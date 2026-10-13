// verifier/tls-binding.mjs on the real shim certificate: the SAN encoding round-trips, the document hash
// matches, and malformed chunk sets are refused.
//   run: node --test test/verifier-tls-binding.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { X509Certificate } from "node:crypto";
import { decodeLabelledSans, dnsSans, hashAttestationDocument, checkHostedCertificate, spkiOfCert, base32Decode } from "../verifier/tls-binding.mjs";

const F = new URL("./fixtures/verifier/genoa-tinfoil/", import.meta.url);
const pem = fs.readFileSync(new URL("tls-cert.pem", F), "utf8"), rad = JSON.parse(fs.readFileSync(new URL("rad.json", F), "utf8"));
const sans = dnsSans(new X509Certificate(pem));

test("the real certificate's hatt SANs decode to sha256(format + body) of the served document", () => {
  assert.equal(decodeLabelledSans(sans, "hatt").toString("utf8"), hashAttestationDocument(rad));
  assert.equal(decodeLabelledSans(sans, "hpke").length, 32);
});
test("checkHostedCertificate passes on the genuine pair and reports the TLS key it bound", () => {
  const hpke = decodeLabelledSans(sans, "hpke").toString("hex");
  const r = checkHostedCertificate({ certPem: pem, host: "inference.tinfoil.sh", doc: rad, hpkeKeyHex: hpke, now: new Date("2026-09-24T05:00:00Z") });
  assert.equal(r.ok, true, r.reasons.join("\n"));
  assert.equal(r.claims.tlsSpkiSha256, rad && require_sha(spkiOfCert(pem).spki));
  assert.equal(checkHostedCertificate({ certPem: pem, host: "inference.tinfoil.sh", doc: { ...rad, body: rad.body.slice(0, -4) + "AAAA" }, hpkeKeyHex: hpke, now: new Date("2026-09-24T05:00:00Z") }).ok, false);
  assert.equal(checkHostedCertificate({ certPem: pem, host: "inference.tinfoil.sh", doc: rad, hpkeKeyHex: "00".repeat(32), now: new Date("2026-09-24T05:00:00Z") }).ok, false);
});
test("chunk sets must be complete, ordered and base32", () => {
  assert.throws(() => decodeLabelledSans(sans.filter((d) => !d.startsWith("01")), "hatt"), /not 00\.\./);
  assert.throws(() => decodeLabelledSans([...sans, sans.find((d) => d.includes(".hatt."))], "hatt"), /not 00\.\./);
  assert.throws(() => decodeLabelledSans(["00abc1.hatt.x"], "hatt"), /base32|not NN/);
  assert.throws(() => base32Decode("!!"), /bad char/);
});
import { createHash } from "node:crypto";
const require_sha = (b) => createHash("sha256").update(b).digest("hex");
