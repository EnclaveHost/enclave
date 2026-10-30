import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';
import { initialRestartState, restartFailure, restartHealthy, restartUnhealthy, restartDecision,
  ownerResumeRestartState, validateRestartState } from '../network/deployment-restart-policy.mjs';
import { signServingPermit, verifyServingPermit } from '../network/deployment-serving-permit.mjs';

const policy = { baseMs: 1000, maxMs: 4000, maxFailures: 4, healthyMs: 10000 };
test('a crash loop backs off exponentially, counts each dead instance once and stays held after time passes', () => {
  let s = initialRestartState();
  for (let i = 1; i <= 4; i++) {
    s = restartFailure(s, { identity: `instance-${i}`, now: i * 10000, random: () => 0, policy });
    assert.equal(s.nextAt - i * 10000, [500, 1000, 2000, 2000][i - 1]);
    const repeated = restartFailure(s, { identity: `instance-${i}`, now: i * 10000 + 1, random: () => { throw Error('must not jitter again'); }, policy });
    assert.equal(repeated.failures, i); assert.equal(repeated.nextAt, s.nextAt);
    assert.equal(restartDecision(s, i * 10000).start, false);
    s = validateRestartState(JSON.parse(JSON.stringify(s))); // host restart
  }
  assert.equal(restartDecision(s, 1000000).start, false);
  assert.equal(restartHealthy(s, { now: 1000000, policy }).held, true);
  assert.equal(restartDecision(ownerResumeRestartState(s, 1000000), 1000000).start, true);
});
test('only sustained healthy service clears the failure counter; interrupted health restarts the timer', () => {
  let s = restartFailure(initialRestartState(), { identity: 'dead-1', now: 1000, random: () => 0, policy });
  s = restartHealthy(s, { now: 2000, policy });
  s = restartHealthy(s, { now: 11999, policy }); assert.equal(s.failures, 1);
  s = restartUnhealthy(s, 12000);
  s = restartHealthy(s, { now: 13000, policy }); assert.equal(s.failures, 1);
  s = restartHealthy(s, { now: 23000, policy }); assert.equal(s.failures, 0);
});
test('clock rollback, corrupt state and bad jitter fail closed', () => {
  const s = restartFailure(initialRestartState(), { identity: 'a', now: 1000, policy, random: () => 0 });
  assert.throws(() => restartDecision(s, 999), /clock/);
  assert.throws(() => validateRestartState({ ...s, failures: -1 }), /failures/);
  assert.throws(() => restartFailure(s, { identity: 'b', now: 1001, policy, random: () => 1 }), /jitter/);
});

const accounts = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey()));
const pins = { chainId: 8453, lifecycle: accounts[4].address };
const record = { deployment: keccak256(toBytes('test deployment')), host: keccak256(toBytes('test host')),
  generation: 4, policyRevision: 1, sequence: 9, issuedAt: 1000, validUntil: 1020 };
const assignment = { deployment: record.deployment, host: record.host, generation: 4,
  policyRevision: 1, state: 'running', observedAt: 1000, blockTimestamp: 1000,
  authorityTier: 'safe', proofVerified: true, admitted: true, funded: true };
const witnesses = { revision: 1, witnesses: accounts.slice(0, 4).map(a => a.address), threshold: 3 };
const signed = async (r = record, who = accounts.slice(0, 3), p = pins) => ({ record: r,
  signatures: await Promise.all(who.map(a => signServingPermit(a, p, r))) });
const options = { pins, assignment, policy: witnesses, nowSec: 1002 };

test('a current witness quorum grants a bounded off-chain permit', async () => {
  const verified = await verifyServingPermit(await signed(), options);
  assert.equal(verified.serveUntil, 1018); assert.equal(verified.signers.length, 3);
  await verifyServingPermit(await signed(), { ...options, floor: verified.floor });
});
test('one witness, duplicate signatures, outsiders and duplicate configured witnesses cannot form a quorum', async () => {
  await assert.rejects(verifyServingPermit(await signed(record, [accounts[0]]), options), /quorum/);
  await assert.rejects(verifyServingPermit(await signed(record, [accounts[0], accounts[1], accounts[0]]), options), /duplicate/);
  await assert.rejects(verifyServingPermit(await signed(record, [accounts[0], accounts[1], accounts[4]]), options), /unauthorized/);
  await assert.rejects(verifyServingPermit(await signed(), { ...options, policy: { ...witnesses,
    witnesses: [accounts[0].address, accounts[0].address, accounts[1].address, accounts[2].address] } }), /duplicate/);
});
test('revocation, reassignment, expired permits and stale chain authority fence the old host', async () => {
  const e = await signed();
  for (const update of [{ state: 'queued' }, { state: 'stopped' }, { generation: 5 },
    { host: keccak256(toBytes('replacement')) }, { policyRevision: 2 }])
    await assert.rejects(verifyServingPermit(e, { ...options, assignment: { ...assignment, ...update } }), /current/);
  await assert.rejects(verifyServingPermit(e, { ...options, nowSec: 1018 }), /expired/);
  await assert.rejects(verifyServingPermit(e, { ...options, assignment: { ...assignment, observedAt: 980 } }), /stale/);
  await assert.rejects(verifyServingPermit(e, { ...options, assignment: { ...assignment, blockTimestamp: 980 } }), /stale/);
  for (const update of [{ admitted: false }, { funded: false }])
    await assert.rejects(verifyServingPermit(e, { ...options, assignment: { ...assignment, ...update } }), /disabled/);
  for (const update of [{ authorityTier: 'unsafe' }, { proofVerified: false }])
    await assert.rejects(verifyServingPermit(e, { ...options, assignment: { ...assignment, ...update } }), /unqualified/);
});
test('domain separation, tampering, replay and equivocation are refused', async () => {
  const e = await signed();
  await assert.rejects(verifyServingPermit(e, { ...options, pins: { ...pins, chainId: 1 } }), /unauthorized/);
  await assert.rejects(verifyServingPermit(e, { ...options, pins: { ...pins, lifecycle: accounts[0].address } }), /unauthorized/);
  await assert.rejects(verifyServingPermit({ ...e, record: { ...record, sequence: 10 } }, options), /unauthorized/);
  const good = await verifyServingPermit(e, options);
  await assert.rejects(verifyServingPermit(await signed({ ...record, sequence: 8 }), { ...options, floor: good.floor }), /replay/);
  await assert.rejects(verifyServingPermit(await signed({ ...record, validUntil: 1019 }), { ...options, floor: good.floor }), /equivocation/);
  await assert.rejects(signed({ ...record, validUntil: 2000 }), /lifetime/);
});
