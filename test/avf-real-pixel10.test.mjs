// A REAL Pixel 10 pVM's evidence through the relay's own verifiers (test/fixtures/avf/pixel10-pvm-cpu-chain.json, captured
// 2026-09-23 from the protected pvm-cpu build p2 on a Pixel 10 Pro XL, Android 17). Synthetic chains cannot prove the
// verifier accepts what phones actually send: this one was refused until the extension's empty fourth field was allowed.
//   - the chain verifies to a pinned Google root at the capture time, isVmSecure, the pvm-cpu build's codeHash;
//   - the same chain is refused expired, for another challenge, and for a build it is not;
//   - a fourth extension field that is not an empty SEQUENCE is refused (same-length tag swap on the real leaf);
//   - the VM's signed capability report from that run is a version-1 report of the RETIRED model tier (a model digest
//     and an inference self-test): its signature verifies under the attested transport key, and admitPvmCpu now refuses
//     it by name. The pVM CPU tier carries no model.
//   - a version-2 capture from the CPU-only build (below) is admitted, and refused for another runtime, signature, nonce or
//     memory floor.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { X509Certificate, createHash } from "node:crypto";
import { verifyAvfEvidence, parseAvfExtension } from "../relay/avf-verify.mjs";
import { admitPvmCpu, pvmCpuPolicy } from "../relay/pvm-cpu-tier.mjs";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/avf/pixel10-pvm-cpu-chain.json", import.meta.url), "utf8"));
const chain = fx.chain.map((c) => Buffer.from(c, "base64"));
const at = Date.parse(fx.capturedAt);
const verify = (over = {}, ev = {}) => verifyAvfEvidence({ chain, challenge: fx.challenge, ...ev },
  { allowedCodeHashes: [fx.codeHash], allowedAuthorityHashes: [fx.authorityHash], now: at, ...over });

test("real Pixel 10 pVM chain: verifies to a pinned Google root, secure VM, the pvm-cpu build", () => {
  const r = verify();
  assert.equal(r.ok, true, r.reasons.join(" | "));
  assert.equal(r.rootVerified, true);
  assert.equal(r.isVmSecure, true);
  assert.equal(r.measurement, fx.codeHash);
  assert.equal(r.components.length, 1);
  assert.equal(r.components[0].name, "apk:host.enclave.anchor.avf");
});

test("real Pixel 10 pVM chain: refused expired, for another challenge, and for another build", () => {
  assert.match(verify({ now: Date.parse(fx.validTo) + 60_000 }).reasons.join(), /expired/);
  assert.match(verify({}, { challenge: "00".repeat(32) }).reasons.join(), /attestationChallenge does not match/);
  assert.match(verify({ allowedCodeHashes: ["b".repeat(64)] }).reasons.join(), /no APK component with an allowlisted codeHash/);
  assert.match(verify({ allowedAuthorityHashes: ["c".repeat(128)] }).reasons.join(), /unpinned authority/);
});

test("the extension's fourth field is accepted only as an EMPTY SEQUENCE", () => {
  const certs = chain.map((d) => new X509Certificate(d));
  const leaf = certs.find((c) => !certs.some((d) => d !== c && d.checkIssued(c)));
  assert.doesNotThrow(() => parseAvfExtension(leaf.raw));
  // the real extension ends "30 00": swap that tag for an empty OCTET STRING (same length, the rest untouched)
  const der = Buffer.from(leaf.raw);
  const oid = der.indexOf(Buffer.from("2b06010401d67902011d01", "hex"));
  const tail = der.indexOf(Buffer.from("3000", "hex"), oid);
  assert.ok(oid > 0 && tail > oid);
  der[tail] = 0x04;
  assert.throws(() => parseAvfExtension(der), /fourth field is not an empty SEQUENCE/);
});

test("real capability report: a version-1 (model tier) report is refused by name, past a genuine signature", () => {
  const avf = verify();
  const policy = pvmCpuPolicy({ codeHashes: [fx.codeHash], authorityHashes: [fx.authorityHash], runtimeIds: ["d3370878" + "0".repeat(56)] });
  const attach = { ok: avf.ok, rootVerified: avf.rootVerified, isVmSecure: avf.isVmSecure, measurement: avf.measurement,
                   component: avf.component, transportSpki: Buffer.from(fx.transportSpki, "hex") };
  const bytes = Buffer.from(fx.capsReportHex, "hex");
  const rep = JSON.parse(bytes.toString("utf8"));
  assert.equal(rep.v, 1); assert.ok(rep.model && rep.selftest, "the capture is the old tier's report: a model and an inference self-test");
  const res = admitPvmCpu({ attach, reportBytes: bytes, signature: fx.capsSigHex, nonce: fx.challenge }, policy, { now: at });
  assert.equal(res.eligible, false);
  assert.deepEqual(res.reasons, ["capability report: a version-1 report is the retired model tier (a model digest and an inference self-test): the pVM CPU tier carries no model"],
                   "the real signature verifies (no signature reason), and the only refusal is the retired model tier");
  // under another signature the refusal is the signature's, before the report is read at all
  const sig = Buffer.from(fx.capsSigHex, "hex"); sig[0] ^= 1;
  assert.match(admitPvmCpu({ attach, reportBytes: bytes, signature: sig, nonce: fx.challenge }, policy, { now: at }).reasons.join(), /not signed by the attested transport key/);
});

// A REAL version-2 capture from the CPU-only build (test/fixtures/avf/pixel10-pvm-cpu-cpuonly-v2.json, 2026-10-08, the same
// phone; shielded/anchor/avf/results/pvm-cpu-only-20261008 on branch pvm-cpu/cpu-only). The run had no relay, so the report
// answers the owner's challenge; the chain, the attested transport key and the signed report are the phone's own.
const fx2 = JSON.parse(fs.readFileSync(new URL("./fixtures/avf/pixel10-pvm-cpu-cpuonly-v2.json", import.meta.url), "utf8"));
const at2 = Date.parse(fx2.capturedAt);
const admit2 = (policyOver = {}, sig = fx2.capsSigHex, nonce = fx2.challenge) => {
  const avf = verifyAvfEvidence({ chain: fx2.chain.map((c) => Buffer.from(c, "base64")), challenge: fx2.challenge },
    { allowedCodeHashes: [fx2.codeHash], allowedAuthorityHashes: [fx2.authorityHash], now: at2 });
  assert.equal(avf.ok, true, avf.reasons.join(" | "));
  const attach = { ok: avf.ok, rootVerified: avf.rootVerified, isVmSecure: avf.isVmSecure, measurement: avf.measurement,
                   component: avf.component, transportSpki: Buffer.from(fx2.transportSpki, "hex") };
  const policy = pvmCpuPolicy({ codeHashes: [fx2.codeHash], authorityHashes: [fx2.authorityHash], runtimeIds: [fx2.runtimeId], ...policyOver });
  return admitPvmCpu({ attach, reportBytes: Buffer.from(fx2.capsReportHex, "hex"), signature: sig, nonce }, policy, { now: at2 });
};

test("real CPU-only capture: the version-2 report is admitted, naming the runtime and no model", () => {
  const rep = JSON.parse(Buffer.from(fx2.capsReportHex, "hex").toString("utf8"));
  assert.equal(rep.v, 2); assert.equal(rep.mode, "protected"); assert.equal(rep.model, undefined);
  assert.equal(createHash("sha256").update(fx2.runtimeIdentity).digest("hex"), fx2.runtimeId, "RuntimeID = SHA-256 of the identity as printed");
  assert.equal(rep.runtime, fx2.runtimeId);
  const res = admit2();
  assert.equal(res.eligible, true, res.reasons.join(" | "));
  assert.deepEqual({ tier: res.capability.tier, runtime: res.capability.runtime, threads: res.capability.vm.threads },
                   { tier: "pvm-cpu", runtime: fx2.runtimeId, threads: rep.vm.threads });
});

test("real CPU-only capture: refused for another runtime, under another signature, for another nonce, below a memory floor", () => {
  assert.deepEqual(admit2({ runtimeIds: ["e".repeat(64)] }).reasons, [`runtime ${fx2.runtimeId.slice(0, 16)}… is not a CPU-only Wasm runtime this tier admits`]);
  const sig = Buffer.from(fx2.capsSigHex, "hex"); sig[5] ^= 1;
  assert.deepEqual(admit2({}, sig).reasons, ["the capability report is not signed by the attested transport key"]);
  assert.deepEqual(admit2({}, fx2.capsSigHex, "00".repeat(32)).reasons, ["the report's nonce is not this attach's nonce (a replayed or foreign report)"]);
  const rep = JSON.parse(Buffer.from(fx2.capsReportHex, "hex").toString("utf8"));
  assert.deepEqual(admit2({ minMemMib: rep.vm.mem_mib + 1 }).reasons, [`VM memory ${rep.vm.mem_mib} MiB is below the tier's ${rep.vm.mem_mib + 1} MiB`]);
});
