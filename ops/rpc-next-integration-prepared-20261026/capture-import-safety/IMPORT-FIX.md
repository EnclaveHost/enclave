# capture-import-safety-stage (PREPARED; source only; NOT run; NO runner by design)

This is the isolated record of the import-safety fix, made against `a1-capture-binding-stage/r2`, which is frozen and untouched.
- **Contents:** r2's tree, with `src/a1_capture.py` patched by `r2-import-fix.patch`, plus the new `tests/test_import_safety.py`.
- **Where to run it:** **not** here. The runnable composition is `a1-capture-binding-stage/r4`: r3 (root PASS 45) plus the **identical** three hunks plus the same test file. Root's runner is `a1-capture-binding-stage/r4/jobs/root-capture-tests.sh`.
- **Why there is no runner here:** this tree lacks r3's size limits. r3 is what root's live capture needs.

See `a1-capture-binding-stage/r4/R4-CHANGES.md` and `logs/claude-capture-import-safety-result.md`.
