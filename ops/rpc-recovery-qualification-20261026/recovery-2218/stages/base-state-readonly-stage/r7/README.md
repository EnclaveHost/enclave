# base-state-readonly-stage/r7 = frozen r6 + ONE fix (root 1735): the /vm device-identity check of jobs/build.sh
# (PREPARED by Claude, SOURCE ONLY; nothing built or run by Claude). Report: logs/claude-base-mount-r7-1735.md
r5/r6 compared `findmnt ... | tr -s ' '` with an exact string; findmnt pads its last column with trailing spaces, so the real build
always refused (no scratch allocated). r7: jobs/mount_identity.py (stdlib) - exactly one line, exactly 4 whitespace-separated fields
(UUID, SOURCE, FSTYPE, MAJ:MIN), each compared individually; missing/extra/mismatched fields, several lines, no output or a findmnt
error refuse (exit 9). Parser fixtures: tests/test_mount_identity.py (6), run by jobs/guard-tests.sh together with the r5 disk-guard
suite (10); receipt format bsro-guard-test-receipt/r7.
UNCHANGED: jobs/disk_guard.py + tests/test_disk_guard.py + tests/guard_wrapper.py (byte-identical to r5, build.sh cmp-checks them and
that r5 is frozen), all thresholds (start >= 64 GiB free, floor 40 GiB, scratch <= 20 GiB, 7500 s), src/main.rs + src/bin/mk_fixture.rs
(= r6: mandatory hashed-only root + trie-cache Verifier; NOT compiled, unqualified until root builds and runs positive.sh).
Root order (offline, unshare): guard-tests (256) -> build (4096, guarded on /vm) -> fixtures (512) -> positive (512, 14 runs).
