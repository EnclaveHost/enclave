// verifier/pvm-evidence.mjs: the client side of the pVM owner's client-verified evidence interface
// (format "enclave-pvm-app-evidence/v1", proposed 2026-09-24). The pVM answers a CLIENT's nonce with fresh
// ABI/2 evidence; the owner's relay/pvm-app-attest.mjs verifyPvmAppEvidence judges it (envelope shape, the
// AVF chain to a pinned Google root, the runtime identity, the self-test, the challenge Bind2 || AppID over
// the caller's nonce). This file never parses that evidence: it imports the owner's verifier when present,
// adds only CONSUMER cross-checks of echoed scalars against the client's own values (a hostile relay that
// rewrites the echo is caught here even before the certificate check), and maps the result to the harness
// verdict shape so verifier/admission.mjs can gate on it. Absent the module, the verdict is "unsupported".
import { createHash } from "node:crypto";

export const PVM_EVIDENCE_FORMAT = "enclave-pvm-app-evidence/v1";
export const PVM_EVIDENCE_MAX_BYTES = 256 * 1024;
const hex = (b) => Buffer.from(b).toString("hex");
const isHex = (s, n) => typeof s === "string" && s.length === n && /^[0-9a-f]+$/.test(s);

export async function loadOwnerVerifier() {
  try { const m = await import("../relay/pvm-app-attest.mjs"); return typeof m.verifyPvmAppEvidence === "function" ? m.verifyPvmAppEvidence : null; } catch { return null; }
}

// verifyPvmEvidence(envelope, expect, { verifyImpl?, now? }) -> harness verdict
//   expect: { nonce: Buffer(32), appId: Buffer(32), allowedRuntimeIds, allowedCodeHashes, allowedAuthorityHashes, rootPins }
export async function verifyPvmEvidence(envelope, expect = {}, { verifyImpl = null, now = Date.now() } = {}) {
  const reasons = [], checks = {};
  const out = (status, extra = {}) => ({ status, admissionSafe: status === "verified", omissions: [], technology: "android-avf", reasons, checks, claims: null, ...extra });
  const fail = (m) => { reasons.push(`REJECT: ${m}`); checks.pvmEvidence = false; return out("rejected"); };
  // consumer-side pre-checks: only the client's own values against the echo; no evidence semantics here
  if (!Buffer.isBuffer(expect.nonce) || expect.nonce.length !== 32) return fail("client supplied no 32-byte challenge");
  if (!Buffer.isBuffer(expect.appId) || expect.appId.length !== 32) return fail("client supplied no expected app id");
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return fail("evidence is not an object");
  let size = 0; try { size = Buffer.byteLength(JSON.stringify(envelope)); } catch { return fail("evidence is not serialisable"); }
  if (size > PVM_EVIDENCE_MAX_BYTES) return fail(`evidence exceeds ${PVM_EVIDENCE_MAX_BYTES} bytes`);
  if (envelope.format !== PVM_EVIDENCE_FORMAT) return fail(`format ${JSON.stringify(envelope.format)} is not ${PVM_EVIDENCE_FORMAT}`);
  const nonceHex = hex(expect.nonce), appHex = hex(expect.appId);
  if (!isHex(envelope.nonce, 64) || envelope.nonce !== nonceHex) return fail("the echoed nonce is not this client's challenge (a hostile relay, a replay, or another session's evidence)");
  if (!isHex(envelope.app, 64) || envelope.app !== appHex) return fail("the echoed app id is not the app this client expects");
  checks["echo matches client"] = true; reasons.push("echoed nonce and app id equal the client's own values (consumer cross-check; the certificate challenge is judged below)");
  for (const k of ["allowedRuntimeIds", "allowedCodeHashes", "allowedAuthorityHashes", "rootPins"]) if (!Array.isArray(expect[k]) || !expect[k].length) return fail(`client supplied no ${k}: refusing (fail closed)`);

  const impl = verifyImpl || await loadOwnerVerifier();
  if (!impl) { checks.pvmEvidence = null; reasons.push("UNSUPPORTED: relay/pvm-app-attest.mjs verifyPvmAppEvidence is not in this tree (pVM owner's branch); the evidence cannot be judged here"); return out("unsupported"); }
  let r;
  try { r = await impl(envelope, { nonce: expect.nonce, appId: expect.appId, allowedRuntimeIds: expect.allowedRuntimeIds, allowedCodeHashes: expect.allowedCodeHashes, allowedAuthorityHashes: expect.allowedAuthorityHashes, rootPins: expect.rootPins, now }); }
  catch (e) { return fail(`evidence verifier threw: ${e.message}`); }
  if (!r || typeof r !== "object") return fail("evidence verifier returned nothing");
  reasons.push(...(Array.isArray(r.reasons) ? r.reasons : []));
  if (r.ok !== true) return fail("the evidence verifier refused");
  checks.pvmEvidence = true;
  // the transport key the CLIENT will pin is what the verifier says the evidence bound, never the raw echo
  const transportSpki = Buffer.isBuffer(r.transportSpki) ? hex(r.transportSpki) : typeof r.transportSpki === "string" ? r.transportSpki.toLowerCase() : null;
  if (!transportSpki || !/^[0-9a-f]{88}$/.test(transportSpki)) return fail("the evidence verifier returned no 44-byte Ed25519 transport SPKI to pin");
  const appKey = typeof r.appKey === "string" && /^[0-9a-f]{64}$/.test(r.appKey) ? r.appKey : null;   // application-layer key for browsers (requested; absent in the v1 proposal)
  const runtimeId = typeof r.runtimeId === "string" ? r.runtimeId.toLowerCase() : null;
  return out("verified", { claims: { technology: "android-avf", format: PVM_EVIDENCE_FORMAT, family: "pvm-app", freshness: "client-nonce", nonce: nonceHex, appId: appHex,
    runtimeId, transportSpki, transportSpkiSha256: createHash("sha256").update(Buffer.from(transportSpki, "hex")).digest("hex"), appKey, tlsKey: r.tlsKey ?? null, measurement: r.measurement ?? null } });
}
