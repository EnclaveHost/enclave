// verifier/web/provider.mjs: the browser's crypto provider for verifier/snp.mjs (context.crypto). It answers the same
// questions Node's NODE_CRYPTO answers with node:crypto (the AMD chain, the CRL, the report signature, hashes, the served
// certificate), with WebCrypto and verifier/web/x509.mjs. Every reason string is the Node function's, verbatim, so a verdict
// from either build reads the same and test/verifier-web-differential.test.mjs can hold them equal; where the underlying
// reader's error text differs it sits after "unparseable:", and where this build refuses on a stricter ground than Node the
// Node wording is kept and the ground is in `detail`. Policy (windows, CN names, key sizes, the CRL rule) is applied here
// exactly as verifier/snp.mjs applies it in Node, in the same order; the CRL judgement itself is snp.mjs's judgeCrl.
import { AMD_ARK_SHA256 } from "../../relay/snp-verify.mjs";
import { crlPolicyPrelude, judgeCrl } from "../snp.mjs";
import { parseCrl, equalBytes, toHex } from "../der.mjs";
import { decodeLabelledSans } from "../tls-binding.mjs";
import * as X from "./x509.mjs";

const inWindow = (c, now) => now >= c.notBefore && now <= c.notAfter;
const asBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

// ASK -> ARK alone (verifier/snp.mjs parseAmdChain, same checks, same order, same words)
export async function parseAmdChain({ chainPem, product, now, roots = AMD_ARK_SHA256 }) {
  const fail = (why, detail) => ({ ok: false, why, detail });
  let chain;
  try { chain = await Promise.all(X.pemCertificates(chainPem).map(X.loadCertificate)); } catch (e) { return fail(`AMD chain unparseable: ${e.message}`); }
  if (chain.length !== 2) return fail(`AMD cert_chain must be exactly ASK then ARK (got ${chain.length} certificates)`);
  const [ask, ark] = chain;
  const want = roots.get(product);
  if (!want) return fail(`no pinned AMD root for product line ${JSON.stringify(product)} (fail closed)`);
  if (ark.fp256 !== want) return fail(`the served ARK (${ark.fp256.slice(0, 16)}...) is not AMD's pinned ${product} root`);
  if (ark.subjectCn !== `ARK-${product}`) return fail(`ARK subject CN is ${ark.subjectCn}, expected ARK-${product}`);
  if (ask.subjectCn !== `SEV-${product}`) return fail(`ASK subject CN is ${ask.subjectCn}, expected SEV-${product}`);
  for (const [c, what] of [[ark, "ARK"], [ask, "ASK"]]) if (!inWindow(c, now)) return fail(`${what} certificate is not valid at ${now.toISOString()} (${c.validFrom} .. ${c.validTo})`);
  for (const [c, what] of [[ark, "ARK"], [ask, "ASK"]]) if (c.key.type !== "rsa" || c.key.bits !== 4096) return fail(`${what} key is not RSA-4096`);
  const self = await X.verifyCertificateSignature(ark, ark); if (!self.ok) return fail("ARK is not self-signed", self.why);
  const issued = X.issuedError(ask, ark); if (issued) return fail("ASK is not signed by the ARK", issued);
  const s = await X.verifyCertificateSignature(ask, ark); if (!s.ok) return fail("ASK is not signed by the ARK", s.why);
  return { ok: true, why: null, ask, ark };
}
// VCEK -> ASK -> ARK (verifier/snp.mjs checkChain)
export async function checkChain({ vcekDer, chainPem, product, now, roots = AMD_ARK_SHA256 }) {
  const reasons = [], fail = (why, detail) => ({ ok: false, why, reasons, detail });
  let vcek;
  try { vcek = await X.loadCertificate(vcekDer instanceof Uint8Array ? vcekDer : new Uint8Array(vcekDer)); } catch (e) { return fail(`VCEK unparseable: ${e.message}`); }
  const c = await parseAmdChain({ chainPem, product, now, roots }); if (!c.ok) return fail(c.why, c.detail);
  const { ask, ark } = c;
  if (vcek.subjectCn !== "SEV-VCEK") return fail(`VCEK subject CN is ${vcek.subjectCn}, expected SEV-VCEK`);
  if (vcek.issuerCn !== `SEV-${product}`) return fail(`VCEK issuer CN is ${vcek.issuerCn}, expected SEV-${product}`);
  if (!inWindow(vcek, now)) return fail(`VCEK certificate is not valid at ${now.toISOString()} (${vcek.validFrom} .. ${vcek.validTo})`);
  const issued = X.issuedError(vcek, ask); if (issued) return fail("VCEK is not signed by the ASK", issued);
  const s = await X.verifyCertificateSignature(vcek, ask); if (!s.ok) return fail("VCEK is not signed by the ASK", s.why);
  reasons.push(`AMD chain verified: VCEK -> ASK (SEV-${product}) -> ARK-${product}, ARK pinned by sha256, all three valid at ${now.toISOString().slice(0, 10)}`);
  return { ok: true, why: null, reasons, vcek, ask, ark };
}
// Is this CRL AMD's, for this ARK (verifier/snp.mjs checkCrlAuthentic)
export async function checkCrlAuthentic({ crlDer, ark, now }) {
  let crl; try { crl = parseCrl(crlDer); } catch (e) { return { ok: false, why: `CRL unparseable: ${e.message}` }; }
  if (!crl.sigAlgIsRsaPss) return { ok: false, why: `CRL signature algorithm ${crl.algOid} is not RSASSA-PSS` };
  if (!equalBytes(crl.issuerDer, ark.subjectDer)) return { ok: false, why: "CRL issuer is not the pinned ARK" };
  const s = await X.verifyCrlSignature(crl, ark);
  if (!s.ok) return { ok: false, why: "CRL signature does not verify with the pinned ARK", detail: s.why };
  if (now < crl.thisUpdate) return { ok: false, why: `CRL thisUpdate ${crl.thisUpdate.toISOString()} is in the future` };
  return { ok: true, why: null, crl };
}
export async function checkCrl({ crlDer, ark, ask, now, mode = "required", maxStaleDays = 0 }) {
  const pre = crlPolicyPrelude({ crlDer, mode }); if (pre) return pre;
  const a = await checkCrlAuthentic({ crlDer, ark, now }); if (!a.ok) return { ok: false, checked: false, reasons: [a.why], detail: a.detail };
  return judgeCrl({ crl: a.crl, askSerialHex: ask.serialHex, now, mode, maxStaleDays });
}
// Hosted-format certificate binding (verifier/tls-binding.mjs checkHostedCertificate), the SAN decoding imported from it
export const hashAttestationDocument = async (doc) => toHex(await X.sha256(X.utf8(String(doc.format) + String(doc.body))));
export async function checkHostedCertificate({ certPem, host, doc, hpkeKeyHex, now = new Date() }) {
  const reasons = [], fail = (m) => ({ ok: false, reasons: [...reasons, m], claims: null });
  let cert; try { cert = await X.loadCertificate(X.pemToDer(certPem)); } catch (e) { return fail(`served certificate unparseable: ${e.message}`); }
  if (now < cert.notBefore || now > cert.notAfter) return fail(`served certificate not valid at ${now.toISOString()} (${cert.validFrom} .. ${cert.validTo})`);
  let sans; try { sans = X.dnsSans(cert); } catch (e) { return fail(`served certificate unparseable: ${e.message}`); }
  if (!host || !X.hostMatches(sans, host)) return fail(`served certificate is not valid for host ${JSON.stringify(host)}`);
  reasons.push(`served certificate names ${host}, valid ${cert.validFrom} .. ${cert.validTo}`);
  let hpke, hatt;
  try { hpke = toHex(decodeLabelledSans(sans, "hpke")); hatt = new TextDecoder().decode(decodeLabelledSans(sans, "hatt")); } catch (e) { return fail(`certificate SAN encoding: ${e.message}`); }
  if (!/^[0-9a-f]{64}$/.test(hpke)) return fail("certificate hpke SAN does not decode to 32 bytes");
  if (hpke !== hpkeKeyHex) return fail("certificate HPKE key differs from the key the report states in report_data[32:64]");
  reasons.push("certificate hpke SANs encode the HPKE key the report states");
  const want = await hashAttestationDocument(doc);
  if (hatt !== want) return fail("certificate hatt SANs do not encode sha256(format + body) of this document (a substituted document)");
  reasons.push("certificate hatt SANs bind this exact attestation document");
  return { ok: true, reasons, claims: { hpkePublicKey: hpke, attestationHash: want, tlsSpkiSha256: toHex(await X.sha256(cert.spki)), notAfter: cert.validTo } };
}

export const WEB_CRYPTO = Object.freeze({
  checkChain, checkCrl, verifyReportSignature: X.verifyReportSignature, sha256: X.sha256, checkHostedCertificate,
  certRaw: (c) => asBuffer(c.raw), certFp: (c) => c.fp256,
});
