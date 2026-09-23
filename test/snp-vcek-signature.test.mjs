// The report signature is actually CHECKED against the VCEK, and each refusal comes from the step that
// must make it.
//
// verifyQuote used to call createPublicKey(vcekCert.publicKey). Node refuses a public KeyObject there
// (ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE), so EVERY report that arrived with a VCEK failed as a
// "cert-chain verification error" before its signature was looked at. That failed closed, but it also
// meant no report could ever verify, and nothing covered the path: every other test runs
// requireVcek:false with no VCEK at all.
//
// These cases forge a report the way a host would, sign it with a key the test made, and hand that key's
// self-signed "VCEK" over in the auxblob (the certificate table the host controls anyway). The REAL AMD
// chains come from fixtures through a stubbed fetch, so nothing touches the network.
//
//   run: node --test test/snp-vcek-signature.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyQuote } from "../relay/snp-verify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const chainPem = (p) => fs.readFileSync(path.join(HERE, "fixtures", "amd", `${p}-cert_chain.pem`), "utf8");

const MEAS = "11".repeat(48), SPKI = randomBytes(91), NONCE = randomBytes(32);

// A self-signed P-384 "VCEK" naming SEV-Milan, so the verifier goes to the Milan chain for it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vcek-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:secp384r1", "-nodes",
  "-keyout", `${tmp}/k.pem`, "-out", `${tmp}/c.pem`, "-days", "1", "-subj", "/CN=SEV-Milan"], { stdio: "ignore" });
const fakeKey = fs.readFileSync(`${tmp}/k.pem`);
const fakeVcekDer = Buffer.from(fs.readFileSync(`${tmp}/c.pem`, "utf8").replace(/-----[^-]+-----|\s/g, ""), "base64");
fs.rmSync(tmp, { recursive: true });

function forgedSignedReport() {
  const r = Buffer.alloc(0x4a0);
  r.writeUInt32LE(5, 0x00);
  r.writeBigUInt64LE(0x30000n, 0x08);                              // DEBUG and MIGRATE_MA off
  createHash("sha256").update(Buffer.concat([SPKI, NONCE])).digest().copy(r, 0x50);
  Buffer.from(MEAS, "hex").copy(r, 0x90);
  // ECDSA P-384 over bytes 0..0x2a0, r and s little-endian at 0x2a0 and 0x2e8, as the PSP writes them
  const sig = sign("sha384", r.subarray(0, 0x2a0), { key: fakeKey, dsaEncoding: "ieee-p1363" });
  Buffer.from(sig.subarray(0, 48)).reverse().copy(r, 0x2a0);
  Buffer.from(sig.subarray(48, 96)).reverse().copy(r, 0x2a0 + 0x48);
  return r;
}
const auxblob = () => {                                           // {guid, offset, length}, zero-terminated
  const hdr = Buffer.alloc(48);
  Buffer.from("63da758de6644564adc5f4b93be8accd", "hex").copy(hdr, 0);
  hdr.writeUInt32LE(48, 16);
  hdr.writeUInt32LE(fakeVcekDer.length, 20);
  return Buffer.concat([hdr, fakeVcekDer]);
};
const verify = (report, extra = {}) => verifyQuote(report, {
  challenge: NONCE, transportKeySpki: SPKI, allowedMeasurements: [MEAS], requireVcek: true, ...extra });

const realFetch = globalThis.fetch;
test.before(() => {
  globalThis.fetch = async (url) => {
    const m = /\/vcek\/v1\/(Milan|Genoa|Turin)\/cert_chain$/.exec(String(url));
    return m ? new Response(chainPem(m[1]), { status: 200 }) : new Response("", { status: 404 });
  };
});
test.after(() => { globalThis.fetch = realFetch; });

test("a correctly signed report reaches the chain check, and a VCEK that is not AMD's is refused there", async () => {
  const res = await verify(forgedSignedReport(), { auxblob: auxblob() });
  assert.equal(res.ok, false);
  assert.equal(res.reasons.at(-1), "VCEK does not chain to ASK",
    "the signature must have verified (else: signature invalid) and the pinned chain refused the VCEK");
});

test("one byte changed after signing is refused on the signature", async () => {
  const r = forgedSignedReport();
  r[0x10] ^= 1;                                                   // family_id: no field check reads it
  const res = await verify(r, { auxblob: auxblob() });
  assert.equal(res.ok, false);
  assert.equal(res.reasons.at(-1), "VCEK signature over the report is invalid");
});

test("with no VCEK anywhere, requireVcek refuses instead of calling the report verified", async () => {
  const res = await verify(forgedSignedReport());
  assert.equal(res.ok, false);
  assert.match(res.reasons.at(-1), /^no VCEK available/);
  const lab = await verify(forgedSignedReport(), { requireVcek: false });
  assert.equal(lab.ok, true);
  assert.equal(lab.vcekVerified, false, "a caller that allows it must be told the chain was NOT verified");
});
