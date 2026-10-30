// host-authority permit r1 protocol suite (root executed: 7 PASS 0 skip on the r1 sources). completion r2: the ONLY change is in 7b's
// fault-injection loop, which now also removes the owned `<file>.established` marker between modes (the repaired sidecar refuses a marker
// without its file). ownership r3: again ONLY 7b's loop: a failure BEFORE the durable intent record landed (fsync/rename of the intent tmp)
// leaves nothing ambiguous, so a new process reads the untouched floor '1'; a failure AFTER it landed (directory open/fsync) survives the
// new process (still uncertain) until explicit verified recovery classifies the on-disk bytes ('not-landed' -> '1'). REAL modules from the
// generated tree: deployment-serving-permit (v2), createPermitCollector, DeploymentLifecycleWitness,
// DeploymentPermitGate, createIsolationLifecycleRuntime, the owned protocol journal and the durable host-authority sidecar. TEST DOUBLES,
// and only these: the witness transport (fetchImpl -> witness.permit in process, instead of deployment-witness-http), each witness's chain
// authority reader (returns a same-block assignment + host evidence), the guestd manager client, launch plans, readiness and the runtime
// boundary (hold/allow acks). A mock allow/ack is NOT production enforcement.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { hashTypedData } from 'viem';
import { createPermitCollector } from '../network/deployment-permit-collector.mjs';
import { DeploymentLifecycleWitness } from '../network/deployment-lifecycle-witness.mjs';
import { DeploymentPermitGate } from '../network/deployment-permit-gate.mjs';
import { createIsolationLifecycleRuntime } from '../network/deployment-isolation-runtime.mjs';
import { openLifecycleJournal } from '../network/deployment-lifecycle-journal.mjs';
import { servingPermitTypedData, verifyServingPermit } from '../network/deployment-serving-permit.mjs';
import { openHostAuthorityJournal } from '../network/deployment-host-authority-journal.mjs';
import { hostAuthorityContextOf, isHostAuthorityPermit, checkPermitHostAuthority, servingContextOf, compareHostAuthority } from '../network/deployment-host-authority.mjs';

const H = b => '0x' + b.repeat(32), A = b => '0x' + b.repeat(20);
const HOST = H('a1'), ID = H('a2'), CTRL = '0x' + 'c7'.repeat(20), REG = A('ab'), CODE = H('23');
const PINS = Object.freeze({ chainId: 8453, lifecycle: CTRL, servingPermit: { version: 2, profile: 'independent-host-registry-r1' } });
const V1PINS = Object.freeze({ chainId: 8453, lifecycle: CTRL });
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hap-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const sorted = xs => xs.sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
const reporters = sorted([0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()))).map(a => a.address.toLowerCase());
// canonical lifecycle exactly as the adapter's hostLifecycleState exposes it (exact decimal strings)
const hr = (over = {}) => ({ scope: 'host', registry: REG, codeConsistent: true, status: 'online', online: true, generation: '1',
  hardwareId: H('b1'), descriptorDigest: H('b2'), qualificationDigest: H('b3'), resourceDigest: H('b4'), trustAnchorId: H('b5'),
  owner: A('1d'), revision: '1', policyHash: H('55'), reporters: { keys: reporters, threshold: 2, revision: '1' }, ...over });
const ctxOf = over => hostAuthorityContextOf(hr(over), { chainId: 8453, hostId: HOST, registryCodeHash: CODE });

function world(t, { now = () => Date.now() } = {}) {
  const dir = tmp(t), operator = privateKeyToAccount(generatePrivateKey());
  const witnesses = sorted([0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey())));
  const policy = { witnesses: witnesses.map(w => w.address), threshold: 3, revision: 1 };
  const S = { ctx: ctxOf(), status: 'online', block: H('e1'), appGen: 2, delayAfterHealth: null, allows: [] };
  const evidence = () => ({ context: S.ctx, status: S.status, blockHash: S.block, proofVerified: true });
  const assignment = () => ({ deployment: ID, host: HOST, operator: operator.address, state: 'running', generation: S.appGen + 1,
    policyRevision: 1, admitted: true, funded: true, authorityTier: 'finalized', proofVerified: true,
    observedAt: Math.floor(now() / 1000), blockTimestamp: Math.floor(now() / 1000), blockHash: S.block });
  // TEST DOUBLE: each witness's own authenticated chain reader (same block for assignment and host evidence)
  const authority = { async read() { return { assignment: assignment(), policy, hostAuthority: evidence(), hostAdmitted: true }; } };
  const health = { async verify(id, host, generation) { if (S.delayAfterHealth) await S.delayAfterHealth();
    return { verified: true, deployment: id, host, generation, ready: true, validUntil: Math.floor(now() / 1000) + 60 }; } };
  const W = witnesses.map((w, i) => new DeploymentLifecycleWitness({ pins: PINS, account: w, journal: openLifecycleJournal(path.join(dir, `w${i}.json`)),
    authority, health, now, hostAuthorityJournal: openHostAuthorityJournal(path.join(dir, `w${i}-ha.json`)) }));
  // TEST DOUBLE transport: the real collector's fetch is delivered to the real witness in process
  const fetchImpl = async (url, { body }) => { const i = Number(new URL(url).hostname.slice(1, 2)), req = JSON.parse(body);
    try { const reply = await W[i].permit(req.record, req.operatorSignature); return { ok: true, body: [Buffer.from(JSON.stringify(reply))] }; }
    catch { return { ok: false, body: [] }; } };
  const collectPermit = createPermitCollector({ pins: PINS, account: operator, fetchImpl,
    endpoints: witnesses.map((w, i) => ({ url: `https://w${i}.witness.test/`, address: w.address })) });
  const hostFile = path.join(dir, 'host.json'), haFile = path.join(dir, 'gate-ha.json');
  const journal = openLifecycleJournal(hostFile);                      // ONE host journal shared by gate and runtime (permit sequence)
  const gate = new DeploymentPermitGate({ pins: PINS, journal, now, hostAuthority: openHostAuthorityJournal(haFile) });
  const reopenGate = () => new DeploymentPermitGate({ pins: PINS, journal: openLifecycleJournal(hostFile), now, hostAuthority: openHostAuthorityJournal(haFile) });
  const vms = new Map();
  const client = { async findByName(id) { return vms.get(id) ?? null; },
    async spawn(body) { const view = { id: 'vm-1', name: body.name, status: 'running' }; vms.set(body.name, view); return { view }; },
    async remove(x) { for (const [k, v] of vms) if (v.id === x || k === x) vms.delete(k); } };
  const boundaries = { async hold(id) { return { deployment: id, ingress: true, storage: true, secrets: true }; },
    async allow(id, grant) { S.allows.push(grant); return { deployment: id, generation: grant.generation, validUntil: grant.validUntil, expiryEnforced: true, hostAuthority: grant.hostAuthority }; } };
  const runtime = createIsolationLifecycleRuntime({ client, gate, journal, collectPermit, boundaries, host: HOST, now,
    plans: { async read(id) { return { verified: true, host: HOST, body: { name: id }, stagingEnforced: true }; } },
    readiness: { async verify({ deployment, generation, view }) { return { verified: true, ready: true, deployment, host: HOST, generation, instance: view.id, validUntil: now() + 60000 }; } } });
  const snapshot = state => ({ schema: 2, id: ID, verified: true, proofVerified: true, authorityTier: 'finalized', blockAt: now(), blockHash: S.block, thisHost: HOST,
    enabled: true, admitted: true, funded: true, policy, hostAuthorityEvidence: evidence(),
    assignment: { state, host: HOST, operator: operator.address, generation: state === 'running' ? S.appGen + 1 : S.appGen, revision: 1 } });
  return { S, W, gate, reopenGate, runtime, collectPermit, snapshot, policy };
}
async function startServing(w) {
  await w.runtime.ensureStaged(ID, w.snapshot('queued'));     // fresh queued origin = explicit handoff to the current host authority
  await w.runtime.serve(ID, w.snapshot('running'));
}
const record = (seq, hostAuthority) => { const s = Math.floor(Date.now() / 1000);
  return { deployment: ID, host: HOST, generation: 3, policyRevision: 1, sequence: seq, issuedAt: s, validUntil: s + 20, hostAuthority }; };

test('1 real v2 permit end to end: collector -> witness quorum -> gate -> runtime producer; positive fresh queued start', async t => {
  const w = world(t);
  await startServing(w);
  const g = w.S.allows.at(-1);
  assert.equal(g.hostAuthority, w.S.ctx.digest, 'the boundary grant carries the exact host authority');
  assert.equal(w.gate.assert(ID, { host: HOST, generation: 3, hostAuthority: w.S.ctx.digest }), g.validUntil);
  assert.throws(() => w.gate.assert(ID, { host: HOST, generation: 3 }), /no current serving permit/);
});

test('2 same app generation: host gen1 -> Offline -> recovered gen2 (missed) drops tracked resources; old signatures refused; restart keeps the floor', async t => {
  const w = world(t);
  await startServing(w);
  const old = await w.collectPermit(record(2, w.S.ctx), w.policy);        // a valid gen1 envelope, installed while gen1 is current
  await w.gate.install(old, servingContextOf(PINS, w.snapshot('running')));
  w.S.ctx = ctxOf({ generation: '2', qualificationDigest: H('c3') });    // the Offline was never observed here
  await assert.rejects(w.runtime.serve(ID, w.snapshot('running')), /handoff required/);
  assert.throws(() => w.gate.assert(ID, { host: HOST, generation: 3, hostAuthority: old.record.hostAuthority.digest }), /no current serving permit/);
  await assert.rejects(w.gate.install(old, servingContextOf(PINS, w.snapshot('running'))), /differs|rollback/);
  await assert.rejects(w.reopenGate().install(old, servingContextOf(PINS, w.snapshot('running'))), /differs|rollback/);
});

test('3 same host generation, legitimate owner revision increase: old grant withdrawn, explicit handoff then serve; lower/conflicting refuse', async t => {
  const w = world(t);
  await startServing(w);
  const first = w.S.ctx, firstDigest = w.S.allows.at(-1).hostAuthority;
  w.S.ctx = ctxOf({ owner: A('2e'), revision: '2', policyHash: H('56') });
  assert.equal(w.gate.observeHostAuthority(w.S.ctx), 'advance');                     // host-wide authenticated advance
  assert.throws(() => w.gate.assert(ID, { host: HOST, generation: 3, hostAuthority: firstDigest }), /no current serving permit/);
  await w.runtime.adoptHostAuthority(ID, w.snapshot('running'));                     // explicit authenticated quiescent handoff
  await w.runtime.serve(ID, w.snapshot('running'));
  assert.equal(w.S.allows.at(-1).hostAuthority, w.S.ctx.digest);
  const floor = { hostGeneration: '1', ownerRevision: '2', digest: w.S.ctx.digest };
  assert.throws(() => compareHostAuthority(floor, first), /rollback/);
  assert.throws(() => compareHostAuthority(floor, ctxOf({ owner: A('3f'), revision: '2' })), /equivocation/);
  assert.equal(compareHostAuthority({ hostGeneration: '1', ownerRevision: '1', digest: first.digest }, w.S.ctx), 'advance', 'no permanent equivocation');
});

test('4 tampering, omission, downgrade, unsafe uint64 and unqualified/nested-verified evidence never sign or grant', async t => {
  const c = ctxOf(), rec = { deployment: ID, host: HOST, generation: 3, policyRevision: 1, sequence: 1, issuedAt: 100, validUntil: 110, hostAuthority: c };
  const base = hashTypedData(servingPermitTypedData(PINS, rec));
  for (const [k, v] of [['registry', A('ac')], ['registryCodeHash', H('24')], ['hostId', H('a3')], ['hostGeneration', '2'], ['qualificationDigest', H('c4')],
      ['trustAnchorId', H('c5')], ['hardwareId', H('c6')], ['resourceDigest', H('c7')], ['descriptorDigest', H('c8')], ['owner', A('3f')], ['ownerRevision', '2'],
      ['policyHash', H('c9')], ['reporterPolicyDigest', H('ca')], ['reporterRevision', '2']])
    assert.throws(() => servingPermitTypedData(PINS, { ...rec, hostAuthority: { ...c, [k]: v } }), /digest|another/, k);
  for (const over of [{ generation: '2' }, { revision: '2' }, { owner: A('3f') }, { qualificationDigest: H('c4') }])
    assert.notEqual(hashTypedData(servingPermitTypedData(PINS, { ...rec, hostAuthority: ctxOf(over) })), base, JSON.stringify(over));
  const { hostAuthority: _h, ...v1 } = rec;
  assert.notEqual(hashTypedData(servingPermitTypedData(V1PINS, v1)), base, 'separate v1/v2 domains');
  assert.throws(() => servingPermitTypedData(PINS, v1), /unknown or missing/);
  assert.throws(() => servingPermitTypedData(PINS, { ...rec, extra: 1 }), /unknown or missing/);
  assert.throws(() => servingPermitTypedData(PINS, { ...rec, hostAuthority: { ...c, hostGeneration: 2 ** 53 } }), /uint64/);
  assert.throws(() => servingPermitTypedData(PINS, { ...rec, hostAuthority: { ...c, hostGeneration: '18446744073709551616' } }), /uint64/);
  assert.throws(() => isHostAuthorityPermit({ servingPermit: { version: 3, profile: 'independent-host-registry-r1' } }), /exactly/);
  const ev = { context: c, status: 'online', blockHash: H('e1'), proofVerified: false, verified: true };
  assert.throws(() => checkPermitHostAuthority(rec, { hostAuthority: ev, hostAdmitted: true, assignment: { blockHash: H('e1') } }), /proof-qualified/);
  assert.throws(() => checkPermitHostAuthority(rec, { hostAuthority: { ...ev, proofVerified: true }, hostAdmitted: true, assignment: { blockHash: H('e2') } }), /same authenticated block/);
  assert.throws(() => checkPermitHostAuthority(rec, { hostAuthority: { ...ev, proofVerified: true, status: 'offline' }, hostAdmitted: true, assignment: { blockHash: H('e1') } }), /offline/);
  assert.throws(() => checkPermitHostAuthority(rec, { hostAuthority: { ...ev, proofVerified: true }, hostAdmitted: false, assignment: { blockHash: H('e1') } }), /admission/);
  const w = world(t);
  await assert.rejects(w.collectPermit(v1, w.policy), /unknown or missing/);
  await assert.rejects(verifyServingPermit({ record: rec, signatures: [] }, { pins: PINS, nowSec: 105 }));
});

test('7a owner change DURING witness readiness/signing: no signature released, no grant', async t => {
  const w = world(t);
  await w.runtime.ensureStaged(ID, w.snapshot('queued'));
  w.S.delayAfterHealth = async () => { w.S.ctx = ctxOf({ owner: A('2e'), revision: '2' }); };
  await assert.rejects(w.runtime.serve(ID, w.snapshot('running')), /quorum/);
  assert.equal(w.S.allows.length, 0);
});

test('7b host-wide advance, rollback handoff, latched persistence, malformed/lost sidecar: no grant or binding resurrection', async t => {
  const w = world(t);
  await startServing(w);
  w.gate.observeHostAuthority(ctxOf({ generation: '2' }));                        // host-wide advance from ANOTHER app's read
  assert.throws(() => w.gate.assert(ID, { host: HOST, generation: 3, hostAuthority: w.S.allows.at(-1).hostAuthority }), /no current serving permit/);
  assert.throws(() => w.gate.handoffHostAuthority(ID, ctxOf(), { kind: 'explicit-adoption' }), /rollback/);
  const d = tmp(t), f = path.join(d, 'ha.json');
  let failOn = null;
  const fsImpl = { ...fs,
    fsyncSync: fd => { if (failOn === 'fsync') throw Error('TEST injected fsync failure'); return fs.fsyncSync(fd); },
    renameSync: (a, b) => { if (failOn === 'rename') throw Error('TEST injected rename failure'); return fs.renameSync(a, b); },
    openSync: (p, fl, m) => { if (failOn === 'dir' && fl === 'r') throw Error('TEST injected directory open failure'); return fs.openSync(p, fl, m); } };
  for (const mode of ['fsync', 'rename', 'dir']) {
    for (const x of ['', '.established', '.intent', '.history']) fs.rmSync(`${f}${x}`, { force: true });   // each mode starts from a clean owned file
    const j = openHostAuthorityJournal(f, { fsImpl });
    j.accept(HOST, ctxOf());
    failOn = mode; assert.throws(() => j.accept(HOST, ctxOf({ generation: '2' })), /uncertain/); failOn = null;
    assert.throws(() => j.read(HOST), /uncertain/, `${mode}: latched in this process even if the bytes reached disk`);
    if (mode === 'dir') {                    // the intent record landed before the directory sync failed: ambiguity survives the process
      const again = openHostAuthorityJournal(f);
      assert.throws(() => again.read(HOST), /uncertain/, 'a new process never makes an ambiguous write clean');
      assert.equal(again.recover(), 'not-landed', 'explicit verified recovery classifies the exact on-disk bytes');
      assert.equal(again.read(HOST).floor.hostGeneration, '1', 'no reset: the verified prior floor');
      assert.equal(fs.readFileSync(`${f}.history`, 'utf8').trim().split('\n').length, 1, 'provenance retained');
    } else assert.equal(openHostAuthorityJournal(f).read(HOST).floor.hostGeneration, '1', `${mode}: failed before the intent landed; the floor is untouched`);
  }
  fs.writeFileSync(f, JSON.stringify({ format: 'enclave-host-authority-permit/v1', hosts: { [HOST]: { floor: { hostGeneration: '1' }, bound: {} } } }));
  assert.throws(() => openHostAuthorityJournal(f).read(HOST), /malformed|unknown/);
  assert.throws(() => openHostAuthorityJournal(path.join(d, 'missing.json'), { expectExisting: true }).read(HOST), /missing|unknown/);
  const live = openHostAuthorityJournal(path.join(d, 'live.json')); live.accept(HOST, ctxOf());
  fs.rmSync(path.join(d, 'live.json'));
  assert.throws(() => live.read(HOST), /lost/);
});

test('8 v1 default unchanged: no servingPermit pins -> v1 typed data, no host authority, servingContextOf undefined', () => {
  const rec = { deployment: ID, host: HOST, generation: 3, policyRevision: 1, sequence: 1, issuedAt: 100, validUntil: 110 };
  const d = servingPermitTypedData(V1PINS, rec);
  assert.equal(d.domain.version, '1'); assert.deepEqual(Object.keys(d.types), ['ServingPermit']);
  assert.equal(servingContextOf(V1PINS, {}), undefined); assert.equal(isHostAuthorityPermit(V1PINS), false);
});
