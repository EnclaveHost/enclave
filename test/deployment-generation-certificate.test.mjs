import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hashTypedData, keccak256, toBytes, recoverTypedDataAddress } from 'viem';
import { certificateWitnessesHash, generationAnchorDigest, generationTypedData, verifyGenerationChain } from '../network/deployment-generation-certificate.mjs';
import { transitionTypedData } from '../network/deployment-transition-intent.mjs';
import { DeploymentLifecycleWitness } from '../network/deployment-lifecycle-witness.mjs';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
import { signServingPermit, verifyServingPermit } from '../network/deployment-serving-permit.mjs';
import { canRestoreLifecycleDenial } from '../network/deployment-authority-window.mjs';
import { DeploymentLifecycleRunner } from '../network/deployment-lifecycle-runner.mjs';
import { createGenerationCollector } from '../network/deployment-permit-collector.mjs';
import { lifecycleWitnessHandler } from '../network/deployment-witness-http.mjs';

const accounts = Array.from({ length: 9 }, () => privateKeyToAccount(generatePrivateKey()));
const hash = text => keccak256(toBytes(text)), zero = `0x${'0'.repeat(64)}`, noAddress = `0x${'0'.repeat(40)}`;
const id = hash('generation app'), oldHost = hash('old host'), nextHost = hash('next host');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-cert-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pins = { chainId: 8453, lifecycle: accounts[4].address };
  const policy = { revision: 1, threshold: 3, witnesses: accounts.slice(0, 4).map(a => a.address),
    maxAnchorAgeSec: 1800, maxTransitionWei: '1000', stopReserveWei: '1000' };
  const anchor = { proofVerified: true, tier: 'finalized', hash: hash('anchor'), number: 100, timestamp: 1000, observedAt: 2000,
    enabled: true, admitted: true, hostAdmission: { host: nextHost, admitted: true },
    funded: true, fundedUntil: 2800, balanceWei: '100000', policyHash: certificateWitnessesHash(policy),
    ownerAuthority: accounts[7].address,
    assignment: { deployment: id, generation: 2, state: 'running', host: oldHost, operator: accounts[5].address,
      changedAt: 1000, startAfter: 0, failures: 0, crashHeld: false } };
  const head = { proofVerified: true, tier: 'unsafe', hash: hash('head'), number: 200, timestamp: 2000, observedAt: 2000,
    anchorHash: anchor.hash, ancestryVerified: true, denied: false };
  const f = { dir, pins, policy, anchor, head, nowSec: 2000, certificates: [] };
  f.advance = seconds => { f.nowSec += seconds; head.timestamp = f.nowSec; head.observedAt = f.nowSec; anchor.observedAt = f.nowSec; };
  f.witnesses = accounts.slice(0, 4).map((account, i) => new DeploymentLifecycleWitness({ account, pins,
    journal: openLifecycleJournal(path.join(dir, `witness-${i}.json`)), now: () => f.nowSec * 1000,
    authority: {
      read: async () => ({ generationAuthority: { ...f } }),
      readGeneration: async () => ({ ...f, candidate: { proofVerified: true, blockHash: anchor.hash, eligible: true,
        host: nextHost, operator: accounts[6].address } }),
    }, health: { verify: async (deployment, host, generation) => ({ verified: true, deployment, host, generation,
      ready: host === nextHost, ended: host === oldHost, instance: 'instance', validUntil: f.nowSec + 20 }) },
  }));
  return f;
}
async function proposal(f, action) {
  const parent = (await verifyGenerationChain(f.certificates, f)).assignment;
  const intent = { id, generation: parent.generation, revision: f.policy.revision, target: action,
    host: action === 2 ? nextHost : zero, deadline: f.nowSec + 60, healthySince: 0,
    payee: accounts[8].address, maxChargeWei: '1000' };
  const record = { deployment: id, anchorHash: f.anchor.hash, anchorNumber: f.anchor.number, policyRevision: f.policy.revision,
    witnessesHash: certificateWitnessesHash(f.policy), previous: parent.digest, generation: parent.generation + 1,
    host: intent.host, operator: action === 2 ? accounts[6].address : noAddress, action, issuedAt: f.nowSec,
    validUntil: 2800, fundedUntil: 2800, remainingWei: String(parent.remainingWei - 1000n),
    transitionIntent: hashTypedData(transitionTypedData(f.pins, intent)) };
  const actor = action === 2 ? accounts[6] : accounts[5];
  return { record, predecessors: [...f.certificates], intent, actorSignature: await actor.signTypedData(transitionTypedData(f.pins, intent)) };
}
async function certify(f, action) {
  const p = await proposal(f, action);
  const votes = await Promise.all(f.witnesses.slice(0, 3).map(w => w.generation(p)));
  const certificate = { record: p.record, signatures: votes.map(v => v.signature) };
  f.certificates.push(certificate);
  await verifyGenerationChain(f.certificates, f);
  return { p, certificate, votes };
}
test('old finalized policy plus fresh denial checks supports fenced failover without waiting for a new finalized block', async t => {
  const f = fixture(t); await certify(f, 1);
  await assert.rejects(proposal(f, 2).then(p => f.witnesses[0].generation(p)), /not startable/);
  f.advance(22); await certify(f, 2);
  const current = await verifyGenerationChain(f.certificates, f);
  assert.equal(current.assignment.host, nextHost); assert.equal(current.assignment.generation, 4);
  assert.equal(current.assignment.remainingWei, 98000n); assert.equal(current.authority.anchorAgeSec, 1022);
  assert.equal(f.anchor.number, 100); // no invented finality advancement
  const record = { deployment: id, host: nextHost, generation: 4, policyRevision: 1, sequence: 1,
    issuedAt: f.nowSec, validUntil: f.nowSec + 20 };
  const operatorSignature = await signServingPermit(accounts[6], f.pins, record);
  const votes = await Promise.all(f.witnesses.slice(0, 3).map(w => w.permit(record, operatorSignature)));
  await verifyServingPermit({ record, signatures: votes.map(v => v.signature) }, { pins: f.pins, generationAuthority: f, nowSec: f.nowSec });
});
test('a partitioned old host cannot obtain a quorum after three witnesses fenced it', async t => {
  const f = fixture(t); await certify(f, 1);
  const record = { deployment: id, host: oldHost, generation: 2, policyRevision: 1, sequence: 1, issuedAt: 2000, validUntil: 2020 };
  const signature = await signServingPermit(accounts[5], f.pins, record);
  const isolated = { ...f, anchor: { ...f.anchor, hostAdmission: { host: oldHost, admitted: true } }, certificates: [] };
  for (const w of f.witnesses.slice(0, 3)) {
    w.authority.read = async () => ({ generationAuthority: isolated });
    w.health.verify = async () => ({ verified: true, deployment: id, host: oldHost, generation: 2, ready: true, validUntil: 2020 });
    await assert.rejects(w.permit(record, signature), /fenced/);
  }
});
test('a restarted witness refuses another successor for the same parent generation', async t => {
  const f = fixture(t), p = await proposal(f, 1);
  await f.witnesses[0].generation(p);
  const w = f.witnesses[0]; w.journal = openLifecycleJournal(path.join(f.dir, 'witness-0.json'));
  const otherIntent = { ...p.intent, deadline: p.intent.deadline + 1 };
  const other = { ...p, intent: otherIntent, actorSignature: await accounts[5].signTypedData(transitionTypedData(f.pins, otherIntent)),
    record: { ...p.record, transitionIntent: hashTypedData(transitionTypedData(f.pins, otherIntent)) } };
  await assert.rejects(w.generation(other), /conflicting successor/);
});
test('quorum certificates cannot mint budget, extend runtime or bypass a revocation', async t => {
  const f = fixture(t), { certificate } = await certify(f, 1);
  for (const mutation of [{ remainingWei: '100000' }, { fundedUntil: 2801 }, { previous: hash('different parent') }, { policyRevision: 2 }]) {
    const record = { ...certificate.record, ...mutation };
    const signatures = await Promise.all(accounts.slice(0, 3).map(a => a.signTypedData(generationTypedData(f.pins, record))));
    await assert.rejects(verifyGenerationChain([{ record, signatures }], f), /funded|lifetime|anchored/);
  }
  await assert.rejects(verifyGenerationChain(f.certificates, { ...f, head: { ...f.head, denied: true } }), /denied/);
  await assert.rejects(verifyGenerationChain(f.certificates, { ...f, denyFloor: { blockNumber: 201 } }), /denied/);
  await assert.rejects(verifyGenerationChain(f.certificates, { ...f, anchor: { ...f.anchor, admitted: false } }), /does not grant/);
});
test('freshly observing an over-age anchor, missing current proof, or changing witnesses cannot authorize service', async t => {
  const f = fixture(t); await certify(f, 1);
  await assert.rejects(verifyGenerationChain(f.certificates, { ...f, anchor: { ...f.anchor, timestamp: 1 } }), /stale/);
  await assert.rejects(verifyGenerationChain(f.certificates, { ...f, head: { ...f.head, observedAt: 1 } }), /stale/);
  await assert.rejects(verifyGenerationChain(f.certificates, { ...f, head: { ...f.head, ancestryVerified: false } }), /unqualified/);
  await assert.rejects(verifyGenerationChain(f.certificates, { ...f, policy: { ...f.policy, witnesses: accounts.slice(1, 5).map(a => a.address) } }), /differs/);
  assert.equal(typeof generationAnchorDigest(f.pins, f.anchor, f.policy), 'string');
});
test('an authenticated unsafe denial persists through restart and a later unsafe allow cannot restore service', async t => {
  const f = fixture(t);
  f.anchor.hostAdmission = { host: oldHost, admitted: true };
  f.witnesses[0].health.verify = async () => ({ verified: true, deployment: id, host: oldHost, generation: 2, ready: true, validUntil: 2020 });
  const record = { deployment: id, host: oldHost, generation: 2, policyRevision: 1, sequence: 1, issuedAt: 2000, validUntil: 2020 };
  const signature = await signServingPermit(accounts[5], f.pins, record);
  f.head.denied = true;
  await assert.rejects(f.witnesses[0].permit(record, signature), /denied/);
  const recovered = openLifecycleJournal(path.join(f.dir, 'witness-0.json'));
  assert.equal(recovered.read(id).denial.blockNumber, 200);
  f.witnesses[0].journal = recovered; f.head.denied = false;
  await assert.rejects(f.witnesses[0].permit(record, signature), /restoration/);
  assert.equal(canRestoreLifecycleDenial(recovered.read(id).denial, { ...f.anchor, number: 201, tier: 'unsafe' }, 2000), false);
  assert.equal(canRestoreLifecycleDenial(recovered.read(id).denial, { ...f.anchor, number: 201, tier: 'l1-finalized-derived' }, 2000), true);
});
test('runner serves a quorum-certified mined transition while retaining its intent until real finality', async t => {
  const f = fixture(t); await certify(f, 1); f.advance(22); const { p } = await certify(f, 2);
  const journal = openLifecycleJournal(path.join(f.dir, 'host.json'));
  const digest = p.record.transitionIntent;
  journal.prepareTransition(id, { digest, payload: JSON.stringify(p.intent) });
  const calls = []; let outcome = 'unknown';
  const chain = {
    read: async () => ({ schema: 2, id, thisHost: nextHost, admitted: true, generationAuthority: f }),
    resolve: async () => ({ verified: true, proofVerified: true, authorityTier: 'unsafe', outcome: 'mined', digest,
      transactionHash: hash('tx'), blockHash: hash('mined block'), blockNumber: 201 }),
    finalize: async () => ({ verified: true, proofVerified: true, authorityTier: 'l1-finalized-derived', digest, outcome }),
  };
  const runtime = { health: async () => ({ ready: true }), serve: async () => calls.push('serve'),
    fence: async () => calls.push('fence'), stop: async () => { calls.push('stop'); return true; } };
  const runner = new DeploymentLifecycleRunner({ pins: f.pins, chain, runtime, journal, now: () => f.nowSec * 1000 });
  assert.equal((await runner.reconcile(id)).status, 'running');
  assert.equal(journal.read(id).pending, null); assert.equal(journal.read(id).minedTransitions.length, 1);
  outcome = 'reorged';
  assert.equal((await runner.reconcile(id)).status, 'held'); assert.equal(journal.read(id).minedTransitions.length, 1);
  assert.deepEqual(calls, ['serve', 'fence', 'stop']);
  outcome = 'finalized';
  assert.equal((await runner.reconcile(id)).status, 'running'); assert.equal(journal.read(id).minedTransitions.length, 0);
});
function scopedRunner(f) {
  const calls = [], journal = openLifecycleJournal(path.join(f.dir, 'scoped-host.json'));
  const snapshot = { schema: 2, id, thisHost: oldHost, enabled: false, admitted: true, generationAuthority: f };
  const runner = new DeploymentLifecycleRunner({ pins: f.pins, journal, now: () => f.nowSec * 1000,
    chain: { read: async () => snapshot,
      prepare: async (_id, _snapshot, target) => { calls.push(`prepare:${target}`); return { payload: target, digest: hash(target) }; },
      submit: async () => calls.push('submit') },
    runtime: { health: async () => ({ ready: true }), serve: async () => calls.push('serve'),
      fence: async () => calls.push('fence'), stop: async () => { calls.push('stop'); return true; },
      ensureStaged: async () => { calls.push('stage'); return { ready: true }; } },
  });
  return { runner, calls, snapshot, journal };
}
test('operational host refusal queues its running assignment without globally stopping the app', async t => {
  const f = fixture(t); f.anchor.hostAdmission = { host: oldHost, admitted: false };
  const { runner, calls } = scopedRunner(f);
  assert.equal((await runner.reconcile(id)).status, 'pending');
  assert.deepEqual(calls, ['fence', 'stop', 'prepare:queued', 'submit']);
});
test('operational host refusal leaves queued work available without starting or charging it', async t => {
  const f = fixture(t); f.anchor.hostAdmission = { host: oldHost, admitted: false };
  Object.assign(f.anchor.assignment, { state: 'queued', host: zero, operator: noAddress });
  const { runner, calls } = scopedRunner(f);
  assert.equal((await runner.reconcile(id)).status, 'queued');
  assert.deepEqual(calls, ['fence', 'stop']);
});
test('missing or differently scoped host admission cannot be repaired by outer snapshot booleans', async t => {
  for (const hostAdmission of [undefined, { host: nextHost, admitted: true }, { host: oldHost, admitted: 'true' }]) {
    const f = fixture(t); f.anchor.hostAdmission = hostAdmission;
    const { runner, calls } = scopedRunner(f);
    assert.equal((await runner.reconcile(id)).status, 'held');
    assert.deepEqual(calls, ['fence']);
  }
});
test('global disable and current denial retain precedence over host admission', async t => {
  for (const change of [f => { f.anchor.enabled = false; }, f => { delete f.anchor.enabled; },
    f => { f.anchor.admitted = false; }, f => { f.head.denied = true; }]) {
    const f = fixture(t); f.anchor.hostAdmission = { host: oldHost, admitted: true }; change(f);
    const { runner, calls } = scopedRunner(f);
    assert.equal((await runner.reconcile(id)).status, 'held');
    assert.equal(calls.includes('serve') || calls.includes('stage') || calls.includes('submit'), false);
    assert.equal(canRestoreLifecycleDenial({ blockNumber: 100 }, { ...f.anchor, enabled: false }, f.nowSec), false);
  }
});
test('witnesses refuse serving on a globally enabled but ineligible or differently scoped host', async t => {
  for (const hostAdmission of [undefined, { host: oldHost, admitted: false }, { host: nextHost, admitted: true }]) {
    const f = fixture(t); f.anchor.hostAdmission = hostAdmission;
    const record = { deployment: id, host: oldHost, generation: 2, policyRevision: 1, sequence: 1, issuedAt: 2000, validUntil: 2020 };
    const signature = await signServingPermit(accounts[5], f.pins, record);
    await assert.rejects(f.witnesses[0].permit(record, signature), /host.*(admi|missing)/);
    assert.equal(f.witnesses[0].journal.read(id).digest, null);
  }
});
test('generation witnesses refuse a successor lacking matching anchored host admission', async t => {
  for (const hostAdmission of [undefined, { host: nextHost, admitted: false }, { host: oldHost, admitted: true }]) {
    const f = fixture(t); await certify(f, 1); f.advance(22);
    f.anchor.hostAdmission = hostAdmission;
    const p = await proposal(f, 2);
    const before = f.witnesses[0].journal.read(id);
    await assert.rejects(f.witnesses[0].generation(p), /host.*(admi|missing)/);
    assert.deepEqual(f.witnesses[0].journal.read(id), before);
  }
});
test('HTTP generation collection verifies both signatures and returns contract-ordered approvals', async t => {
  const f = fixture(t), p = await proposal(f, 1), endpoints = [], servers = [];
  let bad = 1;
  t.after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } });
  for (const [i, witness] of f.witnesses.entries()) {
    const server = http.createServer(lifecycleWitnessHandler({ generation: async request => {
      const vote = await witness.generation(request);
      return i < bad ? { ...vote, transitionSignature: vote.signature } : vote;
    } }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); servers.push(server);
    endpoints.push({ address: accounts[i].address, url: `http://127.0.0.1:${server.address().port}` });
  }
  const collect = createGenerationCollector({ pins: f.pins, endpoints, allowLoopbackHttp: true, now: () => f.nowSec * 1000 });
  const result = await collect(p, f);
  assert.equal(result.certificate.signatures.length, 3);
  const signers = await Promise.all(result.approvals.map(signature => recoverTypedDataAddress({ ...transitionTypedData(f.pins, p.intent), signature })));
  const numeric = signers.map(a => a.toLowerCase());
  assert.deepEqual(numeric, [...numeric].sort());
  assert.equal(signers.includes(accounts[0].address), false);
  bad = 2;
  await assert.rejects(collect(p, f), /quorum unavailable/);
});
test('generation signing persists denials and requires finalized restoration before a new successor', async t => {
  const f = fixture(t), p = await proposal(f, 1), witness = f.witnesses[0];
  f.head.denied = true;
  await assert.rejects(witness.generation(p), /denied/);
  witness.journal = openLifecycleJournal(path.join(f.dir, 'witness-0.json'));
  assert.equal(witness.journal.read(id).denial.blockNumber, 200);
  f.head.denied = false;
  await assert.rejects(witness.generation(p), /restoration/);
  f.anchor.number = 201; f.anchor.hash = hash('finalized restoration'); f.anchor.timestamp = 2000;
  f.anchor.tier = 'l1-finalized-derived'; f.head.number = 202; f.head.anchorHash = f.anchor.hash;
  await witness.generation(await proposal(f, 1));
  assert.equal(witness.journal.read(id).denial, null);
  assert.equal(witness.journal.read(id).fenced, true);
});
