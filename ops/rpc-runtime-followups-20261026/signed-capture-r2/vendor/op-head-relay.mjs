// A loopback head source for the Helios OP-stack verifier (network/helios-verifier.mjs), fed by UNTRUSTED commitment
// sources. It speaks Helios's consensus API (GET /latest -> SequencerCommitment JSON or null, GET /chain_id), the same API
// Helios's own opstack-server serves, so Helios 0.12.0 (a16z/helios 2af9b418) is pointed at it with --consensus-rpc.
//
// What a commitment is: the OP-stack gossip message for one unsafe L2 block, `signature(65) || parentBeaconRoot(32) ||
// SSZ ExecutionPayload`, signed by the chain's unsafe-block signer over keccak256(0^32 || chainId || keccak256(data))
// (helios opstack/src/lib.rs signature_msg). It proves the SEQUENCER said "block N has this hash and state root". It is
// NOT L1-safe or finalized: one sequencer can equivocate, reorg unsafe blocks or withhold. Nothing here claims more.
//
// Why a relay and not Helios alone: Helios takes ONE consensus URL and accepts any validly signed commitment whose number
// is higher than the last, however old (opstack/src/consensus.rs advance: age is only logged). This relay
//   * polls several sources (Enclave-hosted opstack-server replicas, operator-chosen sources; none is built in),
//   * keeps only commitments that recover to the PINNED signer for the PINNED chain (viem recoverAddress; Helios verifies
//     the same signature again - this check only stops a source steering Helios at a block it would reject),
//   * serves the highest such block, and nothing at all once that block is older than maxAgeMs (Helios then makes no
//     progress and every consumer read fails its own freshness check - fail-closed, never a stale answer),
//   * stops serving a height at which two different signed blocks were seen (sequencer equivocation) until a strictly
//     higher block arrives, and records it.
// Sources are untrusted: a lying source costs nothing but its own poll. The relay never fetches anything else.
import http from 'node:http';
import { concat, hexToBytes, keccak256, numberToHex, pad, recoverAddress, toHex } from 'viem';
import { rpcEndpoint, rpcLabel } from './rpc-identity.mjs';

/** The Base mainnet values Helios 0.12.0 ships (opstack/src/config.rs). The signer is a pin, not an L1-verified value:
 *  Helios's verify_unsafe_signer path defaults off and needs a consensus route opstack-server does not serve. */
export const BASE_MAINNET = Object.freeze({ chainId: 8453, unsafeSigner: '0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a',
  systemConfig: '0x73a79fab69143498ed3712e519a88a918e1f4072', source: 'a16z/helios 0.12.0 opstack/src/config.rs' });

const ADDR = /^0x[0-9a-fA-F]{40}$/, WORD = /^0x[0-9a-fA-F]{1,64}$/;
// ExecutionPayload SSZ fixed part as Helios decodes it (opstack/src/types.rs, the Isthmus/V4 layout): byte offsets inside
// the payload, which follows the 32-byte parentBeaconRoot in the signed data.
const PAYLOAD_FIXED = 560, AT = { parentHash: 0, stateRoot: 52, blockNumber: 404, timestamp: 428, blockHash: 472 };
const MAX_DATA = 4 * 1024 * 1024;

const u64 = (b, at) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[at + i]); return v; };
const hex = (b) => toHex(b);

/** The digest the unsafe signer signs for `data` on `chainId`. */
export function commitmentDigest(data, chainId) {
  return keccak256(concat([pad('0x', { size: 32 }), pad(numberToHex(BigInt(chainId)), { size: 32 }), keccak256(data)]));
}

/** {number, timestamp (s), hash, stateRoot, parentHash} read from the signed data's fixed fields, bounds-checked. */
export function payloadHead(data) {
  const b = hexToBytes(data);
  if (b.length < 32 + PAYLOAD_FIXED || b.length > MAX_DATA) throw new Error('commitment payload has the wrong size');
  const p = 32;
  return { number: u64(b, p + AT.blockNumber), timestamp: u64(b, p + AT.timestamp), hash: hex(b.subarray(p + AT.blockHash, p + AT.blockHash + 32)),
    stateRoot: hex(b.subarray(p + AT.stateRoot, p + AT.stateRoot + 32)), parentHash: hex(b.subarray(p + AT.parentHash, p + AT.parentHash + 32)) };
}

const u32 = (b, at) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] * 2 ** 24);
/** The payload's raw transactions (SSZ list of variable-size items between the transactions and withdrawals offsets). */
export function payloadTransactions(data) {
  const b = hexToBytes(data), p = 32;
  if (b.length < p + PAYLOAD_FIXED) throw new Error('commitment payload has the wrong size');
  const len = b.length - p, start = u32(b, p + 504), end = u32(b, p + 508), extra = u32(b, p + 436);
  if (extra !== PAYLOAD_FIXED || start < extra || start > end || end > len) throw new Error('commitment payload offsets are malformed');
  const list = b.subarray(p + start, p + end);
  if (!list.length) return [];
  const first = u32(list, 0);
  if (first % 4 || first > list.length || first === 0) throw new Error('commitment transaction list is malformed');
  const offs = []; for (let i = 0; i < first; i += 4) offs.push(u32(list, i));
  offs.push(list.length);
  const txs = [];
  for (let i = 0; i + 1 < offs.length; i++) {
    if (offs[i + 1] < offs[i] || offs[i] < first) throw new Error('commitment transaction list is malformed');
    if (offs[i + 1] === offs[i]) throw new Error('commitment carries an empty transaction');
    txs.push(list.subarray(offs[i], offs[i + 1]));
  }
  return txs;
}
// EIP-2718 types the PINNED verifier decodes (op-alloy-consensus 2.0.0 OpTxEnvelope: legacy, 0x01, 0x02, 0x04, deposit
// 0x7E, post-exec 0x7D). Helios's payload_to_block unwrap()s that decode, so a commitment carrying any other type (Base's
// EIP-8130 0x79, gated behind the not-yet-scheduled Everest fork at base/base 5476069f) would panic the verifier process;
// such a commitment is refused here instead. 0x7D is an OP type Base does not use; it is refused too (not a Base type).
export const VERIFIER_TX_TYPES = Object.freeze([0x01, 0x02, 0x04, 0x7e]);
/** The first unsupported transaction type byte in a commitment, or null. Legacy txs start with an RLP list byte >= 0xc0. */
export function unsupportedTxType(data, allowed = VERIFIER_TX_TYPES) {
  for (const tx of payloadTransactions(data)) if (tx[0] < 0xc0 && !allowed.includes(tx[0])) return tx[0];
  return null;
}

/** A SequencerCommitment as JSON ({data, signature:{r,s,yParity|v}}) -> the canonical form this relay serves. */
export function normalizeCommitment(c) {
  if (!c || typeof c !== 'object' || typeof c.data !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(c.data) || c.data.length > 2 + 2 * MAX_DATA) throw new Error('malformed commitment');
  const s = c.signature;
  if (!s || typeof s !== 'object' || !WORD.test(String(s.r)) || !WORD.test(String(s.s))) throw new Error('malformed commitment signature');
  let y = s.yParity ?? s.v;
  y = typeof y === 'string' ? Number(BigInt(y)) : Number(y);
  if (y === 27 || y === 28) y -= 27;
  if (y !== 0 && y !== 1) throw new Error('malformed commitment signature parity');
  return { data: c.data.toLowerCase(), signature: { r: pad(String(s.r).toLowerCase(), { size: 32 }), s: pad(String(s.s).toLowerCase(), { size: 32 }), yParity: numberToHex(y) } };
}

/** Verify a commitment against the pinned chain and signer. -> {commitment (canonical), head} or throws. */
export async function verifyCommitment(raw, { chainId, signer }) {
  const commitment = normalizeCommitment(raw);
  const head = payloadHead(commitment.data);
  const { r, s, yParity } = commitment.signature;
  const who = await recoverAddress({ hash: commitmentDigest(commitment.data, chainId), signature: { r, s, yParity: Number(yParity) } });
  if (who.toLowerCase() !== signer) throw new Error('commitment is not signed by the pinned unsafe signer');
  return { commitment, head };
}

function validateConfig({ sources, chainId, signer, maxAgeMs, pollMs, timeoutMs }) {
  if (!Array.isArray(sources) || sources.length > 16) throw new Error('0 to 16 commitment sources');
  const ids = sources.map((u) => rpcEndpoint(u).identity);   // https, or plain http on loopback only; no credentials
  if (new Set(ids).size !== ids.length) throw new Error('commitment sources must be distinct endpoints');
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('chain id required');
  if (!ADDR.test(signer || '') || /^0x0{40}$/i.test(signer)) throw new Error('unsafe signer address required');
  for (const [k, v, lo, hi] of [['maxAgeMs', maxAgeMs, 1000, 600000], ['pollMs', pollMs, 100, 60000], ['timeoutMs', timeoutMs, 100, 30000]])
    if (!Number.isSafeInteger(v) || v < lo || v > hi) throw new Error(`invalid ${k}`);
}

/**
 * sources: base URLs of untrusted Helios-consensus-API servers (each read as <base>/latest). Empty is allowed (offer()
 * still feeds the relay; e.g. a future gossip listener in this process). -> relay with offer(), latest(), status(),
 * poll(), listen(port) (127.0.0.1 only) and close().
 */
export function createHeadRelay({ sources = [], chainId, signer, maxAgeMs = 60000, pollMs = 1000, timeoutMs = 2000, fetch = globalThis.fetch, now = Date.now } = {}) {
  validateConfig({ sources, chainId, signer, maxAgeMs, pollMs, timeoutMs });
  const pinned = signer.toLowerCase();
  let best = null, server = null, timer = null, polling = null;
  const seen = new Map();            // number -> first verified hash at that height (recent heights only)
  const equivocations = [];          // [{number, hashes}]
  const unsupported = [];            // [{number, type}]: signed blocks refused for a transaction type the verifier cannot decode
  let blockedAt = null;               // a height with two signed blocks: nothing at or below it is served
  const perSource = new Map(sources.map((u) => [u, { label: rpcLabel(u), ok: 0, rejected: 0, failed: 0, last: null }]));

  const fresh = (head) => Number(head.timestamp) * 1000 + maxAgeMs > now() && Number(head.timestamp) * 1000 <= now() + 5000;
  async function offer(raw, from = 'offer') {
    const v = await verifyCommitment(raw, { chainId, signer: pinned });
    // a block the pinned verifier cannot decode is never handed to it (Helios 0.12.0 would abort on it)
    const bad = unsupportedTxType(v.commitment.data);
    if (bad !== null) { unsupported.push({ number: String(v.head.number), type: '0x' + bad.toString(16).padStart(2, '0'), from }); if (unsupported.length > 8) unsupported.shift(); return { accepted: false, reason: 'unsupported transaction type 0x' + bad.toString(16).padStart(2, '0') }; }
    const n = v.head.number;
    const prior = seen.get(n);
    if (prior && prior !== v.head.hash) {
      equivocations.push({ number: String(n), hashes: [prior, v.head.hash], from });
      if (blockedAt === null || n > blockedAt) blockedAt = n;
      if (best && best.head.number <= n) best = null;
      return { accepted: false, reason: 'equivocation' };
    }
    if (!prior) { seen.set(n, v.head.hash); if (seen.size > 512) seen.delete(seen.keys().next().value); }
    if (blockedAt !== null && n <= blockedAt) return { accepted: false, reason: 'at or below an equivocated height' };
    if (!fresh(v.head)) return { accepted: false, reason: 'stale or future block' };
    if (!best || n > best.head.number) best = { ...v, from };
    return { accepted: true, number: n };
  }
  async function pollOne(url) {
    const st = perSource.get(url);
    try {
      const r = await fetch(new URL('latest', url.endsWith('/') ? url : url + '/'), { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const text = await r.text();
      if (text.length > 2 + 2 * MAX_DATA + 4096) throw new Error('response too large');
      const body = JSON.parse(text);
      if (body === null) { st.last = 'no commitment'; return; }
      const out = await offer(body, st.label);
      if (out.accepted) st.ok++; else st.rejected++;
      st.last = out.accepted ? 'accepted ' + out.number : out.reason;
    } catch (e) { st.failed++; st.last = String(e?.message || e).slice(0, 160); }
  }
  const poll = () => (polling ||= Promise.allSettled(sources.map(pollOne)).finally(() => { polling = null; }));
  /** The commitment to serve now, or null (none, stale, or equivocated). */
  function latest() {
    if (!best || !fresh(best.head)) return null;
    if (blockedAt !== null && best.head.number <= blockedAt) return null;
    return best.commitment;
  }
  function status() {
    const head = best && latest() ? { number: String(best.head.number), hash: best.head.hash, stateRoot: best.head.stateRoot, timestamp: Number(best.head.timestamp), from: best.from } : null;
    return { trust: 'op-sequencer-signed-unsafe-head', chainId, signer: pinned, maxAgeMs, head, equivocations: equivocations.slice(-8), unsupported: unsupported.slice(),
      sources: [...perSource.values()].map((s) => ({ ...s })) };
  }
  function handler(req, res) {
    const path = new URL(req.url, 'http://relay').pathname;
    if (req.method !== 'GET' || !['/latest', '/chain_id'].includes(path)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(path === '/chain_id' ? chainId : latest()));
  }
  async function listen(port = 0) {
    server = http.createServer(handler);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    if (sources.length) { await poll(); timer = setInterval(poll, pollMs); timer.unref?.(); }
    return `http://127.0.0.1:${server.address().port}/`;
  }
  async function close() {
    clearInterval(timer); timer = null;
    await polling?.catch(() => {});
    if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(() => r())); server = null; }
  }
  return { offer, poll, latest, status, handler, listen, close };
}
