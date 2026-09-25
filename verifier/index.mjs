// verifier/index.mjs: one entry point, one verdict shape, evidence classes kept apart.
//
//   verifyEvidence(doc, { policy, context, collateral })
//     -> { status, admissionSafe, omissions, technology, reasons, checks, claims }
//     status: "verified"    every security check passed and the policy omitted nothing (admissionSafe: true)
//             "limited"     every cryptographic check passed but the policy EXPLICITLY skipped a security
//                           check, or a report version's semantics are unimplemented; `omissions` names them;
//                           never admission-safe (a consumer testing status === "verified" cannot accept it)
//             "rejected"    a check failed
//             "unsupported" evidence whose semantics this verifier does not implement
//     checks[name]: true passed, false failed, null not judged (an omission names why)
//
// Rules that hold for every class: an unknown or unimplemented format is "unsupported" (never green); a
// development format is "rejected"; a CPU verdict says nothing about a GPU; delegated classes (AVF, VBS,
// Hyper-V partition) call the platform's own first-party verifier and are reported as what they are.
import { parseEnvelope, EnvelopeError, FORMATS, TECH } from "./envelope.mjs";
import { verifySnp } from "./snp.mjs";
import { sha256 } from "./tls-binding.mjs";

export { parseEnvelope, FORMATS, TECH } from "./envelope.mjs";
export { verifySnp, parseReportStrict, checkChain, parseAmdChain, checkCrl, checkCrlAuthentic, crlPolicyPrelude, judgeCrl, NODE_CRYPTO, verdictStatus, DEFAULT_SNP_POLICY, JUDGED_MAX_REPORT_VERSION } from "./snp.mjs";
export { cachedCollateral } from "./collateral-cache.mjs";
export { verifyReleaseAttestation, DEFAULT_RELEASE_POLICY } from "./provenance.mjs";
export { checkHostedCertificate, spkiOfCert, hashAttestationDocument } from "./tls-binding.mjs";
export { fileCollateral, memoryCollateral, httpCollateral, layeredCollateral, AMD_KDS } from "./collateral.mjs";
export { admit, createNonceRegistry, RELEASE, HOLD } from "./admission.mjs";
export { verifyClientPolicy, selectDeployment, DEPLOYMENT_ID } from "./pvm-policy.mjs";
export { verifyPvmEvidence, loadOwnerVerifier, loadOwnerModule, STRICT_INTEGRATION, PVM_EVIDENCE_FORMAT, PVM_EVIDENCE_FORMAT_V2, PVM_EVIDENCE_FORMATS } from "./pvm-evidence.mjs";
import { verifyPvmEvidence, PVM_EVIDENCE_FORMATS } from "./pvm-evidence.mjs";

const unsupported = (technology, why) => ({ status: "unsupported", admissionSafe: false, omissions: [], technology, reasons: [`UNSUPPORTED: ${why}`], checks: {}, claims: null });

export async function verifyEvidence(doc, { policy = {}, context = {}, collateral = null } = {}) {
  // the client-verified pVM evidence is a JSON object, not a base64 body: routed before the envelope parser
  if (doc && PVM_EVIDENCE_FORMATS.has(doc.format)) return verifyPvmEvidence(doc, { nonce: context.nonce, appId: context.expectedAppId, ...(policy.pvm || {}) }, { now: context.now ? new Date(context.now).getTime() : Date.now() });
  let env;
  try { env = parseEnvelope(doc); }
  catch (e) {
    if (!(e instanceof EnvelopeError)) throw e;
    const technology = FORMATS[doc?.format]?.technology ?? null;
    return { status: e.code === "unsupported" ? "unsupported" : "rejected", admissionSafe: false, omissions: [], technology, reasons: [`${e.code.toUpperCase()}: ${e.message}`], checks: {}, claims: null };
  }
  const technology = env.spec.technology;
  switch (technology) {
    case TECH.SNP: return { technology, ...(await verifySnp(env, policy.snp || {}, context, collateral)) };
    case TECH.TDX: return unsupported(technology, "Intel TDX quotes are parsed elsewhere but not verified by this harness (DCAP: PCK chain to the Intel SGX Root CA, TCB info, QE identity)");
    case TECH.AVF: return { technology, ...(await verifyAvf(env, policy.avf || {}, context)) };
    case TECH.VBS: return unsupported(technology, "the Windows VBS-enclave backend (ee-engine) is RETIRED (Steven, 2026-09-25: the custom type-1 partition is the only NucBox target): a VBS-enclave report is never verified here and never stands in for a custom-VM report, and tier vbs-dev never reads as verified");
    case TECH.HYPERV: return unsupported(technology, "a Hyper-V partition document is judged by windows/vbslike/verify/judge-hv.mjs against the launcher key; it has no hardware root (hostExcluded=false by contract) and is never a confidential-compute verdict");
    default: return unsupported(technology, `no verifier for ${technology}`);
  }
}

// Android AVF: delegate to the relay's verifier (root pinned to Google, APK code/authority hashes from
// policy); the challenge is the transcript the phone was asked to bind, recomputed from OUR inputs.
async function verifyAvf(env, policy, context) {
  const { verifyAvfEvidence } = await import("../relay/avf-verify.mjs");
  const { avfPadBinding } = await import("../relay/avf-binding.mjs");
  const reasons = [], fail = (m) => ({ status: "rejected", admissionSafe: false, omissions: [], reasons: [...reasons, `REJECT: ${m}`], checks: {}, claims: null });
  let ev; try { ev = JSON.parse(env.body.toString("utf8")); } catch { return fail("AVF body is not JSON"); }
  if (!ev || !Array.isArray(ev.chain) || ev.chain.length > 8) return fail("AVF body needs a bounded chain[]");
  if (typeof ev.signature !== "string" || !ev.signature) return fail("AVF body needs the attested key's signature over the binding transcript (a chain alone proves the VM, not this connection)");
  if (!Buffer.isBuffer(context.transportKeySpki) || !Buffer.isBuffer(context.nonce) || context.nonce.length !== 32) return fail("AVF needs the transport SPKI and a 32-byte nonce from the verifier");
  const bound = env.format === "android-avf-pvm/v2" ? avfPadBinding(context.transportKeySpki, String(env.doc.padKey || ""), context.nonce) : Buffer.concat([context.transportKeySpki, context.nonce]);
  if (!policy.allowedCodeHashes?.length || !policy.allowedAuthorityHashes?.length) return fail("AVF policy needs allowedCodeHashes and allowedAuthorityHashes (fail closed)");
  const r = verifyAvfEvidence({ chain: ev.chain.map((c) => Buffer.from(c, "base64")), challenge: sha256(bound), signature: Buffer.from(ev.signature, "base64"), signedMessage: bound },
    { allowedCodeHashes: policy.allowedCodeHashes, allowedAuthorityHashes: policy.allowedAuthorityHashes, ...(policy.rootPins ? { rootPins: policy.rootPins } : {}), now: context.now ? new Date(context.now).getTime() : Date.now() });
  return { status: r.ok ? "verified" : "rejected", admissionSafe: !!r.ok, omissions: [], reasons: [...reasons, ...r.reasons], checks: { avf: r.ok }, claims: r.ok ? { technology: TECH.AVF, measurement: r.measurement, component: r.component ?? null, rootVerified: r.rootVerified ?? null, freshness: "verifier nonce" } : null };
}

// The pVM ABI/2 app attestation (Bind2 || AppID as the AVF challenge) lives on branch pvm-cpu/portable-runtime
// as relay/pvm-app-attest.mjs; imported when present, "unsupported" when not (never restated here).
export async function verifyPvmAbi2(evidence, opts) {
  const { loadOwnerModule } = await import("./pvm-evidence.mjs");
  const mod = await loadOwnerModule();
  if (!mod) return unsupported(TECH.AVF, "relay/pvm-app-attest.mjs is not in this tree (branch pvm-cpu/portable-runtime; set ENCLAVE_PVM_MODULE via verifier/integration/resolve.mjs); the pVM ABI/2 app attestation cannot be judged here");
  const r = mod.verifyPvmAppAbi2(evidence, opts);
  // the pVM captures bind an OWNER nonce (fixtures/verifier/pvm-abi2/SOURCE.md): the module's ok is "binding verified"
  return { status: r.ok ? "verified" : "rejected", admissionSafe: !!r.ok, omissions: [], technology: TECH.AVF, reasons: r.reasons, checks: { pvmAbi2: r.ok }, claims: r.ok ? { runtimeId: r.runtimeId, bind2: r.bind2, measurement: r.measurement } : null };
}
