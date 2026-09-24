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
// v2 (pVM owner, 2026-09-24, not yet pushed): the closed shape gains appKey (32-byte X25519, 64 hex) and appKeySig
// (Ed25519 under the attested transport key over "enclave-pvm-app-key-v1\n" || nonce || appId || appKey); the
// owner's result carries appKey only after that signature verifies. This is the browser path's key binding.
export const PVM_EVIDENCE_FORMAT_V2 = "enclave-pvm-app-evidence/v2";
export const PVM_EVIDENCE_FORMATS = new Set([PVM_EVIDENCE_FORMAT, PVM_EVIDENCE_FORMAT_V2]);
export const PVM_EVIDENCE_MAX_BYTES = 256 * 1024;
const hex = (b) => Buffer.from(b).toString("hex");
const isHex = (s, n) => typeof s === "string" && s.length === n && /^[0-9a-f]+$/.test(s);

export async function loadOwnerVerifier() {
  try { const m = await import("../relay/pvm-app-attest.mjs"); return typeof m.verifyPvmAppEvidence === "function" ? m.verifyPvmAppEvidence : null; } catch { return null; }
}

// verifyPvmEvidence(envelope, expect, { verifyImpl?, now? }) -> harness verdict
//   expect: { nonce: Buffer(32), appId: Buffer(32), allowedRuntimeIds, allowedCodeHashes, allowedAuthorityHashes, rootPins,
//             formats?: [format strings the CLIENT accepts; default both] }
//   A client that needs the browser key or the sealed channel passes formats: [v2]; a v1 answer is then refused here as a
//   downgrade rather than verified-with-null-appKey (which the gate would still hold for a browser client).
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
  if (!PVM_EVIDENCE_FORMATS.has(envelope.format)) return fail(`format ${JSON.stringify(envelope.format)} is not one of ${[...PVM_EVIDENCE_FORMATS].join(", ")}`);
  const accepted = Array.isArray(expect.formats) ? expect.formats : [...PVM_EVIDENCE_FORMATS];
  if (!accepted.length || accepted.some((f) => !PVM_EVIDENCE_FORMATS.has(f))) return fail("expect.formats must name only known evidence formats");
  if (!accepted.includes(envelope.format)) return fail(`the client accepts ${accepted.join(", ")} but the evidence is ${envelope.format}: a downgrade, refused`);
  const v2 = envelope.format === PVM_EVIDENCE_FORMAT_V2;
  // consumer expectation of the closed shape: v2 carries the browser key and its signature, v1 must not (a relay
  // that strips them from v2 or adds them to v1 produces a malformed envelope, never a silent downgrade)
  if (v2 && (!isHex(envelope.appKey, 64) || !isHex(envelope.appKeySig, 128))) return fail("v2 evidence must carry appKey (64 hex) and appKeySig (128 hex); a stripped key is a malformed envelope, not a downgrade");
  if (!v2 && ("appKey" in envelope || "appKeySig" in envelope)) return fail("v1 evidence must not carry appKey/appKeySig");
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
  // the application-layer key for browsers: taken from the owner's RESULT (present only once appKeySig verified), and
  // it must equal the envelope's field so a relay cannot make the verifier vouch for one key and the client pin another
  const appKey = typeof r.appKey === "string" && /^[0-9a-f]{64}$/.test(r.appKey) ? r.appKey : null;
  if (v2 && (!appKey || appKey !== envelope.appKey)) return fail("v2: the verifier did not vouch for the envelope's appKey (signature not verified, or another key)");
  if (!v2 && appKey) return fail("v1: the verifier returned an appKey the format cannot carry");
  const runtimeId = typeof r.runtimeId === "string" ? r.runtimeId.toLowerCase() : null;
  // v2: the sealed-channel constants the VM enforces, as the verifier reports them (a client schedules re-attestation from these)
  const sealed = v2 && Number.isInteger(r.sealedWindowSeconds) && Number.isInteger(r.sealedMaxRequests) ? { windowSeconds: r.sealedWindowSeconds, maxRequests: r.sealedMaxRequests } : null;
  if (v2 && !sealed) return fail("v2: the verifier reported no sealed-channel window (sealedWindowSeconds, sealedMaxRequests)");
  return out("verified", { claims: { technology: "android-avf", format: envelope.format, family: "pvm-app", freshness: "client-nonce", nonce: nonceHex, appId: appHex,
    runtimeId, transportSpki, transportSpkiSha256: createHash("sha256").update(Buffer.from(transportSpki, "hex")).digest("hex"), appKey, sealed, tlsKey: r.tlsKey ?? null, measurement: r.measurement ?? null } });
}
