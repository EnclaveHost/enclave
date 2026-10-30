# postdelete-bitmap-stage/r1 (PREPARED by Claude, SOURCE ONLY; nothing run by Claude)
Bounded OFFLINE post-deletion block-bitmap reuse checker for the deleted Base DB inode 1950053 (old gen 3326586236).
Uses ONLY the local journal copy logs/base-journal-copy-1626/journal-8.bin (d95d81fc...) + fs-stats.out + candidate-extent-coverage.json,
all pinned in case/base-1626.json. Authentication = the frozen JBD2 runtime jbd2_verify.py (byte-identical to
journal-recovery-verifier-stage r1 and r3, sha d3cfa34e...; checked before exec and by both jobs).
Method, verdicts and LIMITS: see the docstring of postdelete_bitmap.py and logs/claude-postdelete-bitmap-1659.md.
Root order (queue 512):
  1. bash jobs/q-exit-status.sh pdb-r1-tests 512 unshare -Urn bash postdelete-bitmap-stage/r1/jobs/tests.sh      # expect "## PASS (12)"
  2. bash jobs/q-exit-status.sh pdb-r1-check 512 unshare -Urn bash postdelete-bitmap-stage/r1/jobs/root-check.sh # refuses without a passing receipt
rc of 2: 0 NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY / 4 REUSE_OBSERVED / 5 BLOCKED / 3 refused / 9 precondition.
NO verdict is a recovery acceptance. No reuse observed != intact bytes (discard/TRIM, image layer, intra-transaction alloc+free).
