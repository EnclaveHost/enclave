// ROOT-RUN on minipc with the runtime node (C:\Program Files\Enclave\runtime\node\node.exe), inside the protected-temp
// procedure of PLAN.txt M4: node edit-privacy-config.mjs <privacy-config.json> <out-temp> <block.json> <expectSha256> <blockSha256>
// Adds ONLY enclaveNetwork.challengeReplica (network-enroll a9729786's slot: before walletAdmission, which stays last).
// Refuses unless: the input is the CAS-pinned bytes; it round-trips EXACTLY in network-enroll's own format
// (JSON.stringify(c, null, 2) + "\n"), so no other byte can change; the block is the reviewed bytes; no challengeReplica
// exists yet. Prints only shas and key NAMES (never a config value).
import fs from 'node:fs'; import { createHash } from 'node:crypto';
const [file, out, blockFile, expectSha, blockSha] = process.argv.slice(2);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fail = (m) => { console.error('REFUSED: ' + m); process.exit(2); };
const raw = fs.readFileSync(file); if (sha(raw) !== expectSha) fail('privacy-config is not the pinned sha (CAS)');
const braw = fs.readFileSync(blockFile); if (sha(braw) !== blockSha) fail('the block is not the reviewed bytes');
const text = raw.toString('utf8'), c = JSON.parse(text);
if (JSON.stringify(c, null, 2) + '\n' !== text) fail('the file is not in network-enroll format: an edit could change other bytes');
const e = c.enclaveNetwork; if (!e || typeof e !== 'object' || Array.isArray(e)) fail('no enclaveNetwork object');
if (e.challengeReplica !== undefined) fail('challengeReplica already present');
const wa = e.walletAdmission; delete e.walletAdmission;
e.challengeReplica = JSON.parse(braw.toString('utf8'));
if (wa !== undefined) e.walletAdmission = wa;                       // walletAdmission stays LAST (the hold helper's no-op rule)
const next = JSON.stringify(c, null, 2) + '\n';
// proof that nothing else changed: removing the block again gives the original bytes back
const back = JSON.parse(next); delete back.enclaveNetwork.challengeReplica;
if (JSON.stringify(back, null, 2) + '\n' !== text) fail('internal: the edit changed other bytes');
fs.writeFileSync(out, next);
console.log(JSON.stringify({ before: expectSha, after: sha(next), enclaveNetworkKeys: Object.keys(c.enclaveNetwork) }));
