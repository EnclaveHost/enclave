// relay/vbs-vm-report-core.mjs: relay/vbs-vm-report.mjs without node:crypto, shared with the browser verifier
// (verifier/web/shield-app.mjs). The hash and the comparison are passed in (vbsVmReportWith({ sha256, equal })), and the
// RSA-PSS signature is a request the caller answers, as relay/hvnode-core.mjs does: vbsVmReportChecks yields
// { op: "rsaPssSha256", key, data, sig } and expects a boolean back (runSync/runAsync in hvnode-core.mjs drive it).
//
// The checks and their reasons are verifyVbsVmReport's, in its order: the caller's inputs, the envelope, the VTL
// configuration, the guest SVN, the image measurement, the guest input, the signature. The result's `reason` is the FIRST
// failure in that order, so vbs-vm-report.mjs returns exactly what it always returned; `checks` records each step on its
// own (once the envelope parses, every later step runs) for a verdict that shows which ones held.
const BASE = 1236, META = 1216, REPORT_SIZE = 560;
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const zero = (b) => b.every((x) => x === 0);
// constant-time over equal lengths, as timingSafeEqual
const ctEqual = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; };
export const VBS_VM_REPORT_CHECKS = Object.freeze(['inputs', 'envelope', 'vtl', 'svn', 'measurement', 'user-data', 'signature']);
export const VBS_VM_REPORT_SCOPE = 'VBS image and guest input under supplied IDKS; caller must authenticate IDKS and app key custody';

// sha256(bytes) -> Buffer; equal(a, b) -> boolean for Buffers (default: constant-time over equal lengths)
export function vbsVmReportWith({ sha256, equal = ctEqual }) {
  function parseVbsVmReport(envelope) {
    requireThat(Buffer.isBuffer(envelope) && envelope.length >= BASE && envelope.length <= 8192,
      'invalid report envelope length');
    const n = (o) => envelope.readUInt32LE(o);
    requireThat(n(0) === 0x414c4348 && n(4) === 2 && n(12) === 2 && n(16) === 0,
      'unsupported HCLA header');
    requireThat(zero(envelope.subarray(20, 32)), 'nonzero header reserved bytes');
    const size = n(8), claimSize = n(META + 16);
    requireThat(claimSize > 0 && size === BASE + claimSize && size <= envelope.length,
      'invalid claims length');
    requireThat(zero(envelope.subarray(size)), 'nonzero NV padding');
    requireThat(n(META) === 20 + claimSize && n(META + 4) === 1 &&
      n(META + 8) === 1 && n(META + 12) === 1, 'unsupported report metadata');
    const report = envelope.subarray(32, 32 + REPORT_SIZE), r = (o) => report.readUInt32LE(o);
    requireThat(r(0) === REPORT_SIZE && r(4) === 1 && r(8) === 1 && r(12) === 256 &&
      r(16) === 0 && r(20) === 2, 'unsupported VBS report header');
    requireThat(zero(envelope.subarray(32 + REPORT_SIZE, META)) &&
      zero(report.subarray(240, 304)), 'nonzero report reserved bytes');
    const claimsBytes = envelope.subarray(BASE, size);
    const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(claimsBytes));
    requireThat(claims && typeof claims === 'object' && !Array.isArray(claims), 'invalid claims');
    requireThat(typeof claims['user-data'] === 'string' && /^[0-9a-f]{128}$/.test(claims['user-data']),
      'invalid guest input');
    requireThat(equal(report.subarray(24, 56), sha256(claimsBytes)) && zero(report.subarray(56, 88)),
      'claims hash differs from signed report data');
    return { report, claims, userData: Buffer.from(claims['user-data'], 'hex'),
      measurement: report.subarray(120, 152).toString('hex'), enabledVtl: r(216),
      policy: r(220), guestVtl: r(224), guestSvn: r(228) };
  }

  // -> { ok: true, measurement, guestSvn, parsed, checks } | { ok: false, reason, parsed, checks }
  function* vbsVmReportChecks({ envelope, idksPublicKey, expectedUserData, allowedMeasurements, minimumGuestSvn = 0 } = {}) {
    const checks = Object.fromEntries(VBS_VM_REPORT_CHECKS.map((k) => [k, undefined]));
    let reason = null, p = null;
    const step = (key, fn) => { try { fn(); checks[key] = true; } catch (e) { checks[key] = false; if (reason === null) reason = e.message; } };
    const done = () => (reason === null ? { ok: true, measurement: p.measurement, guestSvn: p.guestSvn, parsed: p, checks } : { ok: false, reason, parsed: p, checks });
    step('inputs', () => {
      requireThat(Buffer.isBuffer(expectedUserData) && expectedUserData.length === 64,
        'a verifier-chosen 64-byte binding is required');
      requireThat(Array.isArray(allowedMeasurements) && allowedMeasurements.length > 0 &&
        allowedMeasurements.every((x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)),
        'explicit image measurement pins are required');
      requireThat(Number.isSafeInteger(minimumGuestSvn) && minimumGuestSvn >= 0,
        'invalid minimum guest SVN');
    });
    if (reason !== null) return done();
    step('envelope', () => { p = parseVbsVmReport(envelope); });
    if (reason !== null) return done();
    step('vtl', () => requireThat(p.enabledVtl === 5 && p.guestVtl === 2 && p.policy === 0,
      'unsupported VTL configuration or debug-enabled report'));
    step('svn', () => requireThat(p.guestSvn >= minimumGuestSvn, 'guest SVN below policy'));
    step('measurement', () => requireThat(allowedMeasurements.includes(p.measurement), 'image measurement is not pinned'));
    step('user-data', () => requireThat(equal(p.userData, expectedUserData), 'guest binding differs from verifier request'));
    let signed = false, why = null;
    try { signed = !!(yield { op: 'rsaPssSha256', key: idksPublicKey, data: p.report.subarray(0, 304), sig: p.report.subarray(304, 560) }); }
    catch (e) { why = e.message; }
    step('signature', () => { if (why !== null) throw new Error(why); requireThat(signed, 'VBS report signature failed'); });
    return done();
  }
  return Object.freeze({ parseVbsVmReport, vbsVmReportChecks });
}
