# Linux wallet hold: root review fixes (RESULT-REVIEW, 2026-10-23)

**Status:** a source candidate, committed locally. NOT built into an image, deployed, pushed or merged.
- No SSH, live network, wallet or production action.
- Worked only in `linux-wallet-unknown/candidate`. Read: `work/effective-goal-requirements.txt` (md5 `c66f26fc…`) and
  `ROOT-LINUX-HOLD-REVIEW.txt`.

| item | value |
|---|---|
| review commit | **`b744ba19022763e9688c6b006e8cecd24e21cc18`** (tree `2a6ff7c7…`), parent `09ff3ed5` (terminal), base `2bbea898`; author and committer SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com> |
| review patch | `linux-wallet-unknown-review.patch` = `git diff 09ff3ed5 b744ba19`, sha256 **`300c02076aa161e1364ec433d5d4023d0e2c20dd53858806006a6d5fbccbed1b`** (6 files, +298/−40) |
| full patch | `linux-wallet-unknown-full.patch` = `git diff 2bbea898 b744ba19`, sha256 `f92b1b286616472204c2da49ebbb3126562cac883c3f964fe39e32f1cc3c3454` (6 files, +579/−32) |
| `supervisor.js` | 89ebb50a (base) → 2742f535 (09ff) → **`3b9b371b7c1f84aaeb98ea4b7fc3920c75b5c28a2228f89009e82cebd0406983`** |
| `egress.js` | → **`bd960a2b6ff51e8269dd3979e7d6e1c842796d351fe0e82257e7c84f8f897843`** (adds `closeDeployment`) |
| tests | `supervisor-wallet-unknown-hold.test.mjs` c2d9d5d8; `egress.test.mjs` 309d4367 (+1 case, harness exposes `egress`); `supervisor-wallet-policy.test.mjs` 503265a4 (one stub); `tenant-provision-race.test.mjs` 2485fbce (its harness also extracts the real `revokeLeasePermits`) |

## 1. Both concerns, verified in the 09ff3ed5 source flow

**Concern 1 is REAL.**
- `walletSendGate` (09ff) tested only `rec.walletHeld` and the deadline.
- **Refusal:** `auditClaims` → `retireForPlacement` never sets `walletHeld`. Its `proveAndRelease` enqueues behind the
  renewal already in `_txChain`, so the queued renewal is sent first: reserve gas spent on a banned deployment.
- **Hold → allow:** `walletHeldReview` deletes `walletHeld`, so an older permit on the same record object passes again.
- **Owner stop, lease lost, version switch:** status changes only AFTER `await stopContainer`, so a renewal reaching the
  queue during the DELETE passes.
- **App-funded:** the only check sat at job start. The client then awaits relay discovery and admission before signing
  and relaying.
- **Claims:** no record exists to revoke.
- The 09ff control run shows every one of these (§3).

**Concern 2 is REAL.**
- `walletHoldLocal` (09ff) released the GPU slice unconditionally.
- `stopContainer` returns false on an unconfirmed DELETE (`stopUnconfirmed`), and the slice then went back to
  `cpuPool`/cards while the guest might still run.
- **What was already true:**
  - every new connection is gated on `status === "running"`: `/x/:id` HTTP per request, the `/x/:id/https` bridge into
    `isolationHttps`, the tcp/udp bridges, and egress SOCKS `isKnown`;
  - the record leaving `running` therefore refuses new traffic.
- **What was NOT true:**
  - already-established upgrade streams (isolation splices piped to guestd's data plane, the bridges) and open egress
    tunnels were not cut. A splice ends only when the guest dies (`pipeBoth`), so with a failed stop they kept flowing;
  - nothing blocked a resume or re-claim of the id onto the freed slice.

## 2. Fix

**Lease permissions (concern 1):**
- `revokeLeasePermits(rec)` moves a per-record lease epoch synchronously. It runs:
  - as the **first line of `stopContainer`**, which every teardown, relaunch and replacement path calls before any await;
  - at the top of `provisionTenant` (any new serving life);
  - in `withdrawService` (hold, retire, held release).
- `walletSendGate(rec, validUntil, id)` binds:
  - the record **object** (a replaced record never inherits);
  - its epoch;
  - its status at the decision;
  - a per-deployment count of later refused/unknown wallet answers from any caller, which voids a queued **claim** too;
  - the decision deadline.
- **Where it is asked:**
  - when the operator queue reaches the job (both senders);
  - again, for app-funded, in the client's existing `onSigned` seam (client/lease-executor-client.mjs: after the lease
    is signed, before any relay; a throw = `NotPersisted`, "sent to no relay"). It reports `superseded`, with no 60-s
    failure backoff.

**Physical isolation (concern 2):**
- **`withdrawService`**, before any await:
  - status leaves `running`;
  - the deployment's established upgrade streams are destroyed (new `_depStreams` registry, filled in the upgrade
    handler for every `/x/<id>` stream);
  - its egress tunnels are closed (`egress.closeDeployment`);
  - its permits are revoked.
- **`settleStop`:** the slice is freed ONLY when `stopContainer` succeeded **and** a fresh `listBackendInstances()` names
  no instance of the record (its vm id, or its deployment name). Otherwise:
  - the slice stays on the record with `_stopPending` (persisted);
  - restore keeps it reserved;
  - `considerClaim` and `tryClaim` refuse any resume, claim or replacement of that id.
- **`settlePendingStops(instances)`:** called by `reconcileInstances` from its own listing, before reaping. It frees a
  pending slice only when the backend no longer lists the instance; an unreadable listing confirms nothing.
- **A held record:** clears only after a confirmed stop and an allow. Every pass retries the stop meanwhile.
- **`retireForPlacement`** (administrator/owner refusal, pin): withdraw first, stop, then **release as before** (the ban is
  enforced even when the stop fails), with the slice freed only on confirmation.
- **UNKNOWN:** still never releases, renews or re-claims, and the lease is kept.

**Path audit (final 3b9b371b):**

| path | permits | streams/egress | slice on failed stop |
|---|---|---|---|
| unknown hold (`walletHoldLocal`) | revoked | cut (withdrawService) | **kept until confirmed** |
| administrator/owner refusal, pin (`retireForPlacement`) | revoked | cut | **kept until confirmed** |
| held → refused/owner stop/pin (`walletHeldReview` end) | revoked | cut | (already settled at hold) |
| owner `setActive(false)`, lease lost, version-switch evict, envelope restart, ledger move, yank, abandonClaims, owner DELETE/release routes, billing-ticker stops (stopContainer callers at :7964, 7987, 8067, 8143, 8217, 9728, 10747, 10818, 10920, 10963, 11013, 11078, 11123) | revoked (stopContainer line 1) | streams cut (stopContainer); egress not closed | **unchanged: freed as before** |
| restart / relaunch / resume (`provisionTenant`) | revoked | (stopContainer first) | n/a |
| app death give-up (status `failed`, synchronous) | the gate's status check | instance already dead | unchanged |
| record replaced (`adopt`) | identity check | | |

## 3. Tests (queue; offline: deny stubs, `unshare -rn --pid --fork --kill-child`, `--test-timeout`, `timeout -k`)

**How the suite works:**
- It runs the REAL supervisor bodies: `renewLeases`, `auditClaims`, `tryClaim`, `switchTenantVersion`,
  `retireForPlacement`, `sendLeaseTx`/`sendOperatorTx`, `stopContainer`/`stopUnconfirmed`, `listBackendInstances`, the
  stream registry, `provisionTenant`, `unresumedOwnLeases`, and the new hold/settle functions.
- Behind them is the REAL shipped admission bundle (3438cdf2), with a scripted guestd `/vms` (DELETE ok/fail/hang;
  listing shows/omits the guest) and real TCP sockets for streams.
- The app-funded sender is a stub at the client's documented seam (relays, sign, `onSigned`, relay POST).

| run | cap | result |
|---|---|---|
| `r1-512` candidate | 512 | found two of MY bugs, both fixed: an `egress.js` TDZ (my helper `name` vs a later `const name`: REP 4 on every CONNECT), and a missing stub in the wallet-policy fixture |
| `r1-512` **CONTROL: new suite on 09ff3ed5** | 512 | **9 earlier cases pass; all 7 review cases + the source pin FAIL**, on behaviour: renew sent after the yank; resurrected permit; owner-stop/restart/replace sent; relay POST after the hold; claim after a refusal; failed stop frees the slice and allows resume; stream not cut |
| `r1-512` **CONTROL: egress case on base egress.js** | 512 | only the new `closeDeployment` case fails; the 6 existing cases pass (11 phase-2 skips) |
| `r1b-512` candidate (db73a7f2) | 512 | 28/28 (new suite 17, wallet-policy 4, egress 7; 11 egress phase-2 skips, pre-existing: they need a patched wasmtime) |
| `r2-768` regression (db73a7f2), 23 suites | 768 | **164/169**, peak 299 MiB; details below |
| `r3-512` candidate FINAL 3b9b371b | 512 | **24/25**: the new suite 18/18 (adds "renewal reaching the queue mid-stop") + wallet-policy 4/4 + tenant-provision-race 2/3 (the pre-existing `releaseHold` case) |
| `r3-512` **8 review mutants** | 512 | **8/8 killed**, each by behaviour |
| `r4-scan-256` | 256 | crypto-key scan 0; gitleaks 2 commits, no leaks |

**`r2-768` suites:** approval-gate, claim-open-for-us, claim-sweep, custody-supervisor, egress-probes, host-egress,
instance-reconcile, instance-sweep, isolation-claim/encvol/guest-pool/modelvol/post-adoption-lease/release-ticket/
resume-shield-model, launch-spec, ledger-move, rate-cap, secrets-release-status-lookup, startup-egress-map,
tenant-lease, tenant-provision-race, waf.

**`r2-768` failures:**
- 2 were in tenant-provision-race's harness, which lacked the new `revokeLeasePermits`. Fixed by extracting the real
  function (reformatted to the multi-line form its extractor needs; whitespace only, hence 3b9b371b).
- 1 is the pre-existing `releaseHold` case (identical on base 2bbea898, l3).
- That accounts for 3 of the 5 non-passing cases; the other 2 were skips (r2 showed `skipped 2`).

**What the 8 mutants remove, and which case kills each:**

| mutant | removes | killed by |
|---|---|---|
| RM1 | epoch check | owner-stop/restart/replace; mid-stop |
| RM2 | revoke in `stopContainer` | mid-stop |
| RM3 | free on failed stop | failed-stop; refusal + failed stop; repeated unknown |
| RM4 | trust DELETE without the listing | failed-stop |
| RM5 | no stream cut | failed-stop (real socket) |
| RM6 | no post-sign check | app-funded hold mid-relay |
| RM7 | no stop-pending claim guard | both failed-stop cases |
| RM8 | no verdict epoch | claim voided by a later refusal |

**The new review cases** (all also passing on the final bytes):
- **A verified refusal** (administrator yank) voids a queued renewal: operator-paid and app-funded, 0 sends, the ban
  released.
- **Hold → fresh allow → the same record object `running` again:** the old permit is still void; a renewal decided
  afterwards does go out.
- **Owner stop, restart (`provisionTenant`), replaced record:** each voids a queued renewal.
- **A renewal reaching the queue WHILE the owner-stop DELETE is pending** is not sent (both senders).
- **App-funded:** a hold landing while the client admits relays stops the signed lease before any relay POST (no
  backoff).
- **A claim decided allowed** is voided by a later refusal for that id from another caller.
- **Failed stop:**
  - status leaves running before the DELETE answers;
  - a real established stream is closed;
  - egress closed and permits revoked;
  - the slice is kept and `_stopPending` set;
  - resume refused, and still held after an allow;
  - not vouched for;
  - DELETE 200 with the guest still listed does not count as confirmed;
  - the reconciler's empty listing frees the slice exactly once;
  - then the hold clears and the resume adopts;
  - 0 releases throughout.
- **Administrator refusal with a failed stop:** the lease is still released (ban enforced); the slice waits; a re-claim
  of the id is refused even after the version is admitted again; an unreadable listing confirms nothing.
- **Source pins** for the wiring the vm cannot execute:
  - `stopContainer` first line;
  - `provisionTenant` revoke;
  - restore keeps a pending slice;
  - the `considerClaim` guard;
  - upgrade stream tracking;
  - `settlePendingStops` from the reconcile listing before `orphanInstancePlan`.

## 4. Dependency closure and the exact bundle/image pair

The image must ship, together:
1. `supervisor.js` 3b9b371b;
2. `egress.js` bd960a2b (it imports `closeDeployment`);
3. `windows/node/host-admission.bundle.mjs` **with `decision()`**: this tree's 3438cdf2 (4 DigitalOcean policy mirrors),
   or the installed Windows-recipe 6bef372d (0 mirrors). Root picks the recipe.

Unchanged and relied on (contracts, not changed): `client/lease-executor-client.mjs` (the `onSigned` order) and
`isolation/m4/guestd/supervisor-splice.mjs`.

**The live `metal-deabf8f90` lineage carries bundle e83515fc WITHOUT `decision()`.** With that bundle, every wallet-gated
tenant is held (fail-closed, but an outage).

Both `supervisor.js` and `egress.js` are measured-image inputs, so activation means a rebuild and a new measurement
(root's).

**Rollback** is the previous image. State written by this build adds the record fields `walletHeld`, `_stopPending` and
`_leaseEpoch`. An older supervisor ignores them:
- held records stay terminal: they are not released or renewed, and its own gate decides any resume;
- a pending slice is dropped from accounting at restore (the old behaviour).

## 5. Limits (stated plainly)

- **No process-level run:** no supervisor process on a chain, no guestd, no metal image.
  - The app-funded sender is a stub at the client's documented seam, not the real `createLeaseClient` with relays.
  - The upgrade-handler registration and the restore rule are source-pinned, not executed.
  - A supervisor restart while a stop is pending is not run.
- **What "stopped" means here:** the manager's word, a DELETE 200 plus its listing no longer naming the guest. There is
  no host-level process proof.
  - Isolated guest egress is covered as far as it goes through the supervisor's SOCKS (`ENCLAVE_EGRESS`). Any other
    host network path for a running guest was not audited.
  - New connections are refused at once and established streams cut, but an unconfirmed guest still RUNS (holding its
    memory and keys) until guestd's DELETE, the reaper or guestd's dead-man lease ends it.
- **Residual send windows, both after the last check:**
  - operator-paid: viem's `writeContract` (simulate, sign, broadcast);
  - app-funded: none after `onSigned` except the relay POST itself.
  - A transaction already broadcast cannot be recalled.
- **The other teardown paths in §2's table:** they now revoke permits and cut streams, but still free their slice on an
  unconfirmed stop and do not close egress. This is the pre-existing pattern, deliberately unchanged here; the same
  `withdrawService`/`settleStop` steps are the recommended follow-up.
- **Pre-existing failures kept:**
  - tenant-provision-race `releaseHold` (harness);
  - from the earlier rounds: catalog-platform-enforcement slice, registry-reconcile heartbeat pin, owner-nomination
    chmod (mapped root).
- Not re-run this round (unchanged code): owner-nomination/anvil and `sendOperatorTx`'s operator path beyond the vm suite.
- **Availability trade-off unchanged:** an unknown episode stops service, and a failed stop now also blocks resume of that
  id until the backend confirms the guest gone.

Files (all under `linux-wallet-unknown/`):
- `linux-wallet-unknown-review.patch`, `linux-wallet-unknown-full.patch`;
- `job5.sh`–`job9.sh`;
- `tmp/rmut/` (the 8 mutants), `tmp/sup-09ff.js` (control);
- `logs/r1-512`, `r1b-512`, `r2-768`, `r3-512`, `r4-scan-256`.
