# Lease deep-receipt recovery: solution prepared (2026-10-26 UTC)

**Result: a bounded, actionable, CLI-only patch.** It is **PREPARED and NOT RUN**.
- **What it changes:** no new protocol, and no change to the supervisor, the canonical gate, the ledger or finality.
- **Where:** stage `lease-deep-recovery-solution-stage/` (`SHA256SUMS` `689eb9ad…`, 6 entries, passes `sha256sum -c`).
- **Not done:** no tests, queue use, native build, SSH, live change or commit. Only `node --check` was run.
- **Not touched:** `relay-consumer-source` (read only, `81ba66853`) and the 50cf Windows/conduit files.

## Finding (traced at `81ba66853`)

- **Host side is correct and fail-closed.** Per the depth audit, a deep (> 256-block) sponsored release receipt ends
  as `gone`/`not-held`/`gave-up` (hold-off and lease floor set).
  - It never re-signs while the ledger shows the lease gone, and re-signs exactly once while the same lease is still
    held.
  - An unreadable ledger keeps the intent open, with the app stopped and no resume or re-claim.
  - So **restart and outage recovery already converge** on the host. Only the labels degrade (`gone` vs `released`).
- **Only one client of the owner-move route.** That is the CLI `cmdMoveIndependent`.
  - The browser helper and site never call `release`. The site's `op:"release"` is the unrelated session-vault
    release. There is no mobile client in this repo.
  - The shared classifier makes 503 `release_unconfirmed` *unknown*, and `ManagementError` drops the body, so the CLI
    never sees `leaseHeld:false`.
  - The CLI already lets its own **current-ledger** read decide.
- **The real defects (CLI):**
  1. `release_unconfirmed` gets only a **15 s** window, so a late landing is abandoned.
  2. A quorum outage is reported as **"still held"**, which is false.
  3. A **single** unsafe-head snapshot clears the source, with no reorg guard.
  4. The success labels do not say when the receipt was unverified.

## Solution

**New `cli/move-release-confirm.mjs`** (a pure `confirmSourceLeaseCleared`; `06506cfc…`):
- **Exactly one release.** Then it polls the owner's current ledger for 90 s on any non-definite answer.
- **Cleared** requires the source's lease to be absent (`released` / `lapsed` / `taken`) on **2 strictly increasing
  blocks**. A reappearance resets the count.
- **Outcome labels:** `cleared{how, firstBlock, block, receiptVerified}`, `refused`, `still-held`,
  `clear-unconfirmed`, `quorum-unavailable`.
- **`receiptVerified`** is true only when the host answered `released:true`.

**`cli/enclave.mjs`, patched in a private copy** (`f2307f9d…`):
- **Uses** the function.
- **Labels:** an unverified receipt is stated explicitly, and the three unknown outcomes give accurate messages, exit
  4, and say "Nothing more was sent".
- **Unchanged:** all prior refusals and checks, and the same-operator refusal.

**Tests:** `test/move-release-confirm.test.mjs` (`4f8a3311…`), 14 tests of the **real module**.
- **Fake boundary:** a `ManagementError` `{code, outcomeUnknown}` answer, the ledger snapshots and the clock.
- **Cases:**
  - the deep `release_unconfirmed` case (cleared with `receiptVerified:false`);
  - a late landing within 90 s;
  - a changed generation or runner; a lapsed lease;
  - a reorg, both reset and persistent; lagging reads;
  - a full outage, and an outage then recovery;
  - still held; a definite refusal; a malformed snapshot;
  - **exactly one release in every outcome.**

**Patch:** `move-release-recovery.patch` (`7e5ac3a8…`, 269 lines). It applies onto `git archive 81ba66853` and
reproduces the 3 candidate files exactly (checked).

**Root command, if approved** (clean clone at `81ba66853`, offline):
```
git apply lease-deep-recovery-solution-stage/move-release-recovery.patch
node --test test/move-release-confirm.test.mjs test/management-move-unit.test.mjs
```

## Limits

- **Unsafe head, not finality.** The two increasing blocks reduce the reorg risk only.
- **"Authenticated current state"** is only as strong as the owner's configured chain source (an RPC quorum today, or
  a verifier if configured). This patch does not change that source.
- **A whole-window quorum outage still stops the move** (exit 4, unknown). That is the only safe answer. A later
  re-run is safe: it reads the ledger first and sends no release when the source no longer holds the lease.
- **Not done here:** supervisor labels are not changed; the regenerated `mcp-server.bundle` is not needed (the
  classifier is untouched); same-operator moves stay refused.
- **Not run:** nothing here was executed. Lease consumers stay on HOLD until root runs the tests and reviews. Custody
  v2 stays refused.
