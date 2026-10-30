// r5 (unchanged from r4 except the fixture path) ADAPTED BASELINE: the ten r3 exact receipt/transaction proof + fee-bound tests, test bodies unchanged except `pub` -> `S.pub`,
// now on the REAL candidate ledger/controller/identity world of r4 (test/fixtures/r5-world.mjs, self-hosted host: rate 0) with the
// r5 adapter (complete closure pins, host policy source). Diff vs r3: patches/r3-proof-tests-adapted.diff.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeEventTopics, keccak256, toBytes } from 'viem';
import { useAnvil, world, step, runnerFor, rpc, mine, warp, S, LIFECYCLE, MAX_T, MAX_GAS } from './fixtures/r5-world.mjs';

useAnvil();
const queue = w => step(w, 'queued', 'enroll');
const unverified = (r, re) => { assert.equal(r.outcome, 'unknown'); assert.equal(r.verified, false); assert.equal(r.proof, null); assert.match(r.proofError, re); };

test('confirmed only with the exact transaction + receipt proven at ancestry of the authority block (queued and running)', async () => {
  const w = await world(); const q = await queue(w); await mine(); await mine();
  const a = w.adapter(), r = await a.resolve(w.id, q), head = await S.pub.getBlock({ blockTag: 'latest' }), m = w.mined[0];
  assert.deepEqual([r.verified, r.proofVerified, r.outcome, r.digest], [true, true, 'confirmed', q.digest]);
  const blk = await S.pub.getBlock({ blockNumber: m.blockNumber });
  assert.deepEqual([r.proof.transactionHash, r.proof.blockNumber, r.proof.blockHash, r.proof.transactionIndex, r.proof.receiptsRoot, r.proof.transactionsRoot],
    [m.transactionHash, Number(m.blockNumber), blk.hash, m.transactionIndex, blk.receiptsRoot, blk.transactionsRoot]);
  assert.deepEqual(r.proof.anchor, { number: Number(head.number), hash: head.hash });                  // m < B: headers linked m..B
  assert.equal(r.proof.actor, w.human.address); assert.ok(BigInt(r.proof.chargedWei) > 0n && BigInt(r.proof.chargedWei) <= MAX_T);
  const run = await step(w, 'running', 'ready');
  const rr = await a.resolve(w.id, run);
  assert.deepEqual([rr.outcome, rr.verified, rr.proof.actor, rr.proof.transactionHash], ['confirmed', true, w.operator.address, w.mined[1].transactionHash]);
});

test('state alone never confirms: no location, a location above the authority block, or beyond the ancestry bound -> unknown', async () => {
  const w = await world(); const q = await queue(w); await mine(); await mine();
  w.hooks.locate = async () => null;
  let r = await w.adapter().resolve(w.id, q); assert.deepEqual([r.outcome, r.proof], ['unknown', null]); assert.match(r.reason, /no location hint/);
  const head = await S.pub.getBlock({ blockTag: 'latest' });
  w.hooks.locate = async () => ({ blockNumber: Number(head.number) + 5, transactionHash: w.mined[0].transactionHash });
  r = await w.adapter().resolve(w.id, q); assert.equal(r.outcome, 'unknown'); assert.match(r.reason, /above the authenticated block/);
  delete w.hooks.locate;
  r = await w.adapter({ maxAncestry: 1 }).resolve(w.id, q); assert.equal(r.outcome, 'unknown'); assert.match(r.reason, /headers below/);
  const f = await w.adapter({ maxAncestry: 1 }).finalize(w.id, q); assert.equal(f.outcome, 'unknown');
  assert.equal((await w.adapter().resolve(w.id, q)).outcome, 'confirmed');
});

test('tampered transaction bytes, receipt status, payment log, header root or header chain never confirm', async () => {
  const w = await world(); const q = await queue(w); await mine();
  const txh = w.mined[0].transactionHash, a = w.adapter();
  const flip = h => h.slice(0, -1) + (h.at(-1) === '0' ? '1' : '0');
  const ours = d => d.receipts.find(x => x.transactionHash === txh);
  w.hooks.block = d => { d.transactions = d.transactions.map(flip); return d; };
  unverified(await a.resolve(w.id, q), /transactionsRoot/);
  w.hooks.block = d => { ours(d).status = '0x0'; return d; };
  unverified(await a.resolve(w.id, q), /receipts_root_mismatch/);
  const paidTopic = encodeEventTopics({ abi: LIFECYCLE.abi, eventName: 'TransitionPaid' })[0];
  w.hooks.block = d => { const l = ours(d).logs.find(x => x.topics[0] === paidTopic); l.data = `0x${'0'.repeat(63)}1`; return d; };
  unverified(await a.resolve(w.id, q), /receipts_root_mismatch/);
  w.hooks.block = d => { d.header.receiptsRoot = keccak256(toBytes('forged')); return d; };
  unverified(await a.resolve(w.id, q), /not the authenticated ancestor/);
  delete w.hooks.block;
  w.hooks.header = (h, n) => { if (n === Number(w.mined[0].blockNumber)) { h.extraData = '0x01'; delete h.hash; } return h; };
  unverified(await a.resolve(w.id, q), /unlinked|anchor_mismatch/);
  unverified(await a.finalize(w.id, q), /unlinked|anchor_mismatch/);
  delete w.hooks.header;
  assert.equal((await a.resolve(w.id, q)).outcome, 'confirmed');
});

test('branch binding: data of a reorged-away branch never proves; the canonical re-execution does', async () => {
  const w = await world(); await queue(w); await mine();
  const a = w.adapter(), intent = await a.prepare(w.id, await a.read(w.id), 'running', 'ready');
  const snap = await rpc('evm_snapshot'); await a.submit(w.id, intent);
  const mA = Number(w.mined.at(-1).blockNumber), hintA = await w.receipts.base.locate({ id: w.id, digest: intent.digest, controller: w.contracts.lifecycle });
  const blockA = await w.receipts.base.block(mA);
  await rpc('evm_revert', [snap]); await mine();                                    // branch B: block mA is now an empty block
  await a.submit(w.id, intent); await mine();
  assert.ok(Number(w.mined.at(-1).blockNumber) > mA);
  w.hooks.locate = async () => hintA; w.hooks.block = (d, n) => (n === mA ? structuredClone(blockA) : d);
  unverified(await a.resolve(w.id, intent), /not the authenticated ancestor/);
  delete w.hooks.block;
  const r = await a.resolve(w.id, intent);                                          // honest canonical block mA lacks the hinted tx (unless same bytes)
  assert.equal(r.outcome === 'confirmed' ? r.proof.blockNumber !== mA : r.outcome === 'unknown', true);
  delete w.hooks.locate;
  const ok = await a.resolve(w.id, intent);
  assert.deepEqual([ok.outcome, ok.verified, ok.proof.blockNumber], ['confirmed', true, Number(w.mined.at(-1).blockNumber)]);
});

test('an unrelated receipt never settles this intent: earlier intent, another controller, a non-transition call', async () => {
  const w = await world(); const other = await world(); await queue(w); await queue(other);
  const run = await step(w, 'running', 'ready'); await mine();
  const a = w.adapter(), at = r => async () => ({ blockNumber: Number(r.blockNumber), transactionHash: r.transactionHash });
  w.hooks.locate = at(w.mined[0]); unverified(await a.resolve(w.id, run), /another intent/);              // this deployment's queued tx
  w.hooks.locate = at(other.mined[0]); unverified(await a.resolve(w.id, run), /not a call to the controller/);
  w.hooks.locate = at(w.configureTx); unverified(await a.resolve(w.id, run), /reverted|payee/);           // owner's configure() call
  delete w.hooks.locate;
  assert.equal((await a.resolve(w.id, run)).outcome, 'confirmed');
});

test('runner: lost relay response and missing/tampered proof keep the exact intent pending; no resubmit, no serve; settles only with a proof', async t => {
  const w = await world(); await queue(w); await mine(); w.loseResponse = true;
  const { runner, journal, calls } = runnerFor(w, t);
  const before = w.sent.length;
  assert.equal((await runner.reconcile(w.id)).status, 'pending');
  const pend = journal.read(w.id).pending; assert.ok(pend); assert.equal(w.sent.length, before + 1); w.loseResponse = false;
  await mine();
  w.hooks.locate = async () => null;
  assert.equal((await runner.reconcile(w.id)).status, 'pending');
  delete w.hooks.locate; w.hooks.block = d => { d.receipts.forEach(x => { x.status = '0x1'; x.cumulativeGasUsed = '0x1'; }); return d; };
  assert.equal((await runner.reconcile(w.id)).status, 'pending');
  assert.equal(journal.read(w.id).pending.digest, pend.digest); assert.ok(!calls.includes('serve')); assert.equal(w.sent.length, before + 1);
  delete w.hooks.block;
  assert.equal((await runner.reconcile(w.id)).status, 'reconcile'); assert.equal(journal.read(w.id).pending, null);
  await mine(); assert.equal((await runner.reconcile(w.id)).status, 'running'); assert.ok(calls.includes('serve'));
  assert.equal(w.sent.length, before + 1);
});

test('finalize: finalized only with the proof; after a reorg removes it, unknown, then reorged once the deadline is past (no proof)', async () => {
  const w = await world(); await queue(w); await mine();
  const a = w.adapter(), intent = await a.prepare(w.id, await a.read(w.id), 'running', 'ready');
  const snap = await rpc('evm_snapshot'); await a.submit(w.id, intent); await mine();
  const f = await a.finalize(w.id, intent);
  assert.deepEqual([f.outcome, f.verified, f.proof.transactionHash], ['finalized', true, w.mined.at(-1).transactionHash]);
  w.hooks.locate = async () => null; assert.equal((await a.finalize(w.id, intent)).outcome, 'unknown'); delete w.hooks.locate;
  await rpc('evm_revert', [snap]); await mine();
  assert.equal((await a.finalize(w.id, intent)).outcome, 'unknown');
  await warp(200);
  const r = await a.finalize(w.id, intent); assert.deepEqual([r.outcome, r.proofVerified, r.proof], ['reorged', true, null]);
  assert.equal((await a.resolve(w.id, intent)).outcome, 'finalized-fence');
});

test('finalized fence: another transition consumed the generation -> fence (no proof, never confirmed); theirs is proven', async () => {
  const w = await world(); await queue(w); await mine();
  const a = w.adapter(), s = await a.read(w.id);
  const ours = await a.prepare(w.id, s, 'running', 'ready');
  const theirs = await a.prepare(w.id, s, 'stopped', 'owner stop'); await a.submit(w.id, theirs);
  await assert.rejects(a.submit(w.id, ours));                                       // controller: stale assignment (reverts)
  const r = await a.resolve(w.id, ours);
  assert.deepEqual([r.outcome, r.verified, r.proof], ['finalized-fence', true, null]);
  const t2 = await a.resolve(w.id, theirs);
  assert.deepEqual([t2.outcome, t2.verified, t2.proof.actor], ['confirmed', true, w.human.address]);
});

test('fee payload bound: a rewritten, over-cap or over-budget fee is refused before broadcast; the prepared fee is min(budget, cap)', async () => {
  const w = await world(); await queue(w); await mine(); const n0 = w.sent.length;
  const a = w.adapter(), s = await a.read(w.id), intent = await a.prepare(w.id, s, 'running', 'ready'), p = JSON.parse(intent.payload);
  assert.equal(p.maxGasPriceWei, MAX_GAS.toString());
  const low = w.adapter({ pins: { ...w.pins, maxGasPriceWei: '7' } });
  assert.equal(JSON.parse((await low.prepare(w.id, s, 'running', 'ready')).payload).maxGasPriceWei, '7');
  const mut = q => ({ ...intent, payload: JSON.stringify(q) });
  await assert.rejects(a.submit(w.id, mut({ ...p, maxGasPriceWei: (MAX_GAS + 1n).toString() })), /pins\.maxGasPriceWei/);
  const wide = w.adapter({ pins: { ...w.pins, maxGasPriceWei: (MAX_GAS * 10n).toString() } });
  await assert.rejects(wide.submit(w.id, mut({ ...p, maxGasPriceWei: (MAX_GAS + 1n).toString() })), /authenticated budget/);
  await assert.rejects(a.submit(w.id, mut({ ...p, gasPriceOverride: '1' })), /canonical/);
  await assert.rejects(a.submit(w.id, mut({ reason: p.reason, ...p })), /canonical/);
  await assert.rejects(a.submit(w.id, mut({ ...p, maxGasPriceWei: Number(MAX_GAS) })), /malformed/);
  await assert.rejects(w.adapter({ kind: 'rpc-quorum' }).submit(w.id, intent), /proof-qualified/);
  assert.equal(w.sent.length, n0);
  await a.submit(w.id, intent); assert.equal(w.sent.at(-1).maxFeePerGasWei, MAX_GAS);
  const r = await a.resolve(w.id, intent); assert.deepEqual([r.outcome, r.proof.maxFeePerGasWei], ['confirmed', MAX_GAS.toString()]);
  await assert.rejects(a.submit(w.id, intent), /already executed/); assert.equal(w.sent.length, n0 + 1);
});

test('rpc-quorum: a valid receipt proof is still never verified; an unverified snapshot never prepares', async () => {
  const w = await world(); const q = await queue(w); await mine();
  const qa = w.adapter({ kind: 'rpc-quorum' }), r = await qa.resolve(w.id, q);
  assert.deepEqual([r.outcome, r.verified, r.proofVerified, r.authorityTier], ['confirmed', false, false, 'rpc-quorum']);
  const f = await qa.finalize(w.id, q); assert.deepEqual([f.outcome, f.verified, f.proofVerified], ['finalized', false, false]);
  await assert.rejects(qa.prepare(w.id, await qa.read(w.id), 'running', 'ready'), /verified snapshot/);
  w.auth.proof = false;
  const d = await w.adapter().resolve(w.id, q); assert.deepEqual([d.verified, d.proofVerified], [false, false]);
});
