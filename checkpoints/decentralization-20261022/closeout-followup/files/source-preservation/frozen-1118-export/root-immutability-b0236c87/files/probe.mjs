// Source-binding CONTROL FLOW against scripted endpoints (labelled stubs, test/support/pair-stubs.mjs): what anvil cannot
// produce on demand. A reorg between the receipt read and the canonical re-check, a node that answers another
// transaction, a transaction not in its block, a missing finalized tag. Also why the mainnet identity matters: a
// stub that reports mainnet genesis + GVR on loopback mints 'local-validated-pair' trust. The trust anchor is the
// root-configured loopback pair itself, i.e. local full-node validation, never a portable proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createL1PairSource, MAINNET_L1 } from '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-transaction-independence/src/l1-source-binding.mjs';
import { TRUST, isMinted } from '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-transaction-independence/src/evidence-brand.mjs';
import { startExecutionStub, startBeaconFixture } from '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-transaction-independence/test/support/pair-stubs.mjs';

const H = (b) => '0x' + b.repeat(32);
const now = Math.floor(Date.now() / 1000);
function chain(over = {}) {
  const blocks = { 0: { number: '0x0', hash: MAINNET_L1.elGenesisHash, timestamp: '0x0' }, 90: { number: '0x5a', hash: H('90'), timestamp: '0x' + (now - 600).toString(16), transactions: [H('a1')] },
    100: { number: '0x64', hash: H('64'), timestamp: '0x' + (now - 5).toString(16), transactions: [] } };
  const st = { blocks, orphans: {}, finalized: 90, safe: 90, latest: 100, reorgAfterReceipt: false, receiptTx: H('a1'), calls: 0, ...over };
  const tag = (t) => (t === 'latest' ? st.latest : t === 'finalized' ? st.finalized : t === 'safe' ? st.safe : Number(BigInt(t)));
  const answer = (method, params) => {
    st.calls++;
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_syncing') return false;
    if (method === 'net_peerCount') return '0x5';
    if (method === 'eth_getBlockByNumber') { const n = tag(params[0]); if (n === null) return null; const b = st.blocks[n]; return b ? { ...b } : null; }
    if (method === 'eth_getBlockByHash') return Object.values(st.blocks).find((b) => b.hash === params[0]) ?? st.orphans[params[0]] ?? null;
    if (method === 'eth_getTransactionByHash') return { hash: params[0], blockHash: H('90'), from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20), nonce: '0x7' };
    if (method === 'eth_getTransactionReceipt') {
      // the canonical block at 90 changes right after this read; the old one stays retrievable by hash (an orphan), as a real node keeps it
      if (st.reorgAfterReceipt && !st.orphans[H('90')]) { st.orphans[H('90')] = st.blocks[90]; st.blocks[90] = { ...st.blocks[90], hash: H('91') }; }
      return { transactionHash: st.receiptTx, blockHash: H('90'), blockNumber: '0x5a', status: '0x1', logs: [], from: '0x' + '11'.repeat(20), to: '0x' + '22'.repeat(20),
        cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', type: '0x2', transactionIndex: '0x0', logsBloom: '0x' + '00'.repeat(256), contractAddress: null };
    }
    throw new Error('unsupported ' + method);
  };
  return { st, answer };
}
async function pair(over = {}, beaconState = {}) {
  const c = chain(over);
  const el = await startExecutionStub(c.answer);
  const cl = await startBeaconFixture({ el: el.url, gvr: MAINNET_L1.clGenesisValidatorsRoot, state: beaconState });
  return { c, el, cl, src: createL1PairSource({ execution: { url: el.url }, consensus: { url: cl.url } }), close: () => { el.close(); cl.close(); } };
}


const p = await pair();
try {
 const r = await p.src.receipt(H('a1'));
 const before = {minted:isMinted(r.evidence),outerFrozen:Object.isFrozen(r.evidence),receiptFrozen:Object.isFrozen(r.receipt),transactionFrozen:Object.isFrozen(r.evidence.transaction),nonce:r.evidence.transaction.nonce,status:r.receipt.status,logs:r.receipt.logs.length};
 r.evidence.transaction.nonce = 999; r.receipt.status = 'reverted'; r.receipt.logs.push({address:'0x'+'33'.repeat(20),topics:[],data:'0x'});
 const after = {minted:isMinted(r.evidence),sameReceipt:r.receipt===r.evidence.receipt,nonce:r.evidence.transaction.nonce,status:r.evidence.receipt.status,logs:r.evidence.receipt.logs.length,finalized:r.evidence.finalized};
 console.log(JSON.stringify({test:'actual read adapter over labelled loopback fixtures; no real chain',before,after}));
} finally {p.close();}
