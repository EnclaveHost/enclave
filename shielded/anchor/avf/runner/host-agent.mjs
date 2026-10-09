// host-agent.mjs -- the owner's HOST agent for a phone that sells its protected VMs (PVM-CPU.md "Serving buyers", "Slots by
// share"). It is what metal0's supervisor and the NucBox node agent are for their boxes: the host surface the relay talks to,
// the market sweep, the lease lifecycle and the apps' certificates -- around one HOST VM and up to four SLOT VMs, one per
// buyer's app, each sized to that app's share.
//
//   host VM   the release app's main process: it serves the idle app (a CPU-only probe) with proof pins for deployment ZERO,
//             attaches the phone's tunnel to the relay, and holds the host's registered proof key; the host runner
//             (runner-agent.mjs, deployment ZERO, claim off) registers the endpoint with the owner's price, heartbeats it and
//             withdraws earnings.
//   slot k    AnchorServiceSlotK, its own process and VM instance (<vmName>s<k>): ONE deployment D, the VM resized to D's app
//             (its memory plus the VM's own, at least 384 MiB; one vCPU for a share of at most 1/8). Before D's runner starts
//             the slot VM proves it holds the host's proof key (the sibling statement); a slot that does not is given it by
//             the host VM, which verifies the slot's Android attestation IN the VM (pvm-rt keygrant.rs: same build, protected,
//             fresh) -- the agent only carries bytes. D's runner (claim on, proof-key sync OFF: a slot never re-registers the
//             host's key) claims, renews and proves; this agent asks the relay for D's certificate (a CSR made in the slot VM)
//             and installs it. When D ends, a final proof and release, and the slot is free.
//   router    the TUNA privacy agent's one app port: each connection goes to the slot VM serving the name in its ClientHello
//             (sni-router.mjs; TLS ends in the VM).
//
// The phone's pool (slots.poolMemMb of VM memory, 1000 per mille of CPU share) is what the slots divide: a deployment is taken
// only when its VM and its share fit what is free. One operator key, one transaction in flight: a runner with a transaction
// pending is followed first, and no other runner sends until it settles. Every value the agent signs or registers comes from
// a VM's attested statement (proof key, build), the chain, or the owner's config -- never from the phone's words or a relay
// request. Requests arriving through the tunnel are untrusted: a claim hint only makes the agent LOOK at a deployment, and
// evidence is the VM's own, verified by its reader.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { parseAbi, keccak256, stringToBytes, hexToString, recoverAddress } from "viem";
import { createRunnerAgent } from "./runner-agent.mjs";
import { verifyPvmAppEvidence } from "../../../../relay/pvm-app-attest.mjs";
// a WALLET SESSION as the owner's credential, verified on chain exactly as the other hosts do (shared with supervisor.js)
import { createSessionApiAuth, apiBases, isSessionHeader, DEFAULT_FACTORIES, DEFAULT_API_HOSTS } from "../../../../windows/node/session-api-auth.mjs";
// the deployment's protection rules and secrets, by the CPU host's own modules (the platform's rules, mirrored there)
import { parseWaf } from "../../../../windows/node/waf.mjs";
import { secretsExist } from "../../../../windows/node/secrets.mjs";
import { createEgressServer } from "./egress.mjs";
import { createSniRouter } from "./sni-router.mjs";

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
  const KEYS = ["addressBook", "chainId", "claim", "device", "egress", "evidence", "format", "idleApp", "ipfs", "maxFeePerGasWei", "name", "operator", "payout", "register", "relayOrigin", "slots"];
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
  const sl = c.slots;
  if (!sl || Object.keys(sl).sort().join() !== "count,poolMemMb,routerPort" || !Number.isInteger(sl.count) || sl.count < 1 || sl.count > 4
      || !Number.isInteger(sl.poolMemMb) || sl.poolMemMb < MIN_VM_MB || sl.poolMemMb > 12288 || !Number.isInteger(sl.routerPort) || sl.routerPort < 1024 || sl.routerPort > 65535)
    bad(`slots must be exactly { count (1..4 slot VMs), poolMemMb (${MIN_VM_MB}..12288: the VM memory they share), routerPort (the TUNA app port) }`);
  if (vmMibFor(cl.maxMemMb) > sl.poolMemMb) bad(`claim.maxMemMb ${cl.maxMemMb} needs a ${vmMibFor(cl.maxMemMb)} MiB VM, beyond slots.poolMemMb`);
  const i = c.ipfs || {};
  if (typeof i.fetchScript !== "string" || !Array.isArray(i.gateways) || !i.gateways.length || typeof i.cacheDir !== "string") bad("ipfs must be { python, fetchScript, gateways, cacheDir }");
  return { ...c, endpoint: `${c.relayOrigin}/t/${c.name}`, enclaveId: keccak256(stringToBytes(`${c.relayOrigin}/t/${c.name}`)) };
}

// ---- the slots' sizes (PVM-CPU.md "Slots by share") ----
export const VM_OVERHEAD_MB = 128;   // Microdroid, the payload and the runtime: ~100 MiB measured, with room
export const MIN_VM_MB = 384;        // the smallest VM measured serving (hello-world at 384, a 256 MiB socket app at 512)
export const ONE_CPU_MAX_MILLI = 125;   // a share of at most 1/8 of the phone (8 cores) gets one vCPU; above, as many as the host
/** A slot VM's memory for an app of appMemMb: the app plus the VM's own, at least MIN_VM_MB, in 64 MiB steps. */
export const vmMibFor = (appMemMb) => Math.ceil(Math.max(MIN_VM_MB, appMemMb + VM_OVERHEAD_MB) / 64) * 64;
/** An app's memory (its socket server's, or each request's instance of a handler): its version's, raised by its cpuFallback;
 *  256 MiB when it states none; 64..1024. */
export function appMemFor(version) {
  const fb = cpuFallbackOf(version && version.config);
  const declared = Math.max(Number(version && version.memMb) || 0, fb ? fb.memMb : 0);
  return Math.min(1024, Math.max(64, declared || 256));
}
/**
 * Room for one more app on the phone: { slot, vmMib, cpus } or { why }. `apps`: the apps the slots hold now ({ slot, vmMib,
 * cpuMilli }); `except`: a slot not counted (its own app, resized). Pure.
 */
export function slotFor({ count, poolMemMb }, apps, { cpuMilli, appMemMb }, except = 0) {
  const held = apps.filter((a) => a && a.slot !== except);
  const vmMib = vmMibFor(appMemMb), cpus = Number(cpuMilli) <= ONE_CPU_MAX_MILLI ? 1 : 0;
  const free = [];
  for (let k = 1; k <= count; k++) if (k === except || !held.some((a) => a.slot === k)) free.push(k);
  if (!free.length) return { why: `all ${count} of its slots are in use` };
  const mem = held.reduce((t, a) => t + (Number(a.vmMib) || 0), 0), cpu = held.reduce((t, a) => t + (Number(a.cpuMilli) || 0), 0);
  if (mem + vmMib > poolMemMb) return { why: `its VM needs ${vmMib} MiB and ${Math.max(0, poolMemMb - mem)} MiB of the phone's pool is free` };
  if (cpu + Number(cpuMilli) > 1000) return { why: `it asks cpuMilli ${cpuMilli} and ${Math.max(0, 1000 - cpu)} of the phone's CPU share is free` };
  return { slot: except || free[0], vmMib, cpus };
}

/** The sibling statement's digest (relay/pvm-market.mjs siblingDigest; pvm-rt keygrant.rs sibling_digest). */
export const SIBLING_FORMAT = "enclave-pvm-sibling/v1";
export const siblingDigest = ({ nonce, transportSpki, instanceId, deployment }) => crypto.createHash("sha256").update(Buffer.concat([
  Buffer.from("enclave-pvm-sibling-v1\n"), Buffer.from(nonce, "hex"), crypto.createHash("sha256").update(Buffer.from(transportSpki, "hex")).digest(),
  Buffer.from(instanceId, "hex"), Buffer.from(String(deployment).slice(2), "hex")])).digest();

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
export function optionsFile({ env = null, waf = null, egress = null, sealed = null }) {
  const lines = [];
  if (env && env.length) lines.push(`ENV ${env.toString("hex")}`);
  if (waf) lines.push(`WAF ${Buffer.from(JSON.stringify(waf)).toString("hex")}`);
  if (sealed) lines.push(`SEALED ${sealed}`);
  if (egress) lines.push(`EGRESS ${egress.port} ${egress.token}`);
  return lines.length ? lines.join("\n") + "\n" : null;
}

const json = (res, status, body) => { const b = Buffer.from(JSON.stringify(body)); res.writeHead(status, { "content-type": "application/json", "content-length": b.length, "cache-control": "no-store" }); res.end(b); };

// createRunner / verifyEvidence: the runner agent and the evidence reader (injectable for tests without a chain or a phone)
export async function createHostAgent({ config, publicClient, account, stateDir, device, fetchImpl = globalThis.fetch, now = Date.now,
                                        sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {},
                                        createRunner = createRunnerAgent, verifyEvidence = verifyPvmAppEvidence }) {
  const cfg = checkHostConfig(config), E = cfg.enclaveId, me = cfg.operator, S = cfg.slots;
  if (account.address.toLowerCase() !== me) throw new Error(`host-agent: the signer ${account.address} is not the configured operator ${me}`);
  if (device.slots !== S.count) throw new Error(`host-agent: the device drives ${device.slots} slots, the config says ${S.count}`);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(stateDir, "host-state.json");
  // host: the host VM's launch; slots: k -> the app slot k serves (or null); refused: deployment -> why, when
  let state = { host: null, slots: {}, refused: {} };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, "utf8")) }; } catch {}
  const save = () => { const t = stateFile + ".tmp"; fs.writeFileSync(t, JSON.stringify(state, null, 1), { mode: 0o600 }); fs.renameSync(t, stateFile); };
  const note = (o) => log({ t: new Date(now()).toISOString(), layer: "host", ...o });
  // from the one-VM agent: its app moves to slot 1 (relaunched there, the same lease), and the host VM goes back to idle
  if ("current" in state || "idle" in state) {
    const c = state.current;
    if (c) {
      const appMem = c.memMib || 256;
      state.slots["1"] = { ...c, slot: 1, appMem, vmMib: vmMibFor(appMem), cpus: Number(c.cpuMilli) <= ONE_CPU_MAX_MILLI ? 1 : 0, label: null };
      delete state.slots["1"].memMib; delete state.slots["1"].cert;
    }
    delete state.current; delete state.idle; state.host = null; save();
    note({ ev: "migrated", why: "one VM per app: the served app moves to slot 1", deployment: c ? c.id : null });
  }
  const read = (address, abi, functionName, args = []) => publicClient.readContract({ address, abi, functionName, args });
  const lc = (a) => String(a).toLowerCase();
  const stamp = () => new Date(now()).toISOString().replace(/[:.]/g, "");
  const first = (text) => { try { return JSON.parse(String(text).split("\n")[0] || "{}"); } catch { return {}; } };
  const idleSha = crypto.createHash("sha256").update(fs.readFileSync(cfg.idleApp)).digest("hex");
  let addrs = null, busy = false, lastSweep = 0, registered = null, lastReattach = 0, hostUp = false;
  const runners = new Map();     // "host" | k -> { r, key, lastTick }
  const lastCert = new Map();    // k -> ms
  const standDown = new Map();   // deployment -> until (ms): the owner moved it away; not re-claimed meanwhile
  const sessions = createSessionApiAuth({ pc: publicClient, book: () => cfg.addressBook, ledger: () => (addrs ? addrs.deployments : null),
    factories: DEFAULT_FACTORIES, bases: () => apiBases({ hosts: DEFAULT_API_HOSTS, tunnelNames: [cfg.name], publicUrls: [cfg.endpoint] }),
    log: (m) => note({ ev: "session-auth", m }) });
  const hints = new Set();
  const apps = () => Object.entries(state.slots).filter(([, a]) => a).map(([k, a]) => { a.slot = Number(k); return a; }).sort((x, y) => x.slot - y.slot);
  const appOf = (D) => apps().find((a) => a.id === lc(D)) || null;
  const slotDev = (a) => device.slot(a.slot);

  async function resolve() {
    const [keys, values] = await read(cfg.addressBook, BOOK_ABI, "all");
    const book = {};
    keys.forEach((k, i) => { book[hexToString(k, { size: 32 }).replace(/\0+$/, "")] = lc(values[i]); });
    for (const k of ["registry", "deployments", "proofOfTime", "appCatalog"]) if (!book[k]) throw new Error(`the address book has no ${k}`);
    addrs = book;
    return book;
  }
  const proofPins = (D) => `${cfg.chainId} ${addrs.proofOfTime} ${addrs.registry} ${D} ${E} ${me}`;

  // ---- the runners: the host's (deployment ZERO: register, heartbeat, withdraw) and one per slot (its deployment's lease) ----
  function runnerConfig(D, appSha, { carrierPort, instanceIds, slot = false, gpuOptional = false }) {
    return { format: "enclave-pvm-runner-agent/v1",
      proof: { format: "enclave-pvm-proof-agent/v1", chainId: cfg.chainId, addressBook: cfg.addressBook, deployment: D, endpoint: cfg.endpoint,
               operator: me, carrier: `http://127.0.0.1:${carrierPort}/`, maxFeePerGasWei: cfg.maxFeePerGasWei,
               evidence: { appId: appSha, allowedCodeHashes: cfg.evidence.allowedCodeHashes, allowedAuthorityHashes: cfg.evidence.allowedAuthorityHashes,
                           allowedRuntimeIds: cfg.evidence.allowedRuntimeIds, rootPins: cfg.evidence.rootPins, instanceIds } },
      // a slot's runner never registers or re-keys the entry: the host's key is the host VM's, and a slot that does not
      // attest it stops (proof-key-mismatch) instead of moving the host's key to itself
      lifecycle: slot ? { claim: true, syncProofKey: false, ...(gpuOptional ? { gpuOptional: true } : {}) }
                      : { register: { repo: cfg.register.repo, measurement: "0x" + cfg.evidence.allowedCodeHashes[0], cpuPricePerSec6: cfg.register.cpuPricePerSec6 },
                          claim: false, ...(cfg.payout ? { payout: cfg.payout } : {}) } };
  }
  const anyPending = (except) => [...runners].some(([w, e]) => w !== except && e.r.agent.pending);
  async function closeRunner(who) {
    const e = runners.get(who);
    if (!e) return { kind: "stopped" };
    const s = await e.r.stop({ release: false });
    e.r.close(); runners.delete(who);
    if (s.kind === "in-flight") note({ ev: "runner-closed-in-flight", who, why: "its journal keeps the transaction; a runner for the same deployment settles it" });
    return s;
  }
  async function useRunner(who, D, appSha, dev, opts) {
    const key = `${D}:${appSha}:${opts.instanceIds.join(",")}`;
    const cur = runners.get(who);
    if (cur && cur.key === key) return cur.r;
    if (cur) { const s = await cur.r.stop({ release: false }); if (s.kind === "in-flight") throw new Error("the previous runner still has a transaction in flight"); cur.r.close(); runners.delete(who); }
    const r = await createRunner({ config: runnerConfig(D, appSha, { carrierPort: dev.evidencePort, ...opts }), publicClient, account,
                                       stateDir: path.join(stateDir, "runners", D === ZERO32 ? "idle" : D.slice(2, 18)),
                                       fetchImpl: dev.carrierFetch, now, sleep, log: (o) => log({ t: new Date(now()).toISOString(), layer: "runner", d: D.slice(0, 10), ...o }) });
    runners.set(who, { r, key, lastTick: 0 });
    const st = await r.start();
    note({ ev: "runner-started", who, deployment: D, appSha: appSha.slice(0, 16), proofKey: st.attested && st.attested.proofKey, attestReason: st.attestReason });
    return r;
  }
  const hostRunner = () => useRunner("host", ZERO32, idleSha, device, { instanceIds: cfg.evidence.instanceIds });
  const slotRunner = (a) => useRunner(a.slot, a.id, a.sha, slotDev(a), { instanceIds: [a.instanceId], slot: true, gpuOptional: !!a.gpuOptional });

  // ---- the host VM: the idle app, the tunnel, the host's proof key ----
  async function launchHost(why) {
    note({ ev: "host-launch", why });
    state.host = { label: `idle-${stamp()}`, at: now() }; save();
    await device.ensurePorts();
    await device.stageApp(cfg.idleApp, idleSha);
    await device.stageOptions(null);
    await device.launch({ proofPins: proofPins(ZERO32), label: state.host.label, attachSigner: `http://127.0.0.1:${cfg.device.attachPort}/attach-sign` });
    const s = await device.waitServing(state.host.label);
    await device.readToken();
    note({ ev: "vm-serving", vm: "host", line: s.line.slice(0, 160) });
    hostUp = true;
    await hostRunner();
  }

  // ---- the catalog and the component ----
  async function versionOf(appRef) {
    const m = /^catalog:\/\/(0x[0-9a-fA-F]{64})\/(\d+)$/.exec(String(appRef || "").trim());
    if (!m) return null;
    const v = await read(addrs.appCatalog, CATALOG_ABI, "getVersion", [m[1], BigInt(m[2])]);
    let configCid = ""; try { configCid = String(await read(addrs.appCatalog, CATALOG_ABI, "versionConfigCid", [m[1], BigInt(m[2])]) || ""); } catch {}
    return { ...v, configCid };
  }
  const httpPortOf = (v) => Number((String(v.ports || "").match(/http:(\d+)/) || [])[1] || 0);
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
  /**
   * This deployment's secrets, sealed to its VM (relay/pvm-secrets.mjs): the relay verifies the VM's evidence and its seal key
   * over its own nonce, seals the secrets to that key and signs the release; this agent keeps the CIPHERTEXT only (the
   * operator never sees a value: hostEligibility refuses a pVM host plaintext) and hands it to the VM, which checks the
   * relay's signature against the key its build pins and opens it. The seal key is the VM instance's for this app and
   * deployment, so a release opens again after a relaunch. Asked while a VM serves this deployment (the relay asks it for
   * evidence). Returns { blob (hex: ticket || sig || sealed), count, rev } or null (the reason logged; never a value).
   */
  async function sealedRelease(D) {
    try {
      const ts = Math.floor(now() / 1000);
      const opSig = await account.signMessage({ message: `enclave-pvm-secrets:${D}:${cfg.endpoint}:${ts}` });
      const r = await fetchImpl(`${cfg.relayOrigin}/v1/secrets/pvm-release`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: D, endpoint: cfg.endpoint, ts, opSig }), signal: AbortSignal.timeout(90000) });
      const b = await r.json().catch(() => ({}));
      if (r.status !== 200 || !/^[0-9a-f]{64}$/.test(b.nonce || "") || typeof b.sealed !== "string" || typeof b.sig !== "string") {
        note({ ev: "secrets-failed", deployment: D, status: r.status, error: `${b.error || ""} ${b.message || ""}`.trim().slice(0, 300) });
        return null;
      }
      const sig = Buffer.from(b.sig, "base64"), sealed = Buffer.from(b.sealed, "base64");
      if (sig.length !== 64 || sealed.length < 60) { note({ ev: "secrets-failed", deployment: D, error: "a malformed release" }); return null; }
      note({ ev: "secrets-sealed", deployment: D, count: b.count, rev: b.rev, keyId: b.keyId, sealKey: String(b.sealKey || "").slice(0, 16) });
      return { blob: Buffer.concat([Buffer.from(b.nonce, "hex"), sig, sealed]).toString("hex"), count: Number(b.count) || 0, rev: b.rev };
    } catch (e) { note({ ev: "secrets-failed", deployment: D, error: e.message }); return null; }
  }
  /** The options file for a launch of D (its config with $NAME left for the VM to resolve, its rules, its sealed secrets) and
   *  the launch's egress token. */
  async function launchOptions(D, d, v, sealed) {
    const o = parseOptions(d.configCid, d.gpuMilli);
    const text = await appConfig(d, v);
    const vars = {};
    if (text) vars.ENCLAVE_CONFIG = text;
    vars.ENCLAVE_HOSTS = `${D.slice(2, 10)}.app.enclave.host`;
    const token = cfg.egress ? crypto.randomBytes(16).toString("hex") : null;
    const file = optionsFile({ env: envBlock(vars), waf: o.waf || null, sealed: sealed ? sealed.blob : null, egress: token ? { port: cfg.egress.port, token } : null });
    note({ ev: "options", deployment: D, configBytes: text.length, secrets: sealed ? `sealed (${sealed.count})` : 0, waf: !!o.waf, egress: !!token });
    return { file, token };
  }

  // ---- a slot VM: D's app, resized to it, holding the host's proof key ----
  /**
   * Launch slot a.slot with D's options as they are now: its row, its version, and its sealed secrets when this agent holds a
   * release for it (`a.sealed`: kept across relaunches, refreshed by a restart or a config edit while a VM serves). A new
   * claim has none yet: the next round asks the relay once the VM serves (`needSecrets`) and relaunches only when there are
   * any. Then the slot proves the host's key, or is given it.
   */
  async function launchSlot(a) {
    const dev = slotDev(a);
    const d = await read(addrs.deployments, DEP_ABI, "get", [a.id]);
    const v = await versionOf(a.appRef);
    if (!fs.existsSync(a.file)) Object.assign(a, await fetchComponent(a.cid, httpPortOf(v)));   // the cache was cleared: fetched again, CID-verified
    const { file, token } = await launchOptions(a.id, d, v, a.sealed || null);
    a.egressToken = token; a.configCid = String(d.configCid || ""); a.gpuMilli = Number(d.gpuMilli); a.cpuMilli = Number(d.cpuMilli);
    if (a.sealed === undefined) a.needSecrets = true;
    a.label = `s${a.slot}-${a.id.slice(2, 10)}-${stamp()}`; delete a.cert; lastCert.set(a.slot, 0);
    save();
    try {
      await device.ensurePorts();
      await dev.stageApp(a.file, a.sha);
      await dev.stageOptions(file);
      await dev.launch({ proofPins: proofPins(a.id), label: a.label, sock: a.sock || 0, appMem: a.appMem, vmMib: a.vmMib, cpus: a.cpus, opts: !!file });
      const s = await dev.waitServing(a.label);
      await dev.readToken();
      note({ ev: "vm-serving", vm: `slot ${a.slot}`, deployment: a.id, app: a.sha.slice(0, 16), vmMib: a.vmMib, cpus: a.cpus || "host", line: s.line.slice(0, 160) });
    } catch (e) {
      // a release the VM will not open (another instance, a rotated release key): drop it, ask the relay again later
      if (/the deployment's secrets/.test(e.message) && a.sealed) { delete a.sealed; a.needSecrets = true; save(); note({ ev: "secrets-dropped", deployment: a.id, why: e.message.slice(0, 200) }); }
      throw e;
    }
    await ensureKeyed(a);
  }
  /** The slot VM's own v4 evidence over a fresh nonce, verified under the owner's pins: its instance and transport key. */
  async function slotEvidence(a) {
    const nonce = crypto.randomBytes(32).toString("hex");
    const doc = first(await slotDev(a).exchange(`EVIDENCE3 ${nonce}`, null, 30000));
    const v = verifyEvidence(doc, { nonce, appId: a.sha, requireTls: true, allowedRuntimeIds: cfg.evidence.allowedRuntimeIds,
      allowedCodeHashes: cfg.evidence.allowedCodeHashes, allowedAuthorityHashes: cfg.evidence.allowedAuthorityHashes, rootPins: cfg.evidence.rootPins });
    if (!v.ok || !/^[0-9a-f]{64}$/.test(v.instanceId || "")) throw new Error(`the slot VM's evidence is refused: ${v.reasons.at(-1) || "no instance"}`);
    return v;
  }
  /** Does the VM that gave evidence `v` sign with `want` (the registered proof key)? Its sibling statement over a fresh nonce
   *  recovers to it, for its own transport key, instance and deployment (exactly the relay's check). */
  async function holdsKey(a, v, want) {
    const nonce = crypto.randomBytes(32).toString("hex");
    const s = first(await slotDev(a).exchange(`SIBLING ${nonce}`));
    if (s.error || s.format !== SIBLING_FORMAT || s.nonce !== nonce || s.deployment !== a.id || s.transportSpki !== v.transportSpki || s.instanceId !== v.instanceId
        || !/^[0-9a-f]{130}$/.test(String(s.sig))) return false;
    try { return lc(await recoverAddress({ hash: "0x" + siblingDigest({ nonce, transportSpki: v.transportSpki, instanceId: v.instanceId, deployment: a.id }).toString("hex"), signature: "0x" + s.sig })) === want; }
    catch { return false; }
  }
  /**
   * The slot VM holds the host's proof key, or is given it: the host VM's single-use nonce; the slot's one-time key attested
   * over it (KEYREQ); the host VM verifies that attestation IN the VM and seals the key to it (KEYGRANT); the slot opens it
   * and keeps it in its encrypted store (KEYINSTALL). Every check is the VMs'; this carries bytes and confirms the result.
   */
  async function ensureKeyed(a) {
    if (!registered || !/^0x[0-9a-f]{40}$/.test(lc(registered.proofKey)) || /^0x0{40}$/.test(registered.proofKey)) throw new Error("the host has no registered proof key yet");
    const want = lc(registered.proofKey), v = await slotEvidence(a);
    if (a.instanceId !== v.instanceId) { note({ ev: "slot-instance", slot: a.slot, instanceId: v.instanceId, was: a.instanceId || null }); a.instanceId = v.instanceId; save(); }
    if (await holdsKey(a, v, want)) return "held";
    if (!hostUp) throw new Error("the host VM is not serving: it gives the slot the host's key");
    const dev = slotDev(a), hex = (h) => Buffer.from(h, "hex");
    const n = first(await device.exchange("KEYNONCE"));
    if (!/^[0-9a-f]{64}$/.test(n.nonce || "")) throw new Error(`the host VM gave no key nonce: ${n.error || "no answer"}`);
    const q = first(await dev.exchange(`KEYREQ ${n.nonce}`, null, 60000));
    if (q.format !== "enclave-pvm-keyreq/v1" || q.nonce !== n.nonce || !/^[0-9a-f]{64}$/.test(q.ephPub || "") || !/^(?:[0-9a-f]{2}){64,}$/.test(q.chain || ""))
      throw new Error(`the slot VM made no key request: ${q.error || "a malformed answer"}`);
    const req = Buffer.concat([hex(n.nonce), hex(q.ephPub), hex(q.chain)]);
    const g = first(await device.exchange(`KEYGRANT ${req.length}`, req, 60000));
    if (!/^[0-9a-f]{184}$/.test(g.grant || "")) throw new Error(`the host VM granted no key: ${g.error || "a malformed answer"}`);
    if (lc(g.proofKey) !== want) throw new Error(`the host VM holds ${g.proofKey}, not the registered ${want}: no key handed over`);
    const inst = Buffer.concat([hex(n.nonce), hex(want.slice(2)), hex(g.grant)]);
    const k = first(await dev.exchange(`KEYINSTALL ${inst.length}`, inst, 30000));
    if (k.ok !== true || lc(k.proofKey) !== want) throw new Error(`the slot VM did not install the key: ${k.error || "a malformed answer"}`);
    if (!await holdsKey(a, v, want)) throw new Error("the slot VM still does not prove the host's key");
    note({ ev: "key-handed", slot: a.slot, deployment: a.id, proofKey: want, kept: k.kept === true });
    return "handed";
  }
  /** Free slot a.slot: its VM ended, its runner closed (a transaction in flight stays in its journal). */
  async function freeSlot(a, why) {
    note({ ev: "slot-free", slot: a.slot, deployment: a.id, why });
    await closeRunner(a.slot).catch((e) => note({ ev: "runner-close-failed", slot: a.slot, error: e.message }));
    await slotDev(a).stop().catch((e) => note({ ev: "slot-stop-failed", slot: a.slot, error: e.message }));
    state.slots[String(a.slot)] = null; lastCert.delete(a.slot); save();
  }

  /** Ask the relay for D's sealed secrets while its VM serves: relaunch with them when there are any. */
  async function applySecrets(a) {
    const exists = await secretsExist({ id: a.id, base: cfg.relayOrigin }).catch((e) => { note({ ev: "secrets-unknown", deployment: a.id, error: e.message }); return null; });
    if (exists === false) { a.sealed = null; a.needSecrets = false; save(); return false; }
    const rel = await sealedRelease(a.id);
    if (!rel) return false;                                      // refused or unreachable now: the next round asks again
    a.needSecrets = false;
    if (!rel.count) { a.sealed = null; save(); return false; }
    a.sealed = rel; save();
    await launchSlot(a);
    note({ ev: "secrets-applied", deployment: a.id, count: rel.count });
    return true;
  }
  /** A fresh release while this VM still serves (a restart, a config edit), else the one held. */
  async function refreshSecrets(a) {
    const exists = await secretsExist({ id: a.id, base: cfg.relayOrigin }).catch(() => null);
    if (exists === false) { a.sealed = null; return; }
    const rel = await sealedRelease(a.id);
    if (rel) a.sealed = rel.count ? rel : null;
  }

  // ---- choosing work ----
  /** { v, fit } when this host takes d now, else { why } (busy: it would, with room). */
  async function admission(d, except = 0) {
    const v = await versionOf(d.appRef).catch(() => null);
    const why = pvmClaimRefusal(d, v, { enclaveId: E, maxMemMb: cfg.claim.maxMemMb, nowSec: Math.floor(now() / 1000) }) || (v ? null : "no catalog version");
    if (why) return { why };
    const fit = slotFor(S, apps(), { cpuMilli: Number(d.cpuMilli), appMemMb: appMemFor(v) }, except);
    return fit.why ? { why: `no room on the phone now: ${fit.why}`, busy: true } : { v, fit };
  }
  async function refusalFor(d) { return (await admission(d)).why || null; }
  async function candidates() {
    const n = Number(await read(addrs.deployments, DEP_ABI, "count"));
    const rows = [];
    for (let s = 0; s < n; s += 100) rows.push(...await read(addrs.deployments, DEP_ABI, "getPage", [BigInt(s), BigInt(Math.min(100, n - s))]));
    const t = Math.floor(now() / 1000);
    // CPU-only deployments, and GPU-dialled ones whose owner said the card is optional (a publisher's gpuOptional is judged
    // when one is hinted or pinned here: admission reads the version)
    const softGpu = (d) => { try { return parseOptions(d.configCid, d.gpuMilli).gpuOptional === true; } catch { return false; } };
    return rows.filter((d) => d.active && d.isPublic && (Number(d.gpuMilli) === 0 || softGpu(d)) && Number(d.leaseUntil) < t && !appOf(d.id))
      .map((d) => { let pinned = false; try { const o = JSON.parse(String(d.configCid || "{}") || "{}"); pinned = lc(o?.placement?.hostId || "") === lc(E); } catch {} return { d, pinned }; })
      // the sweep takes what the fleet left: a deployment open for sweepGraceSec, unless hinted to this host or pinned to it
      .filter(({ d, pinned }) => pinned || hints.has(lc(d.id)) || t - Number(d.createdAt) >= cfg.claim.sweepGraceSec)
      .sort((a, b) => (b.pinned - a.pinned) || (hints.has(lc(b.d.id)) - hints.has(lc(a.d.id))) || (Number(b.d.createdAt) - Number(a.d.createdAt)));
  }
  async function sweep() {
    if (!cfg.claim.enabled || !registered || !hostUp || anyPending() || apps().length >= S.count) return null;
    for (const { d } of (await candidates()).slice(0, 16)) {
      const id = lc(d.id), old = state.refused[id];
      if (standDown.has(id) && standDown.get(id) > now()) continue;
      if (old && now() - old.at < 10 * 60_000 && !hints.has(id)) continue;
      const ad = await admission(d);
      if (ad.busy) continue;   // it would be taken with room: looked at again when a slot frees
      if (ad.why) { state.refused[id] = { at: now(), why: ad.why }; save(); note({ ev: "not-taken", deployment: id, why: ad.why }); continue; }
      let ok = false; try { ok = await read(addrs.deployments, DEP_ABI, "claimableBy", [d.id, E]); } catch {}
      if (!ok) { state.refused[id] = { at: now(), why: "the ledger says this host cannot claim it (unfunded at this host's rate, over its rate cap, or taken)" }; save(); continue; }
      hints.delete(id);
      return take(d, ad.v, ad.fit);
    }
    return null;
  }
  async function take(d, v, fit) {
    const D = lc(d.id);
    note({ ev: "taking", deployment: D, appRef: d.appRef, cid: v.cid, memMb: Number(v.memMb), slot: fit.slot, vmMib: fit.vmMib, cpuMilli: Number(d.cpuMilli) });
    let comp;
    try { comp = await fetchComponent(v.cid, httpPortOf(v)); }
    catch (e) { state.refused[D] = { at: now(), why: e.message }; save(); note({ ev: "not-taken", deployment: D, why: e.message }); return null; }
    let soft = false; try { soft = parseOptions(d.configCid, d.gpuMilli).gpuOptional === true || JSON.parse(String(v.config || "{}") || "{}").gpuOptional === true; } catch {}
    const a = { slot: fit.slot, id: D, appRef: d.appRef, configCid: String(d.configCid || ""), cid: v.cid, sha: comp.sha, file: comp.file, sock: comp.sock,
                appMem: appMemFor(v), vmMib: fit.vmMib, cpus: fit.cpus, cpuMilli: Number(d.cpuMilli), gpuMilli: Number(d.gpuMilli),
                gpuOptional: Number(d.gpuMilli) > 0 && soft, label: null, phase: "preparing", at: now() };
    state.slots[String(fit.slot)] = a; save();
    try {
      // the relay hands secrets to the LEASE HOLDER only, and the claim needs this VM attesting this app: so the first launch
      // has none, and once the claim lands the VM is relaunched with them -- only when the relay says there are any
      await launchSlot(a);
      const r = await slotRunner(a);
      runners.get(a.slot).lastTick = now();
      const t = await r.tick();   // the claim (or the reason it was refused), then a first proof
      const L = await r.agent.lease();
      if (L.runner === lc(E) && L.runnerOperator === me && L.leaseUntil >= L.headTs) {
        a.phase = "serving"; a.claimedAt = now(); save();
        note({ ev: "claimed", deployment: D, slot: a.slot, leaseUntil: String(L.leaseUntil), tick: t.kind });
        await applySecrets(a);
        return D;
      }
      throw new Error(`not claimed: ${t.lifecycle ? (t.lifecycle.reason || t.lifecycle.kind) : t.kind}`);
    } catch (e) {
      state.refused[D] = { at: now(), why: e.message }; save();
      note({ ev: "take-failed", deployment: D, slot: a.slot, why: e.message });
      await freeSlot(a, `taking ${D.slice(0, 10)} failed`);
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

  // ---- an app's certificate: a CSR made in its VM, issued by the relay after it verifies that VM's evidence for that key ----
  const labelOf = (D) => D.slice(2, 10);
  async function ensureCertificate(a) {
    const D = a.id, name = `${labelOf(D)}.app.enclave.host`, dev = slotDev(a);
    const csrAns = first(await dev.exchange(`CSR ${name}`));
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
    const ans = first(await dev.exchange(`CERT ${chain.length}`, chain));
    if (ans.ok !== true) throw new Error(`the VM refused the chain: ${ans.error || "no answer"}`);
    a.cert = { name, notAfter: body.notAfter || null, at: now(), spkiHash }; save();
    note({ ev: "cert-installed", name, slot: a.slot, certs: ans.certs, notAfter: body.notAfter, cached: body.cached === true });
    return { ok: true };
  }

  // ---- one round ----
  async function tick() {
    if (busy) return { kind: "busy" };
    busy = true;
    try {
      if (!addrs) await resolve();
      await device.ensurePorts().catch((e) => note({ ev: "ports", error: e.message }));
      const reg = await read(addrs.registry, REGISTRY_ABI, "get", [E]).catch(() => null);
      registered = reg && lc(reg.operator) === me && reg.active ? reg : null;
      // the host VM, carried on from what the state says (a VM that no longer serves is launched again)
      try {
        hostUp = state.host ? await device.alive(state.host.label) : false;
        if (!hostUp) await launchHost(state.host ? "the host VM ended" : "start");
        else if (!runners.has("host")) { await device.readToken(); await hostRunner(); }
      } catch (e) { note({ ev: "host-vm-failed", error: e.message }); }
      // each slot, likewise: relaunched with the same app, pins and sealed release (its key kept in its own store)
      for (const a of apps()) {
        try {
          const up = a.label ? await slotDev(a).alive(a.label) : false;
          if (!up) { if (a.label) note({ ev: "vm-gone", slot: a.slot, label: a.label }); await launchSlot(a); await slotRunner(a); }
          else if (!runners.has(a.slot)) { await slotDev(a).readToken(); await ensureKeyed(a); await slotRunner(a); }
        } catch (e) { note({ ev: "slot-failed", slot: a.slot, deployment: a.id, error: e.message }); }
      }
      // the runners' rounds (register / renew / heartbeat / withdraw / prove), every interval: one transaction in flight at a
      // time across all of them -- a runner with one pending is followed first, and none other sends until it settles
      const every = registered ? 300_000 : 60_000;
      for (const [who, e] of [...runners].sort(([x], [y]) => (x === "host" ? -1 : y === "host" ? 1 : x - y))) {
        const pending = !!e.r.agent.pending;
        if (!pending && (anyPending(who) || now() - e.lastTick < every)) continue;
        e.lastTick = now();
        try {
          const t = await e.r.tick();
          note({ ev: "runner-tick", who, kind: t.kind, lifecycle: t.lifecycle && (t.lifecycle.op || t.lifecycle.kind) });
        } catch (err) { note({ ev: "runner-tick-failed", who, error: err.shortMessage || err.message }); }
      }
      // each app's lease, secrets, options and certificate
      for (const a of apps()) {
        const e = runners.get(a.slot);
        if (!e) continue;
        try { await slotRound(a, e.r); } catch (err) { note({ ev: "slot-round-failed", slot: a.slot, deployment: a.id, error: err.message }); }
      }
      if (registered && hostUp && now() - lastReattach >= 15 * 60_000 && !(await attachedAsOperator())) {
        // the hub counts this host as its operator's only from an attach made AFTER the name was registered (the co-signer's
        // signature over that attach); one made before (first-come) is re-made by restarting the host VM (the slots run on)
        lastReattach = now();
        await launchHost("re-attach under the registered name").catch((e) => note({ ev: "host-vm-failed", error: e.message }));
      } else if (now() - lastSweep >= (hints.size ? 0 : 60_000)) {
        lastSweep = now();
        await sweep();
      }
      return { kind: "ok", apps: apps().map((a) => a.id), registered: !!registered, hostUp };
    } finally { busy = false; }
  }
  async function slotRound(a, r) {
    const L = await r.agent.lease();
    const ours = L.runner === lc(E) && L.runnerOperator === me, live = L.leaseUntil >= L.headTs;
    if (a.phase === "preparing") {
      // a take cut short (the agent restarted mid-claim): serving once the claim landed, else freed after 10 min
      if (L.active && ours && live) { a.phase = "serving"; a.claimedAt = now(); save(); note({ ev: "claimed", deployment: a.id, slot: a.slot, late: true }); }
      else if (now() - a.at > 10 * 60_000) await freeSlot(a, "never claimed");
      return;
    }
    if (!L.active || !ours || !live) {
      note({ ev: "lease-over", deployment: a.id, slot: a.slot, active: L.active, runner: L.runner, leaseUntil: String(L.leaseUntil) });
      // still ours and live (the owner stopped it, or moved it): a final proof, then release, so the unused tail goes back
      const s = await r.stop({ release: ours && live });
      if (s.kind === "in-flight") return;
      await freeSlot(a, "the lease is over");
    } else if (a.needSecrets && now() - (a.secretsTriedAt || 0) >= 60_000) {
      a.secretsTriedAt = now();
      await applySecrets(a);
    } else if (await optionsChanged(a, r)) {
      // handled (relaunched on the new options, or released when they are no longer this host's to apply)
    } else if ((!a.cert || (a.cert.notAfter && Date.parse(a.cert.notAfter) - now() < 30 * 86400_000)) && now() - (lastCert.get(a.slot) || 0) >= 60_000) {
      lastCert.set(a.slot, now());
      try { await ensureCertificate(a); } catch (e) { note({ ev: "cert-failed", slot: a.slot, error: e.message }); }
    }
  }

  /**
   * configEdit / shareResize on the LIVE lease: the owner's setConfig or setShares, seen on the ledger row. New options are
   * judged as at claim -- a new share against what the other slots hold; still this host's to run, the app is relaunched on
   * them (same lease, same VM instance and key; its certificate installed again); no longer this host's (a namespace it does
   * not apply, a GPU share without gpu.optional, a share the phone has no room for), the lease is released with the reason. A
   * share change that keeps the VM's shape (its vCPUs) is admission and billing only: nothing is relaunched for it.
   */
  async function optionsChanged(a, r) {
    const d = await read(addrs.deployments, DEP_ABI, "get", [a.id]).catch(() => null);
    if (!d) return false;
    const cfgChanged = String(d.configCid || "") !== String(a.configCid || "");
    const shareChanged = a.cpuMilli !== undefined && (Number(d.cpuMilli) !== a.cpuMilli || Number(d.gpuMilli) !== a.gpuMilli);
    if (!cfgChanged && !shareChanged) return false;
    const ad = await admission({ ...d, leaseUntil: 0n }, a.slot);
    note({ ev: cfgChanged ? "config-edited" : "shares-resized", deployment: a.id, slot: a.slot, cpuMilli: Number(d.cpuMilli), gpuMilli: Number(d.gpuMilli), refused: ad.why || null });
    if (ad.why) {
      const s = await r.stop({ release: true });
      if (s.kind === "in-flight") return true;
      state.refused[a.id] = { at: now(), why: ad.why }; save();
      await freeSlot(a, `its new options are not this host's to apply: ${ad.why}`);
      return true;
    }
    const reshape = ad.fit.cpus !== a.cpus;
    a.cpuMilli = Number(d.cpuMilli); a.gpuMilli = Number(d.gpuMilli); a.cpus = ad.fit.cpus; save();
    if (!cfgChanged && !reshape) return true;
    await refreshSecrets(a);   // while this VM still serves (the relay asks it for evidence)
    await launchSlot(a);
    return true;
  }

  // ---- the host surface (reached through the phone's tunnel: untrusted requests) ----
  function availability() {
    const held = apps(), ok = !!registered && cfg.claim.enabled && hostUp;
    const mem = held.reduce((t, a) => t + a.vmMib, 0), cpu = held.reduce((t, a) => t + (a.cpuMilli || 0), 0);
    return { ok: true, role: "pvm-host", name: cfg.name, gpu: false, claimEnabled: ok, fullService: false, registered: !!registered,
      enclaveId: E, operator: me, proofKey: registered ? lc(registered.proofKey) : null,
      askCpuPricePerSec6: Number(cfg.register.cpuPricePerSec6), askGpuPricePerSec6: 0,
      // one VM per app, sized to its share: the slots divide the phone's pool of VM memory and its CPU
      slots: S.count, nodeSlotsFree: S.count - held.length, cpuShareFree: Math.max(0, Math.round(1000 - cpu)) / 1000,
      poolMemMb: S.poolMemMb, poolMemMbFree: Math.max(0, S.poolMemMb - mem), ramGbFree: Math.max(0, Math.round((S.poolMemMb - mem) / 102.4) / 10),
      maxAppMemMb: cfg.claim.maxMemMb, vmOverheadMb: VM_OVERHEAD_MB, minVmMb: MIN_VM_MB,
      isolation: ISOLATION_BACKEND, appTls: "in-vm", appEvidence: "enclave-pvm-app-evidence/v4", claimScope: "market",
      // the platform's capability flags (the relay AND-folds them across the fleet): each true only for what this host does
      networkOptions: true, networkTransports: ["tuna"], secrets: true, secretsInConfig: true, secretsKeyIn: "vm (sealed by the relay)", configOverride: true, configCidOverride: true,
      configEdit: true, shareResize: true, waf: true, wafScope: "per-deployment: the app's hostname reaches the VM as TLS through TUNA, with no client address",
      gpuOptional: true, cpuFallback: true, rateCap: true, proofOfTime: true, mem64: true, set: false, p3: false, coopThreads: false,
      egress: cfg.egress ? "tuna-per-app" : false, customDomains: false, devDeploy: false,
      apps: held.map((a) => ({ id: a.id, phase: a.phase, slot: a.slot, vmMib: a.vmMib, cpuMilli: a.cpuMilli, appSha256: a.sha, since: new Date(a.at).toISOString(), cert: a.cert ? a.cert.name : null })) };
  }
  async function claimHint(body) {
    const id = lc(body && body.id);
    if (!B32.test(id)) return { accepted: false, reason: "A ledger deployment ID is required." };
    if (!cfg.claim.enabled || !registered) return { accepted: false, reason: "This host is not taking deployments right now." };
    if (appOf(id)) return { accepted: true, reason: "Already serving it." };
    if (!addrs) await resolve();
    const d = await read(addrs.deployments, DEP_ABI, "get", [id]);
    const ad = await admission(d);
    if (ad.why) return { accepted: false, reason: ad.busy ? `This host has no room for it now: ${ad.why.replace(/^no room on the phone now: /, "")}.` : `Not taken by this host: ${ad.why}.` };
    hints.add(id); delete state.refused[id];
    setImmediate(() => tick().catch((e) => note({ ev: "tick-error", error: e.message })));
    return { accepted: true, reason: "Claiming: a VM sized to its share starts the app, then claims the lease." };
  }
  async function evidence(q) {
    const D = lc(q.get("deployment") || ""), nonce = String(q.get("nonce") || "");
    if (!/^[0-9a-f]{64}$/.test(nonce)) return [400, { error: "nonce must be 64 lowercase hex" }];
    const a = appOf(D);
    if (!a || !a.label) return [404, { error: "this host does not serve that deployment now" }];
    const ans = await slotDev(a).exchange(`EVIDENCE3 ${nonce}`, null, 30000);
    try { return [200, JSON.parse(ans.split("\n")[0])]; } catch { return [502, { error: "the VM gave no evidence" }]; }
  }
  /** The relay's host check (relay/pvm-market.mjs checkHostVm): the slot VM's sibling statement over the relay's nonce. */
  async function sibling(q) {
    const D = lc(q.get("deployment") || ""), nonce = String(q.get("nonce") || "");
    if (!/^[0-9a-f]{64}$/.test(nonce)) return [400, { error: "nonce must be 64 lowercase hex" }];
    const a = appOf(D);
    if (!a || !a.label) return [404, { error: "this host does not serve that deployment now" }];
    const s = first(await slotDev(a).exchange(`SIBLING ${nonce}`));
    return s.error ? [409, { error: s.error }] : s.format === SIBLING_FORMAT ? [200, s] : [502, { error: "the VM gave no sibling statement" }];
  }
  /** The relay's seal check (relay/pvm-secrets.mjs): the VM's v4 evidence and its seal-key statement, both over the relay's nonce. */
  async function sealEvidence(q) {
    const [st, ev] = await evidence(q);
    if (st !== 200) return [st, ev];
    const nonce = String(q.get("nonce") || ""), a = appOf(q.get("deployment"));
    const ans = await slotDev(a).exchange(`SEALKEY ${nonce}`, null, 30000);
    let seal; try { seal = JSON.parse(ans.split("\n")[0]); } catch { return [502, { error: "the VM gave no seal statement" }]; }
    if (seal.error) return [409, { error: seal.error }];
    return [200, { evidence: ev, seal }];
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
        if (req.method === "GET" && p === "/v1/pvm/sibling") { const [s, b] = await sibling(u.searchParams); return json(res, s, b); }
        if (req.method === "GET" && p === "/v1/pvm/secret-evidence") { const [s, b] = await sealEvidence(u.searchParams); return json(res, s, b); }
        if (req.method === "GET" && p === "/v1/deployments") return json(res, 200, { deployments: apps().map(record) });
        const act = /^\/v1\/deployments\/(0x[0-9a-f]{64})(\/restart|\/attestation)?$/.exec(p.toLowerCase());
        if (act && (req.method === "POST" || req.method === "DELETE" || act[2] === "/attestation")) {
          const id = act[1], a = appOf(id);
          if (!a) return json(res, 404, { error: "not_found", id });
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
          if (req.method === "POST" && act[2] === "/restart") { const [st, b] = await restartServed(id); return json(res, st, b); }
          if (req.method === "DELETE" && !act[2]) { const [st, b] = await releaseServed(id, u.searchParams.get("evacuate") === "1"); return json(res, st, b); }
          return json(res, 405, { error: "method_not_allowed" });
        }
        const m = /^\/v1\/deployments\/(0x[0-9a-f]{64})(\/logs)?$/.exec(p.toLowerCase());
        if (req.method === "GET" && m) {
          const a = appOf(m[1]);
          if (!a) return json(res, 404, { error: "not_found", id: m[1] });
          return m[2] ? json(res, 200, { id: m[1], lines: await lifecycleLog(a, 200) }) : json(res, 200, record(a));
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
  async function restartServed(id) {
    if (busy) return [409, { error: "busy", message: "This host is mid-round; retry in a moment." }];
    busy = true;
    try {
      const a = appOf(id);
      if (!a) return [404, { error: "not_found", id }];
      // a restart applies the owner's current secrets and config: released while this VM still serves
      await refreshSecrets(a);
      await launchSlot(a);
      note({ ev: "restarted", deployment: a.id, slot: a.slot });
      return [200, { id: a.id, restarted: true, label: a.label }];
    } catch (e) { return [500, { error: "restart_failed", message: e.message }]; }
    finally { busy = false; }
  }
  /** Release (the owner suspended or moved it): a final proof, release, the slot freed; `evacuate` keeps it from being
   *  re-claimed for 10 min. */
  async function releaseServed(id, evacuate) {
    if (busy) return [409, { error: "busy", message: "This host is mid-round; retry in a moment." }];
    busy = true;
    try {
      const a = appOf(id);
      if (!a) return [404, { error: "not_found", id }];
      if (evacuate) standDown.set(a.id, now() + 10 * 60_000);
      const e = runners.get(a.slot);
      const s = e ? await e.r.stop({ release: true }) : { kind: "stopped" };
      if (s.kind === "in-flight") return [409, { error: "in_flight", message: "A transaction is in flight; retry shortly." }];
      await freeSlot(a, evacuate ? "the owner moved it" : "the owner released it");
      return [200, { id: a.id, released: s.kind === "released", kind: s.kind }];
    } catch (e) { return [500, { error: "release_failed", message: e.message }]; }
    finally { busy = false; }
  }

  // a served deployment as this host has it
  function record(a) {
    return { id: a.id, appRef: a.appRef, status: a.phase === "serving" ? "running" : "starting", enclave: cfg.name, runtime: "pvm-rt (Pulley)",
             appSha256: a.sha, componentCid: a.cid, since: new Date(a.at).toISOString(), ...(a.claimedAt ? { claimedAt: new Date(a.claimedAt).toISOString() } : {}),
             tls: a.cert ? { name: a.cert.name, notAfter: a.cert.notAfter, spkiSha256: a.cert.spkiHash } : null, isolation: ISOLATION_BACKEND,
             vm: { slot: a.slot, memMib: a.vmMib, vcpus: a.cpus === 1 ? 1 : "host", appMemMib: a.appMem } };
  }
  // the VM's lifecycle lines for a served app: serving, connections and request counts, evidence answers, the certificate,
  // checkpoints. Never a request's stderr or any byte of traffic (the app's own output is not this host's to publish).
  async function lifecycleLog(a, n) {
    if (!a.label) return [];
    const text = await slotDev(a).capture(a.label);
    return text.split("\n").map((l) => l.replace(/^VSOCK /, ""))
      .filter((l) => /^(APP (serving|refused|http|served|tls key|evidence endpoint|sealed requests)|APP connection closed|TLS (CSR|chain)|CHECKPOINT|EVIDENCE answered|PROOF key|PROOFPINS|HOST VM instance)/.test(l)
                     && !/stderr/.test(l))
      .slice(-n);
  }

  async function serve(port) {
    const srv = http.createServer(handler());
    await new Promise((r, j) => { srv.once("error", j); srv.listen(port, "127.0.0.1", r); });
    // the TUNA privacy agent's app port: each connection to the slot VM serving the name its ClientHello asks for
    const router = createSniRouter({ log: (o) => note(o),
      portFor: (name) => { const a = apps().find((x) => x.label && `${labelOf(x.id)}.app.enclave.host` === name); return a ? slotDev(a).appPort : null; } });
    await new Promise((r, j) => { router.once("error", j); router.listen(S.routerPort, "127.0.0.1", r); });
    srv.on("close", () => router.close());
    note({ ev: "app-router", listen: `127.0.0.1:${S.routerPort}`, slots: S.count, poolMemMb: S.poolMemMb });
    if (cfg.egress) {
      // the apps' way out (egress.mjs): each launch's token is its own app's, on that app's own route
      const eg = createEgressServer({ routesFile: cfg.egress.routesFile, log: (o) => note(o),
        current: () => apps().filter((a) => a.egressToken).map((a) => ({ token: a.egressToken, deployment: a.id })) });
      await new Promise((r, j) => { eg.once("error", j); eg.listen(cfg.egress.port, "127.0.0.1", r); });
      srv.on("close", () => eg.close());
      note({ ev: "egress-surface", listen: `127.0.0.1:${cfg.egress.port}` });
    }
    return srv;
  }
  async function stop({ release = false } = {}) {
    const out = {};
    for (const [who, e] of [...runners]) { out[who] = (await e.r.stop({ release: release && who !== "host" })).kind; e.r.close(); runners.delete(who); }
    return out;
  }
  return { tick, availability, claimHint, evidence, sibling, handler, serve, stop, ensureCertificate, refusalFor, admission, state: () => state, config: cfg };
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
