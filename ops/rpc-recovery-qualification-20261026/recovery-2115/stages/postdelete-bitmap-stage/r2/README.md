# postdelete-bitmap-stage/r2 (PREPARED by Claude, SOURCE ONLY; nothing run by Claude)
r2 = frozen r1 with a FIXTURE-ONLY fix (root 1682: 5 FAIL; root 1683 repro): the synthetic unrelated bits OTHER=(0,10) overlapped 7
group-2 candidate bits, so the clean fixtures never freed them and the checker (correctly) blocked. OTHER is now (100,110); a new
test asserts disjointness and keeps the r1 overlap as a negative case (BLOCKED, 7 never freed, 7 reused at tid 14). 13 tests.
postdelete_bitmap.py, jbd2_verify.py and case/base-1626.json are byte-identical to r1 (both jobs cmp them).
Bounded OFFLINE post-deletion block-bitmap reuse checker for the deleted Base DB inode 1950053 (old gen 3326586236).
Uses ONLY the local journal copy logs/base-journal-copy-1626/journal-8.bin (d95d81fc...) + fs-stats.out + candidate-extent-coverage.json,
all pinned in case/base-1626.json. Authentication = the frozen JBD2 runtime jbd2_verify.py (byte-identical to
journal-recovery-verifier-stage r1 and r3, sha d3cfa34e...; checked before exec and by both jobs).
Method, verdicts and LIMITS: see the docstring of postdelete_bitmap.py and logs/claude-postdelete-bitmap-1659.md.
Root order (queue 512):
  1. bash jobs/q-exit-status.sh pdb-r2-tests 512 unshare -Urn bash postdelete-bitmap-stage/r2/jobs/tests.sh      # expect "## PASS (13)"
  2. bash jobs/q-exit-status.sh pdb-r2-check 512 unshare -Urn bash postdelete-bitmap-stage/r2/jobs/root-check.sh # refuses without a passing receipt
rc of 2: 0 NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY / 4 REUSE_OBSERVED / 5 BLOCKED / 3 refused / 9 precondition.
NO verdict is a recovery acceptance. No reuse observed != intact bytes (discard/TRIM, image layer, intra-transaction alloc+free).
