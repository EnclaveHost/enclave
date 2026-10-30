# accepted-image-enrollment-stage/r6 provenance (prepared; NOT run by Claude)

**Tree `e72ebae2d022fd7550c9753c86f26c894bf77e91`** = r5 `18c080af` (frozen, SUMS `89a0f926…`) + `patches/accepted-image-enrollment-r6-vs-r5.patch` (2 test files, +96/−59).
- I reproduced it from the full chain in a clean repo.
- **No production source changes:** the role, replica, adapter and KVM r3 are identical to r5.

**Cause** (`inputs/claude-enrollment-r6-failures.md`; root 1435 TAPs and verdict in `inputs/root-1435/`):
1. **The composition stand-in passed `relayChain: { client: {} }`.** The real adapter's `createDerivedWriterAuthority` requires a deny-only verifier client, so every derived start died after KVM's enrollment.
   - **Fix:** a client whose three calls all throw. It can never confirm anything.
2. **The suites used `leader()`** (a primary with a running relay) where the primary was needed. An enrollment quiesces and restarts the relay.
   - **Fix:** `primary()` / `prim()` / `live()`.

**Added:**
- the stop-with-a-commit-in-flight test (review item 7);
- role and stand-in fatal logs in `$L` via `AIE_ROLE_LOG_DIR` (task-specific).

**Counts:** role 19, composition 6, replica 8, KVM unit 22 (+ the full 65 in check).

**Job:** `jobs/root-accepted-image-enrollment-r6.sh` (slice / check / image). It never sets HOME, CODEX_HOME, TMPDIR or TEST_TMP.
