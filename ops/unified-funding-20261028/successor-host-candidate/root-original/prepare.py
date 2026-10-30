#!/usr/bin/env python3
"""successor-host-r1 prepare.py. UNREVIEWED SOURCE: its author executed nothing (no python, no node, no tests).

Deterministic generation of ISOLATED composed copies: the root-reviewed fee-policy-r1 GENERATED host (itself host-queue-r1
+ relay-owner-r2 + the fee envelope) plus marked successor-host-r1 hunks that make every successor send ONE durable intent
of the host's ONE TxQueue journal. Writes ONLY inside this stage:

  generated/relay/sessions.mjs       fee-policy-r1/generated/relay/sessions.mjs (sha256-pinned) + successor-host-r1 hunks
  generated/relay/funding-route.mjs  fee-policy-r1/generated/relay/funding-route.mjs (sha256-pinned) + successor-host-r1 hunks
  generated/relay/funding-abi.mjs    byte copy (sha256-pinned)
  generated/relay/fee-policy.mjs     byte copy (sha256-pinned; its envelope code is NOT changed here)
  generated/relay/sessions-abi.mjs   symlink -> source/relay/sessions-abi.mjs   (read-only import)
  generated/relay/snp-verify.mjs     symlink -> source/relay/snp-verify.mjs     (read-only import)
  generated/node_modules             symlink -> source/node_modules              (viem)
  generated/PREPARE-MANIFEST.json    sha256 of every input, output and hunk; observed (unpinned) test-fixture hashes

Every hunk's `before` must occur exactly once; undoing every hunk must give the input byte for byte. Nothing outside this
stage is written; fee-policy-r1, host-queue-r1, relay-owner-r2 and source/ are only read. Activation stays OFF: no hunk
wires a quote policy or a manifest into initSessions (o.fundingQuotePolicy stays unset in production bootstrap).

  python3 prepare.py           write the outputs
  python3 prepare.py --check   write nothing; exit 1 if anything is missing or differs
"""
import hashlib
import json
import os
import sys

STAGE = os.path.dirname(os.path.realpath(__file__))
UF = os.path.dirname(STAGE)                                   # unified-funding-20261028
SOURCE = os.path.normpath(os.path.join(UF, "..", "source"))
FP = os.path.join(UF, "fee-policy-r1")
FP_MANIFEST = os.path.join(FP, "generated", "PREPARE-MANIFEST.json")
# fee-policy-r1/generated/PREPARE-MANIFEST.json "outputs" as reviewed/pinned by the root (copied verbatim)
FP_PINS = {
    "generated/relay/sessions.mjs": "852ded20b389321f7344ad7dbd436c54242b5ee95e847073bb89406c5719c5d8",
    "generated/relay/funding-route.mjs": "ddbd856c9c3a832cd252719df23c13ca08eb4c4ed747585e0daa38abf0c23966",
    "generated/relay/funding-abi.mjs": "6bb37e658aca45fd416d5ea17dda3109e1b41791e674976a60425d579f485cd7",
    "generated/relay/fee-policy.mjs": "32bcf03ea52db9be70d86e957dd440c1697daf0eaeab79f732378002d4f2bcfd",
}
# read-only test fixtures the tests import from sibling stages: hashes are RECORDED (root: review and pin)
TEST_INPUTS = {
    "relay-owner-r2/test/fake-chain.mjs": os.path.join(UF, "relay-owner-r2", "test", "fake-chain.mjs"),
    "relay-owner-r2/funding-route.mjs": os.path.join(UF, "relay-owner-r2", "funding-route.mjs"),
    "relay-owner-r2/generated/funding-abi.mjs": os.path.join(UF, "relay-owner-r2", "generated", "funding-abi.mjs"),
    "host-queue-r1/test/fixture-rpc.mjs": os.path.join(UF, "host-queue-r1", "test", "fixture-rpc.mjs"),
}
MARK = "successor-host-r1"
SYMLINKS = {
    "generated/relay/sessions-abi.mjs": os.path.join(SOURCE, "relay", "sessions-abi.mjs"),
    "generated/relay/snp-verify.mjs": os.path.join(SOURCE, "relay", "snp-verify.mjs"),
    "generated/node_modules": os.path.join(SOURCE, "node_modules"),
}

HEADER = (
    f"// >>> {MARK} GENERATED COPY by successor-host-r1/prepare.py from fee-policy-r1/generated/relay/sessions.mjs (sha256\n"
    f"// {FP_PINS['generated/relay/sessions.mjs']}). Every change is a marked {MARK} hunk; undoing them gives the input.\n"
    f"// <<< {MARK}\n"
)
ROUTE_HEADER = (
    f"// >>> {MARK} GENERATED COPY by successor-host-r1/prepare.py from fee-policy-r1/generated/relay/funding-route.mjs (sha256\n"
    f"// {FP_PINS['generated/relay/funding-route.mjs']}). Every change is a marked {MARK} hunk; undoing them gives the input.\n"
    f"// <<< {MARK}\n"
)

# ---------------------------------------------------------------------------------------------------------------------
# sessions.mjs hunks (the ONE TxQueue gains a durable intent journal; legacy sends without `intent` run unchanged lines)
# ---------------------------------------------------------------------------------------------------------------------
S_CONST = (r'''export class TxQueue {
''', r'''// >>> successor-host-r1 bounds of the durable successor intent journal (journal.data.intents, the SAME durable journal)
const TX_INTENT_MAX = 500;            // unresolved successor intents before a NEW one is refused (none is ever evicted)
const TX_INTENT_CONTROL = 64;         // extra room for terminate / revokeAll / sign-out only: recovery is not locked out by volume
const TX_INTENT_UNSENT = ["nonce_lost", "nonce_busy"];   // record statuses that prove the node refused the record's only send
// <<< successor-host-r1
export class TxQueue {
''')

S_CTOR = (r'''    this.nonce = null;
    if (!journal.data.txs) journal.data.txs = [];
''', r'''    this.nonce = null;
    if (!journal.data.txs) journal.data.txs = [];
    // >>> successor-host-r1: successor intents live in this journal; `boot` tells a reservation still queued in THIS process
    // from one an earlier process made and never journaled a transaction for (that one provably broadcast nothing)
    journal.data.intents ??= {};
    this.boot = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    // <<< successor-host-r1
''')

S_SEND_SIG = (r'''  async _send({ to, data, label, envelope }) {
''', r'''  // [successor-host-r1] REPLACES the signature line: adds the optional durable successor `intent` key
  async _send({ to, data, label, envelope, intent }) {
''')

S_REC = (r'''    if (env) rec.envelope = env.journal;
''', r'''    if (env) rec.envelope = env.journal;
    // [successor-host-r1] the record names its reservation from its FIRST flush (before any broadcast); unreserved: refused
    if (intent !== undefined) {
      const res = this.journal.data.intents?.[intent];
      if (!res || res.status !== "reserved") throw httpError(500, "intent_unreserved", `${label}: the successor intent is not reserved; nothing was sent`);
      Object.assign(rec, { intent, intentGen: res.gen });
    }
''')

S_PRUNE = (r'''      const i = this.journal.data.txs.findIndex((r) => r !== rec && ["mined", "reverted", "nonce_lost", "nonce_busy"].includes(r.status));
''', r'''      // [successor-host-r1] REPLACES the next line: the record of an UNRESOLVED successor intent is never pruned either
      const i = this.journal.data.txs.findIndex((r) => r !== rec && ["mined", "reverted", "nonce_lost", "nonce_busy"].includes(r.status) && !this._intentOpen(r));
''')

S_METHODS = (r'''  /** Only ever called with a receipt _canonical accepted. */
  _done(rec, rc) {
''', r'''  // >>> successor-host-r1 durable successor intents. The funding route owns the identity (key); this queue owns the nonce
  // and the hashes. A reservation is flushed before the queue can journal or broadcast for it; its record names it
  // (rec.intent, rec.intentGen) from the record's first flush. Nothing here sends, waits or replaces anything.
  intents() {
    return Object.freeze({ reserve: (k, o) => this.reserveIntent(k, o), state: (k) => this.intentState(k),
      release: (k, g) => this.releaseIntent(k, g), settle: (k, s, x) => this.settleIntent(k, s, x),
      reconcile: (k) => this.reconcileIntent(k), byHash: (h) => this.intentOfHash(h) });
  }

  /** { reservation, rec, reusable }: rec is the record of THIS reservation that may have broadcast. reusable: there is no
   *  live submission (none, a canonical revert, or an earlier process's reservation that never journaled a record). */
  intentState(key) {
    const res = this.journal.data.intents?.[key] ?? null;
    const rec = res ? this.journal.data.txs.find((r) => r?.intent === key && r.intentGen === res.gen && !TX_INTENT_UNSENT.includes(r.status)) ?? null : null;
    const reusable = !res || res.status === "reverted" || (res.status === "reserved" && res.boot !== this.boot && !rec);
    return { reservation: res, rec, reusable };
  }

  _intentResolved(key, res) { return res?.status === "done" || this.intentState(key).reusable; }

  _intentOpen(r) {
    if (typeof r?.intent !== "string" || TX_INTENT_UNSENT.includes(r.status)) return false;
    const res = this.journal.data.intents?.[r.intent];
    return Boolean(res && res.gen === r.intentGen && res.status !== "done" && res.status !== "reverted");
  }

  /** Reserve `key` durably. null: reserved now (flushed). Otherwise the live reservation, which the caller must ANSWER,
   *  never send. Only resolved reservations are ever dropped; past the bound a new one is refused before anything is sent. */
  reserveIntent(key, { kind, meta, control = false }) {
    const I = this.journal.data.intents;
    const st = this.intentState(key);
    if (!st.reusable) return st.reservation;
    const open = Object.entries(I).filter(([k, r]) => k !== key && !this._intentResolved(k, r)).length;
    if (open >= TX_INTENT_MAX + (control ? TX_INTENT_CONTROL : 0)) {
      throw httpError(503, "journal_full", `${open} successor intents are unresolved; nothing was reserved or sent (only resolved ones are ever dropped)`, { open });
    }
    for (const [k, r] of Object.entries(I)) {
      if (Object.keys(I).length < TX_INTENT_MAX + TX_INTENT_CONTROL) break;
      if (k !== key && this._intentResolved(k, r)) delete I[k];
    }
    const prev = I[key];
    I[key] = { kind, meta, status: "reserved", gen: (prev?.gen ?? 0) + 1, boot: this.boot, at: Date.now(),
      ...(prev?.status === "reverted" ? { prior: { hash: prev.hash ?? null, block: prev.block ?? null, at: prev.at ?? null } } : {}) };
    this.journal.flush();
    return null;
  }

  /** Undo THIS reservation only when no record of it may have broadcast (a canonical revert it replaced comes back). */
  releaseIntent(key, gen) {
    const I = this.journal.data.intents;
    const res = I[key];
    if (!res || res.gen !== gen || res.status !== "reserved" || this.intentState(key).rec) return false;
    if (res.prior) I[key] = { kind: res.kind, meta: res.meta, status: "reverted", gen: res.gen, boot: res.boot, at: res.prior.at, hash: res.prior.hash, block: res.prior.block };
    else delete I[key];
    this.journal.flush();
    return true;
  }

  settleIntent(key, status, { hash = null, block = null } = {}) {
    const res = this.journal.data.intents?.[key];
    if (!res || (status !== "done" && status !== "reverted")) return false;
    Object.assign(res, { status, hash, block, settledAt: Date.now() });
    this.journal.flush();
    return true;
  }

  /** Read-only, bounded: one canonical observation over EVERY hash the record was sent under (replacements included). */
  async reconcileIntent(key) {
    const { rec } = this.intentState(key);
    if (!rec?.hashes?.length) return { receipt: null, reason: "no_hash", hashes: [] };
    const o = rec.hash ? await this._canonical(rec.hash) : await this._observe(rec.hashes);
    if (o.receipt && !rec.hash) this._done(rec, o.receipt);
    return { receipt: o.receipt ?? null, reason: o.reason ?? null, hashes: [...rec.hashes] };
  }

  intentOfHash(hash) {
    const h = txHash32(hash);
    const rec = h && this.journal.data.txs.find((r) => typeof r?.intent === "string" && Array.isArray(r.hashes) && r.hashes.some((x) => txHash32(x) === h));
    return rec && this.journal.data.intents?.[rec.intent]?.gen === rec.intentGen ? rec.intent : null;
  }
  // <<< successor-host-r1

  /** Only ever called with a receipt _canonical accepted. */
  _done(rec, rc) {
''')

# inside a funding-r2 block: an inline marker, never a nested >>> block
S_WIRE = (r'''    pc, relayer: account.address, store, log, now,
''', r'''    // [successor-host-r1] REPLACES this line: the host queue's durable successor intents (same journal, same queue)
    pc, relayer: account.address, store, log, now, intents: queue.intents(),
''')

S_SIM_SIG = (r'''  async function simulateAndSend({ to, abi, functionName, args, label, afterSimulate, envelope }) {
''', r'''  // [successor-host-r1] REPLACES the signature line: adds the optional durable successor `intent` key
  async function simulateAndSend({ to, abi, functionName, args, label, afterSimulate, envelope, intent }) {
''')

S_SIM_SEND = (r'''    const rc = await queue.send({ to, data: encodeFunctionData({ abi, functionName, args }), label, ...(envelope === undefined ? {} : { envelope }) });
''', r'''    // [successor-host-r1] REPLACES the send line: the successor intent key travels with the same item to the ONE queue
    const rc = await queue.send({ to, data: encodeFunctionData({ abi, functionName, args }), label, ...(envelope === undefined ? {} : { envelope }),
      ...(intent === undefined ? {} : { intent }) });
''')

S_SIM_REVERT = (r'''    if (rc.status !== "success") throw httpError(409, "revert", `${label} reverted on-chain (${rc.transactionHash})`);
''', r'''    // >>> successor-host-r1: a successor intent gets its canonical on-chain REVERT back (the route clears exactly that
    // submission and names its hash); every original caller keeps the original 409 revert below
    if (rc.status !== "success" && intent !== undefined) return rc;
    // <<< successor-host-r1
    if (rc.status !== "success") throw httpError(409, "revert", `${label} reverted on-chain (${rc.transactionHash})`);
''')

SESSIONS_HUNKS = [("constants", *S_CONST), ("constructor", *S_CTOR), ("_send signature", *S_SEND_SIG), ("record intent", *S_REC),
                  ("prune guard", *S_PRUNE), ("intent methods", *S_METHODS), ("funding wiring", *S_WIRE),
                  ("simulateAndSend signature", *S_SIM_SIG), ("simulateAndSend send", *S_SIM_SEND), ("simulateAndSend revert", *S_SIM_REVERT)]

# ---------------------------------------------------------------------------------------------------------------------
# funding-route.mjs hunks
# ---------------------------------------------------------------------------------------------------------------------
R_SIG = (r'''  relayer = null, store = null, log = () => {}, now = () => Math.floor(Date.now() / 1000), simulateAndSend = null } = {}) {
''', r'''  // [successor-host-r1] REPLACES this line: adds `intents`, the host queue's durable successor intent journal
  relayer = null, store = null, log = () => {}, now = () => Math.floor(Date.now() / 1000), simulateAndSend = null, intents = null } = {}) {
''')

R_ACT = (r'''    why = "funding needs a host queue that enforces the gas.fund transaction envelope; none is declared";
  }
  // <<< fee-policy-r1
''', r'''    why = "funding needs a host queue that enforces the gas.fund transaction envelope; none is declared";
  }
  // <<< fee-policy-r1
  // >>> successor-host-r1: every successor send is a durable intent of the host's ONE queue journal; without it, all off
  if (!why && (!intents || ["reserve", "state", "release", "settle", "reconcile", "byHash"].some((k) => typeof intents[k] !== "function"))) {
    why = "funding needs the host queue's durable successor intent journal; none is wired";
  }
  // <<< successor-host-r1
''')

R_PENDING = (r'''  function recordPending(txHash, kind, meta, reason) {
    const P = store.data.fundingPending;
    P[txHash] = { kind, at: now(), reason, meta };
    const keys = Object.keys(P);
    if (keys.length > PENDING_MAX) keys.sort((a, b) => P[a].at - P[b].at).slice(0, keys.length - PENDING_MAX).forEach((k) => delete P[k]);
    flush();
  }
''', r'''  // >>> successor-host-r1 (REPLACES recordPending): every hash of ONE submission, bound to its intent; nothing is evicted
  // (the bound is the queue's, enforced BEFORE a broadcast: a hash already sent is never forgotten). This store is an index;
  // the queue journal is authoritative (reconcile falls back to it).
  function recordPending(hashes, kind, meta, reason, key) {
    const P = store.data.fundingPending;
    for (const h of hashes) P[String(h).toLowerCase()] = { kind, at: now(), reason, meta, intent: key };
    flush();
  }
  function clearPending(hashes) {
    for (const h of hashes) delete store.data.fundingPending[String(h).toLowerCase()];
    flush();
  }
  // <<< successor-host-r1
''')

R_COMPLETED = (r'''  /** Accept the host's receipt only once it is canonical; else record it and answer 202 (bounded, read-only). */
  async function completed(kind, rc, meta) {
    const txHash = typeof rc?.transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(rc.transactionHash)
      ? rc.transactionHash.toLowerCase() : null;
    if (!txHash) throw httpError(502, "no_tx_hash", `${kind}: the host returned no transaction hash`);
    const c = await canonical({ ...rc, transactionHash: txHash });
    if (c.pending) {
      recordPending(txHash, kind, meta, c.pending);
      throw httpError(202, "pending_reconciliation", `submitted ${txHash}, not yet canonical (${c.pending}); it is NOT resubmitted, `
        + "NOT treated as failed or refunded, and nothing is indexed until it is", { txHash, reconcile: `/funding/tx/${txHash}` });
    }
    if (c.receipt.status !== "success") {
      delete store.data.fundingPending[txHash]; flush();
      throw httpError(409, "reverted", `${kind} reverted in canonical block ${c.receipt.blockNumber} (${txHash})`, { txHash });
    }
    const out = FINISH[kind](c.receipt, meta);
    delete store.data.fundingPending[txHash];
    flush();
    return out;
  }
''', r'''  // >>> successor-host-r1 (REPLACES completed): durable successor intents over the host's ONE queue journal.
  // Identity: keccak(kind, chain, relayer, target, the exact calldata with ONLY its signature words blanked): an alternate
  // signature over the same intent is the same submission; another nonce/fee/args/deadline/grant/opNonce is not. Reserved
  // inside the host's afterSimulate (both simulations accepted the signature: a forged request reserves nothing and counts
  // no quota) and flushed BEFORE the queue journals or broadcasts for it. Every later request, retry or reconciliation of
  // it is answered READ-ONLY from the journal: never sent again. Hashes come from THIS intent's journal record, never from
  // a queue error (which can name another, earlier transaction).
  const NO_SUBMISSION = Symbol("no live submission");
  function intentKey(kind, to, abi, functionName, args, blankIdx) {
    const item = abi.find((x) => x.type === "function" && x.name === functionName);
    const masked = args.map((v, i) => (blankIdx.includes(i) ? (item.inputs[i].type === "bytes32" ? ZERO_HASH : "0x") : v));
    return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "bytes" }],
      [kind, BigInt(FUNDING_CHAIN_ID), R, getAddress(to), encodeFunctionData({ abi, functionName, args: masked })]));
  }
  const hashesOf = (key, also) => [...new Set([...(intents.state(key).rec?.hashes ?? []), ...(also ? [also] : [])]
    .map((h) => String(h).toLowerCase()))];
  const doneAnswer = (key, res) => ({ txHash: res.hash, block: res.block, intent: key, already: true });

  /** Accept a receipt only once it is canonical. Pending: EVERY hash of the submission is recorded (202). Canonical revert:
   *  exactly that submission is cleared and named by its hash (an ON-CHAIN revert, never a simulation refusal). Canonical
   *  success: indexed exactly once (the intent turns done in the same synchronous step), all its hashes cleared. */
  async function completed(kind, rc, meta, key) {
    const txHash = typeof rc?.transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(rc.transactionHash)
      ? rc.transactionHash.toLowerCase() : null;
    if (!txHash) throw httpError(502, "no_tx_hash", `${kind}: the host returned no transaction hash`);
    const all = hashesOf(key, txHash);
    const c = await canonical({ ...rc, transactionHash: txHash });
    if (c.pending) {
      recordPending(all, kind, meta, c.pending, key);
      throw httpError(202, "pending_reconciliation", `submitted ${all.join(", ")}, not yet canonical (${c.pending}); it is NOT resubmitted, `
        + "NOT treated as failed or refunded, and nothing is indexed until it is", { txHash, txHashes: all, intent: key, reconcile: `/funding/tx/${txHash}` });
    }
    const res = intents.state(key).reservation;
    if (c.receipt.status !== "success") {
      if (res?.status !== "done") intents.settle(key, "reverted", { hash: txHash, block: Number(c.receipt.blockNumber) });
      clearPending(all);
      throw httpError(409, "reverted", `${kind} reverted ON CHAIN in canonical block ${c.receipt.blockNumber} (${txHash}); not a simulation refusal`,
        { txHash, intent: key, onChain: true });
    }
    if (res?.status === "done") { clearPending(all); return doneAnswer(key, res); }
    const out = FINISH[kind](c.receipt, meta);
    intents.settle(key, "done", { hash: txHash, block: Number(c.receipt.blockNumber) });
    clearPending(all);
    return out;
  }

  /** The live submission of `key` answered read-only, or NO_SUBMISSION (none, or only a canonical revert). */
  async function intentExisting(kind, key) {
    const st = intents.state(key);
    return st.reusable ? NO_SUBMISSION : intentAnswer(kind, key, st);
  }
  async function intentAnswer(kind, key, st) {
    const res = st.reservation;
    if (!res) throw httpError(404, "not_pending", "this relay holds no submission for that intent");
    if (res.status === "done") { clearPending(hashesOf(key)); return doneAnswer(key, res); }
    if (res.status === "reverted") throw httpError(409, "reverted", `the submission reverted ON CHAIN (${res.hash}); nothing is pending for it`, { txHash: res.hash, intent: key, onChain: true });
    if (!st.rec && st.reusable) throw httpError(409, "not_sent", "an earlier process reserved this intent and journaled no transaction for it: nothing was broadcast", { intent: key });
    if (!st.rec) throw httpError(409, "intent_in_flight", "this signed intent is already queued on this relay; nothing more is sent for it", { intent: key });
    if (!st.rec.hashes?.length) {
      throw httpError(503, "intent_unknown", `the send at nonce ${st.rec.nonce} returned no hash (status ${st.rec.status}); it may or may not have `
        + "been broadcast, so it stays fenced: never rebroadcast automatically, it needs operator reconciliation", { intent: key, nonce: st.rec.nonce, sent: "unknown" });
    }
    const r = await intents.reconcile(key);
    if (r.receipt) return completed(res.kind ?? kind, r.receipt, res.meta, key);
    const all = hashesOf(key);
    recordPending(all, res.kind ?? kind, res.meta, r.reason ?? "not_canonical", key);
    throw httpError(202, "pending_reconciliation", `already submitted (${all.join(", ")}), not yet canonical; it is NOT resubmitted, NOT treated `
      + "as failed or refunded, and nothing is indexed until it is", { txHash: all[0], txHashes: all, intent: key, reconcile: `/funding/tx/${all[0]}` });
  }

  /** Host simulation, reservation, the ONE queue, completion. Refused before the reservation: nothing reserved. Failed after
   *  it with no journal record of this intent: nothing of it was broadcast, so it is released, and any hash the error names
   *  (another transaction's) is reported as blocking, never as this call's. With a record: answered from the journal. */
  async function intentSubmit(kind, key, meta, req, control = false) {
    let gen = null;
    let rc;
    try {
      rc = await simulateAndSend({ ...req, intent: key, afterSimulate: () => {
        if (intents.reserve(key, { kind, meta, control })) {
          throw Object.assign(httpError(409, "intent_in_flight", "this signed intent is already being submitted"), { intentHeld: true });
        }
        gen = intents.state(key).reservation.gen;
        req.afterSimulate?.();
      } });
    } catch (e) {
      if (gen === null) {
        if (e?.intentHeld) { const p = await intentExisting(kind, key); if (p !== NO_SUBMISSION) return p; }
        throw e;
      }
      const st = intents.state(key);
      if (!st.rec) {
        intents.release(key, gen);
        const x = e?.extra && typeof e.extra === "object" ? e.extra : {};
        throw httpError(e?.status ?? 503, e?.code ?? "relay", String(e?.message ?? e), { intent: key, sent: false,
          ...(Array.isArray(x.txHashes) ? { blockingTxHashes: [...x.txHashes], blockingNonce: x.nonce ?? null, blockingLabel: x.label ?? null } : {}) });
      }
      return intentAnswer(kind, key, st);
    }
    return completed(kind, rc, meta, key);
  }
  // <<< successor-host-r1
''')

R_EXEC_KEY = (r'''    if (nonce >> 256n !== 0n) throw httpError(400, "bad_request", "nonce out of range");
''', r'''    if (nonce >> 256n !== 0n) throw httpError(400, "bad_request", "nonce out of range");
    // >>> successor-host-r1: one durable submission per signed intent (r, s excluded); an existing one is answered read-only
    const intentId = intentKey("execute", vaultIn, vaultAbi, "execute", [sid, nonce, ACTION_GAS_FUND, args, fee, deadline, x, y, r, sv], [8, 9]);
    const priorSubmission = await intentExisting("execute", intentId);
    if (priorSubmission !== NO_SUBMISSION) return priorSubmission;
    // <<< successor-host-r1
''')

R_EXEC_SEND = (r'''    const rc = await simulateAndSend({ to: vault, abi: vaultAbi, functionName: "execute", args: execArgs,
      label: `funding gas.fund ${sid.slice(0, 10)}`, envelope });
    // <<< fee-policy-r1
    return completed("execute", rc, { vault, sid, nonce: nonce.toString(), args, fee: fee.toString() });
''', r'''    // [successor-host-r1] REPLACES the send and completion: the same call, envelope and queue, as one durable intent
    return intentSubmit("execute", intentId, { vault, sid, nonce: nonce.toString(), args, fee: fee.toString() },
      { to: vault, abi: vaultAbi, functionName: "execute", args: execArgs, label: `funding gas.fund ${sid.slice(0, 10)}`, envelope });
    // <<< fee-policy-r1
''')

R_OPEN = (r'''    await presimulate(A.factory, factoryAbi, fn, args, B);
    const rc = await simulateAndSend({ to: A.factory, abi: factoryAbi, functionName: fn, args, label: `funding ${fn} ${owner.slice(0, 8)}`,
      afterSimulate: () => rateOwner(owner, "open", true) });
    return completed("open", rc, { vault, owner, sid: sessionIdOf(vault, g.sessionKey, g.grantNonce) });
''', r'''    // >>> successor-host-r1 (REPLACES the presimulate/send/completion): the grant and deposit terms are the identity
    // (owner signature and EIP-3009 signature excluded); an existing submission is answered read-only
    const intentId = intentKey("open", A.factory, factoryAbi, fn, args, fn === "openFor" ? [2] : [2, 5]);
    const priorSubmission = await intentExisting("open", intentId);
    if (priorSubmission !== NO_SUBMISSION) return priorSubmission;
    await presimulate(A.factory, factoryAbi, fn, args, B);
    return intentSubmit("open", intentId, { vault, owner, sid: sessionIdOf(vault, g.sessionKey, g.grantNonce) },
      { to: A.factory, abi: factoryAbi, functionName: fn, args, label: `funding ${fn} ${owner.slice(0, 8)}`,
        afterSimulate: () => rateOwner(owner, "open", true) });
    // <<< successor-host-r1
''')

R_OWNER_KEY = (r'''    const { sid, args } = ownerArgs(op, body);
''', r'''    const { sid, args } = ownerArgs(op, body);
    // >>> successor-host-r1: identity = op + every signed argument (the owner's opNonce and signBefore included, the owner
    // signature / EIP-3009 authorization excluded). Looked up BEFORE the quota check: a retry never consumes quota.
    const intentId = intentKey("owner", vaultIn, vaultAbi, op, args, op === "close" ? [] : [args.length - 1]);
    const priorSubmission = await intentExisting("owner", intentId);
    if (priorSubmission !== NO_SUBMISSION) return priorSubmission;
    // <<< successor-host-r1
''')

R_OWNER_SEND = (r'''    const rc = await simulateAndSend({ to: vault, abi: vaultAbi, functionName: op, args, label: `funding ${op} ${vault.slice(0, 8)}`, afterSimulate });
    return completed("owner", rc, { vault, owner, op, sid, epoch });
''', r'''    // >>> successor-host-r1 (REPLACES the send/completion). terminate/revokeAll reserve inside the control headroom.
    return intentSubmit("owner", intentId, { vault, owner, op, sid, epoch },
      { to: vault, abi: vaultAbi, functionName: op, args, label: `funding ${op} ${vault.slice(0, 8)}`, afterSimulate },
      op === "terminate" || op === "revokeAll");
    // <<< successor-host-r1
''')

R_END_KEY = (r'''    const args = [sid, uint(body.deadline, 64, "deadline"), uint(body.x, 256, "x"), uint(body.y, 256, "y"), hex32(body.r, "r"), hex32(body.s, "s")];
''', r'''    const args = [sid, uint(body.deadline, 64, "deadline"), uint(body.x, 256, "x"), uint(body.y, 256, "y"), hex32(body.r, "r"), hex32(body.s, "s")];
    // >>> successor-host-r1: identity = the signed sign-out (r, s excluded); an existing submission is answered read-only
    const intentId = intentKey("end", address(body.vault, "vault"), vaultAbi, "terminateBySession", args, [4, 5]);
    const priorSubmission = await intentExisting("end", intentId);
    if (priorSubmission !== NO_SUBMISSION) return priorSubmission;
    // <<< successor-host-r1
''')

R_END_SEND = (r'''    const rc = await simulateAndSend({ to: vault, abi: vaultAbi, functionName: "terminateBySession", args, label: `funding end ${sid.slice(0, 10)}`,
      afterSimulate: () => { store.data.revoked[sid] = now(); flush(); } });
    return completed("end", rc, { vault, sid });
''', r'''    // >>> successor-host-r1 (REPLACES the send/completion): a sign-out reserves inside the control headroom
    return intentSubmit("end", intentId, { vault, sid },
      { to: vault, abi: vaultAbi, functionName: "terminateBySession", args, label: `funding end ${sid.slice(0, 10)}`,
        afterSimulate: () => { store.data.revoked[sid] = now(); flush(); } }, true);
    // <<< successor-host-r1
''')

R_RECONCILE = (r'''  async function reconcile(hash) {
    const h = hash.toLowerCase();
    const p = store.data.fundingPending[h];
    if (!p) throw httpError(404, "not_pending", "this relay has no pending successor transaction with that hash");
    let rc;
    try { rc = await pc.getTransactionReceipt({ hash: h }); } catch {
      throw httpError(202, "pending_reconciliation", "no receipt yet; nothing is resubmitted", { txHash: h });
    }
    if (typeof rc?.transactionHash !== "string" || rc.transactionHash.toLowerCase() !== h) {
      throw httpError(202, "pending_reconciliation", "receipt does not match the requested transaction; nothing is resubmitted", { txHash: h });
    }
    return completed(p.kind, rc, p.meta);
  }
''', r'''  // >>> successor-host-r1 (REPLACES reconcile): by the intent the hash belongs to, over EVERY hash of that submission
  // (a replacement that landed finalizes it); the queue journal is authoritative when the store index lags. Read-only.
  async function reconcile(hash) {
    const h = hash.toLowerCase();
    const p = store.data.fundingPending[h];
    const key = typeof p?.intent === "string" ? p.intent : intents.byHash(h);
    if (!key) throw httpError(404, "not_pending", "this relay has no pending successor transaction with that hash");
    const st = intents.state(key);
    return intentAnswer(p?.kind ?? st.reservation?.kind, key, st);
  }
  // <<< successor-host-r1
''')

ROUTE_HUNKS = [("signature", *R_SIG), ("activation", *R_ACT), ("recordPending", *R_PENDING), ("completed", *R_COMPLETED),
               ("execute key", *R_EXEC_KEY), ("execute send", *R_EXEC_SEND), ("open", *R_OPEN), ("owner key", *R_OWNER_KEY),
               ("owner send", *R_OWNER_SEND), ("end key", *R_END_KEY), ("end send", *R_END_SEND), ("reconcile", *R_RECONCILE)]


def die(m):
    sys.stderr.write(f"prepare.py: {m}\n")
    sys.exit(1)


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def read(path):
    with open(path, "rb") as f:
        return f.read()


def inside_stage(path):
    p = os.path.join(os.path.realpath(os.path.dirname(path)), os.path.basename(path))
    if os.path.commonpath([p, STAGE]) != STAGE:
        die(f"refusing to write outside the stage: {p}")
    return p


def apply(text, hunks, what):
    if MARK in text:
        die(f"{what} already contains {MARK}")
    out = text
    for name, before, after in hunks:
        if MARK in before or MARK not in after:
            die(f"{what} hunk {name}: malformed")
        if out.count(before) != 1:
            die(f"{what} hunk {name}: its anchor occurs {out.count(before)} times (must be exactly once)")
        out = out.replace(before, after, 1)
    back = out
    for name, before, after in reversed(hunks):
        if back.count(after) != 1:
            die(f"{what} hunk {name}: its result occurs {back.count(after)} times after patching")
        back = back.replace(after, before, 1)
    if back != text:
        die(f"{what}: undoing the hunks does not give the input")
    return out


def build():
    inputs = {}
    for rel, want in FP_PINS.items():
        b = read(os.path.join(FP, rel))
        if sha256(b) != want:
            die(f"fee-policy-r1/{rel} sha256 {sha256(b)} is not the pinned {want} (fee-policy-r1 changed: re-review and re-pin)")
        inputs[rel] = b
    try:
        fm = json.loads(read(FP_MANIFEST))
    except (OSError, ValueError) as e:
        die(f"fee-policy-r1 manifest unreadable: {e}")
    for rel, want in FP_PINS.items():
        if (fm.get("outputs") or {}).get(rel) != want:
            die(f"fee-policy-r1 manifest outputs[{rel}] is {(fm.get('outputs') or {}).get(rel)}, not {want}")
    if fm.get("unpinned") != {}:
        die(f"fee-policy-r1 manifest records unpinned inputs {fm.get('unpinned')}")
    if not str(fm.get("activation", "")).startswith("OFF"):
        die("fee-policy-r1 manifest does not state activation OFF")
    if "fundingQuotePolicy:" in inputs["generated/relay/sessions.mjs"].decode():
        die("the input host already wires a funding quote policy")

    sessions = (HEADER + apply(inputs["generated/relay/sessions.mjs"].decode(), SESSIONS_HUNKS, "sessions.mjs")).encode()
    route = (ROUTE_HEADER + apply(inputs["generated/relay/funding-route.mjs"].decode(), ROUTE_HUNKS, "funding-route.mjs")).encode()
    if b"fundingQuotePolicy:" in sessions:
        die("the generated host must not wire a funding quote policy (activation stays OFF)")
    for k, t in SYMLINKS.items():
        if not os.path.exists(t):
            die(f"{k}: the import target {t} does not exist")
    if not os.path.exists(os.path.join(SOURCE, "node_modules", "viem", "package.json")):
        die("source/node_modules has no viem")

    outputs = {
        "generated/relay/sessions.mjs": sessions,
        "generated/relay/funding-route.mjs": route,
        "generated/relay/funding-abi.mjs": inputs["generated/relay/funding-abi.mjs"],
        "generated/relay/fee-policy.mjs": inputs["generated/relay/fee-policy.mjs"],
    }
    rel_links = {k: os.path.relpath(t, os.path.dirname(os.path.join(STAGE, k))) for k, t in sorted(SYMLINKS.items())}
    hunks = {}
    for what, hs in (("sessions.mjs", SESSIONS_HUNKS), ("funding-route.mjs", ROUTE_HUNKS)):
        for name, before, after in hs:
            hunks[f"{what}: {name}"] = {"before": sha256(before.encode()), "after": sha256(after.encode())}
    observed = {}
    for k, p in sorted(TEST_INPUTS.items()):
        observed[k] = sha256(read(p)) if os.path.isfile(p) else "MISSING"
    manifest = {
        "inputs": {**{f"fee-policy-r1/{k}": v for k, v in sorted(FP_PINS.items())},
                   "fee-policy-r1/generated/PREPARE-MANIFEST.json": sha256(read(FP_MANIFEST))},
        "test_inputs_observed_unpinned": observed,
        "hunks": hunks,
        "outputs": {k: sha256(v) for k, v in sorted(outputs.items())},
        "symlinks": rel_links,
        "activation": "OFF: no hunk wires a quote policy or manifest into the host bootstrap",
        "note": "source-only stage: these hashes are computed when the root runs prepare.py; nothing here was executed by its author",
    }
    outputs["generated/PREPARE-MANIFEST.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    return outputs, rel_links


def write_outputs(outputs, links, check):
    stale = []
    for rel, data in outputs.items():
        path = inside_stage(os.path.join(STAGE, rel))
        if check:
            if os.path.islink(path) or not os.path.isfile(path) or read(path) != data:
                stale.append(rel)
            continue
        os.makedirs(os.path.dirname(path), exist_ok=True)
        path = inside_stage(path)
        if os.path.islink(path):
            die(f"{rel} is a symlink; refusing to write through it")
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    for rel, target in links.items():
        path = os.path.join(STAGE, rel)
        if not check:
            os.makedirs(os.path.dirname(path), exist_ok=True)
        path = inside_stage(path)
        if os.path.islink(path):
            if os.readlink(path) != target:
                (stale.append(rel) if check else die(f"{rel} links to {os.readlink(path)}, not {target}"))
        elif os.path.exists(path):
            (stale.append(rel) if check else die(f"{rel} exists and is not a symlink"))
        elif check:
            stale.append(rel)
        else:
            os.symlink(target, path)
    return stale


def main(argv):
    flags = set(argv)
    if flags - {"--check"}:
        die(f"unknown argument(s) {sorted(flags - {'--check'})}")
    outputs, links = build()
    stale = write_outputs(outputs, links, "--check" in flags)
    if stale:
        die("stale or missing: " + ", ".join(stale))
    m = json.loads(outputs["generated/PREPARE-MANIFEST.json"])
    for k, v in sorted(m["outputs"].items()):
        print(f"{v}  {k}")
    for k, v in sorted(m["test_inputs_observed_unpinned"].items()):
        print(f"OBSERVED (unpinned test input) {v}  {k}")
    print("checked" if "--check" in flags else "written")


if __name__ == "__main__":
    main(sys.argv[1:])
