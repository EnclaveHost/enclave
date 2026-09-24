// A REAL Pixel 10 pVM's v2 attach (test/fixtures/avf/pixel10-pvm-cpu-v2-attach.json, captured 2026-09-24 through the relay's
// own hub, cpu/local-hub.mjs): the attested key's signature over the v2 pad-binding transcript, which no earlier real-device
// test checked. The payload printed it with one trailing zero byte (the size query's length, 72, not the signing's, 71) and
// the relay refused the attach; the relay stays strict, the payload now prints the signing's own length.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { verifyAvfEvidence } from "../relay/avf-verify.mjs";
import { avfPadBinding } from "../relay/avf-binding.mjs";

const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/avf/pixel10-pvm-cpu-v2-attach.json", import.meta.url), "utf8"));
const chain = fx.chain.map((c) => Buffer.from(c, "base64"));
const bound = avfPadBinding(Buffer.from(fx.spki, "hex"), fx.padKey, Buffer.from(fx.nonce, "hex"));
const printed = Buffer.from(fx.signaturePrinted, "hex");
const der = printed.subarray(0, 2 + printed[1]);   // SEQUENCE header + its declared length
const verify = (signature) => verifyAvfEvidence({ chain, challenge: createHash("sha256").update(bound).digest(), signature, signedMessage: bound },
  { allowedCodeHashes: [fx.codeHash], allowedAuthorityHashes: [fx.authorityHash], now: Date.parse(fx.capturedAt) });

test("real v2 attach: the chain carries sha256(transcript) and the attested key's DER signature over it verifies", () => {
  assert.equal(der.length, 71);
  const r = verify(der);
  assert.equal(r.ok, true, r.reasons.join(" | "));
  assert.equal(r.measurement, fx.codeHash);
});

test("real v2 attach: the signature as the old payload printed it (a trailing zero) is refused, not repaired", () => {
  assert.equal(printed.length, 72);
  assert.equal(printed[71], 0);
  assert.match(verify(printed).reasons.join(), /signature does not verify/);
});

test("real v2 attach: another nonce is another transcript -- refused", () => {
  const other = avfPadBinding(Buffer.from(fx.spki, "hex"), fx.padKey, Buffer.alloc(32, 1));
  const r = verifyAvfEvidence({ chain, challenge: createHash("sha256").update(other).digest(), signature: der, signedMessage: other },
    { allowedCodeHashes: [fx.codeHash], allowedAuthorityHashes: [fx.authorityHash], now: Date.parse(fx.capturedAt) });
  assert.equal(r.ok, false);
});
