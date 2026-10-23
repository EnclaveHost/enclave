# Windows node: serving-first pass ordering (INITIAL, 2026-10-22)

**Scope:** source only, in a NEW isolated candidate derived from the final renewal keeper
`adapter-admission-review/candidate` `2afa6733`.
- The frozen 2afa candidate, helper 7ac1d873 (node-activate-min), the node-pair runner and the source checkpoint are not
  edited.
- No production action, SSH, contract, budget-gate change or broad build.
- Root owns activation.

## Problem (in source, 2afa `windows/node/host.mjs` `#tickOnce`)

Each pass runs, in this order:
1. the release journal, `followBook`, `enforceOff`, `refreshOwners`, registration, `ensurePriced`;
2. **`scanLedger()`**, the queued-claim sweep (`consider()`: resolve the app ref, wallet policy, the claim gate, a claim
   send, a launch);
3. `retireForeignRecovered()`;
4. **only then** the per-tracked loop. It is what reconciles every EXISTING served or recovered deployment: a fresh
   ledger row, the host-wallet decision, admin/platform holds, renew-when-due, the envelope edit and resize, `ensureApp`
   (adoption), and finally keeper eligibility (`#leaseSeen`) and the readiness row (`#leaseChecks` → `ready`).

So on a fresh process (or any pass), a slow claim sweep delays readiness and keeper eligibility for every
already-running app by the whole sweep. The loop's own re-claim branch (`!ours` → `consider()`) can also delay the apps
after it in the same loop.

Helper 7ac1's apply budget must therefore cover a whole first pass (the measured 602 s) before any existing app reads
`ready`: 1550 s of all-leases-left, which staggered leases rarely give.

## Smallest correct change (planned)

- Split the per-tracked loop body into one method, unchanged in content. Call it twice:
  - **phase 1, the existing tracked set, BEFORE `scanLedger`:** every gate as today (fresh row, wallet refusal/unknown,
    holds, placement, renew-when-due through the same `#renewTurn`/permit, edit/resize/adoption, keeper eligibility,
    readiness). Only the re-claim of a tracked deployment this box no longer holds (`!ours` → `consider()`) is DEFERRED,
    and its wallet grant is still revoked at once.
  - **then `scanLedger()` and `retireForeignRecovered()`, unchanged;**
  - **phase 2, the same body, for the ids the sweep added** (a resumed lease, a new claim) **plus the deferred
    re-claims,** each re-read fresh from the ledger.
- Unchanged: the tick single-flight, one renewal per deployment, the renewal permit/epoch and release-journal fences,
  never renewing an unserved app, every authorization check, and the order and content of everything else.

## Regression (planned, on the existing fixtures: the keeper test's real Host + chain.mjs + scripted sender)

- **A slow queued-claim sweep** (a gated `scanLedger`) **cannot delay an existing served app:**
  - its readiness row is `ready` while the sweep is still blocked;
  - the keeper renews it when due;
  - the pass's deferred re-claim runs only after the sweep;
  - a lease the sweep resumes is reconciled in the same pass.
- **Still blocking during a slow sweep:** a wallet-policy refusal, an unknown policy, a transfer to an owner this box
  does not serve, a platform suspension. None of them reads `ready` and none is renewed.
- 2afa itself must fail the first case (base run), and the existing keeper, readiness and lease suites must still pass.
