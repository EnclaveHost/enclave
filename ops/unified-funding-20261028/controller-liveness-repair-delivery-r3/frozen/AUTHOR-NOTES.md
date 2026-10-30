# Author notes — r3 focused repair: 409 ownership and stale continuations (source only, nothing run)

Nothing was executed: no tests, node, builds or shell; only Read/Grep/Glob/Edit/Write. **No test outcome is known.** The seed is the failed r2 author delivery and it is not qualified. Root's three focused diagnostics passing doesn't change that, and neither does this repair. The root collector computes hashes and the diff.

## Changed files
- `supervisor.js` (modified)
- `test/isolation-stale-continuation.test.mjs` (new)
- `test/isolation-instance-liveness.test.mjs` (comment only, no assertion changed)
- `AUTHOR-NOTES.md`

No helper module was added.

The r2 contract is unchanged: `classifyInstanceView`/`observeInstance` still return running, starting, dead or unknown, and unknown still freezes rather than counting as dead or serving.

## 1. Teardown authority (P1 unverified ownership)
- `instanceUnknownError(…).vmId` is now **diagnostic only**. `deferProvision` keeps it in `_provisionDeferred.vmId` and never writes it to `_vmId`.
- `_vmId` on a deferred record comes only from:
  - an identity the record already established (a guest it launched or adopted), or
  - `rec._heldVmId`, if `_vmId` is empty.
- `adopt` (resume, isolation, **CPU and GPU**) now keeps the entry from the authenticated `isolationHeldGuest(d.id)` list, when its name matches exactly, its state is live and its id is well formed, as `_heldVmId`.
  - This is the same name-scoped authority that the 409 replacement path in `spawnContainer` already uses to DELETE an authenticated same-name guest.
  - Reservation credit is unchanged: it is GPU only, still needs `isolationHeldSameRecord`, and goes through the same `vmHealth` read.
  - The CPU slice now also performs the `GET /vms` read. That is one extra authenticated read on resume, with no credit attached.
- Success or failure clears `_heldVmId`. Deferral keeps it.
- With no authoritative id, `stopContainer` returns at `!rec._vmId` and ends nothing by id. The owner-stop, lease-loss, abandon, ledger-move and reaper branches still move the record to its terminal state and release (or not) exactly as before.
- Any guest still running under the name is left to the instance reconciler's own rules: current record, vouch, orphan age.
- A later verified same guest (409, then a matching GET) adopts in place through the existing spawn path.

## 2. Attempt fence (P1 stale completion)
How the fence works:
- `beginLaunchAttempt(rec)` stores a token `{status, intent}` per record object in a WeakMap, so it is never persisted.
- `launchAttemptCurrent(rec, a)` requires all of:
  - the token is still the latest;
  - `deployments.get(rec.id) === rec`;
  - the status is unchanged since entry;
  - `_releaseIntents.get(id)` is the same as at entry.

Because the fence captures each caller's own entry state, it also covers the off-chain `forceProvision`/`onPaid` paths.

Checkpoints in `performTenantProvision` and `respawnTenant`:
1. after `launchSpec`, before any spawn;
2. inside `spawnContainer`, via `stillOwned`: before the first POST, after the 409 GET before the replacement DELETE, and before the re-POST;
3. after the spawn resolves or rejects.

Outcomes:
| Outcome | Meaning | Record/handle effects |
|---|---|---|
| `true` | served | unchanged from before (publishes running) |
| `false` + `provisionDeferred(rec)` | deferred (on-chain, current, instanceUnknown) | stays claimed, keeps the slice and lease; `_vmId` only from a verified identity |
| `false` | failed (current) | failed, error, `releaseGpu`; the caller notes it and releases |
| `PROVISION_SUPERSEDED` (`null`) | the record now belongs to a teardown, a replacement or a newer attempt | **nothing**: no status, error, deferral, `_vmId`, port, slice, note or release |

A late guest returned by a superseded attempt is **not DELETEd by id**. That id could by now belong to a newer attempt through 409 adoption. Instead, `reconcileInstancesSoon()` hands it to the reconciler.

**Unresolved ambiguity:** a late guest under the name of a record that stays nonterminal-but-replaced (the synthetic same-status replacement) is kept by the reconciler. That replacement's own launch will meet it via 409 and adopt or replace it under the normal rules. The ticket pump that `spawnContainer` started for that guest is not cancelled.

### Call-site map
| Consumer | Handling of the result |
|---|---|
| adopt | `SUPERSEDED` → log only (no note, no `releaseLease`, which could hit a newer life's lease); `true`/deferred/false as before |
| audit claimed branch, death relaunch | note and `proveAndRelease` only on `=== false && !deferred` |
| `switchTenantVersion`, `applyEnvelopeEdit` | same |
| restart route | `SUPERSEDED` → 409 `restart_superseded`; otherwise as before |
| forceProvision, onPaid | `null` is falsy, so unchanged; it never sets `remainingMs` and never reports provisioned |
| abandonClaims, ledgerMoveSweep, yank, audit stop/lease loss, shutdown | **unchanged**. They stay authoritative, and the fence is what keeps a delayed completion from resurrecting their work |

## 3. Billing and respawn (P1 billing)
- The billing loop:
  - skips records with `tenantProvisions` or `_restarting`;
  - records `intentAt`;
  - after every await (observe, respawn, `proveFinalPeriod`), requires `billingCurrent(rec, vmAt, intentAt)`: the same object in the map, running, the same `_vmId`, the same intent, and no provision or restart. Otherwise there is no respawn, charge, reaper stop or slice release.
  - The confirmed-dead respawn and the unknown freeze are otherwise unchanged.
- `respawnTenant`:
  - refuses to start while a provision or restart owns the record;
  - takes an attempt token, so a provision that starts later supersedes it;
  - when superseded, writes nothing (no backoff, `_vmId`, port or `_preemptedAt`).
- The audit's running-branch post-observation fence also skips `_respawning`, so a death relaunch is not started beside a billing respawn.
- The owner-stop and lease-loss branches are not delayed by a respawn. Their terminal flip supersedes it.

## Test seam (inert outside DIRECT_CLAIM_SELFTEST.lifecycle)
New opt-in keys:
- `conflictIds`: the 409 names the given guest.
- `gates [{at: launchSpec|spawn, nth, act, how}]`.
- a `{how: "gated", act}` vmFault for the billing GET.

The `act` values call the **real** `abandonClaims` and `ledgerMoveSweep`. Two acts are faithful substitutes, not production paths:
- the ledger move retires `rec._ledger`, because the address-book binding can't be rebound from the seam;
- `releaseIntent` uses the `releaseHeld` intent shape.

Recorders only observe and then call through: `stopContainer`, `releaseGpu`, and the outcomes of `provisionTenant`/`respawnTenant`. The output adds `posted`, `stops`, `gpuReleases`, `outcomes`, `gates` (before/after views of the exact old and replacement objects) and `intent`.

## Tests written, NOT RUN
`test/isolation-stale-continuation.test.mjs` covers these ROOT-REGRESSIONS cases:
- `unverified_conflict_stop` (owner stop and lease loss)
- `verified_held_conflicting_id` (CPU)
- `pre_spawn_abandon`
- `spawn_success_abandon`
- `spawn_error_abandon` (error, unknown)
- `spawn_ledger_move` (resolve, error)
- `replacement_same_id` (resolve, error)
- `release_intent_during_await`
- `actual_consumer_propagation`: the audit claimed retry and the death relaunch
- `billing_replaced_observation`
- `billing_respawn_invalidated` (abandon before launchSpec, replace during spawn)

These are pointers, not new tests:
- `unknown_reconnect` and `positive_compatibility` remain the existing liveness and post-adoption tests.

**Assertions deliberately corrected:** none. Test 82–97 keeps `vmId === own.id`, which is now justified by the verified held list rather than the 409. Its comment says so, and the unverified split is new.

## Remaining concerns for root
1. **GPU slice not exercised.** The fixture has no GPU cards, so the GPU resume (credit plus identity) is only code-reviewed.
2. **Restart, version switch and envelope edit with a superseded result are code-reviewed only.** The restart route is HTTP, and the switch and edit need more catalog and ledger scripting than the fixture has.
3. **Seam assumptions.**
   - A resume with no held guest (unverified case) must still pass `considerClaim`.
   - The `foreign` guest must stay younger than `INSTANCE_REAP_MIN_AGE_SEC`.
   - The release journal must not resolve the seam's open intent within 5 s.
   - Abandon's `releaseLease` must be recorded once.
   - If any of these is false, the harness, not the invariant, fails.
4. **Baseline differential needs root to port the r3 seam into the seed.** The seed has no `PROVISION_SUPERSEDED` (the seam's "superseded" label comes from `null`). On the seed the negative cases should fail on the status, outcome, `posts`, release or stop assertions.
5. **Billing now skips a running record's bookkeeping** for a tick in which `_restarting` is set (restart route before its DELETE). The elapsed time catches up, clamped to 2 ticks.
6. **Not changed:** deferred claimed records are still not renewed (lease policy), and real authenticated reconnect, cold activation and journal continuity remain root-owned and unqualified.
