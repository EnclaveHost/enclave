// pVM CPU admission (relay/pvm-cpu-tier.mjs, shielded/anchor/avf/PVM-CPU.md): a phone is admitted from EVIDENCE -- a verified
// secure AVF attach of a pvm-cpu BUILD, and a capability report signed by that VM's attested key over this attach's nonce,
// naming a served model whose self-test output equals the reference and whose measured rate meets the floor. Every rule is
// exercised on its own, and the device name is shown to change nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, randomBytes } from "node:crypto";
import { admitPvmCpu, pvmCpuPolicy, pvmCpuPolicyFromEnv, parseCapabilityReport, PVM_CPU_CAPS_DOMAIN } from "../relay/pvm-cpu-tier.mjs";

const CODE = "a".repeat(64), RESEARCH_CODE = "b".repeat(64), AUTH = "c".repeat(128);
const MODEL = "5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48", SELF = "d".repeat(64);
const policy = pvmCpuPolicy({ codeHashes: [CODE], authorityHashes: [AUTH],
  models: [{ sha256: MODEL, name: "gemma-4-e2b-q4_0", bytes: 3360161216, selftestSha256: SELF, minDecodeTokS: 10, minMemMib: 6144 }] });

function vmKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { spki: publicKey.export({ format: "der", type: "spki" }), privateKey };
}
function report(over = {}) {
  const base = { v: 1, tier: "pvm-cpu", nonce: "", mode: "protected",
    model: { sha256: MODEL, bytes: 3360161216, ctx: 4096 }, vm: { threads: 6, mem_mib: 7168 },
    selftest: { id: "pvm-cpu-selftest-v1", tokens: 64, prefill_tok_s: 108.2, decode_tok_s: 13.9, output_sha256: SELF },
    vm_ms: 200000, attach_vm_ms: 120000, device: "Pixel 10 Pro XL" };
  return { ...base, ...over };
}
function attempt({ key = vmKey(), signer = null, nonce = randomBytes(32), rep = {}, attach = {}, rawReport = null } = {}) {
  const r = report({ nonce: nonce.toString("hex"), ...rep });
  const bytes = rawReport || Buffer.from(JSON.stringify(r));
  const signature = edSign(null, Buffer.concat([Buffer.from(PVM_CPU_CAPS_DOMAIN), bytes]), (signer || key).privateKey);
  const a = { ok: true, rootVerified: true, isVmSecure: true, measurement: CODE, component: { codeHash: CODE, authorityHash: AUTH }, transportSpki: key.spki, ...attach };
  return admitPvmCpu({ attach: a, reportBytes: bytes, signature, nonce }, policy, { now: 1 });
}
const refusedFor = (res, re) => { assert.equal(res.eligible, false); assert.equal(res.tier, null); assert.equal(res.capability, null); assert.ok(res.reasons.some((x) => re.test(x)), res.reasons.join(" | ")); };

test("pvm-cpu: a verified secure pvm-cpu build with a signed, fresh, on-reference, fast-enough report is admitted", () => {
  const res = attempt();
  assert.equal(res.eligible, true, res.reasons.join(" | "));
  assert.equal(res.tier, "pvm-cpu");
  assert.deepEqual(res.capability.model, { sha256: MODEL, name: "gemma-4-e2b-q4_0", ctx: 4096 });
  assert.equal(res.capability.selftest.decodeTokS, 13.9);
});

test("pvm-cpu: the device name decides nothing (evidence does)", () => {
  for (const device of ["Pixel 10 Pro XL", "Pixel 11", "definitely a Pixel", ""]) assert.equal(attempt({ rep: { device } }).eligible, true, device);
  refusedFor(attempt({ rep: { device: "Pixel 10 Pro XL" }, attach: { isVmSecure: false } }), /isVmSecure/);   // a Pixel 10 name does not rescue bad evidence
});

test("pvm-cpu: the attach must be a verified, secure pvm-cpu build by a pinned authority", () => {
  refusedFor(attempt({ attach: { ok: false } }), /no verified AVF attestation/);
  refusedFor(attempt({ attach: { rootVerified: false } }), /no verified AVF attestation/);
  refusedFor(attempt({ attach: { isVmSecure: false } }), /isVmSecure/);
  refusedFor(attempt({ attach: { measurement: RESEARCH_CODE, component: { codeHash: RESEARCH_CODE, authorityHash: AUTH } } }), /not a pVM CPU build/);
  refusedFor(attempt({ attach: { component: { codeHash: CODE, authorityHash: "e".repeat(128) } } }), /not a pinned pVM CPU signing authority/);
  refusedFor(attempt({ attach: { transportSpki: Buffer.alloc(44) } }), /no attested Ed25519 transport key/);
});

test("pvm-cpu: the report must be signed by the attested key, over this attach's nonce", () => {
  refusedFor(attempt({ signer: vmKey() }), /not signed by the attested transport key/);
  const nonce = randomBytes(32);
  const k = vmKey(), bytes = Buffer.from(JSON.stringify(report({ nonce: randomBytes(32).toString("hex") })));
  const sig = edSign(null, Buffer.concat([Buffer.from(PVM_CPU_CAPS_DOMAIN), bytes]), k.privateKey);
  refusedFor(admitPvmCpu({ attach: { ok: true, rootVerified: true, isVmSecure: true, component: { codeHash: CODE, authorityHash: AUTH }, transportSpki: k.spki },
                           reportBytes: bytes, signature: sig, nonce }, policy), /not this attach's nonce/);
  // a signature over the bare report (no domain) is not accepted
  const k2 = vmKey(), b2 = Buffer.from(JSON.stringify(report({ nonce: nonce.toString("hex") })));
  refusedFor(admitPvmCpu({ attach: { ok: true, rootVerified: true, isVmSecure: true, component: { codeHash: CODE, authorityHash: AUTH }, transportSpki: k2.spki },
                           reportBytes: b2, signature: edSign(null, b2, k2.privateKey), nonce }, policy), /not signed/);
});

test("pvm-cpu: tier, protected mode, model, parity, speed, memory and freshness each refuse on their own", () => {
  refusedFor(attempt({ rep: { tier: "research" } }), /not pvm-cpu/);
  refusedFor(attempt({ rep: { mode: "dev" } }), /only a protected build/);
  refusedFor(attempt({ rep: { model: { sha256: "f".repeat(64), bytes: 3360161216, ctx: 4096 } } }), /not one the pVM CPU tier serves/);
  refusedFor(attempt({ rep: { model: { sha256: MODEL, bytes: 5, ctx: 4096 } } }), /model size/);
  refusedFor(attempt({ rep: { selftest: { id: "pvm-cpu-selftest-v1", tokens: 64, prefill_tok_s: 100, decode_tok_s: 14, output_sha256: "0".repeat(64) } } }), /parity failed/);
  refusedFor(attempt({ rep: { selftest: { id: "pvm-cpu-selftest-v1", tokens: 64, prefill_tok_s: 100, decode_tok_s: 9.9, output_sha256: SELF } } }), /below .* floor 10/);
  refusedFor(attempt({ rep: { vm: { threads: 6, mem_mib: 4096 } } }), /VM memory 4096/);
  refusedFor(attempt({ rep: { vm_ms: 2000000, attach_vm_ms: 1000 } }), /older than the report window/);
  refusedFor(attempt({ rep: { vm_ms: 100, attach_vm_ms: 1000 } }), /predates the attach/);
});

test("pvm-cpu: the report schema is strict (missing, extra or mistyped fields refuse)", () => {
  const nonce = randomBytes(32), good = report({ nonce: nonce.toString("hex") });
  const { device, ...missing } = good;
  refusedFor(attempt({ nonce, rawReport: Buffer.from(JSON.stringify(missing)) }), /fields must be exactly/);
  refusedFor(attempt({ nonce, rawReport: Buffer.from(JSON.stringify({ ...good, eligible: true })) }), /fields must be exactly/);
  refusedFor(attempt({ nonce, rawReport: Buffer.from(JSON.stringify({ ...good, vm: { threads: "6", mem_mib: 7168 } })) }), /vm must be/);
  refusedFor(attempt({ nonce, rawReport: Buffer.from("not json") }), /not JSON/);
  assert.throws(() => parseCapabilityReport(Buffer.alloc(5000, 0x20)), /1\.\.4096 bytes/);
});

test("pvm-cpu: no policy means no admission; the env policy parses and refuses when incomplete", () => {
  refusedFor(admitPvmCpu({ attach: {} }, null), /not configured/);
  assert.equal(pvmCpuPolicyFromEnv({}), null);
  assert.equal(pvmCpuPolicyFromEnv({ PVM_CPU_CODE_HASHES: CODE, METAL_AVF_AUTHORITY_HASHES: AUTH, PVM_CPU_MODELS: "nope" }), null);
  const p = pvmCpuPolicyFromEnv({ PVM_CPU_CODE_HASHES: CODE.toUpperCase(), METAL_AVF_AUTHORITY_HASHES: AUTH,
    PVM_CPU_MODELS: JSON.stringify([{ sha256: MODEL, name: "e2b", selftestSha256: SELF, minDecodeTokS: 10 }]) });
  assert.ok(p.codeHashes.has(CODE) && p.authorityHashes.has(AUTH) && p.models.get(MODEL).minDecodeTokS === 10);
  assert.throws(() => pvmCpuPolicy({ codeHashes: [CODE], authorityHashes: [AUTH], models: [{ sha256: MODEL, selftestSha256: SELF, minDecodeTokS: 0 }] }), /positive minDecodeTokS/);
});
