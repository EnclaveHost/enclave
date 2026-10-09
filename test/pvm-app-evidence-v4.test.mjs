// v4 app evidence (relay/pvm-app-attest.mjs verifyPvmAppEvidence; PVM-CPU.md "Serving buyers"): a REAL document from the
// marketplace host (test/fixtures/pvm-v4/probe-device.json, the release build 51aa6f5e on a Pixel 10 Pro XL, fetched over the
// app's own TLS port) verifies under the production pins -- Google's roots, the release build, the release key, the pVM
// runtime -- and yields the TLS key the client saw on that connection. Every v4 field is load-bearing: a changed TLS key,
// signature, restated field, nonce, app or instance is refused, and a caller that needs the TLS key refuses v1..v3 by name.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { verifyPvmAppEvidence, PVM_APP_EVIDENCE_FORMAT_V4, tlsKeyMessage } from "../relay/pvm-app-attest.mjs";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/pvm-v4/probe-device.json", import.meta.url), "utf8"));
const at = Date.parse(fx.capturedAt);
const expect = (over = {}) => ({ nonce: fx.doc.nonce, appId: fx.appSha256, allowedRuntimeIds: [fx.runtimeId],
  allowedCodeHashes: [fx.codeHash], allowedAuthorityHashes: [fx.authorityHash], now: at, ...over });
const verify = (doc = fx.doc, over = {}) => verifyPvmAppEvidence(doc, expect(over));
const with_ = (patch) => ({ ...fx.doc, ...patch });
const last = (r) => r.reasons.at(-1);

test("a real v4 document verifies under the production pins and yields the TLS key the client saw", () => {
  assert.equal(fx.doc.format, PVM_APP_EVIDENCE_FORMAT_V4);
  const r = verify();
  assert.equal(r.ok, true, r.reasons.join(" | "));
  assert.equal(r.measurement, fx.codeHash);
  assert.equal(r.runtimeId, fx.runtimeId);
  assert.equal(r.tlsSpkiSha256, fx.tlsSpkiSha256, "the TLS key bound here is the key the VM logged and the TLS connection presented");
  assert.equal(r.tlsSpki, fx.doc.tlsSpki);
  assert.match(r.instanceId, /^[0-9a-f]{64}$/);
  assert.ok(r.reasons.some((x) => /TLS key \(P-256/.test(x)));
  // a caller that needs the TLS key takes it; a bound deployment (instanceIds) accepts v4 as it does v3
  assert.equal(verify(fx.doc, { requireTls: true }).ok, true);
  assert.equal(verify(fx.doc, { instanceIds: [r.instanceId] }).ok, true);
  assert.match(last(verify(fx.doc, { instanceIds: ["a".repeat(64)] })), /not one bound to the selected deployment/);
});

test("the TLS binding is load-bearing: another key, signature or restated field is refused", () => {
  // another genuine P-256 key in place of the VM's: tlsKeySig no longer verifies
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" });
  const swapped = with_({ tlsSpki: other.toString("hex"), transportKey: other.toString("base64") });
  assert.match(last(verify(swapped)), /TLS key is not signed by the attested transport key/);
  // one bit of the signature
  const sig = Buffer.from(fx.doc.tlsKeySig, "hex"); sig[5] ^= 1;
  assert.match(last(verify(with_({ tlsKeySig: sig.toString("hex") }))), /TLS key is not signed/);
  // the restated fields must restate exactly
  assert.match(last(verify(with_({ transportKey: other.toString("base64") }))), /transportKey is not base64 of its tlsSpki/);
  assert.match(last(verify(with_({ appSha256: "0".repeat(64) }))), /appSha256 is not its app/);
  // not a P-256 SPKI, or not a point on the curve
  assert.match(last(verify(with_({ tlsSpki: "00" + fx.doc.tlsSpki.slice(2) }))), /not a 91-byte P-256 SPKI/);
  const offCurve = fx.doc.tlsSpki.slice(0, -2) + (fx.doc.tlsSpki.endsWith("00") ? "01" : "00");
  const r = verify(with_({ tlsSpki: offCurve, transportKey: Buffer.from(offCurve, "hex").toString("base64") }));
  assert.equal(r.ok, false);
  assert.match(last(r), /not a point on P-256|TLS key is not signed/);
  // dropping or adding a field
  const { tlsKeySig: _drop, ...missing } = fx.doc;
  assert.match(last(verify(missing)), /fields must be exactly/);
  assert.match(last(verify(with_({ extra: 1 }))), /fields must be exactly/);
});

test("the document is bound to the caller's nonce and app, and to the pins", () => {
  assert.match(last(verify(fx.doc, { nonce: "11".repeat(32) })), /another nonce/);
  assert.match(last(verify(fx.doc, { appId: "22".repeat(32) })), /names another app/);
  assert.equal(verify(fx.doc, { allowedCodeHashes: ["b".repeat(64)] }).ok, false);
  assert.equal(verify(fx.doc, { allowedAuthorityHashes: ["c".repeat(128)] }).ok, false);
  assert.match(verify(fx.doc, { allowedRuntimeIds: ["d".repeat(64)] }).reasons.join(), /not an admitted runtime/);
  assert.match(verify(fx.doc, { now: at + 30 * 86400_000 }).reasons.join(), /expired/);
});

test("a caller needing the TLS key refuses v1, v2 and v3 by name; the signed message is the documented one", () => {
  for (const f of ["enclave-pvm-app-evidence/v1", "enclave-pvm-app-evidence/v2", "enclave-pvm-app-evidence/v3"])
    assert.match(last(verify(with_({ format: f }), { requireTls: true })), /binds no TLS key: refused \(v4 required\)/);
  const m = tlsKeyMessage(fx.doc.nonce, fx.doc.app, "33".repeat(32), fx.doc.tlsSpki);
  assert.equal(m.subarray(0, 23).toString(), "enclave-pvm-tls-key-v1\n");
  assert.equal(m.length, 23 + 4 * 32);
  assert.deepEqual(m.subarray(23 + 96), createHash("sha256").update(Buffer.from(fx.doc.tlsSpki, "hex")).digest());
});
