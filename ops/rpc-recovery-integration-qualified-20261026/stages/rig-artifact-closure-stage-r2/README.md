# rig-artifact-closure-stage/r2 (PREPARED; nothing run; runner correction only)

**Frozen and untouched:** the original stage (`../SHA256SUMS`), MCP r6, the active r12 job, and the lease-fixture job 29692.
**No product code** is added.

**Files:**
- `jobs/root-r12-impacted-rerun.sh`: the original runner plus three corrections;
- `runner-r1-to-r2.diff`: the exact diff;
- `SHA256SUMS`.

## The corrections

1. **Heartbeat negative control.**
   - `test/offchain-heartbeat-writers.test.mjs` test 2 skips unless `OFFCHAIN_HEARTBEAT_BASE_SUPERVISOR` names "the patch's base
     supervisor.js (a file in the repository root)" (test lines 25 and 86).
   - The patch is `6f2c7da466dc26e5f7aac88c574a6b807e1a03df`, which added the test. Its parent's `supervisor.js` is blob
     `3ad766906ea1dc34dc6b8010370b15ee7d47b6da`.
   - For each PRIVATE COPIED tree that reruns this test, the runner checks `6f2c7da46^:supervisor.js` is that blob, writes it
     with `git cat-file` as `supervisor.base-6f2c7da46.js` at the copy's root, and checks it with `git hash-object`. This happens
     after the build and tracked-file gates.
   - The env var is set for that test's command only, and the same 3/3, 0-skip requirement against the r12 receipt applies.
     Production source is never altered.
2. **Exact row shapes.**
   - Component and REGRESS rows have 5 fields; STACK and NATIVE rows have 3. NATIVE rows (F2, `CHAIN_VERIFIER_INPUTS`) are never
     artifact rows: they keep their verdict, `ok` only for `rc 0 OK`.
   - An unknown shape is HOLD.
   - An adapted `ok (…)` row counts as ok.
   - The original would have crashed (IndexError) on a 3-field NATIVE row, and miscounted a clean NATIVE row as not ok.
3. **PATH:** `/home/steven/.foundry/bin:/usr/bin:/bin`. The runner asserts that `command -v forge` is the pinned forge
   (`4f77da08…`) and that anvil is the pinned one (`10c1c727…`), for the rigs' runtime forge builds.

**Unchanged:** the finite selection. A row is selected only if it is not ok, statically reaches the missing MockFeed (map), and
shows that ENOENT in its actual receipt. Unrelated rows are kept as they are, and nothing outside that selection is rerun.

**Out of scope:** the browser tests that deliberately fork public Base in the offline namespace are not selected, so they remain
**unqualified**. They must later run against our own historical backend. No expectation is changed or waived.
