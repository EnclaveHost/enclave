// A per-app admission decision, separate from the host's TPM attach verdict.
// Policy is supplied by the relay operator, never by the attached node. No
// default images/platforms are admitted. A successful decision applies only to
// this app and key; it does not make the host or another app eligible.
import { createHash } from 'node:crypto';
import { verifyVbsAppEvidence } from './vbs-app-verify.mjs';
import { platformsValid, platformAdmitted } from './vbs-app-core.mjs';
import { shieldImageCandidates } from './shield-image-candidates.mjs';
import { imageIdentityPins } from './vbs-image-identity.mjs';

const HEX = /^[0-9a-f]{64}$/;
// policy.hosts: the host names admitted to the Shield market, or "*" (the open market, 2026-10-11): any hv-node whose
// attach the hub verified and whose registered owner signed it. Admission still needs this module's per-app evidence.
export const shieldHostAdmitted = (policy, name) => !!policy && !!name &&
  (policy.hosts === '*' || (Array.isArray(policy.hosts) && policy.hosts.includes(name)));
// platformsValid / platformAdmitted: relay/vbs-app-core.mjs (shared with the browser verifier), re-exported here unchanged
export { platformsValid, platformAdmitted } from './vbs-app-core.mjs';

export { shieldImageCandidates } from './shield-image-candidates.mjs';

export function verifyShieldAppPolicy(input, policy = {}) {
  const no = reason => ({ ok: false, reason });
  try {
    if (policy.schema !== 'enclave-shield-app-policy/1') return no('Shield app policy is not configured');
    const { platforms, images } = policy;
    if (!platformsValid(platforms))
      return no('explicit TPM identity and platform firmware pins (or "attested") are required');
    if (!Array.isArray(images) || !images.length || images.some(p =>
      !HEX.test(p?.measurement || '') || !HEX.test(p?.runtimeId || '')))
      return no('explicit image/runtime pairs are required');
    // Caller must obtain these expected identities independently from the
    // deployment and its catalog artifact, not from the app's report.
    const candidates = shieldImageCandidates(policy, { ...input, runtimeId: input?.expectedRuntimeId });
    if (!candidates.length) return no('runtime has no admitted image');
    const v = verifyVbsAppEvidence(input, {
      ekRoots: policy.ekRoots,
      allowedMeasurements: candidates.map(p => p.measurement),
      imageIdentities: imageIdentityPins(candidates),
      minimumGuestSvn: policy.minimumGuestSvn ?? 0,
    });
    if (!v.ok) return v;
    if (!platformAdmitted(platforms, v.boot))
      return no('authenticated TPM/platform pair is not admitted');
    const spkiSha256 = createHash('sha256').update(input.handshakeSpki).digest('hex');
    // For certificate issuance, the actual CSR parser supplies this hash. This
    // prevents an operator from proving a real guest but certifying its own key.
    if (input.expectedCsrSpkiSha256 !== undefined &&
      (!HEX.test(input.expectedCsrSpkiSha256) || input.expectedCsrSpkiSha256 !== spkiSha256))
      return no('certificate key differs from the verified app key');
    return { ...v, spkiSha256,
      scope: platforms === 'attested' ? 'policy-accepted app image, runtime and key on an attested VBS platform'
        : 'policy-accepted app image, runtime and key on a pinned VBS platform' };
  } catch (e) { return no(e.message); }
}
