// verifier/pvm-policy.mjs on the REAL signed lab policies of the installed-client device run (test/fixtures/verifier/pvm-client/,
// SOURCE.md): an independent check written from the design text must reach the same outcome the owner's client did on the
// device for every policy case, from the same anchor and the same rollback memory, and refuse the forgeries.
//   run: node --test test/verifier-pvm-policy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { verifyClientPolicy, keyFingerprint, BUILTIN_GOOGLE_ROOTS } from "../verifier/pvm-policy.mjs";
import { admit } from "../verifier/admission.mjs";

const D = new URL("./fixtures/verifier/pvm-client/", import.meta.url);
const load = (f) => JSON.parse(fs.readFileSync(new URL(f, D), "utf8"));
const pol = (n) => load(`policies/${n}.json`);
const anchor = load("cli-install.json").anchor, policyKey = load("policy-key.json"), attackerKey = load("attacker-key.json"), state = load("cli-state.json");
const NOW = Date.parse("2026-09-24T10:00:00Z"), APP = "29e8942369846359b5936dbef1268c28f7097cccb3101b86345dc4dd8f4c1373", RID = "d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba";
const opts = (over = {}) => ({ anchorFp: anchor.policyKeyFp, serialFloor: anchor.serialFloor, now: NOW, clientVersion: "0.1.0", ...over });
const bytesOf = (n) => Buffer.from(pol(n).policy, "base64");

test("the anchor is the lab policy key's fingerprint, sha256 of the raw key; the attacker's key is not it", () => {
  assert.equal(keyFingerprint(policyKey.key), policyKey.fingerprint); assert.equal(anchor.policyKeyFp, policyKey.fingerprint);
  assert.equal(keyFingerprint(attackerKey.key), attackerKey.fingerprint); assert.notEqual(attackerKey.fingerprint, anchor.policyKeyFp);
  assert.equal(anchor.serialFloor, 1);
});
test("policies 1, 2 and 6 are genuine under the anchor, in order; the attacker's is refused before any field is read", () => {
  let st = null;
  for (const [n, serial] of [["policy-1", 1], ["policy-2", 2], ["policy-6", 6]]) {
    const r = verifyClientPolicy(pol(n), opts({ state: st }));
    assert.equal(r.ok, true, `${n}: ${r.reason}`); assert.equal(r.serial, serial); assert.equal(r.disabled, false);
    st = { serial: r.serial, digest: r.digest, nextPolicyFp: r.nextPolicyFp };
  }
  const a = verifyClientPolicy(pol("attacker"), opts()); assert.equal(a.ok, false); assert.match(a.reason, /a key this client's anchor does not name/);
  // and with the ATTACKER's fingerprint as the anchor, the attacker's policy is genuine and the lab key's is not: the anchor is the root
  assert.equal(verifyClientPolicy(pol("attacker"), opts({ anchorFp: attackerKey.fingerprint })).ok, true);
  assert.match(verifyClientPolicy(pol("policy-1"), opts({ anchorFp: attackerKey.fingerprint })).reason, /does not name/);
});
test("the client's recorded state (serial 6) is the digest of policy-6's bytes; a lower serial is a rollback; equivocation is refused", () => {
  assert.equal(state.serial, 6); assert.equal(state.digest, createHash("sha256").update(bytesOf("policy-6")).digest("hex")); assert.equal(state.policyFp, anchor.policyKeyFp);
  const again = verifyClientPolicy(pol("policy-6"), opts({ state })); assert.equal(again.ok, true, again.reason);   // the same policy re-presented
  for (const n of ["policy-1", "policy-2", "narrow-roots", "min-version", "other-app"]) { const r = verifyClientPolicy(pol(n), opts({ state })); assert.equal(r.ok, false, n); assert.match(r.reason, /below the 6 this client holds: a rollback/); }
  // the device's rollback case: policy 1 presented after policy 2 was accepted
  const rb = verifyClientPolicy(pol("policy-1"), opts({ state: { serial: 2, digest: createHash("sha256").update(bytesOf("policy-2")).digest("hex") } }));
  assert.equal(rb.ok, false); assert.match(rb.reason, /serial 1 is below the 2 this client holds/);
  const eq = verifyClientPolicy(pol("policy-6"), opts({ state: { serial: 6, digest: "00".repeat(32) } })); assert.equal(eq.ok, false); assert.match(eq.reason, /equivocation/);
  assert.match(verifyClientPolicy(pol("policy-1"), opts({ serialFloor: 2 })).reason, /below the install floor 2/);
});
test("narrow-roots is a genuine policy whose pins exclude the root the device's real chain uses (refused later at verify, as on the device)", () => {
  const r = verifyClientPolicy(pol("narrow-roots"), opts()); assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.policy.googleRootPins, [BUILTIN_GOOGLE_ROOTS[0]]);
  assert.ok(!r.policy.googleRootPins.includes("6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"), "the 2025 root the Pixel chains to is not pinned: the device refused at verify");
  const e = r.expectationsFor(APP); assert.equal(e.ok, true); assert.deepEqual(e.expect.rootPins, [BUILTIN_GOOGLE_ROOTS[0]]);
});
test("min-version is genuine but disables client 0.1.0 and not 0.2.0; other-app is genuine but admits no expectations for this app", () => {
  const d = verifyClientPolicy(pol("min-version"), opts()); assert.equal(d.ok, true); assert.equal(d.disabled, true); assert.match(d.reason, /below the policy's minimum 0\.2\.0: disabled/);
  const d2 = verifyClientPolicy(pol("min-version"), opts({ clientVersion: "0.2.0" })); assert.equal(d2.disabled, false);
  const o = verifyClientPolicy(pol("other-app"), opts()); assert.equal(o.ok, true);
  const e = o.expectationsFor(APP); assert.equal(e.ok, false); assert.match(e.reason, /does not admit this app/);
  assert.equal(o.expectationsFor("faaf2071f9cd6982beb9f089f1990b86f43449a7c1db7dcd13a7e1b9f1f27505").ok, true);
});
test("a genuine policy's expectations are what the consumer gate takes, and the gate releases only on them", () => {
  const r = verifyClientPolicy(pol("policy-2"), opts()); const e = r.expectationsFor(APP); assert.equal(e.ok, true);
  assert.deepEqual(e.expect.allowedRuntimeIds, [RID]); assert.deepEqual(e.expect.formats, ["enclave-pvm-app-evidence/v2"]); assert.deepEqual(e.expect.sealedWindow, { seconds: 600, maxRequests: 256 });
  const nonce = Buffer.alloc(32, 5), spki = "302a300506032b6570032100" + "ab".repeat(32);
  const verdict = { status: "verified", admissionSafe: true, omissions: [], checks: { "echo matches client": true, pvmEvidence: true },
    claims: { technology: "android-avf", family: "pvm-app", format: "enclave-pvm-app-evidence/v2", freshness: "client-nonce", nonce: nonce.toString("hex"), appId: APP, runtimeId: RID, transportSpki: spki, transportSpkiSha256: createHash("sha256").update(Buffer.from(spki, "hex")).digest("hex"), appKey: "cd".repeat(32), sealed: { windowSeconds: 600, maxRequests: 256 } } };
  const g = admit(verdict, { ...e.expect, nonce }, { clientKind: "browser" }); assert.equal(g.decision, "release", g.reasons.join("\n")); assert.equal(g.pinned.appKey, "cd".repeat(32));
  const other = verifyClientPolicy(pol("other-app"), opts()).expectationsFor(APP); assert.equal(other.ok, false);   // no expectations -> nothing to release on
  const wrongRuntime = admit({ ...verdict, claims: { ...verdict.claims, runtimeId: "e".repeat(64) } }, { ...e.expect, nonce }, { clientKind: "browser" }); assert.equal(wrongRuntime.decision, "hold");
});
test("time and forgeries: expired, not yet valid, a flipped signature or policy byte, padded bytes, extra field, empty pins, a widened root", () => {
  assert.match(verifyClientPolicy(pol("policy-2"), opts({ now: Date.parse("2026-09-25T00:00:00Z") })).reason, /expired/);
  assert.match(verifyClientPolicy(pol("policy-2"), opts({ now: Date.parse("2026-09-24T00:00:00Z") })).reason, /not yet valid/);
  const p2 = pol("policy-2");
  const sigFlip = { ...p2, sig: (p2.sig.slice(0, 10) + (p2.sig[10] === "0" ? "1" : "0") + p2.sig.slice(11)) }; assert.match(verifyClientPolicy(sigFlip, opts()).reason, /signature does not verify/);
  const b = Buffer.from(p2.policy, "base64");
  const at = b.indexOf(Buffer.from("433dd3dfa08f5be8")) + 3; const flipped = Buffer.from(b); flipped[at] = flipped[at] === 0x64 ? 0x65 : 0x64;   // one hex digit of the pinned code hash: still strict JSON of the right shape, but the signature fails
  assert.match(verifyClientPolicy({ policy: flipped.toString("base64"), sig: p2.sig }, opts()).reason, /signature does not verify/);
  const structural = Buffer.from(b); structural[0] ^= 1;   // a structural byte: refused as not JSON, before any cryptography
  assert.match(verifyClientPolicy({ policy: structural.toString("base64"), sig: p2.sig }, opts()).reason, /not JSON/);
  const padded = { policy: Buffer.from(JSON.stringify(JSON.parse(b.toString()), null, 1)).toString("base64"), sig: p2.sig }; assert.match(verifyClientPolicy(padded, opts()).reason, /strict compact JSON/);
  const extra = { policy: Buffer.from(JSON.stringify({ ...JSON.parse(b.toString()), extra: 1 })).toString("base64"), sig: p2.sig }; assert.match(verifyClientPolicy(extra, opts()).reason, /fields must be exactly/);
  const reordered = { policy: Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(b.toString())).reverse()))).toString("base64"), sig: p2.sig }; assert.match(verifyClientPolicy(reordered, opts()).reason, /fields must be exactly/);
  assert.match(verifyClientPolicy({ policy: p2.policy, sig: p2.sig, more: 1 }, opts()).reason, /exactly \{ policy, sig \}/);
  assert.match(verifyClientPolicy({ policy: p2.policy + " ", sig: p2.sig }, opts()).reason, /strict base64/);
  assert.match(verifyClientPolicy(p2, opts({ anchorFp: "zz" })).reason, /no anchored policy-key fingerprint/);
  // shape rules on unsigned edits are judged only after the signature, so they surface as signature failures; the rules
  // themselves are exercised on synthetic policies whose signature is the last check reached:
  const shaped = (mut) => { const q = JSON.parse(b.toString()); mut(q); return { policy: Buffer.from(JSON.stringify(q)).toString("base64"), sig: p2.sig }; };
  for (const [mut, re] of [[(q) => { q.googleRootPins = []; }, /signature|empty/], [(q) => { q.googleRootPins = ["ff".repeat(32)]; }, /signature|never widen/], [(q) => { q.formats = ["enclave-pvm-app-evidence/v1"]; }, /signature|formats/]]) {
    const r = verifyClientPolicy(shaped(mut), opts()); assert.equal(r.ok, false); assert.match(r.reason, re);
  }
});
