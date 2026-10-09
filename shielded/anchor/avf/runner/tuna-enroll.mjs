#!/usr/bin/env node
// tuna-enroll.mjs -- enroll the app a pVM host serves into its TUNA privacy agent (PVM-CPU.md "Serving buyers"), the pVM's
// twin of network/reconcile-apps.mjs. Run by a timer beside the host agent:
//   node tuna-enroll.mjs --host-state <pvm-host state/host-state.json> --config <tuna pvm config.json> --apps-dir <dir>
//                        --tuna-binary <enclave-tuna> --topup <topup.sh> --targets <topup-targets.txt> [--runtime-id <hex>] [--dry-run]
// The host agent's state names the deployment the VM serves; once it is serving with its certificate installed (the privacy
// agent's local proof is a WebPKI TLS fetch of the VM's own evidence), this writes the app's expectation (appRef and
// configCid exactly as the ledger has them, the component's SHA-256 the VM attests, the pinned runtime), makes its six NKN
// wallets, adds a funding target and tops up, and only once every wallet holds the adapters' minimum adds the app to the
// config, which the privacy agent re-reads when the file changes. Nothing is removed: a lease that ends ends its admission.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const DRY = argv.includes("--dry-run");
const hostStateFile = arg("--host-state"), configFile = arg("--config"), appsDir = arg("--apps-dir"), tunaBinary = arg("--tuna-binary"),
      topup = arg("--topup"), targetsFile = arg("--targets"), runtimeId = arg("--runtime-id") || "d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba";
if (!hostStateFile || !configFile || !appsDir || !tunaBinary || !topup || !targetsFile) {
  console.error("usage: tuna-enroll.mjs --host-state F --config F --apps-dir D --tuna-binary F --topup F --targets F [--runtime-id H] [--dry-run]"); process.exit(2);
}
const log = (m) => console.log(`[tuna-enroll] ${m}`);
const run = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { timeout: 120000, ...opts }, (e, so, se) => e ? rej(Object.assign(e, { stderr: se })) : res({ stdout: so })));
const writeAtomic = async (file, text, mode = 0o600) => { const t = file + ".tmp"; await fs.writeFile(t, text, { mode }); await fs.rename(t, file); };
const NKN_MIN = 10_000_000n;   // 0.01 NKN in base units: the adapters' minimum balance (reconcile-apps.mjs MIN_FUNDED)

const host = JSON.parse(await fs.readFile(hostStateFile, "utf8"));
const cur = host.current;
if (!cur || cur.phase !== "serving" || !cur.cert || !/^0x[0-9a-f]{64}$/.test(cur.id || "")) { log("nothing served with a certificate yet"); process.exit(0); }
if (typeof cur.configCid !== "string" || !cur.appRef || !/^[0-9a-f]{64}$/.test(cur.sha || "")) { log(`${String(cur.id).slice(0, 10)}: the host state lacks appRef/configCid/sha; the agent records them when it takes a deployment`); process.exit(0); }
const cfg = JSON.parse(await fs.readFile(configFile, "utf8"));
const id = cur.id, label = id.slice(2, 10), names = [`${label}.app.enclave.host`];
const expected = { appRef: cur.appRef, configCid: cur.configCid, appSha256: cur.sha, runtimeId };
const existing = cfg.apps.find((a) => a.deploymentId === id);
const dir = path.join(appsDir, id);
if (existing) {
  const have = JSON.parse(await fs.readFile(existing.expectedFile, "utf8").catch(() => "{}"));
  if (JSON.stringify(have) === JSON.stringify(expected)) { log(`${label}: enrolled`); process.exit(0); }
  log(`${label}: the expectation changed (${String(have.appSha256).slice(0, 8)} -> ${expected.appSha256.slice(0, 8)})`);
  if (!DRY) await writeAtomic(existing.expectedFile, JSON.stringify(expected, null, 2));
  process.exit(0);
}
log(`${label}: enrolling ${names.join(", ")}`);
if (DRY) process.exit(0);
await fs.mkdir(dir, { recursive: true, mode: 0o700 });
const wallets = [];
for (const slot of [0, 1]) {
  const w = {};
  for (const role of ["guard", "public", "egress"]) {
    const seed = path.join(dir, `${slot}-${role}.seed`);
    let out;
    try { await fs.access(seed); out = (await run(tunaBinary, ["--wallet-address", seed])).stdout; }
    catch { out = (await run(tunaBinary, ["--init-wallet", seed])).stdout; await fs.chmod(seed, 0o600); }
    // the declared funding stays within the default app budget (1 NKN for six wallets); the top-up target is separate
    w[role] = { seedFile: seed, address: JSON.parse(out).address, fundedNkn: "0.05" };
  }
  wallets.push(w);
}
await writeAtomic(path.join(dir, "wallets.json"), JSON.stringify(wallets, null, 2));
await writeAtomic(path.join(dir, "expected.json"), JSON.stringify(expected, null, 2));
const addrs = wallets.flatMap((w) => Object.values(w).map((x) => x.address));
const targets = (await fs.readFile(targetsFile, "utf8").catch(() => "")).split("\n").filter(Boolean);
if (!targets.some((l) => l.startsWith(`pvm-${id.slice(0, 10)} `))) {
  targets.push(`pvm-${id.slice(0, 10)} 0.25 ${addrs.join(" ")}`);
  await writeAtomic(targetsFile, targets.join("\n") + "\n", 0o644);
}
const balanceOf = async (addr) => {
  for (const rpc of cfg.nknRpc || []) {
    try {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getbalancebyaddr", params: { address: addr } }) });
      const j = await r.json(); const a = j?.result?.amount;
      if (a !== undefined) return BigInt(Math.round(Number(a) * 1e8));
    } catch {}
  }
  return null;
};
const bal = await Promise.all(addrs.map(balanceOf));
if (bal.some((b) => b === null || b < NKN_MIN)) {
  log(`${label}: funding its wallets; enrolled once they confirm`);
  await run(topup, [], { timeout: 600000 }).catch((e) => log("top-up: " + String(e.stderr || e.message).split("\n").slice(-3).join(" ")));
  process.exit(0);
}
cfg.apps.push({ deploymentId: id, names, expectedFile: path.join(dir, "expected.json"), walletsFile: path.join(dir, "wallets.json"), publishToMirror: true });
await writeAtomic(configFile, JSON.stringify(cfg, null, 1));
log(`${label}: enrolled (the privacy agent re-reads its config)`);
