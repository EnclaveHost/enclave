# Composition fixture-audit correction: result (PREPARED; nothing run; no PASS claimed)

**Stage:** `composition-fixture-audit-correction-stage/` (`SHA256SUMS` sha256 `91cade5ba52ba022301cab6656a3c0c888e808c9fe91d7d5692ce6a79754a212`).

| File | sha256 |
|---|---|
| `tools/post-run-audit.py` | `58d1d4f2e3a145b40cf07f8b03ea94a31eef8f84816b6665f06009aea8e11dc7` |
| `tests/test_post_run_audit.py` (exactly 13) | `9ee312adc56704322336e3600568356c073f490efb4657a139f6378b7a80ee20` |
| `jobs/root-post-run-audit.sh` | `271b4f714af735f8c16a4afd8e4133a9cab2293fbf33478becf5d0e524cf0230` |
| `README.md` (the files owned) | `04aa236ab83e18e38d5c9bcbd6d92338dab9951fe2f38e2eb3f1bab7a83305c0` |

**Untouched:** r12 is frozen (`SHA256SUMS` still verifies), and its active job `root-composition-r12-full-0313` (still running: no rc file, currently in phase E) was not stopped, restarted or edited.

**What Claude did:** reads, writes and static checks only (`bash -n`, Python `ast.parse`, sha256).
- **Not done:** no tests, builds, queue jobs, network access, live actions or commits.
- **Disclosure:** while diagnosing, I ran **one plain `git status` (without `--no-optional-locks`)** on the running final tree. Git may refresh `.git/index` stat data during `status`; that is a metadata write, not a content change. The prepared audit uses `--no-optional-locks` with `GIT_OPTIONAL_LOCKS=0`, and its runner checks that the index bytes are unchanged.

## The actual failure (traced)

- **The log line** (`logs/root-composition-r12-full-0313.out:140`): `[FAIL] regeneration touched non-generated files`, followed by **33** paths, all `contracts/foundry/out/<Source>.sol/<Name>.json`.
- **The cause** (`r12/jobs/r12-build-validate.sh:191`):
  - `git status --porcelain=v1 --untracked-files=all --ignored` names every ignored **file**;
  - the allowance appends only the **directory** names `contracts/foundry/out/` and `contracts/foundry/cache/`;
  - `grep -vxF` matches whole lines, so every artifact file B2 had placed (final copied from consumers, per `ARTIFACT-REUSE.txt`) was flagged.
- **Nothing else in D failed in the log:** regenerated candidate `debbfb377d90f4193ea9182f5cb67d714ffaa322` (parent `2d56a4b1…`, 24 files changed), and all 20 generated-artifact manifests pin the tree.
- **Current tree status** (observed): 35 ignored (33 artifacts + the 2 network-runtime files) and 6 untracked (the stack-test copies added after D).

## The corrected audit (`post-run-audit.py audit`, read-only)

**No directory blanket.** Every untracked or ignored path outside `node_modules`, `network/node_modules` and `relay/node_modules` must be **exactly**:

| Path | Condition |
|---|---|
| a bound artifact listed in `ARTIFACTS-final.sha256` | bytes re-hashed equal |
| `out/build-info/*` | only if `BUILDINFO-final.sha256` lists it with equal bytes |
| `cache/*` | only if `CACHE-final.sha256` lists it (r12 records none, so refused) |
| the network-runtime pair | equal to `gen-pass-2.ignored.sha256` |
| post-run only: `test/<f>` for the r12 stack tests | equal to `r12/stack-tests/<f>` |

**Refused:** an extra file, a missing bound file, a tampered byte, a symlink in any component, a path leaving the tree, a tracked modification, or a generated path left uncommitted.

**Kept from r12, not relaxed:**
- HEAD is the candidate, and its parent is the immutable base;
- base..candidate changes only `GENERATED.txt` paths, and every one exists;
- the final artifacts equal their recorded build (`consumers`), which recorded raw build-info;
- the three closures equal `DEPS.txt`, using r12's own `deps-identity.py` (pinned `f54c5935…`);
- the D-time evidence: the logged D line names **exactly** the bound artifacts and nothing else.

## Combining with actual receipts (`combine`; no product test rerun)

The verdict is `PASS WITH THE CORRECTED D AUDIT (actual receipts; no product test rerun) - root review required` **only if all of these hold**:
- the job **finished** (rc file + `## summary:`) with rc 1 and `RESULT: FAIL`;
- its **only** `[FAIL]` line is that D line;
- every `RESULTS.tsv` row is clean (component and adapted rows `ok…` with both sides clean; REGRESS `ok`; STACK clean; NATIVE `rc 0 … OK`);
- every receipt in `receipts/RECEIPTS.tsv` is byte-identical with rc 0;
- the corrected audit is clean.

Otherwise the verdict is FAIL, or INCOMPLETE while the job runs.

## Tests (13, synthetic real-git fixture; prepared, NOT run)

1. **The genuine bug:** r12's line-191 rule (its directory-only allowance asserted from the frozen runner) flags every artifact file.
2. The corrected audit passes the exact bound state.
3. An extra file is refused, both an unexpected artifact and an unrelated file.
4. A tampered or missing artifact is refused.
5. Cache or build-info is refused without an exact record, and accepted with one.
6. An arbitrary source change is refused, as a tracked edit and as a "regeneration" commit touching a source.
7. A symlinked file or symlinked directory (escape) is refused.
8. Network-runtime or stack-copy bytes must match.
9. A dependency-closure change is refused (real `deps-identity.py`).
10. The D-time evidence must be exactly the bound artifacts.
11. git writes nothing (the index is unchanged after a stat change).
12. `combine` accepts only a completed run whose only failure is the D line, and refuses another `[FAIL]` or a tampered receipt.
13. `combine` never passes an unfinished or unclean run.

## Root command (read-only; after, or alongside, the job)

```
ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/composition-fixture-audit-correction-stage
python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $ST/logs/root-post-run-audit.guard -- unshare -rn bash $ST/jobs/root-post-run-audit.sh > $ST/logs/root-post-run-audit.out 2>&1; echo $? > $ST/logs/root-post-run-audit.rc
```

**What it does:**
1. checks the stage `SHA256SUMS`, r12's `SHA256SUMS` and the pinned `deps-identity.py`;
2. runs the tests (exactly `Ran 13 tests` + `OK`, no skips);
3. audits the **actual** final tree twice, requiring identical pre/post output and unchanged `.git/index` bytes;
4. runs `combine`.

**Exit codes:**

| rc | Meaning |
|---|---|
| 0 | corrected audit plus actual receipts clean (root review required) |
| 3 | audit clean, job not finished |
| 1 | anything else |

## Limits

- **Run it after the job finishes.** Run alongside, the E-phase tests may change the tree, and the pre/post stability check then fails, by design.
- **Test residue counts.** If the tests leave any file in the final tree beyond the stack-test copies, the audit fails and lists it. Whether such residue is acceptable is a root decision; it is never ignored.
- **No product tests are re-run.** `combine` relies on r12's own recorded receipts and `RESULTS.tsv`, checked byte for byte.
- **No PASS is claimed.**
