# base-finality-proof-stage/r11: the ONE final composition (PREPARED; qualification PENDING; NOT installed; NOT activated; productionActivated=false)

= frozen r10 + r10-ops-followup-r2 (journal-aware reproof capture retention, installer: configs never replaced + `runtime-dirs`, their tests)
+ r10-forward-log-fix (forward_sync unique exclusive log names + its test) + r10-capture-fixture-fix (test) + r10-recovery-fixture-fix-r2 (test).
Installer qualification strings are r11. `COMPOSITION.tsv` names every file's origin; `jobs/root-finality-r11-tests.sh` re-verifies it.
`bundle/` is assembled by `tools/assemble_bundle.py` (excluded from `SHA256SUMS`, every entry sha-pinned in `install/MANIFEST.json`).
Report: `../../logs/claude-finality-r11-result.md`. Install / runtime dirs / activation order: that report and `install/MISSING.md`.
