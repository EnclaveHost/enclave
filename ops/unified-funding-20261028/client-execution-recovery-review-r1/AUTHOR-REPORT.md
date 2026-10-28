# client-execution-recovery-r1 — gas.fund execution ambiguity and durable recovery

**Status: source only. Nothing here was run, tested, built or bundled by its author.** I used only Read, Grep and Write,
and wrote only `client-execution-recovery-r1/`. I did not modify:
- client-repair-r4 (lib or tests);
- client-site-repair-r2, its candidate or its authored page;
- the active client-site-browser-r1 harness;
- `source/`, production or any wallet.

Root's `root-regression.test.mjs` is preserved byte for byte. Every `FUNDING_*` value stays `null`; there is no approval
or activation. The pending real deployment request remains UNKNOWN and is not part of any test.

## The three root failures

Root's three regressions fail against unchanged r4:

| # | Failure | Cause |
|---|---|---|
| 1 | Body lost after 200 headers → `refused` | r4's `confirmGasFund` journals `refused` for any error whose code is not `relay_unreachable`. The body loss is a raw `TypeError` from `res.text()`. |
| 2 | Gateway 502 → `refused` | Same rule: a 502 is a `RelayError` with code `relay`. |
| 3 | No exact call journaled | The entry holds only digest, nonce, argsHash and the maximum, so nothing can verify a settlement after reload. |

The ported copy, `test/root-regression.fixed.test.mjs`, keeps the three assertions identical. Its only differences are
listed in its header:
1. the successor `confirmGasFund`;
2. a complete stored gas record, because the successor refuses to sign for a record it cannot bind;
3. `relayBase` = that record's relay;
4. an RPC that answers only the pre-send anchor read and, like root's stub, throws once the relay was reached.

## What changed: `lib/gas-execution.mjs`

The new module imports the unchanged r4 core. It is the only new runtime code.

**Binding before signing.** The review is re-derived with the reviewed codec (`buildGasFundCall`) for the verified
runtime and the stored record:
- the record must be open, its key hash must match its public key, and it must belong to the same owner, vault and chain
  as the runtime;
- `relayBase` must equal the record's relay;
- digest, args, argsHash, sessionId, action, domain, deployment and maximum must all match;
- only the re-derived digest is signed.

**Durable public intent before send.** The journal entry `gas-exec:<sid>:<nonce>` (schema
`enclave-funding-gas-execute-r2`) holds:
- the runtime contract identity and the expected submitter;
- the record's public identity: key hash, x, y, owner, vault, chain, relay, sid;
- the relay, sid, nonce, deployment and holder;
- the exact encoded call: domain, digest, argsHash, args, lane, seq, fee, deadline and the decoded intent;
- the maximum;
- a pinned chain anchor read before send (r4 `pinBlock`);
- an `intentHash` over all of the above.

No private key, signature or execute body is stored; r4's `assertPublic` still refuses those keys.

**Atomic admission.** Every transition is a compare-and-set; there is no `putJournal`.
1. CAS-create, refusing if the entry already exists.
2. Re-check that no other unresolved execution of the session exists; if one does, the new entry becomes
   `abandoned_before_send` before signing.
3. Sign in memory.
4. CAS `admitted → dispatching` immediately before the POST.

Each transition checks the stored `rev`, `status` and `intentHash`, so a settled or unknown entry is never overwritten.

**Outcome classification.** `refused` is used only when all of these hold:
- the error is a well-formed relay error (its JSON body's `code` equals the error code, and its `error` is a string);
- the body names no transaction;
- its exact (HTTP status, code) pair is in `DEFINITIVE_REFUSALS`. Those are codes that both `relay-owner-r2` and
  `activation-r1` `funding-route.mjs` `execute()` raise before `simulateAndSend`.

Everything else is `unknown`, or `pending` when the reply carries a valid hash:
- transport errors and a body lost after headers;
- malformed JSON, an HTML 4xx, and every 5xx (the relay's own 502 `settlement_*` replies come after a send);
- `409 revert`: excluded on purpose, because the host's `simulateAndSend` (activation-r1 `sessions.mjs`, line 882) also
  throws it after an on-chain revert;
- `409 reverted`, and a 200 or 202 without a valid `txHash`.

One exception: the page's own guard (`flows.js` `guardRelayFn`) throws a `StateError` (`context_changed`) before calling
the relay. Only that error class, never a `RelayError` or fetch `TypeError`, becomes `abandoned_before_send`. The optional
`dispatchGuard` does the same immediately before the dispatching marker.

**Read-only reconciliation** (`reconcileGasExecution`). It never signs, never POSTs, never resends and never invents a hash.
1. It first verifies the complete stored intent with `verifyStoredIntent`:
   - `intentHash`;
   - id = sid/nonce;
   - the runtime identity equals the live verified runtime;
   - same relay;
   - the stored gas record exists and matches;
   - the call re-derives to its digest, args, domain and maximum.

   A failure returns `intent_invalid` and writes nothing.
2. `admitted` (no dispatching marker was written) → `never_dispatched`.
3. Non-final evidence (`observed`, `superseded_observed`) is re-proven. If the receipt is no longer canonical, or sits in
   a different block, the entry returns to `unknown`, the old evidence moves to `history`, and discovery reruns.
4. Candidates are only hints:
   - journaled hashes;
   - the relay's own session index (GET `/funding/session/<vault>/<sid>`; any failure means "no hint", never a refusal);
   - one bounded `eth_getLogs` for the vault's `SessionOp(sid)`. It covers `[anchor, anchor + 600]` (capped at latest)
     and examines at most 16 candidates; removed or out-of-window logs are rejected.
5. Each candidate is proven with:
   - the unchanged `canonicalReceipt`;
   - `eth_getTransactionByHash` binding: same hash/block, `to` = vault, input decodes to `execute(sid, nonce, 10, args,
     fee, deadline, x, y)` with exactly the stored values;
   - the unchanged `verifySettlement` (codec settlement proof, with the stored relayer as submitter);
   - the unchanged `receiptFinality`.

**Outcomes:**

| Status | When |
|---|---|
| `settled` | Exact settlement proven and final. |
| `observed` | Exact settlement proven, canonical but not final. It keeps blocking. |
| `superseded` / `superseded_observed` | A different canonical operation consumed our sid/nonce (the SessionOp argsHash differs), final or not. |
| `reverted_observed` | Our exact call reverted on chain. It keeps blocking. |
| `contradiction` | Two exact proofs, exact plus superseding, a repeated SessionOp, or our exact op inside a transaction that is not a direct call of our signed execute. Nothing changes; it is left for review. |
| `unresolved` | Nothing proven. Status and reservation are unchanged, and the observation window is recorded. |

**Quote gate.** The successor `quoteGasFund` refuses while the session has a blocking execution. Then r4's own check runs
on the remaining entries.

**Clearing statuses:**

| Clears the session | Keeps it reserved |
|---|---|
| `settled` (final), `superseded` (final), `refused` (allowlisted), `never_dispatched`, `abandoned_before_send` | everything else |

Pre-r2 (r4) entries clear only when `settled`, because r4 could journal `refused` wrongly.

## Files

| File | Role |
|---|---|
| `lib/gas-execution.mjs` | The successor execution module. |
| `lib/browser-entry.mjs` | The successor entry: every r4 export unchanged, plus explicit re-exports of the execution API. The explicit names override the `export *` ones. |
| `test/exec-fixtures.mjs` | Scripted chain and relay. Real WebCrypto P-256, the codec, r4 `MemoryV2Store`, `relayClient`, `canonicalReceipt`, `receiptFinality` and `verifySettlement`. |
| `test/execution.test.mjs` | 16 offline tests (see below). |
| `test/guard.test.mjs` | 4 tests with r2's unchanged `flows.js` guards. |
| `test/root-regression.fixed.test.mjs` | Root's three assertions against the successor. |
| `root-regression.test.mjs` | Root's file, unchanged. Expected to still fail 3/3 against r4. |
| `integration/prepare.py` + `generated/PREPARE-PINS.json` | Builds `prepared/sdk/funding/` (described below). |
| `integration/PAGE-PATCH.md` | Anchored instructions for the r2 page (described below). |
| `native/generate.py` + `generated/NATIVE-PINS.json` | Derives `out/server.mjs` from the root-qualified prior fixture server (described below). |
| `native/execute-fault.native.test.mjs` | Node over real HTTP against that server (described below). |
| `page/index.html`, `page/dist/harness.js`, `generated/HARNESS-INPUTS.json` | Placeholder page and module required by the derived server's hash gate. The pins are null; root fills them. |

**`integration/prepare.py`:**
- copies the six unchanged candidate core files byte for byte (checked against the candidate MANIFEST);
- writes `gas-execution.mjs` with only its six import specifiers rewritten (exact counts, reversible);
- writes the successor portable `browser-entry.mjs`, a new MANIFEST and `INSTALL.json` (must-not-exist / replaces_sha256 /
  rollback);
- refuses if `prepared/` exists or any pin is null or drifts.

**`integration/PAGE-PATCH.md`:**
- a "Gas payments" section listing this browser's blocking executions, scoped to the exact owner / chain / vault / relay /
  key records;
- an explicit read-only reconcile button that needs only the runtime pins, the chain and the store, not the catalog,
  sessions config or intake;
- `relayBase` and `dispatchGuard` added to `fundArgs`.

It is not applied anywhere.

**`native/generate.py`:** the pin is root's own `48246ef1…`. Its edits:
- `eth_getTransactionByHash` added to the read-only RPC allowlist;
- the open-reply fault turned off;
- a one-shot execute reply fault (`body` = 200 headers + truncated body + socket destroyed; `gateway502`), applied after the
  real service handled and submitted the execute;
- a temp-dir prefix.

The generator refuses null or drift, an anchor not found exactly once, `--code-size`, `pkill` and `killall`.

**`native/execute-fault.native.test.mjs`:**
- opens one successor gas session (8 apps, 0.8 TEST) through the real relay;
- for each of `body` and `gateway502`: `unknown`, exactly one execute sent, settled read-only from the real chain, zero new
  prompts, zero resends, session debited exactly once;
- last, a request that never reaches the relay: `unknown`, unresolved, quote refused.

It stops only the child server it spawned (SIGTERM), and that server stops only its own Anvil.

## What the offline tests cover (`test/execution.test.mjs`)

- **Lost replies:**
  - Body loss after 200: `unknown`, exact call stored, no secret, then `observed` → `settled` read-only. One POST and one
    signature in total.
  - Gateway 502: `unknown`, then settled.
  - Unreachable relay: `unknown`. Reconcile stays unresolved even far past the deadline in chain time. Discovery is bounded
    and starts at the anchor; the quote and a second confirm are refused, with no second send or signature.
- **Malformed and refused replies:**
  - Malformed 200 and hashless 200: `unknown`, still blocking.
  - The refusal allowlist versus look-alikes: `revert`, `reverted` + hash, a refusal naming a hash, 503, the relay's 502s,
    and an HTML 400.
- **Pending and finality:**
  - 202 with a hash: `pending` → `observed` → `settled`.
  - Normal success: `observed` blocks the next quote until finality.
- **Durability and concurrency:**
  - Durable JSON round trip into a fresh store with fresh clients.
  - Concurrent confirmations: the same review sends once; two nonces never both send.
- **Tampering:** a tampered call, a call with a recomputed `intentHash`, a foreign runtime vault and another relay are all
  `intent_invalid`, and the entry is unchanged.
- **Candidate rejection:** a foreign hint, reorg after observation (evidence kept in history), a wrong log blockHash, a
  removed log, a preconfirmation, and an exact op in an unbound transaction (`contradiction`).
- **Nonce and revert:** a nonce consumed by another canonical operation becomes `superseded_observed`, then `superseded`;
  an exact reverted call stays `reverted_observed`.
- **Binding before signing:** a tampered digest or maximum, another relay, or another owner gives 0 sends, 0 signatures and
  0 entries.
- **Crash before dispatch:** a crash before the dispatching marker becomes `never_dispatched`.
- **Successor entry:** it overrides only the execution names. r4 migration and every other export are the same objects.

## Commands for root (none run by me)

1. Root failures against unchanged r4 (expect 3 FAIL):
   `node --test client-execution-recovery-r1/root-regression.test.mjs`
2. Successor offline suite:
   `node --test client-execution-recovery-r1/test/root-regression.fixed.test.mjs client-execution-recovery-r1/test/execution.test.mjs client-execution-recovery-r1/test/guard.test.mjs`
3. Unchanged r4 migration and legacy regressions (the lib does not touch them):
   `node --test client-repair-r4/test/offline.test.mjs client-repair-r4/test/partition.test.mjs client-repair-r4/test/scope.test.mjs client-repair-r4/test/wire.test.mjs client-repair-r4/test/root-reorg.test.mjs`
4. Native fault run:
   1. `python3 client-execution-recovery-r1/native/generate.py`
   2. fill `generated/HARNESS-INPUTS.json`
   3. `node --test client-execution-recovery-r1/native/execute-fault.native.test.mjs` under the shared queue (1 CPU, the
      existing guard; it spawns one Anvil).
5. Portable preparation: fill `generated/PREPARE-PINS.json`, then run
   `python3 client-execution-recovery-r1/integration/prepare.py`.

## Limitations

- **Nothing executed.** Every file is unrun, so syntax and logic errors are possible.
  - The offline chain and relay are scripted.
  - The native test uses `MemoryV2Store`, not IndexedDB.
  - The browser path (real IndexedDB, the patched page, the bundle) is not exercised. The page patch is not applied, and
    the active site-browser harness was deliberately not changed. A browser fault run needs a separate, reviewed harness
    change.
- **A lost execute with no hash and no on-chain trace stays unknown forever.** That is the conservative rule required
  here: no clearing on wall time, on an unused nonce, or on relay disappearance. The session's gas.fund is then blocked
  permanently. Owner controls (terminate, withdraw, end) still work, but the reserved budget is not spendable by a new
  gas.fund through this client. A possible future rule is chain time past the call deadline at a final block, with no
  SessionOp for that nonce in the window. It is not implemented, because it relies on an unused nonce.
- **A reverted transaction does not settle identity.** A canonical reverted receipt for our exact calldata proves only
  that this transaction reverted. The same signature could be broadcast again until the deadline, so the entry stays
  reserved.
  - A reverted receipt has no logs, so its identity rests on the decoded calldata alone.
  - A reverted transaction that wrapped our call through another contract would not be recognised.
- **Indirect execution is not resolved.** If our exact SessionOp appears in a transaction that is not a direct
  `vault.execute` of our call, the result is `contradiction` and needs manual review.
- **Relay honesty is assumed for allowlisted refusals.** The relay received the signature. The allowlist trusts its
  specific pre-send refusal codes as a statement that it did not submit, and a dishonest relay could still broadcast until
  the deadline (at most 900 s).
- **Discovery depends on the RPC.**
  - It needs `eth_getLogs` and `eth_getTransactionByHash`. If a provider refuses them, reconcile throws and nothing
    changes.
  - The 600-block window covers 900 s of Base blocks. It is for Base 8453 only.
- **Finality is conservative.** After a successful fund, the next quote waits until a reconcile proves finality. On Base
  that can take many minutes.
- **Concurrency.** Two concurrent confirmations with different nonces in one session send at most once, but both may
  abandon; the user retries.
- **The guard exception relies on an error class.** It trusts the page's `StateError` class name and code, which a relay
  response cannot produce through `relayClient`.
- **Out of scope:**
  - r4's owner-op, end and open journals keep their old `refused` classification for 5xx and body loss. They are not
    gas.fund spends.
  - r4 execute entries written before this change are `legacy_unverifiable` and block unless `settled`. FUNDING_* has been
    null in production, so only test journals have them.
- **Relayer rotation.** The stored relayer is used as the expected submitter. If the relayer rotates, earlier proofs still
  verify against the relayer that was current at send time.
