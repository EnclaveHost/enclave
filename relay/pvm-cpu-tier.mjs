// relay/pvm-cpu-tier.mjs — admission for the pVM CPU tier (shielded/anchor/avf/PVM-CPU.md).
//
// The pVM CPU tier accepts CPU-ONLY workloads: a portable Wasm component, interpreted inside the phone's protected VM.
// It carries no model, no inference engine and no accelerator interface (the owner's direction, 2026-10-08). A phone is
// a pVM CPU host when EVIDENCE says so, never because of a field it sends about itself:
//   1. the AVF attach verdict (relay/avf-verify.mjs via relay/tunnel.js): the chain roots in a pinned Google attestation
//      root, isVmSecure (protected VM, no debuggable DICE link), and an APK component whose codeHash is a pVM CPU BUILD
//      (build.sh ANCHOR_TIER=pvm-cpu: the VM payload and the Wasm runtime, nothing else) signed by a pinned authority.
//      The research build (split engine, the closed TPU lane) is a different codeHash and is never admitted here.
//   2. a capability report produced INSIDE that VM, signed by the VM's attested transport key (the Ed25519 key the v2
//      binding transcript covers) over this attach's nonce: the build mode, the Wasm runtime's identity (its RuntimeID,
//      isolation/contract/runtime.mjs) and the VM's resources.
//   3. policy: the runtime is one the tier admits (a CPU-only runtime: no wasi:nn, no accelerator interface, so a
//      component that imports one fails to instantiate), the build is protected, the report is fresh, and the VM meets
//      the configured minimum memory and threads.
// A version-1 report (the retired model tier: a model digest and an inference self-test) is refused by name, and a relay
// whose environment still sets PVM_CPU_MODELS gets NO policy (fail closed) until that variable is removed: a model list
// means a configuration written for the old tier, and admitting under it would silently drop half of what it says.
// The report's `device` field (e.g. "Pixel 10 Pro XL") is carried for display and never read by any rule here.
//
// admitPvmCpu({ attach, reportBytes, signature, nonce }, policy, { now })
//   -> { eligible, tier: "pvm-cpu" | null, reasons: [...], capability | null }
import { createPublicKey, verify as edVerify } from "node:crypto";

export const PVM_CPU_TIER = "pvm-cpu";
export const PVM_CPU_CAPS_DOMAIN = "enclave-pvm-cpu-caps-v1\n";   // the signed bytes are DOMAIN || reportBytes, exactly
export const PVM_CPU_REPORT_MAX_BYTES = 4096;
export const PVM_CPU_REPORT_VERSION = 2;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const HEX64 = /^[0-9a-f]{64}$/;

// PVM_CPU_CODE_HASHES          comma list: codeHash of each admitted pvm-cpu build (shielded/anchor/avf/pins.py)
// PVM_CPU_AUTHORITY_HASHES     comma list: authorityHash of the signing key(s); falls back to METAL_AVF_AUTHORITY_HASHES
// PVM_CPU_RUNTIME_IDS          comma list: RuntimeID (64 hex) of each admitted CPU-only Wasm runtime
// PVM_CPU_MIN_MEM_MIB          optional: the least VM memory the tier admits (MiB)
// PVM_CPU_MIN_THREADS          optional: the fewest VM threads the tier admits
// PVM_CPU_REPORT_MAX_AGE_MS    how old a report may be, by its VM clock against the attach (default 15 min)
// PVM_CPU_MODELS               RETIRED: set at all, and there is no policy (fail closed)
// pvmCpuPolicyFromEnv(env, { onRefuse }) -> policy | null; onRefuse(reason) says why it is null.
export function pvmCpuPolicyFromEnv(env, { onRefuse = () => {} } = {}) {
  const list = (k) => String(env[k] || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (String(env.PVM_CPU_MODELS || "").trim()) {
    onRefuse("PVM_CPU_MODELS is set: the pVM CPU tier carries no model now; remove it (no pVM CPU policy until then)");
    return null;
  }
  const codeHashes = list("PVM_CPU_CODE_HASHES");
  const authorityHashes = list("PVM_CPU_AUTHORITY_HASHES").length ? list("PVM_CPU_AUTHORITY_HASHES") : list("METAL_AVF_AUTHORITY_HASHES");
  const runtimeIds = list("PVM_CPU_RUNTIME_IDS");
  if (!codeHashes.length || !authorityHashes.length || !runtimeIds.length) {
    if (codeHashes.length || runtimeIds.length) onRefuse("pVM CPU policy needs PVM_CPU_CODE_HASHES, an authority list and PVM_CPU_RUNTIME_IDS");
    return null;
  }
  const opt = (k) => (env[k] == null || String(env[k]).trim() === "" ? undefined : Number(env[k]));
  try {
    return pvmCpuPolicy({ codeHashes, authorityHashes, runtimeIds, minMemMib: opt("PVM_CPU_MIN_MEM_MIB"), minThreads: opt("PVM_CPU_MIN_THREADS"),
                          maxReportAgeMs: opt("PVM_CPU_REPORT_MAX_AGE_MS") });
  } catch (e) { onRefuse(`pVM CPU policy: ${e.message}`); return null; }
}

// The hub's AVF attach policy with the pVM CPU tier beside it. The tier attaches with the v2 transcript on ITS code hashes, so it
// needs no legacy (v1) or pad build pins: with the tier's policy alone this is an AVF policy with no v1/pad builds and the
// tier's authorities; with both, the authorities are the union (admitPvmCpu still holds a pVM CPU attach to the tier's own
// code hashes and authorities, and pad eligibility stays with padCodeHashes alone). Neither -> null.
export function avfAttestWithPvmCpu(avf, pvmCpu) {
  if (!pvmCpu) return avf || null;
  const base = avf || { codeHashes: [], padCodeHashes: [], authorityHashes: [] };
  return { ...base, authorityHashes: [...new Set([...(base.authorityHashes || []), ...pvmCpu.authorityHashes])] };
}

// A pVM CPU row's capacity pool, from what the RELAY verified rather than from the phone's host app: the VM's vCPUs and memory
// as its signed capability report states them (the hub put them on the row as pvmCpu.vm), and its GFLOPS as the VM measured
// them under the runtime apps get (pvmCpu.gflops; never the fleet's 62.5-per-vCPU native convention, which would overstate
// an interpreter). The tier takes no deployments, so nothing is allocated: every share is unallocated. A row without an
// admitted report keeps its availability as the box sent it.
//
// A SLOT host (shielded/anchor/avf/PVM-CPU.md "Slots by share": one VM per app, each sized to its app) states `slots` (1..4)
// and `poolMemMb`, the VM memory its owner lends the slots: no single attested VM holds that pool, so it is the owner's
// figure, bounded (MAX_SLOT_POOL_MB), and its free part is what the host says is unheld (never above the pool). The vCPUs and
// GFLOPS stay the attested host VM's (it runs on every core); the share free is the host's, as before.
export const MAX_SLOT_POOL_MB = 16384;
export function pvmCpuAvailability(row, availability) {
  const vm = row && row.tier === PVM_CPU_TIER ? row.pvmCpu?.vm : null;
  if (!vm || !Number.isInteger(vm.threads) || vm.threads < 1 || !Number.isInteger(vm.memMib) || vm.memMib < 1) return availability;
  const a = availability || {};
  const pool = Number.isInteger(a.slots) && a.slots >= 1 && a.slots <= 4 && Number.isInteger(a.poolMemMb) && a.poolMemMb >= 384 && a.poolMemMb <= MAX_SLOT_POOL_MB ? a.poolMemMb : null;
  const ramGb = Math.round((pool || vm.memMib) / 102.4) / 10;
  const g = row.pvmCpu.gflops;
  // the host may only LOWER what is free (slots taken by buyers' apps): a share in [0, 1], else the whole VM
  const said = a.cpuShareFree;
  const free = typeof said === "number" && Number.isFinite(said) && said >= 0 && said <= 1 ? said : 1;
  const poolFree = pool && Number.isInteger(a.poolMemMbFree) && a.poolMemMbFree >= 0 ? Math.min(pool, a.poolMemMbFree) : null;
  const gflops = typeof g === "number" && Number.isFinite(g) && g > 0 ? { nodeGflops: g, cpuGflopsFree: Math.round(g * free * 100) / 100 } : {};
  return { ...a, gpu: false, nodeVcpus: vm.threads, nodeRamGb: ramGb, ramGbFree: Math.round((poolFree !== null ? poolFree / 1024 : ramGb * free) * 10) / 10, cpuShareFree: free, ...gflops,
           capacitySource: pool ? "pvm-capability-report + the owner's slot pool" : "pvm-capability-report" };
}

export function pvmCpuPolicy({ codeHashes, authorityHashes, runtimeIds, minMemMib = 0, minThreads = 1, maxReportAgeMs = 15 * 60 * 1000, models } = {}) {
  if (models !== undefined) throw new Error("the pVM CPU tier carries no model: a policy with `models` is the retired model tier");
  // codeHash and authorityHash are the AVF extension's octet strings, as hex (a v4 Merkle root; a certificate's
  // SHA-512); a RuntimeID is a SHA-256, so exactly 64 hex
  const hexSet = (xs, what, re = /^(?:[0-9a-f]{2})+$/) => {
    const s = new Set((xs || []).map((h) => String(h).toLowerCase()));
    for (const h of s) if (!re.test(h)) throw new Error(`${what} must be hex${re === HEX64 ? " (64)" : ""}: ${h}`);
    if (!s.size) throw new Error(`${what} is empty`);
    return s;
  };
  const nonNegInt = (v, what) => { if (!Number.isInteger(v) || v < 0) throw new Error(`${what} must be a non-negative integer`); return v; };
  return { codeHashes: hexSet(codeHashes, "codeHashes"), authorityHashes: hexSet(authorityHashes, "authorityHashes"),
           runtimeIds: hexSet(runtimeIds, "runtimeIds", HEX64), minMemMib: nonNegInt(minMemMib, "minMemMib"), minThreads: nonNegInt(minThreads, "minThreads"),
           maxReportAgeMs: nonNegInt(maxReportAgeMs, "maxReportAgeMs") };
}

// The report is strict JSON with exactly these fields; anything else is refused rather than ignored.
//   { v: 2, tier: "pvm-cpu", nonce: <64 hex>, mode: "protected"|"dev", runtime: <64 hex RuntimeID>,
//     vm: { threads: <int>, mem_mib: <int> }, vm_ms: <int>, attach_vm_ms: <int>, device: <string> }
// and, from builds that measure it, gflops: <number> -- the VM's compute as the runtime apps get it (pvm-rt bench: an exactly
// counted f32 multiply-add workload on every vCPU at once, work / wall time). Optional, so older builds still parse.
const REPORT_KEYS = ["attach_vm_ms", "device", "mode", "nonce", "runtime", "tier", "v", "vm", "vm_ms"];
const REPORT_KEYS_MEASURED = [...REPORT_KEYS, "gflops"].sort();
export function parseCapabilityReport(reportBytes) {
  if (!Buffer.isBuffer(reportBytes) || !reportBytes.length || reportBytes.length > PVM_CPU_REPORT_MAX_BYTES) throw new Error("report must be 1..4096 bytes");
  let r; try { r = JSON.parse(reportBytes.toString("utf8")); } catch { throw new Error("report is not JSON"); }
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("report is not an object");
  if (r.v === 1) throw new Error("a version-1 report is the retired model tier (a model digest and an inference self-test): the pVM CPU tier carries no model");
  if (r.v !== PVM_CPU_REPORT_VERSION) throw new Error(`report version must be ${PVM_CPU_REPORT_VERSION}`);
  const keys = Object.keys(r).sort();
  if (keys.join() !== REPORT_KEYS.join() && keys.join() !== REPORT_KEYS_MEASURED.join())
    throw new Error(`report fields must be exactly ${REPORT_KEYS.join(",")} (and optionally gflops) (got ${keys.join(",")})`);
  if ("gflops" in r && !(typeof r.gflops === "number" && Number.isFinite(r.gflops) && r.gflops > 0 && r.gflops <= 1e6))
    throw new Error("gflops must be a positive number (at most 1e6)");
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const obj = (o, ks) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join() === [...ks].sort().join();
  if (typeof r.tier !== "string" || typeof r.mode !== "string" || typeof r.device !== "string" || r.device.length > 128) throw new Error("tier/mode/device must be strings");
  if (typeof r.nonce !== "string" || !HEX64.test(r.nonce)) throw new Error("nonce must be 64 lowercase hex");
  if (typeof r.runtime !== "string" || !HEX64.test(r.runtime)) throw new Error("runtime must be the RuntimeID: 64 lowercase hex");
  if (!obj(r.vm, ["threads", "mem_mib"]) || !int(r.vm.threads, 1, 64) || !int(r.vm.mem_mib, 256, 1 << 20)) throw new Error("vm must be { threads, mem_mib }");
  if (!int(r.vm_ms, 0, 2 ** 53) || !int(r.attach_vm_ms, 0, 2 ** 53)) throw new Error("vm_ms and attach_vm_ms must be non-negative integers");
  return r;
}

export function admitPvmCpu({ attach, reportBytes, signature, nonce } = {}, policy, { now = Date.now() } = {}) {
  const reasons = [];
  const out = (capability = null) => ({ eligible: !reasons.length, tier: reasons.length ? null : PVM_CPU_TIER, reasons, capability: reasons.length ? null : capability });
  if (!policy) { reasons.push("pvm-cpu admission is not configured on this relay (no policy): refusing"); return out(); }
  // 1. the attach verdict: verified chain, secure VM, a pvm-cpu build by a pinned authority
  if (!attach || attach.ok !== true || attach.rootVerified !== true) { reasons.push("no verified AVF attestation for this attach"); return out(); }
  if (attach.isVmSecure !== true) reasons.push("isVmSecure is not true: a debuggable or unverified VM is never pVM CPU");
  const code = String(attach.component?.codeHash || attach.measurement || "").toLowerCase(), auth = String(attach.component?.authorityHash || "").toLowerCase();
  if (!policy.codeHashes.has(code)) reasons.push(`codeHash ${code.slice(0, 16)}… is not a pVM CPU build (a research or unknown build is not this tier)`);
  if (!policy.authorityHashes.has(auth)) reasons.push(`authorityHash ${auth.slice(0, 16)}… is not a pinned pVM CPU signing authority`);
  const spki = attach.transportSpki;
  if (!Buffer.isBuffer(spki) || spki.length !== 44 || !spki.subarray(0, 12).equals(ED25519_SPKI_PREFIX)) { reasons.push("the attach carries no attested Ed25519 transport key"); return out(); }
  if (reasons.length) return out();
  // 2. the report: signed by that key, over this attach's nonce, well-formed
  const sig = Buffer.isBuffer(signature) ? signature : Buffer.from(String(signature || ""), "hex");
  let okSig = false;
  try { okSig = sig.length === 64 && Buffer.isBuffer(reportBytes) &&
        edVerify(null, Buffer.concat([Buffer.from(PVM_CPU_CAPS_DOMAIN), reportBytes]), createPublicKey({ key: spki, format: "der", type: "spki" }), sig); }
  catch { okSig = false; }
  if (!okSig) { reasons.push("the capability report is not signed by the attested transport key"); return out(); }
  let r; try { r = parseCapabilityReport(reportBytes); } catch (e) { reasons.push(`capability report: ${e.message}`); return out(); }
  const want = Buffer.isBuffer(nonce) ? nonce.toString("hex") : String(nonce || "").toLowerCase();
  if (!HEX64.test(want) || r.nonce !== want) reasons.push("the report's nonce is not this attach's nonce (a replayed or foreign report)");
  if (r.tier !== PVM_CPU_TIER) reasons.push(`the report names tier ${JSON.stringify(r.tier)}, not pvm-cpu`);
  if (r.mode !== "protected") reasons.push(`build mode ${JSON.stringify(r.mode)}: only a protected build is admitted`);
  if (r.vm_ms < r.attach_vm_ms || r.vm_ms - r.attach_vm_ms > policy.maxReportAgeMs) reasons.push("the report is older than the report window or predates the attach");
  // 3. the CPU-only runtime and the VM's resources
  if (!policy.runtimeIds.has(r.runtime)) reasons.push(`runtime ${r.runtime.slice(0, 16)}… is not a CPU-only Wasm runtime this tier admits`);
  if (r.vm.mem_mib < policy.minMemMib) reasons.push(`VM memory ${r.vm.mem_mib} MiB is below the tier's ${policy.minMemMib} MiB`);
  if (r.vm.threads < policy.minThreads) reasons.push(`VM threads ${r.vm.threads} are below the tier's ${policy.minThreads}`);
  return out({ tier: PVM_CPU_TIER, runtime: r.runtime, vm: { threads: r.vm.threads, memMib: r.vm.mem_mib }, device: r.device,
               gflops: "gflops" in r ? Math.round(r.gflops * 100) / 100 : null, checkedAt: now });
}
