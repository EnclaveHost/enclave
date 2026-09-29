// Bind a guest VBS report to the caller's actual TLS handshake and app request.
// This is an evidence verifier, not a scheduler or policy admission decision.
// Image allowlists must be reviewed for guest-only input provenance. In particular,
// upstream OpenHCL NV input restored from host-managed VMGS is NOT sufficient to
// establish app-key custody, even when the resulting report signature is valid.
import { verifyHvNodeEvidence } from './hvnode-verify.mjs';
import { parseTcgLog, vsmKey } from './vbs-tcglog.mjs';
import { rsaKeyFromModulus } from './vbs-verify.mjs';
import { verifyVbsVmReport } from './vbs-vm-report.mjs';
import { ABI2, bind2, runtimeId, validateRuntimeIdentity } from './vbs-runtime.mjs';

export function verifyVbsAppEvidence({ doc, handshakeSpki, nonce, expectedAppSha256,
  expectedRuntimeId, hostSession } = {}, policy = {}) {
  const fail = reason => ({ ok: false, reason });
  try {
    if (!Buffer.isBuffer(handshakeSpki) || handshakeSpki.length < 32 || handshakeSpki.length > 4096 ||
        !Buffer.isBuffer(nonce) || nonce.length !== 32) return fail('actual TLS SPKI and fresh nonce required');
    if (!/^[0-9a-f]{64}$/.test(expectedAppSha256 || '') ||
        !/^[0-9a-f]{64}$/.test(expectedRuntimeId || '')) return fail('explicit app and runtime pins required');
    if (!doc || doc.abi !== ABI2 || doc.nonce !== nonce.toString('hex') ||
        doc.transportKey !== handshakeSpki.toString('base64') || doc.appSha256 !== expectedAppSha256)
      return fail('document differs from the requested app, handshake, nonce or ABI');
    const runtimeError = validateRuntimeIdentity(doc.runtime);
    if (runtimeError) return fail(runtimeError);
    const rid = runtimeId(doc.runtime);
    if (rid.toString('hex') !== expectedRuntimeId) return fail('runtime identity is not pinned');
    if (!hostSession || hostSession.capture) return fail('a complete authenticated host session is required');
    const host = verifyHvNodeEvidence(hostSession, policy);
    if (!host.ok || !host.admissible) return fail(`host boot verification failed: ${host.reasons.join('; ')}`);
    if (typeof doc.report !== 'string' || doc.report.length > 32768) return fail('report missing or oversized');
    const report = JSON.parse(Buffer.from(doc.report, 'base64').toString('utf8'));
    if (typeof report.vbsVmReport !== 'string' || report.vbsVmReport.length > 12000)
      return fail('guest VBS report missing or oversized');
    // The key comes only from the SAME log that the successful TPM verifier
    // authenticated above, never from the app document or a caller's bare key.
    const events = parseTcgLog(Buffer.from(hostSession.evidence.log, 'base64')).events;
    const key = vsmKey(events, 'IDKS');
    if (!key) return fail('authenticated boot log contains no IDKS');
    const result = verifyVbsVmReport({ envelope: Buffer.from(report.vbsVmReport, 'base64'),
      idksPublicKey: rsaKeyFromModulus(key.modulus, key.exponent),
      expectedUserData: Buffer.concat([bind2(handshakeSpki, nonce, rid), Buffer.from(expectedAppSha256, 'hex')]),
      allowedMeasurements: policy.allowedMeasurements, minimumGuestSvn: policy.minimumGuestSvn ?? 0 });
    if (!result.ok) return result;
    return { ok: true, scope: 'hardware-bound app evidence; admission is a separate policy decision',
      measurement: result.measurement, appSha256: expectedAppSha256, runtimeId: expectedRuntimeId,
      boot: host.boot };
  } catch (e) { return fail(e.message); }
}
