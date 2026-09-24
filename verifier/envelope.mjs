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
// Field kinds for the per-format shapes below: b64(max chars), hex(n chars, lowercase), str(max), obj (a JSON object),
// oneOf(values). A field marked required must be present; an absent optional field is simply absent.
const b64 = (max, required = false) => ({ kind: "b64", max, required }), hexF = (n, required = false) => ({ kind: "hex", n, required });
const str = (max, required = false) => ({ kind: "str", max, required }), obj = (required = false) => ({ kind: "obj", required }), oneOf = (values, required = false) => ({ kind: "oneOf", values, required });
export const MAX_DOC_BYTES = 1024 * 1024, MAX_DOC_KEYS = 32;
// The shapes, from the producers as they are (metal/guest/agent.mjs, isolation/m2/front, relay/tunnel.js, windows/node/agent.mjs,
// windows/vbslike/verify/judge-hv.mjs) and the fields this verifier reads (snp.mjs: abi; index.mjs: padKey):
//   hosted: exactly { format, body }, CLOSED, because the served certificate binds sha256(format + body) and nothing else;
//   metal:  { format, body } plus the agent's transport key and its UNSIGNED informational fields (certs, name, manifest,
//           volumes, padKey), open because those evolve; each declared field is validated when present, never trusted;
//   domain: the report in `report` (never `body`), the domain's own claims (tier, transportKey, appSha256, nonce, abi,
//           runtime, runtimeSelfTest, certs, boundary, reason) validated for shape only: the binding decides, not these;
//   avf:    { format, body } plus transportKey and, for v2, the pad key the transcript binds (required, 32 bytes hex);
//   vbs / hyperv: judged elsewhere; parsed here to a body so the verdict can say "unsupported" for a well-formed one.
const SHAPES = {
  hosted: { body: "body", closed: true, fields: {} },
  metal: { body: "body", closed: false, fields: { transportKey: b64(4096), transportKeyFp: hexF(64), padKey: hexF(64), certs: b64(96 * 1024), name: str(128), manifest: obj(), volumes: obj() } },
  domain: { body: "report", closed: false, fields: { tier: str(16), transportKey: b64(4096), appSha256: hexF(64), nonce: hexF(64), abi: oneOf(["enclave-domain-abi/1", "enclave-domain-abi/2"]), runtime: obj(), runtimeSelfTest: str(4096), certs: b64(96 * 1024), boundary: obj(), reason: str(1024) } },
  avf1: { body: "body", closed: false, fields: { transportKey: b64(4096), padKey: hexF(64) } },
  avf2: { body: "body", closed: false, fields: { transportKey: b64(4096), padKey: hexF(64, true) } },
  vbs: { body: "body", closed: false, fields: { transportKey: b64(4096), padKey: hexF(64) } },
  hyperv: { body: "report", closed: false, fields: { tier: str(16), nonce: hexF(64), appSha256: hexF(64), transportKey: b64(4096), reason: str(1024) } },
};
export const FORMATS = Object.freeze({
  "https://tinfoil.sh/predicate/sev-snp-guest/v2": { technology: TECH.SNP, family: "hosted-tinfoil", binding: "hosted-tinfoil", gzip: true, supported: true, shape: SHAPES.hosted },
  "https://tinfoil.sh/predicate/sev-snp-guest/v1": { technology: TECH.SNP, family: "hosted-tinfoil", binding: "hosted-tinfoil", gzip: false, supported: false, why: "legacy Tinfoil v1 predicate" },
  "sev-snp-guest-metal-v1":     { technology: TECH.SNP, family: "metal",  binding: "spki",   gzip: false, supported: true, shape: SHAPES.metal },
  "sev-snp-guest-domain-v1":    { technology: TECH.SNP, family: "domain", binding: "domain", gzip: false, supported: true, shape: SHAPES.domain },
  "tdx-guest-metal-v1":         { technology: TECH.TDX, family: "metal",  binding: "spki",   gzip: false, supported: false, why: "Intel TDX quote verification is not implemented (DCAP collateral, QE identity, TCB info)" },
  "https://tinfoil.sh/predicate/tdx-guest/v1": { technology: TECH.TDX, family: "hosted-tinfoil", binding: "hosted-tinfoil", gzip: true, supported: false, why: "Intel TDX quote verification is not implemented" },
  "android-avf-pvm/v1":         { technology: TECH.AVF, family: "pvm", binding: "avf-transcript", gzip: false, supported: "delegate", shape: SHAPES.avf1 },
  "android-avf-pvm/v2":         { technology: TECH.AVF, family: "pvm", binding: "avf-pad-transcript", gzip: false, supported: "delegate", shape: SHAPES.avf2 },
  // client-verified pVM app evidence (pVM owner's proposal, 2026-09-24): a JSON object, not a base64 body; routed
  // by verifier/index.mjs to verifier/pvm-evidence.mjs before parseEnvelope, which is why it has no body here
  "enclave-pvm-app-evidence/v1": { technology: TECH.AVF, family: "pvm-app", binding: "abi2-client-nonce", gzip: false, supported: "delegate", jsonObject: true },
  "enclave-pvm-app-evidence/v2": { technology: TECH.AVF, family: "pvm-app", binding: "abi2-client-nonce", gzip: false, supported: "delegate", jsonObject: true, appKey: true },
  // v3 (INSTANCE-BINDING.md, 2026-09-24): v2 plus the VM instance inside the challenge (Bind3) and an instance signature
  "enclave-pvm-app-evidence/v3": { technology: TECH.AVF, family: "pvm-app", binding: "abi3-client-nonce-instance", gzip: false, supported: "delegate", jsonObject: true, appKey: true, instance: true },
  "windows-vbs-enclave/v1":     { technology: TECH.VBS, family: "consumer-node", binding: "vbs-transcript", gzip: false, supported: "delegate", shape: SHAPES.vbs },
  "hyperv-partition-domain/v1": { technology: TECH.HYPERV, family: "domain", binding: "domain", gzip: false, supported: "delegate", hostExcluded: false, shape: SHAPES.hyperv },
  "dev-unattested-metal-v1":    { technology: TECH.NONE, family: "dev", binding: null, gzip: false, supported: false, rejected: true, why: "development format: proves nothing about hardware by definition" },
  "none":                       { technology: TECH.NONE, family: "t0", binding: null, gzip: false, supported: false, rejected: true, why: "a T0 domain has no hardware report" },
});

export const MAX_BODY_B64 = 64 * 1024, MAX_BODY_BYTES = 64 * 1024, MAX_GUNZIP_BYTES = 64 * 1024;

export class EnvelopeError extends Error { constructor(code, msg) { super(msg); this.code = code; } }   // code: malformed | unsupported | rejected

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// the syntax checks alone (no bytes): the browser build decodes with its own primitives after these
export function checkBase64(s, max, what) {
  if (typeof s !== "string" || !s.length) throw new EnvelopeError("malformed", `${what}: missing`);
  if (s.length > max) throw new EnvelopeError("malformed", `${what}: ${s.length} chars exceeds the ${max}-char cap`);
  if (!B64.test(s)) throw new EnvelopeError("malformed", `${what}: not strict base64`);
  return s;
}
export function strictBase64(s, max, what) { return Buffer.from(checkBase64(s, max, what), "base64"); }
const utf8Length = (s) => (typeof Buffer !== "undefined" ? Buffer.byteLength(s) : new TextEncoder().encode(s).length);

// validateEnvelope(doc) -> { format, spec, shape, bodyB64 }: every rule of the envelope that needs no byte decoding, in the
// order parseEnvelope applies them. parseEnvelope (Node) and the browser build both start here and only then decode.
export function validateEnvelope(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new EnvelopeError("malformed", "evidence is not an object");
  if (typeof doc.format !== "string" || !doc.format || doc.format.length > 200) throw new EnvelopeError("malformed", "evidence.format is not a short string");
  const spec = FORMATS[doc.format];
  if (!spec) throw new EnvelopeError("unsupported", `unknown evidence format ${JSON.stringify(doc.format)}: nothing is known about what it proves`);
  if (spec.rejected) throw new EnvelopeError("rejected", `${doc.format}: ${spec.why}`);
  if (spec.supported === false) throw new EnvelopeError("unsupported", `${doc.format}: ${spec.why}`);
  const shape = spec.shape || { body: "body", closed: false, fields: {} };
  // the whole document, bounded: a verifier that parses an unbounded JSON object has already lost
  const keys = Object.keys(doc);
  if (keys.length > MAX_DOC_KEYS) throw new EnvelopeError("malformed", `${doc.format}: ${keys.length} top-level fields exceeds the cap of ${MAX_DOC_KEYS}`);
  let size = 0; try { size = utf8Length(JSON.stringify(doc)); } catch { throw new EnvelopeError("malformed", `${doc.format}: the document is not serialisable`); }
  if (size > MAX_DOC_BYTES) throw new EnvelopeError("malformed", `${doc.format}: ${size} bytes exceeds the document cap of ${MAX_DOC_BYTES}`);
  // the body field is the one this format names, exactly: a document carrying the other name is another format's shape
  const other = shape.body === "body" ? "report" : "body";
  if (other in doc) throw new EnvelopeError("malformed", `${doc.format}: carries \`${other}\` but this format's body field is \`${shape.body}\` (no alias)`);
  if (!(shape.body in doc)) throw new EnvelopeError("malformed", `${doc.format} ${shape.body}: missing`);
  // a closed shape admits nothing beyond format, the body and its declared fields; an open one tolerates unknown fields,
  // which nothing here ever reads, and validates every declared field it does read
  const allowed = new Set(["format", shape.body, ...Object.keys(shape.fields)]);
  if (shape.closed) for (const k of keys) if (!allowed.has(k)) throw new EnvelopeError("malformed", `${doc.format}: unexpected field \`${k}\` (the format's shape is closed: nothing outside it is bound or read)`);
  for (const [name, f] of Object.entries(shape.fields)) {
    if (!(name in doc)) { if (f.required) throw new EnvelopeError("malformed", `${doc.format}: ${name} is required by this format`); continue; }
    const v = doc[name], bad = (why) => { throw new EnvelopeError("malformed", `${doc.format}: ${name} ${why}`); };
    if (f.kind === "b64") { if (typeof v !== "string" || !v.length) bad("must be a non-empty base64 string"); if (v.length > f.max) bad(`exceeds ${f.max} chars`); if (!B64.test(v)) bad("is not strict base64"); }
    else if (f.kind === "hex") { if (typeof v !== "string" || v.length !== f.n || !/^[0-9a-f]+$/.test(v)) bad(`must be ${f.n} lowercase hex chars`); }
    else if (f.kind === "str") { if (typeof v !== "string" || v.length > f.max) bad(`must be a string of at most ${f.max} chars`); }
    else if (f.kind === "obj") { if (!v || typeof v !== "object" || Array.isArray(v)) bad("must be a JSON object"); }
    else if (f.kind === "oneOf") { if (!f.values.includes(v)) bad(`must be one of ${f.values.join(", ")}`); }
  }
  const bodyB64 = checkBase64(doc[shape.body], MAX_BODY_B64, `${doc.format} ${shape.body}`);
  return { format: doc.format, spec, shape, bodyB64 };
}

// parseEnvelope(doc) -> { format, spec, body: Buffer, doc, shape }
export function parseEnvelope(doc) {
  const { spec, shape, bodyB64 } = validateEnvelope(doc);
  let body = Buffer.from(bodyB64, "base64");
  if (body.length > MAX_BODY_BYTES) throw new EnvelopeError("malformed", "body exceeds the byte cap");
  const gz = body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;
  if (spec.gzip) {
    if (!gz) throw new EnvelopeError("malformed", `${doc.format}: body must be gzip`);
    try { body = gunzipSync(body, { maxOutputLength: MAX_GUNZIP_BYTES }); }
    catch (e) { throw new EnvelopeError("malformed", `${doc.format}: gzip body unreadable or over the cap (${e.message})`); }
  } else if (gz) throw new EnvelopeError("malformed", `${doc.format}: body is gzip but the format is not`);
  return { format: doc.format, spec, body, doc, shape };
}
