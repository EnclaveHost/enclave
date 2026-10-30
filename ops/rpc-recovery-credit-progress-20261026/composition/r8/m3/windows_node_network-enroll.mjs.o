// network-enroll.mjs -- an open-market Windows host keeps its own network agent enrolled on the Enclave network, with no
// operator SSH.
//
// Every app this box serves reaches the internet only through its own Enclave-network circuits (network/privacy-agent.mjs,
// the \Enclave\Network task; docs/design/enclave-network.md). This pass, run by the node agent every few minutes:
//   1. writes privacy-config.json with the first app (the agent refuses an empty list) - the \Enclave\Network task waits
//      for it; the box's own control traffic uses Enclave-network control circuits. A box whose operator opted into its
//      own public service roles (ENCLAVE_HOST_SERVICES_FILE, or hostServices set by hand) gets it with no app yet, unless
//      the node's platform host policy refuses the box: the agent then runs those services only, once it admits the box;
//   2. enrolls each public deployment leased to this box, running ready in a partition of its current version: its
//      expectation (network/shield-expectation.mjs) and its names (the relay's domain map). An expectation that changes
//      (an upgrade) is rewritten; the names follow the relay's map.
// The privacy agent re-reads its config when the file changes. Nothing is ever removed: a lease that ends ends its
// admission at the relay.
//
// A box whose config still carries settings of the retired TUNA transport (NKN wallets, its control guards, its runtime)
// has them dropped, and is switched once to the current enclaveNetwork section (its agent restarted). Paths follow the
// agent's directory: a box whose agent directory moved (ProgramData\Enclave\tuna -> network, release .35) has its
// state directory and expectations repointed, and its agent restarted once.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { shieldExpectation, catalogRef } from "../../network/shield-expectation.mjs";
import { validateHostServicesTransport } from "../../network/host-service-transport.mjs";
import { resolveHostPolicyConfig } from "../../network/platform-host-policy-config.mjs";
import { hostServicesPolicyConfig, hostPolicyGateEnv } from "../../network/host-policy-gate-config.mjs";
import { keccak256, toBytes } from "viem";

const ID = /^0x[0-9a-f]{64}$/;
// the node's explicit chain authority (chain.mjs chainAuthority()) -> the agent's chain section: the verifier (no RPC list:
// the agent then builds no provider client for its lease/registry reads) or null (the legacy RPC list)
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?(\/|$)/;
export function agentChainAuthority(a) {
  if (!a || a.authority !== "local-verifier") return null;
  if (!LOOPBACK.test(String(a.verifier || ""))) throw new Error("the node's chain verifier must be a local (loopback) URL");
  return { authority: "verifier", verifier: a.verifier };
}
// settings of the retired TUNA transport a box's config may still hold; the agent ignores them, the next pass drops them
export const RETIRED_KEYS = ["nknRpc", "inventory", "control", "runtime", "defaults", "tunaUSDC", "currencyManagement"];

/** The privacy agent's config for this box, apps empty (the NucBox's production shape). */
export function baseConfig({ agentDir, binDir, nodeBinary, operatorKeyFile, runner, endpoint, relayBase, policyFile, tpmBinary, tpmSha256,
                             addressBook, chainRpc, chainAuthority = null, manager = "http://127.0.0.1:8091", dataAddr = "127.0.0.1:8092", upstream = "http://127.0.0.1:9600",
                             enclaveNetwork }) {
  const verified = agentChainAuthority(chainAuthority);
  return { version: 2, directory: path.join(agentDir, "state"), operatorKeyFile, runner, endpoint, apps: [],
    chain: verified ? { addressBook, ...verified } : { addressBook, rpc: chainRpc }, upstream,
    shield: { policyFile, tpmBinary, tpmSha256, ingress: { url: manager, dataAddr }, manager },
    dns: [{ address: "1.1.1.1:443", serverName: "cloudflare-dns.com", path: "/dns-query" }, { address: "8.8.8.8:443", serverName: "dns.google", path: "/resolve" }],
    mirror: relayBase, enclaveNetwork: networkConfig({ binDir, nodeBinary, relayBase, ...enclaveNetwork }) };
}

/** The privacy agent's enclaveNetwork section: every app, the box's own control circuits, the bundled binaries. */
export function networkConfig({ binDir, nodeBinary, relayBase, checkers, paid, directories }) {
  const bin = (f) => path.join(binDir, f);
  if (!Array.isArray(checkers) || !checkers.length || checkers.some((c) => !/^0x[0-9a-f]{40}$/.test(c))) throw new Error("Enclave network: trusted checker addresses required");
  return { relay: relayBase, checkers, apps: "all", control: true, wgBinary: bin("enclave-wg.exe"), nodeBinary,
    workerModule: bin("windows-circuit-worker.mjs"), firewallBinary: bin("enclave-circuit-firewall.exe"),
    ...(directories ? { directories: validDirectories(directories) } : {}),
    // paid providers (used only for apps whose owners authorized them on chain): this box's registry proof key signs
    // the bandwidth receipts, its operator key pays the settlement gas; up to 0.01 USDC per provider is settled in a batch
    ...(paid ? { paid: { proofKeyFile: paid.proofKeyFile, gasKeyFile: paid.gasKeyFile, rpc: paid.rpc || "https://base-rpc.publicnode.com", maxPending6: paid.maxPending6 || "10000" } } : {}) };
}

export function validDirectories(values) {
  if (!Array.isArray(values) || !values.length || values.length > 8) throw new Error("1..8 public directory origins required");
  return [...new Set(values.map(value => {
    const u = new URL(value);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.pathname !== "/" || u.search || u.hash) throw new Error("public directory origin required");
    return u.origin;
  }))];
}

/** An operator's hostEgress block kept as it is when its shape is right (apps: deployment ids, own: IP addresses); else none. */
export function validHostEgress(h) {
  if (!h || typeof h !== "object" || Array.isArray(h)) return null;
  const own = Array.isArray(h.own) ? h.own : [];
  // apps: "all", or a list of deployment ids (network/enclave-network-host.mjs reads the same shape)
  if (h.apps !== "all") {
    const apps = Array.isArray(h.apps) ? h.apps : [];
    if (!apps.length || apps.length > 64 || apps.some((a) => !ID.test(String(a).toLowerCase()))) return null;
  }
  if (own.length > 8 || own.some((ip) => !/^[0-9a-fA-F:.]{2,45}$/.test(String(ip)))) return null;
  return structuredClone(h);
}

/** An operator's enclaveNetwork.hostServices (this box's own public service roles, network/host-service-transport.mjs): the
 *  operator's opt-in, set by hand, never computed - and NEVER dropped. -> { block (byte-for-byte copy) | null, error | null }.
 *  A block this release cannot validate (a typo, a field a newer release added) is kept exactly as written and reported on
 *  every pass; the privacy agent then refuses host services only (apps unaffected) until the operator fixes it. */
export function hostServicesBlock(h) {
  if (h === undefined) return { block: null, error: null };
  try { validateHostServicesTransport(h); return { block: structuredClone(h), error: null }; }
  catch (e) { return { block: structuredClone(h), error: e.message }; }
}

/** The operator's host-services opt-in FILE (ENCLAVE_HOST_SERVICES_FILE: what `stage-tool.mjs host-services` prints as
 *  `agent`, i.e. { hostServices, challengeReplica?, hostServicesPolicy? }), the source of those blocks while it is configured
 *  - the only way a box with no app yet (no privacy-config.json) can opt in. hostServicesPolicy: the policy, its RPC quorum and
 *  the CARRIERS of its signed document (network/host-policy-gate-config.mjs). -> { hostServices?, challengeReplica?,
 *  hostServicesPolicy?, error }. A file that is missing, unreadable or not that shape yields only an error: the config's own
 *  blocks are then kept as they are. */
export async function readHostServicesFile(file) {
  if (!file) return { error: null };
  if (!path.isAbsolute(file)) return { error: `ENCLAVE_HOST_SERVICES_FILE must be an absolute path (${file})` };
  let j;
  try { j = JSON.parse(await fs.readFile(file, "utf8")); } catch (e) { return { error: `ENCLAVE_HOST_SERVICES_FILE ${file}: ${e.code === "ENOENT" ? "missing" : e.message}` }; }
  if (!j || typeof j !== "object" || Array.isArray(j) || j.hostServices === undefined || Object.keys(j).some((k) => !["hostServices", "challengeReplica", "hostServicesPolicy"].includes(k)))
    return { error: `ENCLAVE_HOST_SERVICES_FILE ${file}: must be { hostServices, challengeReplica?, hostServicesPolicy? }` };
  for (const k of ["challengeReplica", "hostServicesPolicy"]) if (j[k] !== undefined && (!j[k] || typeof j[k] !== "object" || Array.isArray(j[k])))
    return { error: `ENCLAVE_HOST_SERVICES_FILE ${file}: ${k} must be an object` };
  return { hostServices: j.hostServices, ...(j.challengeReplica !== undefined ? { challengeReplica: j.challengeReplica } : {}),
    ...(j.hostServicesPolicy !== undefined ? { hostServicesPolicy: j.hostServicesPolicy } : {}), error: null };
}

/** Why the privacy agent would refuse an app-less config (network/privacy-agent.mjs runPrivacy: hostServicesPreflight and its
 *  platform host policy), or null. Such a config is written only when the agent would run it: the host-service worker staged,
 *  the runner exactly keccak256 of the endpoint, the policy ON for the config's chain and address book (the agent's own
 *  process carries no ENCLAVE_PLATFORM_HOST_POLICY) - otherwise the \Enclave\Network task restarts a refused agent every 10 s. */
export async function appLessRefusal(cfg) {
  const worker = cfg?.enclaveNetwork?.serviceWorkerModule;
  if (typeof worker !== "string" || !path.isAbsolute(worker) || !(await fs.stat(worker).then((s) => s.isFile(), () => false)))
    return `the host-service ingress worker is not staged (${worker || "none"})`;
  const runner = String(cfg.runner || "");
  if (!/^0x[0-9a-f]{64}$/.test(runner) || keccak256(toBytes(String(cfg.endpoint))) !== runner) return "the runner is not keccak256 of this host's endpoint exactly as configured";
  // the operator's explicit policy block (with its carriers), else the platform's default for the config's chain and book
  const hsp = cfg?.enclaveNetwork?.hostServicesPolicy;
  let policy;
  if (hsp !== undefined) { try { policy = resolveHostPolicyConfig({ env: hostPolicyGateEnv(hostServicesPolicyConfig(hsp)).env, chainId: 8453 }); } catch (e) { return e.message; } }
  else policy = resolveHostPolicyConfig({ env: {}, chainId: 8453, book: cfg?.chain?.addressBook || null });
  return policy.on ? null : `the platform host policy is off for this config (${policy.reason})`;
}

/** An operator's enclaveNetwork.paceMbps (this host's uplink in Mbps; circuits pace their UDP to it) kept when it is a number
 *  in (0, 100000]; else none (unpaced). */
export function validPaceMbps(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100000 ? v : null;
}

/**
 * createNetworkEnroll(opts) -> { pass() }. opts: agentDir (ProgramData\Enclave\network), binDir (Program Files\Enclave\network),
 * runner, relayBase, config (baseConfig's inputs, with enclaveNetwork: {checkers}), rows() (the ledger),
 * version(appRef) (its catalog version record), vms() (the manager's /vms list), restartAgent(), and for tests: fetch, log.
 * name, endpoint and transportKey are accepted (and unused) so older callers keep working.
 */
export function createNetworkEnroll({ agentDir, binDir, runner, relayBase, config, rows, version, vms,
                                   fetch: fetchFn = globalThis.fetch, restartAgent = async () => {}, log = () => {},
                                   hostServiceRefusal = () => null }) {
  if (!config?.enclaveNetwork) throw new Error("the Enclave network configuration (trusted checkers) is required: TUNA is retired");
  const file = (f) => path.join(agentDir, f);
  const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch (e) { if (e.code === "ENOENT") return d; throw e; } };
  const writeAtomic = async (f, text) => { const t = `${f}.tmp-${process.pid}`; await fs.writeFile(t, text); await fs.rename(t, f); };

  async function pass() {
    await fs.mkdir(file("state"), { recursive: true });
    // The config is written once it names an app - or, with no app yet, once it carries the operator's VALID host-services
    // opt-in and this node's platform host policy does not refuse this host (the privacy agent then runs those services
    // only, and starts them only on its own admit; it refuses an empty app list otherwise).
    let cfg = await readJSON(file("privacy-config.json"), null), changed = false, waiting = 0;
    const fresh = !cfg;
    if (fresh) cfg = baseConfig(config);
    // the operator's opt-in file, while configured, is the source of hostServices (and of challengeReplica when it has one)
    const optIn = await readHostServicesFile(config.hostServicesFile);
    if (optIn.error) log(`HOST SERVICES OPT-IN NOT APPLIED (the config's blocks are kept as they are): ${optIn.error}`);
    // HOST EGRESS (network/privacy-agent.mjs, main 7e27c1d0c) is the OPERATOR's opt-in, set by hand in privacy-config.json
    // ({apps:[deployment ids], own:[this box's public addresses]}): kept across passes, never computed here. Without this
    // the next pass replaced the whole section and dropped it (and restarted the agent).
    const hostEgress = validHostEgress(cfg?.enclaveNetwork?.hostEgress);
    // PACING (main d476cc0f9): the operator's uplink in Mbps, set by hand like hostEgress and kept the same way
    const paceMbps = validPaceMbps(cfg?.enclaveNetwork?.paceMbps);
    // HOST SERVICES: the operator's opt-in, kept byte-for-byte (valid or not: never deleted); only then is the service
    // worker named (no other box's section changes, so nothing restarts for this release alone)
    const { block: hostServices, error: hostServicesError } = hostServicesBlock(optIn.hostServices !== undefined ? optIn.hostServices : cfg?.enclaveNetwork?.hostServices);
    if (hostServicesError) log(`HOST SERVICES CONFIG INVALID (kept unchanged; the privacy agent refuses host services until it is fixed): ${hostServicesError}`);
    // CHALLENGE REPLICA (network/challenge-replica-host.mjs; work/challenge-host-tls-20261021): the operator's opt-in, kept
    // byte-for-byte like hostServices - never computed or validated here (the privacy agent judges it at start). Without
    // this every pass replaced the section, dropped it and restarted the agent. Placed before walletAdmission, which stays last.
    const challengeReplica = optIn.challengeReplica !== undefined ? optIn.challengeReplica : cfg?.enclaveNetwork?.challengeReplica;
    const keepChallenge = !!challengeReplica && typeof challengeReplica === "object" && !Array.isArray(challengeReplica);
    // HOST SERVICES POLICY (network/host-policy-gate-config.mjs): the operator's explicit policy block with its document
    // CARRIERS, kept byte-for-byte like hostServices (never dropped) and reported every pass while the agent would refuse it
    const hostServicesPolicy = optIn.hostServicesPolicy !== undefined ? optIn.hostServicesPolicy : cfg?.enclaveNetwork?.hostServicesPolicy;
    const keepPolicy = !!hostServicesPolicy && typeof hostServicesPolicy === "object" && !Array.isArray(hostServicesPolicy);
    let hostServicesPolicyError = null;
    if (keepPolicy) { try { hostServicesPolicyConfig(hostServicesPolicy); } catch (e) { hostServicesPolicyError = e.message; log(`HOST SERVICES POLICY INVALID (kept unchanged; the privacy agent refuses host services until it is fixed): ${e.message}`); } }
    // Directory choice belongs to the host operator; enrollment must not silently
    // restore the default relay each time a new app appears.
    const directories = cfg?.enclaveNetwork?.directories || config.enclaveNetwork.directories;
    const walletAdmission = config.walletAdmission?.file && path.isAbsolute(config.walletAdmission.file) ? { file: config.walletAdmission.file } : null;
    const want = { ...networkConfig({ binDir, nodeBinary: config.nodeBinary, relayBase, ...config.enclaveNetwork, directories }), ...(hostEgress ? { hostEgress } : {}), ...(paceMbps ? { paceMbps } : {}),
      ...(hostServices ? { hostServices, serviceWorkerModule: path.join(binDir, "host-service-ingress.mjs") } : {}),
      ...(keepPolicy ? { hostServicesPolicy } : {}),
      ...(keepChallenge ? { challengeReplica } : {}),
      // the node's wallet hold channel (host.mjs walletChannelStart), only while the node runs one: the agent then admits an
      // app only on a fresh allow there; dropped (one restart) when the node stops writing it, so nothing waits on a dead file
      ...(walletAdmission ? { walletAdmission } : {}) };
    // a box whose config predates the current enclaveNetwork section (or still runs TUNA): switched once, then restarted
    let switched = false;
    if (JSON.stringify(cfg.enclaveNetwork) !== JSON.stringify(want)) {
      cfg.enclaveNetwork = want; switched = !fresh; changed = true;
      log(fresh ? "Enclave network: new config" : "Enclave network: this box's network configuration changes");
    }
    // the chain RPCs follow the node's list (chain.mjs RPCS, or BASE_RPCS): a box kept the list it was set up with forever,
    // and on k11-4 two of its three public RPCs rate-limited, so 2 of 3 agreeing failed most rounds (2026-10-18). The agent
    // reads them at start, so a change restarts it once.
    // the node's explicit verifier replaces the RPC list (and leaving it restores the list); either change restarts once
    const verified = agentChainAuthority(config.chainAuthority);
    if (!fresh && verified && (cfg.chain?.authority !== "verifier" || cfg.chain?.verifier !== verified.verifier || cfg.chain?.rpc)) {
      cfg.chain = { addressBook: cfg.chain?.addressBook ?? config.addressBook, ...verified }; switched = true; changed = true;
      log(`chain reads now the local verifier ${verified.verifier} (unsafe tier; no provider RPC list)`);
    }
    if (!fresh && !verified && cfg.chain?.authority === "verifier") {
      const { authority: _a, verifier: _v, ...rest } = cfg.chain; cfg.chain = rest; switched = true; changed = true;
      log("chain reads no longer use a local verifier");
    }
    const rpcs = Array.isArray(config.chainRpc) ? config.chainRpc.filter((u) => /^https:\/\//.test(String(u))) : [];
    if (!fresh && !verified && rpcs.length >= 2 && JSON.stringify(cfg.chain?.rpc || []) !== JSON.stringify(rpcs)) {
      cfg.chain = { ...(cfg.chain || {}), rpc: rpcs }; switched = true; changed = true;
      log(`chain RPCs now ${rpcs.map((u) => new URL(u).host).join(", ")}`);
    }
    // paths follow the agent's directory (it moved once, tuna -> network): the state directory needs a restart
    if (!fresh && cfg.directory !== file("state")) { cfg.directory = file("state"); switched = true; changed = true; log(`state directory now ${cfg.directory}`); }
    if (!fresh && cfg.shield && cfg.shield.policyFile !== config.policyFile) { cfg.shield.policyFile = config.policyFile; switched = true; changed = true; }
    for (const a of cfg.apps) {
      const want = path.join(file(String(a.deploymentId).toLowerCase()), "expected.json");
      if (a.expectedFile !== want) { a.expectedFile = want; changed = true; }
    }
    // retired TUNA settings are dropped (the agent ignores them; nothing restarts for this alone)
    const retired = RETIRED_KEYS.filter((k) => k in cfg);
    for (const k of retired) delete cfg[k];
    for (const a of cfg.apps) {
      if (a.internetMode !== "enclave-network") { a.internetMode = "enclave-network"; changed = true; }
      if ("walletsFile" in a) { delete a.walletsFile; changed = true; }
    }
    if (retired.length) { changed = true; log(`retired TUNA settings dropped from the config: ${retired.join(", ")}`); }
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
      const expectedFile = path.join(dir, "expected.json");
      const previous = await readJSON(expectedFile, null);
      const v = shieldExpectation({ row, version: await version(row.appRef), vms: list, policy, previous });
      if (!v.expected) { if (v.wait) waiting++; log(`${short}: ${v.wait || v.skip}`); continue; }
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
      cfg.apps.push({ deploymentId: id, names: namesFor(id), expectedFile, internetMode: "enclave-network", publishToMirror: true });
      changed = true; log(`${short}: enrolled on the Enclave network (${namesFor(id).join(", ")})`);
    }
    // no app yet: written only for a VALID host-services block (an invalid one would only be refused by the agent) while this
    // node's platform host policy does not refuse this host (the agent judges the same policy itself before any service)
    let servicesOnly = false;
    if (changed && !cfg.apps.length && hostServices && !hostServicesError && !hostServicesPolicyError) {
      const unusable = await appLessRefusal(cfg), refusal = unusable ? null : hostServiceRefusal();
      if (unusable) log(`host services: no app yet, and the privacy agent would refuse them (${unusable}); the config is not written`);
      else if (refusal) log(`host services: no app yet, and the platform host policy refuses this host (${refusal}); the config is not written`);
      else servicesOnly = true;
    }
    const write = changed && (cfg.apps.length > 0 || servicesOnly);
    if (write) {
      await writeAtomic(file("privacy-config.json"), JSON.stringify(cfg, null, 2));
      if (fresh) log(servicesOnly ? "privacy-config.json written for this host's services only (no app yet): the privacy agent starts" : "privacy-config.json written: the privacy agent starts");
      if (switched) { log("restarting the privacy agent on its new network configuration"); await restartAgent().catch((e) => log(`agent restart: ${e.message}`)); }
    }
    // waiting: apps whose new version's partition is not ready yet - the caller looks again soon instead of in 5 minutes
    return { ready: true, apps: cfg.apps.length, changed: write, waiting, ...(hostServicesError ? { hostServicesError } : {}), ...(hostServicesPolicyError ? { hostServicesPolicyError } : {}), ...(optIn.error ? { hostServicesOptInError: optIn.error } : {}) };
  }
  return { pass };
}

/** sha256 of a file, hex (the TPM tool's pin in the privacy agent's config). */
export const fileSha256 = async (f) => createHash("sha256").update(await fs.readFile(f)).digest("hex");
