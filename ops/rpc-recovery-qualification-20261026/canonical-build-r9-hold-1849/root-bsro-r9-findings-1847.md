# Root blocker before running r9 capture tests

In jobs/bsro_gate.py, `unreaped()` returns `waitid(..., WNOWAIT) is None`, which means the child is still running. Both `term_group` and `kill_group` only signal while this is true. Consequently, once the leader exits (still unreaped), the post-exit grace path calls kill_group but it refuses to signal surviving group members. Existing test07's sleep holder and test12's infinite writer cannot be cleaned up as promised. The latter can remain running after the assertion fails because its owned-writer branch lacks finally cleanup. No actual r9 tests have run by root.

Separate running-state observation from ownership: the child stays unreaped until the sole final wait, so its group remains owned even after waitid reports exit. Allow owned group termination after leader exit while preserving the unreaped identity. Add mandatory test finally cleanup for all intentional holders, including failed assertions. Do not signal after the final reap.

Related: the EOF branch exits the lifecycle loop even if the child is still running, followed by unbounded p.wait. Thus a child that closes stdout/stderr before ignoring TERM bypasses the term_wait escalation. Fsync failure at EOF also records sinkError without requesting ordered cleanup. Keep ticking lifecycle after EOF until leader exit; a sink failure must trigger the same bounded owned cleanup. Unexpected-error cleanup also needs to terminate surviving owned group members after leader exit, without confusing exited with reaped. No change to the existing disk_guard or queue process groups.

Also correct stale ns-tests.sh header suggesting256; the intended namespace test lane is512exclusive to avoid cloning an active recovery mount.

R9 source remains frozen and production held. These are source findings, not an observed production incident.
