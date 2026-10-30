# execute-expiry-recovery-r1: expired-unused release and same-nonce re-admission

**Status: SOURCE ONLY. UNREVIEWED, NOT RUN.** I used only Read, Grep and Write: no shell, no network, no node runs, no live
changes. Nothing outside this directory was modified. The canonical source, production and every other work directory are
untouched. Root must review the code and run the tests.

Base: canonical `source/sdk/funding/gas-execution.mjs` (client-execution-recovery-r1, 491 lines), read in full. I did not
use the stale root-r1 precursor `client-execution-recovery-root-r1/lib/gas-execution.mjs` as a base.

## Problem

In production, the first gas payment was refused before intentSubmit or TxQueue (`503 quote_policy_failed`, host quote
policy `gas_above_cap needs 1051860 > 1000000`). The client correctly journals this as **unknown**: a 5xx is never
proof that nothing was sent. But there was no way to release it:

- the entry blocks the session forever;
- `gas-exec:<sid>:<nonce>` admits exactly one entry, ever;
- the relay quotes `seqOf(sid, lane)` again, which gives the **same nonce**, so any new quote hits `execute_exists`.

No funds were debited.

## Deliverables

| Path | What |
|---|---|
| `sdk/funding/gas-execution.mjs` | **Candidate.** Drop-in replacement for `source/sdk/funding/gas-execution.mjs`. Its imports are byte-identical in form (`"viem"`, `./funding-codec.mjs`, …), plus `predictVault`, `encodeFunctionData` and `keccak256` from the same modules. |
| `sdk/funding/browser-entry.mjs` | **Candidate.** The canonical entry plus the new names: `proveExpiredUnused`, `executionStatusView`, `MAX_PREDECESSORS`, `EXPIRABLE`, `RELEASABLE`. |
| `site-patch/funding.js.diff` | **Proposed page patch (not applied).** Adds one `EXEC_LABEL` line, and the read-only check message now appends `executionStatusView(r.status).text`, so only `settled` is ever worded as funded. `site/vendor/funding.js` must be rebuilt from the sdk by the normal bundling step. |
| `test/expiry.test.mjs` | **New tests**, 12 of them (listed below). |
| `test/execution.test.mjs`, `test/guard.test.mjs`, `test/root-regression.fixed.test.mjs`, `root-review/reservation-regressions.test.mjs` | The existing **25 tests**, copied verbatim except for import specifiers. |
| `test/exec-fixtures.mjs` | Fixtures with imports adjusted (see the deviation below). |
| `sdk/funding/{funding-codec,util,v2-store,chain-proof,funding-client,migration}.mjs`, `node_modules/viem/*` | **Test shims only.** Each is a one-line `export *` of the canonical module, so the portable candidate resolves here to the **same module instances** as the canonical sdk. They are not deliverables. |

### One deviation from "import adjustment only"

The canonical codec trusts only configs produced by its own `fundingConfig()`; the trust list is a module-local
`WeakSet`. The r4 fixture `cfg` comes from the client-r1 codec, so the canonical codec would reject it
(`config_untrusted`). `exec-fixtures.mjs` therefore builds the same `cfg` and `runtime` values with the canonical
`fundingConfig()`.

`runtime.pins` also gains `codehashes`, the shape `verifyRuntime` really returns, with `implementation` set to
`keccak256(IMPL_CODE)`. `runtimeIdentity` reads only `pins.usdc`, so stored intents are unaffected.

## The expired-unused proof (`proveExpiredUnused`, read-only, never writes)

Contract basis (`SessionVault.execute`):

- it reverts `Expired` when `block.timestamp > deadline`;
- it requires `seqOf[sid][uint192(nonce >> 64)] == uint64(nonce)`, then increments it;
- every later Base block has a later timestamp.

So: if a **finalized** block has a timestamp after the deadline, and `seqOf` at that block still equals the stored
sequence, the signed call never ran and can never run.

Steps. Every failure throws `expiry_not_proven` with `detail.reason`, and the entry's status is left unchanged.

1. **Stored metadata.** These must be canonical decimals, non-zero where it matters, and mutually consistent:
   - stored chain ids (runtime, record and domain) are `"8453"`, and so is the runtime cfg;
   - `lane == nonce >> 64`, `seq == nonce & (2^64-1)`, and `call.nonce == nonce`;
   - the call and intent deadlines are non-zero, and the anchor number is valid;
   - the vault matches the stored runtime, the record and the domain, and equals `predictVault(factory, implementation, owner)`;
   - `runtime.pins.codehashes.implementation` is present (`runtime_pins_missing` otherwise).
2. **Chain.** `eth_chainId` must be `8453` (`wrong_chain`).
3. **Finalized header.** Read `eth_getBlockByNumber("finalized")`, then re-read the same block **by number**. Number, hash
   and timestamp must be canonical, non-zero, and identical in both reads. Reasons: `header_missing`, `header_malformed`,
   `header_zero`, `header_number_mismatch`, `header_hash_mismatch`.
4. **Deadlines.** The finalized timestamp must be **strictly** greater than both the call deadline and the intent deadline
   (`not_past_deadline`). The block must also be after the pre-send anchor (`not_after_anchor`).
5. **Code at that pinned block number.**
   - The vault code must equal the exact EIP-1167 clone runtime of the verified implementation (`vault_code_mismatch`).
   - `keccak(implementation code)` must equal the verified pin (`implementation_code_mismatch`).
   - This is the existing verifier's model (the codehash pin plus the CREATE2 clone), so `seqOf` is never read from an
     arbitrary contract.
6. **Nonce.** Call `vault.seqOf(sid, lane)` at that block, with `lane = nonce >> 64`. The answer must be a 32-byte uint64
   word (`seq_malformed`).
   - `> seq` gives `nonce_consumed`.
   - `≠ seq` gives `seq_mismatch`.
7. **Re-check.** The header at the pinned number must still have the same hash, and the finalized head must not have moved
   below or off it (`reorged`).

Never used: `latest`, `pending`, `safe`, head time, or log absence. A test asserts the RPC tags the proof uses.

The proof object is public only: block, hash, timestamp, lane, seq, seqOf, both deadlines, digest, intentHash, vault and
code hashes.

## Status handling

- **New status `expired_unused`.** It is added to `CLEARED`. `isBlocking` for old-schema (r4) entries is unchanged: only
  `settled` clears.
- **`reconcileGasExecution`.** The existing settlement, supersession and contradiction logic runs first, unchanged. Only
  if it ends unresolved, and the status is in `EXPIRABLE` (`dispatching`, `unknown`, `pending`, `reverted_observed`), does
  it try the proof.
  - **On success**, a CAS transition sets `expired_unused` and evidence = proof. The prior status and evidence go to
    `history`; `outcome`, `hints`, `call` and `intentHash` are untouched.
  - **On failure**, the existing `why` strings are kept and `observation.expiry = { proven: false, reason }` is added.
- **Freshness of an `expired_unused` entry on reconcile** (read-only, no write). The stored proof header must still be the
  canonical header at its number, at or below the finalized head.
  - If it was replaced (`evidence_reorged`), the entry goes back to `unknown`, the old proof is kept in history, and the
    normal reconcile path runs again. This matches the existing observed-reorg handling.
  - Any other recheck failure returns `expiry_recheck_failed` and changes nothing.
- **Unchanged:** `settled`, `superseded`, `refused`, `never_dispatched` and `abandoned_before_send` reconcile exactly as
  before.

## Same-nonce re-admission (`confirmGasFund`)

This happens only when the user clicks with a new quote. Nothing is autoloaded, retried, signed or sent on its own.

1. The existing bind checks, deadline check and session-blocker check run unchanged. An unresolved entry still gives
   `unreconciled_execute`.
2. If `gas-exec:<sid>:<nonce>` already exists, `releasePrior` runs before the anchor pin, before admission and before any
   signature:
   - The entry must be r2 and its status in `RELEASABLE` (`expired_unused`, `refused`, `never_dispatched`,
     `abandoned_before_send`). Otherwise `execute_exists`. Settled, superseded, unresolved and old-schema entries are
     never replaced.
   - `verifyStoredIntent(prior)` must pass.
   - There must be fewer than `MAX_PREDECESSORS = 4` predecessors (`predecessor_history_full`).
   - The new digest must differ from the prior digest and from every predecessor digest (`digest_reused`).
   - For `expired_unused`, the stored proof header is rechecked; then a **fresh** `proveExpiredUnused` runs at the current
     finalized head.
   - `refused`, `never_dispatched` and `abandoned_before_send` also need that fresh proof. This is conservative: for
     example, after a page-guard abandon the user waits for the old deadline plus finality.
3. **Atomic CAS replacement.** The CAS fails `execute_exists` unless the current entry has exactly the prior's status, rev,
   intentHash and predecessorsHash.
   - The new entry gets the new intent, `rev = prior.rev + 1`, and `predecessors = [...prior.predecessors, {…complete prior public entry, release: freshProof}]`.
   - `predecessorsHash = hashOf(predecessors)`.
   - Concurrent admissions therefore produce exactly one winner. The loser fails before signing.
4. Everything after that is the unchanged flow: other-execution re-check, sign in memory, CAS to dispatching, POST,
   conservative classification.
5. **`verifyStoredIntent` also checks the history.** It must be bounded and hash-bound. Each predecessor must have the same
   id, sid and nonce, a complete intent with a matching intentHash, a `RELEASABLE` status, and a release proof for exactly
   its own intentHash and digest. No digest may repeat.

`quoteGasFund` is synchronous and unchanged in form. It allows a quote once the entry is `expired_unused`, which is
cleared. The fresh proof is enforced at `confirmGasFund`, before anything is signed.

## Test coverage map (`test/expiry.test.mjs`)

| Requirement | Test |
|---|---|
| 503 `quote_policy_failed` → unknown, reserved, not cleared before deadline finality | "production 503 …" |
| valid expiry clears; intent/hash/outcome/hints preserved; read-only recheck writes nothing; no POST/sign | "valid expiry clears read-only …" |
| finalized + numbered tags only (no latest/pending/safe); correct lane; vault target; pinned tag | "the proof reads only the finalized header …" |
| wrongchain, header number, header hash, zero hash/number, malformed, no finalized, **not finalized while latest past**, **timestamp == deadline**, nonce consumed, **other lane**, vault code, impl codehash, malformed seqOf, **reorg during proof**, pins missing, seq mismatch | "every missing / malformed / …" (table) |
| reorg of stored proof: refused at admission, demoted with history, re-proven | "reorg of a STORED proof …" |
| new quote, same nonce, CAS, full predecessor verbatim, one POST, cost 65 000 and maximum unchanged, grant unchanged, later settles, history survives | "user-requested new quote …" |
| concurrent same-nonce admissions: one admit, one sign, one POST | "concurrent fresh same-nonce …" |
| exact old digest never reused | "the exact old signed digest …" |
| settled never overwritten; refused only with proof | "settled entries are never replaced …" |
| bounded history, refuse on exhaustion, unique digests | "bounded predecessor history …" |
| tampered history refused; old-schema interpretation kept | "tampered predecessor history …" |
| UI/cleared mapping: expired_unused never "funded" | "UI mapping …" |

The 25 existing tests are expected to pass unchanged. Root, please verify this.

- **"connection lost / unreachable … keeps the reservation forever"** still passes, because its scripted chain does not
  answer `eth_chainId`, `eth_getCode` or `eth_call`, so the proof fails closed. Semantically, though, a correctly scripted
  chain could now release such an entry. That is intended; root may want to rename the test.
- **"exact call reverted on chain stays reserved"** keeps its `why`, because chain time never passes the deadline.

## Risks and open points for root

1. **Not run.** Every statement about test outcomes above is expectation, not observation.
2. **RPC must serve state at the finalized block.** `eth_getCode` and `eth_call` are read at the finalized number. On Base
   that block is typically hundreds of blocks behind head, and a pruned node may answer "missing trie node". That error
   fails closed (the reason is recorded as `error:…`, nothing changes), so the release then needs an RPC that serves that
   state. Reads use the number tag plus a hash re-check, as the existing `verifyRuntime` / `pinBlock` do, not EIP-1898
   `{blockHash}`.
3. **Release latency.** The deadline (about 300 s) has to pass, and then Base's finalized head has to pass it, which
   depends on L1 finality. Users will see `not_past_deadline` for a while; that is expected.
4. **Relay-side reservation.** `reservation-regressions` shows the relay can answer `409 intent_conflict` while a nonce
   "belongs to different signed terms". In this production case the refusal came before intentSubmit, so no host
   reservation should exist. If the relay or host does keep one, the re-admitted call gets `intent_conflict`, which stays
   unknown, is never resent, can be expired again, and uses up one predecessor slot. The relay should drop reservations
   once their deadline has passed. This is outside this client change.
5. **History integrity is local.** `predecessorsHash` detects edits to the list, but it is not folded into `intentHash`.
   Deleting both `predecessors` and `predecessorsHash` loses audit history only. It cannot enable reuse of an expired
   digest: the deadline check plus the chain's `Expired` revert prevent that. This is the same local-journal trust model
   as the existing code.
6. **Page.** The diff is minimal. `renderExecutions` lists blocking entries only, so released entries disappear from
   "Gas payments" and the "Get quote" path works again. Nothing labels them funded.
