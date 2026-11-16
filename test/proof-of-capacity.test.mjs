// The hosts' side of EnclaveProofOfCapacity (network/proof-of-capacity.mjs). The three digests are held to the
// contract's own (contracts/foundry/test/EnclaveProofOfCapacity.t.sol testDigestVectors asserts the same values).
import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256, toBytes, pad, toHex, recoverTypedDataAddress} from 'viem';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {reportMessage, selfMessage, proofMessage, digestOf, evidenceDigest, dutyRound, standingRound, VERDICT} from '../network/proof-of-capacity.mjs';

const domain = {chainId: 8453, contract: '0x00000000000000000000000000000000000c0ffe'};
const A = pad(toHex(0xA1), {size: 32}), B = pad(toHex(0xB2), {size: 32}), C = pad(toHex(0xC3), {size: 32});
const seed = keccak256(toBytes('seed')), ev = keccak256(toBytes('evidence'));
export const VECTORS = {
  report: digestOf(reportMessage(domain, {epoch: 495000, checker: A, target: B, verdict: 1, seed, evidence: ev})),
  self: digestOf(selfMessage(domain, {epoch: 495000, host: A, seed, evidence: ev})),
  proof: digestOf(proofMessage(domain, {id: B, enclaveId: A, operator: '0x0000000000000000000000000000000000001234', upto: 1800000600, anchorBlock: 1099, anchorHash: keccak256(toBytes('anchor'))})),
};
const PINNED = {report: '0x13391c317e45a647fc8a1cffaab5b38edec71610cbaa1af9dbacd49a8903f6ba', self: '0xf0fb7c458454ef71aa272c79ecaa7ffe4aa67625218ced2da664dfc85e13ff80', proof: '0x8fe5b3045f7eb0e314870e125f23b10bd185ac176491b4a77413810c17ebd70d'};

test('the three digests are the contract\'s', () => { assert.deepEqual(VECTORS, PINNED); });

test('a message with a missing or impossible field is refused before anything is signed', () => {
  const ok = {epoch: 5, checker: A, target: B, verdict: 1, seed, evidence: ev};
  for (const bad of [{epoch: -1}, {checker: 'x'}, {target: A}, {verdict: 0}, {verdict: 4}, {seed: '0x' + '00'.repeat(32)}, {evidence: '0x12'}])
    assert.throws(() => reportMessage(domain, {...ok, ...bad}), JSON.stringify(bad));
  assert.throws(() => reportMessage({chainId: 0, contract: domain.contract}, ok));
  assert.throws(() => selfMessage(domain, {epoch: 5, host: A, seed: '0x' + '00'.repeat(32), evidence: ev}));
  assert.throws(() => evidenceDigest(''));
});

function world({targets = [B, C], done = {}, seedOf = seed, standing = [true, '']} = {}) {
  const key = privateKeyToAccount(generatePrivateKey());
  return {key, sign: m => key.signTypedData(m),
    reader: {epochNow: async () => 7n, seedOf: async () => seedOf, targetsOf: async () => targets,
      verdictOf: async (_e, _c, t) => done[t] || 0, standing: async () => standing}};
}

test('a round of duty: one signed report per assigned host not yet reported on; a check that throws is no verdict', async () => {
  const w = world({done: {[C]: 1}}), asked = [];
  const r = await dutyRound({domain, host: A, reader: w.reader, sign: w.sign,
    check: async (t, ctx) => { asked.push([t, ctx.epoch, ctx.seed]); return {verdict: 'unreachable', evidence: 'no answer in 10 s'}; }});
  assert.deepEqual(asked, [[B, 7, seed]]);
  assert.equal(r.reports.length, 1);
  const [rep] = r.reports;
  assert.deepEqual({epoch: rep.epoch, checker: rep.checker, target: rep.target, verdict: rep.verdict, evidence: rep.evidence},
    {epoch: 7, checker: A, target: B, verdict: VERDICT.unreachable, evidence: evidenceDigest('no answer in 10 s')});
  // the signature is the proof key's over exactly the contract's message
  const m = reportMessage(domain, {epoch: 7, checker: A, target: B, verdict: 3, seed, evidence: rep.evidence});
  assert.equal(await recoverTypedDataAddress({...m, signature: rep.signature}), w.key.address);

  const w2 = world();
  const r2 = await dutyRound({domain, host: A, reader: w2.reader, sign: w2.sign,
    check: async t => { if (t === B) throw new Error('my own uplink is down'); return {verdict: 'pass', evidence: 'ok'}; }});
  assert.deepEqual(r2.reports.map(x => [x.target, x.verdict]), [[C, 1]]);
  assert.deepEqual(r2.skipped, [{target: B, why: 'my own uplink is down'}]);
  const r3 = await dutyRound({domain, host: A, reader: w2.reader, sign: w2.sign, check: async () => ({verdict: 'maybe', evidence: 'x'})});
  assert.equal(r3.reports.length, 0); assert.equal(r3.skipped.length, 2);
});

test('an epoch with no seed has nothing to sign over', async () => {
  const w = world({seedOf: '0x' + '00'.repeat(32)});
  let checked = 0;
  const r = await dutyRound({domain, host: A, reader: w.reader, sign: w.sign, check: async () => { checked++; return {verdict: 'pass', evidence: 'x'}; }});
  assert.deepEqual(r, {epoch: 7, seed: null, reports: [], skipped: []}); assert.equal(checked, 0);
});

test('standing: in standing, nothing to do; its own proof only when that is what is missing; a duty or a fail is not signed away', async () => {
  let w = world();
  assert.deepEqual(await standingRound({domain, host: A, reader: w.reader, sign: w.sign, selfCheck: async () => { throw new Error('not asked'); }}), {epoch: 7, ok: true});
  for (const why of ['did not check the hosts it was assigned', 'failed its capacity checks']) {
    w = world({standing: [false, why]});
    assert.deepEqual(await standingRound({domain, host: A, reader: w.reader, sign: w.sign, selfCheck: async () => { throw new Error('not asked'); }}), {epoch: 7, ok: false, why});
  }
  w = world({standing: [false, 'needs its own proof of capacity']});
  const r = await standingRound({domain, host: A, reader: w.reader, sign: w.sign, selfCheck: async ctx => `measured under seed ${ctx.seed}`});
  assert.equal(r.ok, false); assert.equal(r.self.evidence, evidenceDigest(`measured under seed ${seed}`));
  assert.equal(await recoverTypedDataAddress({...selfMessage(domain, {epoch: 7, host: A, seed, evidence: r.self.evidence}), signature: r.self.signature}), w.key.address);
  w = world({standing: [false, 'needs its own proof of capacity'], seedOf: '0x' + '00'.repeat(32)});
  assert.equal((await standingRound({domain, host: A, reader: w.reader, sign: w.sign, selfCheck: async () => 'x'})).self, undefined);
});
