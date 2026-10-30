# Lifecycle per-deployment host dispatch — source candidate r1

**Status: source only. Not run, not integrated, not activated.** I had Read/Grep/Write only, so I did not execute
any test, generator or syntax check. Root must review the code and run the bounded tests below before any source
integration. Mock-backed tests do **not** establish production authority, fencing, funding or readiness.

Baseline (read only, not modified): `enclave-deployment-lifecycle` @ `b7dcf5af9`,
`windows/node/host.mjs` SHA-256 `8f0b92bb7b3eb0662d706ab0da0f80b07ec4621f78105384c59a907b89d469c7`
(this is candidate source, not the installed host).

## Deliverables (all inside this task directory)

| File | Purpose |
|---|---|
| `src/network/lifecycle-host-dispatch.mjs` | Standalone per-deployment dispatch. Intended location: `network/`, beside `deployment-lifecycle-runner.mjs`. It constructs the **existing** `DeploymentLifecycleRunner` and only adds refusals around it. |
| `src/tools/generate-lifecycle-host-candidate.mjs` | Strict patch generator: pinned baseline `host.mjs` → a **separate** host candidate. It only inserts text, at 17 exact, unique anchors. |
| `test/helpers/baseline.mjs` | Test-only resolve hook. The generated candidate in a temp dir imports from the read-only baseline; the dispatch imports the baseline runner. |
| `test/helpers/lifecycle-fixture.mjs` | **Mock** lifecycle adapters (explicitly not authority). |
| `test/lifecycle-host-dispatch.test.mjs` | Dispatch over the real runner (18 tests). |
| `test/lifecycle-host-candidate.test.mjs` | Real generated candidate host vs. the unmodified baseline host, using the baseline fake Base RPC and the real `chain.mjs` (6 tests). |
| `test/generate-lifecycle-host-candidate.test.mjs` | Generator checks against the real pinned baseline (5 tests). |

Generate a candidate (writes nothing in the baseline; refuses to overwrite):
```
node src/tools/generate-lifecycle-host-candidate.mjs <baseline>/windows/node/host.mjs /abs/out/host.lifecycle-candidate.mjs
```
Run the tests (Root, bounded; needs Node with `module.registerHooks`, which the baseline tests already use; the
baseline's `node_modules` must be present):
```
LIFECYCLE_BASELINE=<baseline checkout> node --test test/
```

## Design

**Routes are a local routing decision, not chain authority.** `createLifecycleDispatch({ routes, chain, runtime,
journal, pins, policy, verifyQuiescence })`:

- **Routes must be exact.** Every route has exactly these keys: `deployment, oldLedger, newLedger, controller,
  deploymentsSchema (17), lifecycleSchema (2), ledgerCodeHash, controllerCodeHash, quiescenceDigest`. Values are
  lowercase and non-zero. The list is finite (at most 64) with no duplicates, and old ≠ new ledger. Every route's
  new ledger, controller and code hashes must equal the runner chain adapter's immutable `binding`, and
  `pins.lifecycle` must equal the controller. A route for the wrong ledger is refused at construction. Unknown keys
  (e.g. `fallback`) are refused.
- **Routes cannot change after construction.** The table is copied and frozen, and the dispatch object is frozen.
  Mutating the input array does nothing. The dispatch can attach to a host only once. There is no API to add,
  remove or edit a route at runtime.
- **No adapter defaults.** Each missing `chain.read/resolve/prepare/submit/finalize/binding`,
  `runtime.fence/stop/health/ensureStaged/serve`, journal method (the full set the runner calls), `pins`,
  `policy.refusal` or `verifyQuiescence` throws `LifecycleActivationBlocked` with the missing names. With
  `onMissing: 'hold'` the routes are still parsed and **owned** (kept out of every legacy path), but they stay
  **held**. The runner is never constructed in that mode. This is how a v2-configured app with missing adapters
  avoids falling back to v1.
- **Activation is per route.** `activate()` requires all of the following:
  - the current legacy ledger is exactly the route's `oldLedger`;
  - `chain.releaseHold(id)` is null, so no sponsored v1 release may still land. The legacy journal is never cleared;
    unknown intents are kept;
  - this process holds no legacy activity for the id (renewal or give-up in flight, engine app, legacy running
    record, known isolated domain);
  - `verifyQuiescence(route)` returns `verified: true`, `proofVerified: true`, tier `finalized` or
    `l1-finalized-derived`, the same deployment, ledger and `quiescenceDigest`, and `quiescent: true`.

  These local checks run again after the evidence await. A schema number reported by any ledger never activates
  anything.
- **Reconcile** joins one per-deployment promise across cadence, hints and concurrent callers. Before entering the
  runner it checks the legacy ledger, the legacy release hold, local restrictions, the platform service refusal,
  the new-work refusal (only when the app is not already running) and `policy.refusal(id)`. Unknown policy fences;
  a refusal fences and stops. It then calls the real `runner.reconcile(id)`. The runner's adapters are wrapped to
  **add** checks:
  - `read` must return the routed id, new ledger and controller;
  - `prepare`, `ensureStaged` and `serve` re-check context and epoch before their effect;
  - `submit` is deliberately **not** gated, so an intent the runner has already journaled is never stranded.

  After the runner returns, any change across the await (ledger moved, restriction arrived, epoch bumped) fences, and
  stops where policy requires.
- **No synthesized authority.** The dispatch never sets `verified`, tier, admission, funding or `blockAt`. All proof,
  witness (>2/3), generation, denial, journal and funding checks remain the runner's own.
- **Gas.** Only the runner's real transitions (`prepare` → journal → `submit`) transact. An idle, healthy, running app
  gets only `runtime.serve` (off-chain quorum permit) on cadence. The dispatch's own timer defaults to 5 s, bounded to
  1–10 s because permits last 20 s. It runs separately from the 30 s legacy tick, which can take minutes. No gas
  refill, budget removal or grant migration is implemented.
- **Journals.** The dispatch never opens, initializes, deletes or reconciles a journal. The composer must pass the
  lifecycle journal from `ownLifecycleJournal(file)` without `initialize`, on a file separate from
  `lease-release-journal.json`.

## Host call sites (baseline line → candidate behavior for a routed id)

The host accepts routes **only** via `cfg.lifecycleDispatch`; there is no environment flag. When it is absent,
`this.lifecycle === null` and every insertion is inert (`#lifecycleOwns` returns false).

| Baseline site | Legacy effect prevented | Candidate behavior |
|---|---|---|
| ctor :293 | — | `attachLifecycleDispatch(cfg.lifecycleDispatch ?? null, hostView)`; host view = `chain.addresses.deployments`, `chain.releaseHold`, `platformPolicy.serviceRefusal()` or `caps.paused`, `platformPolicy.newWorkRefusal()`, legacy activity, `#record`, `log` |
| `init` :380 | — | `lifecycle.start()` (held until activated), then `activate()` in the background |
| `consider` :749 (agent `/v1/claim-hint`, `scanLedger`, re-claim in `#reconcileTracked`) | `claimableBy`, `claimDeployment`, `ensureApp` | `considerHint`: no RPC, no reconcile, no claim. A forced hint clears only a local restriction |
| `restart` :868 / `restartRequest` :892 (agent restart route) | v1 read, `ensureApp(force)` | refused / HTTP 409, **before** auth (this reveals that the id is routed) |
| `ensureApp` :1497 | launch, `#giveUp` → release | returns the existing record (defense in depth) |
| `scanLedger` loop :2065 | claim, re-tracking a held lease | `continue` |
| `renewDue` filter :2212 (keeper) | `#renewKeep` → `renewDeployment` | excluded |
| `#renewSend` :2298 (pass and keeper) | `chain.renewDeployment` | `{ superseded }` |
| `#reconcileTracked` :2358 (tick phases 1 and 2, deferred re-claim) | v1 read, wallet grant, renew, give-up, stop, re-claim, edit/resize, adoption | voids the keeper permit, readiness row `status: "lifecycle"`, return |
| `#giveUp` :2597 (`ensureApp` gates, resize, `#isolationReconcile`, `#dropForCaps` from `enforceOff` / `setHostingCaps`) | `releaseDeployment`, legacy retire | `lifecycle.restrict(id, why)`: fence and stop through the v2 runtime; sticky until a forced hint; no transaction |
| `#stopApp` :2792 | legacy retire by manager **name** (would kill the v2 VM) | not applied, logged (v1 ledger state is not v2 authority) |
| `proveAll` :2839 | v1 `checkpointBatch` | skipped for routed ids only |
| `retireForeignRecovered` :2703 | removing a v2 VM by name | skipped (the v2 runtime owns its names) |
| `runUnleased` :3772 (agent) | unleased spawn under a routed id | throws |

Not changed, and why:
- `heartbeat`, `ensureRegistered` and `ensurePriced` are host-level registry writes. They are necessary and
  change-driven, not per-app renewals.
- `followBook` is left alone. A moved v1 `deployments` address holds every route ("legacy ledger is not this route's
  old ledger"), and nothing switches to the new ledger.
- `walletRefresh` / `#walletRefreshOne` only refresh grants created by guarded paths; there is no insertion there.
- `chain.mjs` is unchanged. Its transacting exports (`claimDeployment` :429, `renewDeployment` :431,
  `releaseDeployment` :434, `checkpointBatch` :902) are reachable for a routed id only through the host sites above.

**Async.** Routes are immutable, so they cannot change across an await.
- Mutable context (legacy ledger, release hold, platform/owner restriction, restriction epoch) is re-checked before
  each runner effect and after each await.
- `tick()` is already single-flight, and the dispatch is single-flight per id.
- A v1 send in flight in this process cannot coexist with activation, because activation requires no legacy
  activity.
- A v1 send from an earlier process is covered only by the release journal (`releaseHold`) plus external quiescence
  evidence. Route selection never declares it cancelled.

## Explicit blockers (production implementations not provided — must remain blockers)

1. **`verifyQuiescence(route)`** has no implementation. It needs proof-qualified evidence that the legacy assignment
   is fenced and retired, final service is settled, and the lease is not live and cannot be renewed. The evidence
   format behind `quiescenceDigest` is not defined.
2. **`policy.refusal(id)` for v2 records** has no implementation. It needs the host wallet/admission decision
   (`createHostAdmission().decision`: catalog moderation, host policy, `forPrivate`), owner-only scope / delegation
   (`ownerSet`), placement pins and the retired-engine/held rules, all evaluated on the **authenticated v2 record**.
   The legacy versions take a v1 row and cannot be reused as they are.
3. **Qualified lifecycle chain adapter.** It must provide authenticated `read` (returning `ledger` and `controller`),
   `resolve`/`finalize` on the finality bridge, `prepare`/`submit` relay with fee ceilings, and an immutable
   `binding` whose code hashes were checked against deployed runtime code. None of these exists in the host.
4. **Composer.** No code builds `cfg.lifecycleDispatch` (agent.mjs `new Host(...)` is unchanged). It would need:
   `ownLifecycleJournal` (no auto-init), `createIsolationLifecycleRuntime` with real manager, plan, readiness,
   boundaries and `collectPermit`, `DeploymentPermitGate`, `createLifecycleFinalitySnapshot`, reviewed pins and
   the route file. The composer must treat `LifecycleActivationBlocked` as fatal, or use `onMissing: 'hold'`, and
   never start the host with routes silently dropped.
5. **v2 paid proof-of-service settlement** is not implemented. Routed ids are excluded from v1 checkpoints only; this
   is not disabled globally. `state()` reports it.
6. **Recording a stop from a local restriction.** A local owner/platform restriction fences and stops locally. It
   does **not** record `queued`/`stopped` on chain, because the runner has no local-denial input; witnesses must
   fence after permits expire. A runner API for this is needed.
7. **Capacity for routed apps.** v2 records carry no share sizes. Non-running records are published as
   `provisioning` with `isolationRequired: true`, so `Host.occupies` counts them conservatively, but share
   accounting and owner caps are not enforced for v2 starts. A `setHostingCaps` drop is held only until process
   restart (in memory; legacy `blocked` persists).
8. **Gas and grants.** The new transition reserve differs from the deployed legacy gas adapter; existing immutable
   grants cannot fund it. Root and peers own grant/accounting migration. Nothing here refills gas or changes budgets.

## Unsupported integration boundaries (not touched)

- **Supervisors.** The Windows node supervisor/service wrapper (`agent.mjs`, `deploy-files.mjs` closure, which must
  ship `network/lifecycle-host-dispatch.mjs` and the runner's dependencies) and the Linux `supervisor.js` reconcile
  loop have no routing. The Linux side has its own legacy lease loop that would also need the same exclusion.
- **Services.** Ingress/app-zone proxy (`proxy`, `appZoneTarget`, certificates, domains), storage and secret release
  have no binding to `DeploymentPermitGate.assert/track`. Domain refresh in `#tickOnce` still iterates `this.apps`
  and records.
- **Restart readiness.** `leaseReadiness()` consumers will see the new row status `"lifecycle"` and must treat it as
  "not legacy-ready".
- **Migration tooling.** There is no migration script, address-book change, import, or journal migration/deletion.

## Tests (what they show, and what they do not)

- **Dispatch (real runner, mock adapters):**
  - every missing adapter is a named blocker;
  - hold mode owns the route and keeps it held without reading the chain;
  - invalid, duplicate and wrong-ledger routes are refused, including a pins mismatch;
  - routes are immutable and the dispatch attaches once;
  - an unactivated route is held;
  - each evidence mismatch is refused, and so are a release hold, legacy activity and a ledger change across the
    await (the hold is retained);
  - 25 idle passes give 25 `serve` calls and 0 `prepare`/`submit`;
  - a queued start submits once and never resubmits an unresolved intent;
  - wrong-ledger/controller/id snapshots are refused;
  - a moved legacy ledger holds the route without the runner;
  - a context change during the runner await gives no serve;
  - a restriction arriving mid-reconcile stops, and only a forced hint clears it;
  - concurrent reconciles/passes produce one runner execution;
  - policy unknown, refusal and malformed answers behave as designed;
  - service refusal stops, while new-work refusal blocks only starts;
  - hints never reconcile;
  - the cadence uses an injected timer.
- **Candidate host (generated from the pinned baseline):**
  - with zero routes, the candidate's scan/consider/tick outcomes deep-equal the unmodified baseline host's;
  - for routed ids (not activated, and hold mode), `consider` (plain and forced), `restart`, `restartRequest`,
    `runUnleased`, two `tick`s, `renewDue`, `proveAll` and `scanLedger` produce no RPC on the hint paths, no legacy
    transaction, no policy/ensure pass for the routed id and no checkpoint, while the unrelated legacy app is still
    reconciled and checkpointed;
  - an activated route run concurrently with tick, keeper, hint and passes executes the runner once, then idles with
    0 transactions;
  - `caps.paused` through the host's own closure stops the routed app without a transaction;
  - a moved address-book ledger holds the route.
- **Generator:**
  - the pinned hash is checked;
  - removing the insertions restores the baseline byte for byte, and each guard precedes its legacy effect;
  - there is no environment flag;
  - a changed hash, missing/duplicate/overlapping anchors, duplicate names, empty insertions and double application
    are refused;
  - output is never written into the baseline directory or over an existing file.
- **Not shown:**
  - any real adapter, authenticated read, witness quorum, fencing or receipt behavior;
  - `#giveUp` reached through the real `enforceOff`/`dropPlan` (only its guard placement is checked statically);
  - the `renewDue` exclusion while `#leaseSeen` holds a routed id (private state; checked statically plus by
    `#reconcileTracked` voiding it).

  Some host-test preconditions depend on baseline fixture behavior I could not execute. They are asserted
  explicitly (for example, "the legacy scan re-tracks a held lease"), so a mismatch fails loudly rather than
  passing vacuously.
