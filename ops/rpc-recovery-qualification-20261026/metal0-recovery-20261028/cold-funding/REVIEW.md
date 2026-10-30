# Metal0 cold-shutdown C9 funding guard: source-only variant

Scope: this copied package only. Nothing was signed, sent, or run, and no keys were read. No tests were run.

## Changes
- `lib/maintenance.mjs`
  - Adds `COLD`, a profile frozen in code. It contains the marker `metal0-cold-shutdown-c9-funding/v1`, `PROTECTED_IDS`, owner `0x0b2d…eE61`, runner `0x4dde…68be`, `minExpiredSec` 360 and `minStoppedSec` 360, the exact `quiesce.cold` field list, and the root-gate text. Also adds `coldProfileSha256`, `coldPlanProfile`, `PLAN_KIND`/`COLD_PLAN_KIND` and `checkProfile` (accepts only `live` or `cold`).
  - `checkQuiesce` is split into `checkQuiesceBase` (unchanged checks: provided by root, signers listed, age, deadline+60, lease ids, expiry equal to the chain's `leaseUntil`) and the live lease-window part. The live path behaves exactly as before.
  - Adds `checkColdQuiesce`, which refuses unless all of these hold:
    - the operator is C9 and the inventory is exactly the two protected ids (via `requireProtectedInventory`; refuses on a missing, partial, duplicate or extra id);
    - the base checks pass;
    - `quiesce.cold` has exactly the keys `{profile, preservationReceiptSha256, stoppedAtSec, noGuestUnits, noGuestRecords}`, with the exact marker, a 0x-prefixed 32-byte sha, and both no-guest flags `=== true`;
    - `stoppedAtSec <= providedAt` and `stoppedAtSec + 360 <= blockTimestamp`;
    - each lease is `active === true`, has runnerOperator C9 and the exact owner and runner, and has `leaseUntil <= blockTimestamp - 360`.
  - `minLeaseRemainingSec` is not lowered, and leases are not omitted.
  - `buildPlan({profile})`: a cold plan gets kind `…/executable-cold`, `plan.profile = {mode, marker, sha256}`, and `quiesce.mode = "cold"` plus `quiesce.cold`. Live plan bytes are unchanged.
  - `createPreparer({profile})`: cold together with `fixture` throws. For cold, the production-pin comparison always applies, and the inventory is checked before any RPC. The chain fetch now also records `owner` and `runner` for each lease.
- `lib/sender.mjs`
  - `checkExecutablePlan(cfg, plan, profile)` checks four things:
    - the plan kind matches the profile;
    - a cold plan's `plan.profile` deep-equals `coldPlanProfile()`, and a live plan has no `profile`;
    - a cold plan has `quiesce.mode` set to cold and the cold marker;
    - a live plan has no `quiesce.mode`.
  - `checkApproval(..., profile)`: a cold approval needs kind `…/approval-cold`, `profile === COLD.marker` and `coldProfileSha256`. A live approval must have neither field.
  - `createSender({profile})`: cold together with `fixture` throws. `run` and `resume` pass `profile` through, and `preflight` calls `createPreparer({…, profile})`, so the cold facts are checked again at a fresh block before every signing.
  - Unchanged: amount, fee cap, gas, code/storage/nonce checks, the two-provider pins, the journal of the durable presigned pair, and the recovery logic.
  - An original-package sender also refuses cold plans and cold approvals, because their kind strings differ.
- `test/cold.test.mjs` (new). Covers:
  - the exact expired-and-owned pair passing, including the boundaries at exactly 360 s;
  - inventory refusals (missing, partial, duplicate, foreign, extra, undefined);
  - live, recently expired, inactive and foreign holder/owner/runner leases, missing owner/runner, and a stale expiry;
  - missing, false, malformed or extra cold fields, and a stop window that is too short;
  - the unchanged quiesce, deadline and sponsor-balance refusals;
  - live↔cold plan and approval cross-refusal, and a tampered or missing profile;
  - cold with `fixture` refused, and the inventory refusal happening before any RPC.
- Existing tests are not edited: the default profile is `live`, which behaves as before.

## Not run / not done
- No tests were run (the root will run bounded tests). No CLI wiring.
- The 7e12 wei top-up of the sponsor `0x29479…647c` is an operator action and involves no code. The cold plan still requires the sponsor balance to be at least V (5e12) plus the bounded fees (cap 2e12).

## Risks / review points
- The root must verify the actual systemd stop and guest absence immediately before key access. `quiesce.cold` is only an assertion made by root.
- `stoppedAtSec <= providedAt` is an added strictness I chose; check that it matches how root writes the timestamps.
- `checkColdQuiesce` takes owner and runner from `facts.leases`. A preparer from the original package does not fetch them, so it would fail closed (`lease_owner`).
- Cold mode cannot run on anvil or a fixture, so this code has no end-to-end sender test for cold. Cold coverage is pure and unit-level only.
- `maintenance.mjs` now imports `protected-inventory.mjs`.
