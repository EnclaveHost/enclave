# Replica exactness + role cross-child lock: independent read-only review of accepted-image-enrollment-stage/r3 (2026-10-26)

**Scope:**
- Read-only source analysis. I ran no tests, builds, queue jobs, network or live actions, and made no commits or edits to stage or KVM files.
- **Stage checked:** `r3/SHA256SUMS` = `27a9288b…` (`sha256sum -c` OK). Tree **f0ba957eaa63b004e04e66f712c68c26f7bdf545** reproduced exactly in private `/tmp`, using the job's own recipe. Every step matched: r1 `5052bd58`, r2 `c0a5f4e4`, r3 `59e11251`, e1 `583f2d7c`, e2 `d9a70025`, KVM r2 overlay `9c9cae75` (KVM SUMS OK), new `f0ba957e`.
- **Line numbers below are in that tree.**
- **r4 applicability:** `accepted-image-enrollment-stage/r4/patches/accepted-image-enrollment-r4-vs-r3-kvm3.patch` changes only `metal/guest/derived-state.mjs` and tests. It touches neither `relay/state-replica.mjs` nor `metal/guest/platform-api-role.mjs`, so **every role and replica finding below applies to r4 unchanged**. I did not review r4 further.

## Strengths (verified)
- **Catch-up snapshot fix is correct:** `readAllExact` (`relay/state-replica.mjs:85-93`) re-reads every scanned file and refuses on any sha change or vanish. `_commitOnce` (`:357-361`) then sends no snapshot, and that member's answer is not counted. A file written during the append round's await can no longer travel under an older head.
- **Acknowledgement rule:** acks count only with `ok` and an exact `head` echo (`:368`). Stale or behind answers force step-down (`:363-366`). `index = scan` only after a majority (`:373`). Heartbeats (`moved=false`) use `head = base`, so a catch-up during a heartbeat ships the current scan under the current head.
- **In-process writers are serialized.** These all scan and diff synchronously at the start of `_commitOnce` (`:349`), before any await:
  - `writeStateFile` under the derived lock;
  - credentials (`.tmp` + rename);
  - enrollment and marker writes.
  
  An in-process write during a commit's await lands in the next commit's scan.
- **Role commit outcomes** (`platform-api-role.mjs:321-350`):
  - `refused` is returned only before any write (deadline, not current child, not primary, not enrolled).
  - After the write, a failed or false commit, an epoch change or a byte mismatch gives `unknown`.
  - The child committer (`relay/derived-state-commit.mjs:26-80`) fences on refused, unknown, timeout, abort or IPC disconnect, and ignores late or duplicate replies.
  - **No deadlock found:** the child's death never depends on the lock (always SIGKILL), and barrier commits do not take the derived lock.
- **Locks:** `seedDerivedState` (`derived-state.mjs:199-225`) keeps every `*.lock` and removes only working files. KVM's `takeRuntimeLock` holds a never-unlinked flock on the parent's open file description (`network/runtime-lock.mjs`), released when the relay dies. KVM reaps orphaned helios/native children by recorded identity under `runs.lock` (`provider.mjs:332-345`, `process.mjs:24-56`).
- **No public fallback:** `ENCLAVE_DERIVED_INTENDED` disables the lease reader and selects the refusing authority (`relay/api-relay.js:2543-2551`). The 120 s writer ceiling and admin controls are unchanged.
- **API check:** `declaresDerivedStateApi` requires KVM's exported `DERIVED_STATE_API === "enclave-derived-state/v1"` (`provider.mjs:19`) plus all 5 functions.
- **Descriptor and IPC:** both are JSON.stringify or structured IPC; paths are fixed and canonical-checked. I found no JSON or env injection.

## Defects (precise; minimal fixes)
**B1 (blocker, safety): the seed proceeds when the previous child has NOT exited.**
- **Where:** `platform-api-role.mjs:256`, `await Promise.race([lastExit, new Promise((r) => setTimeout(r, 10000))]);`, then `seedDerivedState` runs unconditionally (`:257`).
- **Failure scenario:**
  1. A SIGKILLed relay stuck in uninterruptible I/O past 10 s still holds KVM's flock and may still `strictWriteFile` its `derived-state.json`.
  2. The seed removes and rewrites that file under the old live owner.
  3. The new child's KVM then gets "stateDir is in use" (flock exit 73), exits, and the crash guard counts it as an unexpected exit.
- **Fix:** if the timeout wins, return `{ env: INTENDED, reason: "the previous relay has not exited" }` and seed nothing. Retry on the existing restart path.

**B2 (blocker, safety): no term re-check after that wait.**
- **Where:** `sameTerm(fresh.epoch)` and the local-bytes check run at `:252`, BEFORE the up-to-10 s await at `:256`. Seeding uses `held` from the old fresh scan.
- **Failure scenario:**
  1. During the wait, leadership is lost and regained.
  2. Another primary commits derived progress in between, and this member re-adopts it as the most advanced head.
  3. The child is still seeded with the older committed journal.
  4. Its later commits fork from a stale prefix and can overwrite a newer committed reader journal: a floor regression.
- **Fix:** immediately before `seedDerivedState`, repeat the `:252` checks (`sameTerm(fresh.epoch)` and `DS.readState(dataDir, fresh.scan)` digest and stateDigest). Better: also require `node.index` to still equal `fresh.scan` for the derived files.

**M1 (replica exactness, cross-process): the append path ships unverified bytes.**
- **Where:** `diffDir` (`state-replica.mjs:78-83`; read at `:80`) re-reads changed files without comparing them to the scan's sha. `_commitOnce` (`:349`) is synchronous only within the role process.
- **Failure scenario:** the relay child is a separate process writing in `dataDir`. A write between `scanDir`'s read and `diffDir`'s read sends new bytes under head H while `index` records the old sha.
  - It is self-healing for the child's own files, because the next scan sees a new mtime.
  - It is still exactly the "new bytes under an older scan" condition `readAllExact` fixed for catch-up.
  - A torn non-atomic write can also be shipped. That part is pre-existing.
  - Derived files are not exposed: only the role writes them, atomically, under the lock.
- **Fix:** have `diffDir` verify `sha256(bytes) === after.get(rel).sha`, throwing `changed` (as `readAllExact` does). In `_commitOnce`, catch it, re-scan up to N times, otherwise return `false` WITHOUT sending (outcome: nothing sent).

**M2: the election epoch snapshot uses non-exact `readAll`.**
- **Where:** `state-replica.mjs:326`, `readAll(this.dir, this.index = scanDir(…))`.
- It is synchronous in-process, but a killed-but-not-yet-dead previous child on this member could write between the scan and the read.
- **Fix:** use `readAllExact(this.dir, scan)`; on `changed`, abandon the campaign (`_stepDown`/return false).

**M3: commit rejection is unhandled in the role callers.**
- `_commitOnce` can reject: `diffDir`'s `readFileSync` throws if a file vanished between scan and diff (child deletion), and `_ask` can throw from `sealMessage` on an oversize message, which happens before its try.
- **Callers that do not catch it:**
  - `derivedCommit` (`role:338`): no reply, so the child times out to `unknown`. That is correct for the child, but it causes an unhandled rejection in the role. The bundle logs these (`platform-api.bundle.mjs:69398`), so the role does not crash.
  - The barrier (`role:297-298`): `Promise.resolve(node.commit()).then(…)` sends no barrier reply on rejection. This is pre-existing.
- **Fix:** catch inside `_commitOnce` and return `false`, so all callers see a plain failure.

**M4: the documented crash-guard backoff never fires on its own.**
- **Where:** `derivedDisabled.until` (`role:306`) is only consulted in `derivedPlan` (`:246-248`), at the next relay start. Nothing restarts a healthy non-derived relay when `until` passes. Progress cannot occur either, because without a derived child nothing commits derived state.
- **Effect:** the "retry after 60 s doubling to 1 h" claim (r3 report, role comment `:216-218`) is unimplemented. Derived stays off until a failover, credentials change, crash, or a new admin enrollment. This is liveness only; it fails closed.
- **Fix:** schedule one `unref` timer at `until` that, if still primary, the current child is non-derived and the same `derivedDisabled` record holds, calls `stopRelay("derived retry"); startRelay()`. Otherwise, correct the docs.

**L1: the API string does not distinguish KVM r2 from r3 semantics.**
- Both declare `enclave-derived-state/v1`. The role passes `enrollmentFloor` and r3 provider fields to whichever runtime is built.
- It fails closed today: KVM r2 refuses rotate/recover ("rotation/recovery unsupported").
- **Suggestion for root/KVM:** a capability or version field for carry-floor support, checked by the adapter.

## Untested conditions (meaningful)
1. **B1:** the previous child alive past the wait (e.g. a stand-in that ignores exit, or a stubbed `lastExit` that never resolves). Must not seed, must not remove `derived-state.json`, and must keep the lock inode.
2. **B2:** leadership lost and regained (another primary committing derived progress) during the pre-seed wait. The seeded bytes must equal the NEW committed scan.
3. **M1:** a CROSS-PROCESS writer racing `scanDir`→`diffDir`. Not reachable by r3's unit test (`test/derived-state-enrollment.test.mjs:555-563`) or by r4's new `test/state-replica-exact.test.mjs`, which states "members in this process … driven by hand". In-process interleavings cannot hit a window that is synchronous within one process. A test needs an injected `readFileSync`/`diffDir` hook or a writer child process.
4. **M3:** `node.commit()` rejecting inside `derivedCommit` and the barrier. Expect no unhandled rejection, the child `unknown`, and a barrier reply `ok:false`.
5. **M4:** the backoff expiry with a healthy non-derived relay. Expect derived to be retried, or the docs to say it is not.
6. **Locks:** seeding keeps `journal/derived-state.lock`, `coverage/<binding>/coverage.lock` and `runs/runs.lock` with the same inode. No test asserts this.
7. **Stop with a message in flight:** a `derived-commit` already holding the lock (written, awaiting `node.commit()`) when `stopRelay` SIGKILLs the child. Expect the commit to finish, a reply to the dead child harmless, and the next seed (queued behind it) to include it.

## Not issues (checked)
- **Deadlock:** none between the actor awaiting the lock and the child's exit. Children are SIGKILLed, a queued `derivedCommit` for a dead child refuses `not_current_child`, and `freshCommittedScan` does not take the derived lock inside `node.commit`.
- **Commit continuation:** after `await node.commit()` (`role:338-343`), `node.index` and `node.head` are those of that commit. The continuation runs before any next chained `_commitOnce`.
- **Orphaned KVM grandchildren** after a relay SIGKILL are KVM's to reap (identity-checked) at the next start.
