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
// v3 (pVM owner, INSTANCE-BINDING.md, bytes agreed 2026-09-24, implemented at 193cf823): v2 plus instanceKey (the instance
// key's 44-byte Ed25519 SPKI, 88 hex) and instanceSig (128 hex); the challenge is Bind3(spki, nonce, RuntimeID, InstanceID)
// || AppID with InstanceID = SHA-256(instanceKey); appKeySig signs under a v3 domain and covers the InstanceID. A client
// whose selected deployment is BOUND to instances passes expect.instanceIds, and then only v3 naming a listed instance can
// verify; v1 and v2 are refused as a downgrade. InstanceID is never a field: every verifier computes it.
export const PVM_EVIDENCE_FORMAT_V3 = "enclave-pvm-app-evidence/v3";
export const PVM_EVIDENCE_FORMATS = new Set([PVM_EVIDENCE_FORMAT, PVM_EVIDENCE_FORMAT_V2, PVM_EVIDENCE_FORMAT_V3]);
export const MAX_INSTANCES = 8;
const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
export const PVM_EVIDENCE_MAX_BYTES = 256 * 1024;
const hex = (b) => Buffer.from(b).toString("hex");
const isHex = (s, n) => typeof s === "string" && s.length === n && /^[0-9a-f]+$/.test(s);

// Where the owner's module comes from, in order: ENCLAVE_PVM_MODULE (an absolute path resolved by
// verifier/integration/resolve.mjs from the pinned commit), else ../relay/pvm-app-attest.mjs in this tree (present
// once the owner's branch lands on main). ENCLAVE_STRICT_INTEGRATION=1 turns "absent" into an error, so an
// acceptance run can never pass by skipping.
export const STRICT_INTEGRATION = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
export async function loadOwnerModule() {
  const explicit = process.env.ENCLAVE_PVM_MODULE;
  try {
    const m = await import(explicit ? (await import("node:url")).pathToFileURL(explicit).href : "../relay/pvm-app-attest.mjs");
    if (typeof m.verifyPvmAppEvidence !== "function") throw new Error("module has no verifyPvmAppEvidence export");
    return m;
  } catch (e) {
    if (STRICT_INTEGRATION) throw new Error(`strict integration: the owner's module is missing or unusable (${explicit || "../relay/pvm-app-attest.mjs"}): ${e.message}`);
    return null;
  }
}
export async function loadOwnerVerifier() { const m = await loadOwnerModule(); return m ? m.verifyPvmAppEvidence : null; }

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
  // instance binding: a deployment bound to instances (the signed policy's word) admits v3 naming one of them, nothing else
  const bound = expect.instanceIds !== undefined;
  if (bound && (!Array.isArray(expect.instanceIds) || !expect.instanceIds.length || expect.instanceIds.length > MAX_INSTANCES || !expect.instanceIds.every((i) => isHex(i, 64)) || new Set(expect.instanceIds).size !== expect.instanceIds.length)) return fail(`expect.instanceIds must be 1..${MAX_INSTANCES} unique InstanceIDs (64 lowercase hex) when given`);
  if (bound && envelope.format !== PVM_EVIDENCE_FORMAT_V3) return fail(`the selected deployment is bound to instances, which only ${PVM_EVIDENCE_FORMAT_V3} names: ${envelope.format} is refused as a downgrade (v3 required)`);
  const v2 = envelope.format === PVM_EVIDENCE_FORMAT_V2, v3 = envelope.format === PVM_EVIDENCE_FORMAT_V3, keyed = v2 || v3;
  // consumer expectation of the closed shape: v2 and v3 carry the browser key and its signature, v1 must not; v3 carries the
  // instance key and signature, v1 and v2 must not (a relay that strips or adds them produces a malformed envelope, never a
  // silent downgrade)
  if (keyed && (!isHex(envelope.appKey, 64) || !isHex(envelope.appKeySig, 128))) return fail(`${envelope.format} evidence must carry appKey (64 hex) and appKeySig (128 hex); a stripped key is a malformed envelope, not a downgrade`);
  if (!keyed && ("appKey" in envelope || "appKeySig" in envelope)) return fail("v1 evidence must not carry appKey/appKeySig");
  if (v3 && (!isHex(envelope.instanceKey, 88) || !isHex(envelope.instanceSig, 128))) return fail("v3 evidence must carry instanceKey (a 44-byte Ed25519 SPKI, 88 hex) and instanceSig (128 hex); a stripped instance is a malformed envelope, not a downgrade");
  if (!v3 && ("instanceKey" in envelope || "instanceSig" in envelope)) return fail(`${envelope.format} evidence must not carry instanceKey/instanceSig`);
  const nonceHex = hex(expect.nonce), appHex = hex(expect.appId);
  if (!isHex(envelope.nonce, 64) || envelope.nonce !== nonceHex) return fail("the echoed nonce is not this client's challenge (a hostile relay, a replay, or another session's evidence)");
  if (!isHex(envelope.app, 64) || envelope.app !== appHex) return fail("the echoed app id is not the app this client expects");
  checks["echo matches client"] = true; reasons.push("echoed nonce and app id equal the client's own values (consumer cross-check; the certificate challenge is judged below)");
  for (const k of ["allowedRuntimeIds", "allowedCodeHashes", "allowedAuthorityHashes", "rootPins"]) if (!Array.isArray(expect[k]) || !expect[k].length) return fail(`client supplied no ${k}: refusing (fail closed)`);

  const impl = verifyImpl || await loadOwnerVerifier();
  if (!impl) { checks.pvmEvidence = null; reasons.push("UNSUPPORTED: relay/pvm-app-attest.mjs verifyPvmAppEvidence is not in this tree (pVM owner's branch); the evidence cannot be judged here"); return out("unsupported"); }
  let r;
  try { r = await impl(envelope, { nonce: expect.nonce, appId: expect.appId, ...(bound ? { instanceIds: [...expect.instanceIds] } : {}), allowedRuntimeIds: expect.allowedRuntimeIds, allowedCodeHashes: expect.allowedCodeHashes, allowedAuthorityHashes: expect.allowedAuthorityHashes, rootPins: expect.rootPins, now }); }
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
  if (keyed && (!appKey || appKey !== envelope.appKey)) return fail(`${envelope.format}: the verifier did not vouch for the envelope's appKey (signature not verified, or another key)`);
  if (!keyed && appKey) return fail("v1: the verifier returned an appKey the format cannot carry");
  // v3: the InstanceID the verifier vouches for must be SHA-256 of the envelope's instance key (its definition), and, for a
  // bound deployment, one of the instances the policy names; v1 and v2 can carry no instance
  const instanceId = typeof r.instanceId === "string" && isHex(r.instanceId, 64) ? r.instanceId : null;
  if (v3 && (!instanceId || instanceId !== sha256hex(Buffer.from(envelope.instanceKey, "hex")))) return fail("v3: the verifier's InstanceID is not SHA-256 of the envelope's instanceKey (INSTANCE-BINDING.md)");
  if (!v3 && instanceId) return fail(`${envelope.format}: the verifier returned an InstanceID the format cannot carry`);
  if (bound && !expect.instanceIds.includes(instanceId)) return fail("the verified InstanceID is not one bound to the selected deployment (consumer cross-check of the verifier's own refusal)");
  const runtimeId = typeof r.runtimeId === "string" ? r.runtimeId.toLowerCase() : null;
  // v2: the sealed-channel constants the VM enforces, as the verifier reports them (a client schedules re-attestation from these)
  const sealed = keyed && Number.isInteger(r.sealedWindowSeconds) && Number.isInteger(r.sealedMaxRequests) ? { windowSeconds: r.sealedWindowSeconds, maxRequests: r.sealedMaxRequests } : null;
  if (keyed && !sealed) return fail(`${envelope.format}: the verifier reported no sealed-channel window (sealedWindowSeconds, sealedMaxRequests)`);
  return out("verified", { claims: { technology: "android-avf", format: envelope.format, family: "pvm-app", freshness: "client-nonce", nonce: nonceHex, appId: appHex,
    runtimeId, transportSpki, transportSpkiSha256: createHash("sha256").update(Buffer.from(transportSpki, "hex")).digest("hex"), appKey, sealed, tlsKey: r.tlsKey ?? null, measurement: r.measurement ?? null,
    instanceId, instanceKey: v3 ? envelope.instanceKey : null, bound: bound ? [...expect.instanceIds] : null } });
}
