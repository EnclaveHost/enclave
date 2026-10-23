# Serving-first fixes F1 + F3 (INITIAL, 2026-10-22)

**Scope:**
- Source only, in a NEW isolated copy `serving-first-fixes/candidate` of `windows-serving-first/candidate` at `829a881c`
  (host `817389ec`, chain `3e9fae03`).
- Frozen 829/2afa, the source checkpoint, the helpers and every live system are untouched.
- No SSH or network. Root owns activation.

## F1: a same-pass re-claim must be reconciled in phase 2

**Defect:**
- Phase 2 selects `!first.includes(id) || deferred.has(id)`.
- An id retired in phase 1 (an expired own lease → `#stopApp` → untracked) and re-claimed by `scanLedger` in the same pass is
  in `first`, so phase 2 skips it.
- Its readiness row stays `pending`, and keeper eligibility waits a whole pass.

**Fix: a tracking MEMBERSHIP EPOCH, not list membership.**
- `this.tracked` becomes a `Set` subclass that moves a per-id epoch whenever an id enters (add of an absent id) or leaves
  (delete of a present one) tracking. The constructor fills it after construction, so private fields exist first.
- `#tickOnce` snapshots each tracked id's epoch right AFTER phase 1. Phase 2 reconciles every id tracked now whose epoch
  differs from that snapshot, plus the deferred re-claims. That covers:
  - (re)entered after phase 1: new claims and resumes from the sweep;
  - same-pass re-claims after a phase-1 retire;
  - anything removed and re-added during the sweep.
- Ids phase 1 handled and that stayed tracked (holds, unconfirmed retires) are not re-run, exactly as before.
- The deferral is a module `Symbol`, not a string.

## F3: one tracked deployment's failure must not block the others or the sweep

**Defect:** an uncaught throw in phase 1 (for example from `ensureApp`, `#stopApp`/`#retireIsolated` or manager calls)
aborts `#tickOnce` before `scanLedger`.

**Fix: each `#reconcileTracked` call (both phases) runs under a per-id guard.** On a throw it is conservative for THAT id
only:
- keeper eligibility is cleared (`#leaseSeen.delete`);
- every renewal permit taken for it is voided (`#renewVoid`);
- its readiness row is set to `not-ready` for this pass's sequence, with the error class;
- one log line;
- other deployments and the sweep continue, and it is retried next pass.

**Wallet grants are NOT revoked by the guard, and here is why:**
- Every path that can throw before this pass's fresh decision either revokes or holds first (`#stopApp`, `#giveUpOnce`,
  `#walletHold`), or catches internally (`#walletPolicyState`, the row read, edit/resize, renewal).
- A grant that exists was published from a fresh decision on a fresh row, is bounded to 90 s or less, and is only ever
  refreshed by the refresher's own fresh-row and fresh-decision checks.
- Revoking it on an unrelated adoption error would cut a legitimately admitted app off the network.

**Admin, wallet, placement, release-journal and renewal fences are unchanged.**

## F2 (document only)

After a MANAGER or host restart, phase-1 fresh spawns can meet the manager's 503 while foreign recovered VMs remain. That is
a transient hold, one pass late, with no release. `retireForeignRecovered` must stay after the sweep (which re-tracks live
leases). A node-only restart is unaffected.

## Tests (planned)

New cases in `test/windows-node-lease-renewal-keeper.test.mjs`, on the real Host plus chain.mjs harness:
- **F1:** an expired own lease is retired in phase 1, re-claimed by the sweep, and reconciled in phase 2 of the same pass:
  readiness `ready`, then keeper-eligible.
- **F3:** `ensureApp` throws for app A. App B still reads `ready`, the sweep runs, A reads `not-ready`, and A is never
  renewed by the keeper.

Run offline through the queue (512, bounded runner). The 829 base must fail both cases, and the candidate must pass them
plus the existing keeper suite.
