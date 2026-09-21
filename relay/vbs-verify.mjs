// relay/vbs-verify.mjs — first-party verification of a Windows consumer node's
// VBS-enclave attestation: tunnel format "windows-vbs-enclave/v1". Sibling of
// avf-verify.mjs (phone-anchored) and snp-verify.mjs, same shape of result,
// same rule: the root is PINNED, the policy is explicit, everything parsed off
// the socket is bounded. The contract is windows/vbs/EVIDENCE.md; the checks
// are numbered after its section "What the verifier establishes".
//
// What a node presents (EVIDENCE.md step 6): the enclave's VBS_ENCLAVE_REPORT
// package (signed by the VSM identity key of THIS boot), the measured-boot TCG
// log of this boot, a TPM quote over PCR {0,7,12,13,14} by a restricted key,
// that key's TPMT_PUBLIC, the EK certificate chain, the credential the TPM
// recovered from our TPM2_MakeCredential (vbs-credential.mjs), PCR 0 as read
// live, and the Ed25519 signature of the enclave's transport key over the
// binding transcript. What binds it together:
//
//   EK cert  --chains to-->  pinned AMD/Intel root       (1) genuine on-die TPM
//   credential round trip                                (3) the quoting key lives in THAT TPM
//   quote(challenge, PCRs) signed by the quoting key     (4) the log is what the TPM measured
//   log --replays to--> quoted PCRs; SIPA recomputed     (5) VBS on, HVCI on, no debug, ...
//   log PCR12 VSM_IDKS_INFO --verifies--> enclave report (6,7) this enclave, this boot
//   report.EnclaveData == sha256(bound), Ed25519 over bound (8) this transport key, this nonce
//
// verifyVbsEvidence({ evidence, nonce, transportKeySpki, padKeyHex, expectedCredential,
//                     mintedFor?, capture? }, policy)
//   -> { ok, measurement, reasons: [...], tier: "vbs" | "vbs-dev", checks, warnings, identity }
//
// Node's crypto only: RSA-PSS (salt 32) for the report, PKCS#1 v1.5 for the
// quote, X509Certificate for the EK chain, Ed25519 for the transport binding.
import { createHash, createPublicKey, verify as cryptoVerify, timingSafeEqual, X509Certificate, constants } from "node:crypto";
import fs from "node:fs";
import { parseTcgLog, replayPcrs, unhashedEvents, countRecomputable, sipaFields, vsmKey, secureBootFromLog, bootCounterFromLog } from "./vbs-tcglog.mjs";
import { extensionValue } from "./avf-verify.mjs";

export const VBS_FORMAT = "windows-vbs-enclave/v1";
export const VBS_BIND_DOMAIN = "enclave-vbs-bind-v1\n";
export const VBS_TEE_TECHNOLOGY = "windows-vbs-enclave";

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
// ntenclv.h / winnt.h
export const ENCLAVE_TYPE_VBS = 0x10;
export const ENCLAVE_FLAG_FULL_DEBUG_ENABLED = 0x1, ENCLAVE_FLAG_DYNAMIC_DEBUG_ENABLED = 0x2, ENCLAVE_FLAG_DYNAMIC_DEBUG_ACTIVE = 0x4;
export const ENCLAVE_DEBUG_FLAGS = ENCLAVE_FLAG_FULL_DEBUG_ENABLED | ENCLAVE_FLAG_DYNAMIC_DEBUG_ENABLED | ENCLAVE_FLAG_DYNAMIC_DEBUG_ACTIVE;

// Admission caps (a relay reading bytes off a socket), not format claims.
export const VBS_MAX_REPORT_BYTES = 64 * 1024, VBS_MAX_LOG_BYTES = 4 * 1024 * 1024, VBS_MAX_CERT_BYTES = 64 * 1024, VBS_MAX_CHAIN_CERTS = 8;
export const VBS_MAX_ATTEST_BYTES = 4096, VBS_MAX_SIG_BYTES = 1024, VBS_MAX_TPMT_PUBLIC_BYTES = 1024, VBS_MAX_MODULES = 64;

// EVIDENCE.md check 5: every occurrence of each field on PCR 12 must hold this.
export const VBS_REQUIRED_PCR12 = { VSM_LAUNCH_TYPE: 1, HYPERVISOR_LAUNCH_TYPE: 1, VBS_VSM_REQUIRED: 1, VBS_HVCI_POLICY: 1, CODEINTEGRITY: 1,
                                    BOOTDEBUGGING: 0, OSKERNELDEBUG: 0, HYPERVISOR_DEBUG: 0, SAFEMODE: 0, WINPE: 0, FLIGHTSIGNING: 0 };
export const VBS_QUOTE_PCRS = [0, 7, 12, 13, 14];
export const VBS_REPLAYED_PCRS = [7, 12, 13, 14];

const sha256 = (...parts) => { const h = createHash("sha256"); for (const p of parts) h.update(p); return h.digest(); };
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const hexOf = (b) => Buffer.from(b).toString("hex");
const eq = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && timingSafeEqual(a, b);

// ---- the binding transcript (EVIDENCE.md step 5) -------------------------------
//   bound = "enclave-vbs-bind-v1\n" || spki(44) || padKey(32 raw) || nonce(32)
// Both keys are generated INSIDE the enclave and both are covered: a pad key
// carried outside the signed bytes would be a recipient the host could swap.
export function vbsBinding(spki, padKeyHex, nonce) {
  if (!Buffer.isBuffer(spki) || spki.length !== 44 || !spki.subarray(0, 12).equals(ED25519_SPKI_PREFIX))
    throw new Error("VBS transportKey must be an Ed25519 SPKI (44 bytes)");
  if (typeof padKeyHex !== "string" || !/^[0-9a-f]{64}$/.test(padKeyHex))
    throw new Error("VBS padKey must be 32 bytes of lowercase hex");
  if (!Buffer.isBuffer(nonce) || nonce.length !== 32) throw new Error("VBS nonce must be 32 bytes");
  return Buffer.concat([Buffer.from(VBS_BIND_DOMAIN), spki, Buffer.from(padKeyHex, "hex"), nonce]);
}

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
// Name = nameAlg || H_nameAlg(TPMT_PUBLIC bytes)  (Part 1, 16)
export function tpmNameOf(tpmtPublicBytes) {
  const p = parseTpmtPublic(tpmtPublicBytes);
  if (p.nameAlg !== TPM_ALG_SHA256) throw new Error("only SHA-256 names are supported");
  return Buffer.concat([Buffer.from([0x00, 0x0b]), sha256(p.raw)]);
}
const b64url = (b) => Buffer.from(b).toString("base64url");
const unsigned = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i); };
export function rsaKeyFromModulus(modulus, exponent = 65537) {
  const e = Buffer.isBuffer(exponent) ? unsigned(exponent) : (() => { const x = Buffer.alloc(4); x.writeUInt32BE(exponent); return unsigned(x); })();
  return createPublicKey({ key: { kty: "RSA", n: b64url(unsigned(Buffer.from(modulus))), e: b64url(e) }, format: "jwk" });
}
export const rsaKeyFromTpmtPublic = (bytes) => { const p = parseTpmtPublic(bytes); return rsaKeyFromModulus(p.modulus, p.exponent); };

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

// ---- VBS_ENCLAVE_REPORT package (ntenclv.h; REPORT.md section 3) ----------------
// 24-byte header (PackageSize, Version, SignatureScheme, SignedStatementSize,
// SignatureSize, Reserved), the signed statement = VBS_ENCLAVE_REPORT (ReportSize,
// ReportVersion, EnclaveData[64], ENCLAVE_IDENTITY[152]) + VBS_ENCLAVE_REPORT_
// MODULE records, then the signature. All little-endian.
export const VBS_REPORT_SCHEME_SHA256_RSA_PSS = 1;
export function parseEnclaveReport(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length > VBS_MAX_REPORT_BYTES) throw new Error("report package exceeds size limit");
  if (b.length < 24) throw new Error("report package truncated");
  const header = { packageSize: b.readUInt32LE(0), version: b.readUInt32LE(4), scheme: b.readUInt32LE(8),
                   statementSize: b.readUInt32LE(12), signatureSize: b.readUInt32LE(16), reserved: b.readUInt32LE(20) };
  if (header.packageSize !== b.length || 24 + header.statementSize + header.signatureSize !== b.length) throw new Error("report package sizes do not add up");
  if (header.version !== 1) throw new Error(`report package version ${header.version} unsupported`);
  if (header.scheme !== VBS_REPORT_SCHEME_SHA256_RSA_PSS) throw new Error(`report signature scheme ${header.scheme} is not SHA256/RSA-PSS`);
  const statement = b.subarray(24, 24 + header.statementSize), signature = b.subarray(24 + header.statementSize);
  if (statement.length < 224) throw new Error("signed statement shorter than VBS_ENCLAVE_REPORT");
  const reportSize = statement.readUInt32LE(0), reportVersion = statement.readUInt32LE(4);
  if (reportSize !== statement.length) throw new Error("VBS_ENCLAVE_REPORT.ReportSize does not match the signed statement");
  if (reportVersion !== 1) throw new Error(`VBS_ENCLAVE_REPORT version ${reportVersion} unsupported`);
  const enclaveData = statement.subarray(8, 72), id = statement.subarray(72, 224);
  const identity = { ownerId: id.subarray(0, 32), uniqueId: id.subarray(32, 64), authorId: id.subarray(64, 96), familyId: id.subarray(96, 112), imageId: id.subarray(112, 128),
                     enclaveSvn: id.readUInt32LE(128), secureKernelSvn: id.readUInt32LE(132), platformSvn: id.readUInt32LE(136),
                     flags: id.readUInt32LE(140), signingLevel: id.readUInt32LE(144), enclaveType: id.readUInt32LE(148) };
  const modules = [];
  for (let p = 224; p < statement.length;) {
    if (p + 8 > statement.length) throw new Error("report module record truncated");
    const dataType = statement.readUInt32LE(p), size = statement.readUInt32LE(p + 4);
    if (size < 8 || p + size > statement.length) throw new Error("report module record malformed");
    if (modules.length >= VBS_MAX_MODULES) throw new Error("report lists too many modules");
    if (dataType === 1) {
      if (size < 108) throw new Error("VBS_ENCLAVE_REPORT_MODULE truncated");
      const m = statement.subarray(p + 8, p + size);
      modules.push({ uniqueId: m.subarray(0, 32), authorId: m.subarray(32, 64), familyId: m.subarray(64, 80), imageId: m.subarray(80, 96),
                     svn: m.readUInt32LE(96), name: m.subarray(100).toString("utf16le").replace(/\0+$/, "") });
    }
    p += size;
  }
  return { header, statement, signature, enclaveData, identity, modules, raw: b };
}
// The policy key for an enclave build (EVIDENCE.md "Policy"): sha256(FamilyId||ImageId||AuthorId).
export const enclaveMeasurementKey = (identity) => hexOf(sha256(identity.familyId, identity.imageId, identity.authorId));
// The measurement the tunnel row carries: hex(ImageId || AuthorId || SVN).
export function enclaveMeasurementOf(identity) {
  const svn = Buffer.alloc(4); svn.writeUInt32LE(identity.enclaveSvn);
  return hexOf(Buffer.concat([identity.imageId, identity.authorId, svn]));
}

// ---- EK certificate: chain to a pinned root, on-die manufacturer -------------------
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
const fpHex = (c) => String(c.fingerprint256 || "").replace(/:/g, "").toLowerCase();
const dateOf = (c, k) => new Date(Date.parse(c[k]));
const toCert = (x) => x instanceof X509Certificate ? x : new X509Certificate(x);
const pemCerts = (pem) => String(pem).split(/(?=-----BEGIN CERTIFICATE-----)/).filter((s) => s.includes("BEGIN CERTIFICATE")).map((p) => new X509Certificate(p));
// A roots bundle: its self-signed certificates are the trust anchors, anything
// else in it is an intermediate the node may have omitted (AMD's PRG-HPT).
export function loadTpmRoots(source) {
  const certs = typeof source === "string" ? (source.includes("-----BEGIN") ? pemCerts(source) : pemCerts(fs.readFileSync(source, "utf8")))
              : Array.isArray(source) ? source.map(toCert) : [];
  const roots = certs.filter((c) => c.checkIssued(c) && c.verify(c.publicKey));
  return { roots, intermediates: certs.filter((c) => !roots.includes(c)), pins: roots.map(fpHex) };
}
// Leaf -> (agent-supplied or bundled intermediates) -> a root whose sha256 is pinned.
export function verifyEkChain(leaf, extra, trust, now = Date.now()) {
  const pool = [...extra, ...trust.intermediates];
  const path = [leaf];
  for (let hops = 0; hops < VBS_MAX_CHAIN_CERTS; hops++) {
    const cur = path[path.length - 1];
    const root = trust.roots.find((r) => cur.checkIssued(r) && cur.verify(r.publicKey));
    if (root) {
      if (!trust.pins.includes(fpHex(root))) return { ok: false, reason: `EK chain root ${fpHex(root)} is not a pinned TPM root` };
      path.push(root);
      for (const [i, c] of path.entries()) {
        if (!(dateOf(c, "validFrom") <= now)) return { ok: false, reason: `EK chain cert ${i} not yet valid (${c.validFrom})` };
        if (!(now <= dateOf(c, "validTo"))) return { ok: false, reason: `EK chain cert ${i} expired (${c.validTo})` };
        if (i > 0 && !c.ca) return { ok: false, reason: `EK chain cert ${i} is not a CA` };
      }
      return { ok: true, root, path };
    }
    const issuer = pool.find((c) => !path.includes(c) && c.ca && cur.checkIssued(c) && cur.verify(c.publicKey));
    if (!issuer) return { ok: false, reason: `EK chain breaks at "${(cur.subject || "(empty subject)").replace(/\n/g, ", ")}" <- ${cur.issuer.replace(/\n/g, ", ")}: no issuer among the supplied or bundled intermediates and no pinned root` };
    path.push(issuer);
  }
  return { ok: false, reason: "EK chain too long" };
}

// ---- policy normalisation ----------------------------------------------------------
function normalizePolicy(policy = {}) {
  const hexList = (v) => new Set([...(v || [])].map((h) => String(h).toLowerCase()).filter((h) => /^[0-9a-f]{64}$/.test(h)));
  const trust = policy.ekRoots ? loadTpmRoots(policy.ekRoots) : { roots: [], intermediates: [], pins: [] };
  if (Array.isArray(policy.ekRootPins) && policy.ekRootPins.length) {
    const pins = new Set(policy.ekRootPins.map((p) => String(p).toLowerCase()));
    trust.pins = trust.pins.filter((p) => pins.has(p));
  }
  return { measurements: hexList(policy.measurements), minSvn: Number.isInteger(policy.minSvn) ? policy.minSvn : 1, pcr0: hexList(policy.pcr0),
           allowTestSigning: !!policy.allowTestSigning, trust, now: policy.now || Date.now() };
}

// ---- the verifier ----------------------------------------------------------------------
const b64cap = (cap) => 4 * Math.ceil(cap / 3) + 4;
export function verifyVbsEvidence({ evidence, nonce, transportKeySpki = null, padKeyHex = "", expectedCredential = null, mintedFor = null, capture = null } = {},
                                  policy = {}) {
  const checks = [], warnings = [];
  // required: the check gates admission. dev: it gates the PRODUCTION tier only;
  // with policy.allowTestSigning a failure demotes to tier "vbs-dev" instead.
  const check = (name, ok, detail = "", { required = true, dev = false } = {}) => { checks.push({ name, ok: !!ok, detail, required, dev }); return !!ok; };
  const skip = (name, why) => { checks.push({ name, ok: false, detail: `not checked: ${why}`, required: true, dev: false, skipped: true }); return false; };
  const pol = normalizePolicy(policy);
  const ev = evidence && typeof evidence === "object" ? evidence : {};
  // bounded base64 field access: a field is either well-formed and within its cap, or absent
  const buf = (v, cap) => { if (typeof v !== "string" || !v.length || v.length > b64cap(cap)) return null; const b = Buffer.from(v, "base64"); return b.length && b.length <= cap ? b : null; };

  // ---- binding transcript (8), computed first: the challenge everything else must carry
  let bound = null, challenge = null, quoteExtra = null;
  if (capture) {
    // CAPTURE MODE (CLI / tests on evidence recorded by the spike tools, which
    // used raw nonces before the transcript existed). Never set by the tunnel:
    // the result is a verdict on a recording, not a live admission.
    challenge = Buffer.isBuffer(capture.reportData) ? capture.reportData : null;
    quoteExtra = Buffer.isBuffer(capture.quoteExtraData) ? capture.quoteExtraData : challenge;
    check("8 binding: capture mode (report/quote nonces supplied by the operator, transport binding not exercised)", !!challenge && !!quoteExtra, "", { required: true });
  } else {
    try { bound = vbsBinding(transportKeySpki, padKeyHex, nonce); challenge = sha256(bound); quoteExtra = challenge;
          check("8 binding: transportKey is an Ed25519 SPKI, padKey 32 bytes, nonce 32 bytes", true); }
    catch (e) { check("8 binding: transportKey is an Ed25519 SPKI, padKey 32 bytes, nonce 32 bytes", false, e.message); }
  }

  // ---- 1. EK certificate: pinned root, on-die manufacturer
  let ekLeaf = null, ekDer = null;
  {
    ekDer = buf(ev.ek && ev.ek.cert, VBS_MAX_CERT_BYTES);
    const chainRaw = ev.ek && Array.isArray(ev.ek.chain) ? ev.ek.chain : [];
    let extra = [];
    try {
      if (!ekDer) throw new Error("ek.cert missing or oversized");
      if (chainRaw.length > VBS_MAX_CHAIN_CERTS) throw new Error("ek.chain exceeds certificate-count limit");
      ekLeaf = new X509Certificate(ekDer);
      extra = chainRaw.map((c) => { const d = buf(c, VBS_MAX_CERT_BYTES); if (!d) throw new Error("ek.chain entry missing or oversized"); return new X509Certificate(d); });
      check("1 ek: certificate and chain parse", true, `${ekLeaf.issuer.replace(/\n/g, ", ")}, ${extra.length} intermediate(s) supplied`);
    } catch (e) { ekLeaf = null; check("1 ek: certificate and chain parse", false, e.message); }
    if (ekLeaf) {
      if (!pol.trust.pins.length) check("1 ek: chains to a pinned TPM root", false, "no pinned TPM roots in policy (METAL_VBS_EK_ROOTS): refusing (fail closed)");
      else { const r = verifyEkChain(ekLeaf, extra, pol.trust, pol.now); check("1 ek: chains to a pinned TPM root", r.ok, r.ok ? `root sha256 ${fpHex(r.root)}` : r.reason); }
      let mfr = null; try { mfr = tpmManufacturerOf(ekDer); } catch (e) { mfr = null; warnings.push(`ek SAN: ${e.message}`); }
      check("1 ek: on-die firmware TPM (SAN tpmManufacturer AMD/Intel)", !!mfr && !!TPM_MANUFACTURERS_ON_DIE[mfr], mfr ? `id:${mfr}${TPM_MANUFACTURERS_ON_DIE[mfr] ? ` (${TPM_MANUFACTURERS_ON_DIE[mfr]})` : ""}` : "no tcg-at-tpmManufacturer in the SAN");
      if (mintedFor && Buffer.isBuffer(mintedFor.ekCert)) check("3 credential: EK certificate is the one the credential was minted for", eq(mintedFor.ekCert, ekDer));
    } else { skip("1 ek: chains to a pinned TPM root", "certificate did not parse"); skip("1 ek: on-die firmware TPM (SAN tpmManufacturer AMD/Intel)", "certificate did not parse"); }
  }

  // ---- 2. the quoting key
  let aik = null, aikKey = null, aikName = null;
  {
    const aikPubRaw = buf(ev.quote && ev.quote.aikPub, VBS_MAX_TPMT_PUBLIC_BYTES);
    try {
      if (!aikPubRaw) throw new Error("quote.aikPub missing or oversized");
      aik = parseTpmtPublic(aikPubRaw);
      if (aik.nameAlg !== TPM_ALG_SHA256) throw new Error("quoting key nameAlg is not SHA-256");
      if (aik.scheme.alg !== TPM_ALG_RSASSA || aik.scheme.hash !== TPM_ALG_SHA256) throw new Error("quoting key scheme is not RSASSA/SHA-256");
      aikKey = rsaKeyFromModulus(aik.modulus, aik.exponent);
      aikName = tpmNameOf(aikPubRaw);
      check("2 aik: TPMT_PUBLIC parses (RSA, SHA-256 name, RSASSA-SHA256)", true, `RSA-${aik.keyBits}`);
    } catch (e) { aik = null; check("2 aik: TPMT_PUBLIC parses (RSA, SHA-256 name, RSASSA-SHA256)", false, e.message); }
    if (aik) {
      check("2 aik: attributes fixedTPM|fixedParent|sensitiveDataOrigin|restricted|sign, not decrypt",
            (aik.attributes & AIK_REQUIRED_ATTRIBUTES) === AIK_REQUIRED_ATTRIBUTES && !(aik.attributes & TPMA_DECRYPT), `attrs=0x${aik.attributes.toString(16).padStart(8, "0")}`);
      if (mintedFor && Buffer.isBuffer(mintedFor.aikName))
        check("2 aik: name == 0x000B || sha256(TPMT_PUBLIC), the name the credential was minted for", eq(mintedFor.aikName, aikName), `name ${hexOf(aikName).slice(0, 20)}…`);
      else check("2 aik: name == 0x000B || sha256(TPMT_PUBLIC)", true, `name ${hexOf(aikName).slice(0, 20)}…`);
    } else {
      skip("2 aik: attributes fixedTPM|fixedParent|sensitiveDataOrigin|restricted|sign, not decrypt", "TPMT_PUBLIC did not parse");
      skip("2 aik: name == 0x000B || sha256(TPMT_PUBLIC)", "TPMT_PUBLIC did not parse");
    }
  }

  // ---- 3. the credential round trip: the quoting key lives in the TPM whose EK we checked
  {
    const got = buf(ev.credential, 64);
    if (capture && !expectedCredential) check("3 credential: activated credential == the one minted for (EK, AIK name)", true, "capture mode: no credential minted (skipped)");
    else check("3 credential: activated credential == the one minted for (EK, AIK name)",
               Buffer.isBuffer(expectedCredential) && expectedCredential.length === 32 && got && eq(got, expectedCredential),
               !Buffer.isBuffer(expectedCredential) ? "no credential was minted for this attach" : !got ? "evidence.credential missing" : got.length !== 32 ? `credential is ${got.length} bytes` : "");
  }

  // ---- 5. the log: parse, recompute, replay
  let events = null, pcrs = null, f12 = null;
  {
    const logRaw = buf(ev.log, VBS_MAX_LOG_BYTES);
    try {
      if (!logRaw) throw new Error("log missing or oversized");
      const parsed = parseTcgLog(logRaw, { maxBytes: VBS_MAX_LOG_BYTES });
      if (!parsed.algs.has(TPM_ALG_SHA256)) throw new Error("log carries no SHA-256 bank");
      events = parsed.events; pcrs = replayPcrs(events);
      check("5 log: parses (TCG 2.0 crypto-agile, SHA-256 bank)", true, `${events.length} events`);
    } catch (e) { events = null; check("5 log: parses (TCG 2.0 crypto-agile, SHA-256 bank)", false, e.message); }
    if (events) {
      const bad = unhashedEvents(events);
      check("5 log: every SIPA record and PCR 7 variable event hashes to its recorded digest", !bad.length,
            bad.length ? `edited events at ${JSON.stringify(bad.slice(0, 4))}` : `${countRecomputable(events)} records recomputed`);
      try { f12 = sipaFields(events, 12); } catch (e) { f12 = null; check("5 log: PCR 12 SIPA records decode", false, e.message); }
    } else skip("5 log: every SIPA record and PCR 7 variable event hashes to its recorded digest", "log did not parse");
  }

  // ---- 4. the quote: signature, freshness, PCR digest over replayed PCRs + pinned PCR 0
  let quote = null;
  {
    const attestRaw = buf(ev.quote && ev.quote.attest, VBS_MAX_ATTEST_BYTES), sigRaw = buf(ev.quote && ev.quote.sig, VBS_MAX_SIG_BYTES);
    try {
      if (!attestRaw) throw new Error("quote.attest missing or oversized");
      quote = parseTpmsAttest(attestRaw);
      check("4 quote: TPMS_ATTEST parses (TPM_GENERATED, TPM_ST_ATTEST_QUOTE)", true);
    } catch (e) { quote = null; check("4 quote: TPMS_ATTEST parses (TPM_GENERATED, TPM_ST_ATTEST_QUOTE)", false, e.message); }
    if (quote && aikKey) {
      let okSig = false;
      try { okSig = !!sigRaw && cryptoVerify("sha256", quote.raw, { key: aikKey, padding: constants.RSA_PKCS1_PADDING }, sigRaw); } catch (e) { okSig = false; }
      check("4 quote: signature verifies with the quoting key (RSASSA-PKCS1v15-SHA256)", okSig, sigRaw ? "" : "quote.sig missing or oversized");
    } else skip("4 quote: signature verifies with the quoting key (RSASSA-PKCS1v15-SHA256)", quote ? "quoting key did not parse" : "quote did not parse");
    if (quote) {
      check("4 quote: extraData == challenge", !!quoteExtra && eq(quote.extraData, quoteExtra), quoteExtra ? "" : "no challenge (binding transcript failed)");
      const sel = quote.pcrSelect.length === 1 && quote.pcrSelect[0].hash === TPM_ALG_SHA256 ? quote.pcrSelect[0].pcrs : null;
      const selected = sel || [];
      const wantSet = new Set(VBS_QUOTE_PCRS);
      const coversReplayed = VBS_REPLAYED_PCRS.every((p) => selected.includes(p)) && selected.every((p) => wantSet.has(p));
      check("4 quote: PCR selection is the SHA-256 bank over {0,7,12,13,14}", !!sel && coversReplayed && selected.includes(0),
            `selected ${sel ? `{${selected.join(",")}}` : "(not a single SHA-256 selection)"}`, { dev: !!sel && coversReplayed });   // a dev-tier box may quote without PCR 0
      const hasPcr0 = selected.includes(0);
      const pcr0Hex = typeof ev.pcr0 === "string" && /^[0-9a-fA-F]{64}$/.test(ev.pcr0) ? ev.pcr0.toLowerCase() : null;
      if (hasPcr0) check("4 quote: PCR 0 on the policy pin list (METAL_VBS_PCR0)", !!pcr0Hex && pol.pcr0.has(pcr0Hex),
                         pcr0Hex ? (pol.pcr0.size ? `pcr0 ${pcr0Hex.slice(0, 16)}…` : "no PCR 0 pins configured") : "evidence.pcr0 missing or not 32 bytes hex", { dev: true });
      else check("4 quote: PCR 0 on the policy pin list (METAL_VBS_PCR0)", false, "PCR 0 not quoted: firmware not attested", { dev: true });
      if (pcrs && sel && coversReplayed) {
        const parts = selected.map((p) => p === 0 ? (pcr0Hex ? Buffer.from(pcr0Hex, "hex") : null) : pcrs.get(p) || null);
        const okDigest = parts.every(Boolean) && eq(sha256(...parts), quote.pcrDigest);
        check("4 quote: PCR digest == sha256(PCR0 || replayed PCR7 || PCR12 || PCR13 || PCR14)", okDigest,
              parts.every(Boolean) ? "" : `missing PCR value for ${selected.filter((p, i) => !parts[i]).join(",")}`);
      } else skip("4 quote: PCR digest == sha256(PCR0 || replayed PCR7 || PCR12 || PCR13 || PCR14)", pcrs ? "selection unusable" : "log did not replay");
    } else {
      for (const n of ["4 quote: extraData == challenge", "4 quote: PCR selection is the SHA-256 bank over {0,7,12,13,14}", "4 quote: PCR 0 on the policy pin list (METAL_VBS_PCR0)",
                       "4 quote: PCR digest == sha256(PCR0 || replayed PCR7 || PCR12 || PCR13 || PCR14)"]) skip(n, "quote did not parse");
    }
  }

  // ---- 5. platform state from PCR 12 / PCR 7
  if (f12) {
    for (const [k, want] of Object.entries(VBS_REQUIRED_PCR12)) {
      const vals = f12.get(k) || [];
      check(`5 log: ${k} == ${want}`, vals.length && vals.every((v) => v === want), `log: [${vals.join(", ")}]`);
    }
    const ts = f12.get("TESTSIGNING") || [];
    check("5 log: TESTSIGNING == 0 (production signing)", ts.length && ts.every((v) => v === 0), `log: [${ts.join(", ")}]`, { dev: true });
    const sb = secureBootFromLog(events);
    check("5 log: Secure Boot on (PCR 7 SecureBoot variable)", sb === 1, `log: ${sb}`, { dev: true });
    if (f12.get("HYPERVISOR_BOOT_DMA_PROTECTION")?.[0] !== 1) warnings.push("HYPERVISOR_BOOT_DMA_PROTECTION != 1 (not yet required; see REPORT.md section 5)");
    if (!f12.has("VBS_IOMMU_REQUIRED")) warnings.push("VBS_IOMMU_REQUIRED absent (RequirePlatformSecurityFeatures not set; not yet required)");
  } else {
    for (const [k, want] of Object.entries(VBS_REQUIRED_PCR12)) skip(`5 log: ${k} == ${want}`, "log unusable");
    skip("5 log: TESTSIGNING == 0 (production signing)", "log unusable"); skip("5 log: Secure Boot on (PCR 7 SecureBoot variable)", "log unusable");
  }

  // ---- 6. the VSM IDKS from THIS boot's log
  let idks = null;
  if (events) {
    try { const k = vsmKey(events, "IDKS"); if (!k) throw new Error("no VSM_IDKS_INFO record on PCR 12 (in a recomputed event)");
          idks = rsaKeyFromModulus(k.modulus, k.exponent); check("6 idks: VSM_IDKS_INFO RSA key on PCR 12 (recomputed)", true, `RSA-${k.bits} modulus sha256=${hexOf(sha256(k.modulus)).slice(0, 16)}`); }
    catch (e) { idks = null; check("6 idks: VSM_IDKS_INFO RSA key on PCR 12 (recomputed)", false, e.message); }
  } else skip("6 idks: VSM_IDKS_INFO RSA key on PCR 12 (recomputed)", "log unusable");

  // ---- 7. the enclave report
  let report = null, measurement = null, identity = null;
  {
    const raw = buf(ev.report, VBS_MAX_REPORT_BYTES);
    try { if (!raw) throw new Error("report missing or oversized"); report = parseEnclaveReport(raw); check("7 report: package parses (size, version 1, scheme SHA256/RSA-PSS)", true, `${report.modules.length} module(s): ${report.modules.map((m) => m.name).join(", ")}`); }
    catch (e) { report = null; check("7 report: package parses (size, version 1, scheme SHA256/RSA-PSS)", false, e.message); }
    if (report && idks) {
      let okSig = false;
      try { okSig = cryptoVerify("sha256", report.statement, { key: idks, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, report.signature); } catch { okSig = false; }
      check("7 report: signed by the IDKS of this boot (RSA-PSS SHA-256, salt 32)", okSig);
    } else skip("7 report: signed by the IDKS of this boot (RSA-PSS SHA-256, salt 32)", report ? "no IDKS" : "report did not parse");
    if (report) {
      identity = report.identity;
      check("7 report: EnclaveData[0:32] == challenge", !!challenge && eq(report.enclaveData.subarray(0, 32), challenge), challenge ? "" : "no challenge (binding transcript failed)");
      check("7 report: enclave type VBS", identity.enclaveType === ENCLAVE_TYPE_VBS, `type 0x${identity.enclaveType.toString(16)}`);
      const key = enclaveMeasurementKey(identity);
      check("7 report: sha256(FamilyId||ImageId||AuthorId) on the policy allowlist (METAL_VBS_ENCLAVE_MEASUREMENTS)", pol.measurements.size > 0 && pol.measurements.has(key),
            pol.measurements.size ? `key ${key}` : `no allowlist configured (this build's key: ${key})`);
      check(`7 report: SVN >= ${pol.minSvn}`, identity.enclaveSvn >= pol.minSvn, `svn=${identity.enclaveSvn} platformSvn=${identity.platformSvn}`);
      check("7 report: enclave not debuggable (FULL_DEBUG / DYNAMIC_DEBUG clear)", !(identity.flags & ENCLAVE_DEBUG_FLAGS), `flags=0x${identity.flags.toString(16)}`, { dev: true });
      measurement = enclaveMeasurementOf(identity);
    } else {
      for (const n of ["7 report: EnclaveData[0:32] == challenge", "7 report: enclave type VBS", "7 report: sha256(FamilyId||ImageId||AuthorId) on the policy allowlist (METAL_VBS_ENCLAVE_MEASUREMENTS)",
                       `7 report: SVN >= ${pol.minSvn}`, "7 report: enclave not debuggable (FULL_DEBUG / DYNAMIC_DEBUG clear)"]) skip(n, "report did not parse");
    }
  }

  // ---- 8. the transport binding: the enclave's own key signed OUR transcript
  if (!capture) {
    const sig = buf(ev.signature, 128);
    let okSig = false;
    if (bound && sig && sig.length === 64) { try { okSig = cryptoVerify(null, bound, createPublicKey({ key: transportKeySpki, format: "der", type: "spki" }), sig); } catch { okSig = false; } }
    check("8 binding: Ed25519 signature over bound verifies with transportKey", okSig, !bound ? "no transcript" : !sig ? "evidence.signature missing" : sig.length !== 64 ? `signature is ${sig.length} bytes` : "");
  }

  // ---- 9. freshness (warn only): the log's boot counter vs the quote's clock info
  if (events && quote) {
    const bc = bootCounterFromLog(events);
    if (bc != null && typeof bc === "number" && bc !== quote.clockInfo.resetCount)
      warnings.push(`log BOOTCOUNTER ${bc} != quote resetCount ${quote.clockInfo.resetCount} (AMD fTPM clockInfo is known to decode oddly; warn only)`);
  }

  // ---- verdict
  const failed = checks.filter((c) => !c.ok && !c.skipped && c.required && !c.dev);
  const devFailed = checks.filter((c) => !c.ok && !c.skipped && c.dev);
  const reasons = failed.map((c) => c.detail ? `${c.name}: ${c.detail}` : c.name);
  if (devFailed.length && !pol.allowTestSigning) reasons.push(...devFailed.map((c) => `${c.name}${c.detail ? `: ${c.detail}` : ""} (METAL_VBS_ALLOW_TESTSIGNING not set)`));
  const ok = !reasons.length;
  const tier = devFailed.length ? "vbs-dev" : "vbs";
  return { ok, measurement: ok ? measurement : null, reasons, tier: ok ? tier : null, checks, warnings, capture: !!capture,
           identity: identity ? { authorId: hexOf(identity.authorId), uniqueId: hexOf(identity.uniqueId), familyId: hexOf(identity.familyId), imageId: hexOf(identity.imageId),
                                  svn: identity.enclaveSvn, platformSvn: identity.platformSvn, flags: identity.flags, measurementKey: enclaveMeasurementKey(identity),
                                  modules: report.modules.map((m) => m.name) } : null };
}

// ---- CLI ---------------------------------------------------------------------------------
//   node relay/vbs-verify.mjs <evidence.json> --nonce <b64> [--transport-key <b64 SPKI>] [--pad-key <hex>]
//        [--credential <hex>] [--measurements a,b] [--min-svn N] [--pcr0 a,b] [--ek-roots FILE] [--allow-testsigning]
//        [--capture-report-data <hex|@file> [--capture-quote-nonce <hex|@file>]] [--json]
// evidence.json is the attest frame's `rad` ({format, transportKey, padKey, body}),
// the body object itself, or the whole attest frame. Policy comes from the
// METAL_VBS_* env (vbs-policy.mjs) and the flags override it. The capture flags
// verify evidence recorded by windows/vbs/tools (raw nonces, no transcript).
if (process.argv[1] && /vbs-verify\.mjs$/.test(process.argv[1])) {
  const { vbsPolicyFromEnv } = await import("./vbs-policy.mjs");
  const argv = process.argv.slice(2);
  const VALUED = new Set(["--nonce", "--transport-key", "--pad-key", "--credential", "--measurements", "--min-svn", "--pcr0", "--ek-roots", "--capture-report-data", "--capture-quote-nonce"]);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const file = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && VALUED.has(argv[i - 1])));
  if (!file) { console.error("usage: vbs-verify.mjs <evidence.json> --nonce <b64> [--transport-key b64] [--pad-key hex] [--credential hex] [--measurements a,b] [--pcr0 a,b] [--allow-testsigning] [--capture-report-data hex|@file --capture-quote-nonce hex|@file]"); process.exit(2); }
  const hexOrFile = (v) => v ? (v.startsWith("@") ? fs.readFileSync(v.slice(1)) : Buffer.from(v, "hex")) : null;
  let doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (doc.rad) doc = doc.rad;
  const rad = doc.body && typeof doc.body === "string" ? doc : { format: VBS_FORMAT, transportKey: arg("--transport-key") || "", padKey: arg("--pad-key") || "", body: Buffer.from(JSON.stringify(doc)).toString("base64") };
  const evidence = JSON.parse(Buffer.from(rad.body, "base64").toString("utf8"));
  const env = { ...process.env };
  if (arg("--measurements")) env.METAL_VBS_ENCLAVE_MEASUREMENTS = arg("--measurements");
  if (arg("--min-svn")) env.METAL_VBS_MIN_SVN = arg("--min-svn");
  if (arg("--pcr0")) env.METAL_VBS_PCR0 = arg("--pcr0");
  if (arg("--ek-roots")) env.METAL_VBS_EK_ROOTS = arg("--ek-roots");
  if (argv.includes("--allow-testsigning")) env.METAL_VBS_ALLOW_TESTSIGNING = "1";
  if (!env.METAL_VBS_ENCLAVE_MEASUREMENTS) env.METAL_VBS_ENCLAVE_MEASUREMENTS = "0".repeat(64);   // a placeholder so the policy loads; the allowlist check then reports this build's key
  const policy = vbsPolicyFromEnv(env);
  const capRep = hexOrFile(arg("--capture-report-data"));
  const capture = capRep ? { reportData: capRep.subarray(0, 32), quoteExtraData: hexOrFile(arg("--capture-quote-nonce")) || capRep.subarray(0, 32) } : null;
  const res = verifyVbsEvidence({ evidence, nonce: arg("--nonce") ? Buffer.from(arg("--nonce"), "base64") : null,
                                  transportKeySpki: rad.transportKey ? Buffer.from(rad.transportKey, "base64") : (arg("--transport-key") ? Buffer.from(arg("--transport-key"), "base64") : null),
                                  padKeyHex: rad.padKey || arg("--pad-key") || "", expectedCredential: hexOrFile(arg("--credential")), capture }, policy);
  if (argv.includes("--json")) console.log(JSON.stringify(res, null, 1));
  else {
    for (const c of res.checks) console.log(`  [${c.ok ? "PASS" : c.skipped ? "skip" : c.dev ? "dev " : "FAIL"}] ${c.name.padEnd(96)} ${c.detail || ""}`);
    for (const w of res.warnings) console.log(`  [warn] ${w}`);
    if (res.identity) console.log(`  enclave: AuthorId=${res.identity.authorId}\n           FamilyId=${res.identity.familyId} ImageId=${res.identity.imageId} Svn=${res.identity.svn} Flags=0x${res.identity.flags.toString(16)}\n           policy key (METAL_VBS_ENCLAVE_MEASUREMENTS) = ${res.identity.measurementKey}`);
    console.log(`\nVERDICT: ${res.ok ? `ACCEPT tier=${res.tier}` : "REJECT"}${res.capture ? " (capture mode: not a live admission)" : ""}  measurement=${res.measurement || "-"}${res.reasons.length ? `\n  ${res.reasons.join("\n  ")}` : ""}`);
  }
  process.exit(res.ok ? 0 : 1);
}
