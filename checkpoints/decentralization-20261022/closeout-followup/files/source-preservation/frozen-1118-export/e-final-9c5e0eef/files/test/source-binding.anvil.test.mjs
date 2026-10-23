// SOURCE BINDING end to end, offline: transaction verification reads ONLY through the adapters
// (src/l1-source-binding.mjs, src/base-source-binding.mjs), and every inclusion/finality claim is minted by them.
//   L1 execution = anvil running the PRODUCTION Base portal bytecode (test/support/l1-portal.mjs; research capture).
//   L1 consensus = a LABELLED beacon fixture mirroring anvil's finalized/head tags (test/support/pair-stubs.mjs): it
//                  is NOT Lighthouse and validates nothing; it exists to drive the adapter's pairing/readiness logic.
//   L2 execution = anvil `--network optimism` with the REAL lease contracts (test/support/l2-world.mjs).
//   L2 rollup    = a LABELLED optimism_syncStatus fixture over those two anvils.
// Because the identities are not Ethereum/Base mainnet, every minted object carries trust 'test-fixture', and the
// DEFAULT checks refuse it: these tests opt in with acceptTrust: ['test-fixture'] and assert the default refusal.
// What this does NOT show: that a real reth+Lighthouse pair is synced or honest (P's live pair gate), or any portable
// cryptographic proof. Full-consensus evidence stays an explicit gate until P's pair is synchronized.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as viem from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { extractTransactionDepositedLogs } from 'viem/op-stack';
import * as F from '../src/forced-inclusion.mjs';
import { createL1PairSource, MAINNET_L1 } from '../src/l1-source-binding.mjs';
import { createBaseNodeSource } from '../src/base-source-binding.mjs';
import { TRUST } from '../src/evidence-brand.mjs';
import { startL1, CAPTURE } from './support/l1-portal.mjs';
import { startL2, setupLeaseWorld } from './support/l2-world.mjs';
import { startBeaconFixture, startRollupFixture, jrpc } from './support/pair-stubs.mjs';

const T = { timeout: 180000 };
const FIX = { acceptTrust: [TRUST.TEST_FIXTURE] };
const GVR = '0x' + '7e'.repeat(32);
let l1, l2, w, beacon, rollup, l1src, l2src, l1Identity, l2Identity, clockOffset = 0;
const fixtureNow = () => Math.floor(Date.now() / 1000) + clockOffset;   // FIXTURE CLOCK: the replayed L1's own time
const PIN = { portal: F.BASE_MAINNET.portal, implementation: viem.getAddress(viem.slice(CAPTURE.accounts[F.BASE_MAINNET.portal.toLowerCase()].storage[F.EIP1967_IMPLEMENTATION_SLOT], 12)), versions: ['6.0.1'] };

test.before(async () => {
  [l1, l2] = [await startL1(), await startL2()];
  w = await setupLeaseWorld(l2);
  beacon = await startBeaconFixture({ el: l1.url, gvr: GVR });
  rollup = await startRollupFixture({ l2: l2.url, l1: l1.url });
  // the replayed L1 starts at the captured block number and timestamp: its genesis is that block, its clock is the
  // capture's (FIXTURE CLOCK below), and anvil has a finalized tag only 64 blocks back
  l1Identity = { chainIdHex: '0x1', genesisNumber: Number(BigInt(CAPTURE.block.number)), elGenesisHash: (await jrpc(l1.url, 'eth_getBlockByNumber', ['0x' + BigInt(CAPTURE.block.number).toString(16), false])).hash,
    clGenesisValidatorsRoot: GVR, label: 'TEST-FIXTURE anvil L1 + beacon fixture' };
  await l1.rpc('anvil_mine', ['0x50']);
  const l1ts = Number(BigInt((await jrpc(l1.url, 'eth_getBlockByNumber', ['latest', false])).timestamp));
  clockOffset = l1ts - Math.floor(Date.now() / 1000);
  l2Identity = { chainIdHex: '0x2105', genesisHash: (await jrpc(l2.url, 'eth_getBlockByNumber', ['0x0', false])).hash, label: 'TEST-FIXTURE anvil L2 + rollup fixture' };
  l1src = createL1PairSource({ execution: { url: l1.url }, consensus: { url: beacon.url }, identity: l1Identity, minPeers: 0, now: fixtureNow });
  l2src = createBaseNodeSource({ execution: { url: l2.url }, rollup: { url: rollup.url }, l1: l1src, identity: l2Identity });
});
test.after(() => { l1?.stop(); l2?.stop(); beacon?.close(); rollup?.close(); });

test('configuration: only the local pair, two distinct clients; mainnet identity refuses the anvil fixture; the fixture mints only test-fixture trust', T, async () => {
  assert.throws(() => createL1PairSource({ execution: { url: 'https://ethereum-rpc.publicnode.com' }, consensus: { url: beacon.url } }), (e) => e.code === 'not-local');
  assert.throws(() => createL1PairSource({ execution: { url: l1.url }, consensus: { url: l1.url } }), (e) => e.code === 'bad-config');
  assert.throws(() => createBaseNodeSource({ execution: { url: l2.url }, rollup: { url: rollup.url } }), (e) => e.code === 'bad-config', 'a Base source must name its L1 source');
  assert.throws(() => createL1PairSource({ execution: { url: l1.url }, consensus: { url: beacon.url }, identity: MAINNET_L1, minPeers: 0 }), (e) => e.code === 'bad-config', 'a production pair cannot waive peers');
  const mainnet = createL1PairSource({ execution: { url: l1.url }, consensus: { url: beacon.url }, identity: MAINNET_L1, now: fixtureNow });
  const r = await mainnet.readiness();
  assert.equal(r.ok, false);
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
  for (const n of ['el.genesis', 'cl.genesis', 'el.peers']) assert.ok(failed.includes(n), `${n} refuses the anvil fixture under the mainnet identity`);
  assert.equal(l1src.trust, TRUST.TEST_FIXTURE);
  const ok = await l1src.readiness();
  assert.equal(ok.ok, true, JSON.stringify(ok.checks.filter((c) => !c.ok)));
});

test('a forced lease, read back ONLY through the adapters: minted L1 evidence -> deposit match -> real L2 execution -> minted Base evidence -> unsafe, safe, finalized', T, async (t) => {
  const relayer = generatePrivateKey(), sender = privateKeyToAccount(relayer).address;
  const snap = await F.readLeaseSnapshot({ client: l2.pc, head: await l2.headNow(), pins: w.pins, operator: w.operator, id: w.id, kind: 1, enclaveId: w.enclaveId });
  const lease = { id: w.id, kind: 1, enclaveId: w.enclaveId, nonce: 0n, deadline: BigInt(snap.head.timestamp + 6 * 3600), payee: sender, maxChargeWei: 10n ** 14n };
  const { plan } = await F.planLeaseDeposit({ pins: w.pins, operator: w.operator, lease, signature: await w.signLease(lease), snapshot: snap, l1Sender: sender, l2GasLimit: 800_000n, now: snap.head.timestamp + 5 });
  const portal = await l1src.portalSnapshot(F.BASE_MAINNET.portal);
  assert.equal(portal.version, '6.0.1');
  F.checkPortalPin(portal, PIN, FIX);
  assert.throws(() => F.checkPortalPin(portal, PIN), (e) => e.code === 'l1-state-unverified', 'default trust refuses the fixture');
  assert.throws(() => F.checkPortalPin(structuredClone(portal), PIN, FIX), (e) => e.code === 'l1-state-unverified', 'a copy is not minted');
  const sent = await l1.send(relayer, plan.l1Transaction);
  const got = await l1src.receipt(sent.transactionHash);
  assert.equal(got.state, 'included');
  const ev = got.evidence;
  assert.deepEqual([ev.verifiedBy, ev.trust, ev.finalized, ev.transaction.from], ['l1-local-validated-pair', TRUST.TEST_FIXTURE, false, sender]);
  assert.throws(() => F.matchDepositEvent(plan, undefined, ev), (e) => e.code === 'l1-receipt-unverified', 'default trust refuses fixture evidence');
  assert.throws(() => F.matchDepositEvent(plan, undefined, { ...ev }, FIX), (e) => e.code === 'l1-receipt-unverified', 'a spread copy is caller JSON');
  assert.throws(() => F.matchDepositEvent(plan, sent, ev, FIX), (e) => e.code === 'l1-receipt-mismatch', 'evidence cannot be paired with another receipt object');
  const m = F.matchDepositEvent(plan, undefined, ev, FIX);
  const [log] = extractTransactionDepositedLogs({ logs: ev.receipt.logs });
  const exec = await l2.executeLog(log);
  assert.equal(exec.hash, m.l2TransactionHash);
  // L2: unsafe (the rollup fixture's safe/finalized heads are at 0)
  const b1 = await l2src.receipt(m.l2TransactionHash);
  assert.equal(b1.evidence.level, 'unsafe');
  const outcome = F.classifyL2Outcome({ plan, l2TransactionHash: m.l2TransactionHash, receipt: b1.receipt, head: await l2.headNow(), source: { evidence: b1.evidence }, ...FIX });
  assert.equal(outcome.state, 'l2-included');
  const h1 = await l2.headNow();
  assert.throws(() => F.classifyL2Outcome({ plan, l2TransactionHash: m.l2TransactionHash, receipt: b1.receipt, head: h1, source: { evidence: b1.evidence } }), (e) => e.code === 'receipt-unverified');
  assert.equal(F.classifyFinality({ outcome, depositL1BlockHash: ev.blockHash, l1Evidence: ev, l2Evidence: b1.evidence, ...FIX }).level, 'unsafe');
  // the derivation fixture marks the block safe, then finalized; the L1 deposit block is not final yet -> at most safe
  rollup.state.safeNumber = Number(b1.evidence.blockNumber); rollup.state.finalizedNumber = Number(b1.evidence.blockNumber);
  const b2 = await l2src.receipt(m.l2TransactionHash);
  assert.equal(b2.evidence.level, 'finalized');
  const out2 = F.classifyL2Outcome({ plan, l2TransactionHash: m.l2TransactionHash, receipt: b2.receipt, head: await l2.headNow(), source: { evidence: b2.evidence }, ...FIX });
  assert.equal(F.classifyFinality({ outcome: out2, depositL1BlockHash: ev.blockHash, l1Evidence: ev, l2Evidence: b2.evidence, ...FIX }).level, 'safe', 'no finalized L2 while the deposit L1 block is not final');
  // the L1 pair finalizes the deposit block (anvil: finalized = latest - 64); the adapter re-reads it
  await l1.rpc('anvil_mine', ['0x50']);
  const ev2 = (await l1src.receipt(sent.transactionHash)).evidence;
  assert.equal(ev2.finalized, true);
  const fin = F.classifyFinality({ outcome: out2, depositL1BlockHash: ev2.blockHash, l1Evidence: ev2, l2Evidence: (await l2src.receipt(m.l2TransactionHash)).evidence, ...FIX });
  t.diagnostic(`finality: ${JSON.stringify(fin)}`);
  assert.equal(fin.level, 'finalized');
  assert.equal(fin.depositL1Final, true);
  rollup.state.safeNumber = 0; rollup.state.finalizedNumber = 0;
});

test('fail closed: unpaired beacon, syncing / optimistic / EL offline, no peers, stale head, a Base node on another L1, a reorged-away receipt', T, async () => {
  const key = generatePrivateKey();
  const rc = await l1.send(key, { to: privateKeyToAccount(key).address, data: '0x' });
  const expect = async (mut, code, undo) => { mut(); try { await assert.rejects(l1src.receipt(rc.transactionHash), (e) => e.code === code); } finally { undo(); } };
  await expect(() => { beacon.state.finalizedOverride = { block_number: '1', block_hash: '0x' + '99'.repeat(32), slot: '1' }; }, 'l1-source-not-ready', () => { beacon.state.finalizedOverride = null; });
  // a beacon finalized payload that IS an execution block (number and hash match) but NOT the EL's finalized block
  const latest = await jrpc(l1.url, 'eth_getBlockByNumber', ['latest', false]);
  await expect(() => { beacon.state.finalizedOverride = { block_number: String(Number(BigInt(latest.number))), block_hash: latest.hash, slot: '1' }; }, 'l1-source-not-ready', () => { beacon.state.finalizedOverride = null; });
  for (const k of ['syncing', 'optimistic', 'elOffline']) await expect(() => { beacon.state[k] = true; }, 'l1-source-not-ready', () => { beacon.state[k] = false; });
  const strict = createL1PairSource({ execution: { url: l1.url }, consensus: { url: beacon.url }, identity: l1Identity, minPeers: 1, now: fixtureNow });
  await assert.rejects(strict.receipt(rc.transactionHash), (e) => e.code === 'l1-source-not-ready' && /el.peers/.test(e.message), 'anvil has no peers: a real pair needs some');
  const later = createL1PairSource({ execution: { url: l1.url }, consensus: { url: beacon.url }, identity: l1Identity, minPeers: 0, now: () => fixtureNow() + 3 * 3600 });
  await assert.rejects(later.receipt(rc.transactionHash), (e) => e.code === 'l1-source-not-ready' && /el.head/.test(e.message));
  // a Base node whose L1 view is not in OUR pair
  rollup.state.l1Override = { hash: '0x' + '42'.repeat(32), number: 5, parentHash: '0x' + '00'.repeat(32), timestamp: 1 };
  try { assert.equal((await l2src.readiness()).ok, false); } finally { rollup.state.l1Override = null; }
  // a receipt whose block is reorged away before it is read: missing, never evidence
  const snapId = await l1.rpc('evm_snapshot');
  const k2 = generatePrivateKey();
  const gone = await l1.send(k2, { to: privateKeyToAccount(k2).address, data: '0x' });
  await l1.rpc('evm_revert', [snapId]);
  await l1.rpc('anvil_mine', ['0x2']);
  assert.equal((await l1src.receipt(gone.transactionHash)).state, 'pending');
});

test('nonce/resend tracking binds to the node\'s own transaction: a reverted L1 deposit frees the slot only with minted evidence at the recorded nonce', T, async () => {
  const key = generatePrivateKey(), from = privateKeyToAccount(key).address;
  const data = viem.encodeFunctionData({ abi: F.PORTAL_ABI, functionName: 'depositTransaction', args: [from, 0n, 30_000n, false, '0x' + 'ab'.repeat(388)] });
  const rc = await l1.send(key, { chainId: 1, to: F.BASE_MAINNET.portal, value: 0n, data });
  assert.equal(rc.status, 'reverted');
  const ev = (await l1src.receipt(rc.transactionHash)).evidence;
  const tr = new F.ForcedInclusionTracker();
  tr.admit('k', '0x01', {});
  tr.checkL1Send('k', ev.transaction.nonce + 1);
  assert.throws(() => tr.resolveFailedL1('k', ev.receipt, ev, FIX), (e) => e.code === 'l1-receipt-mismatch', 'not the recorded L1 nonce');
  const tr2 = new F.ForcedInclusionTracker();
  tr2.admit('k', '0x01', {}); tr2.checkL1Send('k', ev.transaction.nonce);
  assert.throws(() => tr2.resolveFailedL1('k', ev.receipt, ev), (e) => e.code === 'l1-receipt-unverified', 'default trust');
  tr2.resolveFailedL1('k', ev.receipt, ev, FIX);
  assert.equal(tr2.get('k').state, 'dead');
});
