// Complete lease-log history against an AUTHENTICATED finalized Base anchor (finality-stage; DESIGN.md).
// Pure and synchronous: no network, no imports. keccak256 (Uint8Array -> Uint8Array) is injected so the module ships flat.
//
// What this module proves, given its inputs:
//   - every header in [lo, hi] links by parentHash to the anchor block hash (the anchor is the ONLY trust input),
//   - every block whose logsBloom could hold a lease log is listed for a receipts read (a bloom never has false negatives),
//   - the final log set is assembled only when every listed block's receipts were verified against that header's
//     receiptsRoot; a missing block is `incomplete`, never an empty history.
// What it does NOT prove (callers must, see DESIGN.md section 3):
//   - that each `hash` is keccak(RLP(header)) of the fields used: the caller recomputes it (Base header encoding),
//   - that the anchor came from a finalized L1 game read through an L1 light client,
//   - that a receipts list hashes to receiptsRoot (OP receipt trie encoding).

export class CompleteLogsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new CompleteLogsError(code, message); };
const HEX = (n) => new RegExp(`^0x[0-9a-f]{${n}}$`);

export function hexBytes(hex, n) {
  const h = String(hex || "").toLowerCase();
  if (!HEX(n * 2).test(h)) fail("bad_input", `expected ${n} bytes of hex`);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
}
const toHex = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// Yellow paper M3:2048: three 11-bit indexes from the first six bytes of keccak(value); bit k lives in byte 255 - k/8.
function bloomBits(value, keccak) {
  const d = keccak(value);
  return [0, 2, 4].map((i) => ((d[i] << 8) | d[i + 1]) & 2047);
}
export function bloomMayContain(bloomHex, valueBytes, keccak) {
  const bloom = hexBytes(bloomHex, 256);
  return bloomBits(valueBytes, keccak).every((k) => (bloom[255 - (k >> 3)] & (1 << (k & 7))) !== 0);
}
/** Test helper and reference: the bloom of a set of values. */
export function bloomOf(values, keccak) {
  const bloom = new Uint8Array(256);
  for (const v of values) for (const k of bloomBits(v, keccak)) bloom[255 - (k >> 3)] |= 1 << (k & 7);
  return toHex(bloom);
}

/**
 * Can this header's block hold a log with address `ledger`, topic0 in `topic0s` and topic1 = `id`? A log adds its
 * address and every topic to the bloom, so all three must be present; any absent one proves no such log.
 */
export function mayHoldLeaseLog(logsBloom, { ledger, id, topic0s }, keccak) {
  if (!bloomMayContain(logsBloom, hexBytes(ledger, 20), keccak)) return false;
  if (!bloomMayContain(logsBloom, hexBytes(id, 32), keccak)) return false;
  return topic0s.some((t) => bloomMayContain(logsBloom, hexBytes(t, 32), keccak));
}

/**
 * The scan plan of [lo, anchor.number]: `headers` ascending, contiguous, parentHash-linked, ending at the anchor.
 * anchor: { number, blockHash } from an authenticated source (never from the backend that served `headers`).
 * -> { lo, hi, candidates: [{ number, hash, receiptsRoot }], skipped }
 */
export function planCompleteScan(headers, anchor, filter, keccak) {
  if (!Array.isArray(headers) || headers.length === 0) fail("bad_input", "no headers");
  if (!anchor || !Number.isSafeInteger(anchor.number) || !HEX(64).test(String(anchor.blockHash).toLowerCase())) fail("no_anchor", "an authenticated anchor { number, blockHash } is required");
  const top = headers[headers.length - 1];
  if (top.number !== anchor.number || String(top.hash).toLowerCase() !== String(anchor.blockHash).toLowerCase()) fail("anchor_mismatch", "the header range does not end at the anchor block");
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (!Number.isSafeInteger(h.number) || !HEX(64).test(String(h.hash).toLowerCase()) || !HEX(64).test(String(h.parentHash).toLowerCase()) || !HEX(64).test(String(h.receiptsRoot).toLowerCase())) fail("bad_input", `header ${i} is malformed`);
    if (i > 0) {
      const p = headers[i - 1];
      if (h.number !== p.number + 1) fail("discontinuity", `header ${h.number} does not follow ${p.number}`);
      if (String(h.parentHash).toLowerCase() !== String(p.hash).toLowerCase()) fail("unlinked", `header ${h.number} does not link to ${p.number}`);
    }
  }
  const candidates = [];
  for (const h of headers) if (mayHoldLeaseLog(h.logsBloom, filter, keccak)) candidates.push({ number: h.number, hash: String(h.hash).toLowerCase(), receiptsRoot: String(h.receiptsRoot).toLowerCase() });
  return { lo: headers[0].number, hi: top.number, candidates, skipped: headers.length - candidates.length };
}

/**
 * The complete lease logs of a plan. receipts: Map(blockHash -> { receiptsRoot, logs }) where receiptsRoot is the root
 * the CALLER recomputed from the full receipt list (not a label from the backend). Every candidate must be present and
 * its recomputed root must equal the linked header's. -> logs ascending (blockNumber, logIndex), matching the filter.
 */
export function assembleCompleteLogs(plan, receipts, { ledger, id, topic0s }) {
  const out = [];
  const addr = String(ledger).toLowerCase(), want = String(id).toLowerCase(), t0 = new Set(topic0s.map((t) => String(t).toLowerCase()));
  for (const c of plan.candidates) {
    const r = receipts.get(c.hash);
    if (!r) fail("incomplete", `block ${c.number} may hold a lease log and its receipts were not read`);
    if (String(r.receiptsRoot).toLowerCase() !== c.receiptsRoot) fail("receipts_root", `block ${c.number}'s receipts do not hash to its receiptsRoot`);
    for (const l of r.logs) {
      if (String(l.blockHash).toLowerCase() !== c.hash || l.blockNumber !== c.number) fail("bad_input", `a log of block ${c.number} names another block`);
      const topics = (l.topics || []).map((t) => String(t).toLowerCase());
      if (String(l.address).toLowerCase() === addr && t0.has(topics[0]) && topics[1] === want) out.push(l);
    }
  }
  return out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

/** OutputRoot v0 (base/base crates/consensus/protocol/src/output_root.rs): keccak(0^32 || stateRoot || bridgeStorageRoot || blockHash). */
export function outputRootV0({ stateRoot, bridgeStorageRoot, blockHash }, keccak) {
  const b = new Uint8Array(128);
  b.set(hexBytes(stateRoot, 32), 32); b.set(hexBytes(bridgeStorageRoot, 32), 64); b.set(hexBytes(blockHash, 32), 96);
  return toHex(keccak(b));
}
/** The anchor block of a finalized game's rootClaim, once its preimage is shown. -> { number, blockHash } */
export function anchorFromOutputRoot(rootClaim, l2BlockNumber, preimage, keccak) {
  if (outputRootV0(preimage, keccak) !== String(rootClaim).toLowerCase()) fail("output_root", "the preimage does not hash to the game's root claim");
  if (!Number.isSafeInteger(l2BlockNumber) || l2BlockNumber < 1) fail("bad_input", "bad L2 block number");
  return { number: l2BlockNumber, blockHash: String(preimage.blockHash).toLowerCase() };
}
