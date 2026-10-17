// verifier/web/index.mjs: the browser entry. verifyEvidenceWeb(doc, { policy, context, collateral }) gives the same verdict
// shape as verifier/index.mjs verifyEvidence, from the same verifier/snp.mjs code, with verifier/web/provider.mjs as the
// crypto provider. Only AMD SEV-SNP is judged by verifyEvidenceWeb; every other technology is "unsupported" there (the
// delegated classes call Node-only modules), never green. An attached Android pVM host is judged by verifyPvmHostWeb
// (verifier/web/pvm-host.mjs, on the relay's own rules in relay/pvm-evidence-core.mjs), and an Enclave Shield host whole by
// verifyShieldHostWeb (verifier/web/shield-host.mjs, on relay/hvnode-core.mjs), and one app on it by verifyShieldAppWeb
// (verifier/web/shield-app.mjs). The envelope's rules are verifier/envelope.mjs's validateEnvelope; the bytes are decoded here
// with the browser's own primitives (atob) under the same caps.
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

// An attached Android pVM host (relay mode "avf", e.g. pixel10-pvm-cpu), verified IN THIS BROWSER (verifier/web/pvm-host.mjs
// has the rules): a fresh app evidence document over a nonce this page draws, its AVF chain to a Google root pinned here, the
// release, runtime, instance, app and TLS keys under the relay's own rules, and its transport key against the box's attach.
// verifyPvmHostWeb({ apiBase, name, expected?, fetchImpl?, timeoutMs? }) -> { status, technology, name, checkOrder, checkLabels,
// checks, omissions, omissionLabels, reasons, summary, facts }
export { verifyPvmHostWeb, verifyPvmEvidenceWeb, APP_FROM_EVIDENCE } from "./pvm-host.mjs";

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

// ONE APP's Enclave Shield partition (a VBS-isolated Hyper-V partition on that host), verified IN THIS BROWSER
// (verifier/web/shield-app.mjs): the host check above first, then, only if it passed, one app request over a fresh nonce this
// page draws, judged by the relay's own app rules (relay/vbs-app-core.mjs, relay/vbs-vm-report-core.mjs) with the report's
// signature checked under the VSM identity key from the host's TPM-quoted log. Never retried (a 503 "busy" is an error). A
// pass is "limited": the host's omissions, plus the expected app/runtime (relay-derived) and the image list (operator-stated).
// verifyShieldAppWeb({ apiBase, name, deployment, fetchImpl?, timeoutMs? }) -> the verdict shape above, the host's check keys
// followed by the app's.
import { verifyShieldAppWith } from "./shield-app.mjs";
export { verifyShieldAppEvidenceWeb, SHIELD_APP_CHECK_ORDER, SHIELD_APP_CHECK_LABELS, SHIELD_APP_OMISSION_LABELS } from "./shield-app.mjs";
export async function verifyShieldAppWeb({ apiBase = "https://api.enclave.host", name, deployment, fetchImpl = globalThis.fetch, timeoutMs = 60000 } = {}) {
  return verifyShieldAppWith({ fetchImpl, randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)), now: () => new Date() },
                             { apiBase, name, deployment, timeoutMs });
}

// ONE app's own SEV-SNP guest on a confidential server (verifier/web/snp-app.mjs has the flow): the server first
// (verifyMetalBoxWeb), then the app guest's report from the app's own origin over this page's nonce, the binding of the key
// the app's TLS certificate carries, HOST_DATA = the deployment id, the measurement against the relay's published prediction
// (/v1/expected-guest) or a caller pin, and the same AMD chip as the server.
// verifySnpAppWeb({ apiBase, name, deployment, expected?, fetchImpl?, timeoutMs? }) -> the Shield-app verdict shape
import { verifySnpAppWith } from "./snp-app.mjs";
import { TCB_FLOORS as SNP_TCB_FLOORS } from "../metal-box.mjs";
export { SNP_APP_CHECK_ORDER, SNP_APP_CHECK_LABELS, SNP_APP_OMISSION_LABELS } from "./snp-app.mjs";
export async function verifySnpAppWeb({ apiBase = "https://api.enclave.host", name, deployment, expected = null, fetchImpl = globalThis.fetch, timeoutMs = 45000 } = {}) {
  const collateral = httpCollateral({ base: apiBase + KDS_MIRROR_PATH, fetchImpl, timeoutMs });
  return verifySnpAppWith({ fetchImpl, collateral, verify: verifyEvidenceWeb, tcbFloors: SNP_TCB_FLOORS, now: () => new Date(),
                            randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
                            verifyBox: (n) => verifyMetalBoxWeb({ apiBase, name: n, fetchImpl, timeoutMs: Math.min(timeoutMs, 20000) }) },
                          { apiBase, name, deployment, expected, timeoutMs });
}

// ONE app's own protected VM on a phone host (verifier/web/pvm-app.mjs has the flow): the phone first (verifyPvmHostWeb),
// then the app VM's evidence from the app's own origin over this page's nonce under the market's admission rules, the TLS key
// its public certificate carries, and the phone link (its own VM, or a sibling recovering to the phone's proof key here).
// verifyPvmAppWeb({ apiBase, name, deployment, expected?, fetchImpl?, timeoutMs? }) -> the Shield-app verdict shape
import { verifyPvmAppWith } from "./pvm-app.mjs";
import { verifyPvmHostWeb as _verifyPvmHostWeb } from "./pvm-host.mjs";
export { PVM_APP_CHECK_ORDER, PVM_APP_CHECK_LABELS, PVM_APP_OMISSION_LABELS, checkSiblingWeb } from "./pvm-app.mjs";
export async function verifyPvmAppWeb({ apiBase = "https://api.enclave.host", name, deployment, expected = null, fetchImpl = globalThis.fetch, timeoutMs = 45000 } = {}) {
  return verifyPvmAppWith({ fetchImpl, now: () => new Date(), randomBytes: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
                            verifyHost: (n) => _verifyPvmHostWeb({ apiBase, name: n, fetchImpl, timeoutMs: Math.min(timeoutMs, 30000) }) },
                          { apiBase, name, deployment, expected, timeoutMs });
}
