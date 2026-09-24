// Verify the M4b plane's attestation report against the AMD chain, and against what the build SAID it would be.
//
// WHY THIS EXISTS. verify-measured-boot.sh read MEASUREMENT out of the bytes the guest printed and checked that
// the SVSM's status field was zero. That is the SVSM saying "success", not the PSP saying anything, so the
// sentence "MEASUREMENT equals igvmmeasure" was a statement about UNAUTHENTICATED bytes. Under this repo's rule
// - "attested" only ever means the AMD chain verified - it could not be called attested, and the fix is to
// verify it rather than to relabel it. Raised by the independent reviewer (enclave-59, 2026-09-24).
//
// Four more things the harness took on trust, all closed here:
//   VMPL      must be 2. The launch measurement is identical at every level, so this field is the ONLY thing
//             separating a report fetched by the plane from one fetched by a VMPL0 component. It is the M3b
//             forged-tuple lesson and it has to be pinned, not printed.
//   POLICY    must be the launch policy the IGVM was built with.
//   the app id expectation comes from the MANIFEST, the build's own statement of what was compiled in, not from
//             the harness's environment - so a disagreement between the two is a finding rather than invisible.
//   the binding report_data[0:32] is RECOMPUTED as Bind2(spki, nonce, RuntimeID) with the contract's own
//             implementation, rather than asserted to be "the SVSM's binding".
//
// usage: verify-report.mjs <workdir> <manifest.json> <vcek.der> <amd-chain.pem> <product> <min-tcb.json>
import fs from 'node:fs';
import { verifyQuote, parseSnpReport, seedCertChain } from '../../relay/snp-verify.mjs';
import { bind2 } from '../contract/runtime.mjs';

const [W, manPath, vcekPath, chainPath, product, minTcbPath] = process.argv.slice(2);
if (!minTcbPath) {
  console.error('usage: verify-report.mjs <workdir> <manifest.json> <vcek.der> <amd-chain.pem> <product> <min-tcb.json>');
  process.exit(2);
}
const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
const ev = fs.readFileSync(`${W}/control.evidence`, 'latin1');

// The guest prints these; take them from the run rather than from the source, so the check is over what ran.
const pick = (k) => {
  const m = [...ev.matchAll(new RegExp(`ADMIT ${k}=([0-9a-fA-F]+)`, 'g'))].pop();
  return m ? m[1] : null;
};
const respHex = pick('report_after_re_admit_hex') || pick('report_hex');
const keyHex = pick('key_registered');
if (!respHex) { console.error('FAIL: the run published no report'); process.exit(1); }
if (!keyHex) { console.error('FAIL: the run does not record the registered key, so the binding cannot be recomputed'); process.exit(1); }
// The nonce the guest wrote to `bind`. This IS the constant from admitinit.c - the run records that a nonce was
// set but not its value - so it is not read from the run, and an earlier comment here claimed otherwise. What
// makes it sound anyway is that the SVSM computed the binding over the nonce it actually received: if the guest
// had used a different one, Bind2 below would not match and the check would fail. So the value is confirmed by
// agreement rather than assumed - but the better fix is for admitinit to print what it wrote, and it does not yet.
const nonceLine = /ADMIT nonce_set=ok/.test(ev);
if (!nonceLine) { console.error('FAIL: the run does not show the nonce being set'); process.exit(1); }
const NONCE = Buffer.from('a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90', 'hex');

// Strip the SVSM's SnpReportResponse header: status(4) + report_size(4) + reserved(24).
const raw = Buffer.from(respHex, 'hex');
const status = raw.readUInt32LE(0), size = raw.readUInt32LE(4);
const report = raw.subarray(32, 32 + size);
console.log(`published ${raw.length} bytes; response status=${status} report_size=${size}`);
if (status !== 0) { console.error('FAIL: non-zero SVSM status'); process.exit(1); }
if (report.length < 0x2a0 + 0x90) {
  console.error(`FAIL: ${report.length} report bytes, too few to contain the signature at 0x2a0 - the publication `
    + 'is truncated and the chain cannot be checked');
  process.exit(1);
}

const spki = Buffer.from(keyHex, 'hex');
const rid = Buffer.from((man.identity.ENCLAVE_RUNTIME_IDS || '').split(',')[1] || '', 'hex');
const wantApp = ((man.identity.ENCLAVE_APP_IDS || '').split(',')[1] || '').toLowerCase();
if (rid.length !== 32) { console.error('FAIL: the manifest states no plane-2 RuntimeID'); process.exit(1); }
if (!wantApp || wantApp === '0'.repeat(64)) { console.error('FAIL: the manifest states no plane-2 app id'); process.exit(1); }

const p = parseSnpReport(report);
console.log(`report version=${p.version} vmpl=${p.vmpl} policy=0x${p.policy.toString(16)}`);
console.log(`reported_tcb=${p.reportedTcb.toString('hex')} chip_id=${p.chipId.toString('hex').slice(0, 32)}...`);

const expectedBinding = bind2(spki, NONCE, rid);
const vcekTable = (der) => {
  const hdr = Buffer.alloc(48);
  Buffer.from('63da758de6644564adc5f4b93be8accd', 'hex').copy(hdr, 0);
  hdr.writeUInt32LE(48, 16); hdr.writeUInt32LE(der.length, 20);
  return Buffer.concat([hdr, der]);
};
seedCertChain(product, fs.readFileSync(chainPath, 'utf8'));

let bad = 0;
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'ok   ' : 'WRONG'} ${what}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) bad++;
};

const res = await verifyQuote(report, {
  challenge: NONCE,
  transportKeySpki: spki,
  allowedMeasurements: [man.igvm.launchDigest.toLowerCase()],
  auxblob: vcekTable(fs.readFileSync(vcekPath)),
  kds: false,
  requireVcek: true,
  minTcb: JSON.parse(fs.readFileSync(minTcbPath, 'utf8')),
  expectedVmpl: 2,
  expectedBinding,
});
// The production verifier's reason strings are its own wording, and one of them reads "measurement on Metal
// release allowlist" whatever set was passed. The set here is exactly one digest - this build's - and a reader
// would otherwise take that phrase to mean the digest is on Metal's PRODUCTION allowlist. It is not.
console.log(`allowed measurement set = { ${man.igvm.launchDigest} }  (this build only, NOT Metal's production allowlist)`);
check(res.ok === true, 'the AMD chain verifies this report (VCEK -> ASK -> ARK), offline against the pinned root',
  res.reasons.join('; '));
check(res.vcekVerified === true, 'the signature was checked against a VCEK, not merely parsed');
check(res.tcb && res.tcb.checked === true,
  `the reported TCB meets the pinned minimum (${res.tcb ? res.tcb.product : '?'})`,
  `pinned ${JSON.stringify(JSON.parse(fs.readFileSync(minTcbPath, 'utf8')))}\n        reported ${p.reportedTcb.toString('hex')}`
  + '\n        NOTE: this minimum equals the values this part currently reports, so it is a pin at today\'s TCB'
  + '\n        rather than a floor below it. It refuses a DOWNGRADE; it does not test the comparison.');
check(p.vmpl === 2, 'VMPL is 2: this report was fetched by the plane, not by a VMPL0 component');
const wantPolicy = BigInt(man.igvm.policy || 0x30000);
check(p.policy === wantPolicy, `POLICY is the launch policy 0x${wantPolicy.toString(16)}`, `report says 0x${p.policy.toString(16)}`);
check(p.measurement.toString('hex').toLowerCase() === man.igvm.launchDigest.toLowerCase(),
  "MEASUREMENT equals the manifest's launch digest");
check(p.reportData.subarray(32, 64).toString('hex') === wantApp,
  'report_data[32:64] is the app id the MANIFEST says was compiled in',
  `report ${p.reportData.subarray(32, 64).toString('hex')}\n        manifest ${wantApp}`);
check(Buffer.compare(p.reportData.subarray(0, 32), expectedBinding) === 0,
  'report_data[0:32] is Bind2(registered key, nonce, RuntimeID), recomputed with the contract implementation');

console.log(bad === 0
  ? 'ATTESTED: the chain verified, and every field equals what the build stated'
  : `${bad} field(s) not as stated - do not call this attested`);
process.exit(bad === 0 ? 0 : 1);
