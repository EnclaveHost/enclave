// standalone.mjs -- the phone hosts on its own (STANDALONE.md). AgentService (Java, process ":agent") runs this with the Node
// the APK carries:
//   libnode.so standalone.mjs --files <app files dir> --apk <installed APK> --lib <native libs dir> --control-port <port>
// It is the owner's computer, moved onto the phone: the host agent (host-agent.mjs: registration, sweep, claims, proofs,
// certificates, secrets, egress, the SNI router) and the attach co-signer run in THIS process, against the phone's own
// files and processes (pvm-device-local.mjs); the Enclave network (network/privacy-agent.mjs, pvm mode, enclave-wg per
// circuit) runs as one child, started once there is an app to carry, and each served app is enrolled in it here (the
// same expectation network-enroll.mjs writes, no wallets).
//
// What it keeps, all in the app's private files (files/agent/):
//   setup.json      the owner's choices, written by the app's setup screens: { name?, vmName?, payoutTo?, priceCpuPerSec6? }.
//                   No setup.json: AgentService does not start this.
//   operator.key    the operator key, made here on first run (0600). It pays its own gas (STANDALONE.md "Gas").
//   instance.json   the host VM's instance, learned on its first attach (attach-cosigner learnInstance). Learning it ends
//                   this process; AgentService starts it again with the instance pinned, before anything is registered.
//   status.json     for the app's screen: the operator's address and gas balance, the name (every minute).
//   codehash.json   this APK's codeHash (apk-code-hash.mjs), cached by the APK's size and mtime.
//   host.json, network.json   the two configs, written from the above and the bundle's build.json on every start.
//   state/ net/ apps/ components/   the host agent's state, the network's, each enrolled app's expectation, the CID cache.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, fallback } from "viem";
import { generatePrivateKeyHex, operatorAccount } from "./standalone-keys.mjs";
import { apkCodeHash } from "./apk-code-hash.mjs";
import { createHostAgent, checkHostConfig } from "./host-agent.mjs";
import { createLocalPvmDevice } from "./pvm-device-local.mjs";
import { createAttachCosigner, serveAttachCosigner } from "./attach-cosigner.mjs";
import { createHash } from "node:crypto";
import { verifyPvmAppEvidence } from "../../../../relay/pvm-app-attest.mjs";
import { checkIndependentProfile, loadVerifierInputs, independentHostConfig, independentNetworkConfig, learnHostInstance } from "./independent.mjs";
import { independentChain, hostPolicyGate, appFundedLeases, capacityPublisher } from "./independent-runtime.mjs";

export const AGENT_PORT = 18187, ATTACH_PORT = 18188, EGRESS_PORT = 18189, ROUTER_PORT = 17780;
// the Enclave app's screen (host-ui, the hosting panel): the local hosting API with its own token, never the tunnel's surface
export const PANEL_PORT = 18191;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

/** write 0600 under a temporary name, renamed into place */
export function writePrivate(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, p);
}
const readJson = (p, dflt = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return dflt; } };

/** The owner's setup, strictly: what the app's screens may write. */
export function checkSetup(s) {
  const bad = (m) => { throw new Error(`setup.json: ${m}`); };
  if (!s || typeof s !== "object" || Array.isArray(s)) bad("not an object");
  for (const k of Object.keys(s)) {
    if (!["name", "vmName", "payoutTo", "priceCpuPerSec6"].includes(k)) bad(`unknown key ${JSON.stringify(k)}`);
    if (typeof s[k] !== "string") bad(`${k} must be a string`);
  }
  if (s.name !== undefined && !/^[a-z0-9][a-z0-9-]{2,40}$/.test(s.name)) bad("name must be 3..41 of [a-z0-9-], starting with a letter or digit");
  if (s.vmName !== undefined && !/^[a-z0-9-]{1,29}$/.test(s.vmName)) bad("vmName must be 1..29 of [a-z0-9-]");
  if (s.payoutTo !== undefined && (!/^0x[0-9a-f]{40}$/.test(s.payoutTo) || /^0x0{40}$/.test(s.payoutTo))) bad("payoutTo must be a lowercase address, not zero");
  if (s.priceCpuPerSec6 !== undefined && !/^[1-9][0-9]{0,18}$/.test(s.priceCpuPerSec6)) bad("priceCpuPerSec6 must be a positive decimal");
  return s;
}

/**
 * The owner's independent profile (independent.mjs), if any: files/agent/independent.json (written on the phone), else the
 * release's own assets/agent/independent.json (an owner's signed release carries it: public, covered by the APK signature and
 * its code hash). A relative leaseGas.file is the release's record next to it. -> { raw, from } or null (legacy mode).
 */
export function locateIndependentProfile({ files, bundleDir }) {
  for (const dir of [path.join(files, "agent"), bundleDir]) {
    const f = path.join(dir, "independent.json");
    const raw = readJson(f);
    if (raw === null) continue;
    if (raw && raw.leaseGas && typeof raw.leaseGas.file === "string" && !path.isAbsolute(raw.leaseGas.file)) raw.leaseGas.file = path.join(dir, raw.leaseGas.file);
    return { raw, from: f };
  }
  return null;
}

/** The phone's name on the relay when the owner chose none: from its operator address, so two phones never collide. */
export const defaultName = (operator) => `phone-${operator.slice(2, 14).toLowerCase()}`;

/** VM memory this phone offers its apps: a quarter of its RAM, 1..4 GiB (the Pixel 10 Pro XL, 16 GB, offers 4096). */
export const poolMemMbFor = (totalBytes) => Math.max(1024, Math.min(4096, Math.floor(totalBytes / 4 / (1 << 20) / 256) * 256));

/** The host agent's config, from the bundle's constants (build.json), the owner's setup and what this phone learned. */
export function hostConfig({ build, setup, operator, codeHash, instanceIds, files, apk, controlPort, bundleDir, totalMem }) {
  const a = path.join(files, "agent");
  return {
    format: "enclave-pvm-host-agent/v1", name: setup.name || defaultName(operator), relayOrigin: build.relayOrigin, chainId: build.chainId,
    addressBook: build.addressBook, operator: operator.toLowerCase(), maxFeePerGasWei: build.maxFeePerGasWei,
    register: { repo: build.repo, cpuPricePerSec6: setup.priceCpuPerSec6 || build.defaultPriceCpuPerSec6 },
    ...(setup.payoutTo ? { payout: { to: setup.payoutTo, minWithdraw6: build.minWithdraw6 } } : {}),
    evidence: { allowedCodeHashes: [codeHash], allowedAuthorityHashes: build.authorityHashes, allowedRuntimeIds: build.runtimeIds,
                rootPins: build.rootPins, instanceIds },
    device: { local: { files, apk, controlPort }, vmName: setup.vmName || "pvmhost", agentPort: AGENT_PORT, attachPort: ATTACH_PORT },
    idleApp: path.join(bundleDir, "idle-app.wasm"),
    claim: { enabled: true, maxMemMb: 512, sweepGraceSec: 300 },
    ipfs: { gateways: build.gateways, cacheDir: path.join(a, "components") },
    egress: { port: EGRESS_PORT, routesFile: path.join(a, "net", "egress-routes.json") },
    slots: { count: 32, poolMemMb: poolMemMbFor(totalMem), routerPort: ROUTER_PORT },
  };
}

/** The Enclave network's config (privacy-agent.mjs, pvm mode) for the apps enrolled so far. */
export function networkConfig({ build, host, apps, files, lib, bundleDir, codeHash, nodeBinary }) {
  const a = path.join(files, "agent");
  return {
    version: 2, directory: path.join(a, "net"), operatorKeyFile: path.join(a, "operator.key"), runner: host.enclaveId, endpoint: host.endpoint,
    apps, chain: { addressBook: build.addressBook, rpc: build.rpc }, dns: build.dns, mirror: build.relayOrigin,
    pvm: { appPort: ROUTER_PORT, codeHashes: [codeHash], authorityHashes: build.authorityHashes, runtimeIds: build.runtimeIds },
    enclaveNetwork: { relay: build.relayOrigin, checkers: build.checkers, apps: "all", control: true, wgBinary: path.join(lib, "libenclavewg.so"),
                      nodeBinary, workerModule: path.join(bundleDir, "windows-circuit-worker.mjs") },
  };
}

/**
 * Enroll the apps the host agent serves (state/host-state.json) into the network's app list: each serving app with its
 * certificate gets its expectation (appRef and configCid as the ledger has them, the attested component's SHA-256, the
 * pinned runtime) and its platform name. Returns the new list and whether anything changed. Nothing is removed: a lease
 * that ends ends its admission (as in network-enroll.mjs).
 */
// requireCert: the legacy rule (a relay-issued certificate installed). Independent hosting issues none: an app enrolls once its
// VM serves, and the network agent's own route probe (network/guest-probe.mjs, pvm evidence over its nonce) admits it.
export function enrollApps({ hostState, apps, appsDir, runtimeId, requireCert = true, log = () => {} }) {
  const served = [...Object.values((hostState && hostState.slots) || {}), hostState && hostState.current].filter(Boolean);
  let changed = false;
  const out = apps.map((x) => ({ ...x }));
  for (const cur of served) {
    if (cur.phase !== "serving" || (requireCert && !cur.cert) || !/^0x[0-9a-f]{64}$/.test(cur.id || "")) continue;
    if (typeof cur.configCid !== "string" || !cur.appRef || !/^[0-9a-f]{64}$/.test(cur.sha || "")) continue;
    const id = cur.id, label = id.slice(2, 10);
    const expected = { appRef: cur.appRef, configCid: cur.configCid, appSha256: cur.sha, runtimeId };
    const file = path.join(appsDir, id, "expected.json");
    if (JSON.stringify(readJson(file)) !== JSON.stringify(expected)) { writePrivate(file, JSON.stringify(expected, null, 2)); changed = true; log({ ev: "enroll-expectation", app: label }); }
    if (!out.some((x) => x.deploymentId === id)) {
      out.push({ deploymentId: id, names: [`${label}.app.enclave.host`], expectedFile: file, internetMode: "enclave-network", publishToMirror: true });
      changed = true; log({ ev: "enroll", app: label });
    }
  }
  return { apps: out, changed };
}

// ---------------------------------------------------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const files = val("--files"), apk = val("--apk"), lib = val("--lib"), controlPort = Number(val("--control-port"));
  if (!files || !apk || !lib || !Number.isInteger(controlPort)) { console.error("usage: standalone.mjs --files D --apk F --lib D --control-port N"); process.exit(2); }
  const a = path.join(files, "agent"), bundleDir = HERE;
  const build = readJson(path.join(bundleDir, "build.json"));
  if (!build) { log({ ev: "fatal", error: "the bundle has no build.json" }); process.exit(2); }
  const setup = checkSetup(readJson(path.join(a, "setup.json"), {}));
  // the owner's choice of independent hosting (independent.mjs): no relay, API, Nan or minipc in any required role
  const located = locateIndependentProfile({ files, bundleDir });
  const IND = located !== null;
  const profile = IND ? checkIndependentProfile(located.raw) : null;
  let inputs = null;
  if (IND) {
    const vi = await loadVerifierInputs({ sha256: profile.verifierInputs.sha256, sources: profile.verifierInputs.sources, cacheFile: path.join(a, "verifier-inputs.json") });
    inputs = vi.doc;
    log({ ev: "independent", profile: located.from, endpoint: profile.endpoint, verifierInputs: profile.verifierInputs.sha256, from: vi.source, refused: vi.report.filter((r) => !r.ok) });
  }

  // the operator key: made here once, never leaves the app's files
  const keyFile = path.join(a, "operator.key");
  if (!fs.existsSync(keyFile)) { writePrivate(keyFile, generatePrivateKeyHex() + "\n"); log({ ev: "operator-key-made" }); }
  const account = operatorAccount(fs.readFileSync(keyFile, "utf8").trim());

  // this APK's codeHash, cached by its size and mtime (hashing ~100 MB takes a few seconds on the phone)
  const st = fs.statSync(apk), stamp = `${st.size}:${st.mtimeMs}`;
  let ch = readJson(path.join(a, "codehash.json"));
  if (!ch || ch.stamp !== stamp) { ch = { stamp, codeHash: await apkCodeHash(apk) }; writePrivate(path.join(a, "codehash.json"), JSON.stringify(ch)); }
  const instanceIds = (readJson(path.join(a, "instance.json"), {}).instanceIds || []).filter((h) => /^[0-9a-f]{64}$/.test(h));

  const config = IND ? independentHostConfig({ build, setup, operator: account.address, codeHash: ch.codeHash, instanceIds, files, apk, controlPort, bundleDir, profile, inputs,
                                               poolMemMb: poolMemMbFor(os.totalmem()), ports: { agent: AGENT_PORT, attach: ATTACH_PORT, egress: EGRESS_PORT, router: ROUTER_PORT } })
    : hostConfig({ build, setup, operator: account.address, codeHash: ch.codeHash, instanceIds, files, apk, controlPort, bundleDir, totalMem: os.totalmem() });
  const cfg = checkHostConfig(config);
  writePrivate(path.join(a, "host.json"), JSON.stringify(config, null, 1));
  log({ ev: "start", name: cfg.name, operator: account.address, codeHash: ch.codeHash, instance: instanceIds[0] || null, endpoint: cfg.endpoint });

  const chain = { id: Number(cfg.chainId), name: `chain-${cfg.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: build.rpc } } };
  const http1 = (u) => http(u, { retryCount: 2, retryDelay: 600, timeout: 20000 });
  const publicClient = IND ? independentChain(profile, chain)
    : createPublicClient({ chain, transport: build.rpc.length > 1 ? fallback(build.rpc.map(http1), { rank: false }) : http1(build.rpc[0]) });

  const stateDir = path.join(a, "state");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const d = cfg.device;
  const device = createLocalPvmDevice({ files, apk, control: { port: controlPort, tokenFile: path.join(a, "control-token") },
    vmName: d.vmName, relay: IND ? null : `${cfg.relayOrigin.replace(/^https:/, "wss:")}/v1/fleet-tunnel`, independent: IND, name: cfg.name, agentPort: d.agentPort,
    attachPort: d.attachPort, egressPort: EGRESS_PORT, slots: cfg.slots.count, log });

  // the co-signer: on the phone it learns the host VM's instance on its first attach, then this process starts again
  // (independent: there is no attach to co-sign; the instance is learned from a LOCAL attestation, below)
  let learned = false;
  const cosigner = IND ? null : createAttachCosigner({ account, name: cfg.name, relay: cfg.relayOrigin, codeHashes: cfg.evidence.allowedCodeHashes,
    authorityHashes: cfg.evidence.allowedAuthorityHashes, rootPins: cfg.evidence.rootPins, instanceIds,
    learnInstance: instanceIds.length ? null : (id) => {
      writePrivate(path.join(a, "instance.json"), JSON.stringify({ instanceIds: [id], at: new Date().toISOString() }));
      learned = true; log({ ev: "instance-learned", instance: id });
    },
    journalFile: path.join(stateDir, "attach-journal.jsonl") });
  const attach = IND ? null : await serveAttachCosigner(cosigner, { host: "127.0.0.1", port: d.attachPort });
  // independent: the address book read through the quorum before anything else (the lease record is checked against it), the
  // admin's platform host policy for this host, the app-funded lease sender, and the off-chain capacity record
  let bound = null, agentRef = null;
  const independent = IND ? await (async () => {
    const BOOK = (await import("viem")).parseAbi(["function all() view returns (bytes32[], address[])"]);
    const [keys, values] = await publicClient.readContract({ address: cfg.addressBook, abi: BOOK, functionName: "all" });
    const book = Object.fromEntries(keys.map((k, i) => [Buffer.from(k.slice(2), "hex").toString("utf8").replace(/\0+$/, ""), values[i].toLowerCase()]));
    bound = { chain: { id: Number(cfg.chainId) }, ledger: book.deployments, registry: book.registry };
    return { hostGate: hostPolicyGate({ profile, hostId: cfg.enclaveId, stateDir, log }),
             leaseSender: appFundedLeases({ profile, account, bindings: () => (agentRef ? agentRef.bindings() : null) || bound, log: (m) => log({ ev: "lease-gas", line: String(m).slice(0, 400) }) }) };
  })() : null;
  const agent = await createHostAgent({ config, publicClient, account, stateDir, device, log, ...(IND ? { independent } : {}) });
  agentRef = agent;
  const capacity = IND ? capacityPublisher({ profile, account, agent, log }) : null;
  const srv = await agent.serve(d.agentPort);
  log({ ev: "host-surface", listen: `127.0.0.1:${d.agentPort}`, enclaveId: cfg.enclaveId });
  const panel = await agent.serveLocal(PANEL_PORT, path.join(a, "hosting-admin.token"));

  // ---- the Enclave network: one child, once there is an app to carry ----
  const netFile = path.join(a, "network.json"), appsDir = path.join(a, "apps");
  let apps = readJson(netFile, {}).apps || [], net = null, netBackoff = 5000, netStarted = 0, stopping = false;
  const writeNet = () => writePrivate(netFile, JSON.stringify(IND
    ? independentNetworkConfig({ build, host: cfg, apps, files, lib, bundleDir, codeHash: ch.codeHash, nodeBinary: process.execPath, profile, inputs, routerPort: ROUTER_PORT })
    : networkConfig({ build, host: cfg, apps, files, lib, bundleDir, codeHash: ch.codeHash, nodeBinary: process.execPath }), null, 1));
  const startNet = () => {
    if (net || !apps.length || stopping) return;
    netStarted = Date.now();
    net = spawn(process.execPath, [path.join(bundleDir, "net-child.mjs"), "--config", netFile], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    const fwd = (s) => s.on("data", (b) => { for (const l of String(b).split("\n").filter(Boolean)) log({ ev: "net", line: l.slice(0, 2000) }); });
    fwd(net.stdout); fwd(net.stderr);
    net.on("exit", (code, sig) => {
      log({ ev: "net-exit", code, sig }); net = null;
      if (Date.now() - netStarted > 10 * 60_000) netBackoff = 5000;
      setTimeout(startNet, netBackoff); netBackoff = Math.min(netBackoff * 2, 5 * 60_000);
    });
    log({ ev: "net-start", apps: apps.length });
  };
  const enroll = () => {
    try {
      const r = enrollApps({ hostState: readJson(path.join(stateDir, "host-state.json")), apps, appsDir, runtimeId: IND ? inputs.runtimeIds[0] : build.runtimeIds[0], requireCert: !IND, log });
      if (r.changed || !fs.existsSync(netFile)) { apps = r.apps; writeNet(); if (net) net.kill("SIGHUP"); }   // SIGHUP: re-read the app list now
      startNet();
    } catch (e) { log({ ev: "enroll-error", error: e.message }); }
  };
  writeNet();

  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { log({ ev: "signal", signal: s }); stopping = true; });
  // what the app's screen shows beside the agent's own surface: the operator, its gas, this phone's name (files/agent/status.json)
  const status = async () => {
    let balanceWei = null;
    try { balanceWei = String(await publicClient.getBalance({ address: account.address })); } catch {}
    writePrivate(path.join(a, "status.json"), JSON.stringify({ operator: account.address, balanceWei, name: cfg.name, endpoint: cfg.endpoint,
      instance: instanceIds[0] || null, at: new Date().toISOString() }));
  };
  let lastEnroll = 0;
  const idleSha = createHash("sha256").update(fs.readFileSync(path.join(bundleDir, "idle-app.wasm"))).digest("hex");
  while (!stopping && !learned) {
    try { await agent.tick(); } catch (e) { log({ ev: "tick-error", error: e.shortMessage || e.message }); }
    if (IND) {
      // the host VM's instance, learned with no relay: its evidence over OUR nonce, verified against the pinned inputs
      if (!instanceIds.length && agent.state().host) {
        try {
          const id = await learnHostInstance({ exchange: (line) => device.exchange(line, null, 30000), verify: verifyPvmAppEvidence, pins: cfg.evidence, idleSha });
          writePrivate(path.join(a, "instance.json"), JSON.stringify({ instanceIds: [id], at: new Date().toISOString(), how: "local attestation (independent)" }));
          learned = true; log({ ev: "instance-learned", instance: id, how: "local attestation" });
        } catch (e) { log({ ev: "instance-unlearned", why: e.message }); }
      }
      await capacity.tick();
    }
    if (Date.now() - lastEnroll > 60_000) { enroll(); await status().catch((e) => log({ ev: "status-error", error: e.message })); lastEnroll = Date.now(); }
    for (let i = 0; i < 30 && !stopping && !learned; i++) await new Promise((r) => setTimeout(r, 1000));
  }
  if (learned) { log({ ev: "restart", why: "the host VM's instance is pinned now" }); await new Promise((r) => setTimeout(r, 2000)); }
  // the runners' own loops may take a while to wind down; their state is journaled, so a deadline is safe (systemd's
  // stop timeout did this for the computer's agent)
  await Promise.race([agent.stop({ release: false }).catch(() => {}), new Promise((r) => setTimeout(r, 20_000).unref())]);
  if (net) net.kill("SIGTERM");
  srv.close(); panel.close(); if (attach) attach.close(); if (cosigner) cosigner.close();
  process.exit(learned ? 75 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main().catch((e) => { log({ ev: "fatal", error: e.stack || e.message }); process.exit(1); });
