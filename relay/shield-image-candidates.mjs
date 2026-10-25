// Pure image selection shared by host enrollment and the full evidence verifier.
import { validateDesktopRelease } from './shield-desktop-release.mjs';
const HEX = /^[0-9a-f]{64}$/;

// Used both by the verifier and by the fresh-report endpoint. Native images
// cannot satisfy a legacy expectation, even when a runtime hash is reused.
// The node's report never chooses this release or its launch measurement.
export function shieldImageCandidates(policy, expected) {
  const desktop = policy?.desktop == null ? null : validateDesktopRelease(policy.desktop);
  const native = expected?.requiresDesktop === true;
  if (expected?.requiresDesktop !== undefined && typeof expected.requiresDesktop !== 'boolean') return [];
  if (native && (!desktop || expected.runtimeId !== desktop.runtimeId)) return [];
  if (!native && desktop && expected?.runtimeId === desktop.runtimeId) return [];
  return (Array.isArray(policy?.images) ? policy.images : []).filter(p =>
    HEX.test(p?.measurement || '') && p.runtimeId === expected?.runtimeId &&
    (!expected.requiresConfigBundleV5 || p.configBundleV5 === true) &&
    (!expected.requiresSecretsV1 || p.secretsV1 === true) &&
    (!expected.requiresConfigSocketServer || p.configSocketServer === true) &&
    (native ? p.nativeDesktop === true && p.measurement === desktop.launchMeasurement &&
      p.igvmSha256 === desktop.igvmSha256 && p.profileSha256 === desktop.profileSha256 &&
      p.controllerSha256 === desktop.controllerSha256 && p.configBundleV5 === true &&
      p.secretsV1 === true && p.configSocketServer === true && p.protectedPorts === true
      : p.nativeDesktop !== true && (!desktop || p.measurement !== desktop.launchMeasurement)));
}

