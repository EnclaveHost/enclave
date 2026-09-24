// A REAL Pixel 10 pVM's evidence through the relay's own verifiers (test/fixtures/avf/pixel10-pvm-cpu-chain.json, captured
// 2026-09-23 from the protected pvm-cpu build p2 on a Pixel 10 Pro XL, Android 17). Synthetic chains cannot prove the
// verifier accepts what phones actually send: this one was refused until the extension's empty fourth field was allowed.
//   - the chain verifies to a pinned Google root at the capture time, isVmSecure, the pvm-cpu build's codeHash;
//   - the same chain is refused expired, for another challenge, and for a build it is not;
//   - a fourth extension field that is not an empty SEQUENCE is refused (same-length tag swap on the real leaf);
//   - the VM's signed capability report from that run is admitted by admitPvmCpu, and its self-test digest equals the
//     digest the SAME engine produced natively on the same phone (cpu/selftest-ref.c): parity.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { X509Certificate } from "node:crypto";
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

test("real capability report: admitted as pvm-cpu, and its self-test digest equals the native run's (parity)", () => {
  const avf = verify();
  const policy = pvmCpuPolicy({ codeHashes: [fx.codeHash], authorityHashes: [fx.authorityHash],
    models: [{ sha256: fx.modelSha256, name: "gemma-4-e2b-q4_0", bytes: 3360161216, selftestSha256: fx.nativeSelftestSha256, minDecodeTokS: 10, minMemMib: 6144 }] });
  const attach = { ok: avf.ok, rootVerified: avf.rootVerified, isVmSecure: avf.isVmSecure, measurement: avf.measurement,
                   component: avf.component, transportSpki: Buffer.from(fx.transportSpki, "hex") };
  const res = admitPvmCpu({ attach, reportBytes: Buffer.from(fx.capsReportHex, "hex"), signature: fx.capsSigHex, nonce: fx.challenge }, policy, { now: at });
  assert.equal(res.eligible, true, res.reasons.join(" | "));
  assert.equal(res.tier, "pvm-cpu");
  const rep = JSON.parse(Buffer.from(fx.capsReportHex, "hex").toString("utf8"));
  assert.equal(rep.selftest.output_sha256, fx.nativeSelftestSha256);   // the pVM produced exactly the native tokens
  assert.equal(rep.mode, "protected");
  // the same report under another signature, or answering another nonce, is not admitted
  const sig = Buffer.from(fx.capsSigHex, "hex"); sig[0] ^= 1;
  assert.equal(admitPvmCpu({ attach, reportBytes: Buffer.from(fx.capsReportHex, "hex"), signature: sig, nonce: fx.challenge }, policy, { now: at }).eligible, false);
  assert.equal(admitPvmCpu({ attach, reportBytes: Buffer.from(fx.capsReportHex, "hex"), signature: fx.capsSigHex, nonce: "11".repeat(32) }, policy, { now: at }).eligible, false);
});
