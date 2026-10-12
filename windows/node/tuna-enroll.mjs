// tuna-enroll.mjs -- an open-market Windows host keeps its own TUNA privacy agent enrolled, with no operator SSH.
//
// Every app this box serves reaches the internet only through its own TUNA circuits (network/privacy-agent.mjs, the
// \Enclave\Tuna task). This pass, run by the node agent every few minutes, does on the box what the platform's
// reconcile-shield-apps.mjs did over SSH for the first host:
//   1. the control channel's two wallets: made here (enclave-tuna.exe --init-wallet; the seeds never leave this box),
//      their funding asked of the relay (relay/tuna-funding.mjs, signed by the attested transport key; the platform pays);
//   2. once those hold the adapters' minimum, the apps below are enrolled; privacy-config.json is written with the
//      first one (the agent refuses an empty list) - the \Enclave\Tuna task waits for it;
//   3. each public deployment leased to this box, running ready in a partition of its current version: its expectation
//      (network/shield-expectation.mjs), six wallets, their funding asked, and once they hold the minimum the app is
//      added to the config. An expectation that changes (an upgrade) is rewritten; the names follow the relay's map.
// The privacy agent re-reads its config when the file changes. Nothing is ever removed: a lease that ends ends its
// admission at the relay, and its wallets simply stop spending.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, sign as cryptoSign, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { shieldExpectation, catalogRef } from "../../network/shield-expectation.mjs";

export const MIN_FUNDED = 10_000_000n;                 // 0.01 NKN in base units: the adapters' minimum (reconcile-apps.mjs)
const NKN_ADDR = /^NKN[1-9A-HJ-NP-Za-km-z]{33}$/, ID = /^0x[0-9a-f]{64}$/;
export const NKN_RPC = ["http://seed.nkn.org:30003", "http://mainnet-seed-0001.nkn.org:30003", "http://mainnet-seed-0002.nkn.org:30003"];
const ROLES = ["guard", "public", "egress"];

/** The canonical funding request message (relay/tuna-funding.mjs fundingMessage; kept byte-identical, tested). */
export const fundingMessage = (name, purpose, deploymentId, addresses, nonce) =>
  ["enclave-tuna-funding/1", name, purpose, deploymentId || "-", addresses.join(","), nonce].join("\n");

/** The privacy agent's config for this box, apps empty (the NucBox's production shape, 2026-10). */
export function baseConfig({ agentDir, binDir, nodeBinary, operatorKeyFile, runner, endpoint, relayBase, policyFile, tpmBinary, tpmSha256,
                             addressBook, chainRpc, manager = "http://127.0.0.1:8091", dataAddr = "127.0.0.1:8092", upstream = "http://127.0.0.1:9600" }) {
  const bin = (f) => path.join(binDir, f);
  return { version: 2, directory: path.join(agentDir, "state"), operatorKeyFile, runner, endpoint, nknRpc: NKN_RPC, apps: [],
    chain: { addressBook, rpc: chainRpc },
    inventory: { binary: bin("enclave-provider-inventory.exe"), asnFile: path.join(agentDir, "asn.json") },
    control: { binary: bin("enclave-tuna.exe"), firewallBinary: bin("enclave-circuit-firewall.exe"), walletsFile: path.join(agentDir, "control-wallets.json") },
    runtime: { binary: bin("enclave-tuna.exe"), nodeBinary, workerModule: bin("windows-circuit-worker.mjs"), discoveryBinary: bin("enclave-route-discovery.exe"),
               firewallBinary: bin("enclave-circuit-firewall.exe") },
    upstream,
    shield: { policyFile, tpmBinary, tpmSha256, ingress: { url: manager, dataAddr }, manager },
    dns: [{ address: "1.1.1.1:443", serverName: "cloudflare-dns.com", path: "/dns-query" }, { address: "8.8.8.8:443", serverName: "dns.google", path: "/resolve" }],
    mirror: relayBase, defaults: { budgetNkn: "1.5" } };
}

/**
 * createTunaEnroll(opts) -> { pass() }. opts: agentDir (ProgramData\Enclave\tuna), binDir (Program Files\Enclave\tuna),
 * name, endpoint, runner, relayBase, transportKey (the attested Ed25519 private key), config (baseConfig's inputs),
 * rows() (the ledger), version(appRef) (its catalog version record), vms() (the manager's /vms list), and for tests:
 * fetch, run (execFile), balanceOf, log.
 */
export function createTunaEnroll({ agentDir, binDir, name, endpoint, runner, relayBase, transportKey, config, rows, version, vms,
                                   fetch: fetchFn = globalThis.fetch, run, balanceOf, log = () => {} }) {
  const file = (f) => path.join(agentDir, f);
  const tuna = path.join(binDir, "enclave-tuna.exe");
  run ||= (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { timeout: 60000, windowsHide: true },
    (e, so, se) => e ? rej(Object.assign(e, { stderr: se })) : res(String(so))));
  balanceOf ||= async (addr) => {
    for (const rpc of NKN_RPC) {
      try {
        const r = await fetchFn(rpc, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getbalancebyaddr", params: { address: addr } }) });
        const a = (await r.json())?.result?.amount;
        if (a !== undefined) return BigInt(Math.round(Number(a) * 1e8));
      } catch {}
    }
    return null;
  };
  const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch (e) { if (e.code === "ENOENT") return d; throw e; } };
  const writeAtomic = async (f, text) => { const t = `${f}.tmp-${process.pid}`; await fs.writeFile(t, text); await fs.rename(t, f); };
  const funded = async (addrs) => (await Promise.all(addrs.map(balanceOf))).every((b) => b !== null && b >= MIN_FUNDED);

  async function wallet(seed) {
    let out;
    try { await fs.access(seed); out = await run(tuna, ["--wallet-address", seed]); }
    catch (e) { if (e.code !== "ENOENT") throw e; out = await run(tuna, ["--init-wallet", seed]); }
    const address = JSON.parse(out).address;
    if (!NKN_ADDR.test(String(address))) throw new Error(`enclave-tuna made no wallet for ${seed}`);
    return address;
  }
  async function askFunding(purpose, deploymentId, addresses) {
    const nonce = randomBytes(16).toString("hex");
    const sig = cryptoSign(null, Buffer.from(fundingMessage(name, purpose, deploymentId, addresses, nonce)), transportKey).toString("hex");
    const r = await fetchFn(`${relayBase}/v1/hosts/tuna-funding`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, purpose, ...(deploymentId ? { deploymentId } : {}), addresses, nonce, sig }), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`the relay refused ${purpose} funding: ${j.error || r.status} ${j.message || ""}`.trim());
    return j;
  }

  /** The control wallets: made, funded. -> true once both hold the minimum. */
  async function control() {
    let ws = await readJSON(file("control-wallets.json"), null);
    if (!Array.isArray(ws) || ws.length !== 2) {
      ws = [];
      for (const i of [0, 1]) { const seedFile = file(`control-${i}.seed`); ws.push({ address: await wallet(seedFile), fundedNkn: "0.05", seedFile }); }
      await writeAtomic(file("control-wallets.json"), JSON.stringify(ws));
      log(`control wallets made: ${ws.map((w) => w.address).join(", ")}`);
    }
    const addrs = ws.map((w) => w.address);
    if (await funded(addrs)) return true;
    const r = await askFunding("control", "", addrs);
    log(`control wallets: funding ${r.already ? "already requested" : "requested"} (${r.label}); waiting for it to arrive`);
    return false;
  }

  async function pass() {
    await fs.mkdir(file("state"), { recursive: true });
    if (!(await control())) return { ready: false };
    // The config is written only once it names an app: the privacy agent refuses an empty app list, and sizes its TUNA
    // runtime from the apps it starts with (an empty file crash-looped \Enclave\Tuna, nucbox-k11-2 2026-10-12).
    let cfg = await readJSON(file("privacy-config.json"), null), changed = false;
    const fresh = !cfg;
    if (fresh) cfg = baseConfig(config);
    const policy = await readJSON(config.policyFile, null);
    if (!policy?.cpu?.runtimeId) throw new Error(`no admitted Shield policy at ${config.policyFile}`);
    const now = Math.floor(Date.now() / 1000), me = String(runner).toLowerCase();
    const mine = (await rows()).filter((d) => String(d.runner).toLowerCase() === me && d.active === true && d.isPublic === true &&
      Number(d.leaseUntil) > now && ID.test(String(d.id).toLowerCase()));
    let domains = null;
    try { const r = await fetchFn(`${relayBase}/v1/domains/map`, { signal: AbortSignal.timeout(15000) }); if (r.ok) domains = (await r.json()).domains || {}; } catch {}
    const namesFor = (id) => { const n = [id.slice(2, 10) + ".app.enclave.host"]; for (const [h, d] of Object.entries(domains || {})) if (String(d).toLowerCase() === id && !n.includes(h)) n.push(h); return n; };
    const list = mine.length ? await vms() : [];
    for (const row of mine) {
      const id = String(row.id).toLowerCase(), short = id.slice(0, 10), dir = file(id);
      if (!catalogRef(row.appRef)) { log(`${short}: not a catalog app; skipped`); continue; }
      const expectedFile = path.join(dir, "expected.json"), walletsFile = path.join(dir, "wallets.json");
      const previous = await readJSON(expectedFile, null);
      const v = shieldExpectation({ row, version: await version(row.appRef), vms: list, policy, previous });
      if (!v.expected) { log(`${short}: ${v.wait || v.skip}`); continue; }
      const existing = cfg.apps.find((a) => a.deploymentId === id);
      await fs.mkdir(dir, { recursive: true });
      if (JSON.stringify(previous) !== JSON.stringify(v.expected)) {
        await writeAtomic(expectedFile, JSON.stringify(v.expected)); changed = changed || !!existing;
        if (existing) log(`${short}: expectation now ${v.expected.appRef.split("/").pop()} app ${v.expected.appSha256.slice(0, 8)}`);
      }
      if (existing) {
        if (domains) { const n = namesFor(id); if (JSON.stringify(n) !== JSON.stringify(existing.names)) { existing.names = n; changed = true; } }
        continue;
      }
      if (!domains) { log(`${short}: new, but the relay's domain map is unavailable; enrolling next pass`); continue; }
      const wallets = [];
      for (const slot of [0, 1]) {
        const w = {};
        for (const role of ROLES) { const seedFile = path.join(dir, `${slot}-${role}.seed`); w[role] = { address: await wallet(seedFile), fundedNkn: "0.25", seedFile }; }
        wallets.push(w);
      }
      const addrs = wallets.flatMap((w) => ROLES.map((r) => w[r].address));
      if (!(await funded(addrs))) {
        try { const r = await askFunding("app", id, addrs); log(`${short}: wallet funding ${r.already ? "already requested" : "requested"} (${r.label}); enrolled once it arrives`); }
        catch (e) { log(`${short}: ${e.message}`); }
        continue;
      }
      await writeAtomic(walletsFile, JSON.stringify(wallets));
      cfg.apps.push({ deploymentId: id, names: namesFor(id), walletsFile, expectedFile, internetMode: "tuna", publishToMirror: true });
      changed = true; log(`${short}: enrolled (${namesFor(id).join(", ")})`);
    }
    if (changed && cfg.apps.length) {
      await writeAtomic(file("privacy-config.json"), JSON.stringify(cfg, null, 2));
      if (fresh) log("privacy-config.json written: the TUNA privacy agent starts");
    }
    return { ready: true, apps: cfg.apps.length, changed: changed && cfg.apps.length > 0 };
  }
  return { pass };
}

/** sha256 of a file, hex (the TPM tool's pin in the privacy agent's config). */
export const fileSha256 = async (f) => createHash("sha256").update(await fs.readFile(f)).digest("hex");
