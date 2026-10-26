# base-finality-proof-stage/r10-recovery-fixture-fix (PREPARED; nothing run by Claude). Frozen r10 untouched; no product code or pin change.
Test-only correction of r10 tests/r7-ported/test_reanchor_recovery.py::Recovery.test_bounds_are_derived_never_widened
(integration/test_reanchor_recovery.patch): after execution is raised above N while Finish.partial_state_trie stays below N, r10's
harness step_plan refuses state_below_anchor (its order: execution, state frontier, stage checkpoints); the test now expects that EXACT
message (anchored, with the frontier read by the harness's own head_state) and asserts no mutating/unwind Base.run call. All other
assertions unchanged. Root job: jobs/root-r10-recovery-fixture-fix.sh. Report: ../../logs/claude-r10-recovery-fixture-fix.md.
A pass here is NOT an r10 overall pass; the test must be integrated in a final source stage.
