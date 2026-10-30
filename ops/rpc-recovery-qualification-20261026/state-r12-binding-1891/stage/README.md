# state-helper-qualification-stage/r3: r2 with the bsro pins moved to frozen r12 (PREPARED by Claude 1884; NOT run; NOT PASS)
Report: ../../logs/claude-state-binding-review-1884.md. Frozen r2 (`SHA256SUMS` `70144b83…`; its 46 tests passed at
`runs/tests-20261027T103130Z-3084678` per root) and r1 are unchanged. r2's receipt does NOT carry over to r3.

**The only changes from r2:**
- the stage and script pins: `R12_STAGE_SUMS_SHA256` `2911943d…`, `R12_POSITIVE_SH_SHA256` `3ba41117…` and `R12_FIXTURES_SH_SHA256`
  `4cf3d582…`, plus `R12_MAIN_RS_SHA256` `5a6fa214…` (the Rust is byte-identical r11 → r12). They are used by `pins_errors`
  (`pins.stageSums`) and by `check_fixture_capture` (expected identities);
- the end markers `## bsro-r12-positive rc=0` and `## bsro-r12-fixtures rc=0`;
- the stage labels;
- test 37 now cross-checks the frozen r12 sources. It also asserts `## outputs $O` with `O=$WORK/out`, and that no `bsro-r11-` marker
  remains.

**Unchanged (by a normalised diff):** the report format and constants (`base-state-readonly/r11`, because the Rust is unchanged), the
schema, `derived_exit`, the production predicate, classification, the r2 P1–P4 evidence rules, the 26 labels and 6 cases, and
`## runs=26 failed=0` / `## fixtures failed=0`.

**Tests:** `jobs/tests.sh` requires exactly `Ran 46 tests`. Root runs:
`bash jobs/q-exit-status.sh sq-r3-tests 256 unshare -Urn bash state-helper-qualification-stage/r3/jobs/tests.sh`.

**Limits:**
- All functions are pure and every input is synthetic or caller-supplied.
- `check_fixture_capture` accepts ANY absolute `## outputs` path; the capture caller must bind it to `<run>/work/out` (review 1884).
- Nothing here is a compiled-fixture qualification, a state result, canonical proof, recovery acceptance or reset authority.
