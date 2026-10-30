# postdelete-bitmap-stage/r3 (PREPARED by Claude, SOURCE ONLY; nothing run by Claude)
r3 = r2 + review 1687 hardening (F1/F2/F3/F4/F6) + the real single-transaction deletion shape found by root 1698 (r2 BLOCKED: the
first slot image after the last live one, tid 17170, already holds a NEW generation 3941633993). Report: logs/claude-postdelete-hardening-r3-1700.md.
jbd2_verify.py (d3cfa34e..., = journal-recovery-verifier r1/r3) and case/base-1626.json are byte-identical to r1 (both jobs cmp them).
Checker changes (postdelete_bitmap.py, see its docstring):
  F1  the candidate map is BOUND to the proven extent tree: last-live inode root (depth 1/2) -> newest proven index/leaf images before
      the deletion, ext4 extent block checksums with the OLD inode generation, leaf pointers == picked[] (order), picked sequence /
      journalBlock == those images, decoded extents == extents[], tree block count == metadataBlocks; window completeness from the
      OLDEST bound tree image; revokes of the file's own tree blocks allowed only at/after the deletion start; per group
      observedSetToClear vs clearWithoutObservedSet counts (the latter reported, never invented as observed).
  F2  LIMITS: userspace e2fsprogs / fuse2fs RW / other kernels / raw or image writes / discard+fstrim are invisible; newestCommitSec
      and the fs last write / mount times are reported side by side.
  F3  S0 checks the orphan i_dtime (next orphan ino or 0, <= inode count), matching the docstring.
  1698 single-transaction mode: next image = NEW generation -> S0 = C = R = that tid; every old bit must be clear there, any set bit = reuse.
Jobs: F4 root-check requires a test receipt bound to THIS stage's SHA256SUMS + checker + runtime + test file; F6 both jobs refuse real
root (uid_map outer 0), hash inputs with nofollow opens owned by the caller, and create a NEW run directory (no mkdir -p of it).
Root order (queue 512, as the unprivileged owner):
  1. bash jobs/q-exit-status.sh pdb-r3-tests 512 unshare -Urn bash postdelete-bitmap-stage/r3/jobs/tests.sh      # expect "## PASS (21)"
  2. bash jobs/q-exit-status.sh pdb-r3-check 512 unshare -Urn bash postdelete-bitmap-stage/r3/jobs/root-check.sh # refuses without a bound receipt
rc of 2: 0 NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY / 4 REUSE_OBSERVED / 5 BLOCKED / 3 refused / 9 precondition.
NO verdict is a recovery acceptance. Full MDBX check, plain-vs-hashed state / trie and a canonical (L1-authenticated) root remain
separate gates; journal absence of reuse alone is NOT acceptance.
