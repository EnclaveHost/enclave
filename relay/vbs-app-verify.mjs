// Bind a guest VBS report to the caller's actual TLS handshake and app request.
// This is an evidence verifier, not a scheduler or policy admission decision.
// Image allowlists must be reviewed for guest-only input provenance. In particular,
// upstream OpenHCL NV input restored from host-managed VMGS is NOT sufficient to
// establish app-key custody, even when the resulting report signature is valid.
import { releaseBinding } from './secrets-release.mjs';
import { verifyHvNodeEvidence } from './hvnode-verify.mjs';
import { parseTcgLog, vsmKey } from './vbs-tcglog.mjs';
import { rsaKeyFromModulus } from './vbs-verify.mjs';
import { verifyVbsVmReport } from './vbs-vm-report.mjs';
import { bind2, runtimeId, validateRuntimeIdentity } from './vbs-runtime.mjs';
import { vbsAppDocChecks, vbsAppReportEnvelope, vbsAppUserData } from './vbs-app-core.mjs';

export function verifyVbsAppEvidence({ doc, handshakeSpki, nonce, expectedAppSha256,
  expectedRuntimeId, hostSession, shieldRelease } = {}, policy = {}) {
  const fail = reason => ({ ok: false, reason });
  try {
    // the document against the request (relay/vbs-app-core.mjs, the browser verifier's rules too)
    const pre = vbsAppDocChecks({ doc, handshakeSpki, nonce, expectedAppSha256, expectedRuntimeId }, { runtimeId, validateRuntimeIdentity });
    if (pre.reason) return fail(pre.reason);
    const rid = pre.rid;
    if (!hostSession || hostSession.capture) return fail('a complete authenticated host session is required');
    const host = verifyHvNodeEvidence(hostSession, policy);
    if (!host.ok || !host.admissible) return fail(`host boot verification failed: ${host.reasons.join('; ')}`);
    const report = vbsAppReportEnvelope(doc);
    if (report.reason) return fail(report.reason);
    // The key comes only from the SAME log that the successful TPM verifier
    // authenticated above, never from the app document or a caller's bare key.
    const events = parseTcgLog(Buffer.from(hostSession.evidence.log, 'base64')).events;
    const key = vsmKey(events, 'IDKS');
    if (!key) return fail('authenticated boot log contains no IDKS');
    let binding = bind2(handshakeSpki, nonce, rid);
    if (shieldRelease !== undefined) {
      if (shieldRelease?.purpose !== 'enclave-shield-secrets/1') return fail('invalid Shield release purpose');
      binding = releaseBinding({id:shieldRelease.id, transportSpki:handshakeSpki, ticket:nonce, runtimeId:rid, sealKey:shieldRelease.sealKey});
    }
    const result = verifyVbsVmReport({ envelope: report.envelope,
      idksPublicKey: rsaKeyFromModulus(key.modulus, key.exponent),
      expectedUserData: vbsAppUserData(binding, expectedAppSha256),
      allowedMeasurements: policy.allowedMeasurements, minimumGuestSvn: policy.minimumGuestSvn ?? 0,
      imageIdentities: policy.imageIdentities });
    if (!result.ok) return result;
    return { ok: true, scope: 'hardware-bound app evidence; admission is a separate policy decision',
      measurement: result.measurement, identity: result.identity, appSha256: expectedAppSha256, runtimeId: expectedRuntimeId,
      boot: host.boot };
  } catch (e) { return fail(e.message); }
}
