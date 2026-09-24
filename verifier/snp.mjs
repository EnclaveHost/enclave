// verifier/snp.mjs: AMD SEV-SNP evidence, verified offline against pinned roots and an explicit policy.
//
// What this adds over relay/snp-verify.mjs (whose checked primitives it IMPORTS rather than copies):
// a strict fixed-size parser with the ABI's must-be-zero ranges, VCEK-only signer, P-384 range checks on
// r and s; certificate validity windows and subject checks along VCEK -> ASK -> pinned ARK; the ARK-signed
// CRL (ASK revocation, collateral freshness); floors applied to the reported AND the committed TCB;
// firmware version floors; a binding rule chosen by the evidence FORMAT (hosted shim, metal, domain
// ABI/1 or ABI/2); and one verdict shape: { status, reasons, checks, claims }.
//
// Layout references: AMD 56860 (SEV-SNP Firmware ABI) Rev 1.59 Table 27 ATTESTATION_REPORT, Tables 4/5
// TCB_VERSION (Turin adds FMC at bits 7:0), Table 148 signature (R, S 72-byte zero-extended little-endian);
// AMD 57230 (VCEK/KDS) extension OIDs 1.3.6.1.4.1.3704.1.*. Versions 2..5 are what go-sev-guest v0.15.0
// parses. Version 6 (Rev 1.59, ETCB fields from 0x220) parses structurally so its bytes can be shown, but its
// security semantics are NOT implemented, so it is "unsupported" by default and can never be "verified".
//
// VERDICTS. "verified" is admission-safe: every security check passed under a policy that omitted nothing.
// "limited" means every cryptographic check passed but the policy EXPLICITLY relaxed a security check (no
// TCB floor, no CRL, no certificate binding, no nonce, a research-only report version); the omissions are
// listed and a consumer that tests `status === "verified"` cannot mistake it for acceptance. "rejected" is
// a failed check; "unsupported" is evidence whose semantics this verifier does not implement.
import { X509Certificate, constants, verify as cryptoVerify } from "node:crypto";
import { AMD_ARK_SHA256, decodeTcb, TCB_FIELDS, snpProductHint, kdsVcekUrl, vcekMatchesReport, checkMinTcb } from "../relay/snp-verify.mjs";
import { parseCrl, subjectNameDer } from "./der.mjs";
import { sha256, checkHostedCertificate } from "./tls-binding.mjs";

export const REPORT_SIZE = 0x4a0, SIG_OFFSET = 0x2a0, MAX_REPORT_VERSION = 6, JUDGED_MAX_REPORT_VERSION = 5;
// The status a run ends with when every check passed: admission-safe only when nothing was omitted.
export const verdictStatus = (omissions) => omissions.length ? "limited" : "verified";
// The certificate and signature work behind one interface, so the SAME verdict code runs in Node (node:crypto, below) and
// in a browser (verifier/web/provider.mjs: WebCrypto and a reviewed X.509 reader). context.crypto selects it; the default
// is Node's. Nothing about policy, order or wording lives in a provider: it answers what a certificate, a CRL or a
// signature IS, and this file decides what that means.
//   checkChain, checkCrl, verifyReportSignature: as the functions of the same name below, possibly async
//   certRaw(cert) -> DER bytes, certFp(cert) -> sha256 hex, sha256(...parts) -> bytes, checkHostedCertificate: tls-binding
const P384_N = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973");
const VCEK_GUID = "63da758de6644564adc5f4b93be8accd";
const hex = (b) => Buffer.from(b).toString("hex");
const fpHex = (cert) => String(cert.fingerprint256 || "").replace(/:/g, "").toLowerCase();
const cn = (dn) => (/(?:^|\n)CN=([^\n]+)/.exec(dn || "") || [])[1] || null;

export const DEFAULT_SNP_POLICY = Object.freeze({
  allowedProducts: ["Milan", "Genoa", "Turin"],
  roots: AMD_ARK_SHA256,                 // product -> sha256 of the ARK (relay/snp-verify.mjs, corroborated against go-sev-guest)
  product: null,                         // required for report version 2 (no CPUID in the report); must agree with CPUID for v3+
  expectedVmpl: 0,
  guestPolicy: { debug: false, migrateMa: false, smt: "any", singleSocket: "any", cxlAllowed: "any", memAes256Xts: "any", raplDis: "any", ciphertextHidingDram: "any", pageSwapDisabled: "any" },
  minTcb: undefined,                     // { Product: { field: n } } per relay/snp-verify.mjs checkMinTcb; applied to reported AND committed TCB
  minFirmware: undefined,                // { major, minor, build }: applied to current AND committed firmware version
  allowedMeasurements: [],               // hex; empty = refuse (a verifier with no expected measurement has nothing to compare)
  crl: "required",                       // required | stale-ok | none
  crlMaxStaleDays: 0,
  requireCertificateBinding: true,       // hosted format: the served certificate must be supplied and must bind this document
  researchAllowUnjudgedReportVersions: false, // RESEARCH ONLY: run the checks on a report version whose new fields are unjudged; the result is at best "limited"
});

export function parseReportStrict(r) {
  if (!Buffer.isBuffer(r)) throw new Error("report is not a byte buffer");
  if (r.length !== REPORT_SIZE) throw new Error(`report is ${r.length} bytes; the ABI fixes ATTESTATION_REPORT at ${REPORT_SIZE}`);
  const u32 = (o) => r.readUInt32LE(o), u64 = (o) => r.readBigUInt64LE(o);
  const p = {
    version: u32(0), guestSvn: u32(4), policy: u64(8), familyId: r.subarray(0x10, 0x20), imageId: r.subarray(0x20, 0x30),
    vmpl: u32(0x30), signatureAlgo: u32(0x34), currentTcb: r.subarray(0x38, 0x40), platformInfo: u64(0x40), signerInfo: u32(0x48),
    reportData: r.subarray(0x50, 0x90), measurement: r.subarray(0x90, 0xc0), hostData: r.subarray(0xc0, 0xe0),
    idKeyDigest: r.subarray(0xe0, 0x110), authorKeyDigest: r.subarray(0x110, 0x140), reportId: r.subarray(0x140, 0x160), reportIdMa: r.subarray(0x160, 0x180),
    reportedTcb: r.subarray(0x180, 0x188), cpuidFam: r[0x188], cpuidMod: r[0x189], cpuidStep: r[0x18a], chipId: r.subarray(0x1a0, 0x1e0),
    committedTcb: r.subarray(0x1e0, 0x1e8), currentBuild: r[0x1e8], currentMinor: r[0x1e9], currentMajor: r[0x1ea],
    committedBuild: r[0x1ec], committedMinor: r[0x1ed], committedMajor: r[0x1ee], launchTcb: r.subarray(0x1f0, 0x1f8),
    launchMitVector: r.subarray(0x1f8, 0x200), currentMitVector: r.subarray(0x200, 0x208),
    // ABI Rev 1.59 (report version 6): extended TCB fields, parsed for display only, never judged here
    currentEtcb: r.subarray(0x220, 0x240), launchEtcb: r.subarray(0x240, 0x260), committedEtcb: r.subarray(0x260, 0x280),
    signature: r.subarray(SIG_OFFSET, SIG_OFFSET + 0x90), signedRegion: r.subarray(0, SIG_OFFSET),
  };
  if (p.version < 2) throw new Error(`report version ${p.version} < 2`);
  if (p.version > MAX_REPORT_VERSION) throw new Error(`report version ${p.version} is newer than this parser knows (ABI Rev 1.59 = version ${MAX_REPORT_VERSION})`);
  if (!(p.policy & (1n << 17n))) throw new Error("guest policy reserved bit 17 is not 1");
  if (p.policy >> 26n) throw new Error("guest policy bits 63:26 are not zero");
  if (p.signatureAlgo !== 1) throw new Error(`signature algorithm ${p.signatureAlgo} is not ECDSA P-384 with SHA-384 (1)`);
  if (p.signerInfo >>> 5) throw new Error("signer_info bits 31:5 are not zero");
  p.signingKey = (p.signerInfo >>> 2) & 7; p.maskChipKey = !!(p.signerInfo & 2); p.authorKeyEn = !!(p.signerInfo & 1);
  if (p.signingKey !== 0) throw new Error(`report signed by key type ${p.signingKey} (1 = VLEK, 7 = none); only VCEK-signed reports chain to AMD's public roots here`);
  const mbz = (lo, hi, what) => { for (let i = lo; i < hi; i++) if (r[i]) throw new Error(`reserved bytes (${what}) are not zero`); };
  mbz(0x4c, 0x50, "0x4c..0x50"); mbz(p.version >= 3 ? 0x18b : 0x188, 0x1a0, "after CPUID"); mbz(0x1eb, 0x1ec, "0x1eb"); mbz(0x1ef, 0x1f0, "0x1ef");
  if (p.version <= 5) mbz(0x208, SIG_OFFSET, "0x208..0x2a0, version <= 5");
  mbz(SIG_OFFSET + 0x30, SIG_OFFSET + 0x48, "signature R zero-extension"); mbz(SIG_OFFSET + 0x78, SIG_OFFSET + 0x90, "signature S zero-extension"); mbz(SIG_OFFSET + 0x90, REPORT_SIZE, "signature tail");
  p.productHint = snpProductHint(p);
  p.policyBits = { abiMinor: Number(p.policy & 0xffn), abiMajor: Number((p.policy >> 8n) & 0xffn), smt: !!(p.policy & (1n << 16n)), migrateMa: !!(p.policy & (1n << 18n)), debug: !!(p.policy & (1n << 19n)),
    singleSocket: !!(p.policy & (1n << 20n)), cxlAllowed: !!(p.policy & (1n << 21n)), memAes256Xts: !!(p.policy & (1n << 22n)), raplDis: !!(p.policy & (1n << 23n)), ciphertextHidingDram: !!(p.policy & (1n << 24n)), pageSwapDisabled: !!(p.policy & (1n << 25n)) };
  p.platformBits = { smtEnabled: !!(p.platformInfo & 1n), tsmeEnabled: !!(p.platformInfo & 2n), eccEnabled: !!(p.platformInfo & 4n), raplDisabled: !!(p.platformInfo & 8n), ciphertextHidingDram: !!(p.platformInfo & 16n), aliasCheckComplete: !!(p.platformInfo & 32n), tioEnabled: !!(p.platformInfo & 128n) };
  return p;
}

// The VCEK carried in a configfs-tsm auxblob / extended report: {guid(16), offset(4), length(4)}* zero-terminated
export function vcekFromAuxblob(aux) {
  if (!Buffer.isBuffer(aux) || aux.length > 64 * 1024) return null;
  for (let o = 0; o + 24 <= aux.length; o += 24) {
    const guid = hex(aux.subarray(o, o + 16)); if (/^0+$/.test(guid)) break;
    const off = aux.readUInt32LE(o + 16), len = aux.readUInt32LE(o + 20);
    if (guid === VCEK_GUID) return off + len <= aux.length && len > 0 ? aux.subarray(off, off + len) : null;
  }
  return null;
}

export function verifyReportSignature(p, vcekCert) {
  const rBE = Buffer.from(p.signature.subarray(0, 48)).reverse(), sBE = Buffer.from(p.signature.subarray(0x48, 0x48 + 48)).reverse();
  const R = BigInt("0x" + hex(rBE)), S = BigInt("0x" + hex(sBE));
  if (R === 0n || R >= P384_N || S === 0n || S >= P384_N) return { ok: false, why: "signature r or s is out of range for P-384" };
  const k = vcekCert.publicKey;
  if (k.asymmetricKeyType !== "ec" || k.asymmetricKeyDetails?.namedCurve !== "secp384r1") return { ok: false, why: "VCEK public key is not EC P-384" };
  let ok = false;
  try { ok = cryptoVerify("sha384", p.signedRegion, { key: k, dsaEncoding: "ieee-p1363" }, Buffer.concat([rBE, sBE])); } catch (e) { return { ok: false, why: `signature check error: ${e.message}` }; }
  return { ok, why: ok ? null : "VCEK signature over the report is invalid" };
}

const pemCerts = (pem) => String(pem).split(/(?=-----BEGIN CERTIFICATE-----)/).filter((s) => s.includes("CERTIFICATE")).map((s) => new X509Certificate(s));
const inWindow = (c, now) => now >= new Date(c.validFrom) && now <= new Date(c.validTo);

// ASK -> ARK alone: the ARK pinned by sha256 for the product, both subjects as AMD issues them, both valid now, RSA-4096,
// the ARK self-signed and the ASK signed by it. Used by checkChain below and by the collateral cache to authenticate a
// chain before it is stored or served (verifier/collateral-cache.mjs).
export function parseAmdChain({ chainPem, product, now, roots = AMD_ARK_SHA256 }) {
  const fail = (why) => ({ ok: false, why });
  let chain;
  try { chain = pemCerts(chainPem); } catch (e) { return fail(`AMD chain unparseable: ${e.message}`); }
  if (chain.length !== 2) return fail(`AMD cert_chain must be exactly ASK then ARK (got ${chain.length} certificates)`);
  const [ask, ark] = chain;
  const want = roots.get(product);
  if (!want) return fail(`no pinned AMD root for product line ${JSON.stringify(product)} (fail closed)`);
  if (fpHex(ark) !== want) return fail(`the served ARK (${fpHex(ark).slice(0, 16)}...) is not AMD's pinned ${product} root`);
  if (cn(ark.subject) !== `ARK-${product}`) return fail(`ARK subject CN is ${cn(ark.subject)}, expected ARK-${product}`);
  if (cn(ask.subject) !== `SEV-${product}`) return fail(`ASK subject CN is ${cn(ask.subject)}, expected SEV-${product}`);
  for (const [c, what] of [[ark, "ARK"], [ask, "ASK"]]) if (!inWindow(c, now)) return fail(`${what} certificate is not valid at ${now.toISOString()} (${c.validFrom} .. ${c.validTo})`);
  for (const [c, what] of [[ark, "ARK"], [ask, "ASK"]]) if (c.publicKey.asymmetricKeyType !== "rsa" || c.publicKey.asymmetricKeyDetails?.modulusLength !== 4096) return fail(`${what} key is not RSA-4096`);
  if (!ark.verify(ark.publicKey)) return fail("ARK is not self-signed");
  if (!ask.checkIssued(ark) || !ask.verify(ark.publicKey)) return fail("ASK is not signed by the ARK");
  return { ok: true, why: null, ask, ark };
}

// VCEK -> ASK -> ARK, with the ARK pinned, every subject as AMD issues it, and every certificate valid now.
export function checkChain({ vcekDer, chainPem, product, now, roots = AMD_ARK_SHA256 }) {
  const reasons = [], fail = (why) => ({ ok: false, why, reasons });
  let vcek;
  try { vcek = new X509Certificate(vcekDer); } catch (e) { return fail(`VCEK unparseable: ${e.message}`); }
  const c = parseAmdChain({ chainPem, product, now, roots }); if (!c.ok) return fail(c.why);
  const { ask, ark } = c;
  if (cn(vcek.subject) !== "SEV-VCEK") return fail(`VCEK subject CN is ${cn(vcek.subject)}, expected SEV-VCEK`);
  if (cn(vcek.issuer) !== `SEV-${product}`) return fail(`VCEK issuer CN is ${cn(vcek.issuer)}, expected SEV-${product}`);
  if (!inWindow(vcek, now)) return fail(`VCEK certificate is not valid at ${now.toISOString()} (${vcek.validFrom} .. ${vcek.validTo})`);
  if (!vcek.checkIssued(ask) || !vcek.verify(ask.publicKey)) return fail("VCEK is not signed by the ASK");
  reasons.push(`AMD chain verified: VCEK -> ASK (SEV-${product}) -> ARK-${product}, ARK pinned by sha256, all three valid at ${now.toISOString().slice(0, 10)}`);
  return { ok: true, why: null, reasons, vcek, ask, ark };
}

// Is this CRL AMD's, for this ARK: parseable, RSASSA-PSS, issued by the pinned ARK, signed by it, not from the future.
// Says nothing about staleness or revocation (checkCrl judges those): a genuine CRL that revokes the ASK, or one past
// its nextUpdate, is still authentic, and a cache must serve it rather than hide it (verifier/collateral-cache.mjs).
export function checkCrlAuthentic({ crlDer, ark, now }) {
  let crl; try { crl = parseCrl(crlDer); } catch (e) { return { ok: false, why: `CRL unparseable: ${e.message}` }; }
  if (!crl.sigAlgIsRsaPss) return { ok: false, why: `CRL signature algorithm ${crl.algOid} is not RSASSA-PSS` };
  if (!crl.issuerDer.equals(subjectNameDer(ark.raw))) return { ok: false, why: "CRL issuer is not the pinned ARK" };
  let sigOk = false;
  try { sigOk = cryptoVerify("sha384", crl.tbsDer, { key: ark.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, crl.signature); } catch (e) { return { ok: false, why: `CRL signature error: ${e.message}` }; }
  if (!sigOk) return { ok: false, why: "CRL signature does not verify with the pinned ARK" };
  if (now < crl.thisUpdate) return { ok: false, why: `CRL thisUpdate ${crl.thisUpdate.toISOString()} is in the future` };
  return { ok: true, why: null, crl };
}

// The ARK-signed CRL: issuer, signature (RSASSA-PSS SHA-384, salt 48), window, and the ASK's serial.
export function checkCrl({ crlDer, ark, ask, now, mode = "required", maxStaleDays = 0 }) {
  const pre = crlPolicyPrelude({ crlDer, mode }); if (pre) return pre;
  const a = checkCrlAuthentic({ crlDer, ark, now }); if (!a.ok) return { ok: false, checked: false, reasons: [a.why] };
  return judgeCrl({ crl: a.crl, askSerialHex: ask.serialNumber, now, mode, maxStaleDays });
}
// The policy's answer before any bytes are read (mode none, or nothing supplied), else null. Shared with the browser provider.
export function crlPolicyPrelude({ crlDer, mode = "required" }) {
  if (mode === "none") return { ok: true, checked: false, reasons: ["CRL: policy 'none': revocation of the ASK was NOT checked"] };
  if (!crlDer) return mode === "required" ? { ok: false, checked: false, reasons: ["CRL: required by policy but none was supplied"] } : { ok: true, checked: false, reasons: ["CRL: none supplied; policy stale-ok continues WITHOUT a revocation check (say so to the user)"] };
  return null;
}
// Staleness and the ASK's serial, on an ALREADY AUTHENTICATED parsed CRL (verifier/der.mjs parseCrl shape). Pure: no
// crypto, no environment; the Node path and the browser provider both end here so the wording and the rule are one.
export function judgeCrl({ crl, askSerialHex, now, mode = "required", maxStaleDays = 0 }) {
  const reasons = []; let stale = false;
  if (crl.nextUpdate && now > crl.nextUpdate) {
    const staleDays = (now - crl.nextUpdate) / 86400000;
    if (mode === "required" || staleDays > maxStaleDays) return { ok: false, checked: true, reasons: [`CRL is stale: nextUpdate ${crl.nextUpdate.toISOString()} is ${staleDays.toFixed(1)} days past (policy ${mode}${mode === "stale-ok" ? `, max ${maxStaleDays}` : ""})`] };
    reasons.push(`CRL is ${staleDays.toFixed(1)} days past nextUpdate; accepted under policy stale-ok (${maxStaleDays} days)`);
    stale = true;
  }
  const askSerial = String(askSerialHex).toLowerCase().replace(/^0+(?=.)/, "");
  const hit = crl.revoked.find((e) => e.serial.replace(/^0+(?=.)/, "") === askSerial);
  if (hit) return { ok: false, checked: true, reasons: [`the ASK (serial ${askSerialHex}) is REVOKED since ${hit.date.toISOString()}`] };
  reasons.push(`CRL verified (ARK-signed, ${crl.revoked.length} revoked serial(s), valid ${crl.thisUpdate.toISOString().slice(0, 10)} .. ${crl.nextUpdate ? crl.nextUpdate.toISOString().slice(0, 10) : "?"}); ASK serial ${askSerialHex} not revoked`);
  return { ok: true, checked: true, stale, reasons, nextUpdate: crl.nextUpdate };
}

// Node's provider: the functions above, as they are.
export const NODE_CRYPTO = Object.freeze({ checkChain, checkCrl, verifyReportSignature, sha256, checkHostedCertificate, certRaw: (c) => c.raw, certFp: fpHex });

const tcbHex = (b) => hex(b);
const fw = (maj, min, build) => `${maj}.${min} build ${build}`;

// verifySnp(env, policy, context, collateral) -> { status, reasons, checks, claims }
//   env:        parseEnvelope() output ({ format, spec, body, doc })
//   context:    { transportKeySpki, nonce?, expectedBinding?, expectedAppId?, host?, certPem?, auxblob?, now? }
//   collateral: an adapter from verifier/collateral.mjs (chain, vcek, crl); the auxblob wins for the VCEK
export async function verifySnp(env, policy = {}, context = {}, collateral = null) {
  const pol = { ...DEFAULT_SNP_POLICY, ...policy, guestPolicy: { ...DEFAULT_SNP_POLICY.guestPolicy, ...(policy.guestPolicy || {}) } };
  const X = context.crypto || NODE_CRYPTO;   // the certificate and signature provider (see the note above P384_N)
  const now = context.now ? new Date(context.now) : new Date();
  const reasons = [], checks = {}, omissions = [], claims = { technology: "amd-sev-snp", format: env.format, family: env.spec.family };
  const out = (status) => ({ status, admissionSafe: status === "verified", omissions, reasons, checks, claims });
  const omit = (name, why) => { omissions.push(name); reasons.push(`OMITTED (${name}): ${why}`); };
  const fail = (name, why) => { checks[name] = false; reasons.push(`REJECT: ${why}`); return out("rejected"); };
  const pass = (name, why) => { checks[name] = true; reasons.push(why); };

  // 1. shape
  let p; try { p = parseReportStrict(env.body); } catch (e) { return fail("report shape", e.message); }
  Object.assign(claims, { reportVersion: p.version, vmpl: p.vmpl, guestSvn: p.guestSvn, measurement: hex(p.measurement), reportData: hex(p.reportData), hostData: hex(p.hostData), chipId: hex(p.chipId), reportId: hex(p.reportId),
    guestPolicy: p.policyBits, platformInfo: p.platformBits, firmware: { current: fw(p.currentMajor, p.currentMinor, p.currentBuild), committed: fw(p.committedMajor, p.committedMinor, p.committedBuild) },
    idKeyDigest: hex(p.idKeyDigest), authorKeyDigest: hex(p.authorKeyDigest), authorKeyEn: p.authorKeyEn, maskChipKey: p.maskChipKey });
  pass("report shape", `report version ${p.version}, ${REPORT_SIZE} bytes, VCEK-signed, ECDSA P-384, reserved ranges zero`);
  if (p.version > JUDGED_MAX_REPORT_VERSION) {
    claims.unjudgedFields = { currentEtcb: hex(p.currentEtcb), launchEtcb: hex(p.launchEtcb), committedEtcb: hex(p.committedEtcb), reserved0x208: hex(env.body.subarray(0x208, 0x220)), reserved0x280: hex(env.body.subarray(0x280, SIG_OFFSET)) };
    const why = `report version ${p.version} (ABI Rev 1.59) carries CURRENT_ETCB, LAUNCH_ETCB and COMMITTED_ETCB (0x220..0x280) whose policy semantics and reserved ranges this verifier has not implemented or tested; the judged range is versions 2..${JUDGED_MAX_REPORT_VERSION}`;
    if (!pol.researchAllowUnjudgedReportVersions) { checks["report version"] = null; reasons.push(`UNSUPPORTED: ${why}`); return out("unsupported"); }
    checks["report version"] = null; omit("report-version-unjudged", `${why} (researchAllowUnjudgedReportVersions: the verdict can be "limited" at best)`);
  } else checks["report version"] = true;

  // 2. product line
  let product = p.productHint;
  if (!product) { if (p.version >= 3) return fail("product line", `CPUID family 0x${p.cpuidFam.toString(16)} model 0x${p.cpuidMod.toString(16)} is not a known product line`); if (!pol.product) return fail("product line", "report version 2 carries no CPUID; policy.product must name the product line"); product = pol.product; }
  else if (pol.product && pol.product !== product) return fail("product line", `policy expects ${pol.product} but the report's CPUID names ${product}`);
  if (!pol.allowedProducts.includes(product)) return fail("product line", `${product} is not an allowed product line (${pol.allowedProducts.join(", ")})`);
  claims.product = product; pass("product line", `product line ${product}${p.version >= 3 ? " (from the report's CPUID, confirmed below by the chain)" : " (from policy)"}`);

  // 3. guest policy and VMPL
  if (p.policyBits.debug) return fail("guest policy", `guest policy 0x${p.policy.toString(16)} allows DEBUG: the host can read guest memory`);
  if (p.policyBits.migrateMa) return fail("guest policy", `guest policy 0x${p.policy.toString(16)} allows MIGRATE_MA`);
  for (const k of ["smt", "singleSocket", "cxlAllowed", "memAes256Xts", "raplDis", "ciphertextHidingDram", "pageSwapDisabled"]) {
    const want = pol.guestPolicy[k]; if (want === "any" || want === undefined) continue;
    if (!!want !== p.policyBits[k]) return fail("guest policy", `guest policy ${k}=${p.policyBits[k]} but policy requires ${want}`);
  }
  pass("guest policy", `guest policy 0x${p.policy.toString(16)}: DEBUG off, MIGRATE_MA off, SMT ${p.policyBits.smt ? "allowed" : "off"}, ABI ${p.policyBits.abiMajor}.${p.policyBits.abiMinor}`);
  if (!Number.isInteger(pol.expectedVmpl) || pol.expectedVmpl < 0 || pol.expectedVmpl > 3) return fail("vmpl", `policy.expectedVmpl must be 0..3`);
  if (p.vmpl !== pol.expectedVmpl) return fail("vmpl", `report is from VMPL${p.vmpl}, policy expects VMPL${pol.expectedVmpl}`);
  pass("vmpl", p.vmpl === 0 ? "report is from VMPL0 (full privilege inside the guest)" : `report is from VMPL${p.vmpl} as expected (VMPL0..${p.vmpl - 1} of this guest are in its TCB)`);

  // 4. collateral: VCEK (auxblob first), chain, CRL
  const tcb = decodeTcb(product, p.reportedTcb);
  const tcbHexStr = tcbHex(p.reportedTcb), chipHex = hex(p.chipId);
  const prov = (r) => (r ? { source: r.source ?? null, fetchedAt: r.fetchedAt ?? null, cached: r.cached === true, ...(r.stale !== undefined ? { stale: r.stale === true } : {}) } : null);
  claims.collateral = { vcek: null, chain: null, crl: null };   // where each piece came from, as the adapter reports it (never a trust input)
  let vcekDer = context.auxblob ? vcekFromAuxblob(context.auxblob) : null, vcekSource = vcekDer ? "the report's own certificate table" : null;
  if (vcekDer) claims.collateral.vcek = { source: vcekSource, fetchedAt: null, cached: false };
  if (!vcekDer && collateral) { try { const v = await collateral.vcek(product, chipHex, tcbHexStr, kdsVcekUrl(product, p).replace(/^https:\/\/[^/]+\//, "")); if (v) { vcekDer = v.der; vcekSource = v.source; claims.collateral.vcek = prov(v); } } catch (e) { return fail("vcek", `VCEK unavailable: ${e.message}`); } }
  if (!vcekDer) return fail("vcek", "no VCEK: not in the certificate table and no collateral source answered (the chain cannot be verified; nothing below is authenticated)");
  let chainPem; try { const c = await collateral?.chain(product); chainPem = c?.pem; claims.collateral.chain = prov(c); } catch (e) { return fail("chain", `AMD chain unavailable: ${e.message}`); }
  if (!chainPem) return fail("chain", `no AMD ASK/ARK chain for ${product} available`);
  const ch = await X.checkChain({ vcekDer, chainPem, product, now, roots: pol.roots });
  if (!ch.ok) return fail("chain", ch.why);
  checks.chain = true; reasons.push(...ch.reasons); claims.vcekSource = vcekSource; claims.vcekFingerprint = X.certFp(ch.vcek); claims.arkFingerprint = X.certFp(ch.ark);
  let crlDer = null; try { const c = await collateral?.crl?.(product); crlDer = c?.der ?? null; claims.collateral.crl = prov(c); } catch (e) { crlDer = null; claims.collateral.crl = { source: null, fetchedAt: null, cached: false, error: e.message }; }
  const crl = await X.checkCrl({ crlDer, ark: ch.ark, ask: ch.ask, now, mode: pol.crl, maxStaleDays: pol.crlMaxStaleDays });
  reasons.push(...crl.reasons); if (!crl.ok) { checks.crl = false; return out("rejected"); }
  checks.crl = crl.checked ? true : null; claims.crlChecked = crl.checked; if (crl.nextUpdate) claims.crlNextUpdate = crl.nextUpdate.toISOString();
  if (!crl.checked) omit("crl-revocation-unchecked", `ASK revocation was not checked (policy crl: ${pol.crl}${crlDer ? "" : ", no CRL supplied"})`);
  else if (crl.stale) omit("crl-stale-accepted", `the CRL is past nextUpdate and was accepted under policy stale-ok (${pol.crlMaxStaleDays} days)`);

  // 5. signature, VCEK identity, TCB
  const sig = await X.verifyReportSignature(p, ch.vcek); if (!sig.ok) return fail("signature", sig.why);
  pass("signature", "PSP signature over bytes 0..0x2a0 verifies with the VCEK (r, s in range)");
  const mm = vcekMatchesReport(X.certRaw(ch.vcek), product, p); if (mm) return fail("vcek identity", mm);
  pass("vcek identity", `VCEK extensions name this chip (${chipHex.slice(0, 16)}...) and the reported TCB (${TCB_FIELDS[product].map((k) => `${k} ${tcb[k]}`).join(", ")})`);
  claims.tcb = { reported: tcb, current: decodeTcb(product, p.currentTcb), committed: decodeTcb(product, p.committedTcb), launch: decodeTcb(product, p.launchTcb) };
  const t = checkMinTcb(pol.minTcb, product, p); if (!t.ok) return fail("tcb policy", t.reason);
  if (t.checked) { const floor = pol.minTcb[product]; const low = TCB_FIELDS[product].filter((k) => claims.tcb.committed[k] < floor[k]); if (low.length) return fail("tcb policy", `committed TCB below policy: ${low.map((k) => `${k} ${claims.tcb.committed[k]} < ${floor[k]}`).join(", ")} (the platform may roll back to it)`); }
  checks["tcb policy"] = t.checked ? true : null;
  if (t.checked) reasons.push(`${t.reason}; committed TCB meets it too`); else omit("tcb-floor-unjudged", `${t.reason}; the reported TCB is shown in the claims, not judged`);
  if (pol.minFirmware) {
    const { major, minor, build } = pol.minFirmware; const geq = (M, m, b) => M > major || (M === major && (m > minor || (m === minor && b >= build)));
    if (!geq(p.currentMajor, p.currentMinor, p.currentBuild) || !geq(p.committedMajor, p.committedMinor, p.committedBuild)) return fail("firmware", `firmware current ${claims.firmware.current} / committed ${claims.firmware.committed} below policy ${fw(major, minor, build)}`);
    pass("firmware", `firmware ${claims.firmware.current} (committed ${claims.firmware.committed}) meets the floor`);
  }

  // 6. measurement
  const allow = new Set((pol.allowedMeasurements || []).map((m) => String(m).toLowerCase()));
  if (!allow.size) return fail("measurement", "policy names no allowed measurement: a verifier with nothing expected has nothing to compare (fail closed)");
  if (!allow.has(claims.measurement)) return fail("measurement", `launch measurement ${claims.measurement.slice(0, 16)}... is not an allowed measurement`);
  pass("measurement", "launch measurement is one the policy allows (from verified provenance, or the caller's explicit expectation)");

  // 7. binding, by format
  const rd0 = p.reportData.subarray(0, 32), rd1 = p.reportData.subarray(32, 64);
  const spki = context.transportKeySpki;
  if (!Buffer.isBuffer(spki) || spki.length < 44 || spki.length > 2048) return fail("binding", "no transport key SPKI from the verifier's own handshake: the binding cannot be checked (never skipped)");
  const spkiHash = Buffer.from(await X.sha256(spki));
  claims.transportSpkiSha256 = hex(spkiHash);   // the key THIS verifier bound; a consumer compares its own peer key to it (verifier/admission.mjs)
  if (env.spec.binding === "hosted-tinfoil") {
    if (!spkiHash.equals(rd0)) return fail("binding", "report_data[0:32] != sha256(the TLS key this connection presented): the report belongs to another key");
    claims.hpkePublicKey = hex(rd1); claims.tlsSpkiSha256 = hex(spkiHash);
    pass("binding", "report_data[0:32] binds the served TLS key (hosted format: no nonce in the report; freshness rests on the served certificate)");
    if (context.certPem) {
      const c = await X.checkHostedCertificate({ certPem: context.certPem, host: context.host, doc: env.doc, hpkeKeyHex: claims.hpkePublicKey, now });
      reasons.push(...c.reasons); if (!c.ok) { checks["certificate binding"] = false; return out("rejected"); }
      if (c.claims.tlsSpkiSha256 !== claims.tlsSpkiSha256) return fail("certificate binding", "the served certificate's key is not the key the report binds");
      checks["certificate binding"] = true; claims.certificate = c.claims;
    } else if (pol.requireCertificateBinding) return fail("certificate binding", "hosted format requires the served certificate (hatt SAN binds the document; without it a replayed document over a fresh key is not excluded)");
    else { checks["certificate binding"] = null; omit("certificate-binding-unchecked", "the served certificate was not checked (policy.requireCertificateBinding=false): document freshness is not established"); }
  } else if (env.spec.binding === "spki") {
    if (context.nonce && context.nonce.length !== 32) return fail("binding", "nonce must be 32 bytes");
    const want = Buffer.from(context.nonce ? await X.sha256(spki, context.nonce) : spkiHash);
    if (!want.equals(rd0)) return fail("binding", context.nonce ? "report_data[0:32] != sha256(SPKI || nonce): stale, replayed, or another key" : "report_data[0:32] != sha256(SPKI): another key");
    if (!rd1.equals(Buffer.alloc(32))) return fail("binding", "report_data[32:64] is not zero for the metal format");
    if (context.nonce) pass("binding", "report_data[0:32] binds the transport key and this verifier's fresh nonce");
    else { checks.binding = true; reasons.push("report_data[0:32] binds the transport key"); omit("freshness-unbound", "no verifier nonce: the report proves key possession at attest time, not freshness (a replayed report is not excluded)"); }
  } else if (env.spec.binding === "domain") {
    let want, abi;
    if (context.expectedBinding) { if (!Buffer.isBuffer(context.expectedBinding) || context.expectedBinding.length !== 32) return fail("binding", "expectedBinding must be 32 bytes"); want = context.expectedBinding; abi = "ABI/2 (caller-derived Bind2 over key, nonce and runtime identity)"; }
    else if (context.nonce) { if (context.nonce.length !== 32) return fail("binding", "nonce must be 32 bytes"); want = Buffer.from(await X.sha256(spki, context.nonce)); abi = "ABI/1 sha256(SPKI || nonce)"; }
    else return fail("binding", "domain format needs a nonce (ABI/1) or an expectedBinding (ABI/2)");
    if ((env.doc.abi === "enclave-domain-abi/2") !== !!context.expectedBinding) return fail("binding", `the document states abi ${env.doc.abi ?? "enclave-domain-abi/1"} but the verifier expected ${context.expectedBinding ? "ABI/2" : "ABI/1"}: no silent downgrade`);
    if (!want.equals(rd0)) return fail("binding", `report_data[0:32] does not equal the ${abi} binding`);
    if (!Buffer.isBuffer(context.expectedAppId) || context.expectedAppId.length !== 32) return fail("app id", "domain format needs the expected app id (32 bytes)");
    if (!rd1.equals(context.expectedAppId)) return fail("app id", `report_data[32:64] names app ${hex(rd1).slice(0, 16)}..., expected ${hex(context.expectedAppId).slice(0, 16)}...`);
    claims.appId = hex(rd1); claims.abi = env.doc.abi ?? "enclave-domain-abi/1";
    pass("binding", `report_data[0:32] equals the ${abi} binding`); pass("app id", "report_data[32:64] names the expected app");
  } else return fail("binding", `no binding rule for format ${env.format}`);

  // 8. deployment binding (Linux per-app tier, finding F11, 2026-09-24): the report's HOST_DATA is the host's launch-time
  // word, signed by the PSP into every report and outside the launch measurement; the client's expectation is the bytes32
  // deployment id it resolved from the ledger. All-zero HOST_DATA is refused when an expectation is given, never read as
  // unbound. What this cannot close: a host launching another genuine instance under the same id.
  if (context.expectedHostData !== undefined) {
    if (!Buffer.isBuffer(context.expectedHostData) || context.expectedHostData.length !== 32) return fail("host data", "expectedHostData must be exactly 32 bytes (the bytes32 deployment id)");
    if (p.hostData.equals(Buffer.alloc(32))) return fail("host data", "report HOST_DATA is all zero: this guest was launched without a deployment binding, refused when one is expected (never read as unbound)");
    if (!p.hostData.equals(context.expectedHostData)) return fail("host data", `report HOST_DATA names ${hex(p.hostData).slice(0, 16)}..., not the expected deployment ${hex(context.expectedHostData).slice(0, 16)}...`);
    pass("host data", "report HOST_DATA equals the expected deployment id (the host's launch-time binding, PSP-signed)");
  }
  claims.freshness = env.spec.binding === "hosted-tinfoil" ? (checks["certificate binding"] ? "served certificate window" : "none (certificate binding omitted)") : context.nonce || context.expectedBinding ? "verifier nonce" : "none (key possession only)";
  // The only way to "verified": every check true and nothing omitted. Anything relaxed by policy is "limited".
  return out(verdictStatus(omissions));
}
