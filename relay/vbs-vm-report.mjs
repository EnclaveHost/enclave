// OpenHCL's public guest-vTPM report. This primitive verifies a report against a
// supplied IDKS key. The caller MUST authenticate that key with the same boot's
// TPM quote, credential activation and measured-boot log before trusting it.
// It does not grant app admission or establish custody of an app's TLS key.
import { createHash, verify, constants, timingSafeEqual } from 'node:crypto';

const BASE = 1236, META = 1216, REPORT_SIZE = 560;
const hash = b => createHash('sha256').update(b).digest();
const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const zero = b => b.every(x => x === 0);

export function parseVbsVmReport(envelope) {
  requireThat(Buffer.isBuffer(envelope) && envelope.length >= BASE && envelope.length <= 8192,
    'invalid report envelope length');
  const n = o => envelope.readUInt32LE(o);
  requireThat(n(0) === 0x414c4348 && n(4) === 2 && n(12) === 2 && n(16) === 0,
    'unsupported HCLA header');
  requireThat(zero(envelope.subarray(20, 32)), 'nonzero header reserved bytes');
  const size = n(8), claimSize = n(META + 16);
  requireThat(claimSize > 0 && size === BASE + claimSize && size <= envelope.length,
    'invalid claims length');
  requireThat(zero(envelope.subarray(size)), 'nonzero NV padding');
  requireThat(n(META) === 20 + claimSize && n(META + 4) === 1 &&
    n(META + 8) === 1 && n(META + 12) === 1, 'unsupported report metadata');
  const report = envelope.subarray(32, 32 + REPORT_SIZE), r = o => report.readUInt32LE(o);
  requireThat(r(0) === REPORT_SIZE && r(4) === 1 && r(8) === 1 && r(12) === 256 &&
    r(16) === 0 && r(20) === 2, 'unsupported VBS report header');
  requireThat(zero(envelope.subarray(32 + REPORT_SIZE, META)) &&
    zero(report.subarray(240, 304)), 'nonzero report reserved bytes');
  const claimsBytes = envelope.subarray(BASE, size);
  const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(claimsBytes));
  requireThat(claims && typeof claims === 'object' && !Array.isArray(claims), 'invalid claims');
  requireThat(typeof claims['user-data'] === 'string' && /^[0-9a-f]{128}$/.test(claims['user-data']),
    'invalid guest input');
  requireThat(equal(report.subarray(24, 56), hash(claimsBytes)) && zero(report.subarray(56, 88)),
    'claims hash differs from signed report data');
  return { report, claims, userData: Buffer.from(claims['user-data'], 'hex'),
    measurement: report.subarray(120, 152).toString('hex'), enabledVtl: r(216),
    policy: r(220), guestVtl: r(224), guestSvn: r(228) };
}

export function verifyVbsVmReport({ envelope, idksPublicKey, expectedUserData, allowedMeasurements,
  minimumGuestSvn = 0 }) {
  try {
    requireThat(Buffer.isBuffer(expectedUserData) && expectedUserData.length === 64,
      'a verifier-chosen 64-byte binding is required');
    requireThat(Array.isArray(allowedMeasurements) && allowedMeasurements.length > 0 &&
      allowedMeasurements.every(x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)),
      'explicit image measurement pins are required');
    requireThat(Number.isSafeInteger(minimumGuestSvn) && minimumGuestSvn >= 0,
      'invalid minimum guest SVN');
    const p = parseVbsVmReport(envelope);
    requireThat(p.enabledVtl === 5 && p.guestVtl === 2 && p.policy === 0,
      'unsupported VTL configuration or debug-enabled report');
    requireThat(p.guestSvn >= minimumGuestSvn, 'guest SVN below policy');
    requireThat(allowedMeasurements.includes(p.measurement), 'image measurement is not pinned');
    requireThat(equal(p.userData, expectedUserData), 'guest binding differs from verifier request');
    requireThat(verify('sha256', p.report.subarray(0, 304),
      { key: idksPublicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
      p.report.subarray(304, 560)), 'VBS report signature failed');
    return { ok: true, measurement: p.measurement, guestSvn: p.guestSvn,
      scope: 'VBS image and guest input under supplied IDKS; caller must authenticate IDKS and app key custody' };
  } catch (e) { return { ok: false, reason: e.message }; }
}
