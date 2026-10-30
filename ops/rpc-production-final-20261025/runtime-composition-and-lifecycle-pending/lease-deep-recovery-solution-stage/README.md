# lease-deep-recovery-solution-stage: owner-move recovery after a deep (> 256-block) release receipt (PREPARED, NOT RUN)

**Status:** prepared only.
- **Not done:** no tests, queue use, native build, SSH, live change or commit. Only `node --check` (syntax) was run on
  the three files.
- **Not touched:** `relay-consumer-source`, which is read only, and the 50cf Windows/conduit stage files. The edited
  files are private copies.
- **Policy unchanged:** nothing weakens the canonical gate, finality or tiers, and no unverified receipt is labelled
  confirmed. **Custody v2 stays refused.**

## Problem (from `canonical-consumer-depth-audit/LEASE-RECOVERY-FOLLOWUP.md` + `LEASE-OUTCOME-TRACE.md`, rechecked at `81ba66853`)

**The deep-receipt case.** Under `ENCLAVE_CHAIN_AUTHORITY=verifier`, the canonical verifier is the **sole** lease
voter. A sponsored release receipt more than 256 blocks below the head (after a supervisor restart, or an
outage of the resolver or verifier) cannot be verified, so `resolveSigned` gives `consumed`/`expired`, and the
supervisor closes the intent as `gone`/`not-held`/`gave-up` instead of `released`.

**What that does to the owner-move route** (`supervisor.js:8345-8366`): it answers **503 `release_unconfirmed`** with
`leaseHeld:false`.

**How every client reads that answer.** The shared classifier `network/management-outcome.mjs` makes
`release_unconfirmed` outcome-*unknown* for every client. `ManagementError` carries `{status, code, outcomeUnknown}`
**without the body**, so the CLI never sees `leaseHeld`.

**The only owner-move client.** That is `cmdMoveIndependent` in `cli/enclave.mjs`.
- **Not callers:** `network/management-browser.mjs` and `site/js/core/independent-management.js` never call
  `release`. The site's `op: "release"` (`deployments.js:4174`) is the session-vault release, which is unrelated. No
  mobile client exists in this repo. `metal/guest/mcp-server.bundle.mjs` only bundles the same classifier.

**What the CLI already does.** It sends **one** release and lets **its own current-ledger read** (`moveSnapshot`)
decide, so a deep receipt does not by itself block a move.

**The concrete defects:**
1. **A 15 s window for `release_unconfirmed`.** It has a `code`, so the CLI waits 15 s instead of 90 s. A release still
   being resolved or mined is abandoned with exit 4.
2. **Wrong outage label.** When the quorum is unreachable for the whole window, the CLI says "the lease is still held
   by … on the quorum". That is false: the state is unknown.
3. **One unsafe-head read is enough.** A single snapshot showing absence at the unsafe head clears the source and
   starts hinting. A reorg back to the source's lease is not guarded.
4. **No receipt caveat.** When the host's receipt was not verified, the success label does not say so.

## Solution: CLI-only, no new protocol, no supervisor, gate or ledger change

**New `cli/move-release-confirm.mjs`, a pure function `confirmSourceLeaseCleared`:**
- **Exactly one `release()`.**
- **Then it polls the owner's current ledger** (`moveSnapshot(id, null)`) for the 90 s answer window, for every
  non-definite answer, including `release_unconfirmed`.
- **Cleared** means the source's lease is absent (runner zeroed = `released`; the same runner not held = `lapsed`;
  another runner = `taken`) on **2 snapshots at strictly increasing blocks**.
  - A snapshot showing the source's lease again (a reorg) resets the count.
  - Same-block or lower-block reads count for nothing.
- **Explicit outcomes:**

  | Outcome | Meaning |
  | --- | --- |
  | `cleared` | `{how, firstBlock, block, receiptVerified}` |
  | `refused` | a definite pre-effect refusal; one read, no sleep |
  | `still-held` | the source held the lease on every readable snapshot |
  | `clear-unconfirmed` | absence was seen but not confirmed, or contradicted |
  | `quorum-unavailable` | no read succeeded |

- **`receiptVerified`** is true **only** when the host answered `released:true`.

**Patched `cmdMoveIndependent` (a private copy of `cli/enclave.mjs`):**
- It uses the function and keeps every prior refusal, message and exit code.
- **The success labels now add:** "the source's release receipt is NOT verified here (current-ledger absence only)"
  when unverified.
- **The three unknown outcomes** each print an accurate reason. "Quorum could not be read: lease state UNKNOWN" is
  never "still held". They exit 4 with "Nothing more was sent".
- **Unchanged:** the same-operator refusal, the rate cap, the balance and target checks, the confirm prompt, the hint
  loop, and `clearedBlock` gating of "new lease" detection.

**Why this is sufficient and safe:**
- **The authority is current state, not history.** The move's authority is the owner's own current ledger state
  (deployment runner and `leaseUntil`), not the historical receipt. That is exactly what the existing code already
  relied on.
- **The host side is already correct and fail-closed** (`LEASE-OUTCOME-TRACE.md` §2–4):
  - a deep receipt closes `gone`, which sets the hold-off and the lease floor;
  - there is no re-sign while the ledger shows the lease gone, and exactly one re-sign while it still holds the same
    lease;
  - an unreadable ledger leaves the intent open (`release_in_progress`, app stopped, no resume or re-claim) until it
    resolves.

  So **restart and outage recovery already converge** once the verifier or quorum is back. No supervisor change is
  needed.
- **Nothing is ever claimed or resent:** no historical receipt is claimed verified, and no release is resent in any
  outcome (tested).

**Limits (explicit):**
- **Unsafe head, not finality.** Two increasing blocks reduce the reorg risk; they are not finality.
- **What "authenticated" means here.** The CLI's snapshot is "authenticated current state" only to the extent of the
  owner's configured chain source (its RPC quorum today, or a verifier authority if configured). This patch does not
  change that source.
- **A quorum outage still blocks a move** (exit 4, unknown). There is no safe way to hand off without knowing the
  current lease. Re-running the move later is safe: it reads the ledger first, and `m.held` false skips the release.
- **Supervisor labels still degrade** for deep receipts (`gone` vs `released`). The degradation is benign per the
  trace; it is not changed here.
- **Same-operator moves stay refused** (unchanged, `work/lease-epoch-proposal.txt`).

## Files

| File | Notes |
| --- | --- |
| `base/cli/enclave.mjs` | `git show 81ba66853:cli/enclave.mjs`, blob `4ef7f7a15904a2279d3cfdda872ac4aafeb7f786` |
| `candidate/cli/enclave.mjs` | the patched private copy |
| `candidate/cli/move-release-confirm.mjs` | new |
| `candidate/test/move-release-confirm.test.mjs` | new, 14 tests |
| `move-release-recovery.patch` | 269 lines |

**The patch:** applies with `git apply` onto a `git archive` of `81ba66853` and reproduces all three candidate files
exactly (checked).

**The tests:** they exercise the **real module** over a fake boundary. That boundary is the host answer, shaped as
`management-client.mjs`'s `ManagementError` `{code, outcomeUnknown}`, plus the owner's ledger snapshots and a fake
clock. Cases:
- a host-verified release;
- the deep receipt via `release_unconfirmed` (cleared, `receiptVerified:false`);
- a late landing inside 90 s;
- a changed generation (another runner);
- a lapsed lease;
- a reorg (reset, and a persistent one);
- lagging reads;
- a full outage, and an outage then recovery;
- still held;
- a definite refusal;
- a malformed snapshot;
- **exactly one release in every outcome.**

**NOT RUN.**

**Root command, if approved** (from a clean clone of `relay-consumer-source` at `81ba66853`; offline; no new
dependency):
```
git apply lease-deep-recovery-solution-stage/move-release-recovery.patch
node --test test/move-release-confirm.test.mjs test/management-move-unit.test.mjs
```
