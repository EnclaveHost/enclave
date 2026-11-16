// The vectors isolation/m2/capacity checks itself against, from the code that defines the work and the messages
// (network/proof-of-capacity-host.mjs, network/proof-of-capacity.mjs, network/proof-of-capacity-card.mjs) and from viem.
//   node isolation/m2/capacity/vectors.mjs           -> prints them
//   node isolation/m2/capacity/vectors.mjs --write   -> testdata/vectors.json
// test/proof-of-capacity-partition.test.mjs refuses a file that is not what this prints.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {hashTypedData} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {capacityLanes, challengeMessage, answerMessage} from '../../../network/proof-of-capacity-host.mjs';
import {reportMessage, selfMessage, proofMessage} from '../../../network/proof-of-capacity.mjs';
import {cardChallengeMessage} from '../../../network/proof-of-capacity-card.mjs';

const H = n => '0x' + createHash('sha256').update('capacity vector ' + n).digest('hex');
const domain = {chainId: 8453, contract: '0x' + H('contract').slice(2, 42)};
// a key no file states: the SHA-256 of a sentence
export const TEST_KEY = '0x' + createHash('sha256').update('enclave host capacity test key').digest('hex');
const flat = m => Object.fromEntries(Object.entries(m.message).map(([k, v]) => [k, typeof v === 'bigint' || typeof v === 'number' ? String(v) : v]));

export async function vectors() {
  const account = privateKeyToAccount(TEST_KEY);
  const work = [];
  for (const [rounds, memoryMiB, lanes] of [[1, 1, 1], [2000, 1, 1], [3000, 2, 3], [500, 3, 5]]) {
    const seed = H(`work ${rounds} ${memoryMiB} ${lanes}`);
    work.push({seed, rounds, memoryMiB, lanes, digest: await capacityLanes({seed, rounds, memoryMiB, lanes})});
  }
  const seed = H('seed'), nonce = H('nonce');
  const workSeed = {seed, nonce, out: '0x' + createHash('sha256').update(Buffer.from(seed.slice(2) + nonce.slice(2), 'hex')).digest('hex')};
  const c = {epoch: 7, checker: H('checker'), target: H('target'), seed, nonce, rounds: 1500, memoryMiB: 2, lanes: 3};
  const typed = [
    challengeMessage(domain, c),
    answerMessage(domain, {epoch: 7, checker: c.checker, target: c.target, nonce, digest: H('digest')}),
    reportMessage(domain, {epoch: 7, checker: c.checker, target: c.target, verdict: 2, seed, evidence: H('evidence')}),
    selfMessage(domain, {epoch: 7, host: c.target, anchorBlock: 123456789, anchorHash: H('anchor'), evidence: H('evidence')}),
    proofMessage(domain, {id: H('deployment'), enclaveId: c.target, operator: '0x' + H('operator').slice(2, 42), upto: 1800000000, anchorBlock: 123456789, anchorHash: H('anchor')}),
    cardChallengeMessage(domain, {epoch: 7, checker: c.checker, target: c.target, seed, nonce, card: 1, k: 4096, n: 4096, batch: 32, frames: 19}),
  ];
  const messages = [];
  for (const m of typed) messages.push({primaryType: m.primaryType, values: flat(m), digest: hashTypedData(m),
    signature: m.primaryType === 'CapacityAnswer' ? null : await account.signTypedData(m)});
  // the answer the partition gives to challenge c: the work's digest, and the test key's signature over it
  const digest = await capacityLanes({seed: workSeed.out, rounds: c.rounds, memoryMiB: c.memoryMiB, lanes: c.lanes});
  const answer = {challenge: c, digest, signature: await account.signTypedData(answerMessage(domain, {epoch: c.epoch, checker: c.checker, target: c.target, nonce, digest}))};
  return {domain, address: account.address.toLowerCase(), work, workSeed, messages, answer};
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const text = JSON.stringify(await vectors(), null, 1) + '\n';
  if (process.argv.includes('--write')) fs.writeFileSync(new URL('./testdata/vectors.json', import.meta.url), text); else process.stdout.write(text);
}
