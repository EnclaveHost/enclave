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
  const KEYS = ["addressBook", "chainId", "claim", "device", "evidence", "format", "idleApp", "ipfs", "maxFeePerGasWei", "name", "operator", "payout", "register", "relayOrigin"];
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
  const i = c.ipfs || {};
  if (typeof i.fetchScript !== "string" || !Array.isArray(i.gateways) || !i.gateways.length || typeof i.cacheDir !== "string") bad("ipfs must be { python, fetchScript, gateways, cacheDir }");
  return { ...c, endpoint: `${c.relayOrigin}/t/${c.name}`, enclaveId: keccak256(stringToBytes(`${c.relayOrigin}/t/${c.name}`)) };
}

/** Why the pVM does NOT take this deployment, or null. Pure: the row, its catalog version and this host's facts. */
export function pvmClaimRefusal(d, version, { enclaveId, maxMemMb, nowSec }) {
  if (!d || !d.active) return "the deployment is not active";
  if (!d.isPublic) return "it is private: this host serves public deployments (its route is public; no owner session check here)";
  if (Number(d.gpuMilli) !== 0) return `it asks gpuMilli ${d.gpuMilli}: the pVM CPU tier takes CPU-only workloads`;
  const lease = Number(d.leaseUntil);
  if (lease >= nowSec && String(d.runner).toLowerCase() !== String(enclaveId).toLowerCase()) return "another host holds its lease";
  let env = {};
  const raw = String(d.configCid || "").trim();
  if (raw) {
    if (!raw.startsWith("{")) return "its options field is a bare CID: a configuration this host cannot apply";
    try { env = JSON.parse(raw); } catch { return "its options envelope is not JSON"; }
    if (!env || typeof env !== "object" || Array.isArray(env)) return "its options envelope is not an object";
  }
  const known = ["isolation", "network", "placement", "gpu"];
  const unknown = Object.keys(env).filter((k) => !known.includes(k));
  if (unknown.length) return `its options carry ${unknown.join(", ")}, which this host does not apply (configuration, secrets and protection rules are not supported in the pVM yet)`;
  if (env.isolation !== undefined) {
    const iso = env.isolation;
    if (!iso || typeof iso !== "object" || Array.isArray(iso) || Object.keys(iso).some((k) => !["require", "cpuTee", "gpuTee"].includes(k))) return "its isolation options are malformed";
    if (iso.cpuTee === true || iso.gpuTee === true) return "it requires a confidential-computing CPU or GPU, which this host does not claim";
    if (iso.require !== undefined && iso.require !== ISOLATION_BACKEND) return `it requires isolation backend ${JSON.stringify(iso.require)}, not ${ISOLATION_BACKEND}`;
  }
  if (env.network !== undefined) {
    const n = env.network;
    if (!n || typeof n !== "object" || Object.keys(n).some((k) => !["transport", "relay"].includes(k)) || (n.transport !== undefined && n.transport !== "tuna"))
      return "its network options ask for a transport other than TUNA";
  }
  if (env.gpu !== undefined && (typeof env.gpu !== "object" || env.gpu.optional !== true)) return "its gpu options are not { optional: true }";
  if (env.placement !== undefined) {
    const p = env.placement;
    if (!p || typeof p !== "object" || !B32.test(String(p.hostId || "").toLowerCase())) return "its placement pin is malformed";
    if (String(p.hostId).toLowerCase() !== String(enclaveId).toLowerCase() && p.allowFallback === false) return "it is pinned to another host";
  }
  if (!version) return "its catalog version could not be read";
  if (version.yanked) return "its catalog version is yanked";
  // the relay serves a public deployment only on an approved version (measurement-predict.mjs versionRefusal)
  if (Number(version.approval) !== 1) return "its catalog version is not approved by the catalog owner";
  if (Number(version.vramMb) > 0 || Number(version.gpuGflops) > 0) {
    let cfg = {}; try { cfg = JSON.parse(String(version.config || "{}") || "{}"); } catch {}
    if (cfg.gpuOptional !== true) return "its catalog version needs a GPU";
  }
  if (Number(version.memMb) > maxMemMb) return `its catalog version needs ${version.memMb} MB, beyond this VM's ${maxMemMb} MB per app`;
  const listed = String(version.ports || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (listed.some((p) => !p.startsWith("http"))) return `its catalog version declares ports ${version.ports}: this host serves wasi:http only`;
  let cfg = {}; try { cfg = JSON.parse(String(version.config || "{}") || "{}"); } catch { return "its catalog version's config is not JSON"; }
  const want = [];
  if (cfg.set === true) want.push("shared-everything threads");
  if (cfg.threads === true) want.push("threads");
  if (cfg.mem64 === true) want.push("a 64-bit memory");
  if (String(cfg.wasi || "0.2") === "0.3") want.push("wasi 0.3");
  if (Array.isArray(cfg.volumes) && cfg.volumes.length) want.push("a model volume");
  if (version.configCid) want.push("a configuration document");
  const appCfg = Object.keys(cfg).filter((k) => !["gpuOptional", "cpuFallback", "wasi", "set", "threads", "mem64", "volumes"].includes(k));
  if (appCfg.length) want.push(`app configuration (${appCfg.slice(0, 4).join(", ")})`);
  if (want.length) return `its catalog version needs ${want.join(", ")}, which the pVM runtime does not offer`;
  return null;
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
  let addrs = null, runner = null, runnerFor = null, busy = false, lastSweep = 0, lastRunnerTick = 0, lastCert = 0, registered = null;
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
  function runnerConfig(D, appSha) {
    return { format: "enclave-pvm-runner-agent/v1",
      proof: { format: "enclave-pvm-proof-agent/v1", chainId: cfg.chainId, addressBook: cfg.addressBook, deployment: D, endpoint: cfg.endpoint,
               operator: me, carrier: `http://127.0.0.1:${device.evidencePort}/`, maxFeePerGasWei: cfg.maxFeePerGasWei,
               evidence: { appId: appSha, allowedCodeHashes: cfg.evidence.allowedCodeHashes, allowedAuthorityHashes: cfg.evidence.allowedAuthorityHashes,
                           allowedRuntimeIds: cfg.evidence.allowedRuntimeIds, rootPins: cfg.evidence.rootPins, instanceIds: cfg.evidence.instanceIds } },
      lifecycle: { register: { repo: cfg.register.repo, measurement: "0x" + cfg.evidence.allowedCodeHashes[0], cpuPricePerSec6: cfg.register.cpuPricePerSec6 },
                   claim: D !== ZERO32, ...(cfg.payout ? { payout: cfg.payout } : {}) } };
  }
  async function useRunner(D, appSha) {
    if (runner && runnerFor === `${D}:${appSha}`) return runner;
    if (runner) { const s = await runner.stop({ release: false }); if (s.kind === "in-flight") throw new Error("the previous runner still has a transaction in flight"); runner.close(); runner = null; runnerFor = null; }
    runner = await createRunnerAgent({ config: runnerConfig(D, appSha), publicClient, account, stateDir: path.join(stateDir, "runners", D === ZERO32 ? "idle" : D.slice(2, 18)),
                                       fetchImpl: device.carrierFetch, now, sleep, log: (o) => log({ t: new Date(now()).toISOString(), layer: "runner", d: D.slice(0, 10), ...o }) });
    runnerFor = `${D}:${appSha}`;
    const st = await runner.start();
    note({ ev: "runner-started", deployment: D, appSha: appSha.slice(0, 16), proofKey: st.attested && st.attested.proofKey, attestReason: st.attestReason });
    return runner;
  }

  // ---- the VM ----
  async function launchVm({ D, file, sha, label }) {
    await device.ensurePorts();
    await device.stageApp(file, sha);
    await device.launch({ proofPins: proofPins(D), label, attachSigner: `http://127.0.0.1:${cfg.device.attachPort}/attach-sign` });
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
  async function fetchComponent(cid) {
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
    if (!bytes.includes(Buffer.from("wasi:http/incoming-handler"))) throw new Error("the component does not export wasi:http/incoming-handler: this host serves wasi:http apps only");
    if (bytes.includes(Buffer.from("wasi:nn"))) throw new Error("the component imports wasi:nn: the pVM CPU tier carries no model");
    return { file: out, sha: crypto.createHash("sha256").update(bytes).digest("hex") };
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
    return rows.filter((d) => d.active && d.isPublic && Number(d.gpuMilli) === 0 && Number(d.leaseUntil) < t)
      .map((d) => { let pinned = false; try { const o = JSON.parse(String(d.configCid || "{}") || "{}"); pinned = lc(o?.placement?.hostId || "") === lc(E); } catch {} return { d, pinned }; })
      // the sweep takes what the fleet left: a deployment open for sweepGraceSec, unless hinted to this host or pinned to it
      .filter(({ d, pinned }) => pinned || hints.has(lc(d.id)) || t - Number(d.createdAt) >= cfg.claim.sweepGraceSec)
      .sort((a, b) => (b.pinned - a.pinned) || (hints.has(lc(b.d.id)) - hints.has(lc(a.d.id))) || (Number(b.d.createdAt) - Number(a.d.createdAt)));
  }
  async function sweep() {
    if (!cfg.claim.enabled || state.current || !registered) return null;
    for (const { d } of (await candidates()).slice(0, 16)) {
      const id = lc(d.id), old = state.refused[id];
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
    let comp;
    try { comp = await fetchComponent(v.cid); }
    catch (e) { state.refused[D] = { at: now(), why: e.message }; save(); note({ ev: "not-taken", deployment: D, why: e.message }); return null; }
    if (runner) { const s = await runner.stop({ release: false }); if (s.kind === "in-flight") { note({ ev: "deferred", why: "a transaction is in flight" }); return null; } runner.close(); runner = null; runnerFor = null; }
    state.current = { id: D, appRef: d.appRef, cid: v.cid, sha: comp.sha, file: comp.file, label: `app-${D.slice(2, 10)}-${new Date(now()).toISOString().replace(/[:.]/g, "")}`, phase: "preparing", at: now() };
    save();
    try {
      await launchVm({ D, file: comp.file, sha: comp.sha, label: state.current.label });
      const r = await useRunner(D, comp.sha);
      const t = await r.tick();   // the claim (or the reason it was refused), then a first proof
      const L = await r.agent.lease();
      if (L.runner === lc(E) && L.runnerOperator === me && L.leaseUntil >= L.headTs) {
        state.current.phase = "serving"; state.current.claimedAt = now(); save();
        note({ ev: "claimed", deployment: D, leaseUntil: String(L.leaseUntil), tick: t.kind });
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
      // after a restart: carry on with what the state says is running; a VM that is not serving it is launched again
      if (!runner) {
        if (state.current) {
          const text = await device.capture(state.current.label);
          if (!text.includes("APP serving https-p256") || /CONTROL closed|APP served /.test(text)) { await launchVm({ D: state.current.id, file: state.current.file, sha: state.current.sha, label: state.current.label = `app-${state.current.id.slice(2, 10)}-${new Date(now()).toISOString().replace(/[:.]/g, "")}` }); save(); }
          else await device.readToken();
          await useRunner(state.current.id, state.current.sha);
        } else {
          const text = state.idle ? await device.capture(state.idle.label) : "";
          if (!text.includes("APP serving https-p256") || /CONTROL closed|APP served /.test(text)) await goIdle("start");
          else { await device.readToken(); await useRunner(ZERO32, idleSha); }
        }
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
          const s = await runner.stop({ release: L.active && L.runner === lc(E) && L.runnerOperator === me });
          if (s.kind === "in-flight") return { kind: "in-flight" };
          runner.close(); runner = null; runnerFor = null;
          await goIdle("the lease is over");
        } else if (!state.current.cert && now() - lastCert >= 60_000) {
          lastCert = now();
          try { await ensureCertificate(); } catch (e) { note({ ev: "cert-failed", error: e.message }); }
        }
      } else if (!state.current && now() - lastSweep >= (hints.size ? 0 : 60_000)) {
        lastSweep = now();
        await sweep();
      }
      return { kind: "ok", current: state.current && state.current.id, registered: !!registered };
    } finally { busy = false; }
  }

  // ---- the host surface (reached through the phone's tunnel: untrusted requests) ----
  function availability() {
    const cur = state.current, ok = !!registered && cfg.claim.enabled;
    return { ok: true, role: "pvm-host", name: cfg.name, gpu: false, claimEnabled: ok, fullService: false, registered: !!registered,
      enclaveId: E, operator: me, proofKey: registered ? lc(registered.proofKey) : null,
      askCpuPricePerSec6: Number(cfg.register.cpuPricePerSec6), askGpuPricePerSec6: 0,
      slots: 1, nodeSlotsFree: cur ? 0 : 1, cpuShareFree: cur ? 0 : 1, maxAppMemMb: cfg.claim.maxMemMb,
      isolation: ISOLATION_BACKEND, appTls: "in-vm", appEvidence: "enclave-pvm-app-evidence/v4", claimScope: "market",
      networkOptions: { transport: ["tuna"] }, secrets: false, configOverride: false, waf: false, customDomains: false,
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
        return json(res, 404, { error: "not_found" });
      } catch (e) { note({ ev: "http-error", error: e.message }); return json(res, 500, { error: "internal" }); }
    };
  }
  async function serve(port) {
    const srv = http.createServer(handler());
    await new Promise((r, j) => { srv.once("error", j); srv.listen(port, "127.0.0.1", r); });
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
