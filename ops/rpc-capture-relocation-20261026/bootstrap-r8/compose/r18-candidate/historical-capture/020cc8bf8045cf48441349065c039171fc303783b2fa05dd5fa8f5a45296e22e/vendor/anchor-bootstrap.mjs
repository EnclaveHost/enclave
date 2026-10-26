// anchor-bootstrap.mjs: authenticate a Base start state from an L1-finalized game anchor (finality-stage/anchor-bootstrap-review).
// Pure and synchronous: no network, no imports. keccak256 (Uint8Array -> Uint8Array) is injected, as in ../complete-logs.mjs.
//
// Security rule (root review 2026-10-25): a block hash commits to its PARENT, never to its children. An authenticated anchor
// block N therefore authenticates ONLY N and its ancestors. Descendants of N (blocks N+1.., including a snapshot head above
// N) are never authenticated by hash links; they are trusted only when our own EL executed them from a state verified at N.
// And because the EL BUILDS derived blocks from plain-state reads, the full hashing+merkle rebuild must target N itself, not
// a later tip whose header our own (possibly misled) execution produced.
//
// What this module proves, given its inputs:
//   - keccak(RLP(header)) is recomputed from the fields (any `hash` field is a claim, never used),
//   - the anchor header N reproduces the game's rootClaim: OutputRoot v0 = keccak(0^32 || stateRoot || messagePasserRoot ||
//     blockHash), with messagePasserRoot = header.withdrawalsRoot (Isthmus: the L2ToL1MessagePasser storage root),
//   - a header range authenticates only when it is contiguous, every hash is recomputed and links, and it ENDS at N,
//   - planBootstrap() never accepts a height above N, and requires the rebuild at exactly N.
// What it does NOT prove (callers must):
//   - that rootClaim/l2BlockNumber came from the L1 AnchorStateRegistry at a beacon-FINALIZED L1 block (MPT proof or
//     proof-verified eth_call against that block's stateRoot),
//   - that the reth rebuild really ran (its result is an input to checkRebuild()),
//   - receipts roots (../complete-logs.mjs + an OP receipt-trie encoder).

export class AnchorBootstrapError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new AnchorBootstrapError(code, message); };
const isHex = (s, n) => typeof s === "string" && new RegExp(n == null ? "^0x([0-9a-fA-F]{2})*$" : `^0x[0-9a-fA-F]{${n}}$`).test(s);
const lower = (s) => String(s).toLowerCase();

export function bytesOf(hex, n) {
  if (!isHex(hex, n == null ? null : 2 * n)) fail("bad_input", `expected ${n == null ? "even-length" : n + "-byte"} hex, got ${String(hex).slice(0, 20)}`);
  const s = hex.slice(2), out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}
export const toHex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
/** an RLP integer: big-endian, no leading zero bytes (0 -> empty). Accepts a 0x quantity, a safe integer or a bigint. */
export function quantityBytes(q) {
  let v;
  if (typeof q === "bigint") v = q;
  else if (Number.isSafeInteger(q) && q >= 0) v = BigInt(q);
  else if (typeof q === "string" && /^0x[0-9a-fA-F]+$/.test(q)) v = BigInt(q);
  else fail("bad_input", `bad quantity ${String(q).slice(0, 20)}`);
  if (v < 0n) fail("bad_input", "negative quantity");
  const out = [];
  while (v > 0n) { out.unshift(Number(v & 0xffn)); v >>= 8n; }
  return Uint8Array.from(out);
}

function lengthPrefix(len, short, long) {
  if (len < 56) return Uint8Array.of(short + len);
  const l = quantityBytes(len);
  return Uint8Array.from([long + l.length, ...l]);
}
const concat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
/** RLP of a Uint8Array or a (nested) array of them. */
export function rlp(item) {
  if (item instanceof Uint8Array) return item.length === 1 && item[0] < 0x80 ? item : concat([lengthPrefix(item.length, 0x80, 0xb7), item]);
  if (Array.isArray(item)) { const body = concat(item.map(rlp)); return concat([lengthPrefix(body.length, 0xc0, 0xf7), body]); }
  return fail("bad_input", "rlp: only bytes and lists");
}

// Ethereum / OP-stack header field order (yellow paper + EIP-1559, -4895, -4844, -4788, -7685). Optional fields are a
// contiguous suffix: a later fork's field is never present without the earlier ones.
const BASE = [["parentHash", 32], ["sha3Uncles", 32], ["miner", 20], ["stateRoot", 32], ["transactionsRoot", 32], ["receiptsRoot", 32],
  ["logsBloom", 256], ["difficulty", "q"], ["number", "q"], ["gasLimit", "q"], ["gasUsed", "q"], ["timestamp", "q"], ["extraData", "bytes"],
  ["mixHash", 32], ["nonce", 8]];
const OPTIONAL = [["baseFeePerGas", "q"], ["withdrawalsRoot", 32], ["blobGasUsed", "q"], ["excessBlobGas", "q"], ["parentBeaconBlockRoot", 32], ["requestsHash", 32]];
export const ISTHMUS_FIELDS = OPTIONAL.map(([k]) => k);

function fieldBytes(h, [k, t]) {
  const v = h[k];
  if (v === undefined || v === null) fail("bad_input", `header field ${k} is missing`);
  return t === "q" ? quantityBytes(v) : t === "bytes" ? bytesOf(v) : bytesOf(v, t);
}
/** RLP(header). requireIsthmus: every post-London field must be present (Base headers at the anchor heights). */
export function headerRlp(h, { requireIsthmus = false } = {}) {
  if (!h || typeof h !== "object") fail("bad_input", "header must be an object");
  const fields = BASE.map((f) => fieldBytes(h, f));
  let gap = false;
  for (const f of OPTIONAL) {
    const present = h[f[0]] !== undefined && h[f[0]] !== null;
    if (present && gap) fail("bad_input", `header field ${f[0]} present after a missing earlier fork field`);
    if (!present) { if (requireIsthmus) fail("not_isthmus", `header lacks ${f[0]}: the anchor must be an Isthmus header (withdrawalsRoot = message-passer root)`); gap = true; continue; }
    fields.push(fieldBytes(h, f));
  }
  return rlp(fields);
}
export function headerHash(h, keccak, opts) { return toHex(keccak(headerRlp(h, opts))); }
const numberOf = (h) => { const n = Number(quantityBytes(h.number).reduce((a, b) => a * 256 + b, 0)); if (!Number.isSafeInteger(n)) fail("bad_input", "block number too large"); return n; };

/** OutputRoot v0 = keccak(0^32 || stateRoot || messagePasserStorageRoot || blockHash). */
export function outputRootV0({ stateRoot, messagePasserStorageRoot, blockHash }, keccak) {
  const b = new Uint8Array(128);
  b.set(bytesOf(stateRoot, 32), 32); b.set(bytesOf(messagePasserStorageRoot, 32), 64); b.set(bytesOf(blockHash, 32), 96);
  return toHex(keccak(b));
}

/**
 * The anchor block N, authenticated from a finalized game's { rootClaim, l2BlockNumber } (read by the caller from
 * authenticated L1) and the Isthmus header N from ANY source (e.g. the untrusted local DB).
 * -> Object.freeze({ number, blockHash, stateRoot, messagePasserStorageRoot })
 */
export function authenticateAnchor({ rootClaim, l2BlockNumber }, header, keccak) {
  if (!isHex(rootClaim, 64)) fail("bad_input", "rootClaim must be 32-byte hex");
  if (!Number.isSafeInteger(l2BlockNumber) || l2BlockNumber < 1) fail("bad_input", "l2BlockNumber must be a positive safe integer");
  const blockHash = headerHash(header, keccak, { requireIsthmus: true });
  if (header.hash !== undefined && lower(header.hash) !== blockHash) fail("hash_claim", "the header's claimed hash is not keccak(RLP(header))");
  if (numberOf(header) !== l2BlockNumber) fail("anchor_number", `header ${numberOf(header)} is not the game's L2 block ${l2BlockNumber}`);
  const pre = { stateRoot: lower(header.stateRoot), messagePasserStorageRoot: lower(header.withdrawalsRoot), blockHash };
  if (outputRootV0(pre, keccak) !== lower(rootClaim)) fail("output_root", "header N does not reproduce the game's output root (state root, message-passer root or block hash differs)");
  return Object.freeze({ number: l2BlockNumber, ...pre });
}

/**
 * Ancestors of the authenticated anchor: `headers` ascending, contiguous, ENDING at the anchor block. Every hash is
 * recomputed (never read), every parentHash must equal the recomputed hash below it.
 * -> Map(number -> Object.freeze({ hash, stateRoot, receiptsRoot, transactionsRoot, logsBloom }))
 */
export function authenticateAncestors(headers, anchor, keccak) {
  if (!Array.isArray(headers) || headers.length === 0) fail("bad_input", "no headers");
  if (!anchor || !Number.isSafeInteger(anchor.number) || !isHex(anchor.blockHash, 64)) fail("no_anchor", "an authenticated anchor is required");
  const out = new Map();
  let above = null;   // the authenticated child, walking DOWN from the anchor
  for (let i = headers.length - 1; i >= 0; i--) {
    const h = headers[i], n = numberOf(h), hash = headerHash(h, keccak);
    if (h.hash !== undefined && lower(h.hash) !== hash) fail("hash_claim", `header ${n}'s claimed hash is not keccak(RLP(header))`);
    if (above === null) {
      if (n > anchor.number) fail("descendant", `header ${n} is ABOVE the anchor ${anchor.number}: descendants are never authenticated by hash links`);
      if (n !== anchor.number || hash !== lower(anchor.blockHash)) fail("anchor_mismatch", "the header range does not end at the anchor block");
    } else {
      if (n !== above.number - 1) fail("discontinuity", `header ${n} is not the parent height of ${above.number}`);
      if (lower(above.parentHash) !== hash) fail("unlinked", `header ${n} is not the parent of ${above.number}`);
    }
    out.set(n, Object.freeze({ hash, stateRoot: lower(h.stateRoot), receiptsRoot: lower(h.receiptsRoot), transactionsRoot: lower(h.transactionsRoot), logsBloom: lower(h.logsBloom) }));
    above = { number: n, parentHash: h.parentHash };
  }
  return out;
}

/**
 * The bootstrap action for the local DB, given the authenticated anchor N:
 *   localHead:      the DB's current head (snapshot head, or later after our own sync)
 *   changesetFloor: lowest block whose state changesets the DB still holds (unwinding to N needs N >= floor)
 * Never accepts any height above N. The state is accepted only by checkRebuild() at exactly N.
 */
export function planBootstrap({ anchor, localHead, changesetFloor }) {
  if (!anchor || !Number.isSafeInteger(anchor.number)) fail("no_anchor", "an authenticated anchor is required");
  for (const [k, v] of Object.entries({ localHead, changesetFloor })) if (!Number.isSafeInteger(v) || v < 0) fail("bad_input", `${k} must be a non-negative safe integer`);
  const N = anchor.number;
  const after = [
    `verify headers [historyFrom, ${N}] as ANCESTORS of N (authenticateAncestors) and their receipts roots`,
    `refuse historical-state queries below ${N} (snapshot changesets are not authenticated)`,
    "clear the snapshot's persisted safe-head data; restart derivation at N from authenticated L1 (M7)",
    `execute every block above ${N} with our own EL; check each later finalized anchor against our chain (tripwire)`,
  ];
  // A rolling prune moves the changeset floor up with the tip, so "sync and wait" is NOT guaranteed to ever meet an anchor:
  // the floor must be HELD (stop at a held head, or retain changesets, e.g. stateHistoryFromBlock) until an anchor >= it exists.
  const hold = "HOLD the changeset floor (stop advancing at a held head, or retain state history from a fixed block, e.g. stateHistoryFromBlock); a continuously advancing tip with rolling Distance pruning may never meet an anchor";
  if (N < changesetFloor) return { action: "wait_for_newer_anchor", authenticatedThrough: null, reason: `anchor ${N} is below the changeset floor ${changesetFloor}: the DB cannot be unwound to it`, steps: [hold, `when a finalized anchor N' >= the HELD floor exists, re-plan (no authority served meanwhile)`] };
  if (N > localHead) return { action: "sync_past_anchor_then_unwind", authenticatedThrough: null, reason: `anchor ${N} is above the local head ${localHead}`, steps: [`sync forward past ${N} (no authority served), retaining changesets back to ${N} (${hold})`, `stop; unwind to exactly ${N}`, `full hashing+merkle rebuild at ${N}; checkRebuild`, ...after] };
  return { action: N === localHead ? "rebuild_at_anchor" : "unwind_to_anchor", authenticatedThrough: null,
    reason: N === localHead ? "the local head is the anchor block" : `the local head ${localHead} is ABOVE the anchor ${N}: blocks ${N + 1}..${localHead} are unauthenticated and are discarded`,
    steps: [...(N === localHead ? [] : [`stop; unwind to exactly ${N}`]), `full hashing+merkle rebuild at ${N}; checkRebuild`, ...after] };
}

/** The rebuild result (block and state root reported by `stage run merkle --to N` OK) must be at exactly N. */
export function checkRebuild(anchor, { block, stateRoot }) {
  if (!anchor || !Number.isSafeInteger(anchor.number) || !isHex(anchor.stateRoot, 64)) fail("no_anchor", "an authenticated anchor is required");
  if (block !== anchor.number) fail("rebuild_height", `a rebuild at ${block} proves nothing: only the authenticated block ${anchor.number} has a trusted state root`);
  if (!isHex(stateRoot, 64) || lower(stateRoot) !== anchor.stateRoot) fail("rebuild_root", "the rebuilt state root is not the anchor's");
  return Object.freeze({ verifiedStateAt: anchor.number, stateRoot: anchor.stateRoot, blockHash: anchor.blockHash });
}
