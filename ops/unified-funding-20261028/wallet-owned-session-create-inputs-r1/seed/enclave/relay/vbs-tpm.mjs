// relay/vbs-tpm.mjs — the crypto-free half of vbs-verify.mjs: TPM 2.0 constants and structures (TPMT_PUBLIC,
// TPMS_ATTEST, the TPM name), the EK certificate's tcg-at-tpmManufacturer, the boot-state policy constants and the
// admission caps. No node:crypto, no fs, no process: the relay's verifiers (vbs-verify.mjs, hvnode-verify.mjs) and the
// browser build (verifier/web/shield-host.mjs) import the same parsers, so a structure is read one way everywhere. Where a
// digest is needed (the TPM name) the caller passes its sha256. Buffer is Node's, or the `buffer` package's in a bundle.

// AMD's fTPM EK root (CN=AMDTPM, 2014-2039), the anchor relay/fixtures/tpm-roots.pem
// ships. Pinned by value here so the test can assert the bundle matches what the
// verifier will accept; an Intel root joins this table when one is added.
export const AMD_FTPM_ROOT_SHA256 = "67bd2472a546751caca5f358a78f80727531671338960a9bcfdfbe6a34d0c6a1";
// TCG EK credential profile: tcg-at-tpmManufacturer (2.23.133.2.1) "id:" + the
// TCG vendor id. On-die firmware TPMs only (EVIDENCE.md check 1).
export const TPM_MANUFACTURERS_ON_DIE = { "414D4400": "AMD", "494E5443": "Intel" };
const OID_SAN = "2.5.29.17", OID_TPM_MANUFACTURER = "2.23.133.2.1";

// TPM 2.0 constants (Part 2)
export const TPM_GENERATED_VALUE = 0xff544347, TPM_ST_ATTEST_QUOTE = 0x8018;
export const TPM_ALG_RSA = 0x0001, TPM_ALG_SHA256 = 0x000b, TPM_ALG_NULL = 0x0010, TPM_ALG_AES = 0x0006, TPM_ALG_CFB = 0x0043, TPM_ALG_RSASSA = 0x0014;
// TPMA_OBJECT: fixedTPM|fixedParent|sensitiveDataOrigin|userWithAuth|restricted|sign
export const AIK_REQUIRED_ATTRIBUTES = 0x00050072, TPMA_DECRYPT = 0x00020000;

// Admission caps (a relay reading bytes off a socket), not format claims.
export const VBS_MAX_REPORT_BYTES = 64 * 1024, VBS_MAX_LOG_BYTES = 4 * 1024 * 1024, VBS_MAX_CERT_BYTES = 64 * 1024, VBS_MAX_CHAIN_CERTS = 8;
export const VBS_MAX_ATTEST_BYTES = 4096, VBS_MAX_SIG_BYTES = 1024, VBS_MAX_TPMT_PUBLIC_BYTES = 1024, VBS_MAX_MODULES = 64;

// EVIDENCE.md check 5: every occurrence of each field on PCR 12 must hold this.
export const VBS_REQUIRED_PCR12 = { VSM_LAUNCH_TYPE: 1, HYPERVISOR_LAUNCH_TYPE: 1, VBS_VSM_REQUIRED: 1, VBS_HVCI_POLICY: 1, CODEINTEGRITY: 1,
                                    BOOTDEBUGGING: 0, OSKERNELDEBUG: 0, HYPERVISOR_DEBUG: 0, SAFEMODE: 0, WINPE: 0, FLIGHTSIGNING: 0 };
export const VBS_QUOTE_PCRS = [0, 7, 12, 13, 14];
export const VBS_REPLAYED_PCRS = [7, 12, 13, 14];

// ---- TPM structures (big-endian, Part 2) --------------------------------------
function reader(b, what) {
  let off = 0;
  const need = (n) => { if (off + n > b.length) throw new Error(`${what} truncated`); };
  const r = {
    get off() { return off; },
    u8: () => { need(1); return b[off++]; },
    u16: () => { need(2); const v = b.readUInt16BE(off); off += 2; return v; },
    u32: () => { need(4); const v = b.readUInt32BE(off); off += 4; return v; },
    u64: () => { need(8); const v = b.readBigUInt64BE(off); off += 8; return v; },
    bytes: (n) => { need(n); const v = b.subarray(off, off + n); off += n; return v; },
    tpm2b: (cap) => { const n = r.u16(); if (n > cap) throw new Error(`${what} TPM2B exceeds ${cap} bytes`); return r.bytes(n); },
    done: () => { if (off !== b.length) throw new Error(`${what} has trailing bytes`); },
  };
  return r;
}

// TPMT_PUBLIC for an RSA key: type, nameAlg, objectAttributes, authPolicy,
// TPMS_RSA_PARMS { symmetric, scheme, keyBits, exponent }, unique (modulus).
export function parseTpmtPublic(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length > VBS_MAX_TPMT_PUBLIC_BYTES) throw new Error("TPMT_PUBLIC exceeds size limit");
  const r = reader(b, "TPMT_PUBLIC");
  const type = r.u16(), nameAlg = r.u16(), attributes = r.u32(), authPolicy = r.tpm2b(64);
  if (type !== TPM_ALG_RSA) throw new Error(`TPMT_PUBLIC type 0x${type.toString(16)} is not TPM_ALG_RSA`);
  const symmetric = { alg: r.u16() };
  if (symmetric.alg !== TPM_ALG_NULL) { symmetric.keyBits = r.u16(); symmetric.mode = r.u16(); }
  const scheme = { alg: r.u16() };
  if (scheme.alg !== TPM_ALG_NULL) scheme.hash = r.u16();
  const keyBits = r.u16(), exponentRaw = r.u32(), modulus = r.tpm2b(1024);
  r.done();
  if (!keyBits || keyBits % 8 || modulus.length !== keyBits / 8) throw new Error("TPMT_PUBLIC modulus does not match keyBits");
  return { type, nameAlg, attributes, authPolicy, symmetric, scheme, keyBits, exponent: exponentRaw || 65537, modulus, raw: b };
}
// Name = nameAlg || H_nameAlg(TPMT_PUBLIC bytes)  (Part 1, 16); sha256(bytes) -> 32 bytes, the caller's
export function tpmNameWith(sha256, tpmtPublicBytes) {
  const p = parseTpmtPublic(tpmtPublicBytes);
  if (p.nameAlg !== TPM_ALG_SHA256) throw new Error("only SHA-256 names are supported");
  return Buffer.concat([Buffer.from([0x00, 0x0b]), Buffer.from(sha256(p.raw))]);
}

// TPMS_ATTEST for a quote: magic, type, qualifiedSigner, extraData, clockInfo,
// firmwareVersion, TPMS_QUOTE_INFO { TPML_PCR_SELECTION, TPM2B_DIGEST }.
export function parseTpmsAttest(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length > VBS_MAX_ATTEST_BYTES) throw new Error("TPMS_ATTEST exceeds size limit");
  const r = reader(b, "TPMS_ATTEST");
  const magic = r.u32(), type = r.u16(), qualifiedSigner = r.tpm2b(68), extraData = r.tpm2b(64);
  const clockInfo = { clock: r.u64(), resetCount: r.u32(), restartCount: r.u32(), safe: r.u8() };
  const firmwareVersion = r.u64();
  if (magic !== TPM_GENERATED_VALUE) throw new Error("TPMS_ATTEST magic is not TPM_GENERATED_VALUE");
  if (type !== TPM_ST_ATTEST_QUOTE) throw new Error(`TPMS_ATTEST type 0x${type.toString(16)} is not TPM_ST_ATTEST_QUOTE`);
  const count = r.u32();
  if (count > 8) throw new Error("TPML_PCR_SELECTION count implausible");
  const pcrSelect = [];
  for (let i = 0; i < count; i++) {
    const hash = r.u16(), n = r.u8();
    if (!n || n > 8) throw new Error("TPMS_PCR_SELECTION sizeofSelect implausible");
    const bits = r.bytes(n), pcrs = [];
    for (let p = 0; p < 8 * n; p++) if ((bits[p >> 3] >> (p & 7)) & 1) pcrs.push(p);
    pcrSelect.push({ hash, pcrs });
  }
  const pcrDigest = r.tpm2b(64);
  r.done();
  return { magic, type, qualifiedSigner, extraData, clockInfo, firmwareVersion, pcrSelect, pcrDigest, raw: b };
}

// ---- EK certificate fields ---------------------------------------------------------
// A small DER walker for the SubjectAltName's directoryName (the avf-verify one
// is not exported and this needs SET/context tags it does not).
function tlv(b, off, limit = b.length) {
  if (off < 0 || off > limit - 2) throw new Error("DER truncated");
  const tag = b[off]; let len = b[off + 1], p = off + 2;
  if ((tag & 0x1f) === 0x1f) throw new Error("unsupported DER tag");
  if (len & 0x80) {
    const n = len & 0x7f;
    if (!n || n > 4 || n > limit - p) throw new Error("invalid DER length");
    len = 0; for (let i = 0; i < n; i++) len = len * 256 + b[p++];
  }
  if (len > limit - p) throw new Error("DER element overruns parent");
  return { tag, start: p, end: p + len, next: p + len };
}
function derChildren(b, node, cap = 256) {
  const out = []; let p = node.start;
  while (p < node.end) { if (out.length >= cap) throw new Error("too many DER children"); const c = tlv(b, p, node.end); out.push(c); p = c.next; }
  return out;
}
function derOid(b, n) {
  const v = b.subarray(n.start, n.end); if (!v.length || v.length > 64) throw new Error("bad OID");
  const parts = []; let acc = 0;
  for (const o of v) { acc = acc * 128 + (o & 0x7f); if (!(o & 0x80)) { parts.push(acc); acc = 0; } }
  const first = parts.shift(), head = first < 40 ? 0 : first < 80 ? 1 : 2;
  return [head, first - head * 40, ...parts].join(".");
}
// One extension's OCTET STRING contents from a certificate. Tolerant where
// avf-verify's extensionValue is strict: AMD's fTPM EK certificates encode
// critical=FALSE explicitly (not DER, but that is what the hardware ships), so
// the strict walker refuses the whole certificate. The chain signature and the
// pinned root already vouch for these bytes; this only locates a field.
export function certExtension(certDer, oid) {
  const b = Buffer.isBuffer(certDer) ? certDer : Buffer.from(certDer);
  if (b.length > VBS_MAX_CERT_BYTES) throw new Error("certificate exceeds size limit");
  const cert = tlv(b, 0);
  if (cert.tag !== 0x30 || cert.end !== b.length) throw new Error("not an exact DER certificate");
  const tbs = derChildren(b, cert, 3)[0];
  if (!tbs || tbs.tag !== 0x30) throw new Error("certificate fields malformed");
  const exts = derChildren(b, tbs, 16).find((f) => f.tag === 0xa3);
  if (!exts) return null;
  const seq = derChildren(b, exts, 1)[0];
  if (!seq || seq.tag !== 0x30) throw new Error("extensions are not a SEQUENCE");
  for (const ext of derChildren(b, seq)) {
    const parts = derChildren(b, ext, 3);
    if (parts.length < 2 || parts[0].tag !== 0x06 || parts[parts.length - 1].tag !== 0x04) throw new Error("extension malformed");
    if (derOid(b, parts[0]) === oid) { const v = parts[parts.length - 1]; return b.subarray(v.start, v.end); }
  }
  return null;
}
// tcg-at-tpmManufacturer from the SAN's directoryName entries: "414D4400" | null
export function tpmManufacturerOf(certDer) {
  const san = certExtension(certDer, OID_SAN);
  if (!san) return null;
  const names = tlv(san, 0);
  if (names.tag !== 0x30 || names.end !== san.length) throw new Error("SAN is not a GeneralNames SEQUENCE");
  for (const gn of derChildren(san, names)) {
    if (gn.tag !== 0xa4) continue;                                  // [4] directoryName
    for (const rdn of derChildren(san, derChildren(san, gn, 1)[0])) {     // Name ::= SEQUENCE OF RDN
      if (rdn.tag !== 0x31) continue;
      for (const atv of derChildren(san, rdn)) {
        const kv = derChildren(san, atv, 2);
        if (kv.length !== 2 || kv[0].tag !== 0x06 || derOid(san, kv[0]) !== OID_TPM_MANUFACTURER) continue;
        const m = /^id:([0-9A-Fa-f]{8})$/.exec(san.subarray(kv[1].start, kv[1].end).toString("latin1"));
        if (m) return m[1].toUpperCase();
      }
    }
  }
  return null;
}
