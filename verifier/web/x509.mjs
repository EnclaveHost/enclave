// verifier/web/x509.mjs: X.509 for the browser build, on WebCrypto and a reviewed reader, for the AMD chain and the served
// certificate. The comparison behind the choice and its measurements: docs/security/browser-x509-parser-decision.md.
//
// Division of labour. verifier/der.mjs (strict, bounded) walks the certificate once and slices the bytes that are compared
// or signed: the whole TBSCertificate, the two AlgorithmIdentifiers, the issuer and subject Names, the SubjectPublicKeyInfo,
// the signature BIT STRING, the extensions. @freedomofpress/sigstore-browser's X509Certificate (already shipped same-origin
// for Sigstore provenance) decodes what deserves a reviewed decoder: distinguished names, key identifiers, key usage, basic
// constraints; the two readers are cross-checked on the names. WebCrypto verifies every signature: RSASSA-PSS with the
// parameters AMD's certificates state (SHA-384, MGF1 with SHA-384, salt 48; AMD 57230), parsed here and refused when
// different, never a library default; and ECDSA P-384 for the report. Nothing here decides policy: verifier/snp.mjs does,
// through verifier/web/provider.mjs, with the same code for both builds.
//
// Stricter than Node in three measured places, each a refusal and never an acceptance Node would not give (Node's OpenSSL
// accepts all of them, test/verifier-web-x509.test.mjs shows both sides): a non-minimal length, an indefinite length and
// trailing bytes are refused; the PSS parameters must be AMD's profile (Node verifies a certificate that honestly states
// another salt); the served certificate's host match uses exact and single-leftmost-wildcard DNS SANs only.
import { X509Certificate as ReviewedCertificate } from "@freedomofpress/sigstore-browser";
import { tlv, children, bytes, whole, oid, integer, time, toHex, equalBytes } from "../der.mjs";

const subtle = () => { const s = globalThis.crypto && globalThis.crypto.subtle; if (!s) throw new Error("WebCrypto (crypto.subtle) is not available"); return s; };
export const OID = Object.freeze({ rsaEncryption: "1.2.840.113549.1.1.1", rsassaPss: "1.2.840.113549.1.1.10", mgf1: "1.2.840.113549.1.1.8", sha384: "2.16.840.1.101.3.4.2.2",
  ecPublicKey: "1.2.840.10045.2.1", secp256r1: "1.2.840.10045.3.1.7", secp384r1: "1.3.132.0.34", secp521r1: "1.3.132.0.35", subjectAltName: "2.5.29.17" });
const CURVES = { [OID.secp256r1]: "P-256", [OID.secp384r1]: "P-384", [OID.secp521r1]: "P-521" };
const P384_N = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973");

export const concatBytes = (...parts) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
export const utf8 = (s) => new TextEncoder().encode(s);
export const latin1 = (b) => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
export const sha256 = async (...parts) => new Uint8Array(await subtle().digest("SHA-256", concatBytes(...parts.map((p) => new Uint8Array(p.buffer, p.byteOffset, p.byteLength)))));
export function base64ToBytes(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
export const pemToDer = (pem) => base64ToBytes(String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
export const pemCertificates = (pem) => String(pem).split(/(?=-----BEGIN CERTIFICATE-----)/).filter((s) => s.includes("CERTIFICATE")).map(pemToDer);

// OpenSSL's ASN1_TIME_print form ("Sep  3 04:05:06 2026 GMT"), which Node's validFrom/validTo carry, so both builds word a
// certificate window identically
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const opensslTime = (d) => { const z = (n) => String(n).padStart(2, "0"); return `${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())} ${d.getUTCFullYear()} GMT`; };

function parseSpki(der, node) {
  const [alg, bits] = children(der, node); if (!alg || !bits || alg.tag !== 0x30 || bits.tag !== 0x03) throw new Error("SubjectPublicKeyInfo shape");
  const [algOid, params] = children(der, alg); if (!algOid || algOid.tag !== 0x06) throw new Error("SubjectPublicKeyInfo algorithm");
  const id = oid(der, algOid), key = bytes(der, bits); if (!key.length || key[0] !== 0) throw new Error("SubjectPublicKeyInfo BIT STRING with unused bits");
  if (id === OID.rsaEncryption) {
    const pk = key.subarray(1), seq = tlv(pk, 0); if (seq.tag !== 0x30 || seq.end !== pk.length) throw new Error("RSAPublicKey shape");
    const [mod] = children(pk, seq); if (!mod || mod.tag !== 0x02) throw new Error("RSAPublicKey modulus");
    let m = bytes(pk, mod); while (m.length > 1 && m[0] === 0) m = m.subarray(1);
    let n = m.length * 8; for (let b = 0x80; b && !(m[0] & b); b >>= 1) n--;   // BN_num_bits, as Node's modulusLength
    return { type: "rsa", bits: n };
  }
  if (id === OID.ecPublicKey) { if (!params || params.tag !== 0x06) throw new Error("ecPublicKey without a named curve"); const c = oid(der, params); return { type: "ec", curve: CURVES[c] || null, curveOid: c }; }
  return { type: "other", oid: id };
}
// [3] EXPLICIT SEQUENCE OF Extension { extnID OID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING }
function parseExtensions(der, node) {
  const out = new Map(); if (!node) return out;
  const [seq] = children(der, node); if (!seq || seq.tag !== 0x30) throw new Error("extensions shape");
  for (const e of children(der, seq, 256)) {
    const k = children(der, e); if (k.length < 2 || k.length > 3 || k[0].tag !== 0x06 || k[k.length - 1].tag !== 0x04) throw new Error("extension shape");
    const id = oid(der, k[0]); if (out.has(id)) throw new Error(`duplicate extension ${id}`);
    out.set(id, { critical: k.length === 3 && k[1].tag === 0x01 && bytes(der, k[1])[0] !== 0, value: bytes(der, k[k.length - 1]) });
  }
  return out;
}

// parseCertificate(der) -> a plain record of the bytes and decoded fields the verifier compares. Synchronous, no crypto.
export function parseCertificate(der) {
  if (!(der instanceof Uint8Array) || der.length < 64 || der.length > 64 * 1024) throw new Error("not a bounded DER certificate");
  const top = tlv(der, 0); if (top.tag !== 0x30 || top.end !== der.length) throw new Error("not exactly one SEQUENCE (trailing or missing bytes)");
  const parts = children(der, top); if (parts.length !== 3) throw new Error("Certificate shape");
  const [tbs, sigAlg, sigVal] = parts; if (tbs.tag !== 0x30 || sigAlg.tag !== 0x30 || sigVal.tag !== 0x03) throw new Error("Certificate shape");
  const k = children(der, tbs); let i = 0;
  if (k[i] && k[i].tag === 0xa0) i++;
  const [serial, tbsSigAlg, issuer, validity, subject, spki] = k.slice(i, i + 6);
  if (!spki || serial.tag !== 0x02 || tbsSigAlg.tag !== 0x30 || issuer.tag !== 0x30 || validity.tag !== 0x30 || subject.tag !== 0x30 || spki.tag !== 0x30) throw new Error("TBSCertificate shape");
  const extNode = k.slice(i + 6).find((n) => n.tag === 0xa3);
  const [nb, na] = children(der, validity); if (!nb || !na) throw new Error("Validity shape");
  const notBefore = time(der, nb), notAfter = time(der, na);
  const sig = bytes(der, sigVal); if (!sig.length || sig[0] !== 0) throw new Error("signature BIT STRING with unused bits");
  let rv; try { rv = ReviewedCertificate.parse(der); } catch (e) { throw new Error(`reviewed reader: ${e.message}`); }
  if (!equalBytes(rv.issuer, bytes(der, issuer)) || !equalBytes(rv.subject, bytes(der, subject))) throw new Error("the two readers disagree on the names");
  const ku = rv.extKeyUsage, bc = rv.extBasicConstraints, akid = rv.extAuthorityKeyID, skid = rv.extSubjectKeyID;
  return {
    raw: der, tbs: whole(der, tbs), sigAlg: whole(der, sigAlg), tbsSigAlg: whole(der, tbsSigAlg), signature: sig.subarray(1),
    serialHex: integer(der, serial).toUpperCase(),   // OpenSSL BN_bn2hex form (byte-wise, leading zero bytes dropped), as Node's serialNumber
    subjectDer: whole(der, subject), issuerDer: whole(der, issuer), subjectCn: rv.subjectDN.get("CN") ?? null, issuerCn: rv.issuerDN.get("CN") ?? null,
    notBefore, notAfter, validFrom: opensslTime(notBefore), validTo: opensslTime(notAfter),
    spki: whole(der, spki), key: parseSpki(der, spki), extensions: parseExtensions(der, extNode),
    akid: akid ? (akid.keyIdentifier || null) : null, skid: skid ? (skid.keyIdentifier || null) : null,
    keyUsage: ku ? { keyCertSign: !!ku.keyCertSign, critical: !!ku.critical } : null, isCA: bc ? !!bc.isCA : null,
    fp256: null,
  };
}
export async function loadCertificate(der) { const c = parseCertificate(der); c.fp256 = toHex(await sha256(der)); return c; }

// AMD's signature profile as RSASSA-PSS-params (RFC 4055 3.1): hashAlgorithm [0] SHA-384, maskGenAlgorithm [1] MGF1 with
// SHA-384, saltLength [2] 48, trailerField [3] absent (the DER default, what OpenSSL writes) or explicitly 1 (what AMD writes).
export function amdPssProfileError(algDer) {
  try {
    const top = tlv(algDer, 0); if (top.tag !== 0x30 || top.end !== algDer.length) return "AlgorithmIdentifier shape";
    const [id, params] = children(algDer, top); if (!id || id.tag !== 0x06 || oid(algDer, id) !== OID.rsassaPss) return "signature algorithm is not RSASSA-PSS";
    if (!params || params.tag !== 0x30) return "RSASSA-PSS without parameters";
    const f = {}; for (const n of children(algDer, params)) { if (f[n.tag]) return "PSS parameters repeat a field"; f[n.tag] = n; }
    for (const t of Object.keys(f)) if (![0xa0, 0xa1, 0xa2, 0xa3].includes(+t)) return "PSS parameters carry an unknown field";
    const inner = (t) => (f[t] ? children(algDer, f[t])[0] : null), algId = (n) => (n && n.tag === 0x30 ? oid(algDer, children(algDer, n)[0]) : null);
    const hashAlg = inner(0xa0), mgf = inner(0xa1), salt = inner(0xa2), trailer = inner(0xa3);
    if (algId(hashAlg) !== OID.sha384) return "PSS hash is not SHA-384";
    if (algId(mgf) !== OID.mgf1) return "PSS mask generation is not MGF1";
    if (algId(children(algDer, mgf)[1]) !== OID.sha384) return "PSS MGF1 hash is not SHA-384";
    if (!salt || salt.tag !== 0x02 || integer(algDer, salt) !== "30") return "PSS salt length is not 48";
    if (f[0xa3] && (!trailer || trailer.tag !== 0x02 || integer(algDer, trailer) !== "01")) return "PSS trailer field is not 1";
    return null;
  } catch (e) { return `PSS parameters unreadable: ${e.message}`; }
}
export function amdSignatureProfileError(cert) {
  if (!equalBytes(cert.sigAlg, cert.tbsSigAlg)) return "the certificate's two AlgorithmIdentifiers differ (RFC 5280 4.1.1.2)";
  return amdPssProfileError(cert.sigAlg);
}
// OpenSSL X509_check_issued, the parts these certificates carry: names, AKID against SKID when both are present, the
// issuer's key usage when present. Returns null when issued, else why not.
export function issuedError(cert, issuer) {
  if (!equalBytes(cert.issuerDer, issuer.subjectDer)) return "issuer name is not the issuer certificate's subject";
  if (cert.akid && issuer.skid && !equalBytes(cert.akid, issuer.skid)) return "authority key identifier is not the issuer's subject key identifier";
  if (issuer.keyUsage && !issuer.keyUsage.keyCertSign) return "issuer key usage does not include keyCertSign";
  return null;
}
async function pssVerify(issuer, signature, signed) {
  if (issuer.key.type !== "rsa") return { ok: false, why: "issuer key is not RSA (the signature is RSASSA-PSS)" };
  let key; try { key = await subtle().importKey("spki", issuer.spki, { name: "RSA-PSS", hash: "SHA-384" }, false, ["verify"]); } catch (e) { return { ok: false, why: `issuer key import: ${e.message}` }; }
  const ok = await subtle().verify({ name: "RSA-PSS", saltLength: 48 }, key, signature, signed);
  return { ok, why: ok ? null : "signature does not verify" };
}
// The certificate's signature by the issuer's key, under AMD's profile only. { ok, why }
export async function verifyCertificateSignature(cert, issuer) {
  const prof = amdSignatureProfileError(cert); if (prof) return { ok: false, why: prof };
  return pssVerify(issuer, cert.signature, cert.tbs);
}
// A parsed CRL's (verifier/der.mjs parseCrl) signature by the ARK, under AMD's profile only. { ok, why }
export async function verifyCrlSignature(crl, ark) {
  if (!equalBytes(crl.sigAlgDer, crl.tbsSigAlgDer)) return { ok: false, why: "the CRL's two AlgorithmIdentifiers differ (RFC 5280 5.1.1.2)" };
  const prof = amdPssProfileError(crl.sigAlgDer); if (prof) return { ok: false, why: prof };
  return pssVerify(ark, crl.signature, crl.tbsDer);
}
// The PSP's ECDSA P-384 signature over the report's signed region, with the VCEK's key. Same words as verifier/snp.mjs.
export async function verifyReportSignature(p, vcek) {
  const rBE = Uint8Array.from(p.signature.subarray(0, 48)).reverse(), sBE = Uint8Array.from(p.signature.subarray(0x48, 0x48 + 48)).reverse();
  const R = BigInt("0x" + toHex(rBE)), S = BigInt("0x" + toHex(sBE));
  if (R === 0n || R >= P384_N || S === 0n || S >= P384_N) return { ok: false, why: "signature r or s is out of range for P-384" };
  if (vcek.key.type !== "ec" || vcek.key.curve !== "P-384") return { ok: false, why: "VCEK public key is not EC P-384" };
  let ok = false;
  try {
    const key = await subtle().importKey("spki", vcek.spki, { name: "ECDSA", namedCurve: "P-384" }, false, ["verify"]);
    ok = await subtle().verify({ name: "ECDSA", hash: "SHA-384" }, key, concatBytes(rBE, sBE), p.signedRegion);
  } catch (e) { return { ok: false, why: `signature check error: ${e.message}` }; }
  return { ok, why: ok ? null : "VCEK signature over the report is invalid" };
}

// The served certificate's DNS names (GeneralName [2] dNSName), and the host rule: exact, or one leftmost wildcard label
// standing for exactly one label with at least two labels after it. Lowercase ASCII only. No CN fallback.
export function dnsSans(cert) {
  const ext = cert.extensions.get(OID.subjectAltName); if (!ext) return [];
  const v = ext.value, top = tlv(v, 0); if (top.tag !== 0x30 || top.end !== v.length) throw new Error("subjectAltName shape");
  return children(v, top, 1024).filter((n) => n.tag === 0x82).map((n) => latin1(bytes(v, n)));
}
export function hostMatches(sans, host) {
  if (typeof host !== "string" || !host || host.length > 253 || !/^[a-z0-9.-]+$/i.test(host) || host.startsWith(".") || host.endsWith(".")) return false;
  const h = host.toLowerCase(), rest = h.slice(h.indexOf(".") + 1);
  for (const san of sans) {
    const s = String(san).toLowerCase();
    if (s === h) return true;
    if (s.startsWith("*.") && !s.slice(2).includes("*") && h.includes(".") && s.slice(2).split(".").length >= 2 && s.slice(2) === rest) return true;
  }
  return false;
}
