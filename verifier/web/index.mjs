// verifier/web/index.mjs: the browser entry. verifyEvidenceWeb(doc, { policy, context, collateral }) gives the same verdict
// shape as verifier/index.mjs verifyEvidence, from the same verifier/snp.mjs code, with verifier/web/provider.mjs as the
// crypto provider. Only AMD SEV-SNP is judged here; every other technology is "unsupported" in this build (the delegated
// classes call Node-only modules), never green. The envelope's rules are verifier/envelope.mjs's validateEnvelope; the bytes
// are decoded here with the browser's own primitives (atob, DecompressionStream) under the same caps.
//
// Built for a page by verifier/web/build.mjs (esbuild: node:crypto and node:zlib aliased to throwing shims, Buffer from the
// `buffer` package); the same file runs unbundled under Node 22 for the differential and the unit suites.
import { validateEnvelope, EnvelopeError, FORMATS, TECH, MAX_BODY_BYTES, MAX_GUNZIP_BYTES } from "../envelope.mjs";
import { verifySnp } from "../snp.mjs";
import { WEB_CRYPTO } from "./provider.mjs";
import { base64ToBytes, concatBytes } from "./x509.mjs";

export { WEB_CRYPTO } from "./provider.mjs";
export * as x509 from "./x509.mjs";
export { memoryCollateral, httpCollateral } from "./collateral.mjs";
export { createShadow } from "./shadow.mjs";
// release provenance verified in the browser from the signed index's bytes (verifier/web/provenance.mjs); the memory is
// the same module the Node consumers use (verifier/index-memory.mjs), here over localStorage
export { releaseExpectationsFromMirror, createBrowserIndexMemory, MIRROR_PATH, MEMORY_KEY, TRUSTED_ROOT } from "./provenance.mjs";
export { createIndexMemory, webStorageStore, memoryStore } from "../index-memory.mjs";

const unsupported = (technology, why) => ({ status: "unsupported", admissionSafe: false, omissions: [], technology, reasons: [`UNSUPPORTED: ${why}`], checks: {}, claims: null });
const asBuffer = (x) => (x == null ? x : Buffer.isBuffer(x) ? x : Buffer.from(x.buffer ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : x));

export async function gunzipBounded(bytes, cap) {
  const ds = new DecompressionStream("gzip");
  // the writer's promise is settled whatever happens on the reading side: cancelling a stream past the cap rejects it
  const writer = ds.writable.getWriter(); let writeError = null;
  const writing = writer.write(bytes).then(() => writer.close()).catch((e) => { writeError = e; });
  const reader = ds.readable.getReader(); const chunks = []; let n = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      n += value.length; if (n > cap) throw new Error(`gunzip output exceeds ${cap} bytes`);
      chunks.push(value);
    }
  } catch (e) { await reader.cancel().catch(() => {}); await writing; throw e; }
  await writing; if (writeError) throw writeError;
  return concatBytes(...chunks);
}

// decodeEnvelopeWeb(doc) -> { env } or { verdict } (the envelope's refusal, in the verdict shape): validateEnvelope's rules,
// then the bytes with the browser's own primitives under the same caps as parseEnvelope
export async function decodeEnvelopeWeb(doc) {
  if (doc && typeof doc === "object" && FORMATS[doc.format] && FORMATS[doc.format].jsonObject) return { verdict: unsupported(FORMATS[doc.format].technology, `${doc.format} is client-verified pVM evidence, judged by the Node verifier with the owner's module; not in the browser build`) };
  let v;
  try { v = validateEnvelope(doc); }
  catch (e) {
    if (!(e instanceof EnvelopeError)) throw e;
    const technology = FORMATS[doc?.format]?.technology ?? null;
    return { verdict: { status: e.code === "unsupported" ? "unsupported" : "rejected", admissionSafe: false, omissions: [], technology, reasons: [`${e.code.toUpperCase()}: ${e.message}`], checks: {}, claims: null } };
  }
  const malformed = (m) => ({ verdict: { status: "rejected", admissionSafe: false, omissions: [], technology: v.spec.technology, reasons: [`MALFORMED: ${m}`], checks: {}, claims: null } });
  let body = base64ToBytes(v.bodyB64);
  if (body.length > MAX_BODY_BYTES) return malformed("body exceeds the byte cap");
  const gz = body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b;
  if (v.spec.gzip) {
    if (!gz) return malformed(`${v.format}: body must be gzip`);
    try { body = await gunzipBounded(body, MAX_GUNZIP_BYTES); } catch (e) { return malformed(`${v.format}: gzip body unreadable or over the cap (${e.message})`); }
  } else if (gz) return malformed(`${v.format}: body is gzip but the format is not`);
  return { env: { format: v.format, spec: v.spec, body: asBuffer(body), doc, shape: v.shape } };
}

export async function verifyEvidenceWeb(doc, { policy = {}, context = {}, collateral = null } = {}) {
  const d = await decodeEnvelopeWeb(doc); if (d.verdict) return d.verdict;
  const env = d.env, technology = env.spec.technology;
  if (technology !== TECH.SNP) return unsupported(technology, `the browser build judges AMD SEV-SNP evidence only; ${technology} is judged by the Node verifier`);
  const ctx = { ...context, crypto: WEB_CRYPTO };
  for (const k of ["transportKeySpki", "nonce", "expectedAppId", "expectedBinding", "expectedHostData", "auxblob"]) if (ctx[k] != null) ctx[k] = asBuffer(ctx[k]);
  return { technology, ...(await verifySnp(env, policy.snp || {}, ctx, collateral)) };
}
