// READ ADAPTER binding L2 receipt/finality verification to the LOCAL Base node (S's holder: the official `base`
// v1.5.1, base-reth execution + in-process base-consensus deriving from the LOCAL L1 pair, `trustRpc: false`) and to
// the L1 pair adapter (src/l1-source-binding.mjs).
//
// Every call, from these configured endpoints only (loopback, no fallback):
//   1. readiness: chain 8453, Base mainnet genesis hash, eth_syncing false, optimism_syncStatus present with a fresh
//      unsafe head; the consensus heads (unsafe/safe/finalized) ARE the execution node's canonical blocks at those
//      numbers (EL/CL pairing);
//   2. L1 binding: the node's own L1 view (current_l1, and finalized_l1 for finality) is canonical in OUR validated L1
//      pair, and finalized_l1 is final there. A Base node deriving from some other L1 source is refused;
//   3. the receipt, by hash, its block canonical at its number after the read; level from the node's heads:
//      <= finalized_l2 -> 'finalized', <= safe_l2 -> 'safe', else 'unsafe' (sequencer-signed / not yet derived).
// Output: MINTED L2 evidence `verifiedBy: 'base-derivation'` with the same trust as the L1 pair (local full-node
// validation, not a portable proof). An unsafe head, a Sia/archive history entry or a submission reply is never
// upgraded to safe/finalized here.
import { formatTransactionReceipt } from 'viem';
import { refuse } from './forced-inclusion.mjs';
import { TRUST, mint } from './evidence-brand.mjs';

/** Base mainnet identity (base/base v1.5.1 crates/common/chains/src/config.rs MAINNET). */
export const BASE_MAINNET_L2 = Object.freeze({ chainIdHex: '0x2105', genesisHash: '0xf712aa9241cc24369b143cf6dce85f0902a9731e70d66818a3a5845b296c73dd', label: 'base-mainnet' });
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const num = (v) => (typeof v === 'string' ? Number(BigInt(v)) : Number(v));
function endpoint(u, name) {
  let url;
  try { url = new URL(u); } catch { refuse('bad-config', `${name} url`); }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.has(url.hostname)) refuse('not-local', `${name} must be the local node on loopback`);
  return url.href.replace(/\/$/, '');
}

/** config: {execution: {url}, rollup: {url}, l1 (createL1PairSource), identity?, maxUnsafeLagSec?} */
export function createBaseNodeSource({ execution, rollup, l1, identity = BASE_MAINNET_L2, maxUnsafeLagSec = 120, timeoutMs = 8000, fetch = globalThis.fetch, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const el = endpoint(execution?.url, 'execution'), cl = endpoint(rollup?.url, 'rollup');
  if (!l1?.blockStanding) refuse('bad-config', 'the Base source must be bound to the L1 pair source it derives from');
  const trust = identity === BASE_MAINNET_L2 && l1.trust === TRUST.LOCAL_VALIDATED_PAIR ? TRUST.LOCAL_VALIDATED_PAIR : TRUST.TEST_FIXTURE;
  let id = 0;
  const call = async (url, method, params = []) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
    const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`); return j.result;
  };
  const rpc = (m, p) => call(el, m, p), roll = (m, p) => call(cl, m, p);
  const ref = (b) => ({ number: num(b.number), hash: b.hash, timestamp: num(b.timestamp), l1origin: b.l1origin ? { number: num(b.l1origin.number), hash: b.l1origin.hash } : null });

  async function readiness() {
    const checks = [];
    const chk = async (name, fn) => { try { checks.push({ name, ok: true, detail: await fn() }); } catch (e) { checks.push({ name, ok: false, detail: String(e.message || e) }); } };
    const need = (c, m) => { if (!c) throw new Error(m); };
    let st;
    await chk('l2.chain', async () => { const c = await rpc('eth_chainId'); need(c === identity.chainIdHex, `chain ${c}`); return c; });
    await chk('l2.genesis', async () => { const g = await rpc('eth_getBlockByNumber', ['0x0', false]); need(g?.hash === identity.genesisHash, `genesis ${g?.hash}`); return g.hash; });
    await chk('l2.syncing', async () => { need(await rpc('eth_syncing') === false, 'eth_syncing is not false'); return false; });
    await chk('l2.syncStatus', async () => {
      st = await roll('optimism_syncStatus');
      need(st?.unsafe_l2 && st.safe_l2 && st.finalized_l2 && st.current_l1 && st.finalized_l1, 'incomplete optimism_syncStatus');
      const lag = now() - num(st.unsafe_l2.timestamp); need(lag <= maxUnsafeLagSec, `unsafe head lag ${lag} s`);
      return { unsafe: num(st.unsafe_l2.number), safe: num(st.safe_l2.number), finalized: num(st.finalized_l2.number) };
    });
    await chk('l2.pair', async () => {
      for (const k of ['unsafe_l2', 'safe_l2', 'finalized_l2']) {
        const b = await rpc('eth_getBlockByNumber', ['0x' + num(st[k].number).toString(16), false]);
        need(b?.hash === st[k].hash, `${k} is not the execution node's block at that height`);
      }
      return true;
    });
    await chk('l2.l1view', async () => {
      const cur = await l1.blockStanding(num(st.current_l1.number), st.current_l1.hash);
      need(cur.canonical, 'the Base node\'s current L1 block is not canonical in the local L1 pair (another L1 source?)');
      const fin = await l1.blockStanding(num(st.finalized_l1.number), st.finalized_l1.hash);
      need(fin.canonical && fin.finalized, 'the Base node\'s finalized L1 block is not final in the local L1 pair');
      return { currentL1: num(st.current_l1.number), finalizedL1: num(st.finalized_l1.number) };
    });
    const ok = checks.every((c) => c.ok);
    return { ok, checks, status: ok ? { unsafe: ref(st.unsafe_l2), safe: ref(st.safe_l2), finalized: ref(st.finalized_l2), finalizedL1: { number: num(st.finalized_l1.number), hash: st.finalized_l1.hash } } : null };
  }
  async function readyOrRefuse() { const r = await readiness(); if (!r.ok) refuse('l2-source-not-ready', r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ')); return r; }

  /** -> {state: 'pending'} | {state: 'included', receipt, evidence: {verifiedBy: 'base-derivation', level, safe, finalized, ...}} */
  async function receipt(txHash) {
    const r0 = await readyOrRefuse();
    const raw = await rpc('eth_getTransactionReceipt', [txHash]);
    if (!raw) return { state: 'pending' };
    if (raw.transactionHash?.toLowerCase() !== String(txHash).toLowerCase()) refuse('l2-receipt-mismatch', 'another transaction');
    const r1 = await readyOrRefuse();
    const canon = await rpc('eth_getBlockByNumber', [raw.blockNumber, false]);
    if (canon?.hash !== raw.blockHash) refuse('l2-not-canonical', 'the receipt\'s block is no longer canonical (reorg)');
    if (r1.status.finalized.number < r0.status.finalized.number || r1.status.safe.number < r0.status.safe.number) refuse('l2-source-regressed');
    const n = num(raw.blockNumber), s = r1.status;
    const finalized = n <= s.finalized.number, safe = n <= s.safe.number;
    const receiptOut = formatTransactionReceipt(raw);
    const evidence = mint({ kind: 'l2-receipt', verifiedBy: 'base-derivation', trust, source: { execution: el, rollup: cl, l1: l1.source, identity: identity.label ?? 'custom' },
      txHash: raw.transactionHash, blockHash: raw.blockHash, blockNumber: n, level: finalized ? 'finalized' : safe ? 'safe' : 'unsafe', safe, finalized,
      heads: { safe: s.safe, finalized: s.finalized, finalizedL1: s.finalizedL1 }, readAt: now(), receipt: receiptOut });
    return { state: 'included', receipt: evidence.receipt, evidence };   // the frozen, owned receipt: identity checks hold
  }
  return { readiness, receipt, trust };
}
