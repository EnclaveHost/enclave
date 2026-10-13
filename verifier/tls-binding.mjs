// verifier/tls-binding.mjs: how a served TLS key is bound into an attestation.
//
// The rule that matters for every format: the SPKI a verifier binds is the one ITS OWN handshake saw,
// never a key the document states. A document's transportKey field is a convenience for offline replay
// and is labelled as such in the verdict.
//
// Hosted (Tinfoil shim) format: report_data[0:32] = sha256(SPKI DER), report_data[32:64] = the HPKE public
// key, and the served certificate carries two extra SAN sets, NN<base32>.hpke.<zone> encoding that HPKE key
// and NN<base32>.hatt.<zone> encoding the ASCII hex of sha256(format + body). The encoding is Tinfoil's
// ("dcode"); it is re-implemented here from its observable form (fixture genoa-tinfoil/tls-cert.pem) so
// the hosted format verifies without Tinfoil code.
import { createHash, X509Certificate } from "node:crypto";

export const sha256 = (...parts) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest(); };

export function spkiOfCert(pemOrDer) {
  const c = new X509Certificate(pemOrDer);
  return { spki: c.publicKey.export({ type: "spki", format: "der" }), cert: c };
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Decode(s) {
  s = s.toUpperCase().replace(/=+$/, "");
  const out = []; let bits = 0, val = 0;
  for (const ch of s) { const i = B32.indexOf(ch); if (i < 0) throw new Error(`base32: bad char ${JSON.stringify(ch)}`); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
// SANs "NNchunk.<label>.<zone>" -> concatenated chunks in NN order -> bytes. Duplicate or missing indexes refuse.
export function decodeLabelledSans(sans, label) {
  const parts = sans.filter((d) => d.includes(`.${label}.`)).map((d) => { const m = /^(\d{2})([a-z2-7]+)\./i.exec(d); if (!m) throw new Error(`SAN ${d} is not NN<base32>.${label}.<zone>`); return [+m[1], m[2]]; });
  if (!parts.length) throw new Error(`no .${label}. SANs`);
  parts.sort((a, b) => a[0] - b[0]);
  parts.forEach(([n], i) => { if (n !== i) throw new Error(`.${label}. SAN chunks are not 00..${parts.length - 1} (found ${n} at ${i})`); });
  return base32Decode(parts.map((p) => p[1]).join(""));
}
export const dnsSans = (cert) => (cert.subjectAltName || "").split(",").map((s) => s.trim()).filter((s) => s.startsWith("DNS:")).map((s) => s.slice(4));

export const hashAttestationDocument = (doc) => sha256(Buffer.from(String(doc.format) + String(doc.body), "utf8")).toString("hex");

// Hosted-format certificate binding: the served certificate names the host, encodes the HPKE key the
// report states, and encodes the hash of exactly this document. Returns { ok, reasons, claims }.
export function checkHostedCertificate({ certPem, host, doc, hpkeKeyHex, now = new Date() }) {
  const reasons = [], fail = (m) => ({ ok: false, reasons: [...reasons, m], claims: null });
  let cert; try { cert = new X509Certificate(certPem); } catch (e) { return fail(`served certificate unparseable: ${e.message}`); }
  if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) return fail(`served certificate not valid at ${now.toISOString()} (${cert.validFrom} .. ${cert.validTo})`);
  const sans = dnsSans(cert);
  if (!host || !cert.checkHost(host)) return fail(`served certificate is not valid for host ${JSON.stringify(host)}`);
  reasons.push(`served certificate names ${host}, valid ${cert.validFrom} .. ${cert.validTo}`);
  let hpke, hatt;
  try { hpke = decodeLabelledSans(sans, "hpke").toString("hex"); hatt = decodeLabelledSans(sans, "hatt").toString("utf8"); } catch (e) { return fail(`certificate SAN encoding: ${e.message}`); }
  if (!/^[0-9a-f]{64}$/.test(hpke)) return fail("certificate hpke SAN does not decode to 32 bytes");
  if (hpke !== hpkeKeyHex) return fail("certificate HPKE key differs from the key the report states in report_data[32:64]");
  reasons.push("certificate hpke SANs encode the HPKE key the report states");
  const want = hashAttestationDocument(doc);
  if (hatt !== want) return fail("certificate hatt SANs do not encode sha256(format + body) of this document (a substituted document)");
  reasons.push("certificate hatt SANs bind this exact attestation document");
  return { ok: true, reasons, claims: { hpkePublicKey: hpke, attestationHash: want, tlsSpkiSha256: sha256(cert.publicKey.export({ type: "spki", format: "der" })).toString("hex"), notAfter: cert.validTo } };
}
