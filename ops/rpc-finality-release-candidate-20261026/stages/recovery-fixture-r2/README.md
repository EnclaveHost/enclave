# base-finality-proof-stage/r10-recovery-fixture-fix-r2 (PREPARED; nothing run by Claude). r1 + r10 frozen, untouched; no product change.
r1 run 1119222 ERRORed: its pre-read A.head_state touched the DB before gate_static (harness refuses ungated_db_access). r2 reads the frontier
only after the NORMAL A.gate_static(c, base) on the same Base (no bypass). Assertions identical to r1: exact anchored state_below_anchor
message with that frontier, no mutating/unwind Base.run during step_plan. Job: jobs/root-r10-recovery-fixture-fix-r2.sh (single test).
