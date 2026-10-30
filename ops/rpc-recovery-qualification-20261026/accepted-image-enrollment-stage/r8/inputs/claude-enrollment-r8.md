# Enrollment r8: diagnosis of root 1457's r7 slice (EARLY; source only, not run by Claude)

**Evidence:** `accepted-image-enrollment-stage/r7/runs/20261026T163100Z-slice-2026124` (terminal).

| suite | result |
|---|---|
| KVM r3 unit | **22/22** |
| real-KVM composition | **6/6** |
| replica exactness | **8/8** |
| role suite | **18/19** |

**The one failure:** role test 15, "stop with a commit IN FLIGHT", timed out in its precondition, "written, awaiting the majority (false)". The role never wrote the test's bytes.

## Root cause: test isolation between M3 (test 14) and test 15; the role behaved correctly
1. **M3 leaves the stand-in's committer FENCED, as designed.** M3 makes the role's replica `commit` reject, so the child's commit is outcome-unknown, and `relay/derived-state-commit.mjs` fences that committer for the life of the process. M3 never restarted that child.
2. **M3's patch was too broad.** It replaced `node.commit` for every caller, including the replica's own heartbeat ticks (`commit({heartbeat:true})`). The lease could not be renewed: `enrollment-role-1.log` shows "step down (the lease could not be renewed)" at 16:32:35.029, about 0.4 s after M3 ended. The group was then re-electing while test 15 ran.
3. **Test 15 reused the fenced child.** Its `/commit` was refused inside the child (`derived_commit_fenced`) **before any IPC**, so the role correctly wrote nothing. The precondition "the role has written the bytes" then timed out after 5 s.
   - This is the intended fail-closed behaviour of a fenced committer, not a role defect.

## r8 fix (test-only; minimal; no assertion weakened)
- **M3:** inject the rejection ONLY for the calls under test (the role's derived commit and the barrier: `commit()` without `heartbeat`). The replica's heartbeat and fresh-scan rounds keep the real `commit`, so M3 no longer ends the lease.
  - At the end, M3 restarts the child and asserts the new child's committer is unfenced (fresh).
  - The M3 assertions are unchanged: outcome-unknown, barrier `ok:false`, zero unhandled rejections.
- **Test 15** is self-contained: it starts from a restarted child, and asserts the committer is unfenced before the in-flight commit. A fenced committer would make the test fail rather than silently pass.
- **Regression:** the precondition is asserted explicitly (`/status` of the stand-in is null or unfenced). The exact-bytes, in-flight, seed and every-member assertions are unchanged.
- **Harness:** explicit test-file discovery (each suite is named) and no HOME/CODEX_HOME/TMPDIR/TEST_TMP. Counts are unchanged: role 19, composition 6, replica 8, KVM 22 (+65 in check).
- **No runtime change since r5:** B1/B2, private-IPC durability, restart recovery, floor monotonicity and admin controls are all untouched.
