#!/usr/bin/env node
// N3b's proof chain, in three steps that must ALL hold.
//
// The earlier version of this file called parseSnpReport and nothing else, then said the report was
// "signed by the PSP". That asserted more than it proved: parsing reads fields out of a blob that could have
// been fabricated wholesale. The rule this project applies everywhere else - "attested" only with the AMD
// chain verified (isolation/m2/judge.mjs) - has to apply here too, or N3b is a claim about bytes we made up.
//
//   1. AUTHENTIC: the exact report verifies through the real verifier - VCEK -> ASK -> pinned ARK, the VCEK
//      naming this chip and TCB, the reported TCB meeting the caller's floor, the guest policy sane, and the
//      report_data binding the key and nonce it claims. Against the ADVERSARY's own measured image.
//   2. NAMES B: report_data[32:64] is B's AppID, and the binding half is over B's transport key, so this is
//      as complete an impersonation of B as an adversary can construct.
//   3. REJECTED AS B: the same bytes, judged with B's expected measurement, are refused - and refused ON THE
//      MEASUREMENT, not for some incidental reason.
//
// Only if all three hold does this print AUTHENTICATED-AND-REJECTED-AS-B. Step 1 is what makes step 3 mean
// anything: without it, "rejected" could just mean "garbage in".
//
// usage: judge-adv.mjs <report.b64> <B-measurement> <B-appid> <ADV-measurement> <vcek.der> <min-tcb.json> <B-spki.b64> <nonce.hex> <amd-chain.pem> <product>
import fs from 'node:fs';
import { verifyQuote, parseSnpReport, seedCertChain } from '../../relay/snp-verify.mjs';

const [f, measB, idB, measAdv, vcekPath, minTcbPath, spkiPath, noncePath, chainPath, product] = process.argv.slice(2);
const rep = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
const vcek = fs.readFileSync(vcekPath);
const minTcb = JSON.parse(fs.readFileSync(minTcbPath, 'utf8'));
const spki = Buffer.from(fs.readFileSync(spkiPath, 'utf8').trim(), 'base64');
const nonce = Buffer.from(fs.readFileSync(noncePath, 'utf8').trim(), 'hex');
if (chainPath && product) seedCertChain(product, fs.readFileSync(chainPath, 'utf8'));

// the certificate table configfs-tsm would have returned, holding this chip's VCEK
function vcekTable(der) {
  const hdr = Buffer.alloc(48);
  Buffer.from('63da758de6644564adc5f4b93be8accd', 'hex').copy(hdr, 0);
  hdr.writeUInt32LE(48, 16);
  hdr.writeUInt32LE(der.length, 20);
  return Buffer.concat([hdr, der]);
}
const aux = vcekTable(vcek);
const common = { challenge: nonce, transportKeySpki: spki, auxblob: aux, kds: false, requireVcek: true, minTcb };

const p = parseSnpReport(rep);
const seenMeas = p.measurement.toString('hex');
const namedApp = p.reportData.subarray(32, 64).toString('hex');
console.log(`adversary report: measurement=${seenMeas}`);
console.log(`adversary report: report_data[32:64]=${namedApp}`);
console.log(`B's app id=${idB}`);
console.log(`B's measurement=${measB}`);

let bad = 0;
const step = (n, ok, why) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} step ${n}: ${why}`);
  if (!ok) bad++;
  return ok;
};

// 1. AUTHENTIC, against the adversary's own measured image
const auth = await verifyQuote(rep, { ...common, allowedMeasurements: [measAdv] });
for (const r of auth.reasons) console.log(`  chain: ${r}`);
step(1, auth.ok === true && auth.vcekVerified === true && auth.tcb && auth.tcb.checked === true,
  'the exact report verifies: VCEK -> ASK -> pinned ARK, VCEK names this chip and TCB, reported TCB meets the floor'
  + ` (ok=${auth.ok} vcekVerified=${auth.vcekVerified} tcbChecked=${auth.tcb ? auth.tcb.checked : 'n/a'})`);

// 2. NAMES B, as completely as an adversary can
step(2, namedApp === idB.toLowerCase(),
  `report_data[32:64] is B's AppID, and the binding half is over B's transport key: a complete impersonation attempt`);

// 3. REJECTED AS B, on the measurement
const asB = await verifyQuote(rep, { ...common, allowedMeasurements: [measB] });
const measReason = asB.reasons.some((r) => /measurement/i.test(r));
step(3, asB.ok === false && measReason,
  `judged with B's expected measurement it is REFUSED, on the measurement (${asB.reasons.filter((r) => /measurement/i.test(r)).join('; ') || asB.reasons.at(-1)})`);

if (seenMeas === measB.toLowerCase()) {
  console.log('ACCEPTED-AS-B: the adversary produced B\'s measurement. That would be a break of the guest boundary.');
  process.exit(1);
}
if (bad) { console.log(`PROOF-CHAIN-INCOMPLETE: ${bad} step(s) failed, so N3b is not established`); process.exit(1); }
console.log('the adversary minted a GENUINE, chain-verified, TCB-conforming report that names B and binds B\'s key,');
console.log('and a verifier pinning B\'s measurement still refuses it: the measurement is the app-naming authority.');
console.log('AUTHENTICATED-AND-REJECTED-AS-B');
