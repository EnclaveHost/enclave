# r9: ONE Windows chain authority - consumer e4f507d6b + owner CLI b6ac5d657 composed with route's verified reads (private; nothing run)
Candidate `refs/r9/candidate` in the private `src.git` (alternates -> frozen r3 objects), parents r8 partial 8fdf00d0 + b6ac5d657.
`tools/build-r9.py` (deterministic) -> `R9-RESOLUTIONS.json` (per file: result blob, r8 blob, rationale). Runner
`jobs/r9-build-validate.sh` (= r7 runner + owner-CLI component + REGRESSIONS.txt phase + INTENTIONAL-CHANGES markers +
recomputed DEPGRAPH.json); stack tests in `stack-tests/` (r7's, unchanged).
