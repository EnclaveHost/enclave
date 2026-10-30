# Lifecycle host authority r2: owner-scoped authority for routed apps (source candidate)

**Status: source only. Nothing has been run, integrated or activated.** I had Read/Grep/Write only, so I did not
execute or syntax-check any file. Root must review and then run the bounded tests. Mock-backed tests do **not**
establish production authority, fencing, funding, capacity or readiness, and this candidate is not deployable.

This is a component of the decentralization goal. It removes the platform's extra veto from the generated host's
lifecycle path and keeps the box owner's and host wallet's own controls. It does **not** make Enclave decentralized.
The remaining central dependencies are listed in section 6.

## Inputs (read only, not modified)
- Root-reviewed r1: `../lifecycle-host-routing-review-r1`, with root's two fixes: the post-await unsigned-prepare recheck
  and the attached-host read binding. Both are retained (`assertStart` before and after `chain.prepare`;
  `s.thisHost === host.hostId`). The root tests are kept unchanged in intent in `test/root-dispatch-regressions.test.mjs`.
- Candidate baseline `…/2026-10-23/it/work/enclave-deployment-lifecycle`, `windows/node/host.mjs` SHA-256
  `8f0b92bb7b3eb0662d706ab0da0f80b07ec4621f78105384c59a907b89d469c7`, pinned by the generator. This is candidate source,
  not installed production.
- Existing r6 adapter `lifecycle-chain-adapter-stage/r6/network/deployment-chain-adapter.mjs`. I reused its interface and
  did not re-implement or modify it.
- Peer `lifecycle-emergency-offline-r1`: REPORT.md, INTEGRATION-NOTES.md and ROOT-REVIEW.md (in progress). I did not edit
  or duplicate any contract.

## 1. Deliverables (all in this directory)
| File | Purpose |
|---|---|
| `src/network/lifecycle-host-dispatch.mjs` | Revised r1 dispatch. Authority is scoped to the authenticated host owner, and online gates act at the point of effect. |
| `src/network/lifecycle-host-authority.mjs` | New. Integrity/consent vs optional moderation admission, the scoped `EnclaveHostOwnership` reader with a revision floor, the catalog reader, and `composeIndependentLifecycle` (wires the r6 adapter instance). |
| `src/tools/generate-lifecycle-host-candidate.mjs` | Pinned insertion-only generator: 18 edits (r1 had 17). The constructor view is rescoped and a new `proxy` edit is added. |
| `test/helpers/{baseline,lifecycle-fixture,candidate-host}.mjs` | Resolution hook (task modules → baseline network/site/node_modules), **mock** fixture, shared generated-host setup. |
| `test/*.test.mjs` | 60 tests in 7 files (section 5). |

The intended source locations are `network/lifecycle-host-dispatch.mjs` and `network/lifecycle-host-authority.mjs`.
Legacy `host-admission-policy.mjs`, `host-admission-runtime.mjs`, `host-service-gate.mjs` and `catalog-policy.js` are
**imported, never changed**. Their behavior on legacy paths is identical, and a test asserts that legacy
`hostAdmissionRefusal` still applies mandatory moderation.

## 2. What changed in source, and why

**A. The platform gate is scoped to authenticated host ownership. The generator constructor view (`host.mjs` ctor) and the dispatch `denial()` both change.**
- r1 passed `platformPolicy.serviceRefusal() || caps.paused` as an unconditional `serviceRestriction`. The view now
  passes these separately:
  - `ownerRestriction`: `caps.paused`. This is the box owner's control and always applies.
  - `platformService` / `platformNewWork`: the gate's answers, passed as data.
  - `capacity`.
- The dispatch applies the platform answers only when the decision's **authenticated owner**
  (`EnclaveHostOwnership.authority(hostId)`, read through the production `hostAuthorityReader` +
  `readHostAdmissionPolicy`) is in `platformWallets`. That is an explicit, frozen, reviewed list, and an empty list is
  valid.
- No ownership boolean is accepted from a caller. The dispatch computes `platformOwned` itself from `decision.owner`.
- The platform policy is not turned off globally: the gate still runs, and every unrouted app keeps it unchanged.
- When Enclave's wallet owns a host, its ban is that owner's stop: a local fence plus a ledger revocation. When the host
  is owned independently, a ban or outage has no effect on routed apps.

**B. Admission separates integrity/consent from optional moderation (`independentAdmissionRefusal`).**
- **Always applied:**
  - the host owner's committed deny lists;
  - the version exists (`versionCount > index`), with a content commitment (`cid`, `createdAt`);
  - publisher consent: `active` and `yanked`. Only the publisher sets these (`EnclaveAppCatalog.setActive` and
    `yankVersion` go through `_resolveMine`).
- **Only if `requireCatalogApproval === true`:** catalog-owner moderation, i.e. the production `catalogAdmissionRefusal`
  plus `approval === 1`. `setApproval` is `owner`-only.
- Any failure to read is **unknown**, and unknown never means allow.

**C. Old authority ends at the handoff.**
- `activate()` is unchanged. It still requires:
  - the exact old ledger;
  - an empty legacy release-journal entry (never cleared);
  - no legacy activity in this process;
  - finalized quiescence evidence bound to the route.
- After activation, `reconcileOnce` no longer consults `legacyLedger()`. A later legacy `releaseHold` refuses **starts
  only** and is retained, never cleared.

**D. Online gates act at the point of effect, never before the runner.**
- After activation the runner always runs, so authenticated reads, mined/pending reconciliation and revocations proceed.
- **Serving** requires a fresh, valid decision with no owner-scoped denial and an unchanged epoch.
- **Starts** (`ensureStaged`, `prepare('running')`) additionally require:
  - no release hold;
  - no platform new-work refusal on a platform-owned host;
  - capacity.
- **Revocations** (`prepare('queued'|'stopped')`) are never gated. `submit` is never gated, which keeps no-resend.
- An owner-scoped denial only **lowers** `admitted`. The runner's own logic then fences, stops and prepares the queue
  intent. The dispatch never sets `verified`, a tier, `admitted: true` or funding.
- New-work refusal no longer reads the in-memory `last` status. A restarted process reconciles authenticated running
  state and serves it.

**E. Local owner stop.** `restrict()` fences and stops at once. It then schedules a reconcile, in which the runner sees
admission lowered and records a `queued` revocation through the chain adapter (`prepare` → journal → `submit`). If the
chain cannot be read, there is no ledger record until it can; the local fence still holds. This uses this host's
ordinary actor path. No failed-host signer is required here. Witness-quorum emergency offline belongs to the peer and is
not wired (section 6).

**F. Capacity is never a silent allow.**
- A start needs `snapshot.resources {cpuShare, gpuShare}` and a host capacity view with `paused === false` and finite
  caps.
- The check is: allocations and pending reservations (both counted in `shareUse`, because each reservation is written
  into the record at once through the merging `#record`) + need + `capacityHeadroom` ≤ cap. Headroom is explicit and in
  the range 0–0.5.
- Missing shares or an unreadable capacity view means the start is refused.

**G. Replay and transfer.**
- Each decision must:
  - have exactly these keys: `hostId, deployment, owner, revision, policyHash, refusal, validUntil`;
  - bind this host and this deployment;
  - be fresh.
- The revision floor is monotonic. A lower revision is a replay; a different owner or policy at the same revision is
  equivocation. Both are unknown.
- The same floor is enforced inside `createScopedHostAuthority`.

**H. Ingress (`proxy`, new edit).**
- A routed id gets `dispatch.ingressRefusal(id)`: last authenticated status `running`, a fresh decision, and no
  owner-scoped denial.
- The baseline platform check runs, byte for byte, for every unrouted app. The edit puts it under
  `if (!this.#lifecycleOwns(key))`.

**I. Composer (`composeIndependentLifecycle`).**
- It takes an r6 adapter instance and its exact reviewed pins. The binding (ledger, controller, code hashes), `hostId`,
  `hostOwnership` and `catalog` addresses all come from those pins, never from separate arguments.
- It builds the real scoped ownership reader and catalog reader over the production `LeaseReader.agreed`.
- It labels r6 snapshots with the pinned `ledger`/`controller`. r6 verifies both, together with the code hashes, inside
  the same authenticated block.
- A missing part raises `LifecycleActivationBlocked` naming it, or holds the route with `onMissing: 'hold'`.

## 3. Host path audit (generated candidate)
| Path | Routed id |
|---|---|
| ctor view | owner / platform / capacity separated (A). `this.caps` is loaded at :277, before the anchor; the closures are lazy. |
| `proxy` :4189 | owner-scoped ingress; platform check only for unrouted ids |
| `enforceOff` :2986, `setHostingCaps` drop :3020 → `#dropForCaps` → `#giveUp` | `restrict` (owner control: fence now, revocation via runner). Tested through the real `enforceOff`. |
| `consider` :749 | the guard is inserted at :750, **before** `releaseHold` (:751) and the platform `newWorkRefusal` (:753). A routed hint gets `considerHint`, never the platform reason or a claim. |
| `renewDue`/keeper :2207 :2240 :2291 :2477 :2522 | legacy lease renewal; routed ids are excluded (r1 edits) |
| `#reconcileTracked`, `ensureApp`, `restart*`, `scanLedger`, `proveAll`, `#stopApp`, `retireForeignRecovered`, `runUnleased` | unchanged r1 exclusions |
| other `#giveUp` callers :960 :964 :1253 :1407 | not exercised. For a routed id they become a **local** restriction (fail-safe and not platform-derived; a forced hint clears it). Root should confirm they are unreachable for routed records. |
| `chain.setLeaseRelayPolicy` :202, `agent.mjs` :1095 `hostServiceRefusal` | legacy relay signing / host-services enrollment; untouched (section 6) |

## 4. Changed expectations from r1 (the r1 evidence logs stay in r1 and are not edited)
1. Dispatch, "moved legacy ledger holds an activated route" → **after handoff the app keeps serving**. The hold before
   handoff is still tested.
2. Dispatch, context change across the runner await: the trigger was a ledger move; it is now a local owner restriction
   (no serve, one queued revocation).
3. Dispatch, a restriction mid-reconcile used to end `running` after a forced hint → it now ends **pending revocation
   retained** (no resend, no invented cancellation).
4. Dispatch, policy unknown used to give `read 0` → the runner still reads (`read 1`) and serving is fenced, not
   stopped. A refusal now records `queued`.
5. Dispatch, "platform service refusal stops" → now **only on a platform-owned host**.
6. Dispatch, new-work refusal is now owner-scoped and survives a restart.
7. Candidate, "owner off stops without a transaction" → it now issues **one queued revocation via the (mock) lifecycle
   chain**, with 0 legacy transactions, through the real `enforceOff`.
8. Candidate, "address-book ledger moved holds the activated route" → it now holds only before activation.
9. Blocker names: `policy.refusal` → `authority.decision`, plus `platformWallets` and `capacityHeadroom`.

## 5. Tests (60; none skipped; no hidden overrides; all adapters for authority, funds, runtime and proofs are mocks)
- `lifecycle-host-dispatch.test.mjs` (26): real runner.
  - Retained r1 cases: blockers, hold mode, routes, activation, idle, once-only submission, binding.
  - Changed cases (section 4).
  - New regressions:
    - independent host under a ban;
    - legitimate stop on a platform-owned host;
    - pending reconciliation under denial;
    - restart;
    - owner stop under online denial and a chain outage;
    - replay, equivocation and foreign host/deployment decisions;
    - ownership transfer;
    - capacity and headroom.
- `root-dispatch-regressions.test.mjs` (3): root's two r1 regressions, plus a companion showing the post-await recheck
  does not block a revocation.
- `lifecycle-host-pending.test.mjs` (6): a journaled start is resolved read-only and never resent under each accepted
  denial. Note: the dispatch file's pending case switches owner at an unchanged revision. That correctly becomes
  equivocation (unknown); this file covers the accepted-refusal cases.
- `lifecycle-host-authority.test.mjs` (8): the real `host-admission-policy`/`catalog-policy` functions with a mock
  agreeing reader.
  - integrity vs elected moderation;
  - legacy behavior unchanged;
  - hash-checked commitment, revision floor and freshness;
  - end to end through the real runner: pending-approval app served under a ban; elected moderation, deny list or yank
    stops; platform-owned ban stops; outage gives unknown;
  - composer wiring: ownership and catalog read from the pinned addresses; missing parts are named.
- `lifecycle-host-candidate.test.mjs` (6): the generated host against the unmodified baseline host, using the fake Base
  RPC and real `chain.mjs`.
- `lifecycle-host-independence.test.mjs` (6): the generated host with the platform gate on (ban and outage).
  - routed app served, while the **legacy app is still refused** (legacy apps are not claimed independent);
  - a queued app starts;
  - ban on a platform-owned host;
  - transfer, then replay;
  - restart;
  - box-owner stop.

  It runs in its own process because a non-off gate installs a process-wide lease-relay policy.
- `generate-lifecycle-host-candidate.test.mjs` (5): pin, byte-exact restore, guard order (including `proxy`), host view,
  refusals, no overwrite.

Run (root, bounded, one process per file, concurrency 1). It needs `module.registerHooks` and the baseline's
`node_modules`:
```
LIFECYCLE_BASELINE=<baseline checkout> node --test --test-concurrency=1 test/
node src/tools/generate-lifecycle-host-candidate.mjs <baseline>/windows/node/host.mjs /abs/out/host.lifecycle-candidate.mjs
```
I could not execute two preconditions: what `proxy` does past the gate in the fixture, and the `enforceOff`→`dropPlan`
membership of a lifecycle record. The `ingress` helper asserts only the gate outcome, and `enforceOff` is asserted to
return `[A]`. A mismatch fails loudly rather than passing.

## 6. Unresolved real composition gaps (must remain blockers)
1. **r6 address-book dependency.** The `pinned()` check in r6 (adapter lines ~186-189) requires the address book to
   equal the reviewed entries at every read. Its `addressBook.owner`/`pendingOwner` admin checks (~237-238) also deny
   starts. As a result, an Enclave address-book change after handoff still **fails every routed read closed** (fence,
   no stop) and denies starts. The dispatch removes the old book only at the host level. Needed: a reviewed
   post-handoff pin profile without the global book.
2. **r6 global catalog veto.** r6 computes `enabled = ownerEnabled && catalogAdmissionRefusal(...) === null` (~386-388),
   so a catalog-owner rejection or a pending approval makes the runner **stop the deployment on every host**. r6's
   per-host `hostDenial` (~399) also uses the legacy mandatory moderation. The dispatch must not raise either field.
   Needed: an r6 revision in which `enabled` = owner/active + publisher consent/integrity, and the per-host check uses
   `independentAdmissionRefusal`. This is listed in `ADAPTER_GAPS`.
3. **r6 snapshot lacks `resources` and `forPrivate`**, so every routed start is refused (capacity unknown). Needed: the
   ledger `get()` shares (`cpuMilli`/`gpuMilli`, plus the version's effective share) at the same block.
4. **`verifyQuiescence` has no implementation.** The evidence format behind `quiescenceDigest` is undefined (carried
   over from r1).
5. **Revocation liveness.** The host's revocation uses the normal `transition`, which needs the ledger, identity and
   oracle to be live, plus this host's actor signer and relay. Peer emergency offline (`emergencyOffline`, schema 3) is
   **BLOCKED** on the paired-ledger patch and is not wired. There is no independent reporter or witness submitter here.
6. **Replay floor and local holds are in memory.** After a restart, an older but still fresh snapshot (within 90 s)
   could be accepted once. Drop-for-caps holds are lost on restart; `caps.paused` persists through the host caps file.
   Needed: persist the floor in the lifecycle journal (the journal API owner decides).
7. **`platformWallets` source.** These must be root-reviewed pins; no source of truth has been decided. Platform-side
   gates outside this host (relay discovery/attach, DNS/app-zone routes, custody, host-services enrollment at
   `agent.mjs` :1095, the lease-relay policy) still give Enclave reach over independent hosts.
8. **Ingress and resources.** Ingress uses the dispatch's last status and decision. `DeploymentPermitGate`, storage,
   secret and certificate boundaries are not bound to the generation (see the peer's integration notes).
9. **Not wired.** There is no composer call in `agent.mjs`, no Linux `supervisor.js` routing, and no deploy-closure
   entries.
10. **Funding.** Gas, grants and v2 paid settlement are unchanged from r1. Nothing here refills, migrates or enlarges a
    budget.

No environment flag, default ledger change, activation, renewal, heartbeat, custody transfer, key, signature or network
action is introduced.
