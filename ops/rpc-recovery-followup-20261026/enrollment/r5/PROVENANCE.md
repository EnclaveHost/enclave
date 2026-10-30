# accepted-image-enrollment-stage/r5 provenance (prepared; NOT run by Claude)

**Tree `18c080afd23bc6676cef7e452b0e832bea943e89`** = r4 `f1a8216a` (frozen, SUMS `6061969b…`; composed with FROZEN KVM r3 `14656ef5…`) + `patches/accepted-image-enrollment-r5-vs-r4.patch` (4 files, +249/−35). I reproduced it from the full chain in a clean repo. No KVM module is changed.

**Fixes for `inputs/claude-replica-enrollment-r3-review.md`:**
- **B1:** a seed and its compose happen only after the previous child's exit is CONFIRMED.
  - **On timeout (`derivedExitWaitMs`, 10 s):** refuse with no compose and no seed (the relay runs without derived), then retry once that exit is confirmed.
  - **What the seed keeps:** every `*.lock`.
- **B2:** IMMEDIATELY before seeding, with no await in between: the same primary and epoch with a valid lease, `node.index` derived entries equal to the fresh scan's, and the local bytes equal to that scan. Otherwise refuse and log.
- **M1:** `diffDir` ships exactly the scanned bytes. A file another process rewrote makes the commit re-scan (up to 3 times), then a plain `false` with NOTHING sent.
- **M2:** the election snapshot, follower `fetch` answers and archives use `readAllExact`. On a change: no epoch, a refused fetch, or a skipped archive round.
- **M3:** `ReplicaNode.commit()` never rejects; an unexpected failure gives `false` and a step-down. The role's derived-commit, verify and barrier paths catch too.
- **M4:** a real backoff timer restarts a healthy relay running without derived when `derivedDisabled.until` passes.
- **Testability:** ReplicaNode `readFile` and role `spawnImpl`/`derivedExitWaitMs` hooks. They default to production behaviour.

**Tests:**
- `test/state-replica-exact.test.mjs`: 4 → **8**. Adds a forced read race, a REAL cross-process writer, an election snapshot race, and the never-reject case.
- `test/derived-state-enrollment.test.mjs`: 15 → **18**. Adds B1 (no seed, lock inodes kept, retry on exit), B2 (term lost in the wait), M3 (IPC rejection), and M4 inside the crash-guard test.

**Job:** `jobs/root-accepted-image-enrollment-r5.sh`, with modes `slice` / `check` / `image`. It never sets HOME, CODEX_HOME, TMPDIR or TEST_TMP.
