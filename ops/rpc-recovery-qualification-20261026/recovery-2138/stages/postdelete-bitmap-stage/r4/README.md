# postdelete-bitmap-stage/r4 (PREPARED by Claude, SOURCE ONLY; nothing run by Claude)
r4 = frozen r3 (not yet tested; preserved, SUMS 5ecd6a6d...) + the precise COALESCED rules of independent review 1701 and root's r3
review. Report: logs/claude-postdelete-coalesced-r4-1710.md. jbd2_verify.py (d3cfa34e...) and case/base-1626.json = r1 (jobs cmp them).
Coalesced model (first slot image after the last live tid P is a NEW generation), accepted ONLY if:
  T == P + 1; the T slot image is inode-checksum valid with links >= 1; the inode bit is SET at T (and while that generation lives);
  no old-generation image at/after T; EVERY covered group - old data blocks AND the bound extent-tree blocks (28 on the real case) -
  has a proven block-bitmap image IN T with every old bit CLEAR. Missing T image / set bit in T / T != P + 1 / gap -> BLOCKED;
  an old bit set in a later image -> REUSE_OBSERVED. Output: mode "coalesced", deletionStartTid null ("NOT observed"),
  firstObservedCompletionTid = slotReuseTid = T, bitmaps.coalesced {T, groupsWithTImage, groupsWithoutTImage, oldBitsSetInT}.
Classic model (explicit unlinked -> freed -> reused images) unchanged (mode "classic"); in BOTH models the bound tree blocks are part
of the no-reuse masks. recoveryAcceptance is always false.
Root order (queue 512, as the unprivileged owner):
  1. bash jobs/q-exit-status.sh pdb-r4-tests 512 unshare -Urn bash postdelete-bitmap-stage/r4/jobs/tests.sh      # expect "## PASS (22)"
  2. bash jobs/q-exit-status.sh pdb-r4-check 512 unshare -Urn bash postdelete-bitmap-stage/r4/jobs/root-check.sh # needs the bound r4 receipt
rc of 2: 0 NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY / 4 REUSE_OBSERVED / 5 BLOCKED / 3 refused / 9 precondition.
NO verdict is a recovery acceptance; the current flags only. Full MDBX check, plain-vs-hashed state / trie and a canonical
(L1-authenticated) root remain separate gates.
