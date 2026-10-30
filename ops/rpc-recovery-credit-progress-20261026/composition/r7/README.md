# r7: smallest source reconciliation of the r2 route-first-base defect + link gates (private; nothing run)
Candidate `refs/r7/candidate` c154f05c in the private `src.git` (alternates -> frozen r3/src.git objects; r3 untouched),
child of c4de37a3, 4 files (`R7-RESOLUTIONS.json`). Evidence: `ROUTE-LOSS.json` (tools/route-loss.py), `LINK-*.json`
(tools/link-check.py), `BUNDLE-LINKS-*.json` (tools/bundle-entry-links.py). Runner `jobs/r7-build-validate.sh` = r6 + the
r7 candidate + the bundle-entry link precheck + the post-regeneration link gate vs `LINK-BASELINE.json` + the new
`stack-tests/stack-windows-chain-reader.test.mjs`.
