// The M2 verdict: what a client may conclude from a domain's attestation document, and whether that
// conclusion opens the gate for application traffic. One function, shared by client.mjs and the
// negative tests, so the rule that is tested is the rule that runs.
//
// Verdicts:
//   attested         a T1 report whose AMD signature chain (VCEK -> ASK -> pinned ARK) VERIFIED, whose VCEK
//                    names this chip and TCB, whose reported TCB meets the caller's minimum-TCB policy, and
//                    whose policy, VMPL, measurement, key binding and app naming all check out
//   no-tcb-policy    all of that except the TCB: no minimum-TCB policy was supplied, so the platform's
//                    firmware level is unjudged. Authenticated, but not accepted
//   unauthenticated  the field checks pass but the AMD chain did NOT verify. Nothing authenticates those
//                    fields: a host could have written every one of them. Lab diagnostic only
//   not-attested     a T0 domain, which has no hardware report
//   reject           anything else
//
// Modes, and the only verdicts that open the gate in each:
//   trusted          (default) attested
//   lab-unsigned     attested, no-tcb-policy, unauthenticated   explicit lab-only diagnostic
//   t0-diagnostic    not-attested                               explicit; a T0 domain is never trusted
//
// want = { measurement, appSha, mode, minTcb?, vcek?, kds? }
//   minTcb  the caller's floor, passed to relay/snp-verify.mjs checkMinTcb unchanged; nothing picks one here
//   vcek    a VCEK (DER) the caller already holds, used exactly like one in the report's certificate table:
//           it must sign the report, chain to AMD's pinned root and name this chip and TCB
//   kds     false: never contact AMD KDS (the VCEK and the chain must then be supplied)
//   expectedVmpl  the plane the report must come from, passed through to relay/snp-verify.mjs. Default 0.
//                 A domain running beneath a VMPL0 monitor reports its own level, and every level shares
//                 one launch measurement, so this field is what tells them apart
import { verifyQuote, parseSnpReport } from '../../relay/snp-verify.mjs';

export const MODES = ['trusted', 'lab-unsigned', 't0-diagnostic'];
const OPENS = { trusted: ['attested'], 'lab-unsigned': ['attested', 'no-tcb-policy', 'unauthenticated'], 't0-diagnostic': ['not-attested'] };

// the certificate table configfs-tsm returns, holding one VCEK: {guid, offset, length}, zero-terminated
export function vcekTable(vcekDer) {
  const hdr = Buffer.alloc(48);
  Buffer.from('63da758de6644564adc5f4b93be8accd', 'hex').copy(hdr, 0);
  hdr.writeUInt32LE(48, 16);
  hdr.writeUInt32LE(vcekDer.length, 20);
  return Buffer.concat([hdr, vcekDer]);
}

export async function judge(doc, handshakeSpki, nonce, { measurement, appSha, mode = 'trusted', minTcb, vcek, kds = true, expectedVmpl }) {
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
  const extra = { measurement: p.measurement.toString('hex'), reportData: p.reportData.toString('hex'),
    vmpl: p.vmpl };   // which privilege level the report came from, so a caller can show it, not just pin it
  const auxblob = doc.certs ? Buffer.from(doc.certs, 'base64') : vcek ? vcekTable(vcek) : null;
  const v = await verifyQuote(report, {
    challenge: nonce, transportKeySpki: handshakeSpki, allowedMeasurements: [measurement], auxblob, kds,
    requireVcek: mode === 'trusted',      // lab-unsigned alone may continue without the chain
    ...(minTcb !== undefined ? { minTcb } : {}),
    ...(expectedVmpl !== undefined ? { expectedVmpl } : {}),
  });
  const reasons = [...v.reasons];
  if (v.tcb) extra.tcb = v.tcb;
  if (!v.ok) return out('reject', reasons, extra);
  if (p.reportData.subarray(32, 64).toString('hex') !== appSha) {
    reasons.push('report_data[32:64] does not name the expected app');
    return out('reject', reasons, extra);
  }
  reasons.push('report_data[32:64] names the expected app');
  if (v.vcekVerified !== true) {
    reasons.push('UNAUTHENTICATED: the AMD signature chain did not verify, so every field above is unauthenticated '
      + '(a host could have written them); lab diagnostic only, not attestation');
    return out('unauthenticated', reasons, extra);
  }
  if (!v.tcb || v.tcb.checked !== true) {
    reasons.push('NOT ACCEPTED: the AMD chain verified, but no minimum-TCB policy was supplied, so the firmware level '
      + 'is unjudged (supply --min-tcb)');
    return out('no-tcb-policy', reasons, extra);
  }
  return out('attested', reasons, extra);
}
