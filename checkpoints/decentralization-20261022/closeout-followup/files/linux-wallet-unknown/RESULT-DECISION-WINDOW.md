# Linux wallet hold: decision-window and teardown-path fixes (RESULT-DECISION-WINDOW, 2026-10-23)

**Status:** a source candidate, committed locally. NOT built into an image, deployed, pushed or merged.
- No SSH, live network, wallet or production action. Only `linux-wallet-unknown/candidate` was changed.
- Read: `work/effective-goal-requirements.txt` (md5 `c66f26fc…`), `ROOT-LINUX-DECISION-WINDOW-REVIEW.txt` and root's probe files.

| item | value |
|---|---|
| commit | **`f1d0666b9fc80d25a7c4cbacf4025f3a33152111`** (tree `2db82e4f…`), parent `b744ba19` → `09ff3ed5` → base `2bbea898`; author and committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| this round's patch | `linux-wallet-unknown-decision-window.patch` = `git diff b744ba19 f1d0666b`, sha256 **`fb373d7eeab9c51bc9a1a42e9cb58695d21520e6e33e92d0d47cae14475ed5f1`** (5 files, +412/−173) |
| full patch | `linux-wallet-unknown-full.patch` = `git diff 2bbea898 f1d0666b`, sha256 `3c30dd3ccc9a2dba0fd2f40b3d1b42bb259050fc38af71ba5f8136c68798f35f` (9 files, +859/−73) |
| `supervisor.js` | 89ebb50a → 2742f535 → 3b9b371b → **`e50da21dac2cbbd79d06dc971558c17a8352bb590811b7366a08f2597579e04d`** |
| `egress.js` | unchanged this round: **`bd960a2b…`** (`closeDeployment`, from b744ba19) |
| tests | `supervisor-wallet-unknown-hold.test.mjs` 6487b2cf; NEW `helpers/supervisor-wallet-fixture.mjs` 1fbda768 (the vm fixture, moved out of the suite and extended); NEW `supervisor-wallet-real-lease-client.test.mjs` 1973ad40; `pool-reconcile.test.mjs` 7b8a8f2e (+1 case). Unchanged: wallet-policy 503265a4, egress 309d4367, tenant-provision-race 2485fbce |

## 1. Root's decision-window gap: verified, then fixed

**Verified through the actual flows** (the new cases run against b744ba19's supervisor as the control):
- **`tryClaim`, operator-paid and app-funded:** with `openForUs` delayed while a separate admission call refuses (or
  answers unknown), b744 **dispatches the claim** (`writes: ['claim']`).
- **The real lease client and relay:** b744's claim reaches the client and relay (`d5-768`).
- **`renewLeases`:** with the ledger read delayed while the audit retires the record, b744 **sends the renewal**. Its gate
  took the record epoch and status after that read.
- **Cause:** `walletSendGate` read the counter and the record epoch/status when the GATE was built, i.e. after the
  awaits, so an old allow was rebased onto the newer state.

**Fix** (`supervisor.js`):
- **The permit belongs to the decision:**
  - `leasePermit(rec)` (the record object, its epoch and its status) is taken by the caller **before its first await**:
    `renewLeases` takes it before the ledger read and re-checks `running` after the lease-gas-lead await; `auditClaims`
    takes it before its decision.
  - `hostWalletDecision` records the per-deployment refused/unknown count **when the decision starts**, before its own
    await.
  - `walletSendGate(decision)` compares against those values and never re-captures.
- **Overlapping decisions:** an allow whose read overlapped a refused/unknown answer for the same deployment (an old
  in-flight read returning after a newer withdrawal) is read again once; a second overlap answers unknown.
- **Fresh-allow recovery is preserved:** a decision that STARTS after the withdrawal is a fresh allow and stands. Tested:
  the re-read claims, and a claim decided after a refusal goes out.
- **Where the gate is asked:** when the operator queue reaches the send (both senders) and, app-funded, again in the
  client's `onSigned` hook (after signing, before any relay).

**What the guards guarantee, bounded exactly:**
- Nothing is signed or relayed if the permission was withdrawn before the queue reached the send. For app-funded, the same
  holds if it was withdrawn before the relay POST; a throw in `onSigned` makes the client send the lease to no relay.
- **After those points nothing can be recalled:**
  - operator-paid: viem's `writeContract` simulates, signs and broadcasts after the gate;
  - app-funded: the relay POST and anything the relay then broadcasts.
- A withdrawal that the supervisor learns of only after the broadcast does not stop it.

## 2. The other teardown paths: consistent withdrawal and confirmed-stop accounting

**`tearDown(rec, status, why)`:**
- Before the stop's await: `withdrawService` (status, open streams cut, `egress.closeDeployment`, permits revoked) and a
  `_stopPending` mark, so no resume, claim or replacement can start while the DELETE is outstanding.
- Then the stop. The slice is freed only on a confirmed stop: DELETE ok AND a fresh listing without the instance
  (`settleStop`).
- Returns whether the stop was confirmed. Each path's LEASE rule is unchanged.

| path | lease rule (unchanged) | now |
|---|---|---|
| reaper: lease over (not renewed) | final proof, no release | `tearDown(expired)` |
| reaper: out of funded time | none | `tearDown(expired)` |
| owner `setActive(false)` (audit) | prove + release if ours | `tearDown(terminated)` |
| lease lost (audit, 2 strikes) | none | `tearDown(expired)` |
| share-resize eviction | prove + release | `tearDown(expired)` |
| `abandonClaims` (unreachable endpoint) | prove + release | `tearDown(expired)` |
| ledger move | none (lease void) | `tearDown(terminated)` |
| publisher yank | prove + release | `tearDown(terminated)` |
| admin consolidation release route | prove + release (holdoff) | `tearDown(expired)` |
| owner DELETE route | prove + release | `tearDown(terminated)`; the response adds `instanceStopConfirmed` (the old comment claimed "the instance is gone") |
| wallet hold / refusal (`walletHoldLocal`, `retireForPlacement`) | keep / release | `tearDown`, as before |
| owner move route | release ONLY on a confirmed DELETE (unchanged) | slice via `settleStop` (listing must agree) |
| envelope-edit relaunch | n/a | an unconfirmed stop now DEFERS the relaunch (the version switch's existing rule) instead of provisioning over a possibly live instance |
| version switch in place | n/a | unchanged: it already defers on an unconfirmed DELETE; its synchronous slice swap follows a DELETE-confirmed stop |

**Not converted, with reasons:**
- unpaid-reservation expiry and cancel: no instance ever ran;
- provision failure: the spawn failed;
- app-death give-up and relaunch, and preemption: the manager reports the instance not running or preempted;
- shutdown: the node CVM dies with its guests.

**A further real gap found in b744ba19 itself, and fixed:** `reconcilePools` (every 60 s) dropped `_gpu` from EVERY
terminal record. A pending-stop slice therefore went back to the pool within a minute while the guest might still run. A
terminal record with `_stopPending` now keeps its hold, which the restore path already re-reserved. Proven by the vm
restart case (it fails on b744) and by a `POOL_SELFTEST` process case on the real supervisor.

**User-facing honesty:**
- No message, status or field claims physical termination from metadata.
- `status` stays the local service state; `instanceStopConfirmed`/`walletHeld.stopConfirmed` say only that guestd's DELETE
  succeeded and its listing no longer names the guest.
- `error` texts for unconfirmed stops say "NOT confirmed stopped".

## 3. Tests (queue; offline: deny stubs, `unshare -rn --pid --fork --kill-child`, `--test-timeout`, `timeout -k`)

| run | cap | result |
|---|---|---|
| `d1-512` candidate | 512 | 35/38. All 3 failures were test-side and fixed: the refusal path now frees the slice on confirmation before releasing (order); an outdated assertion that the owner stop still read `running` during its DELETE (it now withdraws first, which is stricter); the fixture lacked `process` for `loadState` |
| `d1-512` **CONTROL** new pool case on the base tree | 512 | fails (the reconciler reclaims the pending slice); the 8 existing cases pass |
| **`d2-512` candidate (final e50da21d)** | 512 | **38/38**: the main suite 26 + wallet-policy 4 + pool-reconcile 8 |
| `d2-512` **CONTROL: the main suite on b744ba19** | 512 | **9 FAIL**, all behavioural: 4 decision-window cases (claim/renewal SENT), teardown paths, restart/accounting (the reconciler reclaims), the source pin; plus the two old-order assertions |
| **`d3-768` real lease client (final)** | 768 | **4/4**, peak 692 MiB (anvil + the lease-gas forge build) |
| `d5-768` **CONTROL: the real-client suite on b744ba19** | 768 | the decision-window case **FAILS** (the claim reached the real client and relay). The other 3 pass: the post-sign hook already existed in b744 |
| `d4-512` **5 mutants** of this round | 512 | **5/5 killed** by behaviour |
| `d6-768` regression, 18 suites (final) | 768 | **132/135**, peak 301 MiB: 1 failure = the pre-existing tenant-provision-race `releaseHold` harness case (it fails identically on base 2bbea898); 2 skipped, as in the earlier run |
| `d7-scan-256` | 256 | crypto-key scan 0; gitleaks 3 commits (2bbea898..f1d0666b), no leaks |

**Mutants (`d4-512`):**

| mutant | removes | killed by |
|---|---|---|
| DM1 | gate re-captures the counter at construction (b744's behaviour) | two decision-window cases |
| DM2 | no overlap re-read | the overlap case |
| DM3 | renewal permit taken after the ledger read | the renewal-permit case |
| DM4 | reconciler reclaims pending slices | the restart case |
| DM5 | no pending mark before the DELETE | the teardown case |

**`d6-768` suites:** approval-gate, claim-sweep, config-edit, custody-supervisor, domain-carryover, instance-reconcile,
instance-sweep, isolation-guest-pool/post-adoption-lease/release-ticket, ledger-move, rate-cap, tenant-lease,
tenant-provision-race, transfer, version-switch, waf, yank-teardown.

**New cases:**
- **Decision window**, via the real `tryClaim` with a slow `openForUs`:
  - a separate refusal (also refusal then re-admitted) means no dispatch, on both senders;
  - a separate unknown means no dispatch.
- **Overlapping decisions:**
  - an old in-flight allow returning after a refusal is re-read and the fresh allow claims;
  - a second overlap returns unknown with nothing claimed;
  - a claim decided after a refusal goes out.
- **Renewal:** a retire during the ledger read is never rebased, even if the record later reads `running` (both senders).
- **Teardown paths on a FAILED stop** (owner stop, lost lease, eviction, abandoned claims, ledger move):
  - withdrawn and pending before the DELETE answers, with egress closed and permits revoked;
  - the slice is kept;
  - each path's own lease rule is applied: release / none / release / release / none;
  - resume is refused;
  - the confirmation frees the slice exactly once.
- **Teardown on a CONFIRMED stop:** the slice is freed at once (owner-stop control).
- **Restart/accounting**, with the real `loadState`, `reconcilePools`, `releaseGpu` and `settlePendingStops`:
  - the pending slice is restored and re-reserved, and a stale handle on a confirmed teardown is dropped;
  - the reconciler reports no drift;
  - still listed means still pending;
  - the empty listing frees the slice exactly once (and is idempotent).
- **Real lease client** (`createLeaseClient` + `startRelayService` on anvil, behind a counting/delaying proxy, `onSigned`
  wired exactly as `leaseGasSender`; source-pinned):
  - control: one POST, claimed on chain, 0 host ETH;
  - a refusal landing while the client reads its relay: 0 POSTs, nothing on chain, reserve unchanged;
  - a decision-window refusal: the client is never asked.

**Not executed:**
- The billing-ticker reaper paths, the admin/owner HTTP routes and the yank sweep are not run in the vm. They are covered
  by the source pins ("no teardown frees a slice after an unchecked stop", the route strings) and by the regression
  suites that drive them (yank-teardown, waf, transfer and others).
- The envelope-edit deferral is source-pinned and covered by config-edit regression, not by a dedicated failed-stop case.

## 4. Activation prerequisites (root)

- **Ship together:** `supervisor.js` e50da21d, `egress.js` bd960a2b, and a host-admission bundle **with `decision()`**:
  3438cdf2 (this tree, 4 DigitalOcean policy mirrors) or 6bef372d (the installed Windows recipe, 0 mirrors).
  - The live `metal-deabf8f90` bundle e83515fc has NO `decision()`, so every wallet-gated tenant would be held.
- Both files are measured-image inputs, so activation means a rebuild and a new measurement.
- **Unchanged contract relied on:** `client/lease-executor-client.mjs` `onSigned` (after signing, before any relay; a throw
  = `NotPersisted`, no relay).
- **Rollback** is the previous image.
  - New persisted record fields are `walletHeld`, `_stopPending` and `_leaseEpoch`. An older supervisor ignores them, and
    its reconciler/restore free a pending slice (the old behaviour).
  - The DELETE response gains one field (`instanceStopConfirmed`).

## 5. Limits (stated plainly)

- No supervisor process on a chain, no guestd, no metal image. The real-client case uses a local anvil chain and relay,
  not production relays or Base.
- **"Confirmed stopped"** is guestd's word (a DELETE plus listing absence), not host-level process proof. Until it is
  confirmed, the guest may still run and hold memory and keys:
  - routes are refused;
  - open streams and supervisor-SOCKS egress are cut;
  - other host network paths of a running guest were not audited.
- **Broadcasts cannot be recalled** (§1).
- **App-death relaunch** still relaunches after a best-effort DELETE: the instance was reported dead.
- **Pre-existing failures** (not claimed as passing):
  - tenant-provision-race `releaseHold` (harness);
  - earlier rounds: catalog-platform-enforcement slice, registry-reconcile heartbeat pin, owner-nomination chmod under a
    mapped root.
- **Availability:**
  - an unknown wallet episode stops service;
  - a failed stop blocks resume, re-claim and new placement on that slice until the backend confirms the guest gone;
  - an owner's config change waits for a confirmed stop.

**Files** (all under `linux-wallet-unknown/`):
- `linux-wallet-unknown-decision-window.patch`, `linux-wallet-unknown-full.patch`, `linux-wallet-unknown-review.patch`
  (previous round);
- `jobd1.sh`–`jobd6.sh`;
- `tmp/dmut/` (the 5 mutants), `tmp/sup-b744.js` (control);
- `logs/d1-512`, `d2-512`, `d3-768`, `d4-512`, `d5-768`, `d6-768`, `d7-scan-256`.
