// UNREVIEWED SOURCE (unified-funding client-repair-r3). Receipt binding and exact event proofs, shared by normal
// execution and reconciliation. Two different facts are kept apart:
//   canonicalReceipt  -> the receipt is in the canonical chain AT OBSERVATION (it can still be reorged out);
//   receiptFinality   -> the node's "finalized" head is at/after the receipt's block and the header at that exact height
//                        has the receipt's number and hash.
// null = not (yet) canonical: absent, pending, zero-hash preconfirmation, header not visible yet, or reorged out.
// A throw = malformed or contradictory identity (never "pending").
import { decodeEventLog, parseAbi } from "../../../source/node_modules/viem/_esm/index.js";
import { fail, lower, sameAddr } from "./util.mjs";

const QTY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const H32 = /^0x[0-9a-f]{64}$/;
const ADDR = /^0x[0-9a-f]{40}$/;
const HEX = /^0x([0-9a-f]{2})*$/;
export const ZERO32 = `0x${"0".repeat(64)}`;

const str = (v) => (typeof v === "string" ? v.toLowerCase() : "");
function qty(v, name) {
  const s = str(v);
  if (!QTY.test(s)) fail("receipt_malformed", `${name} is not a canonical hex quantity`);
  return BigInt(s);
}
function h32(v, name) {
  const s = str(v);
  if (!H32.test(s)) fail("receipt_malformed", `${name} is not a 32-byte hash`);
  return s;
}
const toQty = (n) => `0x${n.toString(16)}`;

export async function canonicalReceipt(rpc, txHash) {
  const h = h32(txHash, "txHash");
  if (h === ZERO32) fail("receipt_malformed", "txHash is zero");
  const rc = await rpc("eth_getTransactionReceipt", [h]);
  if (rc === null || rc === undefined) return null;
  if (typeof rc !== "object" || Array.isArray(rc)) fail("receipt_malformed", "receipt is not an object");
  for (const k of ["transactionHash", "transactionIndex", "blockHash", "blockNumber", "status", "logs"]) {
    if (!(k in rc)) fail("receipt_malformed", `receipt lacks ${k}`);
  }
  if (rc.blockHash === null || rc.blockNumber === null) return null;              // pending
  const bh = h32(rc.blockHash, "receipt.blockHash");
  if (bh === ZERO32) return null;                                                  // preconfirmation
  const bn = qty(rc.blockNumber, "receipt.blockNumber");
  if (bn === 0n) fail("receipt_malformed", "receipt.blockNumber is zero");
  if (h32(rc.transactionHash, "receipt.transactionHash") !== h) fail("receipt_identity", "the receipt is for another transaction");
  const ti = qty(rc.transactionIndex, "receipt.transactionIndex");
  const st = str(rc.status);
  if (st !== "0x1" && st !== "0x0") fail("receipt_status_unknown", `receipt.status ${String(rc.status)} is neither 0x1 nor 0x0`);
  if (!Array.isArray(rc.logs)) fail("receipt_malformed", "receipt.logs is not an array");

  const blk = await rpc("eth_getBlockByNumber", [toQty(bn), false]);
  if (blk === null || blk === undefined) return null;                             // header not visible at this node yet
  if (qty(blk.number, "block.number") !== bn) fail("receipt_identity", "the canonical header at that height has another number");
  const hh = h32(blk.hash, "block.hash");
  if (hh === ZERO32) fail("receipt_malformed", "canonical header hash is zero");
  if (hh !== bh) return null;                                                      // reorged out (or never canonical)
  if (!Array.isArray(blk.transactions)) fail("receipt_malformed", "block.transactions is not an array");
  const at = blk.transactions[Number(ti)];
  if (str(typeof at === "string" ? at : at?.hash) !== h) fail("receipt_identity", "the transaction is not at its index in the canonical block");

  const seen = new Set();
  rc.logs.forEach((l, k) => {
    const n = `logs[${k}]`;
    if (l === null || typeof l !== "object") fail("receipt_malformed", `${n} is not an object`);
    if (l.removed !== false) fail("receipt_log_removed", `${n}.removed must be exactly false`);
    if (h32(l.transactionHash, `${n}.transactionHash`) !== h) fail("receipt_identity", `${n} belongs to another transaction`);
    if (h32(l.blockHash, `${n}.blockHash`) !== bh) fail("receipt_identity", `${n} belongs to another block`);
    if (qty(l.blockNumber, `${n}.blockNumber`) !== bn) fail("receipt_identity", `${n} has another block number`);
    if (qty(l.transactionIndex, `${n}.transactionIndex`) !== ti) fail("receipt_identity", `${n} has another transaction index`);
    const li = qty(l.logIndex, `${n}.logIndex`);
    if (seen.has(li)) fail("receipt_malformed", `${n}.logIndex repeats`);
    seen.add(li);
    if (!ADDR.test(str(l.address))) fail("receipt_malformed", `${n}.address`);
    if (!Array.isArray(l.topics) || l.topics.length > 4) fail("receipt_malformed", `${n}.topics`);
    l.topics.forEach((t, j) => h32(t, `${n}.topics[${j}]`));
    if (!HEX.test(str(l.data))) fail("receipt_malformed", `${n}.data`);
  });
  if (st === "0x0") fail("tx_reverted", `transaction ${h} reverted on chain`, { txHash: h });
  return rc;
}

/** Finality is a separate, later fact about an ALREADY canonical receipt. Both headers are validated: the finalized head
 *  (valid nonzero number and hash) and the header at the receipt height (exactly the receipt's number and hash). Any
 *  mismatch is a contradiction (throws), never "not final yet". */
export async function receiptFinality(rpc, rc) {
  const bn = qty(rc.blockNumber, "receipt.blockNumber");
  const bh = h32(rc.blockHash, "receipt.blockHash");
  if (bn === 0n || bh === ZERO32) fail("receipt_malformed", "receipt block identity is zero");
  const fin = await rpc("eth_getBlockByNumber", ["finalized", false]);
  if (!fin) return Object.freeze({ canonicalAtObservation: true, final: false, finalizedNumber: null });
  const fn = qty(fin.number, "finalized.number");
  const fh = h32(fin.hash, "finalized.hash");
  if (fn === 0n || fh === ZERO32) fail("receipt_malformed", "the finalized header identity is zero");
  if (fn < bn) return Object.freeze({ canonicalAtObservation: true, final: false, finalizedNumber: fn });
  const at = await rpc("eth_getBlockByNumber", [toQty(bn), false]);
  if (!at) fail("receipt_reorged", "no header at the receipt height although it is below the finalized head");
  if (qty(at.number, "header.number") !== bn) fail("receipt_identity", "the header at the receipt height has another number");
  const ah = h32(at.hash, "header.hash");
  if (fn === bn && ah !== fh) fail("receipt_identity", "finalized head and header at the same height differ");
  if (ah !== bh) fail("receipt_reorged", "the receipt's block is not in the finalized chain");
  return Object.freeze({ canonicalAtObservation: true, final: true, finalizedNumber: fn });
}

// =====================================================================================================================
// Exact event proofs (events from the deployed sources: SessionVault.sol / FundingSessionVault.sol, FiatToken v2)
// =====================================================================================================================

export const VAULT_EVENTS = parseAbi([
  "event SessionOpened(bytes32 indexed sid, bytes32 indexed keyHash, uint64 expiresAt, uint256 actions, uint8 envs, uint256 budget6, string label)",
  "event SessionEnded(bytes32 indexed sid, uint8 reason, uint256 refund6, uint256 fee6)",
]);
export const USDC_EVENTS = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
]);
export const END_REASON_OWNER = 1;                 // SessionVault.terminate -> _end(sid, s, 1, 0)

/** Decoded events of `abi` emitted by `address`. A known signature that fails strict decoding is an error. */
export function eventsOf(rc, address, abi) {
  const out = [];
  for (const l of rc.logs) {
    if (!sameAddr(l.address, address)) continue;
    let ev;
    try { ev = decodeEventLog({ abi, topics: l.topics, data: l.data, strict: true }); }
    catch (e) {
      if (e?.name === "AbiEventSignatureNotFoundError") continue;
      fail("log_decode", `log ${l.logIndex} does not decode: ${e?.shortMessage ?? e?.message}`);
    }
    out.push({ name: ev.eventName, args: ev.args, logIndex: l.logIndex });
  }
  return out;
}
const one = (list, code, what) => {
  if (list.length !== 1) fail(code, `expected exactly one ${what}, found ${list.length}`);
  return list[0];
};

/** Owner termination: exactly one SessionEnded(oldSid, reason 1, refund = full balance, fee 0) from the vault and exactly
 *  one USDC Transfer(vault -> owner, refund). Not-live alone is never accepted (expiry/revocation refunds nothing here). */
export function proveEnded(rc, { vault, usdc, owner, sid, refund6 }) {
  const ended = one(eventsOf(rc, vault, VAULT_EVENTS).filter((e) => e.name === "SessionEnded" && lower(e.args.sid) === lower(sid)),
    "terminate_log", `SessionEnded for ${sid}`);
  if (Number(ended.args.reason) !== END_REASON_OWNER) fail("terminate_reason", `SessionEnded reason ${ended.args.reason} is not owner termination`);
  if (BigInt(ended.args.refund6) !== BigInt(refund6) || BigInt(ended.args.fee6) !== 0n) {
    fail("terminate_refund", `refund ${ended.args.refund6} / fee ${ended.args.fee6} is not ${refund6} / 0`);
  }
  one(eventsOf(rc, usdc, USDC_EVENTS).filter((e) => e.name === "Transfer" && sameAddr(e.args.from, vault) && sameAddr(e.args.to, owner)
    && BigInt(e.args.value) === BigInt(refund6)), "terminate_transfer", "USDC refund transfer vault -> owner");
  return Object.freeze({ kind: "ended", sid: lower(sid), refund6: BigInt(refund6) });
}

/** Funded open: exactly one SessionOpened(sid, keyHash, exact scope, budget) from the vault, exactly one
 *  AuthorizationUsed(owner, grantDigest) and exactly one Transfer(owner -> vault, budget) from USDC. */
export function proveOpened(rc, { vault, usdc, owner, sid, keyHash, digest, amount6, expiresAt, actions, envs }) {
  const o = one(eventsOf(rc, vault, VAULT_EVENTS).filter((e) => e.name === "SessionOpened" && lower(e.args.sid) === lower(sid)),
    "open_log", `SessionOpened for ${sid}`);
  const bad = [];
  if (lower(o.args.keyHash) !== lower(keyHash)) bad.push("keyHash");
  if (BigInt(o.args.budget6) !== BigInt(amount6)) bad.push("budget6");
  if (BigInt(o.args.expiresAt) !== BigInt(expiresAt)) bad.push("expiresAt");
  if (BigInt(o.args.actions) !== BigInt(actions)) bad.push("actions");
  if (Number(o.args.envs) !== Number(envs)) bad.push("envs");
  if (bad.length) fail("open_scope", `SessionOpened differs in [${bad}]`, { bad });
  const u = eventsOf(rc, usdc, USDC_EVENTS);
  one(u.filter((e) => e.name === "AuthorizationUsed" && sameAddr(e.args.authorizer, owner) && lower(e.args.nonce) === lower(digest)),
    "open_authorization", "AuthorizationUsed(owner, grant digest)");
  one(u.filter((e) => e.name === "Transfer" && sameAddr(e.args.from, owner) && sameAddr(e.args.to, vault) && BigInt(e.args.value) === BigInt(amount6)),
    "open_transfer", "USDC deposit transfer owner -> vault");
  return Object.freeze({ kind: "opened", sid: lower(sid), amount6: BigInt(amount6) });
}
