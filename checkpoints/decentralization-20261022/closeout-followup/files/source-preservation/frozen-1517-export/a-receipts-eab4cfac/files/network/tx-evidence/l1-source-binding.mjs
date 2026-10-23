// READ ADAPTER binding transaction verification to the LOCAL, VALIDATED Ethereum L1 pair (P's package: reth v2.8.0
// execution on 127.0.0.1:18645, Lighthouse v8.3.2 beacon on 127.0.0.1:15052; work/rpc-l1-source-package 1260cdc).
//
// What it does, on every call (never cached across calls, no fallback endpoint of any kind):
//   1. readiness, the same facts P's `l1pair.py ready` gate checks, read from THESE two configured endpoints only:
//      EL chain id 1, mainnet genesis hash, eth_syncing false, at least minPeers peers, head fresh, finalized present
//      and fresh; CL mainnet genesis_validators_root, not syncing, not optimistic, EL online, at least minPeers peers;
//   2. PAIRING: the beacon node's finalized block's execution payload (block_number, block_hash) IS the execution
//      node's block at that number AND its `finalized` block; the beacon head payload is the EL block at that height.
//      Two URLs that are not a real EL/CL pair (or one untrusted backend behind both) cannot produce this unless that
//      backend fakes BOTH a consensus finalized chain and a matching execution chain;
//   3. the requested receipt / block / storage, pinned by hash, re-checked canonical at its number AFTER the read
//      (reorg -> refused), and classified final ONLY by number <= the paired finalized block with the canonical hash.
// What it returns is MINTED evidence (src/evidence-brand.mjs) carrying `trust: 'local-validated-pair'`: local full-node
// validation trust (reth executed every block from genesis; Lighthouse follows consensus from its weak-subjectivity
// anchor), NOT a portable cryptographic proof. A submission-only endpoint can never mint this; the same validated pair
// may serve sends (P's opt-in broadcast) and reads, because the evidence comes from its validated state, not from the
// reply to a send.
import { formatTransactionReceipt, getAddress, slice } from 'viem';
import { refuse } from './forced-inclusion.mjs';
import { TRUST, mint } from './evidence-brand.mjs';

/** Ethereum mainnet identity, as pinned by P (l1pair/PINS.json at 1260cdc). */
export const MAINNET_L1 = Object.freeze({
  chainIdHex: '0x1',
  elGenesisHash: '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3',
  clGenesisValidatorsRoot: '0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95',
  label: 'ethereum-mainnet',
});
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const num = (v) => (typeof v === 'string' ? Number(BigInt(v)) : Number(v));

function endpoint(u, name) {
  let url;
  try { url = new URL(u); } catch { refuse('bad-config', `${name} url`); }
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.has(url.hostname)) refuse('not-local', `${name} must be the local node on loopback (no remote or public endpoint)`);
  if (url.username || url.password) refuse('bad-config', `${name}: no credentials in the url`);
  return url.href.replace(/\/$/, '');
}

/**
 * config: {execution: {url}, consensus: {url}, identity?, trust?, minPeers?, maxHeadLagSec?, maxFinalizedLagSec?, timeoutMs?}
 * identity/trust overrides exist ONLY for labelled test fixtures: anything but the mainnet identity mints
 * `trust: 'test-fixture'`, which the default transaction checks refuse.
 */
export function createL1PairSource({ execution, consensus, identity = MAINNET_L1, minPeers = 1, maxHeadLagSec = 120, maxFinalizedLagSec = 3600, timeoutMs = 8000,
  fetch = globalThis.fetch, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const el = endpoint(execution?.url, 'execution'), cl = endpoint(consensus?.url, 'consensus');
  if (el === cl) refuse('bad-config', 'execution and consensus must be the two clients of the pair, not one endpoint');
  const trust = identity === MAINNET_L1 ? TRUST.LOCAL_VALIDATED_PAIR : TRUST.TEST_FIXTURE;
  if (!(Number.isInteger(minPeers) && minPeers >= 0)) refuse('bad-config', 'minPeers');
  if (minPeers === 0 && trust !== TRUST.TEST_FIXTURE) refuse('bad-config', 'a production pair must have peers: minPeers 0 is for labelled fixtures only');
  let id = 0;
  async function rpc(method, params = []) {
    const r = await fetch(el, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`execution ${method}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`execution ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
  }
  async function beacon(path) {
    const r = await fetch(cl + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`consensus ${path}: HTTP ${r.status}`);
    return (await r.json()).data;
  }

  /** -> {ok, checks: [{name, ok, detail}], head, finalized, safe} (finalized = the PAIRED finalized execution block) */
  async function readiness() {
    const checks = [];
    const chk = async (name, fn) => { try { const d = await fn(); checks.push({ name, ok: true, detail: d }); return true; } catch (e) { checks.push({ name, ok: false, detail: String(e.message || e) }); return false; } };
    const need = (c, msg) => { if (!c) throw new Error(msg); };
    let head, fin, safe, clFin;
    await chk('el.chain', async () => { const c = await rpc('eth_chainId'); need(c === identity.chainIdHex, `chain ${c}`); return c; });
    await chk('el.genesis', async () => { const g = await rpc('eth_getBlockByNumber', ['0x' + (identity.genesisNumber ?? 0).toString(16), false]); need(g?.hash === identity.elGenesisHash, `genesis ${g?.hash}`); return g.hash; });
    await chk('el.syncing', async () => { const s = await rpc('eth_syncing'); need(s === false, 'eth_syncing is not false'); return false; });
    await chk('el.peers', async () => { if (minPeers === 0) return 'skipped (labelled fixture, minPeers 0)'; const p = num(await rpc('net_peerCount')); need(p >= minPeers, `${p} peers`); return p; });
    await chk('el.head', async () => { head = await rpc('eth_getBlockByNumber', ['latest', false]); const lag = now() - num(head.timestamp); need(lag <= maxHeadLagSec, `head lag ${lag} s`); return num(head.number); });
    await chk('el.finalized', async () => { fin = await rpc('eth_getBlockByNumber', ['finalized', false]); need(fin, 'no finalized block'); const lag = now() - num(fin.timestamp); need(lag <= maxFinalizedLagSec, `finalized lag ${lag} s`); return num(fin.number); });
    await chk('el.safe', async () => { safe = await rpc('eth_getBlockByNumber', ['safe', false]); need(safe, 'no safe block'); return num(safe.number); });
    await chk('cl.genesis', async () => { const g = await beacon('/eth/v1/beacon/genesis'); need(g.genesis_validators_root === identity.clGenesisValidatorsRoot, 'genesis_validators_root differs'); return true; });
    await chk('cl.syncing', async () => { const d = await beacon('/eth/v1/node/syncing'); need(d.is_syncing === false && d.is_optimistic === false && d.el_offline === false, `syncing=${d.is_syncing} optimistic=${d.is_optimistic} el_offline=${d.el_offline}`); return num(d.head_slot); });
    await chk('cl.peers', async () => { const d = await beacon('/eth/v1/node/peer_count'); need(num(d.connected) >= minPeers, `${d.connected} peers`); return num(d.connected); });
    await chk('pair.finalized', async () => {
      const b = await beacon('/eth/v2/beacon/blocks/finalized');
      const pl = b.message.body.execution_payload;
      clFin = { number: num(pl.block_number), hash: pl.block_hash, slot: num(b.message.slot) };
      const at = await rpc('eth_getBlockByNumber', ['0x' + clFin.number.toString(16), false]);
      need(at?.hash === clFin.hash, 'the beacon finalized payload is not the execution block at that height');
      need(fin && fin.hash === clFin.hash, 'the execution node\'s finalized block is not the beacon node\'s finalized payload');
      return clFin;
    });
    await chk('pair.head', async () => {
      const b = await beacon('/eth/v2/beacon/blocks/head');
      const pl = b.message.body.execution_payload;
      const at = await rpc('eth_getBlockByNumber', ['0x' + num(pl.block_number).toString(16), false]);
      need(at?.hash === pl.block_hash, 'the beacon head payload is not the execution block at that height');
      return num(pl.block_number);
    });
    const ok = checks.every((c) => c.ok);
    return { ok, checks, head: head && { number: num(head.number), hash: head.hash, timestamp: num(head.timestamp) },
      finalized: ok ? { number: clFin.number, hash: clFin.hash, slot: clFin.slot } : null, safe: safe && { number: num(safe.number), hash: safe.hash } };
  }
  async function readyOrRefuse() {
    const r = await readiness();
    if (!r.ok) refuse('l1-source-not-ready', r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; '));
    return r;
  }
  const sourceId = { execution: el, consensus: cl, identity: identity.label ?? 'custom' };

  /**
   * The L1 receipt of `txHash`, its block bound by hash and canonical at its number, with finality from the paired
   * finalized checkpoint. -> {state: 'pending'} | {state: 'included', receipt, evidence}
   */
  async function receipt(txHash) {
    const r0 = await readyOrRefuse();
    const raw = await rpc('eth_getTransactionReceipt', [txHash]);
    if (!raw) return { state: 'pending', readiness: r0 };
    if (raw.transactionHash?.toLowerCase() !== String(txHash).toLowerCase()) refuse('l1-receipt-mismatch', 'the node answered another transaction');
    const tx = await rpc('eth_getTransactionByHash', [txHash]);
    if (!tx || tx.blockHash !== raw.blockHash || tx.hash?.toLowerCase() !== raw.transactionHash.toLowerCase()) refuse('l1-receipt-mismatch', 'transaction not bound to the receipt\'s block');
    const block = await rpc('eth_getBlockByHash', [raw.blockHash, false]);
    if (!block || block.hash !== raw.blockHash || block.number !== raw.blockNumber) refuse('l1-receipt-mismatch', 'receipt block not served by hash');
    if (!(block.transactions ?? []).map((t) => (typeof t === 'string' ? t : t.hash).toLowerCase()).includes(raw.transactionHash.toLowerCase())) refuse('l1-receipt-mismatch', 'the block does not list the transaction');
    // re-read readiness and the canonical hash AFTER the receipt: a reorg in between is refused, not reported
    const r1 = await readyOrRefuse();
    const canon = await rpc('eth_getBlockByNumber', [raw.blockNumber, false]);
    if (canon?.hash !== raw.blockHash) refuse('l1-not-canonical', 'the receipt\'s block is no longer canonical (reorg)');
    if (r1.finalized.number < r0.finalized.number) refuse('l1-source-regressed', 'finalized checkpoint went backwards');
    const n = num(raw.blockNumber);
    const receiptOut = formatTransactionReceipt(raw);
    const evidence = mint({ kind: 'l1-receipt', verifiedBy: 'l1-local-validated-pair', trust, source: sourceId, txHash: raw.transactionHash, blockHash: raw.blockHash, blockNumber: n,
      finalized: n <= r1.finalized.number, safe: !!r1.safe && n <= r1.safe.number, finalizedCheckpoint: r1.finalized, readAt: now(), receipt: receiptOut,
      transaction: { from: getAddress(tx.from), to: tx.to ? getAddress(tx.to) : null, nonce: Number(BigInt(tx.nonce)) },
      headerHash: raw.blockHash });
    return { state: 'included', receipt: evidence.receipt, evidence };   // the frozen, owned receipt: identity checks hold
  }

  /** The portal pin facts at the paired FINALIZED block (EIP-1967 implementation slot + version()), minted. */
  async function portalSnapshot(portal) {
    const r = await readyOrRefuse();
    const at = { blockHash: r.finalized.hash };
    const implWord = await rpc('eth_getStorageAt', [portal, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', at]);
    const verRaw = await rpc('eth_call', [{ to: portal, data: '0x54fd4d50' }, at]);
    const len = Number(BigInt(slice(verRaw, 32, 64))), version = Buffer.from(slice(verRaw, 64, 64 + len).slice(2), 'hex').toString('utf8');
    return mint({ kind: 'l1-portal', verifiedBy: 'l1-local-validated-pair', trust, source: sourceId, head: { number: r.finalized.number, hash: r.finalized.hash, verifiedBy: 'l1-local-validated-pair' },
      portal: getAddress(portal), implementation: getAddress(slice(implWord, 12)), version });
  }

  /** An L1 block's standing (for the Base adapter's L1-view check): canonical hash at `number`, and whether final. */
  async function blockStanding(number, hash) {
    const r = await readyOrRefuse();
    const b = await rpc('eth_getBlockByNumber', ['0x' + Number(number).toString(16), false]);
    return { canonical: b?.hash === hash, finalized: b?.hash === hash && Number(number) <= r.finalized.number, finalizedCheckpoint: r.finalized };
  }
  return { readiness, receipt, portalSnapshot, blockStanding, trust, source: sourceId };
}
