# Historical origin coverage and activation freshness

The frozen r2 implementation passed its 25 offline tests. Root then added a regression that demonstrated activation could accept stale segment evidence: it rechecked using the saved evaluation timestamp. The original failing result is preserved; r2 must not be deployed as-is.

The proposed corrected overlay rechecks every segment using the current activation time and rejects nonfinite, boolean or future evaluation timestamps. It normalizes only the evaluation timestamp for the exact historical-content comparison. Both new regressions passed, then all 27 tests (the original25 plus both regressions) passed with no skips or expected failures. This correction is saved under activation-freshness-fix; it is not installed and must be incorporated into the pending r3 wrapper/readiness integration before deployment.

The tests use synthetic local chains and pinned KZG tooling. They prove the tested origin-binding, segment completeness and refusal behavior, not actual production historical availability. Exact original checkpoint origin, real L1/blob coverage, current safe/finalized Base, positive native witnesses and SNP qualification remain unverified. Aggregate availability evidence is not consensus authority. Administrator controls are unchanged.
