// verifier/index.mjs: one entry point, one verdict shape, evidence classes kept apart.
//
//   verifyEvidence(doc, { policy, context, collateral }) -> { status, technology, reasons, checks, claims }
//     status: "verified" | "rejected" | "unsupported"
//
// Rules that hold for every class: an unknown or unimplemented format is "unsupported" (never green); a
// development format is "rejected"; a CPU verdict says nothing about a GPU; delegated classes (AVF, VBS,
// Hyper-V partition) call the platform's own first-party verifier and are reported as what they are.
import { parseEnvelope, EnvelopeError, FORMATS, TECH } from "./envelope.mjs";
import { verifySnp } from "./snp.mjs";
import { sha256 } from "./tls-binding.mjs";

export { parseEnvelope, FORMATS, TECH } from "./envelope.mjs";
export { verifySnp, parseReportStrict, checkChain, checkCrl, DEFAULT_SNP_POLICY } from "./snp.mjs";
export { verifyReleaseAttestation, DEFAULT_RELEASE_POLICY } from "./provenance.mjs";
export { checkHostedCertificate, spkiOfCert, hashAttestationDocument } from "./tls-binding.mjs";
export { fileCollateral, memoryCollateral, httpCollateral, layeredCollateral, AMD_KDS } from "./collateral.mjs";

const unsupported = (technology, why) => ({ status: "unsupported", technology, reasons: [`UNSUPPORTED: ${why}`], checks: {}, claims: null });

export async function verifyEvidence(doc, { policy = {}, context = {}, collateral = null } = {}) {
  let env;
  try { env = parseEnvelope(doc); }
  catch (e) {
    if (!(e instanceof EnvelopeError)) throw e;
    const technology = FORMATS[doc?.format]?.technology ?? null;
    return { status: e.code === "unsupported" ? "unsupported" : "rejected", technology, reasons: [`${e.code.toUpperCase()}: ${e.message}`], checks: {}, claims: null };
  }
  const technology = env.spec.technology;
  switch (technology) {
    case TECH.SNP: return { technology, ...(await verifySnp(env, policy.snp || {}, context, collateral)) };
    case TECH.TDX: return unsupported(technology, "Intel TDX quotes are parsed elsewhere but not verified by this harness (DCAP: PCK chain to the Intel SGX Root CA, TCB info, QE identity)");
    case TECH.AVF: return { technology, ...(await verifyAvf(env, policy.avf || {}, context)) };
    case TECH.VBS: return unsupported(technology, "a VBS-enclave attestation is judged by relay/vbs-verify.mjs with the relay's TPM credential round trip; it is not replayable offline here, and tier vbs-dev never reads as verified");
    case TECH.HYPERV: return unsupported(technology, "a Hyper-V partition document is judged by windows/vbslike/verify/judge-hv.mjs against the launcher key; it has no hardware root (hostExcluded=false by contract) and is never a confidential-compute verdict");
    default: return unsupported(technology, `no verifier for ${technology}`);
  }
}

// Android AVF: delegate to the relay's verifier (root pinned to Google, APK code/authority hashes from
// policy); the challenge is the transcript the phone was asked to bind, recomputed from OUR inputs.
async function verifyAvf(env, policy, context) {
  const { verifyAvfEvidence } = await import("../relay/avf-verify.mjs");
  const { avfPadBinding } = await import("../relay/avf-binding.mjs");
  const reasons = [], fail = (m) => ({ status: "rejected", reasons: [...reasons, `REJECT: ${m}`], checks: {}, claims: null });
  let ev; try { ev = JSON.parse(env.body.toString("utf8")); } catch { return fail("AVF body is not JSON"); }
  if (!ev || !Array.isArray(ev.chain) || ev.chain.length > 8) return fail("AVF body needs a bounded chain[]");
  if (!Buffer.isBuffer(context.transportKeySpki) || !Buffer.isBuffer(context.nonce) || context.nonce.length !== 32) return fail("AVF needs the transport SPKI and a 32-byte nonce from the verifier");
  const bound = env.format === "android-avf-pvm/v2" ? avfPadBinding(context.transportKeySpki, String(env.doc.padKey || ""), context.nonce) : Buffer.concat([context.transportKeySpki, context.nonce]);
  if (!policy.allowedCodeHashes?.length || !policy.allowedAuthorityHashes?.length) return fail("AVF policy needs allowedCodeHashes and allowedAuthorityHashes (fail closed)");
  const r = verifyAvfEvidence({ chain: ev.chain.map((c) => Buffer.from(c, "base64")), challenge: sha256(bound), signature: ev.signature ? Buffer.from(ev.signature, "base64") : null, signedMessage: bound },
    { allowedCodeHashes: policy.allowedCodeHashes, allowedAuthorityHashes: policy.allowedAuthorityHashes, ...(policy.rootPins ? { rootPins: policy.rootPins } : {}), now: context.now ? new Date(context.now).getTime() : Date.now() });
  return { status: r.ok ? "verified" : "rejected", reasons: [...reasons, ...r.reasons], checks: { avf: r.ok }, claims: r.ok ? { technology: TECH.AVF, measurement: r.measurement, component: r.component ?? null, rootVerified: r.rootVerified ?? null, freshness: "verifier nonce" } : null };
}

// The pVM ABI/2 app attestation (Bind2 || AppID as the AVF challenge) lives on branch pvm-cpu/portable-runtime
// as relay/pvm-app-attest.mjs; imported when present, "unsupported" when not (never restated here).
export async function verifyPvmAbi2(evidence, opts) {
  let mod; try { mod = await import("../relay/pvm-app-attest.mjs"); } catch { return unsupported(TECH.AVF, "relay/pvm-app-attest.mjs is not in this tree (branch pvm-cpu/portable-runtime); the pVM ABI/2 app attestation cannot be judged here"); }
  const r = mod.verifyPvmAppAbi2(evidence, opts);
  return { status: r.ok ? "verified" : "rejected", technology: TECH.AVF, reasons: r.reasons, checks: { pvmAbi2: r.ok }, claims: r.ok ? { runtimeId: r.runtimeId, bind2: r.bind2, measurement: r.measurement } : null };
}
