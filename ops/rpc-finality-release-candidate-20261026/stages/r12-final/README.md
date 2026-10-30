# base-finality-proof-stage/r12-final: THE final composition (PREPARED; qualification PENDING; NOT installed; NOT activated; productionActivated=false)

= frozen r12 + root's r10-recovery-fixture-fix-r3 test + final installer qualification strings (`## finality-r12-final rc=0`, `## r12-final SHA256SUMS`).
No other byte differs from r12. ONE root job: `jobs/root-finality-r12-final.sh` (bundle assembly + every check + suites; command in its header).
`COMPOSITION.tsv` names every file's origin; the job re-verifies r12-final, r12 and r11 compositions and r10 identity. Immutable after freeze
(`bundle/` is assembled by the job, excluded from `SHA256SUMS`, every entry sha-pinned in `install/MANIFEST.json`).
Report: `../../logs/claude-finality-r12-final-result.md`.
