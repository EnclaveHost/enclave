# composite-mdbx-validation-stage/r7: gated PRODUCTION entry for the qualified r6 runtime (PREPARED by Claude 1802; NOT run)
Report: ../../logs/claude-composite-production-gate-1802.md. r1–r6 are unchanged, including their failed and passed runs.

**What it reuses, unchanged:**
- the r6 runtime `composite_session.py` (`407aa7e9…`);
- the r6 guard and stop helper (`../r6/jobs/common.sh`, `../r6/jobs/stop-session.sh`);
- the r6 view importer (through the r6 runtime's own pinned loader).

**`production_gate.py` (new) checks, each fail-closed:**
1. the r6 stage files and SUMS `06705b02…`;
2. the EXACT r6 fixture qualification receipt (sha `c94c4689…`), plus strict fields: Ran 4 + Ran 12, rc 0, no FAIL/ERROR/skip/ResourceWarning, every check true, clean environment, qualified hashes;
3. the 2560 MiB queue cgroup and the 16 GiB floor plus headroom;
4. the REAL production view: importer `load_view(production)` + `recheck` (all 265 parts committed and independently verified in CONFIRMED sessions), manifest `f94807f7…`, 1,138,166,333,440 bytes, 265 parts.

Only then does it `exec` the r6 runtime with `--expect-kind production`.

**Launching:**
- **Gate tests:** `bash jobs/q-exit-status.sh cmv-r7-gate-tests 256 bash composite-mdbx-validation-stage/r7/jobs/tests.sh` → `## PASS (6)`. These are tiny gate tests; the r6 lifecycle is not re-run.
- **Production:** MANUAL ONLY, after all parts are complete: `bash jobs/q-exit-status.sh cmv-r7-prod 2560 bash composite-mdbx-validation-stage/r7/jobs/root-composite-validate.sh VIEW_DIR MAX_HOURS`.

**What CLEAN means:** structural only (mdbx_chk). Canonical, state and trie validation is separate, and fixtures never constitute a production acceptance.
