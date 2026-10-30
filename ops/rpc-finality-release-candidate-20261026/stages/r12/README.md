# base-finality-proof-stage/r12: the ONE final composition (PREPARED; qualification PENDING; NOT installed; NOT activated; productionActivated=false)

= frozen r11 (r10 + r10-ops-followup-r2 + r10-forward-log-fix + r10-capture-fixture-fix + r10-recovery-fixture-fix-r2; never run, superseded)
+ the narrow installer fixture fix for root run 0728 (late-config test accounts explicitly for the retained install journal and its parents)
+ r12 installer qualification strings + the corrected L1 checkpoint expiry (2026-11-01T19:22Z, slot-bound). No other product change.
Jobs: `jobs/root-r12-installer-18.sh` FIRST, then `tools/assemble_bundle.py`, then `jobs/root-finality-r12-tests.sh`.
`COMPOSITION.tsv` names every file's origin (r11 copy, r11 + `integration-r12/*.patch`, or new); the job re-verifies r12 AND r11's own composition.
Report: `../../logs/claude-finality-r12-result.md`.
