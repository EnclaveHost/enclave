// relay/vbs-app-core.mjs: the parts of relay/vbs-app-verify.mjs that need no node:crypto and no host session, shared with
// the browser verifier (verifier/web/shield-app.mjs) so both read an app's document by the same rules and word a refusal the
// same way. The runtime digest and binding are passed in ({ runtimeId, validateRuntimeIdentity }), so each side hashes with
// its own SHA-256. What stays in vbs-app-verify.mjs: the host session's verification and the IDKS read from its log.
import { ABI2 } from './vbs-runtime.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
export const VBS_APP_MAX_REPORT_CHARS = 32768, VBS_APP_MAX_VM_REPORT_CHARS = 12000;

// The document against what the caller asked for, in vbs-app-verify.mjs's order. -> { reason, checks, rid }: reason is the
// first refusal (null when none), checks = { document, app, runtime } each true/false (undefined when the caller's own inputs
// were refused first): document = ABI/2, this nonce, this TLS key; app = the expected app; runtime = an admissible identity
// whose id is the expected one. rid (Buffer) only when runtime holds.
export function vbsAppDocChecks({ doc, handshakeSpki, nonce, expectedAppSha256, expectedRuntimeId } = {}, { runtimeId, validateRuntimeIdentity }) {
  const checks = { document: undefined, app: undefined, runtime: undefined };
  if (!Buffer.isBuffer(handshakeSpki) || handshakeSpki.length < 32 || handshakeSpki.length > 4096 ||
      !Buffer.isBuffer(nonce) || nonce.length !== 32) return { reason: 'actual TLS SPKI and fresh nonce required', checks, rid: null };
  if (!HEX64.test(expectedAppSha256 || '') ||
      !HEX64.test(expectedRuntimeId || '')) return { reason: 'explicit app and runtime pins required', checks, rid: null };
  checks.document = !!doc && doc.abi === ABI2 && doc.nonce === nonce.toString('hex') && doc.transportKey === handshakeSpki.toString('base64');
  checks.app = !!doc && doc.appSha256 === expectedAppSha256;
  let runtimeError = doc ? validateRuntimeIdentity(doc.runtime) : 'no document', rid = null;
  if (!runtimeError) { rid = runtimeId(doc.runtime); if (rid.toString('hex') !== expectedRuntimeId) runtimeError = 'runtime identity is not pinned'; }
  checks.runtime = !runtimeError;
  const reason = !(checks.document && checks.app) ? 'document differs from the requested app, handshake, nonce or ABI' : runtimeError;
  return { reason, checks, rid: checks.runtime ? rid : null };
}

// The guest's report out of the document, bounded: -> { envelope } | { reason }. Throws on a report that is not JSON (the
// caller's catch words it).
export function vbsAppReportEnvelope(doc) {
  if (typeof doc.report !== 'string' || doc.report.length > VBS_APP_MAX_REPORT_CHARS) return { reason: 'report missing or oversized' };
  const report = JSON.parse(Buffer.from(doc.report, 'base64').toString('utf8'));
  if (typeof report.vbsVmReport !== 'string' || report.vbsVmReport.length > VBS_APP_MAX_VM_REPORT_CHARS)
    return { reason: 'guest VBS report missing or oversized' };
  return { envelope: Buffer.from(report.vbsVmReport, 'base64') };
}

// policy.platforms: explicit {ekCertSha256, pcr0} pins, or "attested" (the open market): any TPM whose EK chains to the
// pinned ekRoots, on a boot that passed the production checks (Secure Boot on, no test signing; hvnode-verify.mjs).
// "attested" admits any firmware (PCR 0) on such a TPM: it says the app ran isolated on genuine hardware, not on whose.
// (relay/shield-app-policy.mjs re-exports both.)
export const platformsValid = platforms => platforms === 'attested' || (Array.isArray(platforms) && platforms.length > 0 &&
  platforms.every(p => HEX64.test(p?.ekCertSha256 || '') && HEX64.test(p?.pcr0 || '')));
// a VERIFIED boot (an admissible hvnode-verify verdict's .boot) on an admitted platform
export const platformAdmitted = (platforms, boot) => platformsValid(platforms) && HEX64.test(boot?.ekCertSha256 || '') &&
  (platforms === 'attested' || platforms.some(p => p.ekCertSha256 === boot.ekCertSha256 && p.pcr0 === boot.pcr0));

// the 64 bytes the guest put in its report: the ABI/2 binding, then the app's SHA-256
export const vbsAppUserData = (binding, expectedAppSha256) => Buffer.concat([binding, Buffer.from(expectedAppSha256, 'hex')]);
