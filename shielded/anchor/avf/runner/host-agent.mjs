// host-agent.mjs -- the owner's HOST agent for a phone that sells its protected VM (PVM-CPU.md "Serving buyers"). It is what
// metal0's supervisor and the NucBox node agent are for their boxes: the host surface the relay talks to, the market sweep,
// the lease lifecycle and the app's certificate -- around ONE pVM that serves one buyer's app at a time.
//
//   idle      the VM serves the idle app (a CPU-only probe) with proof pins for deployment ZERO, so its attested proof key
//             can be registered; the idle runner (runner-agent.mjs, deployment ZERO, claim off) registers the endpoint with
//             the owner's price, heartbeats it and withdraws earnings. /availability says claimEnabled with one free slot.
//   preparing a deployment D was chosen (a claim hint, a placement pin, or the sweep): its component is fetched by CID and
//             verified, staged on the phone, and the VM is restarted serving it with D's proof pins.
//   serving   D's runner (claim on) claims the lease once the VM attests D's app and pins, then renews it while proofs land and
//             proves every 5 min; this agent asks the relay for D's certificate (a CSR made in the VM; the relay verifies the
//             VM's v4 evidence binds the CSR's key before any CA is asked) and installs it in the VM. When D ends (cancelled,
//             transferred, the lease lost), a final proof and release, then idle again.
//
// Never two runners at once: one operator key, one transaction in flight (each runner's journal is settled before the next
// one starts). Every value the agent signs or registers comes from the VM's attested statement (proof key, build), the
// chain, or the owner's config -- never from the phone's words or a relay request. Requests arriving through the tunnel are
// untrusted: a claim hint only makes the agent LOOK at a deployment, and evidence is the VM's own, verified by its reader.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { parseAbi, keccak256, stringToBytes, hexToString } from "viem";
import { createRunnerAgent } from "./runner-agent.mjs";
// a WALLET SESSION as the owner's credential, verified on chain exactly as the other hosts do (shared with supervisor.js)
import { createSessionApiAuth, apiBases, isSessionHeader, DEFAULT_FACTORIES, DEFAULT_API_HOSTS } from "../../../../windows/node/session-api-auth.mjs";
// the deployment's protection rules and secrets, by the CPU host's own modules (the platform's rules, mirrored there)
import { parseWaf } from "../../../../windows/node/waf.mjs";
import { fetchSecrets, secretsExist } from "../../../../windows/node/secrets.mjs";
import { createEgressServer } from "./egress.mjs";

export const HOST_CONFIG_FORMAT = "enclave-pvm-host-agent/v1";
export const ZERO32 = "0x" + "00".repeat(32);
const ADDR = /^0x[0-9a-f]{40}$/, B32 = /^0x[0-9a-f]{64}$/, HEX64 = /^[0-9a-f]{64}$/;
export const ISOLATION_BACKEND = "avf-pvm-per-app";

const DEP_ABI = parseAbi([
  "function count() view returns (uint256)",
  "function getPage(uint256 start, uint256 n) view returns ((bytes32 id, address owner, string appRef, string ports, string configCid, uint16 gpuMilli, uint16 cpuMilli, uint32 appPort, bool isPublic, bool active, uint64 createdAt, uint256 rate, uint256 balance6, uint256 spent6, bytes32 runner, address runnerOperator, uint64 leaseUntil)[])",
  "function get(bytes32 id) view returns ((bytes32 id, address owner, string appRef, string ports, string configCid, uint16 gpuMilli, uint16 cpuMilli, uint32 appPort, bool isPublic, bool active, uint64 createdAt, uint256 rate, uint256 balance6, uint256 spent6, bytes32 runner, address runnerOperator, uint64 leaseUntil))",
  "function claimableBy(bytes32 id, bytes32 enclaveId) view returns (bool)",
]);
const CATALOG_ABI = parseAbi([
  "function getVersion(bytes32 appId, uint256 index) view returns ((string cid, string version, uint32 vramMb, uint32 gpuGflops, uint32 memMb, uint32 cpuGflops, uint64 createdAt, bool verified, bool yanked, string ports, uint8 approval, string config))",
  "function versionConfigCid(bytes32 appId, uint256 index) view returns (string)",
]);
const REGISTRY_ABI = parseAbi([
  "function get(bytes32 id) view returns ((string endpoint, string repo, bytes32 measurement, address operator, uint64 registeredAt, uint64 lastSeen, bool active, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6, address proofKey))",
]);
const BOOK_ABI = parseAbi(["function all() view returns (bytes32[], address[])"]);

/** Strict: public values only (addresses, ids, pins, paths, the owner's price); the operator key is never in it. */
export function checkHostConfig(c) {
  const bad = (m) => { throw new Error(`host-agent config: ${m}`); };
  if (!c || typeof c !== "object" || Array.isArray(c)) bad("not an object");
  const KEYS = ["addressBook", "chainId", "claim", "device", "egress", "evidence", "format", "idleApp", "ipfs", "maxFeePerGasWei", "name", "operator", "payout", "register", "relayOrigin"];
  for (const k of Object.keys(c)) if (!KEYS.includes(k)) bad(`unknown key ${JSON.stringify(k)}`);
  if (c.format !== HOST_CONFIG_FORMAT) bad(`format must be ${HOST_CONFIG_FORMAT}`);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(c.name || "")) bad("name must be the tunnel name");
  if (!/^https:\/\/[a-z0-9.-]+$/.test(c.relayOrigin || "")) bad("relayOrigin must be https://<relay host>");
  if (!/^[1-9][0-9]{0,15}$/.test(c.chainId || "")) bad("chainId must be a canonical decimal");
  if (!ADDR.test(c.addressBook || "")) bad("addressBook must be 0x + 40 lowercase hex");
  if (!ADDR.test(c.operator || "")) bad("operator must be 0x + 40 lowercase hex");
  if (!/^[1-9][0-9]{0,30}$/.test(c.maxFeePerGasWei || "")) bad("maxFeePerGasWei (the owner's fee cap) is required");
  const r = c.register;
  if (!r || Object.keys(r).sort().join() !== "cpuPricePerSec6,repo" || typeof r.repo !== "string" || !r.repo || !/^[1-9][0-9]{0,18}$/.test(r.cpuPricePerSec6))
    bad("register must be exactly { repo, cpuPricePerSec6 } (the owner's price, > 0)");
  if (c.payout !== undefined && (!c.payout || Object.keys(c.payout).sort().join() !== "minWithdraw6,to" || !ADDR.test(c.payout.to) || !/^[1-9][0-9]{0,30}$/.test(c.payout.minWithdraw6)))
    bad("payout must be exactly { to, minWithdraw6 }");
  const e = c.evidence;
  if (!e || Object.keys(e).sort().join() !== "allowedAuthorityHashes,allowedCodeHashes,allowedRuntimeIds,instanceIds,rootPins") bad("evidence must be exactly { allowedCodeHashes, allowedAuthorityHashes, allowedRuntimeIds, rootPins, instanceIds }");
  if (e.allowedCodeHashes.length !== 1) bad("evidence.allowedCodeHashes must name exactly the build this host runs (it is the registered measurement)");
  const d = c.device;
  if (!d || typeof d.adb !== "string" || !d.serial || !d.vmName || !Number.isInteger(d.agentPort) || !Number.isInteger(d.attachPort)) bad("device must be { adb, serial, vmName, agentPort, attachPort[, bridgeApp, bridgeEvidence] }");
  if (typeof c.idleApp !== "string" || !fs.existsSync(c.idleApp)) bad("idleApp must be the idle component's file");
  const cl = c.claim || {};
  if (!Number.isInteger(cl.maxMemMb) || cl.maxMemMb < 16 || cl.maxMemMb > 1024) bad("claim.maxMemMb must be 16..1024");
  if (!Number.isInteger(cl.sweepGraceSec) || cl.sweepGraceSec < 0) bad("claim.sweepGraceSec must be a non-negative integer");
  if (typeof cl.enabled !== "boolean") bad("claim.enabled must be true or false");
  if (c.egress !== undefined) {
    const g = c.egress;
    if (!g || Object.keys(g).sort().join() !== "port,routesFile" || !Number.isInteger(g.port) || g.port < 1024 || g.port > 65535 || typeof g.routesFile !== "string" || !path.isAbsolute(g.routesFile))
      bad("egress must be exactly { port (1024..65535, the phone reaches it over adb reverse), routesFile (the privacy agent's egress-routes.json, absolute) }");
  }
  const i = c.ipfs || {};
  if (typeof i.fetchScript !== "string" || !Array.isArray(i.gateways) || !i.gateways.length || typeof i.cacheDir !== "string") bad("ipfs must be { python, fetchScript, gateways, cacheDir }");
  return { ...c, endpoint: `${c.relayOrigin}/t/${c.name}`, enclaveId: keccak256(stringToBytes(`${c.relayOrigin}/t/${c.name}`)) };
}

/**
 * The deployment-options envelope as this host applies it (the CPU host's parseEnvelope, windows/node/chain.mjs, plus the
 * pVM's own `placement` and isolation flags): { config?, configCid?, waf?, gpuOptional?, placement?, isolation? }, or throws
 * the reason. FAIL-CLOSED: a namespace this host does not apply refuses the deployment, never silently drops.
 */
export function parseOptions(raw, gpuMilli) {
  const s = String(raw || "").trim();
  if (!s) return {};
  if (!s.startsWith("{")) throw new Error("its options field is a bare CID: a configuration this host cannot apply");
  let env; try { env = JSON.parse(s); } catch { throw new Error("its options envelope is not JSON"); }
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new Error("its options envelope is not an object");
  const known = ["config", "configCid", "gpu", "isolation", "network", "placement", "waf"];
  const unknown = Object.keys(env).filter((k) => !known.includes(k));
  if (unknown.length) throw new Error(`its options carry ${unknown.join(", ")}, which this host does not apply`);
  const o = {};
  if (env.isolation !== undefined) {
    const iso = env.isolation;
    if (!iso || typeof iso !== "object" || Array.isArray(iso) || Object.keys(iso).some((k) => !["require", "cpuTee", "gpuTee"].includes(k))) throw new Error("its isolation options are malformed");
    if (iso.cpuTee === true || iso.gpuTee === true) throw new Error("it requires a confidential-computing CPU or GPU, which this host does not claim");
    if (iso.require !== undefined && iso.require !== ISOLATION_BACKEND) throw new Error(`it requires isolation backend ${JSON.stringify(iso.require)}, not ${ISOLATION_BACKEND}`);
  }
  if (env.network !== undefined) {
    const n = env.network;
    if (!n || typeof n !== "object" || Array.isArray(n) || Object.keys(n).some((k) => !["transport", "relay"].includes(k)) || (n.transport !== undefined && n.transport !== "tuna"))
      throw new Error("its network options ask for a transport other than TUNA");
    if ("relay" in n && n.relay !== null && n.relay !== "" && (typeof n.relay !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(n.relay))) throw new Error("its network options carry an invalid relay");
  }
  if (env.gpu !== undefined) {
    const g = env.gpu;
    if (!g || typeof g !== "object" || Array.isArray(g) || Object.keys(g).some((k) => k !== "optional") || typeof g.optional !== "boolean") throw new Error("its gpu options are not { optional: true|false }");
    if (g.optional && gpuMilli != null && Number(gpuMilli) <= 0) throw new Error("gpu.optional applies only to a deployment that bought GPU share");
    o.gpuOptional = g.optional;
  }
  if (env.placement !== undefined) {
    const p = env.placement;
    if (!p || typeof p !== "object" || !B32.test(String(p.hostId || "").toLowerCase())) throw new Error("its placement pin is malformed");
    o.placement = { hostId: String(p.hostId).toLowerCase(), allowFallback: p.allowFallback !== false };
  }
  if (env.waf !== undefined) {
    try { o.waf = parseWaf(env.waf); } catch (e) { throw new Error(`its protection rules are invalid: ${e.message}`); }
  }
  if (env.configCid !== undefined) {
    if (typeof env.configCid !== "string" || !/^[A-Za-z0-9]{10,100}$/.test(env.configCid)) throw new Error("its configCid is not a bare IPFS CID");
    o.configCid = env.configCid;
  }
  if (env.config !== undefined) {
    if (!env.config || typeof env.config !== "object" || Array.isArray(env.config)) throw new Error("its config override is not a JSON object");
    o.config = env.config;
  }
  return o;
}

/** A version config's `cpuFallback` ({memMb, cpuGflops}): the floor of a coreless placement (the CPU host's reading). */
export function cpuFallbackOf(cfgText) {
  let f; try { f = JSON.parse(String(cfgText || "{}") || "{}").cpuFallback; } catch { return null; }
  if (!f || typeof f !== "object" || Array.isArray(f)) return null;
  const num = (x, max) => { const n = Number(x); return Number.isFinite(n) && n >= 0 && n <= max ? n : 0; };
  const memMb = num(f.memMb, 1048576), cpuGflops = num(f.cpuGflops, 10000000);
  return memMb || cpuGflops ? { memMb, cpuGflops } : null;
}

/** Why the pVM does NOT take this deployment, or null. Pure: the row, its catalog version and this host's facts. */
export function pvmClaimRefusal(d, version, { enclaveId, maxMemMb, nowSec }) {
  if (!d || !d.active) return "the deployment is not active";
  if (!d.isPublic) return "it is private: this host serves public deployments (its route is public; no owner session check here)";
  const lease = Number(d.leaseUntil);
  if (lease >= nowSec && String(d.runner).toLowerCase() !== String(enclaveId).toLowerCase()) return "another host holds its lease";
  let opts;
  try { opts = parseOptions(d.configCid, d.gpuMilli); } catch (e) { return e.message; }
  if (opts.placement && opts.placement.hostId !== String(enclaveId).toLowerCase() && !opts.placement.allowFallback) return "it is pinned to another host";
  if (!version) return "its catalog version could not be read";
  if (version.yanked) return "its catalog version is yanked";
  // the relay serves a public deployment only on an approved version (measurement-predict.mjs versionRefusal)
  if (Number(version.approval) !== 1) return "its catalog version is not approved by the catalog owner";
  let vcfg = {}; try { vcfg = JSON.parse(String(version.config || "{}") || "{}"); } catch { return "its catalog version's config is not JSON"; }
  // a GPU share runs here only when the owner or the publisher said the card is optional: on cores, CPU-only (no model)
  const soft = opts.gpuOptional === true || vcfg.gpuOptional === true;
  if (Number(d.gpuMilli) !== 0 && !soft) return `it asks gpuMilli ${d.gpuMilli}: the pVM CPU tier takes CPU-only workloads (a GPU share runs here only with {"gpu":{"optional":true}})`;
  if ((Number(version.vramMb) > 0 || Number(version.gpuGflops) > 0) && !soft) return "its catalog version needs a GPU";
  // the node floor of a coreless placement: the on-chain size, raised by the publisher's cpuFallback
  const fb = cpuFallbackOf(version.config);
  const memFloor = Math.max(Number(version.memMb) || 0, fb ? fb.memMb : 0);
  if (memFloor > maxMemMb) return `its catalog version needs ${memFloor} MB${fb && fb.memMb > Number(version.memMb) ? " (its cpuFallback)" : ""}, beyond this VM's ${maxMemMb} MB per app`;
  const listed = String(version.ports || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  // a wasi:http handler (no ports), or a socket server on ONE http port; raw tcp/udp ports need a network this VM has not
  if (listed.some((p) => !/^http:[1-9][0-9]{0,4}$/.test(p)) || listed.length > 1 || listed.some((p) => Number(p.slice(5)) > 65535))
    return `its catalog version declares ports ${version.ports}: this host serves HTTP on one port only`;
  // the routing keys the version declares (the CPU host's unmetNeeds): what this runtime cannot do. A 64-bit memory it can
  // (wasmtime's default feature set, bounds-checked in Pulley); everything else in the config is the app's own, handed to
  // it as ENCLAVE_CONFIG
  const want = [];
  if (vcfg.set === true) want.push("shared-everything threads (set:true)");
  if (vcfg.threads === true) want.push("cooperative threads (threads:true)");
  if (String(vcfg.wasi || "0.2") === "0.3") want.push("wasi 0.3");
  if (Array.isArray(vcfg.volumes) && vcfg.volumes.length) want.push(`the model volume${vcfg.volumes.length > 1 ? "s" : ""} ${vcfg.volumes.join(", ")}`);
  if (want.length) return `its catalog version needs ${want.join(" and ")}, which the pVM runtime does not offer`;
  return null;
}

/**
 * `$NAME` / `${NAME}` in the config's STRING values, resolved from the deployment's secrets: the platform runner's rule
 * (wasm_manager.py _subst_secrets, mirrored by windows/node/host.mjs), down to `$$` for a literal `$`. Only names that are
 * secrets substitute; a config that is not JSON passes through untouched.
 */
export function substituteSecrets(text, secrets) {
  if (!text || !secrets || !Object.keys(secrets).length || !text.includes("$")) return text;
  const RE = /\$(\$)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  const rep = (m, dollar, braced, bare) => { if (dollar) return "$"; const v = secrets[braced || bare]; return v === undefined ? m : String(v); };
  const walk = (x) => typeof x === "string" ? x.replace(RE, rep) : Array.isArray(x) ? x.map(walk)
    : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)])) : x;
  let parsed; try { parsed = JSON.parse(text); } catch { return text; }
  return JSON.stringify(walk(parsed));
}

/** The app's environment as the VM takes it: "K=V\0..." (the runtime checks it again: pvm-rt parse_env). */
export function envBlock(vars) {
  const parts = [];
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || k === "ENCLAVE_PORTS" || k === "ENCLAVE_MEM_MB") throw new Error(`${k} cannot be set in the app's environment`);
    if (String(v).includes("\0")) throw new Error(`${k} holds a NUL`);
    parts.push(`${k}=${v}\0`);
  }
  return Buffer.from(parts.join(""), "utf8");
}

/** The launch's options file for the phone (host/app Main.appOptions): ENV / WAF lines, hex; EGRESS <port> <token>. */
export function optionsFile({ env = null, waf = null, egress = null }) {
  const lines = [];
  if (env && env.length) lines.push(`ENV ${env.toString("hex")}`);
  if (waf) lines.push(`WAF ${Buffer.from(JSON.stringify(waf)).toString("hex")}`);
  if (egress) lines.push(`EGRESS ${egress.port} ${egress.token}`);
  return lines.length ? lines.join("\n") + "\n" : null;
}

const json = (res, status, body) => { const b = Buffer.from(JSON.stringify(body)); res.writeHead(status, { "content-type": "application/json", "content-length": b.length, "cache-control": "no-store" }); res.end(b); };

export async function createHostAgent({ config, publicClient, account, stateDir, device, fetchImpl = globalThis.fetch, now = Date.now,
                                        sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  const cfg = checkHostConfig(config), E = cfg.enclaveId, me = cfg.operator;
  if (account.address.toLowerCase() !== me) throw new Error(`host-agent: the signer ${account.address} is not the configured operator ${me}`);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(stateDir, "host-state.json");
  let state = { current: null, idle: null, refused: {} };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }; } catch {}
  const save = () => { const t = stateFile + ".tmp"; fs.writeFileSync(t, JSON.stringify(state, null, 1), { mode: 0o600 }); fs.renameSync(t, stateFile); };
  const note = (o) => log({ t: new Date(now()).toISOString(), layer: "host", ...o });
  const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args });
  const lc = (a) => String(a).toLowerCase();
  const idleSha = crypto.createHash("sha256").update(fs.readFileSync(cfg.idleApp)).digest("hex");
  let addrs = null, runner = null, runnerFor = null, busy = false, lastSweep = 0, lastRunnerTick = 0, lastCert = 0, registered = null, lastReattach = 0;
  const standDown = new Map();   // deployment -> until (ms): the owner moved it away; not re-claimed meanwhile
  const sessions = createSessionApiAuth({ pc: publicClient, book: () => cfg.addressBook, ledger: () => (addrs ? addrs.deployments : null),
    factories: DEFAULT_FACTORIES, bases: () => apiBases({ hosts: DEFAULT_API_HOSTS, tunnelNames: [cfg.name], publicUrls: [cfg.endpoint] }),
    log: (m) => note({ ev: "session-auth", m }) });
  const hints = new Set();

  async function resolve() {
    const [keys, values] = await read(cfg.addressBook, BOOK_ABI, "all");
    const book = {};
    keys.forEach((k, i) => { book[hexToString(k, { size: 32 }).replace(/\0+$/, "")] = lc(values[i]); });
    for (const k of ["registry", "deployments", "proofOfTime", "appCatalog"]) if (!book[k]) throw new Error(`the address book has no ${k}`);
    addrs = book;
    return book;
  }
  const proofPins = (D) => `${cfg.chainId} ${addrs.proofOfTime} ${addrs.registry} ${D} ${E} ${me}`;

  // ---- the runner for the VM as it is now: deployment D (claim on) or ZERO (idle: register, heartbeat, withdraw) ----
  function runnerConfig(D, appSha, { gpuOptional = false } = {}) {
    return { format: "enclave-pvm-runner-agent/v1",
      proof: { format: "enclave-pvm-proof-agent/v1", chainId: cfg.chainId, addressBook: cfg.addressBook, deployment: D, endpoint: cfg.endpoint,
               operator: me, carrier: `http://127.0.0.1:${device.evidencePort}/`, maxFeePerGasWei: cfg.maxFeePerGasWei,
               evidence: { appId: appSha, allowedCodeHashes: cfg.evidence.allowedCodeHashes, allowedAuthorityHashes: cfg.evidence.allowedAuthorityHashes,
                           allowedRuntimeIds: cfg.evidence.allowedRuntimeIds, rootPins: cfg.evidence.rootPins, instanceIds: cfg.evidence.instanceIds } },
      lifecycle: { register: { repo: cfg.register.repo, measurement: "0x" + cfg.evidence.allowedCodeHashes[0], cpuPricePerSec6: cfg.register.cpuPricePerSec6 },
                   claim: D !== ZERO32, ...(gpuOptional ? { gpuOptional: true } : {}), ...(cfg.payout ? { payout: cfg.payout } : {}) } };
  }
  async function useRunner(D, appSha) {
    if (runner && runnerFor === `${D}:${appSha}`) return runner;
    const gpuOptional = !!(state.current && state.current.id === D && state.current.gpuOptional);
    if (runner) { const s = await runner.stop({ release: false }); if (s.kind === "in-flight") throw new Error("the previous runner still has a transaction in flight"); runner.close(); runner = null; runnerFor = null; }
    runner = await createRunnerAgent({ config: runnerConfig(D, appSha, { gpuOptional }), publicClient, account, stateDir: path.join(stateDir, "runners", D === ZERO32 ? "idle" : D.slice(2, 18)),
                                       fetchImpl: device.carrierFetch, now, sleep, log: (o) => log({ t: new Date(now()).toISOString(), layer: "runner", d: D.slice(0, 10), ...o }) });
    runnerFor = `${D}:${appSha}`;
    const st = await runner.start();
    note({ ev: "runner-started", deployment: D, appSha: appSha.slice(0, 16), proofKey: st.attested && st.attested.proofKey, attestReason: st.attestReason });
    return runner;
  }

  // ---- the VM ----
  async function launchVm({ D, file, sha, label, sock = 0, memMib = 0, opts = null }) {
    await device.ensurePorts();
    await device.stageApp(file, sha);
    await device.stageOptions(opts);
    await device.launch({ proofPins: proofPins(D), label, attachSigner: `http://127.0.0.1:${cfg.device.attachPort}/attach-sign`, sock, memMib, opts: !!opts });
    const s = await device.waitServing(label);
    await device.readToken();
    note({ ev: "vm-serving", deployment: D, app: sha.slice(0, 16), line: s.line.slice(0, 160) });
  }
  async function goIdle(why) {
    note({ ev: "go-idle", why });
    state.current = null; state.idle = { label: `idle-${new Date(now()).toISOString().replace(/[:.]/g, "")}`, at: now() }; save();
    await launchVm({ D: ZERO32, file: cfg.idleApp, sha: idleSha, label: state.idle.label });
    await useRunner(ZERO32, idleSha);
  }

  // ---- the catalog and the component ----
  async function versionOf(appRef) {
    const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d+)$/.exec(String(appRef || "").trim());
    if (!m) return null;
    const v = await read(addrs.appCatalog, CATALOG_ABI, "getVersion", [m[1], BigInt(m[2])]);
    let configCid = ""; try { configCid = String(await read(addrs.appCatalog, CATALOG_ABI, "versionConfigCid", [m[1], BigInt(m[2])]) || ""); } catch {}
    return { ...v, configCid };
  }
  const execFileP = (cmd, args, opts) => new Promise((res, rej) => execFile(cmd, args, opts, (e, so, se) => e ? rej(new Error(`${(se || e.message).toString().trim().slice(0, 300)}`)) : res(so.toString())));
  /** The component, CID-verified, and how it serves: a wasi:http handler, or a wasi:cli/run socket server on `httpPort`. */
  async function fetchComponent(cid, httpPort = 0) {
    if (!/^[A-Za-z0-9]{10,100}$/.test(cid)) throw new Error(`not a CID: ${cid}`);
    fs.mkdirSync(cfg.ipfs.cacheDir, { recursive: true });
    const out = path.join(cfg.ipfs.cacheDir, `${cid}.wasm`);
    if (!fs.existsSync(out)) {
      let last = null;
      for (const gw of cfg.ipfs.gateways) {
        try { await execFileP(cfg.ipfs.python || "python3", [cfg.ipfs.fetchScript, cid, out + ".part", String(256 << 20), gw], { timeout: 300000, maxBuffer: 4 << 20 }); fs.renameSync(out + ".part", out); last = null; break; }
        catch (e) { last = e; try { fs.unlinkSync(out + ".part"); } catch {} }
      }
      if (last) throw new Error(`the component ${cid} could not be CID-verified from any gateway: ${last.message}`);
    }
    const bytes = fs.readFileSync(out);
    if (bytes.subarray(0, 4).toString("binary") !== "\0asm" || bytes.readUInt16LE(6) !== 1) throw new Error("the artifact is not a WebAssembly component");
    if (bytes.includes(Buffer.from("wasi:nn"))) throw new Error("the component imports wasi:nn: the pVM CPU tier carries no model");
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    if (bytes.includes(Buffer.from("wasi:http/incoming-handler"))) return { file: out, sha, sock: 0 };
    if (httpPort && bytes.includes(Buffer.from("wasi:cli/run")) && bytes.includes(Buffer.from("wasi:sockets/tcp"))) return { file: out, sha, sock: httpPort };
    throw new Error(`the component is neither a wasi:http handler nor a socket server on a declared http port${httpPort ? "" : " (its version declares none)"}`);
  }

  // ---- the deployment's options: its config (CID-verified when it lives at a CID), its secrets, its rules, its way out ----
  async function fetchConfigCid(cid) {
    if (!/^[A-Za-z0-9]{10,100}$/.test(cid)) throw new Error(`not a CID: ${cid}`);
    fs.mkdirSync(cfg.ipfs.cacheDir, { recursive: true });
    const out = path.join(cfg.ipfs.cacheDir, `cfg-${cid}.json`);
    if (!fs.existsSync(out)) {
      let last = null;
      for (const gw of cfg.ipfs.gateways) {
        try { await execFileP(cfg.ipfs.python || "python3", [cfg.ipfs.fetchScript, cid, out + ".part", String(1 << 20), gw], { timeout: 120000, maxBuffer: 4 << 20 }); fs.renameSync(out + ".part", out); last = null; break; }
        catch (e) { last = e; try { fs.unlinkSync(out + ".part"); } catch {} }
      }
      if (last) throw new Error(`the config ${cid} could not be CID-verified from any gateway: ${last.message}`);
    }
    const text = fs.readFileSync(out, "utf8");
    JSON.parse(text);   // it must BE JSON before an app sees it
    return text;
  }
  /** The app's config text, as the CPU host resolves it (windows/node/host.mjs appConfig): the envelope's override, inline or
   *  at a CID; else the version's own config document (a rev-7 version's CID, which must be fetched: its inline field is then
   *  only the routing manifest); else the version's inline config. */
  async function appConfig(d, v) {
    const o = parseOptions(d.configCid, d.gpuMilli);
    if (o.config !== undefined) return JSON.stringify(o.config);
    if (o.configCid) return fetchConfigCid(o.configCid);
    if (v && v.configCid) return fetchConfigCid(v.configCid);
    return String((v && v.config) || "");
  }
  /** This deployment's staged secrets ({NAME: value}), fetched as the lease holder with the operator's signature, or null
   *  when the relay would not say (the reason logged: names and counts only, never a value). */
  async function secretsFor(D) {
    try {
      const r = await fetchSecrets({ id: D, endpoint: cfg.endpoint, base: cfg.relayOrigin, sign: (message) => account.signMessage({ message }),
                                     log: (m) => note({ ev: "secrets", deployment: D, m }) });
      return r.env || {};
    } catch (e) { note({ ev: "secrets-failed", deployment: D, error: e.message }); return null; }
  }
  /** The options file for a launch of D (with its secrets when given) and the launch's egress token. */
  async function launchOptions(D, d, v, secrets) {
    const o = parseOptions(d.configCid, d.gpuMilli);
    const text = substituteSecrets(await appConfig(d, v), secrets || {});
    const vars = { ...(secrets || {}) };
    if (text) vars.ENCLAVE_CONFIG = text;
    vars.ENCLAVE_HOSTS = `${D.slice(2, 10)}.app.enclave.host`;
    const token = cfg.egress ? crypto.randomBytes(16).toString("hex") : null;
    const file = optionsFile({ env: envBlock(vars), waf: o.waf || null, egress: token ? { port: cfg.egress.port, token } : null });
    note({ ev: "options", deployment: D, configBytes: text.length, secrets: Object.keys(secrets || {}).length, waf: !!o.waf, egress: !!token });
    return { file, token };
  }
  /**
   * Launch D's VM with its options as they are now (its row, its version, and `secrets` when the caller holds them).
   * The relay serves secrets only to the lease holder WHILE this host is eligible -- a VM attached -- so they are fetched
   * while a VM serves (restart, config edit: before the relaunch) or once a new one does (claim, a VM that died:
   * `needSecrets`, applied by the next round with one more relaunch, only when the relay says any exist).
   */
  async function launchFor(c, { secrets = null } = {}) {
    const d = await read(addrs.deployments, DEP_ABI, "get", [c.id]);
    const v = await versionOf(c.appRef);
    const { file, token } = await launchOptions(c.id, d, v, secrets);
    c.egressToken = token; c.configCid = String(d.configCid || ""); c.gpuMilli = Number(d.gpuMilli); c.cpuMilli = Number(d.cpuMilli);
    c.needSecrets = !secrets; if (secrets) c.secretsAt = now();
    save();
    await launchVm({ D: c.id, file: c.file, sha: c.sha, label: c.label, sock: c.sock || 0, memMib: c.memMib || 0, opts: file });
    return { secrets: secrets ? Object.keys(secrets).length : null };
  }
  /** A served VM launched without its secrets gets them (one relaunch) when the relay says it has any. */
  async function applySecrets(c) {
    const exists = await secretsExist({ id: c.id, base: cfg.relayOrigin }).catch((e) => { note({ ev: "secrets-unknown", deployment: c.id, error: e.message }); return null; });
    if (exists === false) { c.needSecrets = false; save(); return false; }
    const secrets = await secretsFor(c.id);
    if (!secrets) return false;                                  // refused or unreachable now: the next round asks again
    if (!Object.keys(secrets).length) { c.needSecrets = false; save(); return false; }
    c.label = `app-${c.id.slice(2, 10)}-${new Date(now()).toISOString().replace(/[:.]/g, "")}`; delete c.cert; save();
    await launchFor(c, { secrets });
    lastCert = 0;
    note({ ev: "secrets-applied", deployment: c.id, count: Object.keys(secrets).length });
    return true;
  }

  // ---- choosing work ----
  async function refusalFor(d) {
    const v = await versionOf(d.appRef).catch(() => null);
    return pvmClaimRefusal(d, v, { enclaveId: E, maxMemMb: cfg.claim.maxMemMb, nowSec: Math.floor(now() / 1000) }) || (v ? null : "no catalog version");
  }
  async function candidates() {
    const n = Number(await read(addrs.deployments, DEP_ABI, "count"));
    const rows = [];
    for (let s = 0; s < n; s += 100) rows.push(...await read(addrs.deployments, DEP_ABI, "getPage", [BigInt(s), BigInt(Math.min(100, n - s))]));
    const t = Math.floor(now() / 1000);
    // CPU-only deployments, and GPU-dialled ones whose owner said the card is optional (a publisher's gpuOptional is judged
    // when one is hinted or pinned here: refusalFor reads the version)
    const softGpu = (d) => { try { return parseOptions(d.configCid, d.gpuMilli).gpuOptional === true; } catch { return false; } };
    return rows.filter((d) => d.active && d.isPublic && (Number(d.gpuMilli) === 0 || softGpu(d)) && Number(d.leaseUntil) < t)
      .map((d) => { let pinned = false; try { const o = JSON.parse(String(d.configCid || "{}") || "{}"); pinned = lc(o?.placement?.hostId || "") === lc(E); } catch {} return { d, pinned }; })
      // the sweep takes what the fleet left: a deployment open for sweepGraceSec, unless hinted to this host or pinned to it
      .filter(({ d, pinned }) => pinned || hints.has(lc(d.id)) || t - Number(d.createdAt) >= cfg.claim.sweepGraceSec)
      .sort((a, b) => (b.pinned - a.pinned) || (hints.has(lc(b.d.id)) - hints.has(lc(a.d.id))) || (Number(b.d.createdAt) - Number(a.d.createdAt)));
  }
  async function sweep() {
    if (!cfg.claim.enabled || state.current || !registered) return null;
    for (const { d } of (await candidates()).slice(0, 16)) {
      const id = lc(d.id), old = state.refused[id];
      if (standDown.has(id) && standDown.get(id) > now()) continue;
      if (old && now() - old.at < 10 * 60_000 && !hints.has(id)) continue;
      const why = await refusalFor(d);
      if (why) { state.refused[id] = { at: now(), why }; save(); note({ ev: "not-taken", deployment: id, why }); continue; }
      let ok = false; try { ok = await read(addrs.deployments, DEP_ABI, "claimableBy", [d.id, E]); } catch {}
      if (!ok) { state.refused[id] = { at: now(), why: "the ledger says this host cannot claim it (unfunded at this host's rate, over its rate cap, or taken)" }; save(); continue; }
      hints.delete(id);
      return take(d);
    }
    return null;
  }
  async function take(d) {
    const D = lc(d.id), v = await versionOf(d.appRef);
    note({ ev: "taking", deployment: D, appRef: d.appRef, cid: v.cid, memMb: Number(v.memMb) });
    const httpPort = Number((String(v.ports || "").match(/http:(\d+)/) || [])[1] || 0);
    let comp;
    try { comp = await fetchComponent(v.cid, httpPort); }
    catch (e) { state.refused[D] = { at: now(), why: e.message }; save(); note({ ev: "not-taken", deployment: D, why: e.message }); return null; }
    if (runner) { const s = await runner.stop({ release: false }); if (s.kind === "in-flight") { note({ ev: "deferred", why: "a transaction is in flight" }); return null; } runner.close(); runner = null; runnerFor = null; }
    let soft = false; try { soft = parseOptions(d.configCid, d.gpuMilli).gpuOptional === true || JSON.parse(String(v.config || "{}") || "{}").gpuOptional === true; } catch {}
    const fb = cpuFallbackOf(v.config);
    state.current = { id: D, appRef: d.appRef, configCid: String(d.configCid || ""), cid: v.cid, sha: comp.sha, file: comp.file,
                      sock: comp.sock, memMib: comp.sock ? Math.min(1024, Math.max(64, Number(v.memMb) || 256, fb ? fb.memMb : 0)) : 0,
                      gpuOptional: Number(d.gpuMilli) > 0 && soft,
                      label: `app-${D.slice(2, 10)}-${new Date(now()).toISOString().replace(/[:.]/g, "")}`, phase: "preparing", at: now() };
    save();
    try {
      // the relay hands secrets to the LEASE HOLDER only, and the claim needs this VM attesting this app: so the first launch
      // has none, and once the claim lands the VM is relaunched with them -- only when the relay says there are any
      await launchFor(state.current);
      const r = await useRunner(D, comp.sha);
      const t = await r.tick();   // the claim (or the reason it was refused), then a first proof
      const L = await r.agent.lease();
      if (L.runner === lc(E) && L.runnerOperator === me && L.leaseUntil >= L.headTs) {
        state.current.phase = "serving"; state.current.claimedAt = now(); save();
        note({ ev: "claimed", deployment: D, leaseUntil: String(L.leaseUntil), tick: t.kind });
        await applySecrets(state.current);
        lastRunnerTick = now(); lastCert = 0;
        return D;
      }
      throw new Error(`not claimed: ${t.lifecycle ? (t.lifecycle.reason || t.lifecycle.kind) : t.kind}`);
    } catch (e) {
      state.refused[D] = { at: now(), why: e.message }; save();
      note({ ev: "take-failed", deployment: D, why: e.message });
      await goIdle(`taking ${D.slice(0, 10)} failed`);
      return null;
    }
  }

  /** Does the relay's own row for this host name the operator (its attach was signed by the registered owner)? Unknown = yes. */
  async function attachedAsOperator() {
    try {
      const r = await fetchImpl(`${cfg.relayOrigin}/enclaves`, { signal: AbortSignal.timeout(15000) });
      const rows = (await r.json()).enclaves || [];
      const row = rows.find((e) => lc(e.id) === lc(E));
      return !row || lc(row.operator || "") === me;
    } catch { return true; }
  }

  // ---- the app's certificate: a CSR made in the VM, issued by the relay after it verifies the VM's evidence for that key ----
  const labelOf = (D) => D.slice(2, 10);
  async function ensureCertificate() {
    const D = state.current.id, name = `${labelOf(D)}.app.enclave.host`;
    const csrAns = JSON.parse((await device.exchange(`CSR ${name}`)).split("\n")[0] || "{}");
    if (!csrAns.csr) throw new Error(`the VM made no CSR: ${csrAns.error || "no answer"}`);
    const der = Buffer.from(csrAns.csr, "base64");
    const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE REQUEST-----\n`;
    const spkiHash = crypto.createHash("sha256").update(spkiOfCsr(der)).digest("hex");
    const ts = Math.floor(now() / 1000);
    const opSig = await account.signMessage({ message: `enclave-certs-issue:${name}:${cfg.endpoint}:${spkiHash}:${ts}` });
    const r = await fetchImpl(`${cfg.relayOrigin}/v1/certs/issue`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, csr: pem, endpoint: cfg.endpoint, ts, opSig }), signal: AbortSignal.timeout(60000) });
    const body = await r.json().catch(() => ({}));
    if (r.status === 202) { note({ ev: "cert-pending", name, retryAfterSec: body.retryAfterSec }); return { pending: Math.min(300, Math.max(15, Number(body.retryAfterSec) || 30)) }; }
    if (r.status !== 200 || typeof body.certPem !== "string") throw new Error(`the relay issued no certificate for ${name}: ${r.status} ${body.error || ""} ${body.message || ""}`.trim());
    const chain = Buffer.from(body.certPem);
    const ans = JSON.parse((await device.exchange(`CERT ${chain.length}`, chain)).split("\n")[0] || "{}");
    if (ans.ok !== true) throw new Error(`the VM refused the chain: ${ans.error || "no answer"}`);
    state.current.cert = { name, notAfter: body.notAfter || null, at: now(), spkiHash }; save();
    note({ ev: "cert-installed", name, certs: ans.certs, notAfter: body.notAfter, cached: body.cached === true });
    return { ok: true };
  }

  // ---- one round ----
  async function tick() {
    if (busy) return { kind: "busy" };
    busy = true;
    try {
      if (!addrs) await resolve();
      await device.ensurePorts().catch((e) => note({ ev: "ports", error: e.message }));
      // after a restart, and on every round: carry on with what the state says is running; a VM that no longer serves it
      // (the app's process gone, its session ended) is launched again with the same app and pins
      const label = state.current ? state.current.label : state.idle && state.idle.label;
      const up = label ? await device.alive(label) : false;
      if (!runner || !up) {
        if (!up && runner) { note({ ev: "vm-gone", label }); }
        if (state.current) {
          if (!up) {
            // a relaunched VM holds no certificate (the chain lives in its memory only): install it again
            state.current.label = `app-${state.current.id.slice(2, 10)}-${new Date(now()).toISOString().replace(/[:.]/g, "")}`; delete state.current.cert; save();
            await launchFor(state.current);   // no secrets yet: the relay serves them once this VM attaches (needSecrets)
          } else await device.readToken();
          await useRunner(state.current.id, state.current.sha);
        } else if (!up) await goIdle(runner ? "the VM ended" : "start");
        else { await device.readToken(); await useRunner(ZERO32, idleSha); }
      }
      const reg = await read(addrs.registry, REGISTRY_ABI, "get", [E]).catch(() => null);
      registered = reg && lc(reg.operator) === me && reg.active ? reg : null;
      // the runner's round (register / setProofKey / renew / heartbeat / withdraw / prove), every interval or when unregistered
      if (now() - lastRunnerTick >= (registered ? 300_000 : 60_000)) {
        lastRunnerTick = now();
        const t = await runner.tick();
        note({ ev: "runner-tick", deployment: state.current ? state.current.id.slice(0, 10) : "idle", kind: t.kind, lifecycle: t.lifecycle && (t.lifecycle.op || t.lifecycle.kind) });
      }
      if (state.current && state.current.phase === "serving") {
        const L = await runner.agent.lease();
        if (!L.active || L.runner !== lc(E) || L.runnerOperator !== me || L.leaseUntil < L.headTs) {
          note({ ev: "lease-over", deployment: state.current.id, active: L.active, runner: L.runner, leaseUntil: String(L.leaseUntil) });
          // still ours and live (the owner stopped it, or moved it): a final proof, then release, so the unused tail goes back
          const s = await runner.stop({ release: L.runner === lc(E) && L.runnerOperator === me && L.leaseUntil >= L.headTs });
          if (s.kind === "in-flight") return { kind: "in-flight" };
          runner.close(); runner = null; runnerFor = null;
          await goIdle("the lease is over");
        } else if (state.current.needSecrets && now() - (state.current.secretsTriedAt || 0) >= 60_000) {
          state.current.secretsTriedAt = now();
          await applySecrets(state.current);
        } else if (await optionsChanged()) {
          // handled (relaunched on the new options, or released when they are no longer this host's to apply)
        } else if ((!state.current.cert || (state.current.cert.notAfter && Date.parse(state.current.cert.notAfter) - now() < 30 * 86400_000))
                   && now() - lastCert >= 60_000) {
          lastCert = now();
          try { await ensureCertificate(); } catch (e) { note({ ev: "cert-failed", error: e.message }); }
        }
      } else if (!state.current && registered && now() - lastReattach >= 15 * 60_000 && !(await attachedAsOperator())) {
        // the hub counts this host as its operator's only from an attach made AFTER the name was registered (the co-signer's
        // signature over that attach); one made before (first-come) is re-made by restarting the idle VM
        lastReattach = now();
        await goIdle("re-attach under the registered name");
      } else if (!state.current && now() - lastSweep >= (hints.size ? 0 : 60_000)) {
        lastSweep = now();
        await sweep();
      }
      return { kind: "ok", current: state.current && state.current.id, registered: !!registered };
    } finally { busy = false; }
  }

  /**
   * configEdit / shareResize on the LIVE lease: the owner's setConfig or setShares, seen on the ledger row. New options are
   * judged as at claim; still this host's to run, the app is relaunched on them (same lease, same VM instance and key; its
   * certificate installed again); no longer this host's (a namespace it does not apply, a GPU share without
   * gpu.optional), the lease is released with the reason. A share change alone is admission and billing here (one app, one
   * VM): nothing is relaunched for it.
   */
  async function optionsChanged() {
    const c = state.current;
    const d = await read(addrs.deployments, DEP_ABI, "get", [c.id]).catch(() => null);
    if (!d) return false;
    const cfgChanged = String(d.configCid || "") !== String(c.configCid || "");
    const shareChanged = c.cpuMilli !== undefined && (Number(d.cpuMilli) !== c.cpuMilli || Number(d.gpuMilli) !== c.gpuMilli);
    if (!cfgChanged && !shareChanged) return false;
    const v = await versionOf(c.appRef).catch(() => null);
    const why = pvmClaimRefusal({ ...d, leaseUntil: 0n }, v, { enclaveId: E, maxMemMb: cfg.claim.maxMemMb, nowSec: Math.floor(now() / 1000) });
    note({ ev: cfgChanged ? "config-edited" : "shares-resized", deployment: c.id, cpuMilli: Number(d.cpuMilli), gpuMilli: Number(d.gpuMilli), refused: why });
    if (why) {
      const s = await runner.stop({ release: true });
      if (s.kind === "in-flight") return true;
      runner.close(); runner = null; runnerFor = null;
      state.refused[c.id] = { at: now(), why }; save();
      await goIdle(`its new options are not this host's to apply: ${why}`);
      return true;
    }
    if (!cfgChanged) { c.cpuMilli = Number(d.cpuMilli); c.gpuMilli = Number(d.gpuMilli); save(); return true; }
    const secrets = await secretsFor(c.id);   // while this VM still serves (eligible); null: the new one gets them later
    c.label = `app-${c.id.slice(2, 10)}-${new Date(now()).toISOString().replace(/[:.]/g, "")}`; delete c.cert; save();
    await launchFor(c, { secrets });
    lastCert = 0;
    return true;
  }

  // ---- the host surface (reached through the phone's tunnel: untrusted requests) ----
  function availability() {
    const cur = state.current, ok = !!registered && cfg.claim.enabled;
    return { ok: true, role: "pvm-host", name: cfg.name, gpu: false, claimEnabled: ok, fullService: false, registered: !!registered,
      enclaveId: E, operator: me, proofKey: registered ? lc(registered.proofKey) : null,
      askCpuPricePerSec6: Number(cfg.register.cpuPricePerSec6), askGpuPricePerSec6: 0,
      slots: 1, nodeSlotsFree: cur ? 0 : 1, cpuShareFree: cur ? 0 : 1, maxAppMemMb: cfg.claim.maxMemMb,
      isolation: ISOLATION_BACKEND, appTls: "in-vm", appEvidence: "enclave-pvm-app-evidence/v4", claimScope: "market",
      // the platform's capability flags (the relay AND-folds them across the fleet): each true only for what this host does
      networkOptions: true, networkTransports: ["tuna"], secrets: true, secretsInConfig: true, configOverride: true, configCidOverride: true,
      configEdit: true, shareResize: true, waf: true, wafScope: "per-deployment: the app's hostname reaches the VM as TLS through TUNA, with no client address",
      gpuOptional: true, cpuFallback: true, rateCap: true, proofOfTime: true, mem64: true, set: false, p3: false, coopThreads: false,
      egress: cfg.egress ? "tuna-per-app" : false, customDomains: false, devDeploy: false,
      apps: cur ? [{ id: cur.id, phase: cur.phase, appSha256: cur.sha, since: new Date(cur.at).toISOString(), cert: cur.cert ? cur.cert.name : null }] : [] };
  }
  async function claimHint(body) {
    const id = lc(body && body.id);
    if (!B32.test(id)) return { accepted: false, reason: "A ledger deployment ID is required." };
    if (!cfg.claim.enabled || !registered) return { accepted: false, reason: "This host is not taking deployments right now." };
    if (state.current && state.current.id === id) return { accepted: true, reason: "Already serving it." };
    if (state.current) return { accepted: false, reason: "This host's one slot is in use." };
    if (!addrs) await resolve();
    const d = await read(addrs.deployments, DEP_ABI, "get", [id]);
    const why = await refusalFor(d);
    if (why) return { accepted: false, reason: `Not taken by this host: ${why}.` };
    hints.add(id); delete state.refused[id];
    setImmediate(() => tick().catch((e) => note({ ev: "tick-error", error: e.message })));
    return { accepted: true, reason: "Claiming: the VM starts the app, then claims the lease." };
  }
  async function evidence(q) {
    const D = lc(q.get("deployment") || ""), nonce = String(q.get("nonce") || "");
    if (!/^[0-9a-f]{64}$/.test(nonce)) return [400, { error: "nonce must be 64 lowercase hex" }];
    if (!state.current || state.current.id !== D) return [404, { error: "this host does not serve that deployment now" }];
    const a = await device.exchange(`EVIDENCE3 ${nonce}`, null, 30000);
    try { return [200, JSON.parse(a.split("\n")[0])]; } catch { return [502, { error: "the VM gave no evidence" }]; }
  }
  function handler() {
    return async (req, res) => {
      try {
        const u = new URL(req.url, "http://agent"), p = u.pathname;
        if (req.method === "GET" && p === "/availability") return json(res, 200, availability());
        if (req.method === "GET" && p === "/v1/health") return json(res, 200, { ok: true, role: "pvm-host", name: cfg.name });
        if (req.method === "POST" && p === "/v1/claim-hint") {
          let raw = ""; for await (const c of req) { raw += c; if (raw.length > 4096) return json(res, 413, { accepted: false, reason: "too large" }); }
          let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
          return json(res, 200, await claimHint(body));
        }
        if (req.method === "GET" && p === "/v1/pvm/evidence") { const [s, b] = await evidence(u.searchParams); return json(res, s, b); }
        if (req.method === "GET" && p === "/v1/deployments") return json(res, 200, { deployments: state.current ? [record()] : [] });
        const act = /^\/v1\/deployments\/(0x[0-9a-f]{64})(\/restart|\/attestation)?$/.exec(p.toLowerCase());
        if (act && (req.method === "POST" || req.method === "DELETE" || act[2] === "/attestation")) {
          const id = act[1];
          if (!state.current || state.current.id !== id) return json(res, 404, { error: "not_found", id });
          if (act[2] === "/attestation" && req.method === "GET") {
            // the VM's own v4 evidence for a fresh nonce: public (the app's origin answers it too); verify with
            // relay/pvm-app-attest.mjs verifyPvmAppEvidence against Google's roots and the pinned build and runtime
            const nonce = crypto.randomBytes(32).toString("hex"), [st, doc] = await evidence(new URLSearchParams({ deployment: id, nonce }));
            return json(res, st, st === 200 ? { format: "enclave-pvm-app-evidence", host: cfg.name, deploymentId: id, nonce, evidence: doc,
              verify: "relay/pvm-app-attest.mjs verifyPvmAppEvidence(evidence, { nonce, appId: evidence.app, requireTls: true, pins })" } : doc);
          }
          let raw = Buffer.alloc(0); for await (const c of req) { raw = Buffer.concat([raw, c]); if (raw.length > 65536) return json(res, 413, { error: "too_large" }); }
          const no = await ownerRefusal(req, raw, id, "api.restart");
          if (no) return json(res, no[0], no[1]);
          if (req.method === "POST" && act[2] === "/restart") { const [st, b] = await restartServed(); return json(res, st, b); }
          if (req.method === "DELETE" && !act[2]) { const [st, b] = await releaseServed(u.searchParams.get("evacuate") === "1"); return json(res, st, b); }
          return json(res, 405, { error: "method_not_allowed" });
        }
        const m = /^\/v1\/deployments\/(0x[0-9a-f]{64})(\/logs)?$/.exec(p.toLowerCase());
        if (req.method === "GET" && m) {
          if (!state.current || state.current.id !== m[1]) return json(res, 404, { error: "not_found", id: m[1] });
          return m[2] ? json(res, 200, { id: m[1], lines: await lifecycleLog(200) }) : json(res, 200, record());
        }
        return json(res, 404, { error: "not_found" });
      } catch (e) { note({ ev: "http-error", error: e.message }); return json(res, 500, { error: "internal" }); }
    };
  }
  /** The owner's wallet session for `scope` on deployment `id` (null = allowed), or [status, body] refusing. */
  async function ownerRefusal(req, raw, id, scope) {
    const header = req.headers.authorization;
    if (!isSessionHeader(header)) return [401, { error: "unauthorized", message: "This host takes the owner's wallet session (EnclaveSession)." }];
    try {
      if (!addrs) await resolve();
      const session = await sessions.verify({ header, method: req.method, path: req.url, body: raw, scope, fresh: true });
      const d = await read(addrs.deployments, DEP_ABI, "get", [id]);
      const why = await sessions.refusal(session, { id, owner: d.owner }, { fresh: true });
      return why ? [403, { error: "not_allowed", id, message: why }] : null;
    } catch (e) { return [Number.isInteger(e.status) ? e.status : 503, { error: e.code || "session_check_failed", message: e.message }]; }
  }
  /** Restart: the same app and pins in a fresh VM (its certificate installed again). */
  async function restartServed() {
    if (busy) return [409, { error: "busy", message: "This host is mid-round; retry in a moment." }];
    busy = true;
    try {
      const c = state.current;
      c.label = `app-${c.id.slice(2, 10)}-${new Date(now()).toISOString().replace(/[:.]/g, "")}`; delete c.cert; save();
      // a restart applies the owner's current secrets and config: fetched while this VM still serves (the host eligible)
      await launchFor(c, { secrets: await secretsFor(c.id) });
      lastCert = 0;
      note({ ev: "restarted", deployment: c.id });
      return [200, { id: c.id, restarted: true, label: c.label }];
    } catch (e) { return [500, { error: "restart_failed", message: e.message }]; }
    finally { busy = false; }
  }
  /** Release (the owner suspended or moved it): a final proof, release, idle; `evacuate` keeps it from being re-claimed for 10 min. */
  async function releaseServed(evacuate) {
    if (busy) return [409, { error: "busy", message: "This host is mid-round; retry in a moment." }];
    busy = true;
    try {
      const c = state.current;
      if (evacuate) standDown.set(c.id, now() + 10 * 60_000);
      const s = runner ? await runner.stop({ release: true }) : { kind: "stopped" };
      if (s.kind === "in-flight") return [409, { error: "in_flight", message: "A transaction is in flight; retry shortly." }];
      if (runner) { runner.close(); runner = null; runnerFor = null; }
      await goIdle(evacuate ? "the owner moved it" : "the owner released it");
      return [200, { id: c.id, released: s.kind === "released", kind: s.kind }];
    } catch (e) { return [500, { error: "release_failed", message: e.message }]; }
    finally { busy = false; }
  }

  // the served deployment as this host has it
  function record() {
    const c = state.current;
    return { id: c.id, appRef: c.appRef, status: c.phase === "serving" ? "running" : "starting", enclave: cfg.name, runtime: "pvm-rt (Pulley)",
             appSha256: c.sha, componentCid: c.cid, since: new Date(c.at).toISOString(), ...(c.claimedAt ? { claimedAt: new Date(c.claimedAt).toISOString() } : {}),
             tls: c.cert ? { name: c.cert.name, notAfter: c.cert.notAfter, spkiSha256: c.cert.spkiHash } : null, isolation: ISOLATION_BACKEND };
  }
  // the VM's lifecycle lines for the served app: serving, connections and request counts, evidence answers, the certificate,
  // checkpoints. Never a request's stderr or any byte of traffic (the app's own output is not this host's to publish).
  async function lifecycleLog(n) {
    if (!state.current) return [];
    const text = await device.capture(state.current.label);
    return text.split("\n").map((l) => l.replace(/^VSOCK /, ""))
      .filter((l) => /^(APP (serving|refused|http|served|tls key|evidence endpoint|sealed requests)|APP connection closed|TLS (CSR|chain)|CHECKPOINT|EVIDENCE answered|PROOF key|PROOFPINS|RELAY attest|RELAY caps|RELAY tunnel)/.test(l)
                     && !/stderr/.test(l))
      .slice(-n);
  }

  async function serve(port) {
    const srv = http.createServer(handler());
    await new Promise((r, j) => { srv.once("error", j); srv.listen(port, "127.0.0.1", r); });
    if (cfg.egress) {
      // the app's way out (egress.mjs): only for the deployment now served, with this launch's token
      const eg = createEgressServer({ routesFile: cfg.egress.routesFile, log: (o) => note(o),
        current: () => (state.current && state.current.egressToken ? { token: state.current.egressToken, deployment: state.current.id } : null) });
      await new Promise((r, j) => { eg.once("error", j); eg.listen(cfg.egress.port, "127.0.0.1", r); });
      srv.on("close", () => eg.close());
      note({ ev: "egress-surface", listen: `127.0.0.1:${cfg.egress.port}` });
    }
    return srv;
  }
  async function stop({ release = false } = {}) {
    if (!runner) return { kind: "stopped" };
    const s = await runner.stop({ release });
    runner.close(); runner = null; runnerFor = null;
    return s;
  }
  return { tick, availability, claimHint, evidence, handler, serve, stop, ensureCertificate, refusalFor, state: () => state, config: cfg };
}

/** The DER SubjectPublicKeyInfo inside a PKCS#10 request (the second element of its CertificationRequestInfo). */
export function spkiOfCsr(der) {
  const tlv = (b, off) => {
    let len = b[off + 1], hdr = 2;
    if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + b[off + 2 + i]; hdr = 2 + n; }
    return { tag: b[off], start: off, body: off + hdr, end: off + hdr + len };
  };
  const top = tlv(der, 0), cri = tlv(der, top.body);
  let o = cri.body;
  const ver = tlv(der, o); o = ver.end;
  const subj = tlv(der, o); o = subj.end;
  const spki = tlv(der, o);
  if (spki.tag !== 0x30) throw new Error("no SubjectPublicKeyInfo in the request");
  return der.subarray(spki.start, spki.end);
}
