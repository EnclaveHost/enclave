# composition-fixture-audit-correction-stage (PREPARED; nothing run; read-only post-run audit for r12)

**Files owned (nothing else):**
- `tools/post-run-audit.py`
- `tests/test_post_run_audit.py` (exactly 13)
- `jobs/root-post-run-audit.sh`
- `README.md`, `SHA256SUMS`

**Not touched:** r12 (FROZEN), its active run `root-composition-r12-full-0313` and its tree. They are never stopped, restarted
or edited; git runs with `--no-optional-locks`.

## The bug in r12's D audit (`jobs/r12-build-validate.sh:191`)

- `git status --untracked-files=all --ignored` names every ignored **file**.
- The allowance names only the **directories** `contracts/foundry/out/` and `contracts/foundry/cache/`.
- `grep -vxF` matches whole lines, so all 33 bound contract artifacts that B2 placed in the final tree were reported:
  `[FAIL] regeneration touched non-generated files`.
- The rest of D passed in the log: the regenerated candidate `debbfb377d90f4193ea9182f5cb67d714ffaa322`, and all 20 generated
  manifests.

## The corrected audit (no directory blanket)

**Allowed untracked or ignored paths.** Outside the three dependency closures, each must be exactly one of:

| Path | Condition |
|---|---|
| a bound artifact (`ARTIFACTS-final.sha256`) | bytes re-hashed equal |
| `out/build-info/*` | only with `BUILDINFO-final.sha256` listing it |
| `cache/*` | only with `CACHE-final.sha256` (r12 records none, so refused) |
| the network runtime pair | bytes equal to `gen-pass-2.ignored.sha256` |
| the copied stack tests (post-run) | bytes equal to `r12/stack-tests` |

**Refused:** anything else, a missing bound file, a symlink or escape, a tracked modification, or a generated path left
uncommitted.

**r12's D rules, re-checked (not relaxed):**
- HEAD is the regenerated candidate on the immutable base `2d56a4b1…`;
- base..candidate changes only `GENERATED.txt` paths, all of which exist;
- the final artifacts equal their recorded build, and that build recorded raw build-info;
- the three dependency closures equal `DEPS.txt` (r12's own `deps-identity.py`, pinned);
- the D-time evidence: the logged D line names **exactly** the bound artifacts.

## Combining with actual receipts (no product test rerun)

`combine` passes only if **all** of these hold:
- the r12 job **finished** (rc file and summary line), with rc 1 and `RESULT: FAIL`;
- its **only** `[FAIL]` is that D line;
- every `RESULTS.tsv` row is clean (component, regression, stack, native);
- every receipt is byte-identical to its record with rc 0;
- the corrected audit is clean.

Otherwise the verdict is FAIL, or INCOMPLETE (rc 3) while the job runs. **No PASS is claimed now.**
