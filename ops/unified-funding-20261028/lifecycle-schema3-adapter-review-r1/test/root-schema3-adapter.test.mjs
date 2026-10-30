// schema3 r1: the GENERATED adapter in the explicit 'independent-schema3-r1' profile against the ACTUAL schema-3 controller/ledger/
// library/identity/prover on owned loopback Anvil 8453 (test/fixtures/schema3-world.mjs). Same labelled r5 TEST doubles for the rest.
// UNRUN at authoring time: prepared for the root harness (run-schema3-adapter-r1.sh). No live Base, production key, RPC or send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { useAnvil, step, mine, warp, rpc, read, tx, codeHash, S, HOST, ZERO, ZERO32 } from './fixtures/r5-world.mjs';
import { world3, emergency3, reconcile3, runner3, deployLibrary, deployController, deployLedger, deployProver, ART3, L3 } from './fixtures/schema3-world.mjs';
import { verifyGenerationChain } from '../network/deployment-generation-certificate.mjs';
import { SCHEMA3_PROFILE } from '../network/lifecycle-schema3-profile.mjs';

useAnvil();
const MAX = Number.MAX_SAFE_INTEGER;
const clone = p => structuredClone(p);
const nowSec = () => Math.floor((Date.now() + S.skewMs) / 1000);

test('actual schema3 pair: library runtime + embedded self address; read/prepare/submit/resolve/finalize through lifecycleStart/lifecycleEndAt', async () => {
  const w = await world3({ payout: 'owner' });
  const lib = w.contracts.accountingLibrary, self = ART3.accountingLibrary.immutableReferences.library_deploy_address;
  const code = await S.pub.getCode({ address: lib });
  for (const s of self) assert.equal(code.slice(2 + s.start * 2, 2 + (s.start + 32) * 2), `${'0'.repeat(24)}${lib.slice(2).toLowerCase()}`);
  assert.ok((code.length - 2) / 2 <= 24576 && ((await S.pub.getCode({ address: w.contracts.ledger })).length - 2) / 2 <= 24576);
  const a = w.adapter();
  assert.deepEqual([a.profile, a.lifecycleSchema, a.lifecycleProofSchema, a.independence.complete], [SCHEMA3_PROFILE, 3, 2, false]);
  let s = await a.read(w.id);
  assert.deepEqual([s.schema, s.verified, s.profile, s.lifecycleSchema, s.enabled, s.admitted, s.funded, s.fundedUntil, s.emergency.pending],
    [2, true, SCHEMA3_PROFILE, 3, true, true, true, MAX, false]);
  const q = await step(w, 'queued', 'enroll'); await mine();
  const rq = await a.resolve(w.id, q); assert.deepEqual([rq.outcome, rq.proof.actor], ['confirmed', w.human.address]);
  const run = await step(w, 'running', 'ready'); await mine();
  const rr = await a.resolve(w.id, run);
  assert.deepEqual([rr.outcome, rr.verified, rr.proof.actor, rr.emergency.pending], ['confirmed', true, w.operator.address, false]);
  const f = await a.finalize(w.id, run); assert.deepEqual([f.outcome, f.verified], ['finalized', true]);
  let d = await w.ledgerGet(); assert.deepEqual([getAddress(d.runnerOperator), d.runner, d.leaseUntil], [w.operator.address, HOST, 2n ** 64n - 1n]);
  s = await a.read(w.id); assert.deepEqual([s.assignment.state, s.funded, s.fundedUntil], ['running', true, MAX]);
  const back = await step(w, 'queued', 'owner requeue'); await mine();                 // running -> queued: synchronous lifecycleEndAt at now
  assert.equal((await a.resolve(w.id, back)).outcome, 'confirmed');
  d = await w.ledgerGet(); assert.deepEqual([d.runnerOperator, d.runner], [ZERO, ZERO32]);
});

test('fail closed: absent/wrong library or self binding, wrong immutables, wrong prover/controller/ledger/recursive dependency, wrong profile', async () => {
  const w = await world3({ payout: 'owner' });
  const p = w.pins, readWith = pins => async () => w.adapter({ pins }).read(w.id);   // construction OR read must refuse
  const without = clone(p); delete without.contracts.accountingLibrary; delete without.schema3.immutables.accountingLibrary;
  assert.throws(() => w.adapter({ pins: without }), /accountingLibrary/);
  const lib2 = await deployLibrary(w.admin);                                              // byte-identical library code except its self address
  const otherLib = clone(p); otherLib.contracts.accountingLibrary = { address: lib2, codeHash: await codeHash(lib2) };
  assert.throws(() => w.adapter({ pins: otherLib }), /ledger\.codeHash is not the reviewed/);   // the ledger links the first library
  const selfSwap = clone(p); selfSwap.contracts.accountingLibrary.codeHash = await codeHash(lib2);
  assert.throws(() => w.adapter({ pins: selfSwap }), /accountingLibrary\.codeHash is not the reviewed/);   // self address binds the code
  const ids = Object.keys(p.schema3.immutables.ledger), swapped = clone(p);
  swapped.schema3.immutables.ledger = { [ids[0]]: p.schema3.immutables.ledger[ids[1]], [ids[1]]: p.schema3.immutables.ledger[ids[0]] };
  assert.throws(() => w.adapter({ pins: swapped }), /ledger\.codeHash is not the reviewed/);
  const wrongTarget = clone(p); const lid = Object.keys(p.schema3.immutables.lifecycle).find(k => p.schema3.immutables.lifecycle[k] === 'l1Oracle');
  wrongTarget.schema3.immutables.lifecycle[lid] = 'registry'; assert.throws(() => w.adapter({ pins: wrongTarget }), /targets must be exactly/);
  const missingId = clone(p); delete missingId.schema3.immutables.proofOfTime[Object.keys(p.schema3.immutables.proofOfTime)[0]];
  assert.throws(() => w.adapter({ pins: missingId }), /exactly the compiler immutable ids/);
  const noS3 = clone(p); delete noS3.schema3; assert.throws(() => w.adapter({ pins: noS3 }), /pins\.schema3 required/);
  // same code, wrong authority: a second actual prover/controller/ledger with identical immutables (hence identical code hash)
  const prover2 = await deployProver(w.admin, w.contracts.ledger, w.contracts.registry);
  const wp = clone(p); wp.contracts.proofOfTime.address = prover2; assert.equal(await codeHash(prover2), p.contracts.proofOfTime.codeHash);
  await assert.rejects(readWith(wp), /authority pair|binding/);
  const ctrl2 = await deployController(w.admin, w.contracts.ledger, w.contracts.l1Oracle);
  const wc = clone(p); wc.contracts.lifecycle.address = ctrl2; assert.equal(await codeHash(ctrl2), p.contracts.lifecycle.codeHash);
  await assert.rejects(readWith(wc), /proofOfTime\.codeHash|lifecycleController|authority pair|binding/);   // the prover's immutable names the real controller
  const ledger2 = await deployLedger(w.admin, w.contracts.accountingLibrary, w.contracts.usdc, w.admin.address, w.contracts.registry);
  const wl = clone(p); wl.contracts.ledger.address = ledger2; assert.equal(await codeHash(ledger2), p.contracts.ledger.codeHash);
  await assert.rejects(readWith(wl), /codeHash is not the reviewed|binding/);
  const stale = await world3({ payout: 'owner', staleDep: 'connectivity' });
  await assert.rejects(stale.adapter().read(stale.id), /binding connectivity\.ledger/);
  // profiles: the legacy default and 'independent-r1' keep pinning schema 2 and refuse this world; unknown profile refused
  await assert.rejects(readWith(w.legacyPins), /lifecycle schema 2/);
  const r1 = clone(p); r1.profile = 'independent-r1';
  await assert.rejects(readWith(r1), /lifecycle schema 2/);
  assert.throws(() => w.adapter({ pins: { ...p, profile: 'independent-schema3-r2' } }), /not a reviewed profile/);
  assert.throws(() => w.adapter({ pins: { ...p, addressBook: w.legacyPins.addressBook } }), /not authority/);
  assert.equal((await w.adapter().read(w.id)).verified, true);                            // the exact pins still pass
});

test('qualified schema3 retirement is metadata only; residual admin powers remain blockers; admin change denies new starts, not reads/queue/reconciliation', async () => {
  const w = await world3({ payout: 'owner' }); const a = w.adapter();
  await tx(w.admin, w.contracts.ledger, L3.LEDGER, 'retire'); await mine();
  let s = await a.read(w.id);
  assert.deepEqual([s.ledgerState.retired, s.enabled, s.admitted, s.funded], [true, true, true, true]);
  assert.match(s.ledgerState.retirement, /metadata-only/);
  assert.ok(!s.independence.blockers.some(x => /stops independent deployments on every host/.test(x)));
  assert.ok(s.independence.blockers.some(x => /setClaimBond/.test(x)) && s.independence.blockers.some(x => /Host-wide registry offline/.test(x)));
  await step(w, 'queued', 'enroll'); await mine();
  const run = await step(w, 'running', 'start after retirement'); await mine();
  assert.equal((await a.resolve(w.id, run)).outcome, 'confirmed');
  await tx(w.admin, w.contracts.ledger, L3.LEDGER, 'setOwner', [w.other.address]); await mine();
  s = await a.read(w.id);
  assert.deepEqual([s.verified, s.adminChanged, s.admitted, s.assignment.state], [true, true, false, 'running']);
  assert.ok(s.adminChanges.includes('ledger.pendingOwner'));
  await emergency3(w); await mine();
  s = await a.read(w.id); assert.deepEqual([s.verified, s.emergency.pending, s.admitted], [true, true, false]);
  await reconcile3(w); await mine();
  s = await a.read(w.id); assert.deepEqual([s.verified, s.emergency.pending, s.admitted, s.adminChanged], [true, false, false, true]);
  await assert.rejects(a.prepare(w.id, s, 'running', 'x'), /administrator changed/);
  const stop = await a.prepare(w.id, s, 'stopped', 'owner stop'); await a.submit(w.id, stop); await mine();
  assert.equal((await a.resolve(w.id, stop)).outcome, 'confirmed');
});

test('pending emergency cutoff: exact tuple at the authenticated block; no fresh funding/admission/transition; reconciliation restores normal', async () => {
  const w = await world3({ payout: 'owner' }); const a = w.adapter();
  await step(w, 'queued', 'enroll'); await mine(); await step(w, 'running', 'ready'); await mine();
  const before = await a.read(w.id), preBlock = before.blockNumber;
  const stale = await a.prepare(w.id, before, 'queued', 'prepared before the emergency');
  const e = await emergency3(w); await mine();
  const s = await a.read(w.id);
  assert.deepEqual([s.assignment.state, s.assignment.generation, s.assignment.host], ['queued', before.assignment.generation + 1, ZERO32]);
  assert.deepEqual([s.emergency.pending, s.emergency.runGeneration, s.emergency.cutoff, s.emergency.stopped, s.emergency.host, s.emergency.operator, s.emergency.lastEmergency],
    [true, before.assignment.generation, e.cutoff, false, HOST, w.operator.address, e.digest]);
  assert.deepEqual([s.enabled, s.funded, s.admitted, s.fundedUntil, s.host.active], [true, false, false, Math.floor(s.blockAt / 1000), true]);
  assert.equal(s.hostOffline.registryOffline, 'not-implemented');                       // per-app offline is not host registry offline
  assert.equal(await read(w.contracts.ledger, L3.LEDGER, 'lifecycleFunded', [w.id]), false);
  assert.equal(getAddress((await w.ledgerGet()).runnerOperator), w.operator.address);     // unsettled: the ledger still names the revoked run
  w.auth.pin = BigInt(preBlock);                                                          // the tuple is read at the authority's block, not latest
  const old = await a.read(w.id); assert.deepEqual([old.emergency.pending, old.assignment.state], [false, 'running']); w.auth.pin = null;
  for (const t of ['running', 'queued', 'stopped']) await assert.rejects(a.prepare(w.id, s, t, 'x'), /pending/);
  const n = w.sent.length;
  await assert.rejects(a.submit(w.id, stale), /pending/); assert.equal(w.sent.length, n);
  const r = await a.resolve(w.id, stale); assert.deepEqual([r.outcome, r.proof, r.emergency.pending], ['finalized-fence', null, true]);
  await reconcile3(w); await mine();
  const { result: again } = await S.pub.simulateContract({ account: w.other, address: w.contracts.lifecycle, abi: L3.LIFECYCLE, functionName: 'reconcileOffline', args: [w.id] });
  assert.equal(again, false);                                                             // never settles twice
  const s2 = await a.read(w.id);
  assert.deepEqual([s2.emergency.pending, s2.emergency.runGeneration, s2.funded, s2.admitted, s2.fundedUntil], [false, before.assignment.generation, true, true, MAX]);
  const d = await w.ledgerGet(); assert.deepEqual([d.runnerOperator, d.runner], [ZERO, ZERO32]);
  await warp(400);                                                                        // past the fence/backoff
  const restart = await step(w, 'running', 'restart after exact settlement'); await mine();
  assert.equal((await a.resolve(w.id, restart)).outcome, 'confirmed');
});

test('stopped emergency + final settlement; a revoked confirmed start is never upgraded; a reorged emergency is not retained; reorg proof refusal', async () => {
  const w = await world3({ payout: 'owner' }); const a = w.adapter();
  await step(w, 'queued', 'enroll'); await mine();
  const run = await step(w, 'running', 'ready'); await mine();
  assert.equal((await a.resolve(w.id, run)).outcome, 'confirmed');
  const snap = await rpc('evm_snapshot');
  await emergency3(w, { target: 'stopped' }); await mine();
  let s = await a.read(w.id); assert.deepEqual([s.assignment.state, s.emergency.pending, s.emergency.stopped], ['stopped', true, true]);
  const rr = await a.resolve(w.id, run), ff = await a.finalize(w.id, run);
  assert.deepEqual([rr.outcome, rr.verified, rr.proof], ['inconsistent', false, null]);
  assert.notEqual(ff.outcome, 'finalized'); assert.equal(ff.proof, null);
  await reconcile3(w); await mine();
  s = await a.read(w.id); assert.deepEqual([s.emergency.pending, s.assignment.state], [false, 'stopped']);
  const d = await w.ledgerGet(); assert.deepEqual([d.runnerOperator, d.runner], [ZERO, ZERO32]);
  await rpc('evm_revert', [snap]); await mine();                                          // the emergency branch is gone
  s = await a.read(w.id); assert.deepEqual([s.emergency.pending, s.assignment.state, s.admitted], [false, 'running', true]);
  const intent = await a.prepare(w.id, s, 'queued', 'requeue');
  const snap2 = await rpc('evm_snapshot'); await a.submit(w.id, intent); await mine();
  assert.equal((await a.finalize(w.id, intent)).outcome, 'finalized');
  await rpc('evm_revert', [snap2]); await mine();
  assert.equal((await a.finalize(w.id, intent)).outcome, 'unknown');
  await warp(200);
  const r = await a.finalize(w.id, intent); assert.deepEqual([r.outcome, r.proofVerified, r.proof], ['reorged', true, null]);
});

test('runner: a pending offline run is never served/restarted; generation certificates refused; monotonic denial restored only after settlement', async t => {
  const w = await world3({ payout: 'owner' });
  await tx(w.human, w.contracts.lifecycle, L3.LIFECYCLE, 'setAuthorityPolicy', [w.id, 3600]); await mine();
  await step(w, 'queued', 'enroll'); await mine(); await step(w, 'running', 'ready'); await mine();
  const plain = runner3(w, t);
  assert.equal((await plain.runner.reconcile(w.id)).status, 'running'); assert.ok(plain.calls.includes('serve'));
  await emergency3(w); await mine();
  plain.calls.length = 0; const n = w.sent.length;
  const held = await plain.runner.reconcile(w.id);
  assert.equal(held.status, 'held'); assert.match(held.reason, /pending/);
  assert.ok(plain.calls.includes('fence') && !plain.calls.includes('serve') && !plain.calls.includes('stage')); assert.equal(w.sent.length, n);
  const state = { denied: true };                                                         // TEST DOUBLE recent-head source (labelled values)
  const generation = { certificates: { read: async () => [] }, head: { read: async ({ anchor }) => ({ proofVerified: true, tier: 'unsafe', number: anchor.number,
    hash: anchor.hash, timestamp: Number((await S.pub.getBlock({ blockNumber: BigInt(anchor.number) })).timestamp), observedAt: nowSec(),
    anchorHash: anchor.hash, ancestryVerified: true, denied: state.denied }) } };
  const pins = { chainId: 8453, lifecycle: w.contracts.lifecycle };
  const g = (await w.adapter({ generation }).read(w.id)).generationAuthority;               // the ACTUAL generated snapshot
  assert.deepEqual([g.anchor.enabled, g.anchor.funded, g.anchor.hostAdmission, g.anchor.fundedUntil], [true, false, { host: HOST, admitted: false }, g.anchor.timestamp]);
  state.denied = false;
  await assert.rejects(verifyGenerationChain([], { ...g, head: await generation.head.read({ anchor: g.anchor }), pins, nowSec: nowSec() }), /does not grant service/);
  const forged = [{ record: { deployment: w.id, generation: g.anchor.assignment.generation + 1, action: 2, host: HOST, operator: w.operator.address,
    anchorHash: g.anchor.hash, anchorNumber: g.anchor.number }, signatures: [] }];
  await assert.rejects(verifyGenerationChain(forged, { ...g, head: await generation.head.read({ anchor: g.anchor }), pins, nowSec: nowSec() }), /does not grant service/);
  state.denied = true;
  const op = runner3(w, t, { generation, pins });
  await mine(); let r = await op.runner.reconcile(w.id);
  assert.equal(r.status, 'held'); assert.ok(op.journal.read(w.id).denial, 'authenticated denial persisted');
  state.denied = false; await mine(); r = await op.runner.reconcile(w.id);
  assert.equal(r.status, 'held'); assert.ok(op.journal.read(w.id).denial, 'pending anchor cannot restore');
  assert.ok(!op.calls.includes('serve') && !op.calls.includes('stage'));
  await reconcile3(w); await mine();
  r = await op.runner.reconcile(w.id);
  assert.ok(!op.journal.read(w.id).denial, 'restored only by a positive authenticated anchor after settlement');
  assert.ok(['queued', 'pending'].includes(r.status), JSON.stringify(r)); assert.ok(!op.calls.includes('serve'));
});
