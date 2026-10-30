# Enrollment r5: fixes for the replica/role review (B1, B2, M1–M4) (source only; NOT run by Claude)

**Stage:** `accepted-image-enrollment-stage/r5/`, `SHA256SUMS` sha256 **89a0f926b489665145fb41673fb1c87ec35b4f996c173c4699711682b51024e2**.

| file | sha256 |
|---|---|
| `patches/accepted-image-enrollment-r5-vs-r4.patch` | `4b85e68e…` |
| `jobs/root-accepted-image-enrollment-r5.sh` | `561f17b3…` |
| `jobs/kvm-overlay.py` | `90c579ab…`, unchanged |

- **Tree:** **`18c080afd23bc6676cef7e452b0e832bea943e89`** = r4 `f1a8216a` + the patch. I reproduced the full chain (`f0ba957e` → `f1a8216a` → `18c080af`) in a clean repo.
- **Left alone:** r4 still verifies (`6061969b…`). KVM r3 (`14656ef5…`) is unchanged; no KVM module is edited.
- **Not done:** no tests, builds, queue, live actions or commits.
- **Main retention stopped** (15:53:59, memory guard): nothing here assumes anything live.
- **No runtime activation.**

## Fixes (review: `logs/claude-replica-enrollment-r3-review.md`, applied to r4)
- **B1: seed only after the previous child's exit is CONFIRMED** (`platform-api-role.mjs` `derivedPlan`).
  - **Wait:** the plan waits up to `derivedExitWaitMs` (10 s) for the previous child's `exit` event. `error` counts too, meaning it never started.
  - **On timeout:** `{ env: INTENDED, reason: "the previous relay has not exited: nothing is seeded" }`. **Nothing is composed or seeded**, and the relay serves without derived.
  - **Retry:** a promise on THAT exit retries derived once it is confirmed. It is ordered after the non-derived spawn, so neither order of the two events loses the retry.
  - **Order:** `composeDerivedReader` now also runs after the confirmed exit, because it rewrites `derived-reader/`. The seed still keeps every `*.lock`.
- **B2: recheck IMMEDIATELY before seeding** (no await in between):
  - `sameTerm(fresh.epoch)`: the same primary and epoch, with a valid lease;
  - `node.index` derived entries equal to the fresh scan's (`sameDerived`);
  - `readState(dataDir, fresh.scan)` equal in digest and stateDigest.
  
  Otherwise refuse, with the log line "derived start refused: the committed view changed while starting".
- **M1: exact cross-process append** (`relay/state-replica.mjs`):
  - **`diffDir`** reads each changed file through `readExact`, which requires sha256(bytes) to equal the scan's entry. ENOENT means `changed`; any other error propagates.
  - **`_commitOnce`** re-scans on `changed` up to `scanRetries` (3) times, then returns `false` having **sent nothing** (no step-down; the lease stands).
  - **Limit:** a torn non-atomic write whose torn bytes were themselves scanned is still shipped as scanned. That is pre-existing, the scan is the truth, and the role writes atomically.
- **M2: exact election snapshot.** `campaign` uses `readAllExact` on its scan; on `changed` it steps down with no epoch opened and nothing sent. Also exact:
  - follower `fetch` answers: `readAllExact(index)`, otherwise `{ok:false}`;
  - archives: the committed index's exact files, otherwise the round is skipped and logged.
- **M3: commits never reject.** `ReplicaNode.commit()` catches: an unexpected failure is logged, the member steps down (the outcome is unknown, since members may hold part of the round), and it returns `false`.
  - **Role belt-and-braces:**
    - `await node.commit().catch(() => false)` in the fresh scan, derived commit and enrollment;
    - the barrier answers `ok:false` on rejection;
    - the IPC handlers run under `Promise.resolve().then(...).catch(log)`.
- **M4: a real backoff timer.** On every disable, `scheduleDerivedRetry` arms one `unref` timer at `until`. If still primary, still the same record, and the current child is not derived, it restarts the relay. The plan then allows the same enrollment because `now ≥ until`. The "60 s doubling to 1 h" claim is now implemented.
- **Testability hooks** (production defaults unchanged): ReplicaNode `readFile`, `scanRetries`; role `spawnImpl`, `derivedExitWaitMs`.
- **Unchanged:** every floor rule, the fixed 120 s writer ceiling, admin controls, no reset, the actual KVM r3 composition, and the never-enrolled-archive strict refusal.

## New tests (exact counts; no widening)
**`test/state-replica-exact.test.mjs`: 4 → 8.**
- **M1, forced read race:** the leader's file read is hooked to rewrite the file (via rename) between the scan and the diff read, as another process would.
  - **One race:** re-scan, then commit; the committed scan equals the shipped bytes, and every member holds exactly the index.
  - **Persistent race:** `false` with **no member seeing the round** (heads unchanged), and the leader keeps its lease. The next clean commit is exact.
- **M1, REAL cross-process writer:** a separate `node` process loops atomic renames for 1.5 s while the leader commits repeatedly. Every result is `true`/`false` (never a rejection), and afterwards every member holds exactly the committed scan.
- **M2:** a candidate whose epoch snapshot changed under its scan opens no epoch, and the other member's head and files are unchanged.
- **M3:** an injected EACCES read inside a commit gives `false` and a step-down, with **zero unhandled rejections**.

**`test/derived-state-enrollment.test.mjs`: 15 → 18.**
- **B1:**
  - **Setup:** a role-initiated stop + start (a signed rotate) while the SIGKILLed child's `exit` is not yet observed (the `spawnImpl` stand-in delays the real child's exit event by 6 s, more than the 3 s wait).
  - **Assertions:** reason "has not exited"; the relay serves with only `ENCLAVE_DERIVED_INTENDED`; the RAM anchor journal, `derived-reader/state.json` and **all four lock files keep inode and mtime**; then, once the exit fires, the role retries by itself; the locks are still the same inodes, and the seed equals the committed bytes.
- **B2:**
  - **Setup:** a rotate restart whose exit is confirmed after 2.8 s (within the 3 s wait), while the primary is partitioned and loses its term.
  - **Assertions:** the role logs the refusal; the deposed member's RAM journal is not touched; the new primary seeds exactly its committed scan.
- **M3, IPC rejection:** the replica's `commit` is patched to reject. The child's commit is `derived_commit_outcome_unknown`, the relay barrier gets `ok:false` (new stand-in `/barrier`), and there are zero unhandled rejections.
- **M4** (inside the crash-guard test): with `derivedRetryMs` 4 s, a disabled enrollment comes back **by the timer alone**, with the same enrollment digest and no admin package. The log carries "derived retry: the backoff".
- **Composition suite (real KVM r3):** 6, unchanged.

## Harness (`jobs/root-accepted-image-enrollment-r5.sh`)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh aie-enroll5-slice  256 unshare -Urnm bash accepted-image-enrollment-stage/r5/jobs/root-accepted-image-enrollment-r5.sh slice
bash jobs/q-exit-status.sh aie-enroll5-check 2560 unshare -Urnm bash accepted-image-enrollment-stage/r5/jobs/root-accepted-image-enrollment-r5.sh check
```
- **Composition:** r4 composition → `f1a8216a` (checked) → r5 patch → `18c080af` (checked).
- **Exact counts:**
  - slice: KVM unit 22, composition 6, replica 8, role 18;
  - check: those, plus KVM 65 + native and the rest as in r4.
- **Environment:** the job **never sets or exports HOME, CODEX_HOME, TMPDIR or TEST_TMP**. `env -i` children get only PATH and task variables. The scratch is the run's own `$OUT`, and test processes use the system temporary directory (they clean up).
- **Risk to watch:** if a suite silently needed the r4 job's HOME override (`api-relay.js` startups, the foundry-backed relay group), it now fails visibly rather than the job inventing a HOME.

## Remaining (plain)
- **Not exercised:** stop with a message already in flight (review untested item 7).
  - **Behaviour by source:** the commit finishes under the lock, the reply to the dead child is harmless, and the next seed (queued behind it) includes it.
  - **Status:** no dedicated test.
- **L1 (suggestion):** the API string does not distinguish KVM r2 from r3. It fails closed (r2 refuses rotate/recover); a capability field is for KVM and root to decide.
- **Unchanged blockers:**
  - a never-enrolled restored group has no recovery path (a separate admin follow-up);
  - writer authority stays `stale_snapshot` under the fixed 120 s ceiling;
  - co-located members are not a quorum;
  - there is no live reader start and no SNP.
- **Root runs** slice, then check.
