// A per-app admission decision, separate from the host's TPM attach verdict.
// Policy is supplied by the relay operator, never by the attached node. No
// default images/platforms are admitted. A successful decision applies only to
// this app and key; it does not make the host or another app eligible.
import { createHash } from 'node:crypto';
import { verifyVbsAppEvidence } from './vbs-app-verify.mjs';

const HEX = /^[0-9a-f]{64}$/;
// policy.hosts: the host names admitted to the Shield market, or "*" (the open market, 2026-10-11): any hv-node whose
// attach the hub verified and whose registered owner signed it. Admission still needs this module's per-app evidence.
export const shieldHostAdmitted = (policy, name) => !!policy && !!name &&
  (policy.hosts === '*' || (Array.isArray(policy.hosts) && policy.hosts.includes(name)));
// policy.platforms: explicit {ekCertSha256, pcr0} pins, or "attested" (the open market): any TPM whose EK chains to the
// pinned ekRoots, on a boot that passed the production checks (Secure Boot on, no test signing; hvnode-verify.mjs).
// "attested" admits any firmware (PCR 0) on such a TPM: it says the app ran isolated on genuine hardware, not on whose.
export const platformsValid = platforms => platforms === 'attested' || (Array.isArray(platforms) && platforms.length > 0 &&
  platforms.every(p => HEX.test(p?.ekCertSha256 || '') && HEX.test(p?.pcr0 || '')));
// a VERIFIED boot (an admissible hvnode-verify verdict's .boot) on an admitted platform
export const platformAdmitted = (platforms, boot) => platformsValid(platforms) && HEX.test(boot?.ekCertSha256 || '') &&
  (platforms === 'attested' || platforms.some(p => p.ekCertSha256 === boot.ekCertSha256 && p.pcr0 === boot.pcr0));
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
    const candidates = images.filter(p => p.runtimeId === input?.expectedRuntimeId &&
      (!input.requiresConfigBundleV5 || p.configBundleV5 === true) &&
      (!input.requiresSecretsV1 || p.secretsV1 === true) &&
      (!input.requiresConfigSocketServer || p.configSocketServer === true));
    if (!candidates.length) return no('runtime has no admitted image');
    const v = verifyVbsAppEvidence(input, {
      ekRoots: policy.ekRoots,
      allowedMeasurements: candidates.map(p => p.measurement),
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
