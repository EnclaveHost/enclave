// verifier/envelope.mjs: the closed registry of evidence formats and the strict envelope parser.
//
// Everything a client is asked to verify arrives as {format, body} plus format-specific fields. This file
// decides what the format MEANS (technology, family, which binding rule, whether the body is gzipped) and
// refuses what it does not know. The verdict for an unknown format is "unsupported", never green; the
// verdict for a development format is "rejected", because those prove nothing by their own definition.
import { gunzipSync } from "node:zlib";

export const TECH = { SNP: "amd-sev-snp", TDX: "intel-tdx", AVF: "android-avf", VBS: "windows-vbs-enclave", HYPERV: "hyperv-partition", NONE: "none" };

// binding: how report_data[0:32] (or the platform's equivalent) relates to the verifier's own inputs
//   hosted-tinfoil  sha256(TLS SPKI); [32:64] = HPKE public key; freshness rests on the served certificate
//   spki            sha256(SPKI), or sha256(SPKI || nonce) when the verifier issued a nonce (metal attach)
//   domain          ABI/1 sha256(SPKI || nonce) or ABI/2 Bind2 (caller-supplied bytes); [32:64] = AppID
export const FORMATS = Object.freeze({
  "https://tinfoil.sh/predicate/sev-snp-guest/v2": { technology: TECH.SNP, family: "hosted-tinfoil", binding: "hosted-tinfoil", gzip: true, supported: true },
  "https://tinfoil.sh/predicate/sev-snp-guest/v1": { technology: TECH.SNP, family: "hosted-tinfoil", binding: "hosted-tinfoil", gzip: false, supported: false, why: "legacy Tinfoil v1 predicate" },
  "sev-snp-guest-metal-v1":     { technology: TECH.SNP, family: "metal",  binding: "spki",   gzip: false, supported: true },
  "sev-snp-guest-domain-v1":    { technology: TECH.SNP, family: "domain", binding: "domain", gzip: false, supported: true },
  "tdx-guest-metal-v1":         { technology: TECH.TDX, family: "metal",  binding: "spki",   gzip: false, supported: false, why: "Intel TDX quote verification is not implemented (DCAP collateral, QE identity, TCB info)" },
  "https://tinfoil.sh/predicate/tdx-guest/v1": { technology: TECH.TDX, family: "hosted-tinfoil", binding: "hosted-tinfoil", gzip: true, supported: false, why: "Intel TDX quote verification is not implemented" },
  "android-avf-pvm/v1":         { technology: TECH.AVF, family: "pvm", binding: "avf-transcript", gzip: false, supported: "delegate" },
  "android-avf-pvm/v2":         { technology: TECH.AVF, family: "pvm", binding: "avf-pad-transcript", gzip: false, supported: "delegate" },
  // client-verified pVM app evidence (pVM owner's proposal, 2026-09-24): a JSON object, not a base64 body; routed
  // by verifier/index.mjs to verifier/pvm-evidence.mjs before parseEnvelope, which is why it has no body here
  "enclave-pvm-app-evidence/v1": { technology: TECH.AVF, family: "pvm-app", binding: "abi2-client-nonce", gzip: false, supported: "delegate", jsonObject: true },
  "windows-vbs-enclave/v1":     { technology: TECH.VBS, family: "consumer-node", binding: "vbs-transcript", gzip: false, supported: "delegate" },
  "hyperv-partition-domain/v1": { technology: TECH.HYPERV, family: "domain", binding: "domain", gzip: false, supported: "delegate", hostExcluded: false },
  "dev-unattested-metal-v1":    { technology: TECH.NONE, family: "dev", binding: null, gzip: false, supported: false, rejected: true, why: "development format: proves nothing about hardware by definition" },
  "none":                       { technology: TECH.NONE, family: "t0", binding: null, gzip: false, supported: false, rejected: true, why: "a T0 domain has no hardware report" },
});

export const MAX_BODY_B64 = 64 * 1024, MAX_BODY_BYTES = 64 * 1024, MAX_GUNZIP_BYTES = 64 * 1024, MAX_EXTRA_FIELD = 8 * 1024 * 1024;

export class EnvelopeError extends Error { constructor(code, msg) { super(msg); this.code = code; } }   // code: malformed | unsupported | rejected

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export function strictBase64(s, max, what) {
  if (typeof s !== "string" || !s.length) throw new EnvelopeError("malformed", `${what}: missing`);
  if (s.length > max) throw new EnvelopeError("malformed", `${what}: ${s.length} chars exceeds the ${max}-char cap`);
  if (!B64.test(s)) throw new EnvelopeError("malformed", `${what}: not strict base64`);
  return Buffer.from(s, "base64");
}

// parseEnvelope(doc) -> { format, spec, body: Buffer, doc }
export function parseEnvelope(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new EnvelopeError("malformed", "evidence is not an object");
  if (typeof doc.format !== "string" || !doc.format || doc.format.length > 200) throw new EnvelopeError("malformed", "evidence.format is not a short string");
  const spec = FORMATS[doc.format];
  if (!spec) throw new EnvelopeError("unsupported", `unknown evidence format ${JSON.stringify(doc.format)}: nothing is known about what it proves`);
  if (spec.rejected) throw new EnvelopeError("rejected", `${doc.format}: ${spec.why}`);
  if (spec.supported === false) throw new EnvelopeError("unsupported", `${doc.format}: ${spec.why}`);
  const bodyField = doc.body ?? doc.report;      // domain documents say "report", the shim says "body"
  let body = strictBase64(bodyField, MAX_BODY_B64, `${doc.format} body`);
  if (body.length > MAX_BODY_BYTES) throw new EnvelopeError("malformed", "body exceeds the byte cap");
  const gz = body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;
  if (spec.gzip) {
    if (!gz) throw new EnvelopeError("malformed", `${doc.format}: body must be gzip`);
    try { body = gunzipSync(body, { maxOutputLength: MAX_GUNZIP_BYTES }); }
    catch (e) { throw new EnvelopeError("malformed", `${doc.format}: gzip body unreadable or over the cap (${e.message})`); }
  } else if (gz) throw new EnvelopeError("malformed", `${doc.format}: body is gzip but the format is not`);
  return { format: doc.format, spec, body, doc };
}
