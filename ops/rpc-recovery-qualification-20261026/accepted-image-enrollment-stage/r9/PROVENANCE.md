# accepted-image-enrollment-stage/r9 provenance (prepared; NOT run by Claude)

**Source tree: r8's `68245755168b13bb47041bce54ad5fb7cd0b89da`, UNCHANGED.**
- There is no r9 patch; the job composes exactly r8's chain, including r8's patch.
- **Evidence:** root 1464 (r8 full `check`), in `inputs/root-1464/`: everything passed except the unenrolled-tree verdict.

**Change (job only):** `jobs/check-unenrolled-tree.py` replaces the r3-era substring test with an EXACT allowed tree:
- the 7 entries a refused, unenrolled KVM r3 start leaves (the frozen `startDerivedReader` creates the private `runs/` and the journal lock before `openDerivedJournal` refuses);
- with types, private modes, an EMPTY lock, an EMPTY `runs/`, no symlinks and nothing else.

Its `--self-test` runs first: 13 declared fixtures (1 positive, 12 negative: journal, coverage, anchor journal, run directory, `runs.lock`, symlinked lock, unknown file, split journal directory, non-empty lock, `runs` mode 0755, symlinked `runs`, missing `runs`).

**Unchanged:** KVM r3 files, role, replica and adapter source, and the 234 test counts. The job never sets HOME, CODEX_HOME, TMPDIR or TEST_TMP.
