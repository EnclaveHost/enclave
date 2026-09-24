// verifier/der.mjs: a bounded DER reader, just enough for an X.509 CRL (RFC 5280 section 5) and the
// SubjectPublicKeyInfo of a PEM certificate. Not a general ASN.1 library: every length is checked against
// its parent, indefinite lengths and long tags are refused, and nothing here interprets cryptography.
// Node's X509Certificate covers certificates; it has no CRL type, so the CRL is read here and its
// signature is checked by node:crypto (verifier/snp.mjs checkCrl).

export function tlv(b, off, limit = b.length) {
  if (!Number.isSafeInteger(off) || off < 0 || off + 2 > limit || limit > b.length) throw new Error("DER truncated");
  const tag = b[off];
  if ((tag & 0x1f) === 0x1f) throw new Error("DER long-form tag unsupported");
  let len = b[off + 1], p = off + 2;
  if (len === 0x80) throw new Error("DER indefinite length refused");
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4 || p + n > limit) throw new Error("DER length form");
    if (b[p] === 0) throw new Error("DER non-minimal length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[p++];
    if (len < 0x80) throw new Error("DER non-minimal length");
  }
  if (p + len > limit) throw new Error("DER element overruns its parent");
  return { tag, start: p, end: p + len, hdr: off };
}
export function children(b, node, cap = 4096) {
  if (!(node.tag & 0x20)) throw new Error("DER parent is not constructed");
  const out = []; let p = node.start;
  while (p < node.end) { if (out.length >= cap) throw new Error("DER: too many children"); const c = tlv(b, p, node.end); out.push(c); p = c.end; }
  return out;
}
export const bytes = (b, n) => b.subarray(n.start, n.end);
export const whole = (b, n) => b.subarray(n.hdr, n.end);   // header + body, for re-hashing tbs

export function oid(b, n) {
  const v = bytes(b, n); if (!v.length) throw new Error("empty OID");
  const parts = [Math.floor(v[0] / 40), v[0] % 40];
  for (let i = 1, x = 0; i < v.length; i++) { x = x * 128 + (v[i] & 0x7f); if (!(v[i] & 0x80)) { parts.push(x); x = 0; } }
  return parts.join(".");
}
export function integer(b, n) {   // non-negative, as hex without leading zero bytes (serial numbers)
  if (n.tag !== 0x02) throw new Error("DER: not an INTEGER");
  let v = bytes(b, n); if (!v.length) throw new Error("DER: empty INTEGER");
  if (v[0] & 0x80) throw new Error("DER: negative INTEGER where a serial was expected");
  while (v.length > 1 && v[0] === 0) v = v.subarray(1);
  return v.toString("hex");
}
// UTCTime (YYMMDDHHMMSSZ, RFC 5280: 1950..2049) or GeneralizedTime (YYYYMMDDHHMMSSZ), Z only
export function time(b, n) {
  const s = bytes(b, n).toString("latin1");
  let m;
  if (n.tag === 0x17 && (m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    const yy = +m[1]; return new Date(Date.UTC(yy >= 50 ? 1900 + yy : 2000 + yy, +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }
  if (n.tag === 0x18 && (m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)))
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  throw new Error(`DER: unsupported time ${JSON.stringify(s)} (tag 0x${n.tag.toString(16)})`);
}

// CertificateList ::= SEQUENCE { tbsCertList, signatureAlgorithm, signatureValue BIT STRING }
// TBSCertList ::= SEQUENCE { version INTEGER OPTIONAL, signature, issuer, thisUpdate, nextUpdate OPTIONAL,
//                            revokedCertificates SEQUENCE OF { userCertificate, revocationDate, ... } OPTIONAL,
//                            crlExtensions [0] OPTIONAL }
export function parseCrl(der, { maxRevoked = 4096 } = {}) {
  if (!Buffer.isBuffer(der) || der.length < 8 || der.length > 1 << 20) throw new Error("CRL: not a bounded DER buffer");
  const top = tlv(der, 0); if (top.tag !== 0x30 || top.end !== der.length) throw new Error("CRL: not one SEQUENCE");
  const [tbs, sigAlg, sigVal] = children(der, top);
  if (!tbs || !sigAlg || !sigVal || sigVal.tag !== 0x03) throw new Error("CRL: shape");
  const k = children(der, tbs); let i = 0;
  const version = k[i].tag === 0x02 ? (i++, integer(der, k[i - 1])) : "00";
  const algOid = oid(der, children(der, k[i++])[0]);
  const issuer = k[i++];                              // Name, compared by DER bytes to the issuer certificate's subject
  const thisUpdate = time(der, k[i++]);
  let nextUpdate = null;
  if (k[i] && (k[i].tag === 0x17 || k[i].tag === 0x18)) nextUpdate = time(der, k[i++]);
  const revoked = [];
  if (k[i] && k[i].tag === 0x30) {
    for (const e of children(der, k[i], maxRevoked)) { const [serial, date] = children(der, e); revoked.push({ serial: integer(der, serial), date: time(der, date) }); }
    i++;
  }
  const sig = bytes(der, sigVal); if (sig[0] !== 0) throw new Error("CRL: BIT STRING with unused bits");
  return { version, algOid, issuerDer: whole(der, issuer), thisUpdate, nextUpdate, revoked, tbsDer: whole(der, tbs), signature: sig.subarray(1),
           sigAlgIsRsaPss: algOid === "1.2.840.113549.1.1.10" };
}

// The subject Name of a certificate, as DER, so a CRL issuer can be compared byte for byte.
export function subjectNameDer(certDer) {
  const tbs = children(certDer, tlv(certDer, 0))[0];
  const k = children(certDer, tbs); let i = 0;
  if (k[0].tag === 0xa0) i++;         // [0] version
  i++;                                // serial
  i++;                                // signature alg
  i++;                                // issuer
  i++;                                // validity
  return whole(certDer, k[i]);        // subject
}
