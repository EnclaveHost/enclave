# Windows permit r10 — actual Host independence, withdrawal, capacity, final-send exclusion

AUTHORED SOURCE ONLY. Nothing was executed, tested, built or hashed by the author (Read/Grep/Write/Edit only). Every "test" below is
**authored, not run**. Executed evidence is only the root's (section 6). No Windows, Base, finality, production or financial qualification is claimed.

## 1. Actual Host authority/config/reconciliation (root findings 1 and 2)

`control/windows/node/host.mjs`
- `tick()` now starts `protectedTick()` first, on its **own** in-flight guard, and only then joins/starts the legacy pass. The protected pass is
  no longer inside `#tickOnce`, so `chainReady`, `followBook`, owner/registration refresh, `scanLedger` or a hung legacy pass neither precede nor
  delay it (cold recovery works with `chainReady=false`). `tick()` still reports a legacy failure to its caller after both settle.
- `#protectedPass()`: PHASE 1 calls `ProtectedSupervisor.authority(id)` for **every** enrolled route before any new-work planning — owner-loss raw
  cleanup, authenticated snapshot, canonical Stop/Offline/revocation with exact removal, unknown-authority fence (never an invented Offline),
  unknown raw-stage resolution, and local capacity observation. `#protectedOutcome` clears instance fields only on confirmed absence.
  PHASE 2 runs `#protectedLaunch(id, snap)` only for routes whose authenticated assignment is queued/running here.
- `#protectedLaunch` no longer calls `chain.readDeployment` or `chain.resolveAppRef`, has no yank early-return, and does not overwrite shares.
  Configuration comes only from `protectedConfigOf(snapshot)`: content pin (`content.appRef/cid`), resources/version minima, envelope `configCid`,
  owner and access (`forPrivate`). Integrity is preserved: these are the pinned identities that `#isolationReconcile`'s strict config fetch
  (`appConfig(..., { strictCid: true })`) verifies, and the envelope is parsed by the same `envelopeOf`. Publisher listing is carried as
  `listing` for host-owner-elected moderation, which the adapter's host-scoped `independentAdmissionRefusal` already applies; it is never a Host veto.
- Withdrawal does not depend on a launch plan: Stop/Offline is decided in phase 1, and the supervisor's `reconcile()` repeats `authority()` at
  the start effect, so a plan never outlives a withdrawal.

`control/windows/node/protected-supervisor.mjs`: `authority(id)` split out of `reconcile()`; `reconcile()` = `authority()` then `#newWork()`
(route handoff → owner restriction → manager capability → stage/serve). `resolveUnknown()` moved ahead of the capability gate (it is cleanup).
New `enrollmentState()` and `protectedConfigOf()`.

`control/network/deployment-chain-adapter.mjs` (**pinned R18 copy modified — provenance change**): the independent snapshot now carries
`envelope: { configCid, owner }` from the same authenticated deployment row. If `configCid` is not a string the node holds, because the
configuration is unknown. That `v.d.configCid` is present in the real derived row was inferred from the legacy Host's use of the same contract.
It has not been verified against the ABI artifact.

## 2. Conservative invalid policy and final-send exclusion (root finding 3)

An unknown policy (unreadable, malformed or hash-mismatched) is never treated as "not enrolled". Every legacy financial send boundary now
requires `enrolledByPolicy(id) === false`:
- `consider()`: at entry **and** immediately before `chain.claimDeployment`, after all of its awaits.
- `renewDue` filter changed from `!== true` to `=== false`. The `#renewKeep` post-await `fenced()` now includes the enrollment check.
- `#renewPermit` checks enrollment first. That permit is the `gate` that `#renewSend` checks, and that `chain.mjs` re-checks when the operator
  queue reaches an **already queued** send. So a policy that turns unknown after a decision causes no send.
- `#reconcileTracked`: unknown → `#policyUnknownHold` (renew epoch voided, wallet grant revoked, keeper state cleared, tracking kept, not-ready).
- `#giveUp`: unknown → `#policyUnknownWithdraw`. This does exact local removal (retried while unconfirmed), sends no release and keeps tracking.
  A genuine local refusal therefore does not strand compute. `#giveUpOnce` re-checks enrollment right before `chain.releaseDeployment`; if it
  withholds the release, it re-tracks the id so the obligation is kept.
- Known unenrolled neighbours on a valid policy are unchanged. Local Stop (`#stopApp`) never sends a transaction.

## 3. Real allocation/headroom before staging (root finding 4)

- `lifecycle-host-dispatch.mjs` (**pinned R18 copy modified — provenance change**) exposes its **existing** `observe`/`learnShares`/
  `capacityRefusal`/reservation as `observeRoute`, `admitStart`, `confirmPresent` and `confirmRetired`. `admitStart` first runs a decision-free
  precheck (legacy release hold, unresolved routes, unobserved inventory, CPU/GPU caps plus `capacityHeadroom`). Under host-registry it then
  takes `freshDecision`, which persists the authority floor and incarnation. It re-checks owner/local holds, incarnation and platform new work,
  and reserves in **one synchronous step** before the awaited stage. Nothing here prepares, signs or submits, and the dispatch cadence is still never started.
- `protected-authority-factory.mjs`: `admittedRuntime()` wraps the owned runtime. `ensureStaged` goes through `admitStart`; confirmed
  `stop`/`revoke*` absence calls `confirmRetired`; health naming a live instance calls `confirmPresent`. Everything else is the bound owned runtime.
  `handoff.observe` drives `observeRoute` on the authority path. `hostView.bindCapacity(dispatch.capacityUnresolved)` is the host-wide hold.
- Host: `Host.occupies` counts `lifecycleAllocated === true`, so pending/recovered/unknown allocations are counted before an instance id exists
  (root test 4: 0.2 + 0.4). `#lifecycleNewWorkHold()` holds **legacy** new claims (`consider`) and new spawns (`#spawnCapHold`, enrolled excluded)
  when the policy is unknown, when the owned lifecycle is not yet open on an enrolled host, or while any route's allocation is unresolved.
  Unknown is never zero. The maximum confirmed commitment survives a shrink or an unknown read (`learnShares` max while physical/reserved).
  It is released only on evidence (`retired` / a definite absent listing with no commitment).

## 4. Authored tests (NOT RUN)

`test/windows-permit/r10-host-independence.test.mjs` — actual Host class with the root's import-hook approach and labelled external-service doubles:
- Part A (actual Host + actual supervisor + **labelled TEST owned runtime**, isolationVerdict as a reachability probe):
  - carried root positive control, now asserting **0** retired ledger and **0** catalog reads (deliberately changed from the root's `catalog === 1`);
  - publisher yank does not veto;
  - book failure, then `chainReady=false`, still reconcile;
  - canonical Stop withdraws with a failing plan and failing book, with no plan reached and no sends;
  - proof-verified Offline revokes host authority, and stale evidence only fences;
  - root capacity test unchanged;
  - hash-mismatched enrollment produces zero claim/renew/release across tick, keeper and consider, with tracking retained and no legacy row read.
- Part B (actual `Host.lifecycleView()` + **real** `composeProtectedAuthority` → R18 owned factory/journals/flock → real dispatch, TEST
  chain-adapter/finality/collector/inventory):
  - cold unresolved allocation holds an ordinary legacy claim and refuses a lifecycle stage, with nothing staged;
  - unknown inventory stays unresolved;
  - a recovered VM is committed at the authenticated 0.25 beside the 0.5 neighbour;
  - the commitment is kept across a shrink to 0.1 and an unknown read, and released only on a definite absent listing.

Carried root fixture corrections:
- `r7-owner-lifetime` line36 (`entry.promise`, exact identity/absence); line62 is kept.
- `r4-supervisor-chain`: owned obligation store and full snapshot mapping.
- `r5-ownership-chain`: full snapshot mapping.
- `r6-stage-revocation`: `live()` counts every VM (stricter).

## 5. Honest remaining work (not done in this pass)

- **Required full positive consumer test not delivered**: actual Host + real factory/owned journals/gate/runtime + actual client/manager/router
  performing a useful queued stage, readiness, Running serve/renew and exact Stop/Offline/owner-loss removal. Part A uses a TEST owned runtime.
  Part B stops at capacity admission: a positive `admitStart` under host-registry needs a real `authority.decision`/incarnation fixture chain
  that I did not build. The existing r7 composite still uses the TEST pre-activated handoff.
- Also not covered by tests:
  - delayed already-queued renewal under a policy that becomes unknown. The permit-gate path exists, but no test drives a legacy renewal to the operator queue;
  - "no duplicate legacy claim/renew/release" with a valid policy for a routed id, beyond the existing r9 coverage;
  - a positive start after capacity resolves.
- **Root's unmodified `root-host-consumer.test.mjs` will now differ**: with no authority composed, the Host reaches no plan, because no
  authenticated configuration exists. Its test 1 (`catalog === 1`) encodes the removed legacy-row dependency. The portable successor asserts the intended property.
- Unchanged from r9, not attempted in r10:
  - protected native roles (allpp→legacy routing, V8/native protected refusal in manager main/compose and router main/control/io);
  - two-manager native composite;
  - per-workload KVM desktop/GPU/worker/egress/secrets/volumes/storage/ports/command-socket serving-ownership boundaries.
- Production quiescence still needs a reviewed derived-proof verifier implementation (only the pinned-module interface exists).
- Windows Job/EXLOCK, Base finality and npm acceptance of the ws override all remain unqualified.
- Risks to check on execution:
  - `ProtectedIsolationClient.runtimeAdapters` accepting Part A's minimal gate/pins;
  - the owned factory passing `client` as the dispatch `inventory`;
  - the fresh owned journal's `read(id)` for an untouched route.

## 6. Executed root evidence (unchanged, not re-run)

- Focused: 44 tests, 38 PASS / 6 FAIL. The six failures are fixture-interface defects.
- External corrected fixtures: 17 PASS / 0 FAIL. These overlap the focused run and are not additive.
- Actual Host corrected (port41) run: 1 PASS / 3 FAIL.
- Initial port1 run: a setup failure, not a product result.
