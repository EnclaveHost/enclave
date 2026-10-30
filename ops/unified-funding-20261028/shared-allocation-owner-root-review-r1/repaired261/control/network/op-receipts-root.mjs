// Strict OP-stack (Base) receipts-root encoder/verifier for A5 complete historical logs (finality-stage/op-receipts-root).
// Pure ES module, no imports: keccak256 and the header-hash function are injected.
//
// The rules follow pinned base v1.5.1 (5476069f):
//   root    = ordered trie (key rlp(index)) of EIP-2718 receipt encodings   crates/execution/consensus/src/proof.rs:13-42
//   quirk   = Regolith <= t < Canyon: deposit receipts are encoded WITHOUT depositNonce (op-geth/op-erigon bug compat)
//   types   = 0x0 legacy, 0x1, 0x2, 0x4, 0x7e deposit; 0x79 (EIP-8130) exists but Base mainnet everest = None
//             crates/common/consensus/src/receipts/receipt.rs:26-45, crates/common/chains/src/config.rs:465-479
//   deposit = [status, cumulativeGasUsed, bloom, logs, depositNonce?, depositReceiptVersion?]   receipts/deposit.rs:112-130
// A returned JSON root is never accepted: the root is RECOMPUTED from the receipts and compared to the receiptsRoot of a
// header whose keccak(RLP) the caller-supplied authenticated block hash must equal.

export class ReceiptsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new ReceiptsError(code, message); };
export const toHex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const lc = (s) => String(s).toLowerCase();

export const BASE_MAINNET = Object.freeze({ name: "base-mainnet", chainId: 8453, regolith: 1686789347, canyon: 1704992401, everest: null,
                                            types: Object.freeze(["0x0", "0x1", "0x2", "0x4", "0x7e"]) });
// Ethereum L1 (only to exercise the trie/encoder on an independent L1 vector; no deposits, blobs allowed)
export const ETHEREUM_MAINNET = Object.freeze({ name: "ethereum-mainnet", chainId: 1, regolith: null, canyon: null, everest: null,
                                                types: Object.freeze(["0x0", "0x1", "0x2", "0x3", "0x4"]) });

// ---- strict JSON field parsing ---------------------------------------------------------------------------------------
function bytes(h, n, what) {
  const s = String(h);
  if (!/^0x([0-9a-fA-F]{2})*$/.test(s)) fail("bad_field", `${what} is not even-length hex`);
  const b = Uint8Array.from(s.slice(2).match(/../g) || [], (x) => parseInt(x, 16));
  if (n !== undefined && b.length !== n) fail("bad_field", `${what} must be ${n} bytes`);
  return b;
}
function qty(h, what) {
  const s = String(h);
  if (!/^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(s)) fail("bad_field", `${what} is not a canonical quantity: ${s.slice(0, 24)}`);
  const v = BigInt(s);
  if (v >= 1n << 64n) fail("bad_field", `${what} exceeds uint64`);
  return v;
}

// ---- RLP encode (canonical) ------------------------------------------------------------------------------------------
const intBytes = (v) => { if (v === 0n) return new Uint8Array(0); let h = v.toString(16); if (h.length % 2) h = "0" + h; return bytes("0x" + h); };
function lenPrefix(len, small) {
  if (len < 56) return Uint8Array.of(small + len);
  const l = intBytes(BigInt(len));
  return Uint8Array.of(small + 55 + l.length, ...l);
}
const cat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
/** item: Uint8Array (string), bigint (integer), {raw: Uint8Array} (already-encoded), or an array of items. */
export function rlp(item) {
  if (item && item.raw) return item.raw;
  if (Array.isArray(item)) { const body = cat(item.map(rlp)); return cat([lenPrefix(body.length, 0xc0), body]); }
  const b = typeof item === "bigint" ? intBytes(item) : item;
  if (b.length === 1 && b[0] < 0x80) return b;
  return cat([lenPrefix(b.length, 0x80), b]);
}

// ---- ordered Merkle-Patricia trie root -------------------------------------------------------------------------------
const nibbles = (b) => { const n = []; for (const x of b) n.push(x >> 4, x & 15); return n; };
function hexPrefix(path, leaf) {
  const odd = path.length % 2, flag = (leaf ? 2 : 0) + odd;
  const out = [odd ? (flag << 4) | path[0] : flag << 4];
  for (let k = odd; k < path.length; k += 2) out.push((path[k] << 4) | path[k + 1]);
  return Uint8Array.from(out);
}
function trieNode(entries, depth, keccak) {
  if (entries.length === 1) return rlp([hexPrefix(entries[0].path.slice(depth), true), entries[0].value]);
  let p = 0;                                            // shared prefix below depth
  for (;;) {
    const c = entries[0].path[depth + p];
    if (c === undefined || !entries.every((e) => e.path[depth + p] === c)) break;
    p++;
  }
  const ref = (enc) => enc.length < 32 ? { raw: enc } : keccak(enc);
  if (p > 0) return rlp([hexPrefix(entries[0].path.slice(depth, depth + p), false), ref(trieNode(entries, depth + p, keccak))]);
  const slots = Array.from({ length: 16 }, () => []); let value = new Uint8Array(0);
  for (const e of entries) {
    if (e.path.length === depth) value = e.value; else slots[e.path[depth]].push(e);
  }
  return rlp([...slots.map((s) => s.length ? ref(trieNode(s, depth + 1, keccak)) : new Uint8Array(0)), value]);
}
/** Root of the ordered trie whose key i is rlp(i) and whose value i is values[i] (raw bytes). */
export function orderedTrieRoot(values, keccak) {
  if (values.length === 0) return toHex(keccak(rlp(new Uint8Array(0))));
  const entries = values.map((v, i) => ({ path: nibbles(rlp(BigInt(i))), value: v }));
  return toHex(keccak(trieNode(entries, 0, keccak)));
}

// ---- bloom -------------------------------------------------------------------------------------------------------------
function bloomAdd(bloom, data, keccak) {
  const d = keccak(data);
  for (const i of [0, 2, 4]) { const bit = ((d[i] << 8) | d[i + 1]) & 2047; bloom[255 - (bit >> 3)] |= 1 << (bit & 7); }
}
export function logsBloom(logs, keccak) {
  const b = new Uint8Array(256);
  for (const l of logs) { bloomAdd(b, l.address, keccak); for (const t of l.topics) bloomAdd(b, t, keccak); }
  return b;
}

// ---- consensus receipt -> EIP-2718 bytes -----------------------------------------------------------------------------
/** r: {type:"0x7e"|..., status:0|1, cumulativeGasUsed:bigint, logs:[{address,topics,data} Uint8Array], depositNonce?, depositReceiptVersion?} */
export function encodeConsensusReceipt(r, keccak, { stripDepositNonce = false } = {}) {
  // r.bloom (explicit) exists ONLY for upstream fixed-bloom vectors; verifyBlockReceipts never passes it (always recomputes)
  const fields = [r.status ? Uint8Array.of(1) : new Uint8Array(0), r.cumulativeGasUsed, r.bloom ?? logsBloom(r.logs, keccak),
                  r.logs.map((l) => [l.address, l.topics, l.data])];
  if (r.type === "0x7e") {
    if (r.depositNonce !== undefined && !stripDepositNonce) fields.push(r.depositNonce);
    if (r.depositReceiptVersion !== undefined) fields.push(r.depositReceiptVersion);
  }
  const body = rlp(fields);
  return r.type === "0x0" ? body : cat([Uint8Array.of(Number(BigInt(r.type))), body]);
}
export const consensusReceiptsRoot = (receipts, keccak, opts) => orderedTrieRoot(receipts.map((r) => encodeConsensusReceipt(r, keccak, opts)), keccak);

// ---- strict verification of one block's eth_getBlockReceipts answer --------------------------------------------------
// Results are deep-frozen and branded in this module-private WeakSet. completeLogsEntry accepts ONLY branded results
// whose transaction hashes are bound to a transactionsRoot-verified body. Scope of the brand: a trusted-internal API
// guard against accidental or hand-built objects within one loaded module instance; it is not a security boundary
// against hostile code in the same process (a second copy of this module has its own, separate brand set).
const VERIFIED = new WeakSet();
export const DEFAULT_MAX_RECEIPTS = 50_000;     // per block; a Base block holds a few thousand at most
export const DEFAULT_MAX_LOGS = 500_000;        // per block
const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
/** Exported JS numbers must be exact: refuse instead of rounding above Number.MAX_SAFE_INTEGER. */
function safeNum(v, what) {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail("unsafe_integer", `${what} ${v} exceeds Number.MAX_SAFE_INTEGER`);
  return Number(v);
}
// RPC receipts carry informational fields (l1Fee, gasUsed, from, ...): they are ignored and never encoded.
/**
 * verifyBlockReceipts({ header, expectedBlockHash, receipts, txHashes?, chain }, { keccak, headerHash })
 *   header            the block header JSON (untrusted); keccak(RLP(header)) MUST equal expectedBlockHash
 *   expectedBlockHash an AUTHENTICATED block hash (from the A1/A2 anchor parentHash chain), never from the same RPC answer
 *   receipts          the eth_getBlockReceipts JSON (untrusted, complete list in transaction order)
 *   txHashes          optional transaction hashes from a transactionsRoot-verified body; binds receipt i to tx i
 * -> { blockHash, number, timestamp, receiptsRoot (recomputed), logs[], txHashBinding }  or throws ReceiptsError
 */
//   limits (resource bounds, refused with "resource_bound"): maxReceipts, maxLogs per block. TRANSPORT bounds (response
//   byte cap, timeout, redirect refusal) are the CALLER's job before JSON parsing, e.g. l1-anchor-a1 a1-read.mjs rpc().
export function verifyBlockReceipts({ header, expectedBlockHash, receipts, txHashes, chain = BASE_MAINNET, maxReceipts = DEFAULT_MAX_RECEIPTS, maxLogs = DEFAULT_MAX_LOGS },
                                    { keccak, headerHash }) {
  const blockHash = lc(expectedBlockHash);
  if (!/^0x[0-9a-f]{64}$/.test(blockHash)) fail("bad_input", "expectedBlockHash (authenticated) is required");
  if (headerHash(header, keccak) !== blockHash) fail("header_hash", "header does not hash to the authenticated block hash");
  if (header.hash !== undefined && lc(header.hash) !== blockHash) fail("header_hash", "header.hash field differs from its recomputed hash");
  const number = qty(header.number, "header.number"), ts = safeNum(qty(header.timestamp, "header.timestamp"), "header.timestamp");
  const numberOut = safeNum(number, "header.number");
  if (!Array.isArray(receipts)) fail("bad_input", "receipts must be the complete eth_getBlockReceipts list");
  if (receipts.length > maxReceipts) fail("resource_bound", `${receipts.length} receipts exceed maxReceipts ${maxReceipts}`);
  if (receipts.reduce((a, r) => a + (Array.isArray(r?.logs) ? r.logs.length : 0), 0) > maxLogs) fail("resource_bound", `logs exceed maxLogs ${maxLogs}`);
  const strip = chain.regolith !== null && ts >= chain.regolith && chain.canyon !== null && ts < chain.canyon;
  const consensus = [], outLogs = [];
  let cum = -1n, logIndex = 0n;
  receipts.forEach((r, i) => {
    const what = `receipt ${i}`;
    if (!chain.types.includes(lc(r.type))) fail("unsupported_type", `${what} type ${r.type} is not supported for ${chain.name}${lc(r.type) === "0x79" ? " (EIP-8130: everest not active; encoder deliberately refuses)" : ""}`);
    if ("root" in r) fail("pre_byzantium", `${what} carries a state root instead of status`);
    if (lc(r.blockHash) !== blockHash) fail("wrong_block", `${what} names block ${r.blockHash}`);
    if (qty(r.blockNumber, `${what}.blockNumber`) !== number) fail("wrong_block", `${what} names another block number`);
    if (qty(r.transactionIndex, `${what}.transactionIndex`) !== BigInt(i)) fail("order", `${what} has transactionIndex ${r.transactionIndex}`);
    const txh = lc(r.transactionHash); bytes(txh, 32, `${what}.transactionHash`);
    if (txHashes && lc(txHashes[i]) !== txh) fail("tx_binding", `${what} transactionHash differs from the verified body`);
    const status = qty(r.status, `${what}.status`);
    if (status > 1n) fail("bad_field", `${what} status is not 0/1`);
    const c = qty(r.cumulativeGasUsed, `${what}.cumulativeGasUsed`);
    if (c < cum) fail("gas_order", `${what} cumulativeGasUsed decreases`);
    cum = c;
    const type = lc(r.type);
    const isDeposit = type === "0x7e";
    const hasNonce = r.depositNonce !== undefined && r.depositNonce !== null, hasVer = r.depositReceiptVersion !== undefined && r.depositReceiptVersion !== null;
    if (!isDeposit && (hasNonce || hasVer)) fail("deposit_fields", `${what} is not a deposit but carries deposit fields`);
    const canyon = chain.canyon !== null && ts >= chain.canyon, regolith = chain.regolith !== null && ts >= chain.regolith;
    if (isDeposit) {
      if (regolith && !hasNonce) fail("deposit_fields", `${what} deposit without depositNonce after Regolith`);
      if (!regolith && (hasNonce || hasVer)) fail("deposit_fields", `${what} deposit fields before Regolith`);
      if (canyon && (!hasVer || qty(r.depositReceiptVersion, `${what}.depositReceiptVersion`) !== 1n)) fail("deposit_fields", `${what} deposit receipt version must be 1 after Canyon`);
      if (!canyon && hasVer) fail("deposit_fields", `${what} depositReceiptVersion before Canyon`);
    }
    if (!Array.isArray(r.logs)) fail("bad_field", `${what}.logs is not a list`);
    const logs = r.logs.map((l, k) => {
      const lw = `${what} log ${k}`;
      if (l.removed === true) fail("removed_log", `${lw} is marked removed`);
      if (lc(l.blockHash) !== blockHash || qty(l.blockNumber, `${lw}.blockNumber`) !== number) fail("wrong_block", `${lw} names another block`);
      if (qty(l.transactionIndex, `${lw}.transactionIndex`) !== BigInt(i) || lc(l.transactionHash) !== txh) fail("order", `${lw} names another transaction`);
      if (qty(l.logIndex, `${lw}.logIndex`) !== logIndex) fail("order", `${lw} logIndex ${l.logIndex} != ${logIndex}`);
      logIndex++;
      if (!Array.isArray(l.topics) || l.topics.length > 4) fail("bad_field", `${lw} topics`);
      return { address: bytes(lc(l.address), 20, `${lw}.address`), topics: l.topics.map((t) => bytes(lc(t), 32, `${lw}.topic`)), data: bytes(lc(l.data), undefined, `${lw}.data`) };
    });
    const rec = { type, status: Number(status), cumulativeGasUsed: c, logs,
                  ...(hasNonce ? { depositNonce: qty(r.depositNonce, `${what}.depositNonce`) } : {}),
                  ...(hasVer ? { depositReceiptVersion: qty(r.depositReceiptVersion, `${what}.depositReceiptVersion`) } : {}) };
    if (r.logsBloom !== undefined && toHex(logsBloom(logs, keccak)) !== lc(r.logsBloom)) fail("bloom_mismatch", `${what} logsBloom differs from its logs`);
    consensus.push(rec);
    logs.forEach((l, k) => outLogs.push({ blockNumber: numberOut, blockHash, transactionIndex: i, transactionHash: txh,
      logIndex: safeNum(BigInt(r.logs[k].logIndex), `${what} log ${k}.logIndex`), address: toHex(l.address), topics: l.topics.map(toHex), data: toHex(l.data) }));
  });
  if (txHashes && txHashes.length !== receipts.length) fail("tx_binding", `${receipts.length} receipts for ${txHashes.length} verified transactions`);
  const gasUsed = qty(header.gasUsed, "header.gasUsed");
  if ((receipts.length ? cum : 0n) !== gasUsed) fail("gas_total", `last cumulativeGasUsed ${cum} != header.gasUsed ${gasUsed}`);
  const blockBloom = new Uint8Array(256);
  for (const r of consensus) { const b = logsBloom(r.logs, keccak); for (let k = 0; k < 256; k++) blockBloom[k] |= b[k]; }
  if (toHex(blockBloom) !== lc(header.logsBloom)) fail("bloom_mismatch", "OR of receipt blooms differs from header.logsBloom");
  const root = consensusReceiptsRoot(consensus, keccak, { stripDepositNonce: strip });
  if (root !== lc(header.receiptsRoot)) fail("receipts_root_mismatch", `recomputed receipts root ${root} != header ${lc(header.receiptsRoot)}`);
  const result = deepFreeze({ blockHash, number: numberOut, timestamp: ts, receiptsRoot: root, logs: outLogs,
           txHashBinding: txHashes ? "verified-body" : "unauthenticated (receipt.transactionHash not bound to a verified body)" });
  VERIFIED.add(result);
  return result;
}

/**
 * The exact map entry complete-logs.mjs assembleCompleteLogs expects: blockHash -> { receiptsRoot (RECOMPUTED), logs }.
 * REFUSES (never strips): anything not returned by verifyBlockReceipts in this module instance ("not_verified"), and any
 * result whose transactionHash fields are not bound to a transactionsRoot-verified body ("tx_unbound"). Exported logs
 * therefore never carry an unproven transactionHash. The returned entry shares the frozen result's logs.
 */
export function completeLogsEntry(v) {
  if (!VERIFIED.has(v)) fail("not_verified", "completeLogsEntry accepts only a result returned by verifyBlockReceipts");
  if (v.txHashBinding !== "verified-body") fail("tx_unbound", "receipts were verified without a transactionsRoot-verified body: transactionHash is unproven; pass txHashes from a verified body");
  return [v.blockHash, Object.freeze({ receiptsRoot: v.receiptsRoot, logs: v.logs })];
}
