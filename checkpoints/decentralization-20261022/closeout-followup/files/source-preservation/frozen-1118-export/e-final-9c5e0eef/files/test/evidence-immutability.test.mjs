// EVIDENCE IMMUTABILITY: the actual read adapter (createL1PairSource.receipt) over a LABELLED scripted loopback pair
// (no real chain), run against the CURRENT source and, as a counter-control, the previous source 46dbfbef extracted
// from git. Old source: nested validated facts are mutable after minting, and each mutation changes a classifier's
// answer (a tracker slot freed by a rewritten nonce, a forged deposit matched); top-level fields such as `finalized`
// were already frozen there. Current
// source: the same writes throw (ES modules are strict) and every classifier still sees what the node said.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as viem from 'viem';
import { startExecutionStub, startBeaconFixture } from './support/pair-stubs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = path.join(ROOT, 'tmp', 'old-46dbfbef');
const H = (b) => '0x' + b.repeat(32);
const PORTAL = '0x49048044D57e1C92A77f79988d21fa8faf74E97e';
const MAINNET_GENESIS = '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3', GVR = '0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95';

function extractOld() {
  fs.rmSync(OLD, { recursive: true, force: true }); fs.mkdirSync(OLD, { recursive: true });
  const tar = execFileSync('git', ['-C', ROOT, 'archive', '46dbfbef32a25e23c7d1045f2458f00a7470cb32', 'src']);
  execFileSync('tar', ['-x', '-C', OLD], { input: tar });
}
const load = async (dir) => ({
  F: await import(pathToFileURL(path.join(dir, 'src/forced-inclusion.mjs')).href),
  L1: await import(pathToFileURL(path.join(dir, 'src/l1-source-binding.mjs')).href),
});

/** A scripted mainnet-identity pair: the deposit-candidate tx at block 90 (status chosen), finalized at 80 or 90. */
async function pair({ status = '0x1', finalized = 90 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const blk = (n, h, ago, txs = []) => ({ number: '0x' + n.toString(16), hash: h, parentHash: H('00'), timestamp: '0x' + (now - ago).toString(16), transactions: txs });
  const blocks = { 0: blk(0, MAINNET_GENESIS, 10 ** 6), 80: blk(80, H('80'), 900), 90: blk(90, H('90'), 600, [H('a1')]), 100: blk(100, H('64'), 5) };
  const tag = (t) => (t === 'latest' ? 100 : t === 'finalized' || t === 'safe' ? finalized : Number(BigInt(t)));
  const el = await startExecutionStub((method, params) => {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_syncing') return false;
    if (method === 'net_peerCount') return '0x5';
    if (method === 'eth_getBlockByNumber') return blocks[tag(params[0])] ?? null;
    if (method === 'eth_getBlockByHash') return Object.values(blocks).find((b) => b.hash === params[0]) ?? null;
    if (method === 'eth_getTransactionByHash') return { hash: params[0], blockHash: H('90'), from: '0x' + '11'.repeat(20), to: PORTAL, nonce: '0x7' };
    if (method === 'eth_getTransactionReceipt') return { transactionHash: H('a1'), blockHash: H('90'), blockNumber: '0x5a', status, logs: [], from: '0x' + '11'.repeat(20), to: PORTAL,
      cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', type: '0x2', transactionIndex: '0x0', logsBloom: '0x' + '00'.repeat(256), contractAddress: null };
    throw new Error('unsupported ' + method);
  });
  const cl = await startBeaconFixture({ el: el.url, gvr: GVR });
  return { el, cl, close: () => { el.close(); cl.close(); } };
}
/** A TransactionDeposited log as the portal would emit it (the forgery a caller might push into a receipt). */
function forgedDepositLog(F, plan) {
  const [to, value, gas, isCreation, data] = viem.decodeFunctionData({ abi: F.PORTAL_ABI, data: plan.l1Transaction.data }).args;
  const opaque = viem.encodePacked(['uint256', 'uint256', 'uint64', 'bool', 'bytes'], [0n, value, gas, isCreation, data]);
  return { address: PORTAL, blockHash: H('90'), blockNumber: 90n, logIndex: 0, transactionHash: H('a1'), transactionIndex: 0, removed: false,
    topics: [viem.toEventSelector(F.PORTAL_ABI[1]), viem.pad('0x' + '11'.repeat(20)), viem.pad(to), H('00')], data: viem.encodeAbiParameters([{ type: 'bytes' }], [opaque]) };
}
const tryWrite = (fn) => { try { fn(); return 'written'; } catch (e) { return e instanceof TypeError ? 'refused' : 'error:' + e.message; } };

async function scenario(dir) {
  const { F, L1 } = await load(dir);
  const out = {};
  // 1. a REVERTED L1 tx at nonce 7, while the tracker recorded a different L1 transaction at nonce 999
  let p = await pair({ status: '0x0' });
  try {
    const r = await L1.createL1PairSource({ execution: { url: p.el.url }, consensus: { url: p.cl.url } }).receipt(H('a1'));
    const tr = new F.ForcedInclusionTracker();
    tr.admit('k', '0x01', {}); tr.checkL1Send('k', 999);
    out.nonceWrite = tryWrite(() => { r.evidence.transaction.nonce = 999; });
    try { tr.resolveFailedL1('k', r.receipt, r.evidence); out.slot = tr.get('k').state; } catch (e) { out.slot = 'refused:' + e.code; }
    out.bigint = typeof r.evidence.receipt.blockNumber;
  } finally { p.close(); }
  // 2. the deposit's L1 block (90) is NOT final (finalized = 80); a write of `finalized: true`
  p = await pair({ finalized: 80 });
  try {
    const r = await L1.createL1PairSource({ execution: { url: p.el.url }, consensus: { url: p.cl.url } }).receipt(H('a1'));
    out.finalizedBefore = r.evidence.finalized;
    out.finalizedWrite = tryWrite(() => { r.evidence.finalized = true; });
    const outcome = { state: 'l2-included', level: 'unsafe', receipt: { blockNumber: 5n, blockHash: H('05') } };
    out.depositL1Final = F.classifyFinality({ outcome, depositL1BlockHash: H('90'), l1Evidence: r.evidence }).depositL1Final;
    // 3. the receipt has NO deposit log; a forged TransactionDeposited pushed into it, then the plan matched
    const plan = { operation: 'lease.claim', l1Transaction: { chainId: 1, to: PORTAL, value: 0n, data: viem.encodeFunctionData({ abi: F.PORTAL_ABI, functionName: 'depositTransaction',
      args: ['0x' + '22'.repeat(20), 0n, 800000n, false, '0x' + 'cd'.repeat(388)] }) }, deposit: { to: viem.getAddress('0x' + '22'.repeat(20)), value: 0n, mint: 0n, gasLimit: 800000n,
      isCreation: false, data: '0x' + 'cd'.repeat(388), acceptableFrom: [viem.getAddress('0x' + '11'.repeat(20))] } };
    out.logPush = tryWrite(() => { r.evidence.receipt.logs.push(forgedDepositLog(F, plan)); });
    try { out.match = F.matchDepositEvent(plan, undefined, r.evidence).l2TransactionHash ? 'matched-forged-deposit' : 'no'; } catch (e) { out.match = 'refused:' + e.code; }
    out.statusWrite = tryWrite(() => { r.receipt.status = 'reverted'; });
    out.sameReceipt = r.receipt === r.evidence.receipt;
  } finally { p.close(); }
  return out;
}

test('counter-control on the previous source 46dbfbef: nested validated facts are writable and each write changes a classifier answer', async () => {
  extractOld();
  const o = await scenario(OLD);
  assert.deepEqual([o.nonceWrite, o.slot], ['written', 'dead'], 'a rewritten nonce freed a slot held by a different L1 transaction');
  // the old shallow freeze DID protect top-level fields such as `finalized`: that case was not exploitable
  assert.deepEqual([o.finalizedBefore, o.finalizedWrite, o.depositL1Final], [false, 'refused', false], 'top level was already frozen');
  assert.equal(o.statusWrite, 'written', 'but the nested receipt was writable');
  assert.deepEqual([o.logPush, o.match], ['written', 'matched-forged-deposit'], 'a forged deposit log was matched as a real deposit');
  fs.rmSync(OLD, { recursive: true, force: true });
});

test('current source: the same writes throw, every classifier sees what the node said; BigInt kept; receipt identity kept', async () => {
  const o = await scenario(ROOT);
  assert.deepEqual([o.nonceWrite, o.slot], ['refused', 'refused:l1-receipt-mismatch'], 'the recorded L1 nonce 999 is not the node\'s nonce 7');
  assert.deepEqual([o.finalizedBefore, o.finalizedWrite, o.depositL1Final], [false, 'refused', false]);
  assert.deepEqual([o.logPush, o.statusWrite, o.match], ['refused', 'refused', 'refused:l1-receipt-mismatch'], 'no deposit log: nothing to match');
  assert.equal(o.sameReceipt, true, 'the adapter hands callers the frozen receipt itself');
  assert.equal(o.bigint, 'bigint', 'viem BigInt fields survive the owned copy');
});

test('mint copies, it does not freeze caller-owned state; binary buffers and functions are refused', async () => {
  const { mint, isMinted } = await import('../src/evidence-brand.mjs');
  const caller = { kind: 'x', nested: { list: [1n, 2n] } };
  const m = mint(caller);
  assert.equal(Object.isFrozen(caller) || Object.isFrozen(caller.nested) || Object.isFrozen(caller.nested.list), false, 'the caller\'s object is untouched');
  caller.nested.list.push(3n);
  assert.deepEqual(m.nested.list, [1n, 2n], 'the minted copy is owned: later caller writes do not reach it');
  assert.equal(isMinted(m), true); assert.equal(isMinted(caller), false);
  assert.throws(() => mint({ b: new Uint8Array(2) }), /binary buffers/);
  assert.throws(() => mint({ f: () => 1 }), (e) => e.name === 'DataCloneError');
});
