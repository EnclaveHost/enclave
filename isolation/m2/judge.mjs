// The M2 verdict: what a client may conclude from a domain's attestation document, and whether that
// conclusion opens the gate for application traffic. One function, shared by client.mjs and the
// negative tests, so the rule that is tested is the rule that runs.
//
// Verdicts:
//   attested         a T1 report whose AMD signature chain (VCEK -> ASK -> pinned ARK) VERIFIED, and whose
//                    policy, VMPL, measurement, key binding and app naming all check out
//   unauthenticated  the same field checks pass but the AMD chain did NOT verify. Nothing authenticates
//                    those fields, so a host could have written every one of them. Lab diagnostic only
//   not-attested     a T0 domain, which has no hardware report
//   reject           anything else
//
// Modes, and the only verdicts that open the gate in each:
//   trusted          (default) attested
//   lab-unsigned     attested, unauthenticated   explicit lab-only diagnostic for chips with no VCEK
//   t0-diagnostic    not-attested                explicit; talking to a T0 domain is never trusted
import { verifyQuote, parseSnpReport } from '../../relay/snp-verify.mjs';

export const MODES = ['trusted', 'lab-unsigned', 't0-diagnostic'];
const OPENS = { trusted: ['attested'], 'lab-unsigned': ['attested', 'unauthenticated'], 't0-diagnostic': ['not-attested'] };

export async function judge(doc, handshakeSpki, nonce, { measurement, appSha, mode = 'trusted' }) {
  if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
  const out = (verdict, reasons, extra = {}) => ({ verdict, reasons, gateOpen: OPENS[mode].includes(verdict), ...extra });

  if (doc.format === 'none') {
    const reasons = [doc.reason || 'no hardware report'];
    if (mode !== 't0-diagnostic') reasons.push(`a T0 domain is never trusted; ${mode} mode refuses it (--t0-diagnostic talks to it explicitly)`);
    else reasons.push('T0 diagnostic: the pin is trust-on-first-use and the host can read and change this traffic');
    return out('not-attested', reasons);
  }
  if (mode === 't0-diagnostic') return out('reject', [`t0-diagnostic mode expects a T0 domain, got format ${doc.format}`]);
  if (doc.format !== 'sev-snp-guest-domain-v1' || !doc.report) return out('reject', [`unknown attestation format ${doc.format}`]);

  const report = Buffer.from(doc.report, 'base64');
  let p;
  try { p = parseSnpReport(report); } catch (e) { return out('reject', [`unparseable report: ${e.message}`]); }
  const extra = { measurement: p.measurement.toString('hex'), reportData: p.reportData.toString('hex') };
  const v = await verifyQuote(report, {
    challenge: nonce, transportKeySpki: handshakeSpki, allowedMeasurements: [measurement],
    auxblob: doc.certs ? Buffer.from(doc.certs, 'base64') : null,
    requireVcek: mode === 'trusted',      // lab-unsigned alone may continue without the chain
  });
  const reasons = [...v.reasons];
  if (!v.ok) return out('reject', reasons, extra);
  if (p.reportData.subarray(32, 64).toString('hex') !== appSha) {
    reasons.push('report_data[32:64] does not name the expected app');
    return out('reject', reasons, extra);
  }
  reasons.push('report_data[32:64] names the expected app');
  if (v.vcekVerified === true) return out('attested', reasons, extra);
  reasons.push('UNAUTHENTICATED: the AMD signature chain did not verify, so every field above is unauthenticated '
    + '(a host could have written them); lab diagnostic only, not attestation');
  return out('unauthenticated', reasons, extra);
}
