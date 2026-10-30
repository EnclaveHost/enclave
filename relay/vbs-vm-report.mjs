// OpenHCL's public guest-vTPM report. This primitive verifies a report against a
// supplied IDKS key. The caller MUST authenticate that key with the same boot's
// TPM quote, credential activation and measured-boot log before trusting it.
// It does not grant app admission or establish custody of an app's TLS key.
//
// The checks are relay/vbs-vm-report-core.mjs, shared with the browser verifier;
// this module answers them with node:crypto and exposes the individual checks.
import { createHash, verify, constants, timingSafeEqual } from 'node:crypto';
import { vbsVmReportWith, VBS_VM_REPORT_SCOPE } from './vbs-vm-report-core.mjs';
import { runSync } from './hvnode-core.mjs';

const hash = b => createHash('sha256').update(b).digest();
const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const CORE = vbsVmReportWith({ sha256: hash, equal });
const OPS = Object.freeze({
  rsaPssSha256: ({ key, data, sig }) => verify('sha256', data,
    { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig),
});

export const parseVbsVmReport = CORE.parseVbsVmReport;

export function verifyVbsVmReport({ envelope, idksPublicKey, expectedUserData, allowedMeasurements,
  minimumGuestSvn = 0, imageIdentities }) {
  try {
    const r = runSync(CORE.vbsVmReportChecks({ envelope, idksPublicKey, expectedUserData, allowedMeasurements, minimumGuestSvn, imageIdentities }), OPS);
    if (!r.ok) return { ok: false, reason: r.reason, checks: r.checks };
    return { ok: true, measurement: r.measurement, guestSvn: r.guestSvn, identity: r.identity, checks: r.checks, scope: VBS_VM_REPORT_SCOPE };
  } catch (e) { return { ok: false, reason: e.message }; }
}
