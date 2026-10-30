# accepted-image-enrollment-stage/r8 provenance (prepared; NOT run by Claude)

**Tree `68245755168b13bb47041bce54ad5fb7cd0b89da`** = r7 `1cc32f1c` (frozen, SUMS `0daca3cf…`) + `patches/accepted-image-enrollment-r8-vs-r7.patch` (1 test file, +20/−10).
- I reproduced it from the full chain in a clean repo.
- **No production source change since r5:** role, replica, adapter and KVM r3 are unchanged.

**Evidence:** root 1457 (`inputs/root-1457/`): KVM 22/22, composition 6/6, replica 8/8, role 18/19. The failure was test 15's precondition (the role never received the commit).

**Cause** (`inputs/claude-enrollment-r8.md`): test isolation.
- M3 replaced the replica's `commit` for ALL callers (heartbeats included), so the lease was lost right after M3.
- M3 also left the stand-in's committer fenced (by design), and test 15 reused that child. Its commit was refused inside the child, so nothing reached the role.

**Fix:**
- **M3:** rejects only the calls under test (non-heartbeat commits), asserts the lease survived, and leaves a fresh, unfenced child.
- **Test 15:** starts from its own fresh child and asserts the unfenced precondition. The transport delay is always reset.

**Job:** `jobs/root-accepted-image-enrollment-r8.sh`.
- explicit suite discovery;
- counts: role 19, composition 6, replica 8, KVM 22 (+65 in check);
- never sets HOME, CODEX_HOME, TMPDIR or TEST_TMP.
