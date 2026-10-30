// UNREVIEWED SOURCE, NOT RUN (execute-expiry-recovery-r1, on the canonical client-execution-recovery-r1 source). Successor
// gas.fund EXECUTION + durable RECOVERY for the funding client. Everything else stays the unchanged client-repair-r4 core
// (imported, never copied or edited here).
//
// Replaces r4 confirmGasFund / quoteGasFund (r4 keeps its originals; the successor browser entry re-exports these names
// explicitly). Root's three regressions (root-regression.test.mjs) show r4 journaling `refused` for a body lost after
// HTTP 200 headers and for a gateway 502, and keeping no exact call to verify a settlement after reload.
//
// Rules implemented here:
//   1. Bind before signing: the supplied review is re-derived with the reviewed codec (buildGasFundCall) for THIS
//      runtime and THIS stored gas record (owner / chain / vault / relay / key / sid); the digest, args, argsHash,
//      execute fields, domain and maximum must all match, and only the re-derived digest is signed.
//   2. Durable PUBLIC intent before send: runtime identity, record identity (public key only), relay, sid, nonce,
//      deployment, holder, the exact encoded call, its domain, digest and maximum, and a pinned chain anchor read
//      BEFORE send. No private key, no signature, no execute body is ever journaled (r4 assertPublic still enforces it).
//   3. Atomic admission: compare-and-set create of gas-exec:<sid>:<nonce> (never a blind put), then a re-check that no
//      other unresolved execution of the same session exists, then CAS admitted -> dispatching IMMEDIATELY before the
//      request. A crash before that marker provably sent nothing ("never_dispatched" on explicit reconcile).
//   4. Outcome classification is conservative: ONLY a well-formed relay error whose (HTTP status, code) pair is in
//      DEFINITIVE_REFUSALS - codes both successor routes raise before simulateAndSend - is "refused". Transport errors,
//      a body lost after headers, malformed JSON, any 5xx (the relay's own 502 settlement_* answers come AFTER a send),
//      the host's 409 "revert" (also raised for an ON-CHAIN revert after send), 409 "reverted", and a 200 without a valid
//      txHash are all "unknown" (or "pending" with a hash). Nothing unknown ever unlocks a fresh spend. The one exception
//      is the PAGE's own guard (flows.js guardRelayFn), which throws a StateError "context_changed" before it calls the
//      relay at all: that, and only that error class, is recorded "abandoned_before_send".
//   5. Read-only reconciliation (reconcileGasExecution): never signs, never POSTs, never invents a hash. It first
//      re-verifies the COMPLETE stored intent; tx hashes (journaled hints, the relay's session index) and bounded logs are
//      only candidates, each proven with the unchanged canonicalReceipt, the exact transaction (target vault, decoded
//      execute(sid, nonce, 10, args, fee, deadline, x, y)), the codec settlement proof (verifySettlement) and the
//      unchanged receiptFinality. Canonical is not final: "observed" blocks until a later reconcile proves finality, and a
//      receipt that is no longer canonical moves the entry back to "unknown" with its evidence kept in history.
//   6. Quote gate: any unresolved execution of the session blocks quoteGasFund; only final settlements, final proven
//      supersession, definitive refusals, provably undispatched admissions and proven expired-unused calls clear.
//   7. execute-expiry-recovery-r1. "expired_unused" (proveExpiredUnused) is a CHAIN proof, never an inference from
//      silence, logs or a 5xx: the node's FINALIZED Base header, re-read by number (same number, hash, timestamp), has a
//      timestamp strictly after BOTH the call deadline and the intent deadline (execute reverts Expired once
//      block.timestamp > deadline, and every later block is later still); at that pinned block the vault's code is the
//      exact EIP-1167 clone of the verified implementation, the implementation's code hash is the verified pin, and
//      vault.seqOf(sid, nonce >> 64) equals the stored sequence (nonce & 2^64-1), i.e. the nonce is unconsumed; the
//      pinned header and the finalized head are re-checked afterwards. latest / pending / safe / head and "no logs" are
//      never used. Any missing, malformed, zero, non-canonical or inconsistent fact fails closed (status unchanged).
//      The proven call can never execute, so a USER-requested new quote may carry the SAME on-chain nonce: confirmGasFund
//      re-proves the expiry FRESH (and re-checks the stored proof's header) before it CAS-replaces the entry with the new
//      intent, which keeps every earlier attempt verbatim (public intent, intentHash, outcome, evidence, history) in a
//      bounded, hash-bound `predecessors` list. Only expired_unused / refused / never_dispatched / abandoned_before_send
//      entries can be replaced, each only with that fresh proof; settled, superseded and every unresolved status never.
//      A digest already attempted for that nonce is refused. Nothing here loads, retries, signs or sends on its own.
import { decodeFunctionData, encodeFunctionData, keccak256 } from "viem";
import { ACTION_GAS_FUND, SESSION_OP_EVENT, SESSION_OP_TOPIC, buildGasFundCall, keyHashOf, predictVault } from "./funding-codec.mjs";
import { canon, fail, hashOf, lower, sameAddr } from "./util.mjs";
import { signerFor } from "./v2-store.mjs";
import { canonicalReceipt, eventsOf, receiptFinality } from "./chain-proof.mjs";
import { RelayError, pinBlock, quoteGasFund as quoteGasFundR4, verifySettlement } from "./funding-client.mjs";

export const EXEC_SCHEMA = "enclave-funding-gas-execute-r2";
export const MAX_DISCOVERY_BLOCKS = 600n;     // one eth_getLogs window from the persisted anchor (>= 900 s of Base blocks)
export const MAX_CANDIDATES = 16;             // candidate transactions examined per reconcile
export const MAX_PREDECESSORS = 4;            // earlier attempts kept per (sid, nonce); one more re-admission is refused

/** (HTTP status -> codes) raised by relay-owner-r2 and activation-r1 funding-route execute() BEFORE simulateAndSend.
 *  Deliberately absent: "revert" (the host's simulateAndSend also uses it for an on-chain revert after send),
 *  "intent_conflict" (another reservation already exists), "reverted", every 5xx, "not_sent", anything the host or a gateway might produce. */
export const DEFINITIVE_REFUSALS = Object.freeze({
  400: Object.freeze(["bad_request", "bad_action", "bad_args", "wrong_payer", "fee_tier_not_pinned", "bad_deadline"]),
  402: Object.freeze(["policy_refused"]),
  404: Object.freeze(["not_a_funding_vault", "unknown_deployment"]),
  409: Object.freeze(["not_live", "op_limit", "op_counter_exhausted", "nonce_lane_exhausted", "quote_exceeds_adapter",
    "expired", "quote_moved", "vault_identity"]),
});
/** Statuses that no longer reserve the session. Everything else (admitted, dispatching, unknown, pending,
 *  reverted_observed, observed, superseded_observed, ...) blocks the next quote and confirmation. */
export const CLEARED = Object.freeze(["settled", "superseded", "refused", "never_dispatched", "abandoned_before_send", "expired_unused"]);
/** Unresolved statuses a read-only reconcile may move to expired_unused (with the full chain proof only). */
export const EXPIRABLE = Object.freeze(["dispatching", "unknown", "pending", "reverted_observed"]);
/** Cleared statuses whose (sid, nonce) entry a NEW user-confirmed call may replace, each only after a fresh expiry proof. */
export const RELEASABLE = Object.freeze(["expired_unused", "refused", "never_dispatched", "abandoned_before_send"]);

const H32 = /^0x[0-9a-f]{64}$/;
const QTY = /^0x(0|[1-9a-f][0-9a-f]*)$/;
const DEC = /^(0|[1-9][0-9]*)$/;
const MASK64 = (1n << 64n) - 1n;
const isHash = (h) => typeof h === "string" && H32.test(lower(h)) && !/^0x0{64}$/.test(lower(h));
const normRelay = (r) => String(r ?? "").replace(/\/+$/, "");
const toQty = (n) => `0x${BigInt(n).toString(16)}`;
export const execId = (sid, nonce) => `gas-exec:${lower(sid)}:${BigInt(nonce)}`;

const EXECUTE_ABI = Object.freeze([{ type: "function", name: "execute", stateMutability: "nonpayable",
  inputs: [{ name: "sid", type: "bytes32" }, { name: "nonce", type: "uint256" }, { name: "action", type: "uint8" },
    { name: "args", type: "bytes" }, { name: "fee", type: "uint256" }, { name: "deadline", type: "uint64" },
    { name: "x", type: "uint256" }, { name: "y", type: "uint256" }, { name: "r", type: "bytes32" }, { name: "sv", type: "bytes32" }],
  outputs: [{ name: "result", type: "bytes" }] }]);
/** SessionVault: mapping(bytes32 => mapping(uint192 => uint64)) public seqOf; execute checks seqOf[sid][uint192(nonce >> 64)] == uint64(nonce). */
const SEQ_ABI = Object.freeze([{ type: "function", name: "seqOf", stateMutability: "view",
  inputs: [{ name: "", type: "bytes32" }, { name: "", type: "uint192" }], outputs: [{ name: "", type: "uint64" }] }]);
/** EIP-1167 runtime of FundingSessionVaultFactory's clone (the codec's predictVault init code minus its 10-byte constructor). */
const cloneRuntime = (impl) => `0x363d3d373d3d3d363d73${lower(impl).slice(2)}5af43d82803e903d91602b57fd5bf3`;

// =====================================================================================================================
// Identities and binding
// =====================================================================================================================

/** The verified runtime's contract identity (relayer excluded: it is stored separately as the expected submitter). */
export function runtimeIdentity(runtime) {
  const c = runtime?.cfg;
  if (!c) fail("runtime_missing", "no verified runtime");
  return { chainId: String(c.chainId ?? 8453), factory: lower(c.factory), implementation: lower(c.implementation),
    gasAdapter: lower(c.gasAdapter ?? ""), legacyFactory: lower(c.legacyFactory ?? ""), legacyVault: lower(c.legacyVault ?? ""),
    vault: lower(c.vault), owner: lower(c.owner), usdc: lower(runtime.pins?.usdc ?? "") };
}
/** The stored gas record's PUBLIC identity. */
export function recordIdentity(record) {
  return { id: String(record.id), keyHash: lower(record.keyHash), x: BigInt(record.x).toString(), y: BigInt(record.y).toString(),
    owner: lower(record.owner), vault: lower(record.vault), chainId: String(record.chainId), relay: normRelay(record.relay),
    sid: lower(record.sid) };
}
function requireRecordForRuntime(runtime, record, relayBase) {
  const c = runtime.cfg;
  if (!record || record.status !== "open" || !isHash(record.sid)) fail("session_not_open", "the gas record is not an open session");
  if (keyHashOf(BigInt(record.x), BigInt(record.y)) !== lower(record.keyHash)) fail("key_mismatch", "record public key and key hash disagree");
  if (!sameAddr(record.vault, c.vault) || !sameAddr(record.owner, c.owner) || Number(record.chainId) !== 8453) {
    fail("record_runtime_mismatch", "the gas record belongs to another owner, vault or chain than the verified runtime");
  }
  if (typeof relayBase !== "string" || normRelay(relayBase) !== normRelay(record.relay)) {
    fail("record_relay_mismatch", "the relay used now is not the relay this gas record was opened through");
  }
}
const sameJson = (a, b) => canon(a) === canon(b);

/** Re-derive the reviewed call for THIS runtime and record; every reviewed field must match. Returns the re-derived call. */
export function bindReview(runtime, record, review, now) {
  const c = review?.call;
  if (!c?.execute || !c.intent) fail("review_shape", "the review carries no codec call");
  const rebuilt = buildGasFundCall(runtime.cfg, { domainVersion: "2", now: BigInt(now), sessionId: lower(record.sid),
    nonce: BigInt(c.execute.nonce), action: ACTION_GAS_FUND, intent: c.intent, fee: BigInt(c.execute.fee), deadline: BigInt(c.execute.deadline) });
  const bad = [];
  if (lower(rebuilt.digest) !== lower(c.digest)) bad.push("digest");
  if (lower(rebuilt.args) !== lower(c.args)) bad.push("args");
  if (lower(rebuilt.argsHash) !== lower(c.argsHash)) bad.push("argsHash");
  if (lower(c.execute.sessionId) !== lower(record.sid)) bad.push("sessionId");
  if (Number(c.execute.action) !== ACTION_GAS_FUND) bad.push("action");
  if (c.typedData && !sameJson(c.typedData.domain, rebuilt.typedData.domain)) bad.push("domain");
  if (review.deployment !== undefined && lower(review.deployment) !== lower(rebuilt.intent.deployment)) bad.push("deployment");
  if (review.sid !== undefined && lower(review.sid) !== lower(record.sid)) bad.push("sid");
  const t = review.totals ?? {};
  if (BigInt(t.maxUsdcIn6 ?? -1) !== rebuilt.maximum.maxUsdcIn6 || BigInt(t.fee6 ?? -1) !== rebuilt.maximum.fee6
    || BigInt(t.totalMaximum6 ?? -1) !== rebuilt.maximum.totalMaximum6) bad.push("maximum");
  if (bad.length) fail("review_not_bound", `the review differs from its re-derivation in [${bad}]; nothing was signed`, { bad });
  return rebuilt;
}

function intentOf({ runtime, record, relayBase, call, now, anchor }) {
  const i = call.intent;
  return {
    runtime: runtimeIdentity(runtime), relayer: lower(runtime.relayer ?? ""), record: recordIdentity(record), relay: normRelay(relayBase),
    sid: lower(record.sid), nonce: BigInt(call.execute.nonce).toString(), deployment: lower(i.deployment), holder: lower(i.expectedOwner),
    call: {
      domain: { name: call.typedData.domain.name, version: String(call.typedData.domain.version),
        chainId: String(call.typedData.domain.chainId), verifyingContract: lower(call.typedData.domain.verifyingContract) },
      digest: lower(call.digest), argsHash: lower(call.argsHash), args: lower(call.args), action: String(ACTION_GAS_FUND),
      nonce: BigInt(call.execute.nonce).toString(), lane: BigInt(call.nonce.lane).toString(), seq: BigInt(call.nonce.seq).toString(),
      fee: BigInt(call.execute.fee).toString(), deadline: BigInt(call.execute.deadline).toString(), builtAt: BigInt(now).toString(),
      intent: { payer: lower(i.payer), deployment: lower(i.deployment), expectedOwner: lower(i.expectedOwner), ethOut: BigInt(i.ethOut).toString(),
        maxUsdcIn6: BigInt(i.maxUsdcIn6).toString(), fee: String(Number(i.fee)), deadline: BigInt(i.deadline).toString() },
    },
    maximum: { maxUsdcIn6: call.maximum.maxUsdcIn6.toString(), fee6: call.maximum.fee6.toString(), totalMaximum6: call.maximum.totalMaximum6.toString() },
    anchor: { number: anchor.number.toString(), hash: lower(anchor.hash), timestamp: anchor.timestamp.toString() },
  };
}
const INTENT_KEYS = ["runtime", "relayer", "record", "relay", "sid", "nonce", "deployment", "holder", "call", "maximum", "anchor"];
const intentPart = (e) => Object.fromEntries(INTENT_KEYS.map((k) => [k, e[k]]));

/** True when the entry still reserves its session. Pre-r2 entries (r4, no schema) clear only when `settled`: r4 could
 *  journal `refused` for an outcome that was in fact unknown. */
export function isBlocking(e) {
  if (!e || e.kind !== "gas-execute") return false;
  if (e.schema === EXEC_SCHEMA) return !CLEARED.includes(e.status);
  return e.status !== "settled";
}
/** The unresolved executions that block `record`'s session (exact sid; r2 entries also exact record id). */
export function executionBlockers(entries, record) {
  return (entries || []).filter((e) => isBlocking(e) && lower(e.sid) === lower(record.sid)
    && (e.schema !== EXEC_SCHEMA || e.record?.id === String(record.id)));
}

// =====================================================================================================================
// Outcome classification of the execute POST
// =====================================================================================================================

const hintHashes = (d) => [...new Set([d?.txHash, ...(Array.isArray(d?.txHashes) ? d.txHashes : [])].filter(isHash).map(lower))];
/** { kind: "refused" | "unknown", ... }. Only an explicit, well-formed, pre-admission relay refusal is "refused". */
export function classifyExecuteFailure(err) {
  if (err instanceof RelayError && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    const d = err.detail;
    const allowed = DEFINITIVE_REFUSALS[err.status];
    const wellFormed = d && typeof d === "object" && !Array.isArray(d) && d.code === err.code && typeof d.error === "string";
    if (allowed?.includes(err.code) && wellFormed && hintHashes(d).length === 0) {
      return { kind: "refused", code: err.code, status: err.status };
    }
  }
  const phase = err instanceof RelayError ? (err.status ? "http_error" : "transport") : err instanceof TypeError ? "body_or_transport" : "unclassified";
  return { kind: "unknown", code: String(err?.code ?? err?.name ?? "error"), status: Number.isInteger(err?.status) ? err.status : null,
    phase, hints: hintHashes(err?.detail) };
}
/** The page's own effect guard (flows.js guardRelayFn -> state.js StateError) refused BEFORE calling the relay. A relay
 *  error is always a RelayError or a fetch TypeError, never this class, so a relay cannot forge this outcome. */
const pageGuardCancelled = (err) => !(err instanceof RelayError) && !(err instanceof TypeError)
  && err?.name === "StateError" && err?.code === "context_changed";

// =====================================================================================================================
// Journal transitions (compare-and-set only; never putJournal)
// =====================================================================================================================

async function transition(store, id, from, mutate) {
  return store.casJournal(id, (cur) => {
    if (!cur || cur.schema !== EXEC_SCHEMA) fail("journal_changed", `${id} is missing or not a ${EXEC_SCHEMA} entry`);
    if (cur.intentHash !== from.intentHash || cur.status !== from.status || Number(cur.rev) !== Number(from.rev)) {
      fail("journal_changed", `${id} changed meanwhile (${cur.status}); nothing was overwritten`);
    }
    const next = mutate(cur) ?? cur;
    next.rev = Number(cur.rev) + 1;
    return next;
  });
}
const addHints = (e, hs) => { e.hints = { txHashes: [...new Set([...(e.hints?.txHashes ?? []), ...hs])].slice(0, MAX_CANDIDATES) }; };

// =====================================================================================================================
// confirmGasFund (successor): bind -> [release proof] -> anchor -> CAS admit -> re-check -> sign -> CAS dispatching -> POST
// =====================================================================================================================

/** dispatchGuard (optional): the page's synchronous guard check, run immediately before the dispatching marker. */
export async function confirmGasFund({ runtime, store, record, review, relay, relayBase, rpc, now, subtle, dispatchGuard }) {
  requireRecordForRuntime(runtime, record, relayBase);
  const call = bindReview(runtime, record, review, now);
  const e = call.execute;
  if (BigInt(now) > e.deadline) fail("call_deadline_passed", "the quote expired; quote again");
  const signer = signerFor(record.privateKey, BigInt(record.x), BigInt(record.y), subtle);
  if (signer.keyHash !== lower(record.keyHash)) fail("key_mismatch", "record key hash mismatch");
  const before = executionBlockers(await store.listJournal(), record);
  if (before.length) fail("unreconciled_execute", "an earlier gas.fund of this session is not resolved; reconcile it first (never resent)", { ids: before.map((x) => x.id) });
  const id = execId(record.sid, e.nonce);
  const prior = await store.getJournal(id);
  const release = prior ? await releasePrior(prior, { runtime, store, rpc, relayBase, call }) : null;   // read-only; throws unless proven
  const anchor = await pinBlock(rpc, now);                       // read BEFORE send: the bounded discovery anchor
  const body = intentOf({ runtime, record, relayBase, call, now, anchor });
  const entry = { id, kind: "gas-execute", schema: EXEC_SCHEMA, status: "admitted", rev: 1, at: Number(now), ...body,
    intentHash: hashOf(body), hints: { txHashes: [] }, evidence: null, outcome: null, lastReconcile: null, history: [] };
  if (release) {
    entry.rev = Number(release.prior.rev) + 1;
    entry.predecessors = [...(release.prior.predecessors ?? []), predecessorOf(release.prior, release.proof)];
    entry.predecessorsHash = hashOf(entry.predecessors);
  }
  const admitted = await store.casJournal(id, (cur) => {
    if (!cur && !release) return entry;
    const p = release?.prior;
    if (!cur || !p || cur.schema !== EXEC_SCHEMA || cur.status !== p.status || cur.intentHash !== p.intentHash
      || Number(cur.rev) !== Number(p.rev) || (cur.predecessorsHash ?? null) !== (p.predecessorsHash ?? null)) {
      fail("execute_exists", `${id} already exists (${cur?.status ?? "changed"}); never overwritten`);
    }
    return entry;
  });
  const abandon = async (reason) => transition(store, id, admitted, (cur) => { cur.status = "abandoned_before_send"; cur.outcome = { reason }; });
  const others = executionBlockers(await store.listJournal(), record).filter((x) => x.id !== id);
  if (others.length) {
    await abandon("concurrent_execution");
    fail("concurrent_execution", "another execution of this session was admitted concurrently; nothing was signed or sent", { ids: others.map((x) => x.id) });
  }
  const { r, s } = await signer.signDigest(lower(call.digest));   // memory only
  if (typeof dispatchGuard === "function") {
    try { dispatchGuard(); } catch (err) { await abandon("guard_before_dispatch"); throw err; }
  }
  const dispatching = await transition(store, id, admitted, (cur) => { cur.status = "dispatching"; });
  let out;
  try {
    out = await relay("POST", "/funding/execute", { vault: runtime.cfg.vault, sid: lower(record.sid), nonce: e.nonce, action: ACTION_GAS_FUND,
      args: e.args, fee: e.fee, deadline: e.deadline, x: signer.x, y: signer.y, r, s });
  } catch (err) {
    const c = pageGuardCancelled(err) ? { kind: "not_dispatched", code: "context_changed", status: null, phase: "page_guard_before_fetch" }
      : classifyExecuteFailure(err);
    await transition(store, id, dispatching, (cur) => {
      cur.status = c.kind === "refused" ? "refused" : c.kind === "not_dispatched" ? "abandoned_before_send" : "unknown";
      cur.outcome = { code: c.code, status: c.status, phase: c.phase ?? "relay_refusal", message: String(err?.message ?? "").slice(0, 300) };
      if (c.hints?.length) addHints(cur, c.hints);
    });
    throw err;
  }
  const hashes = hintHashes(out);
  if (hashes.length === 0) {
    await transition(store, id, dispatching, (cur) => { cur.status = "unknown"; cur.outcome = { code: "relay_malformed_success", phase: "success_body" }; });
    fail("relay_malformed_success", "the relay answered without a valid transaction hash; the execution is UNKNOWN (never resent)");
  }
  let cur = await transition(store, id, dispatching, (c) => { c.status = "pending"; c.outcome = { code: out.pending ? "relay_pending" : "relay_success" }; addHints(c, hashes); });
  if (out.pending) return { pending: true, txHash: hashes[0], id };
  const res = await proveCandidate(cur, hashes[0], runtime, rpc);
  if (res.kind !== "exact") return { pending: true, txHash: hashes[0], id, observation: res.kind };
  cur = await transition(store, id, cur, (c) => applyExact(c, res));
  if (out.settlement && BigInt(out.settlement.actual?.totalDebit6 ?? -1) !== BigInt(res.actual.totalDebit6)) {
    fail("relay_settlement_mismatch", "the relay's settlement differs from the canonical receipt (the chain proof is journaled)");
  }
  return { pending: false, txHash: res.txHash, id, final: res.final, status: cur.status,
    settlement: { actual: { usdcSpent6: BigInt(res.actual.usdcSpent6), fee6: BigInt(res.actual.fee6), totalDebit6: BigInt(res.actual.totalDebit6) } } };
}

/** The existing (sid, nonce) entry may be replaced by a NEW call only when it is a verified r2 entry in RELEASABLE, the
 *  bounded history has room, the new digest was never attempted for this nonce, a stored expired_unused proof is still
 *  canonical and final, and a FRESH proof at the current finalized head shows the old call can never execute. */
async function releasePrior(prior, { runtime, store, rpc, relayBase, call }) {
  if (prior.schema !== EXEC_SCHEMA || !RELEASABLE.includes(prior.status)) {
    fail("execute_exists", `${prior.id} already exists (${prior.status}); never overwritten`);
  }
  await verifyStoredIntent(prior, { runtime, store, relayBase });
  const preds = prior.predecessors ?? [];
  if (preds.length >= MAX_PREDECESSORS) {
    fail("predecessor_history_full", `${prior.id} already holds ${preds.length} earlier attempts; this nonce cannot be re-admitted again`);
  }
  if ([prior.call.digest, ...preds.map((p) => p.call.digest)].includes(lower(call.digest))) {
    fail("digest_reused", "this exact signed call was already attempted for this nonce; a new quote is required");
  }
  if (prior.status === "expired_unused") await recheckStoredExpiry(prior, rpc);
  const proof = await proveExpiredUnused(prior, runtime, rpc);
  return { prior, proof };
}
/** The complete public prior entry (minus its own flattened history list) plus the fresh release proof. */
function predecessorOf(prior, proof) {
  const { predecessors: _p, predecessorsHash: _h, ...rest } = prior;
  return { ...rest, release: proof };
}

// =====================================================================================================================
// Candidate proof (shared by confirm and reconcile): unchanged canonicalReceipt + exact tx binding + codec settlement
// =====================================================================================================================

async function txBinding(entry, h, rc, rpc) {
  const tx = await rpc("eth_getTransactionByHash", [h]);
  if (!tx || typeof tx !== "object") return { kind: "rejected", reason: "tx_unavailable" };
  if (lower(tx.hash) !== h) return { kind: "rejected", reason: "tx_identity" };
  if (rc && (lower(tx.blockHash) !== lower(rc.blockHash) || BigInt(tx.blockNumber ?? -1) !== BigInt(rc.blockNumber))) {
    return { kind: "rejected", reason: "tx_block_mismatch" };
  }
  if (!sameAddr(tx.to ?? "", entry.runtime.vault)) return { kind: "other", direct: false };
  let d;
  try { d = decodeFunctionData({ abi: EXECUTE_ABI, data: lower(tx.input ?? tx.data ?? "0x") }); } catch { return { kind: "other", direct: true }; }
  const [sid, nonce, action, args, fee, deadline, x, y] = d.args;
  if (lower(sid) !== entry.sid || BigInt(nonce) !== BigInt(entry.nonce)) return { kind: "other", direct: true };
  const exact = Number(action) === ACTION_GAS_FUND && lower(args) === entry.call.args && BigInt(fee) === BigInt(entry.call.fee)
    && BigInt(deadline) === BigInt(entry.call.deadline) && BigInt(x) === BigInt(entry.record.x) && BigInt(y) === BigInt(entry.record.y);
  return exact ? { kind: "exact" } : { kind: "same_nonce_other_call" };
}
const sessionOpsFor = (rc, entry) => eventsOf(rc, entry.runtime.vault, [SESSION_OP_EVENT])
  .filter((x) => x.name === "SessionOp" && lower(x.args.sid) === entry.sid && BigInt(x.args.nonce) === BigInt(entry.nonce));

/** { kind: exact | superseding | reverted_exact | not_canonical | not_ours | rejected | contradiction, ... } */
export async function proveCandidate(entry, txHash, runtime, rpc) {
  const h = lower(txHash);
  if (!isHash(h)) return { kind: "rejected", txHash: h, reason: "hash_malformed" };
  let rc;
  try { rc = await canonicalReceipt(rpc, h); }
  catch (e) {
    if (e?.code === "tx_reverted") {
      const b = await txBinding(entry, h, null, rpc);
      return b.kind === "exact" ? { kind: "reverted_exact", txHash: h } : { kind: "not_ours", txHash: h, reason: "reverted_other" };
    }
    return { kind: "rejected", txHash: h, reason: e?.code ?? "receipt_error" };
  }
  if (!rc) return { kind: "not_canonical", txHash: h };
  const b = await txBinding(entry, h, rc, rpc);
  if (b.kind === "rejected") return { ...b, txHash: h };
  let ops;
  try { ops = sessionOpsFor(rc, entry); } catch (e) { return { kind: "rejected", txHash: h, reason: e?.code ?? "log_decode" }; }
  if (b.kind === "exact") {
    let st;
    const pinned = { ...runtime, relayer: entry.relayer || runtime.relayer };   // the submitter expected at send time
    try {
      st = await verifySettlement({ runtime: pinned, rpc, txHash: h,
        call: { execute: { sessionId: entry.sid, nonce: BigInt(entry.nonce), fee: BigInt(entry.call.fee) }, args: entry.call.args } });
    } catch (e) { return { kind: "rejected", txHash: h, reason: e?.code ?? "settlement_error" }; }
    if (!st) return { kind: "not_canonical", txHash: h };
    let fin;
    try { fin = await receiptFinality(rpc, rc); } catch (e) { return { kind: "rejected", txHash: h, reason: e?.code ?? "finality_error" }; }
    return { kind: "exact", txHash: h, block: BigInt(rc.blockNumber).toString(), blockHash: lower(rc.blockHash), final: fin.final === true,
      finalizedNumber: fin.finalizedNumber === null ? null : String(fin.finalizedNumber),
      actual: { usdcSpent6: String(st.actual.usdcSpent6), fee6: String(st.actual.fee6), totalDebit6: String(st.actual.totalDebit6) } };
  }
  // not our exact transaction: does it CONSUME our nonce (another operation), or contain our exact op indirectly?
  if (ops.length === 0) return { kind: "not_ours", txHash: h };
  if (ops.length !== 1) return { kind: "contradiction", txHash: h, reason: "session_op_repeats" };
  if (lower(ops[0].args.argsHash) === entry.call.argsHash) {
    return { kind: "contradiction", txHash: h, reason: "exact_op_via_unbound_transaction" };   // a debit we cannot bind: review
  }
  let fin;
  try { fin = await receiptFinality(rpc, rc); } catch (e) { return { kind: "rejected", txHash: h, reason: e?.code ?? "finality_error" }; }
  return { kind: "superseding", txHash: h, block: BigInt(rc.blockNumber).toString(), blockHash: lower(rc.blockHash), final: fin.final === true,
    finalizedNumber: fin.finalizedNumber === null ? null : String(fin.finalizedNumber), otherArgsHash: lower(ops[0].args.argsHash) };
}
function keepHistory(c, why) {
  c.history = [...(c.history ?? []), { status: c.status, evidence: c.evidence ?? null, why }].slice(-20);
}
function applyExact(c, res) {
  if (c.evidence && c.evidence.txHash !== res.txHash) fail("evidence_conflict", "a different transaction was already proven for this call");
  keepHistory(c, "exact_settlement_proven");
  c.status = res.final ? "settled" : "observed";
  c.evidence = { kind: "settlement", txHash: res.txHash, block: res.block, blockHash: res.blockHash, final: res.final,
    finalizedNumber: res.finalizedNumber, actual: res.actual };
  addHints(c, [res.txHash]);
}
function applySuperseding(c, res) {
  keepHistory(c, "nonce_consumed_by_other_operation");
  c.status = res.final ? "superseded" : "superseded_observed";
  c.evidence = { kind: "superseded", txHash: res.txHash, block: res.block, blockHash: res.blockHash, final: res.final,
    finalizedNumber: res.finalizedNumber, otherArgsHash: res.otherArgsHash };
}

// =====================================================================================================================
// Expired-unused proof (READ-ONLY): finalized header past both deadlines + verified vault code + seqOf unconsumed
// =====================================================================================================================

const notProven = (reason, message, extra) => fail("expiry_not_proven", `expired-unused not proven: ${message}`, { reason, ...extra });

/** A header with canonical non-zero number, non-zero 32-byte hash and canonical non-zero timestamp; anything else refuses. */
function headerOf(b, name) {
  if (!b || typeof b !== "object" || Array.isArray(b)) notProven("header_missing", `no ${name} header`);
  const n = typeof b.number === "string" ? b.number.toLowerCase() : "";
  const h = typeof b.hash === "string" ? b.hash.toLowerCase() : "";
  const t = typeof b.timestamp === "string" ? b.timestamp.toLowerCase() : "";
  if (!QTY.test(n) || !H32.test(h) || !QTY.test(t)) notProven("header_malformed", `the ${name} header number/hash/timestamp is malformed`);
  if (BigInt(n) === 0n || !isHash(h) || BigInt(t) === 0n) notProven("header_zero", `the ${name} header identity is zero`);
  return { number: BigInt(n), hash: h, timestamp: BigInt(t) };
}
/** The node's finalized head, re-read by NUMBER: both lookups must agree on number, hash and timestamp. */
async function finalizedHeader(rpc) {
  const fin = headerOf(await rpc("eth_getBlockByNumber", ["finalized", false]), "finalized");
  const at = headerOf(await rpc("eth_getBlockByNumber", [toQty(fin.number), false]), "numbered");
  if (at.number !== fin.number) notProven("header_number_mismatch", "the header at the finalized number has another number");
  if (at.hash !== fin.hash || at.timestamp !== fin.timestamp) notProven("header_hash_mismatch", "the finalized head and the header at its number differ");
  return fin;
}
/** The stored entry's own facts the proof depends on, each canonical, non-zero and mutually consistent with this runtime. */
function expiryTerms(entry, runtime) {
  const dec = (v, name) => {
    if (typeof v !== "string" || !DEC.test(v)) notProven("metadata_malformed", `${name} is not a canonical decimal`);
    return BigInt(v);
  };
  const c = entry?.call;
  if (!c || !entry.runtime || !entry.record || !entry.anchor) notProven("metadata_missing", "the stored call is incomplete");
  if (entry.runtime.chainId !== "8453" || entry.record.chainId !== "8453" || c.domain?.chainId !== "8453"
    || Number(runtime?.cfg?.chainId) !== 8453) notProven("wrong_chain", "the stored call or the runtime is not for Base 8453");
  if (!isHash(entry.sid)) notProven("metadata_malformed", "sid");
  const nonce = dec(entry.nonce, "nonce");
  const lane = dec(c.lane, "call.lane");
  const seq = dec(c.seq, "call.seq");
  if (dec(c.nonce, "call.nonce") !== nonce || lane !== nonce >> 64n || seq !== (nonce & MASK64)) {
    notProven("lane_inconsistent", "the stored lane/sequence is not the decomposition (nonce >> 64, nonce & 2^64-1) of the nonce");
  }
  if (seq === MASK64) notProven("metadata_malformed", "the sequence is the lane's last value");
  const deadline = dec(c.deadline, "call.deadline");
  const intentDeadline = dec(c.intent?.deadline, "call.intent.deadline");
  if (deadline === 0n || intentDeadline === 0n) notProven("metadata_zero", "a deadline is zero");
  const anchorNumber = dec(entry.anchor.number, "anchor.number");
  const vault = lower(runtime.cfg.vault);
  const impl = lower(runtime.cfg.implementation);
  if (entry.runtime.vault !== vault || entry.record.vault !== vault || c.domain.verifyingContract !== vault
    || entry.runtime.implementation !== impl
    || lower(predictVault(runtime.cfg.factory, runtime.cfg.implementation, runtime.cfg.owner)) !== vault) {
    notProven("vault_mismatch", "the vault is not the verified factory clone of the verified implementation");
  }
  const implCodehash = lower(runtime.pins?.codehashes?.implementation ?? "");
  if (!isHash(implCodehash)) notProven("runtime_pins_missing", "the verified runtime carries no implementation code hash pin");
  return { nonce, lane, seq, deadline, intentDeadline, anchorNumber, vault, impl, implCodehash };
}

/** READ-ONLY. Returns the public proof object or throws `expiry_not_proven` (detail.reason). Never writes. */
export async function proveExpiredUnused(entry, runtime, rpc) {
  const t = expiryTerms(entry, runtime);
  const chainId = await rpc("eth_chainId", []);
  if (typeof chainId !== "string" || !QTY.test(chainId.toLowerCase()) || BigInt(chainId) !== 8453n) notProven("wrong_chain", "the RPC is not Base 8453");
  const fin = await finalizedHeader(rpc);
  if (!(fin.timestamp > t.deadline && fin.timestamp > t.intentDeadline)) {
    notProven("not_past_deadline", `the finalized header (${fin.timestamp}) is not strictly after both deadlines`, { finalizedTimestamp: String(fin.timestamp) });
  }
  if (fin.number <= t.anchorNumber) notProven("not_after_anchor", "the finalized header is not after the pre-send anchor");
  const tag = toQty(fin.number);
  const vcode = await rpc("eth_getCode", [t.vault, tag]);
  if (typeof vcode !== "string" || vcode.toLowerCase() !== cloneRuntime(t.impl)) {
    notProven("vault_code_mismatch", "the vault's code at the pinned block is not the clone of the verified implementation");
  }
  const icode = await rpc("eth_getCode", [t.impl, tag]);
  if (typeof icode !== "string" || !/^0x([0-9a-f]{2})+$/.test(icode.toLowerCase()) || lower(keccak256(icode.toLowerCase())) !== t.implCodehash) {
    notProven("implementation_code_mismatch", "the implementation's code at the pinned block differs from its verified pin");
  }
  const out = await rpc("eth_call", [{ to: t.vault, data: encodeFunctionData({ abi: SEQ_ABI, functionName: "seqOf", args: [entry.sid, t.lane] }) }, tag]);
  if (typeof out !== "string" || !H32.test(out.toLowerCase()) || BigInt(out) > MASK64) notProven("seq_malformed", "seqOf returned no uint64 word");
  const onchain = BigInt(out);
  if (onchain > t.seq) notProven("nonce_consumed", `seqOf(sid, ${t.lane}) is ${onchain} > ${t.seq}: the nonce was consumed`, { seqOf: String(onchain) });
  if (onchain !== t.seq) notProven("seq_mismatch", `seqOf(sid, ${t.lane}) is ${onchain}, not the stored ${t.seq}`, { seqOf: String(onchain) });
  // re-check: the pinned header is still the one at its number, and the finalized head did not move below / off it
  const again = headerOf(await rpc("eth_getBlockByNumber", [tag, false]), "pinned recheck");
  if (again.number !== fin.number || again.hash !== fin.hash) notProven("reorged", "the pinned header was replaced while it was read");
  const fin2 = headerOf(await rpc("eth_getBlockByNumber", ["finalized", false]), "finalized recheck");
  if (fin2.number < fin.number || (fin2.number === fin.number && fin2.hash !== fin.hash)) notProven("reorged", "the finalized head moved off the pinned header");
  return { kind: "expired_unused", chainId: "8453", block: fin.number.toString(), blockHash: fin.hash, timestamp: fin.timestamp.toString(),
    lane: t.lane.toString(), seq: t.seq.toString(), seqOf: onchain.toString(), callDeadline: t.deadline.toString(),
    intentDeadline: t.intentDeadline.toString(), digest: entry.call.digest, intentHash: entry.intentHash, vault: t.vault,
    vaultCodehash: lower(keccak256(cloneRuntime(t.impl))), implementationCodehash: t.implCodehash };
}
/** READ-ONLY. A stored expired_unused proof is still usable only while its header is canonical at its number and final. */
async function recheckStoredExpiry(entry, rpc) {
  const ev = entry.evidence;
  if (ev?.kind !== "expired_unused" || typeof ev.block !== "string" || !DEC.test(ev.block) || !isHash(ev.blockHash)
    || ev.intentHash !== entry.intentHash || ev.digest !== entry.call.digest || ev.seq !== entry.call.seq || ev.lane !== entry.call.lane) {
    notProven("evidence_malformed", "the stored expired-unused evidence is incomplete or not for this call");
  }
  const n = BigInt(ev.block);
  const fin = headerOf(await rpc("eth_getBlockByNumber", ["finalized", false]), "finalized");
  const at = headerOf(await rpc("eth_getBlockByNumber", [toQty(n), false]), "evidence");
  if (at.number !== n) notProven("header_number_mismatch", "the header at the evidence number has another number");
  if (at.hash !== ev.blockHash || fin.number < n || (fin.number === n && fin.hash !== ev.blockHash)) {
    notProven("evidence_reorged", "the stored expiry header is no longer the finalized canonical header at its number");
  }
  return { finalizedNumber: fin.number.toString(), evidenceBlock: ev.block };
}

// =====================================================================================================================
// Stored-intent verification and READ-ONLY reconciliation
// =====================================================================================================================

/** Throws `intent_invalid` unless the stored entry is complete, self-consistent (intentHash), re-derives with the codec
 *  for THIS runtime, and its record identity is exactly this browser's stored gas record. */
export async function verifyStoredIntent(entry, { runtime, store, relayBase }) {
  const bad = (why) => fail("intent_invalid", `stored execution ${entry?.id} cannot be trusted: ${why}`, { why });
  if (!entry || entry.kind !== "gas-execute" || entry.schema !== EXEC_SCHEMA) bad("not an r2 execution entry");
  for (const k of INTENT_KEYS) if (entry[k] === undefined || entry[k] === null) bad(`missing ${k}`);
  if (hashOf(intentPart(entry)) !== entry.intentHash) bad("intentHash mismatch (edited entry)");
  if (entry.id !== execId(entry.sid, entry.nonce)) bad("id does not match sid/nonce");
  if (!sameJson(runtimeIdentity(runtime), entry.runtime)) bad("the verified runtime differs from the one the call was built for");
  if (normRelay(relayBase) !== entry.relay) bad("another relay");
  const rec = await store.loadKey(entry.record.id);
  if (!rec) bad("its gas record is missing");
  const ri = recordIdentity(rec);
  if (!sameJson({ ...ri, sid: entry.record.sid }, entry.record) || lower(rec.sid) !== entry.sid) bad("its gas record differs");
  let rebuilt;
  try {
    const i = entry.call.intent;
    rebuilt = buildGasFundCall(runtime.cfg, { domainVersion: "2", now: BigInt(entry.call.builtAt), sessionId: entry.sid, nonce: BigInt(entry.call.nonce),
      action: ACTION_GAS_FUND, intent: { payer: i.payer, deployment: i.deployment, expectedOwner: i.expectedOwner, ethOut: BigInt(i.ethOut),
        maxUsdcIn6: BigInt(i.maxUsdcIn6), fee: Number(i.fee), deadline: BigInt(i.deadline) },
      fee: BigInt(entry.call.fee), deadline: BigInt(entry.call.deadline) });
  } catch (e) { bad(`the codec refuses the stored call (${e?.code ?? e?.message})`); }
  const d = rebuilt.typedData.domain;
  if (lower(rebuilt.digest) !== entry.call.digest || lower(rebuilt.args) !== entry.call.args || lower(rebuilt.argsHash) !== entry.call.argsHash
    || d.name !== entry.call.domain.name || String(d.version) !== entry.call.domain.version || String(d.chainId) !== entry.call.domain.chainId
    || lower(d.verifyingContract) !== entry.call.domain.verifyingContract || entry.call.nonce !== entry.nonce
    || rebuilt.maximum.totalMaximum6.toString() !== entry.maximum.totalMaximum6) bad("the stored call does not re-derive to its digest/args/domain/maximum");
  if (!/^\d+$/.test(entry.anchor.number) || !isHash(entry.anchor.hash)) bad("malformed anchor");
  if (entry.predecessors !== undefined || entry.predecessorsHash !== undefined) verifyPredecessors(entry, bad);
  return rebuilt;
}
/** Earlier attempts of this (sid, nonce): bounded, hash-bound, each a complete self-consistent public intent that was
 *  released by an expired-unused proof for exactly that intent, and no signed digest appears twice. */
function verifyPredecessors(entry, bad) {
  const ps = entry.predecessors;
  if (!Array.isArray(ps) || ps.length === 0 || ps.length > MAX_PREDECESSORS) bad("malformed predecessor history");
  if (entry.predecessorsHash !== hashOf(ps)) bad("predecessor history edited");
  const seen = new Set([entry.call.digest]);
  for (const p of ps) {
    if (!p || p.kind !== "gas-execute" || p.schema !== EXEC_SCHEMA || p.id !== entry.id || p.sid !== entry.sid || p.nonce !== entry.nonce) bad("predecessor identity");
    for (const k of INTENT_KEYS) if (p[k] === undefined || p[k] === null) bad(`predecessor missing ${k}`);
    if (hashOf(intentPart(p)) !== p.intentHash) bad("predecessor intentHash mismatch");
    if (!RELEASABLE.includes(p.status) || p.release?.kind !== "expired_unused" || p.release.intentHash !== p.intentHash
      || p.release.digest !== p.call.digest) bad("predecessor without its expired-unused release");
    if (seen.has(p.call.digest)) bad("a signed digest repeats in the predecessor history");
    seen.add(p.call.digest);
  }
}

/** Relay hints: the relay's own session index (GET only). Any failure is "no hint", never a refusal. */
async function relayHints(relay, entry) {
  if (typeof relay !== "function") return [];
  try {
    const v = await relay("GET", `/funding/session/${entry.runtime.vault}/${entry.sid}`);
    return (Array.isArray(v?.ops) ? v.ops : []).filter((o) => String(o?.nonce) === entry.nonce).map((o) => o.tx).filter(isHash).map(lower);
  } catch { return []; }
}
/** Bounded log discovery: ONE eth_getLogs over [anchor, min(anchor + MAX_DISCOVERY_BLOCKS, latest)] for the vault's
 *  SessionOp(sid) events. Logs are only candidates; a log marked removed is rejected. */
async function discover(rpc, entry, limits) {
  const span = BigInt(limits?.maxBlocks ?? MAX_DISCOVERY_BLOCKS);
  if (span <= 0n || span > MAX_DISCOVERY_BLOCKS) fail("discovery_bounds", `maxBlocks must be 1..${MAX_DISCOVERY_BLOCKS}`);
  const latest = await rpc("eth_getBlockByNumber", ["latest", false]);
  const from = BigInt(entry.anchor.number);
  const head = BigInt(latest?.number ?? -1);
  if (head < from) return { hashes: [], window: { from: entry.anchor.number, to: null, complete: false }, rejected: [] };
  const to = from + span < head ? from + span : head;
  const endBlk = await rpc("eth_getBlockByNumber", [toQty(to), false]);
  const logs = await rpc("eth_getLogs", [{ address: entry.runtime.vault, topics: [SESSION_OP_TOPIC, entry.sid], fromBlock: toQty(from), toBlock: toQty(to) }]);
  const hashes = [], rejected = [];
  for (const l of Array.isArray(logs) ? logs : []) {
    if (l?.removed !== false) { rejected.push({ txHash: lower(l?.transactionHash), reason: "log_removed" }); continue; }
    const n = BigInt(l.blockNumber ?? -1);
    if (n < from || n > to) { rejected.push({ txHash: lower(l.transactionHash), reason: "log_outside_window" }); continue; }
    if (isHash(l.transactionHash)) hashes.push(lower(l.transactionHash));
  }
  const pastDeadline = endBlk?.timestamp !== undefined && BigInt(endBlk.timestamp) > BigInt(entry.call.deadline);
  return { hashes, rejected, window: { from: entry.anchor.number, to: to.toString(), complete: pastDeadline } };
}

/** READ-ONLY reconciliation of one execution: no signature, no POST, no resend, no invented hash. Journal writes are
 *  CAS transitions of THIS entry only (outcome evidence / observations). Returns { verdict, status, ... }. */
export async function reconcileGasExecution({ runtime, store, rpc, relay, relayBase, id, limits }) {
  const entry = await store.getJournal(id);
  if (!entry) fail("execution_missing", `no execution ${id}`);
  if (entry.schema !== EXEC_SCHEMA) return { verdict: "legacy_unverifiable", status: entry.status, id };
  try { await verifyStoredIntent(entry, { runtime, store, relayBase }); }
  catch (e) { if (e?.code === "intent_invalid") return { verdict: "intent_invalid", status: entry.status, id, why: e.detail?.why }; throw e; }
  if (entry.status === "expired_unused") {          // freshness: the stored proof's header must still be canonical and final
    try {
      const recheck = await recheckStoredExpiry(entry, rpc);
      return { verdict: "resolved", status: entry.status, id, evidence: entry.evidence, recheck };
    } catch (e) {
      if (e?.code !== "expiry_not_proven" || e.detail?.reason !== "evidence_reorged") {
        return { verdict: "expiry_recheck_failed", status: entry.status, id, why: e?.detail?.reason ?? String(e?.code ?? e?.name ?? "error") };
      }
      const back = await transition(store, id, entry, (x) => { keepHistory(x, "expiry_evidence_reorged"); x.status = "unknown"; x.evidence = null; });
      return reconcileGasExecution({ runtime, store, rpc, relay, relayBase, id: back.id, limits });
    }
  }
  if (CLEARED.includes(entry.status)) return { verdict: "resolved", status: entry.status, id };
  if (entry.status === "admitted") {              // the dispatching marker was never written: nothing was sent
    const c = await transition(store, id, entry, (x) => { keepHistory(x, "no_dispatch_marker"); x.status = "never_dispatched"; });
    return { verdict: "resolved", status: c.status, id };
  }
  // non-final evidence: revalidate it first (canonical observation is not finality)
  if ((entry.status === "observed" || entry.status === "superseded_observed") && entry.evidence?.txHash) {
    const res = await proveCandidate(entry, entry.evidence.txHash, runtime, rpc);
    const wanted = entry.status === "observed" ? "exact" : "superseding";
    if (res.kind === wanted && res.blockHash === entry.evidence.blockHash) {
      if (!res.final) return { verdict: "observed_not_final", status: entry.status, id, evidence: entry.evidence };
      const c = await transition(store, id, entry, (x) => (wanted === "exact" ? applyExact(x, res) : applySuperseding(x, res)));
      return { verdict: "resolved", status: c.status, id, evidence: c.evidence };
    }
    // reorged, moved, or contradicted: the old evidence is kept in history and the execution is unknown again
    const back = await transition(store, id, entry, (x) => { keepHistory(x, `evidence_${res.kind}${res.reason ? `:${res.reason}` : ""}`); x.status = "unknown"; x.evidence = null; });
    return reconcileGasExecution({ runtime, store, rpc, relay, relayBase, id: back.id, limits });
  }
  const fromRelay = await relayHints(relay, entry);
  const found = await discover(rpc, entry, limits);
  const candidates = [...new Set([...(entry.hints?.txHashes ?? []), ...fromRelay, ...found.hashes])];
  const observation = { window: found.window, candidates: candidates.length, rejected: [...found.rejected] };
  if (candidates.length > MAX_CANDIDATES) {
    return { verdict: "unresolved", status: entry.status, id, why: "too_many_candidates", observation };
  }
  const results = [];
  for (const h of candidates) results.push(await proveCandidate(entry, h, runtime, rpc));
  for (const r of results) if (!["exact", "superseding"].includes(r.kind)) observation.rejected.push({ txHash: r.txHash, kind: r.kind, reason: r.reason ?? null });
  const exact = [...new Map(results.filter((r) => r.kind === "exact").map((r) => [r.txHash, r])).values()];
  const sup = [...new Map(results.filter((r) => r.kind === "superseding").map((r) => [r.txHash, r])).values()];
  const contra = results.filter((r) => r.kind === "contradiction");
  if (contra.length || exact.length > 1 || sup.length > 1 || (exact.length && sup.length)) {
    return { verdict: "contradiction", status: entry.status, id, observation };    // kept as is for manual review
  }
  const record = (x) => { x.lastReconcile = observation; };
  if (exact.length === 1) {
    const c = await transition(store, id, entry, (x) => { applyExact(x, exact[0]); record(x); });
    return { verdict: c.status === "settled" ? "resolved" : "observed_not_final", status: c.status, id, evidence: c.evidence };
  }
  if (sup.length === 1) {
    const c = await transition(store, id, entry, (x) => { applySuperseding(x, sup[0]); record(x); });
    return { verdict: c.status === "superseded" ? "resolved" : "observed_not_final", status: c.status, id, evidence: c.evidence };
  }
  // nothing proven on chain: only the full expired-unused chain proof can release it (any failure keeps it reserved)
  let proof = null;
  if (EXPIRABLE.includes(entry.status)) {
    try { proof = await proveExpiredUnused(entry, runtime, rpc); observation.expiry = { proven: true }; }
    catch (e) { observation.expiry = { proven: false, reason: e?.code === "expiry_not_proven" ? String(e.detail?.reason) : `error:${String(e?.code ?? e?.name ?? "unknown")}` }; }
  }
  if (proof) {
    const c = await transition(store, id, entry, (x) => { keepHistory(x, "expired_unused_proven"); x.status = "expired_unused"; x.evidence = proof; record(x); });
    return { verdict: "resolved", status: c.status, id, evidence: c.evidence, observation };
  }
  const revertedExact = results.some((r) => r.kind === "reverted_exact");
  const c = await transition(store, id, entry, (x) => {
    if (revertedExact && x.status !== "reverted_observed") { keepHistory(x, "exact_call_reverted_on_chain"); x.status = "reverted_observed"; }
    record(x);
  });
  return { verdict: "unresolved", status: c.status, id, observation,
    why: revertedExact ? "reverted_signature_may_still_be_usable" : found.window.complete ? "no_canonical_operation_found_in_bounded_window" : "window_not_past_deadline" };
}

/** Display mapping for the page: ONLY a final proven settlement is "funded"; text only for cleared statuses. Pure. */
const CLEARED_TEXT = Object.freeze({
  settled: "Funded: the exact payment is final on chain.",
  superseded: "Not funded by this payment: its nonce was used by another operation (final on chain).",
  refused: "Not sent: the relay refused it before sending. Nothing was charged.",
  never_dispatched: "Not sent: it was never dispatched. Nothing was charged.",
  abandoned_before_send: "Not sent: cancelled before sending. Nothing was charged.",
  expired_unused: "Expired unused, never funded: a finalized Base block after its deadline shows its nonce unused, so it can never execute and charged nothing. A new quote and a new signature are needed to pay.",
});
export function executionStatusView(status) {
  const cleared = CLEARED.includes(status);
  return Object.freeze({ status: String(status), cleared, funded: status === "settled", text: cleared ? CLEARED_TEXT[status] : null });
}

/** Executions of THIS gas record (exact record id + sid), for the page's recovery view. Pure. */
export function listGasExecutions(entries, record) {
  return (entries || []).filter((e) => e?.kind === "gas-execute" && lower(e.sid) === lower(record.sid)
    && (e.schema !== EXEC_SCHEMA || e.record?.id === String(record.id)))
    .map((e) => ({ id: e.id, status: e.status, blocking: isBlocking(e), schema: e.schema ?? "r4", nonce: e.schema === EXEC_SCHEMA ? e.nonce : String(e.nonce ?? ""),
      deployment: e.deployment ?? null, maximum: e.maximum ?? null, evidence: e.evidence ?? null, hints: e.hints?.txHashes ?? e.txHashes ?? [],
      predecessors: Array.isArray(e.predecessors) ? e.predecessors.length : 0,
      funded: e.schema === EXEC_SCHEMA ? e.status === "settled" : false }));
}

/** quoteGasFund with the successor gate: any unresolved execution of the session refuses before the relay is asked;
 *  r4's own unresolved check still runs (cleared r2 entries are removed from what it sees). A cleared expired_unused
 *  entry is re-proven fresh by confirmGasFund before its nonce can be admitted again; quoting itself signs nothing. */
export async function quoteGasFund(input) {
  const entries = input.journalEntries ?? [];
  const blockers = executionBlockers(entries, input.record);
  if (blockers.length) {
    fail("unreconciled_execute", "an earlier gas.fund of this session is not resolved; check its status first (never resent)", { ids: blockers.map((x) => x.id) });
  }
  return quoteGasFundR4({ ...input, journalEntries: entries.filter((e) => !(e?.kind === "gas-execute" && e.schema === EXEC_SCHEMA && CLEARED.includes(e.status))) });
}
