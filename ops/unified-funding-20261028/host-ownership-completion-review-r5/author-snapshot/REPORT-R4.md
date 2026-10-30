# REPORT-R4: async owner withdrawal + persistent commit evidence (source only)

Status: **authored, not run.** Nothing here was executed (no node, compiler, git, network or services). Root executes the tests. This is a focused repair, not completion and not production readiness. The inherited `REPORT.md` is left as it was; this file replaces none of its evidence.

## Files written in this run (all under `candidate/`)

| File | Change |
|---|---|
| `src/network/owned-durable-state.mjs` | Rewritten. Asynchronous owner lifetime and a retained intent/acknowledgement protocol (details below). |
| `src/network/deployment-host-authority-journal.mjs` | Passes through `withdrawDeadlineMs` and exposes `assertLive`. `release` now returns the completion promise. Validation and semantics are otherwise unchanged. |
| `src/network/lifecycle-host-incarnation-journal.mjs` | Same plumbing, plus an owner-epoch guard on the **production (locked) wrapper**. |
| `src/network/lifecycle-host-owned-authority.mjs` | `release()` now returns one memoized promise. Both sidecar locks wait for a single combined withdrawal. |
| `src/tools/generate-host-authority-permit-candidates.mjs` | New gate and runtime insertion edits. The five pinned inputs, the marker and the byte-restoration self-proof are unchanged. |
| `test/root-async-ownership-r4.test.mjs` | **New** narrow suite: 16 tests. |
| `test/root-ownership-lifecycle.test.mjs` | Updated only where r3 asserted a synchronous release object or deletion of the intent file. |

All other seeded files are byte-identical to the frozen r3 delivery. That includes the dispatch generator, the protocol and adapter copies, the other tests and the r3 harness.

## What is implemented

### 1. Asynchronous owner lifetime

**`owned-durable-state.mjs`**
- `release(reason)` does three things synchronously:
  - marks the handle released, so every retained method refuses;
  - starts every registered withdrawal listener;
  - returns **one memoized completion promise** resolving to `{released, fenced, errors}`. It never rejects, so nothing becomes an unhandled rejection.
- The flock is released only after **every** listener settles successfully.
- These all leave the lock held and the handle fenced for the life of the process:
  - a rejection or a synchronous throw from a listener;
  - exceeding the optional `withdrawDeadlineMs`.
- No timeout ever releases the lock.
- If every listener is synchronous and succeeds, the lock is released synchronously. This keeps root's control case and the existing `release(); reopen` callers intact.
- `onRelease` after release now **throws**. In r3 it ran the listener immediately.
- Lock loss is detected on every `state`/`store` call and also by `assertLive()`. It starts the same withdrawal. The orphaned fd is closed only after that withdrawal succeeds.

**Generated gate** (edits `assert-check`, `track-withdrawal`, `close-completion`, `methods`)
- Each tracked resource close callback is wrapped. Its promise is retained in `withdrawals` instead of only passing through `#dropResources`' `.catch(onError)`.
- `close()` returns a memoized completion. It loops until every withdrawal and every registered in-flight runtime operation has settled, and rejects with an `AggregateError` if any failed.
- The owner listener returns that promise, so the actual runtime `revokeInstance` (manager removal plus boundary hold) holds the flock until it finishes.
- `assert()` now also refuses unless `ownerLive()` holds. `ownerLive()` calls `hostAuthority.assertLive()`, so the next `assert` call after a lock loss closes the gate.
- New methods: `epochOf(id)` and `work(promise)`. `work` refuses once the owner is not live.

**Composition** (`openOwnedHostRegistryLifecycle`)
- Both sidecar owners register the same `withdrawAll`:
  - stop the dispatch cadence;
  - trigger release of the other owner;
  - await `gate.close()`'s completion.
- Both locks release only if that combined withdrawal succeeds; otherwise both stay fenced.
- `release()` resolves `{released, fenced, permit, incarnation}`. It is idempotent and returns the same promise.

**Locked incarnation wrapper**
- Forwarded owned-journal methods require a live owner. Only `SAFE_AFTER_AUTHORITY_LOSS` is exempt: `read`, `readHostAuthority`, `decision`, `settleMined`, `archiveMined`, `retireRuntime`, `fence`, `deny`.
- So the dispatch cannot prepare or submit through a retained reference.
- Authenticated Stop and read-only or mined reconciliation remain available.
- `settleTransition` is **not** exempt, so pending records are not erased after authority loss.
- The caller-owned `withHostIncarnationJournal` is unguarded, so root's mock-based tests behave as before.

**Witness**
- An `assertLive()` check sits right before the signature leaves.
- On lock loss, the witness's journal reads after each await detect it, close the witness and abort its in-flight requests.

### 2. Runtime cancellation at await boundaries (generated runtime, v2 only)

`ensureStaged` registers an owned operation **before any side effect** via `gate.work`; it refuses if the owner is already gone. It then re-checks owner liveness and the app's revocation epoch at these points:

- after `plans.read`, which also follows the boundary hold;
- after `handoffHostAuthority`, where the epoch is pinned;
- after the initial manager lookup. This is the last check before `spawn`, so **no spawn is initiated after close**;
- after `spawn`. A spawn initiated before close is awaited. Its instance is removed and its absence confirmed by an independent lookup. A rejected spawn after close also confirms absence;
- after readiness. Whatever this start staged is withdrawn.

`close()`'s completion waits for the operation to end. A failed or unknown removal makes it reject, so the owner stays fenced.

`revokeHostAuthority` now withdraws the grant and the durable binding **synchronously, before** awaiting the boundary fence.

v1 runtimes get an inert operation, so their old behavior is exact. This is a generator-only change: the old pinned runtime input (`40333d5b`) is untouched. The previous final runtime that root's `lifecycle-staging-close-boundary-r1` evidence ran against is **not** this generated runtime, and no claim is made that root's test passes on it until root runs it.

### 3. Durable intent acknowledgement

Every write is a numbered transaction in this order:

1. intent (tmp, fsync, rename, dir fsync);
2. state (tmp, fsync, rename, dir fsync);
3. commit acknowledgement (tmp, fsync, rename, dir fsync).

Rules:
- **A store never deletes `<file>.intent`.**
- A reopen is clean only when `.commit` matches all of:
  - the current intent's `seq`;
  - the sha256 of the exact intent bytes;
  - the on-disk state hash, which must equal `intent.after`, or `intent.before` for a recovered `not-landed`.
- If the acknowledgement's own final directory sync fails, the acknowledgement is retracted by renaming it to `.commit.unacknowledged-<seq>-<uuid>` (retained). A fresh open then sees an intent with no matching acknowledgement and stays uncertain. This covers root's exact third-directory-fsync case.
- `recover()` (explicit, by a live handle):
  1. classifies the exact bytes as `intent.after` or `intent.before`; anything else refuses;
  2. fsyncs the file and the directory;
  3. appends a fsynced provenance line to `<file>.history`;
  4. acknowledges through the same retractable path.

  So a failure of recovery's final acknowledgement also stays uncertain across a fresh open.
- Nothing is reset.
- A v2 marker with a state file but no intent refuses.
- Legacy r3 files (empty marker, no intent) open as committed. A leftover r3 `v1` intent stays uncertain until recovered.
- Established coupling is unchanged: losing the sidecar plus its marker refuses when the actual owned lifecycle journal shows an established host, and recovery refuses a missing file.

**Stated residual:** suppose the retraction rename itself fails after a failed final directory sync. The error says so and the process stays latched, but a same-boot fresh open could see that acknowledgement. The acknowledgement is only ever written after the state file and its directory entry synced successfully.

## Tests authored, not run

**`test/root-async-ownership-r4.test.mjs`** (16 tests). It must run in the final layered native tree, i.e. a `network/` directory holding the r4-generated gate, witness, runtime and serving-permit, the three ownership modules and `runtime-lock.mjs`.

- A1–A4, owned-durable-state with a real flock:
  - delayed async withdrawal, with the next owner **excluded before** cleanup completes and acquiring afterwards;
  - rejected and synchronous failures stay fenced;
  - the deadline fences;
  - lock loss is detected via `assertLive`.
- D1–D4, the acknowledgement protocol:
  - positive control;
  - store final-acknowledgement fault (third directory fsync), then fresh open, then owned recovery with history;
  - recovery final-acknowledgement fault, then fresh open, then successful recovery;
  - sidecar plus marker loss.
- G1–G8, actual generated gate and runtime over an owned permit journal, with a synthetic manager that has await gates:
  - release waits for the actual `revokeInstance`;
  - rejected removal stays fenced;
  - no spawn after close at the initial lookup;
  - a spawn initiated before close is removed and its absence confirmed before release completes;
  - a failed removal of that spawn stays fenced;
  - positive control;
  - lock loss refuses the old gate's `assert`;
  - witness lock loss cancels signing.

**`test/root-ownership-lifecycle.test.mjs`**: r3 O1–O8, now awaiting the completion. It also checks the r4 forwarded-write guard and that read-only reconciliation stays available.

Expected to be compatible but **not verified**: root's `ownership-terminal-root-r3/test.mjs` (3), root's journal-lifetime 6, author7 7b, and completion C6/C7.

## Remaining integration requirements (not done, not waived)

- **Harness wiring.** Root's harness must:
  - copy `test/root-async-ownership-r4.test.mjs`, plus `test/helpers/lifecycle-fixture.mjs` as `test/helpers/ownership-fixture.mjs`, into the native tree;
  - overlay `owned-durable-state.mjs`, `lifecycle-host-owned-authority.mjs` and `runtime-lock.mjs`;
  - re-derive every generated-output hash (permit generator outputs changed);
  - apply root's own pins, guards and exact counts.

  The complete original 93+8 harness was not rebuilt in this run.
- **A staged instance whose spawn and readiness both finished before close** is not tracked as a gate resource until `serve` calls `track`. Release fences its boundaries (`hold`), but the compute stays until an explicit Stop.
- **`serve()` has no owned-operation registration.** It relies on `install`/`track`/`assert` refusing and on the awaited resource callbacks.
- **Witness close** aborts and refuses but does not await settlement of in-flight work.
- **Lock loss** is detected on use, not by an asynchronous watcher.
- **Not addressed in this run:**
  - the post-canonical inventory-await adoption race in the dispatch (dispatch generator unchanged);
  - an actual hardware deadman;
  - production Base authority and chain reader;
  - guestd/ingress/storage/secret enforcement;
  - prelisting capacity, sponsor, Offline funding and autofill;
  - live migration.

No contracts, deployments, financial requests or production changes were made.
