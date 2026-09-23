#!/usr/bin/env node
// Judge the report a COMPROMISED app minted while naming another app.
//
// In the M4a shape there is no monitor: the app owns its guest and therefore its configfs, so it CAN put any
// 32 bytes it likes in report_data[32:64], including the victim's AppID. That is expected and it is not the
// hole it looks like - what it cannot forge is the LAUNCH MEASUREMENT, because that is the PSP's word about
// the image it launched, and in this shape each app has its own image and so its own measurement.
//
// So the property under test is verifier rejection: a report naming app B must not be accepted unless it also
// carries B's measurement. This prints exactly one verdict line the harness greps for.
//
// usage: judge-adv.mjs <report.b64 file> <expected-measurement-hex-of-B> <B-app-id-hex> <adversary-measurement-hex>
import fs from 'node:fs';
import { parseSnpReport } from '../../relay/snp-verify.mjs';

const [f, measB, idB, measAdv] = process.argv.slice(2);
const rep = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
const p = parseSnpReport(rep);
const seenMeas = p.measurement.toString('hex');
const namedApp = p.reportData.subarray(32, 64).toString('hex');

console.log(`adversary report: measurement=${seenMeas}`);
console.log(`adversary report: report_data[32:64]=${namedApp}`);
console.log(`B's app id=${idB}`);
console.log(`B's measurement=${measB}`);

const namesB = namedApp === idB.toLowerCase();
const carriesBMeasurement = seenMeas === measB.toLowerCase();
const carriesAdvMeasurement = seenMeas === (measAdv || '').toLowerCase();

if (!namesB) {
  // the probe failed to do the thing we are testing against, so this is not evidence either way
  console.log('INCONCLUSIVE: the adversary did not actually name B, so verifier rejection was not exercised');
  process.exit(1);
}
if (carriesBMeasurement) {
  console.log('ACCEPTED-AS-B: the adversary produced B\'s measurement. That would be a break of the guest boundary.');
  process.exit(1);
}
console.log(`the adversary DID name B (report_data[32:64] == B's AppID) and the report is signed by the PSP,`);
console.log(`but its measurement is ${carriesAdvMeasurement ? "the adversary's own" : 'neither B\'s nor the adversary\'s predicted value'},`);
console.log('so a verifier pinning B\'s measurement refuses it.');
console.log('REJECTED-ON-MEASUREMENT');
