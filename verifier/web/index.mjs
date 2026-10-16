// verifier/web/index.mjs: the browser entry. verifyEvidenceWeb(doc, { policy, context, collateral }) gives the same verdict
// shape as verifier/index.mjs verifyEvidence, from the same verifier/snp.mjs code, with verifier/web/provider.mjs as the
// crypto provider. Only AMD SEV-SNP is judged here; every other technology is "unsupported" in this build (the delegated
// classes call Node-only modules), never green; an Enclave Shield host is verified whole by verifyShieldHostWeb (below).
// The envelope's rules are verifier/envelope.mjs's validateEnvelope; the bytes are decoded here with the browser's own
// primitives (atob) under the same caps.
//
// Built for a page by verifier/web/build.mjs (esbuild: node:crypto aliased to a throwing shim, Buffer from the
// `buffer` package); the same file runs unbundled under Node 22 for the differential and the unit suites.
import { validateEnvelope, EnvelopeError, FORMATS, TECH, MAX_BODY_BYTES, isGzip } from "../envelope.mjs";
import { verifySnp } from "../snp.mjs";
import { WEB_CRYPTO } from "./provider.mjs";
import { base64ToBytes } from "./x509.mjs";

export { WEB_CRYPTO } from "./provider.mjs";
export * as x509 from "./x509.mjs";
export { memoryCollateral, httpCollateral } from "./collateral.mjs";
import { httpCollateral } from "./collateral.mjs";
import { verifyMetalBoxWith } from "../metal-box.mjs";
export { TCB_FLOORS, FRESH_ATTESTATION_PATH, OPERATOR_STATED } from "../metal-box.mjs";

const unsupported = (technology, why) => ({ status: "unsupported", admissionSafe: false, omissions: [], technology, reasons: [`UNSUPPORTED: ${why}`], checks: {}, claims: null });
const asBuffer = (x) => (x == null ? x : Buffer.isBuffer(x) ? x : Buffer.from(x.buffer ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : x));

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
  const body = base64ToBytes(v.bodyB64);
  if (body.length > MAX_BODY_BYTES) return malformed("body exceeds the byte cap");
  if (isGzip(body)) return malformed(`${v.format}: body is gzip but the format is not`);
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

// An attached metal SEV-SNP box, verified IN THIS BROWSER (verifier/metal-box.mjs has the rules): a fresh document over a nonce
// this page draws, AMD collateral through the relay's KDS mirror (bytes only: the chain is checked against the pinned AMD
// root here), the measurement against a caller pin or - labelled, never "verified" - the relay operator's allowlist.
export const KDS_MIRROR_PATH = "/v1/amd-kds";
export async function verifyMetalBoxWeb({ apiBase = "https://api.enclave.host", name, expected = null, minTcb = undefined, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const collateral = httpCollateral({ base: apiBase + KDS_MIRROR_PATH, fetchImpl, timeoutMs });
  return verifyMetalBoxWith({ fetchImpl, verify: verifyEvidenceWeb, collateral,
                              randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
                              sha256: async (b) => new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", b)),
                              toBytes: (u) => u, now: () => new Date() },
                            { apiBase, name, expected, minTcb, timeoutMs });
}

// An attached Enclave Shield host (the NucBox hv-node: a Windows Hyper-V host attested by its TPM), verified IN THIS BROWSER
// (verifier/web/shield-host.mjs has the flow, relay/hvnode-core.mjs the rules the relay also runs): this page draws the
// nonce AND mints the TPM credential, so the relay cannot stand in for the TPM. A pass is "limited", never "verified":
// Shield does not exclude the host, and PCR 0 has no independent pin.
import { verifyShieldHostWith } from "./shield-host.mjs";
export { verifyHvNodeEvidenceWeb, makeCredentialWeb, TPM_EK_ROOTS_PEM, TPM_EK_ROOT_PINS, SHIELD_CHECK_ORDER, SHIELD_CHECK_LABELS, SHIELD_OMISSION_LABELS } from "./shield-host.mjs";
export async function verifyShieldHostWeb({ apiBase = "https://api.enclave.host", name, fetchImpl = globalThis.fetch, timeoutMs = 45000 } = {}) {
  return verifyShieldHostWith({ fetchImpl, randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)), now: () => new Date() },
                              { apiBase, name, timeoutMs });
}
