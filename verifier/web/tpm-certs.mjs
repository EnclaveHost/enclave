// verifier/web/tpm-certs.mjs: the TPM endorsement-key certificate chain, in the browser. The relay checks it with Node's
// X509Certificate (relay/vbs-verify.mjs loadTpmRoots / verifyEkChain); this is the same walk, the same order and the same
// reason strings, on verifier/der.mjs (strict, bounded) and WebCrypto. The site's own pins are TPM_EK_ROOTS_PEM below.
//
// Why not verifier/web/x509.mjs's parseCertificate: its reviewed name reader (Sigstore's) refuses AMD's fTPM EK
// certificates (an empty subject Name and a TCG directoryName SAN), and those are exactly the certificates this walks. The
// slicing is the same verifier/der.mjs, and the issuer rule is x509.mjs's issuedError (OpenSSL X509_check_issued: names,
// AKID against SKID, the issuer's keyCertSign); the few fields that rule and Node's `ca` need are decoded here.
//
// Stricter than Node, each a refusal Node would not give and never an acceptance it would refuse: non-minimal and
// indefinite DER lengths, a certificate whose two AlgorithmIdentifiers differ, and any signature algorithm but
// sha{256,384,512}WithRSAEncryption and ecdsa-with-SHA{256,384,512} over P-256/P-384/P-521 (no RSA-PSS, no SHA-1).
import { sha256 } from "@noble/hashes/sha2";
import { tlv, children, bytes, whole, oid, integer, time, toHex, equalBytes } from "../der.mjs";
import { parseSpki, parseExtensions, issuedError, opensslTime, pemCertificates } from "./x509.mjs";

// The pinned TPM endorsement-key roots, embedded: relay/fixtures/tpm-roots.pem's certificates, byte for byte
// (test/verifier-web-shield-host.test.mjs holds them equal). Self-signed entries are the anchors, the rest intermediates a
// node may omit, exactly as the relay reads that bundle. AMD's fTPM chain only; an Intel root joins when the relay pins one.
//   CN=AMDTPM  (root, 2014-10-23 .. 2039-10-23)          sha256 67bd2472a546751caca5f358a78f80727531671338960a9bcfdfbe6a34d0c6a1
//   CN=PRG-HPT (intermediate, 2023-01-01 .. 2048-01-01)  sha256 1745706c9e0163b128166cfa3875c9b675423e7097d8eecd73a88d1b22950cd9
export const TPM_EK_ROOT_PINS = Object.freeze(["67bd2472a546751caca5f358a78f80727531671338960a9bcfdfbe6a34d0c6a1"]);
export const TPM_EK_ROOTS_PEM = `-----BEGIN CERTIFICATE-----
MIIEjDCCA3SgAwIBAgIQJk05ojzrXVtJ1hAETuvRITANBgkqhkiG9w0BAQsFADB2
MRQwEgYDVQQLDAtFbmdpbmVlcmluZzELMAkGA1UEBhMCVVMxEjAQBgNVBAcMCVN1
bm55dmFsZTELMAkGA1UECAwCQ0ExHzAdBgNVBAoMFkFkdmFuY2VkIE1pY3JvIERl
dmljZXMxDzANBgNVBAMMBkFNRFRQTTAiGA8yMDE0MTAyMzE0MzQzMloYDzIwMzkx
MDIzMTQzNDMyWjB2MRQwEgYDVQQLDAtFbmdpbmVlcmluZzELMAkGA1UEBhMCVVMx
EjAQBgNVBAcMCVN1bm55dmFsZTELMAkGA1UECAwCQ0ExHzAdBgNVBAoMFkFkdmFu
Y2VkIE1pY3JvIERldmljZXMxDzANBgNVBAMMBkFNRFRQTTCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBALLJzgGLuZ0X5UJNG1bbExXC0gDMfaHWeBMt5+vz
AOhQ+wxAiBO9ERmYGkSCA9Hm/ncl985zK6dU0vpQ/hiUsO8gyaynlOIrfHDC6ha6
hpuEhMf1+RgWtdbE5i+IutKSeZw6Nk+vToifoqmM4AX2CS6h0GnkkTemwWMp98NR
+CTczwzb6ih75D32HsB41ABSQCNXUoWDvERJzQgfHnqJY9++Z8pnwAGc4APL+85h
V/9bVSwsuzJup+853U+OdkwdZnpPSwuS5MJZ8gAcGjdkPC1eDVqSAM04K+ecW1OV
b4HCKcPv6nG2B5qi+mcwknhNYESkF5bMmyvluKYQrUHzIB0CAwEAAaOCARAwggEM
MA4GA1UdDwEB/wQEAwIBBjAjBgkrBgEEAYI3FSsEFgQUV4xUX3lpUUISIaSleKzb
X2gvicgwHQYDVR0OBBYEFFeMVF95aVFCEiGkpXis219oL4nIMA8GA1UdEwEB/wQF
MAMBAf8wOAYIKwYBBQUHAQEELDAqMCgGCCsGAQUFBzABhhxodHRwOi8vZnRwbS5h
bWQuY29tL3BraS9vY3NwMCwGA1UdHwQlMCMwIaAfoB2GG2h0dHA6Ly9mdHBtLmFt
ZC5jb20vcGtpL2NybDA9BgNVHSAENjA0MDIGBFUdIAAwKjAoBggrBgEFBQcCARYc
aHR0cHM6Ly9mdHBtLmFtZC5jb20vcGtpL2NwczANBgkqhkiG9w0BAQsFAAOCAQEA
EYk2axIzYPg4eCyUFk3phQW4lUhIJrmhrZRNQ/vMNd0Ao34SgORF6af8XW2xVnwE
iNMJ4kOSeehJnsuuixB4NXf4XRift1UESoqQLOMzlgQTcAoXIqzPxqG28aApOiAn
Vt7v6YJqcXRf4WfQI8EnOuCydl3a5OhlM2uEoy/GWHqvWoMuh1/j5/L8aWCacwGw
hz/uL0I64lUSLLoTZFdBIJ9r2RDiEqxsb7MbgtLOqeZFWfVITasTbcno8+rIOmn/
860bTAfKuQWVIMKyHV/rElwa7A0d75Nl+p6BEMDxAs/bLq10PaGSxao8iGWiCihm
tgzAbWXJ0VoaLTb3eZw+Rg==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIFBDCCA+ygAwIBAgIQC3+DOgDRW+tGuhjM424CRDANBgkqhkiG9w0BAQsFADB2
MRQwEgYDVQQLDAtFbmdpbmVlcmluZzELMAkGA1UEBhMCVVMxEjAQBgNVBAcMCVN1
bm55dmFsZTELMAkGA1UECAwCQ0ExHzAdBgNVBAoMFkFkdmFuY2VkIE1pY3JvIERl
dmljZXMxDzANBgNVBAMMBkFNRFRQTTAiGA8yMDIzMDEwMTA1MDAwMFoYDzIwNDgw
MTAxMDUwMDAwWjB5MRQwEgYDVQQLDAtFbmdpbmVlcmluZzELMAkGA1UEBhMCVVMx
FDASBgNVBAcMC1NhbnRhIENsYXJhMQswCQYDVQQIDAJDQTEfMB0GA1UECgwWQWR2
YW5jZWQgTWljcm8gRGV2aWNlczEQMA4GA1UEAwwHUFJHLUhQVDCCASIwDQYJKoZI
hvcNAQEBBQADggEPADCCAQoCggEBALr4oxwgDyqCt6BemboPYDR/uxjWZIrebuC8
Vu+Nm36PsDlmVkQycFqmKm6sSb4R8/fgkL/NBozoIucvCcJeh0jpPNzOZZFSwfHr
z7sCdToJqe1KKVRJdWYDGQ2acOpVSyrsltDZ119H0iCDHuxhtbOMatXU9CEHRiWr
DBYOPyBtqhvEPGTBicrxUXTWNEattaoc6bMaPwINs3AQ+W+vqg7bmmdzAnCaeO8B
1cizRo5P196q/Ja4/PiU0om/IKPOHHltTQvx5HCvuhT/qx5o3XWHzZtp9b08Dum3
R/BR6pkhVpCTmyRGoAgCb91jcLhfaHiv/7j1JDkbHJ1aklSIKocCAwEAAaOCAYUw
ggGBMA4GA1UdDwEB/wQEAwIBBjAjBgkrBgEEAYI3FSsEFgQUbV/Ix0F2UY5tXz8W
Jg0Ej27qd9AwgYIGCCsGAQUFBwEBBHYwdDBIBggrBgEFBQcwAoY8aHR0cDovL2Z0
cG0uYW1kLmNvbS9wa2kvYWlhLzI2NEQzOUEyM0NFQjVENUI0OUQ2MTAwNDRFRUJE
MTIxMCgGCCsGAQUFBzABhhxodHRwOi8vZnRwbS5hbWQuY29tL3BraS9vY3NwMCwG
A1UdHwQlMCMwIaAfoB2GG2h0dHA6Ly9mdHBtLmFtZC5jb20vcGtpL2NybDBDBgNV
HSAEPDA6MDgGCisGAQQBnHhlFQowKjAoBggrBgEFBQcCARYcaHR0cHM6Ly9mdHBt
LmFtZC5jb20vcGtpL2NwczAdBgNVHQ4EFgQUbV/Ix0F2UY5tXz8WJg0Ej27qd9Aw
HwYDVR0jBBgwFoAUV4xUX3lpUUISIaSleKzbX2gvicgwEgYDVR0TAQH/BAgwBgEB
/wIBADANBgkqhkiG9w0BAQsFAAOCAQEAMQq8z58kbw4eQ2ue2cFcfhxXk/vyrUVC
0BQETkusBwtkku5MO+5dVFU7vo8MdM2AgZnnLE3SxFMThroGFqL6vMxQVxv97XxX
3wvK2PCAjX7XIe8BVZuSeka9I6MOgPegd7VGpzFUM+ZeXaqqW+qNucZfIKoStz2T
EPenqsYHy/S7I9uazweix7Sa9P6fndAgw8AvlaIxtcDR7wK0VvnSSQP376dxYZZ7
UFOqm7jAKOnH6K9hwk7EyecBnVDD59hi5sDUH2rcfaMxIvZ60w+LEognktDkw2cr
YYYOpxF2m1V0tRX4DJqHMF179L7jVnoIWV0+W6NcuK066LjPqzC0dQ==
-----END CERTIFICATE-----
`;

const subtle = () => { const s = globalThis.crypto && globalThis.crypto.subtle; if (!s) throw new Error("WebCrypto (crypto.subtle) is not available"); return s; };
const MAX_CERT_BYTES = 64 * 1024, MAX_CHAIN_CERTS = 8;   // relay/vbs-tpm.mjs VBS_MAX_CERT_BYTES / VBS_MAX_CHAIN_CERTS
const OID_EXT = { keyUsage: "2.5.29.15", basicConstraints: "2.5.29.19", subjectKeyId: "2.5.29.14", authorityKeyId: "2.5.29.35" };
// the certificate signature algorithms this build verifies (RFC 4055, RFC 5758), and with what
const SIG_ALGS = {
  "1.2.840.113549.1.1.11": { kind: "rsa", hash: "SHA-256" }, "1.2.840.113549.1.1.12": { kind: "rsa", hash: "SHA-384" }, "1.2.840.113549.1.1.13": { kind: "rsa", hash: "SHA-512" },
  "1.2.840.10045.4.3.2": { kind: "ec", hash: "SHA-256" }, "1.2.840.10045.4.3.3": { kind: "ec", hash: "SHA-384" }, "1.2.840.10045.4.3.4": { kind: "ec", hash: "SHA-512" },
};
const EC_SIZE = { "P-256": 32, "P-384": 48, "P-521": 66 };
// the attribute names OpenSSL prints for the names these certificates carry, so a reason reads as Node's does
const DN = { "2.5.4.3": "CN", "2.5.4.5": "serialNumber", "2.5.4.6": "C", "2.5.4.7": "L", "2.5.4.8": "ST", "2.5.4.10": "O", "2.5.4.11": "OU", "1.2.840.113549.1.9.1": "emailAddress" };
const utf8 = (b) => new TextDecoder("utf-8", { fatal: false }).decode(b);

// Name -> "OU=Engineering, C=US, ..." in certificate order (Node's subject with its newlines as ", "), "" for an empty Name
function nameText(der, node) {
  const out = [];
  for (const rdn of children(der, node, 64)) for (const atv of children(der, rdn, 16)) {
    const [k, v] = children(der, atv); if (!k || !v || k.tag !== 0x06) throw new Error("Name attribute shape");
    const id = oid(der, k); out.push(`${DN[id] || id}=${utf8(bytes(der, v))}`);
  }
  return out.join(", ");
}

// parseTpmCertificate(der) -> the fields the chain walk compares (the shape x509.mjs's issuedError reads), synchronous
export function parseTpmCertificate(der) {
  if (!(der instanceof Uint8Array) || der.length < 64 || der.length > MAX_CERT_BYTES) throw new Error("not a bounded DER certificate");
  const top = tlv(der, 0); if (top.tag !== 0x30 || top.end !== der.length) throw new Error("not exactly one SEQUENCE (trailing or missing bytes)");
  const parts = children(der, top); if (parts.length !== 3) throw new Error("Certificate shape");
  const [tbs, sigAlg, sigVal] = parts; if (tbs.tag !== 0x30 || sigAlg.tag !== 0x30 || sigVal.tag !== 0x03) throw new Error("Certificate shape");
  const k = children(der, tbs); let i = 0;
  if (k[i] && k[i].tag === 0xa0) i++;
  const [serial, tbsSigAlg, issuer, validity, subject, spki] = k.slice(i, i + 6);
  if (!spki || serial.tag !== 0x02 || tbsSigAlg.tag !== 0x30 || issuer.tag !== 0x30 || validity.tag !== 0x30 || subject.tag !== 0x30 || spki.tag !== 0x30) throw new Error("TBSCertificate shape");
  const [nb, na] = children(der, validity); if (!nb || !na) throw new Error("Validity shape");
  const notBefore = time(der, nb), notAfter = time(der, na);
  const sig = bytes(der, sigVal); if (!sig.length || sig[0] !== 0) throw new Error("signature BIT STRING with unused bits");
  const algId = children(der, sigAlg)[0]; if (!algId || algId.tag !== 0x06) throw new Error("signature AlgorithmIdentifier shape");
  const extensions = parseExtensions(der, k.slice(i + 6).find((n) => n.tag === 0xa3));
  const ext = (id) => extensions.get(id)?.value ?? null;
  // keyUsage BIT STRING: keyCertSign is bit 5 (0x04 of the first content byte)
  const ku = ext(OID_EXT.keyUsage); let keyUsage = null;
  if (ku) { const n = tlv(ku, 0); if (n.tag !== 0x03 || n.end !== ku.length) throw new Error("keyUsage shape"); const v = bytes(ku, n); keyUsage = { keyCertSign: v.length > 1 && !!(v[1] & 0x04) }; }
  // basicConstraints SEQUENCE { cA BOOLEAN DEFAULT FALSE, pathLenConstraint INTEGER OPTIONAL }
  const bc = ext(OID_EXT.basicConstraints); let isCA = null;
  if (bc) { const n = tlv(bc, 0); if (n.tag !== 0x30 || n.end !== bc.length) throw new Error("basicConstraints shape"); const c = children(bc, n); isCA = !!(c[0] && c[0].tag === 0x01 && bytes(bc, c[0])[0] !== 0); }
  const sk = ext(OID_EXT.subjectKeyId); let skid = null;
  if (sk) { const n = tlv(sk, 0); if (n.tag !== 0x04 || n.end !== sk.length) throw new Error("subjectKeyIdentifier shape"); skid = bytes(sk, n); }
  const ak = ext(OID_EXT.authorityKeyId); let akid = null;
  if (ak) { const n = tlv(ak, 0); if (n.tag !== 0x30 || n.end !== ak.length) throw new Error("authorityKeyIdentifier shape"); const id = children(ak, n).find((c) => c.tag === 0x80); akid = id ? bytes(ak, id) : null; }
  return {
    raw: der, tbs: whole(der, tbs), sigAlg: whole(der, sigAlg), tbsSigAlg: whole(der, tbsSigAlg), sigAlgOid: oid(der, algId), signature: sig.subarray(1),
    serialHex: integer(der, serial).toUpperCase(), subjectDer: whole(der, subject), issuerDer: whole(der, issuer), subject: nameText(der, subject), issuer: nameText(der, issuer),
    notBefore, notAfter, validFrom: opensslTime(notBefore), validTo: opensslTime(notAfter), spki: whole(der, spki), key: parseSpki(der, spki), extensions,
    akid, skid, keyUsage,
    // Node's X509Certificate.ca: OpenSSL X509_check_ca() == 1, i.e. basicConstraints cA and, when keyUsage is present, keyCertSign
    ca: isCA === true && (!keyUsage || keyUsage.keyCertSign),
    fp256: toHex(sha256(der)),
  };
}

// ECDSA-Sig-Value SEQUENCE { r INTEGER, s INTEGER } -> r || s, each left-padded to the curve size (WebCrypto's form)
function ecdsaRaw(sig, size) {
  const top = tlv(sig, 0); if (top.tag !== 0x30 || top.end !== sig.length) throw new Error("ECDSA signature shape");
  const rs = children(sig, top); if (rs.length !== 2 || rs.some((n) => n.tag !== 0x02)) throw new Error("ECDSA signature shape");
  const out = new Uint8Array(2 * size);
  rs.forEach((n, j) => { let v = bytes(sig, n); while (v.length > 1 && v[0] === 0) v = v.subarray(1); if (v.length > size) throw new Error("ECDSA integer too long"); out.set(v, (j + 1) * size - v.length); });
  return out;
}
// Is `cert` signed by `issuer`'s key? (Node: cert.verify(issuer.publicKey)) A false for anything this build does not verify.
export async function certSignedBy(cert, issuer) {
  try {
    if (!equalBytes(cert.sigAlg, cert.tbsSigAlg)) return false;
    const alg = SIG_ALGS[cert.sigAlgOid]; if (!alg || alg.kind !== issuer.key.type) return false;
    if (alg.kind === "rsa") {
      const key = await subtle().importKey("spki", issuer.spki, { name: "RSASSA-PKCS1-v1_5", hash: alg.hash }, false, ["verify"]);
      return await subtle().verify({ name: "RSASSA-PKCS1-v1_5" }, key, cert.signature, cert.tbs);
    }
    const size = EC_SIZE[issuer.key.curve]; if (!size) return false;
    const key = await subtle().importKey("spki", issuer.spki, { name: "ECDSA", namedCurve: issuer.key.curve }, false, ["verify"]);
    return await subtle().verify({ name: "ECDSA", hash: alg.hash }, key, ecdsaRaw(cert.signature, size), cert.tbs);
  } catch { return false; }
}
const issuedBy = async (cert, issuer) => !issuedError(cert, issuer) && (await certSignedBy(cert, issuer));

// relay/vbs-verify.mjs loadTpmRoots: a PEM bundle (or DER certificates) -> { roots, intermediates, pins }; its self-signed
// certificates are the trust anchors, anything else in it an intermediate the node may have omitted (AMD's PRG-HPT).
export async function loadTpmRootsWeb(source) {
  const ders = typeof source === "string" ? (source.includes("-----BEGIN") ? pemCertificates(source) : (() => { throw new Error("a TPM root bundle must be PEM text in the browser (no files)"); })())
             : Array.isArray(source) ? source.map((d) => (d instanceof Uint8Array ? d : new Uint8Array(d))) : [];
  const certs = ders.map(parseTpmCertificate), roots = [];
  for (const c of certs) if (await issuedBy(c, c)) roots.push(c);
  return { roots, intermediates: certs.filter((c) => !roots.includes(c)), pins: roots.map((c) => c.fp256) };
}

// relay/vbs-verify.mjs verifyEkChain, step for step: leaf -> (supplied or bundled intermediates) -> a root whose sha256 is
// pinned; then every certificate on the path in its window, and every one above the leaf a CA. { ok, reason?, root?, path? }
export async function verifyEkChainWeb(leaf, extra, trust, now = Date.now()) {
  const pool = [...extra, ...trust.intermediates];
  const path = [leaf];
  for (let hops = 0; hops < MAX_CHAIN_CERTS; hops++) {
    const cur = path[path.length - 1];
    let root = null;
    for (const r of trust.roots) if (await issuedBy(cur, r)) { root = r; break; }
    if (root) {
      if (!trust.pins.includes(root.fp256)) return { ok: false, reason: `EK chain root ${root.fp256} is not a pinned TPM root` };
      path.push(root);
      for (const [i, c] of path.entries()) {
        if (!(c.notBefore <= now)) return { ok: false, reason: `EK chain cert ${i} not yet valid (${c.validFrom})` };
        if (!(now <= c.notAfter)) return { ok: false, reason: `EK chain cert ${i} expired (${c.validTo})` };
        if (i > 0 && !c.ca) return { ok: false, reason: `EK chain cert ${i} is not a CA` };
      }
      return { ok: true, root, path };
    }
    let issuer = null;
    for (const c of pool) if (!path.includes(c) && c.ca && (await issuedBy(cur, c))) { issuer = c; break; }
    if (!issuer) return { ok: false, reason: `EK chain breaks at "${cur.subject || "(empty subject)"}" <- ${cur.issuer}: no issuer among the supplied or bundled intermediates and no pinned root` };
    path.push(issuer);
  }
  return { ok: false, reason: "EK chain too long" };
}
