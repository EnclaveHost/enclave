# 1684: postdelete-bitmap-stage/r2, a FIXTURE-ONLY fix of r1 (SOURCE ONLY; frozen, NOT run)

**Stage:** `postdelete-bitmap-stage/r2/`, **SHA256SUMS sha256 `51c393bfeef5506752b44ebb3ae27c1a7f40faffa0126a278948b705113b529d`** (files 0444, no bytecode).
- **Frozen r1:** unchanged (`f5c89089…`, re-verified).
- **What I did:** `ast.parse` and `bash -n` only. No tests, real check, build, live action or USB.

## Cause (root 1682: 12 ran, 5 FAIL; root 1683 repro)
Root's diagnosis is correct, and it is a **fixture bug, not a checker bug**:
- **The overlap:** the synthetic "unrelated" bitmap bits `OTHER=(0,10)` overlapped **7 candidate bits of group 2**: E3B bits 0–1 and E2 bits 5–9.
- **The consequence:** the clean fixtures therefore never freed those 7 blocks, and showed them set at C (tid 14).
- **The checker was right:** it correctly answered BLOCKED, with 7 never seen freed and 7 reused at tid 14 in group 2. All 5 failures are that `rc 5` (`5 != 0` / `5 != 4`).
- **The other 7 tests passed in root 1682,** including the non-circular real inode-checksum and real fs-stats vectors and the expected-BLOCKED cases.

## r2 changes (checker acceptance NOT relaxed)
| file | r1 → r2 |
|---|---|
| `postdelete_bitmap.py` | `fd3c0a9f…` **byte-identical** |
| `jbd2_verify.py` | `d3cfa34e…` **byte-identical** (= journal-recovery-verifier r1/r3) |
| `case/base-1626.json` | `f952b1f8…` **byte-identical** |
| real vectors (`a6003b4a…`, `3a6b36e3…`) | identical |
| `tests/test_postdelete_bitmap.py` | `c44fed4e…` → `50a29521…` |
| `jobs/tests.sh` | → `ba3e7fcf…` |
| `jobs/root-check.sh` | → `42ab1715…` |
| `README.md` | → `b340bb16…` |

**Tests:**
- **The fix:** `OTHER = (100, 110)`, disjoint from every candidate bit. `clean_txs(other=…)` is parameterised.
- **Assertions:** every existing assertion is unchanged, including the negative and BLOCKED ones.
- **New test 13** (`test_fixture_unrelated_bits_disjoint_and_r1_overlap_still_blocks`):
  - **Invariant:** asserts the fixture invariant `candidate mask & OTHER == 0` in groups 1 and 2, and that the unrelated allocation bit 5000 is disjoint.
  - **Negative case:** asserts the r1 overlap is exactly 0/7 bits in groups 1/2, then keeps it as a NEGATIVE case. It must still give BLOCKED with `notObservedFreedBlocks` 7, `reusedBlocks` 7, group 2, first reuse at tid 14, sample `[65536, 65537, 65541..65545]`. That is root 1683's output.

**Jobs:**
- **New r2 checks:** both jobs additionally verify frozen postdelete r1 (`f5c89089…`) and `cmp` the checker, runtime and case against it. They refuse if r2 is not fixture-only.
- **Kept from r1:**
  - the r1/r3 verifier pins;
  - the bytecode ban;
  - `ulimit -t`/timeout bounds (tests: 600 s CPU and wall; check: 3600 s CPU, 5400 s wall);
  - the journal hash before and after the run;
  - the check refusing to start without a passing test receipt.
- **Test gate:** exactly `Ran 13 tests`, a final `OK`, empty stdout and no ResourceWarning, skipped, FAIL, ERROR or Traceback.

## Root commands (queue 512)
```
bash jobs/q-exit-status.sh pdb-r2-tests 512 unshare -Urn bash postdelete-bitmap-stage/r2/jobs/tests.sh       # expect ## PASS (13)
bash jobs/q-exit-status.sh pdb-r2-check 512 unshare -Urn bash postdelete-bitmap-stage/r2/jobs/root-check.sh  # only after PASS
```
**About the fixture assertions I could not run:** the 5 previously failing tests never reached their post-rc assertions in root 1682. I checked their expected values by hand against the corrected fixtures:
- `perGroup` `[[1,11,108,4,2,13,null],[2,12,52,3,1,14,null]]`;
- inode-bitmap rows `[[14,0],[16,1]]`;
- the split-batch equality.

A further mismatch is possible; if one appears, send me the stderr for an r3.

## Unchanged status
- **The real check has NOT run.** It is pending a PASS.
- **Method, limits and missing gates:** unchanged from `logs/claude-postdelete-bitmap-1659.md`:
  - allocate+free within one transaction is invisible;
  - discard/fstrim and the image layer are invisible, and are a separate missing gate;
  - history before the retained window cannot be proven absent;
  - reuse is not proof of overwrite, and no reuse is not proof of intact bytes.
- **No recovery acceptance:** none from the candidate map or from an absence of history.
