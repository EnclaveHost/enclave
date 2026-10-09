// pVM CPU admission (relay/pvm-cpu-tier.mjs, shielded/anchor/avf/PVM-CPU.md): the tier runs CPU-ONLY Wasm workloads
// and carries no model. A phone is admitted from EVIDENCE -- a verified secure AVF attach of a pvm-cpu BUILD, and a
// version-2 capability report signed by that VM's attested key over this attach's nonce, naming a CPU-only Wasm runtime
// the tier admits and resources that meet its minimums. Every rule is exercised on its own, the device name is shown to
// change nothing, and the retired model tier (a v1 report, a `models` policy, PVM_CPU_MODELS) is refused by name.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, randomBytes } from "node:crypto";
import { admitPvmCpu, pvmCpuPolicy, pvmCpuPolicyFromEnv, avfAttestWithPvmCpu, pvmCpuAvailability, parseCapabilityReport, PVM_CPU_CAPS_DOMAIN, PVM_CPU_REPORT_VERSION } from "../relay/pvm-cpu-tier.mjs";

const CODE = "a".repeat(64), RESEARCH_CODE = "b".repeat(64), AUTH = "c".repeat(128);
const RUNTIME = "d3370878" + "e".repeat(56), OTHER_RUNTIME = "f".repeat(64);
const policy = pvmCpuPolicy({ codeHashes: [CODE], authorityHashes: [AUTH], runtimeIds: [RUNTIME], minMemMib: 1024, minThreads: 2 });

function vmKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { spki: publicKey.export({ format: "der", type: "spki" }), privateKey };
}
function report(over = {}) {
  const base = { v: 2, tier: "pvm-cpu", nonce: "", mode: "protected", runtime: RUNTIME, vm: { threads: 6, mem_mib: 2048 },
    vm_ms: 200000, attach_vm_ms: 120000, device: "Pixel 10 Pro XL" };
  return { ...base, ...over };
}
function attempt({ key = vmKey(), signer = null, nonce = randomBytes(32), rep = {}, attach = {}, rawReport = null, pol = policy } = {}) {
  const r = report({ nonce: nonce.toString("hex"), ...rep });
  const bytes = rawReport || Buffer.from(JSON.stringify(r));
  const signature = edSign(null, Buffer.concat([Buffer.from(PVM_CPU_CAPS_DOMAIN), bytes]), (signer || key).privateKey);
  const a = { ok: true, rootVerified: true, isVmSecure: true, measurement: CODE, component: { codeHash: CODE, authorityHash: AUTH }, transportSpki: key.spki, ...attach };
  return admitPvmCpu({ attach: a, reportBytes: bytes, signature, nonce }, pol, { now: 1 });
}
const refusedFor = (res, re) => { assert.equal(res.eligible, false); assert.equal(res.tier, null); assert.equal(res.capability, null); assert.ok(res.reasons.some((x) => re.test(x)), res.reasons.join(" | ")); };

test("pvm-cpu: a verified secure pvm-cpu build with a signed, fresh v2 report naming an admitted CPU-only runtime is admitted", () => {
  assert.equal(PVM_CPU_REPORT_VERSION, 2);
  const res = attempt();
  assert.equal(res.eligible, true, res.reasons.join(" | "));
  assert.equal(res.tier, "pvm-cpu");
  assert.deepEqual(res.capability, { tier: "pvm-cpu", runtime: RUNTIME, vm: { threads: 6, memMib: 2048 }, device: "Pixel 10 Pro XL", gflops: null, checkedAt: 1 });
  assert.ok(!("model" in res.capability) && !("selftest" in res.capability), "no model and no inference self-test anywhere in the verdict");
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

test("pvm-cpu: tier, protected mode, CPU-only runtime, memory, threads and freshness each refuse on their own", () => {
  refusedFor(attempt({ rep: { tier: "research" } }), /not pvm-cpu/);
  refusedFor(attempt({ rep: { mode: "dev" } }), /only a protected build/);
  refusedFor(attempt({ rep: { runtime: OTHER_RUNTIME } }), /not a CPU-only Wasm runtime this tier admits/);
  refusedFor(attempt({ rep: { vm: { threads: 6, mem_mib: 1023 } } }), /VM memory 1023 MiB is below the tier's 1024/);
  refusedFor(attempt({ rep: { vm: { threads: 1, mem_mib: 2048 } } }), /VM threads 1 are below the tier's 2/);
  refusedFor(attempt({ rep: { vm_ms: 2000000, attach_vm_ms: 1000 } }), /older than the report window/);
  refusedFor(attempt({ rep: { vm_ms: 100, attach_vm_ms: 1000 } }), /predates the attach/);
  // the minimums are inclusive, and default to none (memory) and one thread
  assert.equal(attempt({ rep: { vm: { threads: 2, mem_mib: 1024 } } }).eligible, true);
  const bare = pvmCpuPolicy({ codeHashes: [CODE], authorityHashes: [AUTH], runtimeIds: [RUNTIME] });
  assert.equal(attempt({ pol: bare, rep: { vm: { threads: 1, mem_mib: 256 } } }).eligible, true);
});

test("pvm-cpu: the retired model tier is refused by name, never half-admitted", () => {
  // a version-1 report (model digest + inference self-test), even well signed and otherwise in order
  const nonce = randomBytes(32);
  const v1 = { v: 1, tier: "pvm-cpu", nonce: nonce.toString("hex"), mode: "protected",
    model: { sha256: "5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48", bytes: 3360161216, ctx: 4096 }, vm: { threads: 6, mem_mib: 7168 },
    selftest: { id: "pvm-cpu-selftest-v1", tokens: 64, prefill_tok_s: 108.2, decode_tok_s: 13.9, output_sha256: "d".repeat(64) },
    vm_ms: 200000, attach_vm_ms: 120000, device: "Pixel 10 Pro XL" };
  refusedFor(attempt({ nonce, rawReport: Buffer.from(JSON.stringify(v1)) }), /version-1 report is the retired model tier/);
  // a v2 report that smuggles a model field is refused by the strict schema
  refusedFor(attempt({ nonce, rawReport: Buffer.from(JSON.stringify({ ...report({ nonce: nonce.toString("hex") }), model: v1.model })) }), /fields must be exactly/);
  // a policy built for the old tier, and an environment that still names models
  assert.throws(() => pvmCpuPolicy({ codeHashes: [CODE], authorityHashes: [AUTH], runtimeIds: [RUNTIME], models: [] }), /retired model tier/);
  const why = [];
  assert.equal(pvmCpuPolicyFromEnv({ PVM_CPU_CODE_HASHES: CODE, METAL_AVF_AUTHORITY_HASHES: AUTH, PVM_CPU_RUNTIME_IDS: RUNTIME, PVM_CPU_MODELS: "[]" },
                                   { onRefuse: (w) => why.push(w) }), null);
  assert.match(why.join(), /PVM_CPU_MODELS is set: the pVM CPU tier carries no model now/);
});

test("pvm-cpu: the report schema is strict (missing, extra or mistyped fields refuse)", () => {
  const nonce = randomBytes(32), good = report({ nonce: nonce.toString("hex") });
  const { device, ...missing } = good;
  refusedFor(attempt({ nonce, rawReport: Buffer.from(JSON.stringify(missing)) }), /fields must be exactly/);
  refusedFor(attempt({ nonce, rawReport: Buffer.from(JSON.stringify({ ...good, eligible: true })) }), /fields must be exactly/);
  refusedFor(attempt({ nonce, rawReport: Buffer.from(JSON.stringify({ ...good, vm: { threads: "6", mem_mib: 2048 } })) }), /vm must be/);
  refusedFor(attempt({ nonce, rawReport: Buffer.from(JSON.stringify({ ...good, runtime: RUNTIME.toUpperCase() })) }), /runtime must be the RuntimeID/);
  refusedFor(attempt({ nonce, rawReport: Buffer.from(JSON.stringify({ ...good, v: 3 })) }), /report version must be 2/);
  refusedFor(attempt({ nonce, rawReport: Buffer.from("not json") }), /not JSON/);
  assert.throws(() => parseCapabilityReport(Buffer.alloc(5000, 0x20)), /1\.\.4096 bytes/);
});

test("pvm-cpu: no policy means no admission; the env policy parses, and refuses when incomplete or malformed", () => {
  refusedFor(admitPvmCpu({ attach: {} }, null), /not configured/);
  assert.equal(pvmCpuPolicyFromEnv({}), null);
  const why = []; const onRefuse = (w) => why.push(w);
  assert.equal(pvmCpuPolicyFromEnv({ PVM_CPU_CODE_HASHES: CODE, METAL_AVF_AUTHORITY_HASHES: AUTH }, { onRefuse }), null);   // no runtime list
  assert.match(why.pop(), /needs PVM_CPU_CODE_HASHES, an authority list and PVM_CPU_RUNTIME_IDS/);
  assert.equal(pvmCpuPolicyFromEnv({ PVM_CPU_CODE_HASHES: CODE, METAL_AVF_AUTHORITY_HASHES: AUTH, PVM_CPU_RUNTIME_IDS: "abc" }, { onRefuse }), null);
  assert.match(why.pop(), /runtimeIds must be hex \(64\)/);
  assert.equal(pvmCpuPolicyFromEnv({ PVM_CPU_CODE_HASHES: CODE, METAL_AVF_AUTHORITY_HASHES: AUTH, PVM_CPU_RUNTIME_IDS: RUNTIME, PVM_CPU_MIN_MEM_MIB: "-5" }, { onRefuse }), null);
  assert.match(why.pop(), /minMemMib must be a non-negative integer/);
  const p = pvmCpuPolicyFromEnv({ PVM_CPU_CODE_HASHES: CODE.toUpperCase(), METAL_AVF_AUTHORITY_HASHES: AUTH, PVM_CPU_RUNTIME_IDS: ` ${RUNTIME.toUpperCase()} `,
                                  PVM_CPU_MIN_MEM_MIB: "1536", PVM_CPU_MIN_THREADS: "4" });
  assert.ok(p.codeHashes.has(CODE) && p.authorityHashes.has(AUTH) && p.runtimeIds.has(RUNTIME));
  assert.equal(p.minMemMib, 1536); assert.equal(p.minThreads, 4); assert.equal(p.maxReportAgeMs, 15 * 60 * 1000);
  // PVM_CPU_AUTHORITY_HASHES wins over the METAL fallback
  const q = pvmCpuPolicyFromEnv({ PVM_CPU_CODE_HASHES: CODE, PVM_CPU_AUTHORITY_HASHES: "ab", METAL_AVF_AUTHORITY_HASHES: AUTH, PVM_CPU_RUNTIME_IDS: RUNTIME });
  assert.ok(q.authorityHashes.has("ab") && !q.authorityHashes.has(AUTH));
});

test("the hub's AVF policy: the tier needs no legacy or pad pins beside it; with both, authorities are the union and the builds untouched", () => {
  assert.equal(avfAttestWithPvmCpu(null, null), null);
  const legacy = { codeHashes: ["aa".repeat(32)], padCodeHashes: ["bb".repeat(32)], authorityHashes: ["cc".repeat(48)] };
  assert.equal(avfAttestWithPvmCpu(legacy, null), legacy, "no tier: the legacy policy as it was");
  const p = pvmCpuPolicy({ codeHashes: [CODE], authorityHashes: [AUTH], runtimeIds: [RUNTIME] });
  assert.deepEqual(avfAttestWithPvmCpu(null, p), { codeHashes: [], padCodeHashes: [], authorityHashes: [AUTH] },
                   "the tier alone: no v1 or pad build is admitted, only the tier's authority");
  const both = avfAttestWithPvmCpu(legacy, p);
  assert.deepEqual(both.codeHashes, legacy.codeHashes); assert.deepEqual(both.padCodeHashes, legacy.padCodeHashes, "pad eligibility unchanged");
  assert.deepEqual(both.authorityHashes, ["cc".repeat(48), AUTH]);
});

test("a pVM CPU row's pool is the relay-verified VM size; the host may only lower what is free; GFLOPS unreported", () => {
  const phoneSaid = { ok: true, role: "phone-anchor", gpu: false, nodeVcpus: 64, nodeRamGb: 512 };
  const row = { tier: "pvm-cpu", pvmCpu: { runtime: RUNTIME, vm: { threads: 8, memMib: 1994 } } };
  assert.deepEqual(pvmCpuAvailability(row, phoneSaid),
    { ok: true, role: "phone-anchor", gpu: false, nodeVcpus: 8, nodeRamGb: 1.9, ramGbFree: 1.9, cpuShareFree: 1, capacitySource: "pvm-capability-report" },
    "the VM's signed figures replace the phone host's own word");
  // the host agent's one slot taken by a buyer's app: nothing free, the VM's size unchanged
  assert.deepEqual(pvmCpuAvailability(row, { ...phoneSaid, cpuShareFree: 0 }),
    { ok: true, role: "phone-anchor", gpu: false, nodeVcpus: 8, nodeRamGb: 1.9, ramGbFree: 0, cpuShareFree: 0, capacitySource: "pvm-capability-report" });
  assert.equal(pvmCpuAvailability(row, { cpuShareFree: 0.5 }).ramGbFree, 1);
  for (const bad of [2, -0.1, "0", NaN, null]) assert.equal(pvmCpuAvailability(row, { cpuShareFree: bad }).cpuShareFree, 1, `an unreadable share (${bad}) frees nothing up and takes nothing away`);
  assert.equal(pvmCpuAvailability(row, phoneSaid).nodeGflops, undefined, "no native-core GFLOPS convention for an interpreted runtime");
  for (const r of [{ ...row, tier: undefined }, { tier: "pvm-cpu" }, { ...row, pvmCpu: { vm: { threads: 0, memMib: 1994 } } }, { ...row, pvmCpu: { vm: { threads: 8, memMib: "2G" } } }, null])
    assert.equal(pvmCpuAvailability(r, phoneSaid), phoneSaid, "no admitted report: the row keeps what the box sent");
});

test("a report may carry the VM's measured GFLOPS: carried to the pool when well-formed, refused when not", () => {
  const res = attempt({ rep: { gflops: 12.3456 } });
  assert.equal(res.eligible, true, res.reasons.join(" | "));
  assert.equal(res.capability.gflops, 12.35, "two decimals");
  for (const bad of [0, -1, "12", 1e7, null, { v: 1 }]) refusedFor(attempt({ rep: { gflops: bad } }), /gflops must be a positive number/);
  refusedFor(attempt({ rep: { gflops: 3, extra: 1 } }), /report fields must be exactly/);
  const row = { tier: "pvm-cpu", pvmCpu: { runtime: RUNTIME, vm: { threads: 8, memMib: 1994 }, gflops: 12.35 } };
  const a = pvmCpuAvailability(row, { ok: true });
  assert.equal(a.nodeGflops, 12.35); assert.equal(a.cpuGflopsFree, 12.35, "all of it unallocated");
  assert.equal(pvmCpuAvailability(row, { ok: true, cpuShareFree: 0 }).cpuGflopsFree, 0, "a taken slot frees no compute");
});
