// relay/pvm-cpu-tier.mjs — admission for the pVM CPU tier (shielded/anchor/avf/PVM-CPU.md).
//
// A phone is a pVM CPU host when EVIDENCE says so, never because of its model name or a field it sends about itself:
//   1. the AVF attach verdict (relay/avf-verify.mjs via relay/tunnel.js): the chain roots in a pinned Google attestation
//      root, isVmSecure (protected VM, no debuggable DICE link), and an APK component whose codeHash is a pVM CPU BUILD
//      (build.sh ANCHOR_TIER=pvm-cpu: the CPU engine only, every other mode refused inside the VM) signed by a pinned
//      authority. The research build (split engine, the closed TPU lane) is a different codeHash and is never admitted here.
//   2. a capability report produced INSIDE that VM after its model loaded, signed by the VM's attested transport key
//      (the Ed25519 key the v2 binding transcript covers) over this attach's nonce: the protected build, the model's
//      digest, the VM's resources, and a fixed self-test's measured decode rate and output digest.
//   3. policy: the model is one the tier serves, its self-test output equals the reference output for that model (the
//      parity check: the VM ran the model it names, correctly), and the measured rate meets the model's floor.
// The report's `device` field (e.g. "Pixel 10 Pro XL") is carried for display and never read by any rule here.
//
// This tier is its own lane: the platform's inference engine on the owner's phone. It is NOT the OS-neutral app isolation
// contract (isolation/contract, isolation/DESIGN.md) and admits nothing for tenant app deployments.
//
// admitPvmCpu({ attach, reportBytes, signature, nonce }, policy, { now })
//   -> { eligible, tier: "pvm-cpu" | null, reasons: [...], capability | null }
import { createPublicKey, verify as edVerify } from "node:crypto";

export const PVM_CPU_TIER = "pvm-cpu";
export const PVM_CPU_CAPS_DOMAIN = "enclave-pvm-cpu-caps-v1\n";   // the signed bytes are DOMAIN || reportBytes, exactly
export const PVM_CPU_REPORT_MAX_BYTES = 4096;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const HEX64 = /^[0-9a-f]{64}$/;

// PVM_CPU_CODE_HASHES          comma list: codeHash of each admitted pvm-cpu build (shielded/anchor/avf/pins.py)
// PVM_CPU_AUTHORITY_HASHES     comma list: authorityHash of the signing key(s); falls back to METAL_AVF_AUTHORITY_HASHES
// PVM_CPU_MODELS               JSON array: [{ sha256, name, bytes, selftestSha256, minDecodeTokS, minMemMib }]
// PVM_CPU_REPORT_MAX_AGE_MS    how old a report may be, by its VM clock against the attach (default 15 min)
export function pvmCpuPolicyFromEnv(env) {
  const list = (k) => String(env[k] || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const codeHashes = list("PVM_CPU_CODE_HASHES");
  const authorityHashes = list("PVM_CPU_AUTHORITY_HASHES").length ? list("PVM_CPU_AUTHORITY_HASHES") : list("METAL_AVF_AUTHORITY_HASHES");
  let models = [];
  try { models = JSON.parse(env.PVM_CPU_MODELS || "[]"); } catch { return null; }
  if (!codeHashes.length || !authorityHashes.length || !Array.isArray(models) || !models.length) return null;
  return pvmCpuPolicy({ codeHashes, authorityHashes, models, maxReportAgeMs: Number(env.PVM_CPU_REPORT_MAX_AGE_MS) || undefined });
}

export function pvmCpuPolicy({ codeHashes, authorityHashes, models, maxReportAgeMs = 15 * 60 * 1000 }) {
  const m = new Map();
  for (const x of models) {
    const sha = String(x.sha256 || "").toLowerCase(), self = String(x.selftestSha256 || "").toLowerCase();
    if (!HEX64.test(sha) || !HEX64.test(self)) throw new Error(`pvm-cpu model entry needs sha256 and selftestSha256 (64 hex): ${x.name || sha}`);
    if (!(Number(x.minDecodeTokS) > 0)) throw new Error(`pvm-cpu model ${x.name || sha} needs a positive minDecodeTokS`);
    m.set(sha, { name: String(x.name || sha.slice(0, 12)), bytes: x.bytes == null ? null : Number(x.bytes), selftestSha256: self,
                 minDecodeTokS: Number(x.minDecodeTokS), minMemMib: Number(x.minMemMib) || 0 });
  }
  return { codeHashes: new Set(codeHashes.map((h) => String(h).toLowerCase())), authorityHashes: new Set(authorityHashes.map((h) => String(h).toLowerCase())),
           models: m, maxReportAgeMs };
}

// The report is strict JSON with exactly these fields; anything else is refused rather than ignored.
//   { v: 1, tier: "pvm-cpu", nonce: <64 hex>, mode: "protected"|"dev",
//     model: { sha256: <64 hex>, bytes: <int>, ctx: <int> },
//     vm: { threads: <int>, mem_mib: <int> },
//     selftest: { id: <string>, tokens: <int>, prefill_tok_s: <num>, decode_tok_s: <num>, output_sha256: <64 hex> },
//     vm_ms: <int>, attach_vm_ms: <int>, device: <string> }
const REPORT_KEYS = ["attach_vm_ms", "device", "mode", "model", "nonce", "selftest", "tier", "v", "vm", "vm_ms"];
export function parseCapabilityReport(reportBytes) {
  if (!Buffer.isBuffer(reportBytes) || !reportBytes.length || reportBytes.length > PVM_CPU_REPORT_MAX_BYTES) throw new Error("report must be 1..4096 bytes");
  let r; try { r = JSON.parse(reportBytes.toString("utf8")); } catch { throw new Error("report is not JSON"); }
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("report is not an object");
  const keys = Object.keys(r).sort();
  if (keys.join() !== REPORT_KEYS.join()) throw new Error(`report fields must be exactly ${REPORT_KEYS.join(",")} (got ${keys.join(",")})`);
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi, num = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  const obj = (o, ks) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join() === [...ks].sort().join();
  if (r.v !== 1) throw new Error("report version must be 1");
  if (typeof r.tier !== "string" || typeof r.mode !== "string" || typeof r.device !== "string" || r.device.length > 128) throw new Error("tier/mode/device must be strings");
  if (typeof r.nonce !== "string" || !HEX64.test(r.nonce)) throw new Error("nonce must be 64 lowercase hex");
  if (!obj(r.model, ["sha256", "bytes", "ctx"]) || !HEX64.test(String(r.model.sha256)) || !int(r.model.bytes, 1, 2 ** 40) || !int(r.model.ctx, 512, 32768))
    throw new Error("model must be { sha256, bytes, ctx }");
  if (!obj(r.vm, ["threads", "mem_mib"]) || !int(r.vm.threads, 1, 64) || !int(r.vm.mem_mib, 256, 1 << 20)) throw new Error("vm must be { threads, mem_mib }");
  const s = r.selftest;
  if (!obj(s, ["id", "tokens", "prefill_tok_s", "decode_tok_s", "output_sha256"]) || typeof s.id !== "string" || s.id.length > 64 || !int(s.tokens, 1, 4096) ||
      !num(s.prefill_tok_s, 0, 1e6) || !num(s.decode_tok_s, 0, 1e5) || !HEX64.test(String(s.output_sha256)))
    throw new Error("selftest must be { id, tokens, prefill_tok_s, decode_tok_s, output_sha256 }");
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
  if (r.mode !== "protected") reasons.push(`build mode ${JSON.stringify(r.mode)}: only a protected build (model pinned in the APK) is admitted`);
  if (r.vm_ms < r.attach_vm_ms || r.vm_ms - r.attach_vm_ms > policy.maxReportAgeMs) reasons.push("the self-test is older than the report window or predates the attach");
  // 3. the model and its measured capability
  const m = policy.models.get(r.model.sha256);
  if (!m) reasons.push(`model ${r.model.sha256.slice(0, 16)}… is not one the pVM CPU tier serves`);
  else {
    if (m.bytes != null && r.model.bytes !== m.bytes) reasons.push(`model size ${r.model.bytes} is not ${m.name}'s ${m.bytes}`);
    if (r.selftest.output_sha256 !== m.selftestSha256) reasons.push(`self-test output differs from ${m.name}'s reference output (parity failed)`);
    if (r.selftest.decode_tok_s < m.minDecodeTokS) reasons.push(`self-test decoded ${r.selftest.decode_tok_s} tok/s, below ${m.name}'s floor ${m.minDecodeTokS}`);
    if (m.minMemMib && r.vm.mem_mib < m.minMemMib) reasons.push(`VM memory ${r.vm.mem_mib} MiB is below ${m.name}'s ${m.minMemMib} MiB`);
  }
  return out({ tier: PVM_CPU_TIER, model: m ? { sha256: r.model.sha256, name: m.name, ctx: r.model.ctx } : null,
               selftest: { id: r.selftest.id, decodeTokS: r.selftest.decode_tok_s, prefillTokS: r.selftest.prefill_tok_s, tokens: r.selftest.tokens },
               vm: { threads: r.vm.threads, memMib: r.vm.mem_mib }, device: r.device, checkedAt: now });
}
