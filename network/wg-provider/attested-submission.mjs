// A PAID provider's on-chain sends (EnclaveConnectivity setHost and qualify, network/onchain-qualification.mjs) under
// chainAuthority "attested-verifier" (attested-authority.mjs). The authority stays ONE: the attested remote verifier
// (network/attested-verifier-client.mjs: execution inside a SEV-SNP-attested measured guest, labelled attested-verifier,
// localProof false, the sequencer-signed unsafe tier, no finality, replicas by failover - never a quorum). It answers every
// contract read, the simulation, the gas search, the account's nonce and balance, and every receipt.
// The operator's OWN Base node (cfg.txBackend: a loopback or private IPv4 literal, network/chain-authority.mjs
// checkOwnBackend) is asked only what no proof can answer, and is never evidence:
//   eth_chainId + eth_getBlockByNumber   its BINDING to the verifier: the same chain, the same hash at the verifier's head
//   eth_getTransactionCount(pending)     the pending-pool hint (must equal the proven nonce: see below)
//   eth_maxPriorityFeePerGas             the tip hint (capped)
//   eth_sendRawTransaction               submission, only after the binding, of bytes signed once
// A hash it returns is a submission acknowledgement, not inclusion, and a pool is not inclusion: a send counts only by a
// receipt the attested verifier answers (a reverted receipt is a revert). Nothing is sent through any other server, and
// without a valid own backend nothing is sent at all (attested-authority.mjs refuses the configuration).
//
// Gates BEFORE anything is signed (a refusal leaves nothing signed, recorded or sent): the verifier's head is fresh
// (at most 60 s old, not ahead of this clock); the backend is bound to it; the proven nonce equals the backend's pending
// nonce (a pool with this key's transactions this provider has no record of, or a pool behind the chain, refuses); the
// call succeeds in a verified execution at the head; a gas limit at which a verified execution succeeds is within maxGas;
// the fees are within the caps; the proven balance covers gas x max fee.
//
// Exact-bytes retry (the lease relay's rule, client/lease-executor-client.mjs): the signed transaction {nonce, raw, hash}
// is written strictly (temp, fsync, rename, directory fsync) BEFORE its broadcast. While it is unresolved nothing new is
// signed: those same bytes are re-broadcast (after the binding again), never re-signed, also after a restart. It is
// resolved only from the verifier: its receipt (success or revert), or the proven nonce past it with no receipt shown
// ("nonce consumed": not landed by this send; the next round decides again from verified contract state). NO backend answer
// resolves it - not even a "definite" refusal of the first broadcast (an untrusted backend may forward the bytes and then
// answer "insufficient funds"): a refusal is reported as refused, never as "nothing pending", and the bytes stay recorded.
// So a send the chain really cannot take (e.g. too little ETH for its fee) holds the record by design until it is reconciled
// by hand WITHOUT deleting the record: fund the key (the next re-broadcast of the same bytes can land), or consume that nonce
// with another transaction of the operator key - either way the attested verifier then proves the resolution.
//
// Every backend answer is checked strictly (backendCaller): JSON-RPC 2.0, exactly the request's id, exactly one of result
// or a well-formed error, canonical quantities. Anything else is "unavailable" (no answer), never evidence of anything.
import fs from 'node:fs';
import path from 'node:path';
import { encodeFunctionData, keccak256, parseTransaction, recoverTransactionAddress, getAddress, stringify } from 'viem';
import { checkOwnBackend } from '../chain-authority.mjs';
import { createVerifiedSnapshot, verifierEndpoint, verifiedHeader } from '../verified-chain.mjs';
import { strictWriteFile } from '../lease-release-journal.mjs';

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, status: 503, ...extra });
const hex = (n) => '0x' + BigInt(n).toString(16);
const lc = (s) => String(s).toLowerCase();
const HASH = /^0x[0-9a-f]{64}$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GWEI = 1_000_000_000n;
export const TX_BACKEND_DEFAULTS = Object.freeze({ maxFeePerGasWei: String(1n * GWEI), maxPriorityFeePerGasWei: String(GWEI / 100n), maxGas: 300_000 });
// the own backend's methods, and nothing else is ever sent to it
export const TX_BACKEND_USE = Object.freeze(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionCount(pending)', 'eth_maxPriorityFeePerGas', 'eth_sendRawTransaction']);

/** cfg.txBackend = { url (loopback or private IPv4 literal), maxFeePerGasWei?, maxPriorityFeePerGasWei? (decimal strings), maxGas? } */
export function providerTxBackend(raw) {
  const bad = (m) => { throw new Error(`provider chain authority: txBackend: ${m}`); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('{ url, maxFeePerGasWei?, maxPriorityFeePerGasWei?, maxGas? } is required');
  for (const k of Object.keys(raw)) if (!['url', 'maxFeePerGasWei', 'maxPriorityFeePerGasWei', 'maxGas'].includes(k)) bad(`unknown field ${k}`);
  let own; try { own = checkOwnBackend(raw.url); } catch (e) { bad(`url: ${e.message.replace(/^ENCLAVE_CHAIN_TX_BACKEND: /, '')}`); }
  const wei = (k) => {
    const v = raw[k] ?? TX_BACKEND_DEFAULTS[k];
    if (typeof v !== 'string' || !/^[1-9][0-9]{0,30}$/.test(v)) bad(`${k} must be a positive decimal string (wei)`);
    return BigInt(v);
  };
  const maxFeePerGas = wei('maxFeePerGasWei'), maxPriorityFeePerGas = wei('maxPriorityFeePerGasWei');
  if (maxPriorityFeePerGas > maxFeePerGas) bad('maxPriorityFeePerGasWei exceeds maxFeePerGasWei');
  const maxGas = raw.maxGas ?? TX_BACKEND_DEFAULTS.maxGas;
  if (!Number.isSafeInteger(maxGas) || maxGas < 21_000 || maxGas > 30_000_000) bad('maxGas must be an integer from 21000 to 30000000');
  return Object.freeze({ url: own.url, label: own.label, scope: own.scope, caps: Object.freeze({ maxFeePerGas, maxPriorityFeePerGas, maxGas: BigInt(maxGas) }) });
}

const MAX_RESPONSE = 1 << 20;
const QTY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/;
/** A canonical JSON-RPC quantity (lowercase hex, no leading zeros, at most 256 bits) -> bigint; anything else throws `code`. */
export function quantity(x, what, code = 'chain_unconfirmed') {
  if (typeof x !== 'string' || !QTY.test(x)) throw fail(code, `${what}: not a canonical quantity (${String(x).slice(0, 40)})`, { unavailable: true });
  return BigInt(x);
}
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/**
 * One JSON-RPC call to the own backend: bounded, no redirects. The answer must be ONE JSON-RPC 2.0 response object with
 * EXACTLY this request's id and exactly one of `result` or a well-formed `error` ({code: integer, message: string}).
 * A transport failure or any other answer (a batch, a wrong or retyped id, both or neither member, a malformed error) is
 * `chain_backend_unavailable`: no answer at all, never evidence. A well-formed JSON-RPC error keeps its words.
 */
export function backendCaller(url, label, timeoutMs, fetchImpl = globalThis.fetch) {
  let next = 0;
  return async (method, params) => {
    const id = ++next;
    let r;
    try { r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stringify({ jsonrpc: '2.0', id, method, params }), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw fail('chain_backend_unavailable', `own backend ${label} unreachable: ${String(e?.message || e).slice(0, 200)}`, { unavailable: true }); }
    let text;
    try {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (Number(r.headers.get('content-length') || 0) > MAX_RESPONSE) throw new Error('response too large');
      const chunks = []; let n = 0;
      for await (const c of r.body) { n += c.length; if (n > MAX_RESPONSE) throw new Error('response too large'); chunks.push(c); }
      text = Buffer.concat(chunks).toString('utf8');
    } catch (e) { throw fail('chain_backend_unavailable', `own backend ${label}: ${String(e?.message || e).slice(0, 200)}`, { unavailable: true }); }
    const bad = (why) => fail('chain_backend_unavailable', `own backend ${label}: ${method}: ${why} (not an answer)`, { unavailable: true, malformed: true });
    let j; try { j = JSON.parse(text); } catch { throw bad('not JSON'); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw bad('not one JSON-RPC response object');
    if (j.jsonrpc !== '2.0') throw bad('not JSON-RPC 2.0');
    if (!hasOwn(j, 'id') || j.id !== id) throw bad(`answer for id ${JSON.stringify(j.id)?.slice(0, 40)}, not this request's ${id}`);
    if (hasOwn(j, 'result') === hasOwn(j, 'error')) throw bad('not exactly one of result or error');
    if (hasOwn(j, 'error')) {
      const e = j.error;
      if (!e || typeof e !== 'object' || Array.isArray(e) || !Number.isSafeInteger(e.code) || typeof e.message !== 'string') throw bad('malformed error object');
      throw fail('chain_backend_error', `own backend ${label}: ${e.message.slice(0, 300)}`, { rpcMessage: e.message });
    }
    return j.result;
  };
}

// classification of a backend refusal for the logs and the caller's error only: it never resolves or clears anything
const definiteRejection = (m) => /insufficient funds|intrinsic gas|exceeds block gas|invalid sender|invalid signature|max fee per gas less than block base fee|fee cap|transaction type not supported/i.test(m);
const alreadyKnown = (m) => /already known|known transaction|already imported/i.test(m);

/** The send record: EXACTLY {} or {nonce, raw, hash} with hash = keccak256(raw) (the lease relay's format). Anything else throws. */
export function parseSendRecord(text, where) {
  const bad = (why) => { throw new Error(`${where}: not a provider send record (${why}); settle it by hand`); };
  let j; try { j = JSON.parse(text); } catch { bad('not JSON'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) bad('not an object');
  const keys = Object.keys(j).sort().join(',');
  if (keys === '') return null;
  if (keys !== 'hash,nonce,raw') bad(`fields ${keys.slice(0, 80)}`);
  if (!Number.isSafeInteger(j.nonce) || j.nonce < 0) bad('nonce');
  if (typeof j.raw !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(j.raw)) bad('raw');
  if (typeof j.hash !== 'string' || !HASH.test(j.hash) || keccak256(j.raw) !== lc(j.hash)) bad('hash');
  return j;
}
export const SEND_RECORD_MAX_BYTES = 64 * 1024;

/**
 * createAttestedSubmitter({verifier, backend (providerTxBackend), account, stateFile, chainId, ...})
 *   .client   { readContract, waitForTransactionReceipt }   for onchain-qualification.mjs (verifier answers only)
 *   .wallet   { account, writeContract }                    gated, signed once, recorded, submitted to the bound backend
 *   .settle() resolves this key's unresolved send first (re-broadcast as the same bytes while unresolved: throws tx_unresolved)
 *   .pending() the unresolved {nonce, hash} or null;  .describe() labels for logs and status
 */
export function createAttestedSubmitter({ verifier, backend, account, stateFile, chainId = 8453, maxHeadAgeMs = 60_000, futureSkewMs = 5_000,
  timeoutMs = 15_000, receiptPollMs = 1_000, fetch: fetchImpl = globalThis.fetch, now = Date.now, log = () => {} } = {}) {
  const v = verifierEndpoint(verifier);
  if (!v.attested) throw new Error('attested submission needs the attested verifier client (a plain or local endpoint is not that authority)');
  if (!backend?.url || !backend.caps) throw new Error('attested submission needs the own transaction backend (providerTxBackend): nothing is sent without it');
  if (!account?.address || typeof account.signTransaction !== 'function') throw new Error('attested submission needs the operator account');
  if (typeof stateFile !== 'string' || !path.isAbsolute(stateFile)) throw new Error('attested submission needs an absolute stateFile (its durable send record)');
  const from = getAddress(account.address), caps = backend.caps;
  const V = (method, params = []) => v.request(method, params, timeoutMs);
  const B = backendCaller(backend.url, backend.label, timeoutMs, fetchImpl);
  const snapshot = createVerifiedSnapshot({ verifier, chainId, confirmations: 0, maxBlockAgeMs: 90_000, futureSkewMs, deadlineMs: Math.max(1000, timeoutMs * 2), now });
  const evidence = Object.freeze({ authority: 'attested-verifier', localProof: false, tier: 'unsafe', finality: 'none', replicaQuorum: false, verifier: v.label });

  // ---- the durable record: loaded (and checked to be THIS key's own transaction on this chain) before any send --------------
  let rec = null;
  const ready = (async () => {
    let st = null;
    try { st = fs.lstatSync(stateFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!st) return;
    if (!st.isFile() || st.size > SEND_RECORD_MAX_BYTES) throw new Error(`${stateFile}: not a provider send record (a regular file of at most ${SEND_RECORD_MAX_BYTES} bytes); settle it by hand`);
    const j = parseSendRecord(fs.readFileSync(stateFile, 'utf8'), stateFile);
    if (!j) return;
    const bad = (why) => { throw new Error(`${stateFile}: not this provider's send record (${why}); settle it by hand`); };
    let tx; try { tx = parseTransaction(j.raw); } catch { bad('not a signed transaction'); }
    if (tx.chainId !== chainId || tx.nonce !== j.nonce) bad(`chain ${tx.chainId}, nonce ${tx.nonce}`);
    const signer = await recoverTransactionAddress({ serializedTransaction: j.raw }).catch(() => bad('no recoverable signature'));
    if (getAddress(signer) !== from) bad('signed by another key');
    rec = j;
    log(`[attested-submission] unresolved send ${j.hash} (nonce ${j.nonce}) restored: re-broadcast as the same bytes until the verifier resolves it`);
  })();
  ready.catch(() => {});
  const setRecord = (x) => { strictWriteFile(stateFile, JSON.stringify(x || {})); rec = x; };
  let queue = Promise.resolve();
  const serial = (fn) => { const p = queue.then(async () => { await ready; return fn(); }); queue = p.catch(() => {}); return p; };

  // The pinned Helios can name a head (eth_blockNumber) or a receipt's block before its header path holds that block: it then
  // refuses the header with "block N is outside EIP-2935 ring buffer range (latest: M ...)", M < N (measured on the real
  // runtime, p4/b1). Only THAT refusal, for exactly the block asked, is read as "not there yet" ({behind: M}); every other
  // failure propagates.
  const AHEAD = /block (\d+) is outside EIP-2935 ring buffer range \(latest: (\d+)/;
  async function headerAt(n) {
    try { return await V('eth_getBlockByNumber', [hex(n), false]); }
    catch (e) { const m = AHEAD.exec(String(e?.message)); if (m && BigInt(m[1]) === n && BigInt(m[2]) < n) return { behind: BigInt(m[2]) }; throw e; }
  }
  // ---- the verifier's head, fresh; the backend bound to it ------------------------------------------------------------------
  async function head({ fresh = true } = {}) {
    const id = quantity(await V('eth_chainId'), 'the attested verifier\'s chain id');
    if (id !== BigInt(chainId)) throw fail('chain_wrong_network', `the attested verifier follows chain ${id}, not ${chainId}`);
    let n = quantity(await V('eth_blockNumber'), 'the attested verifier\'s head');
    let block = await headerAt(n);
    if (block?.behind !== undefined) {                       // its header path is one step behind: use ITS latest, once
      n = block.behind; block = await headerAt(n);
      if (block?.behind !== undefined) throw fail('chain_unconfirmed', `the attested verifier has no header for its head ${n}`);
    }
    const h = verifiedHeader(block, n);
    if (fresh) {
      if (h.timestamp > now() + futureSkewMs) throw fail('chain_future', 'the attested verifier\'s head is ahead of this host\'s clock');
      if (now() - h.timestamp > maxHeadAgeMs) throw fail('chain_stale', `the attested verifier's head is ${Math.round((now() - h.timestamp) / 1000)} s old (more than ${Math.round(maxHeadAgeMs / 1000)} s)`);
    }
    return { ...h, baseFeePerGas: block.baseFeePerGas };
  }
  async function bind(h) {
    const id = quantity(await B('eth_chainId', []), 'the own backend\'s chain id', 'chain_backend_unavailable');
    if (id !== BigInt(chainId)) throw fail('chain_backend_wrong_chain', `the own backend ${backend.label} follows chain ${id}, not ${chainId}`);
    const bb = await B('eth_getBlockByNumber', [hex(h.number), false]);
    if (bb !== null && (typeof bb !== 'object' || Array.isArray(bb) || !HASH.test(String(bb.hash)))) throw fail('chain_backend_unavailable', `the own backend ${backend.label} answered a malformed block ${h.number}`, { unavailable: true });
    if (!bb?.hash) throw fail('chain_backend_behind', `the own backend ${backend.label} has no block ${h.number} (behind the attested verifier's head)`);
    if (lc(bb.hash) !== h.hash) throw fail('chain_backend_unbound', `the own backend ${backend.label} has another block ${h.number} than the attested verifier: not submitting through it`);
  }
  const gate = async (what) => {
    try { const h = await head(); await bind(h); return h; }
    catch (e) { throw Object.assign(e?.code ? e : fail('chain_unavailable', String(e?.message || e).slice(0, 300)), { message: `${what} not done: ${e?.message || e}` }); }
  };

  // ---- the attested verifier's receipt (never the backend's) ------------------------------------------------------------
  async function verifiedReceipt(hash) {
    let rc;
    try { rc = await V('eth_getTransactionReceipt', [hash]); }
    catch (e) {
      if (/receipt not found/i.test(String(e?.message))) return null;   // Helios: no receipt evidence (never proof of absence)
      // the pinned Helios checks a receipt against a block its header path does not hold yet: not confirmable YET (b2, real runtime)
      const m = AHEAD.exec(String(e?.message)); if (m && BigInt(m[1]) > BigInt(m[2])) return null;
      throw e;
    }
    if (!rc) return null;
    if (lc(rc.transactionHash) !== lc(hash) || !HASH.test(String(rc.blockHash)) || !['0x1', '0x0'].includes(lc(rc.status)) || (rc.from && getAddress(rc.from) !== from))
      throw fail('chain_receipt_invalid', `the attested verifier answered a receipt that is not this transaction's (${String(rc.transactionHash).slice(0, 18)})`);
    // its block must be the verifier's block at that number (a receipt off its chain is no receipt). The pinned Helios can
    // answer a receipt for a block past its own head, whose header it then refuses: not confirmable YET (no receipt, the send
    // stays unresolved) - only that case; any other failure propagates and resolves nothing.
    const n = quantity(rc.blockNumber, 'receipt block number', 'chain_receipt_invalid');
    if (n > quantity(await V('eth_blockNumber'), 'the attested verifier\'s head')) return null;
    const blk = await headerAt(n);
    if (blk?.behind !== undefined) return null;
    const b = verifiedHeader(blk, n);
    if (b.hash !== lc(rc.blockHash)) return null;
    return { status: lc(rc.status) === '0x1' ? 'success' : 'reverted', transactionHash: lc(hash), blockNumber: n, blockHash: b.hash,
      gasUsed: quantity(rc.gasUsed, 'receipt gasUsed', 'chain_receipt_invalid'), from, to: rc.to ? getAddress(rc.to) : null, logs: rc.logs || [], evidence };
  }
  const provenNonce = async (h) => {
    const n = quantity(await V('eth_getTransactionCount', [from, { blockHash: h.hash }]), 'the proven nonce');
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw fail('chain_unconfirmed', `the proven nonce ${n} is beyond a safe integer`);
    return n;
  };

  /** -> {state: 'receipt', receipt} | {state: 'nonce-consumed'} | {state: 'unresolved'} for the recorded send. */
  async function resolve(r) {
    const rc = await verifiedReceipt(r.hash);
    if (rc) { if (rec?.hash === r.hash) setRecord(null); return { state: 'receipt', receipt: rc }; }
    const h = await head({ fresh: false });
    if (await provenNonce(h) > BigInt(r.nonce)) {
      const again = await verifiedReceipt(r.hash);
      if (rec?.hash === r.hash) setRecord(null);
      if (again) return { state: 'receipt', receipt: again };
      log(`[attested-submission] nonce ${r.nonce} was consumed without a verifier-checked receipt of ${r.hash}: not landed by this send`);
      return { state: 'nonce-consumed' };
    }
    return { state: 'unresolved' };
  }

  /** -> {outcome: 'accepted' (the backend answered THIS hash or knows it) | 'rejected' (a definite refusal) | 'unknown' (no clear answer), why} */
  async function broadcast(raw, hash) {
    let r;
    try { r = await B('eth_sendRawTransaction', [raw]); }
    catch (e) {
      const m = String(e?.rpcMessage || '');
      if (e?.code === 'chain_backend_error' && alreadyKnown(m)) return { outcome: 'accepted', why: m.slice(0, 200) };
      if (e?.code === 'chain_backend_error' && definiteRejection(m)) return { outcome: 'rejected', why: m.slice(0, 200) };
      log(`[attested-submission] broadcast of ${hash}: no clear answer (${String(e?.message || e).slice(0, 200)}): it may or may not be pending`);
      return { outcome: 'unknown', why: String(e?.message || e).slice(0, 200) };
    }
    if (typeof r === 'string' && lc(r) === lc(hash)) return { outcome: 'accepted', why: null };
    log(`[attested-submission] the own backend answered another hash (${String(r).slice(0, 18)}) for ${hash}: not evidence, treated as unknown`);
    return { outcome: 'unknown', why: 'the backend answered another hash' };
  }
  const busy = (r, outcome) => fail('tx_unresolved', `transaction ${r.hash} (nonce ${r.nonce}) is unresolved (${outcome}): re-broadcast as the same bytes, never re-signed; nothing new is sent until the attested verifier shows its receipt or its nonce consumed`);
  async function rebroadcast(r) {
    await gate('re-broadcast');
    const { outcome } = await broadcast(r.raw, r.hash);
    return outcome === 'rejected' ? 'refused on re-broadcast (kept: a refusal is not proof that nothing is pending)' : `re-broadcast ${outcome}`;
  }

  // ---- pre-sign: everything a send needs, from the verifier (state) and the bound backend (pool and fee hints) ------------
  async function prepare({ to, data }) {
    const h = await gate('signing');
    const at = { blockHash: h.hash };
    const nonce = await provenNonce(h);
    const pending = quantity(await B('eth_getTransactionCount', [from, 'pending']), 'the own backend\'s pending nonce', 'chain_backend_unavailable');
    if (pending < nonce) throw fail('chain_backend_pool_behind', `the own backend's pending nonce ${pending} is below the proven nonce ${nonce}: nothing signed`);
    if (pending > nonce) throw fail('tx_foreign_pending', `the own backend's pool holds ${pending - nonce} transaction(s) of ${from} this provider has no record of (pending nonce ${pending}, proven ${nonce}): nothing signed until they resolve`);
    const call = { from, to, data };
    try { await V('eth_call', [call, at]); }
    catch (e) { throw fail('tx_simulation', `simulation at block ${h.number} refused by the attested verifier: ${String(e?.message || e).slice(0, 300)}; nothing signed`); }
    // a gas LIMIT a verified execution succeeded with (the pinned verifier's estimate is the gas USED): optimistic bound, else the cap
    const used = quantity(await V('eth_estimateGas', [call, hex(h.number)]), 'the verified gas estimate');
    const works = async (g) => { try { await V('eth_call', [{ ...call, gas: hex(g) }, at]); return true; } catch { return false; } };
    let gas = ((used * 5n) / 4n + 2300n) * 64n / 63n + 1n;
    if (gas > caps.maxGas || !(await works(gas))) gas = caps.maxGas;
    if (gas === caps.maxGas && !(await works(gas))) throw fail('tx_gas_cap', `no verified execution succeeds within maxGas ${caps.maxGas}: nothing signed`);
    const base = quantity(h.baseFeePerGas, 'the attested verifier\'s head base fee (nothing signed)');
    let tip = quantity(await B('eth_maxPriorityFeePerGas', []), 'the own backend\'s tip hint (nothing signed)', 'chain_backend_unavailable');
    if (tip > caps.maxPriorityFeePerGas) tip = caps.maxPriorityFeePerGas;
    let maxFee = 2n * base + tip;
    if (maxFee > caps.maxFeePerGas) maxFee = caps.maxFeePerGas;
    if (maxFee < base + tip) throw fail('tx_fee_cap', `the verified base fee ${base} wei + tip ${tip} exceeds maxFeePerGasWei ${caps.maxFeePerGas}: nothing signed`);
    const balance = quantity(await V('eth_getBalance', [from, at]), 'the proven balance');
    if (balance < gas * maxFee) throw fail('tx_insufficient_funds', `the proven balance of ${from} (${balance} wei) does not cover gas ${gas} x max fee ${maxFee}: nothing signed`);
    if (!Number.isSafeInteger(Number(nonce)) || gas <= 0n || tip < 0n || maxFee <= 0n || tip > maxFee) throw fail('tx_bounds', 'transaction fields out of bounds: nothing signed');
    return { nonce, gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, block: h.number };
  }

  async function writeContract({ address, abi, functionName, args }) {
    return serial(async () => {
      if (rec) {
        const r = rec, s = await resolve(r);
        if (s.state === 'unresolved') throw busy(r, await rebroadcast(r).catch((e) => `not re-broadcast: ${e.message}`));
        throw fail('tx_previous_resolved', `the previous transaction ${r.hash} was resolved just now (${s.state}${s.receipt ? ' ' + s.receipt.status : ''}): re-evaluate from verified state; nothing signed`);
      }
      const to = getAddress(address), data = encodeFunctionData({ abi, functionName, args });
      const p = await prepare({ to, data });
      const raw = await account.signTransaction({ chainId, type: 'eip1559', nonce: Number(p.nonce), to, data, value: 0n, gas: p.gas, maxFeePerGas: p.maxFeePerGas, maxPriorityFeePerGas: p.maxPriorityFeePerGas });
      const hash = keccak256(raw);
      setRecord({ nonce: Number(p.nonce), raw, hash });            // durable BEFORE the backend has the bytes
      const { outcome, why } = await broadcast(raw, hash);
      // a refusal is the backend's word only: the bytes may have been forwarded anyway. The record stays (re-broadcast as the
      // same bytes, resolved only by the attested verifier); see the header for the manual reconciliation of a stuck send.
      if (outcome === 'rejected') throw fail('tx_refused', `the own backend refused ${functionName} ${hash} (${why}): refused, NOT proof that nothing is pending; the signed bytes stay recorded until the attested verifier shows their receipt or their nonce consumed`, { hash });
      log(`[attested-submission] ${functionName} ${hash} nonce ${p.nonce} gas ${p.gas} maxFee ${p.maxFeePerGas}: submitted (${outcome}; a submission, not inclusion)`);
      return hash;
    });
  }

  /** A receipt the attested verifier answers for `hash` within `timeout` ms; a reverted one is returned as reverted. */
  async function waitForTransactionReceipt({ hash, timeout = 60_000 }) {
    const end = Date.now() + timeout;
    let lastErr = null;
    for (;;) {
      try {
        const rc = await verifiedReceipt(hash);
        if (rc) { if (rec?.hash === lc(hash)) setRecord(null); return rc; }
        if (rec?.hash === lc(hash)) {
          const s = await resolve(rec);
          if (s.state === 'receipt') return s.receipt;
          if (s.state === 'nonce-consumed') throw fail('tx_nonce_consumed', `nonce of ${hash} was consumed by another transaction; it has no verifier-checked receipt: not landed by this send`);
        }
      } catch (e) { if (e?.code === 'tx_nonce_consumed' || e?.code === 'chain_receipt_invalid') throw e; lastErr = e; }
      if (Date.now() >= end) throw fail('tx_unconfirmed', `${hash} is not confirmed by a receipt from the attested verifier within ${timeout} ms${lastErr ? ` (${String(lastErr.message).slice(0, 200)})` : ''}; it stays this provider's unresolved send (re-broadcast as the same bytes, never re-signed)`);
      await sleep(receiptPollMs);
    }
  }

  async function readContract(args) {
    if (args.blockTag !== undefined || args.blockNumber !== undefined) throw new Error('attested submission reads at the verifier\'s head only');
    return (await snapshot((c) => c.readContract(args))).value;
  }
  const settle = () => serial(async () => {
    if (!rec) return { state: 'none' };
    const r = rec, s = await resolve(r);
    if (s.state === 'unresolved') throw busy(r, await rebroadcast(r).catch((e) => `not re-broadcast: ${e.message}`));
    return s;
  });
  const describe = () => ({ ...evidence, submission: { backend: backend.label, scope: backend.scope, use: TX_BACKEND_USE, evidence: 'none (inclusion only by a receipt from the attested verifier)' },
    caps: { maxFeePerGasWei: String(caps.maxFeePerGas), maxPriorityFeePerGasWei: String(caps.maxPriorityFeePerGas), maxGas: Number(caps.maxGas) } });
  return Object.freeze({ client: Object.freeze({ readContract, waitForTransactionReceipt }), wallet: Object.freeze({ account, writeContract }),
    settle, pending: () => (rec ? { nonce: rec.nonce, hash: rec.hash } : null), describe, ready });
}
