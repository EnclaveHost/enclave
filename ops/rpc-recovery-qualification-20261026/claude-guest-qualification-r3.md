# guest-state-qualification-stage/r3: fix for root 1479's logic-test ERROR (source only)

**Status: PREPARED, NOT RUN.**
- No tests, build, queue, live, network or VM actions; the only checks were `py_compile` and `bash -n`.
- **No production qualification is claimed.**
- r1 and r2 are preserved and re-verified (r2 `e828ae6a…`).

**Stage:** `guest-state-qualification-stage/r3/`, **SHA256SUMS sha256 `cae6bddab0dfa07cd2f1ac769d51cc2432631fa09d7f87115f489ac688b4db92`** (8 files).

## Root 1479 (`r2/logs/logic-20261026T170025Z-2072352/tests.txt`): 19 ran, 18 PASS, 1 ERROR
- **The error:** `test_base_version_failure_refuses`: `TypeError: Refuse.__init__() got multiple values for argument 'rc'`.
- **Cause:** `q2_extract_confinement.py:271` raised `Refuse(2, 'base --version failed', rc=ver.returncode, …)`. The detail keyword `rc` collided with `Refuse`'s positional `rc`, so a TypeError was raised instead of the intended refusal.
- **Fix** (the exact diff vs r2 is 3 lines in q2; the rest is renaming r2 → r3 in comments and job paths):
  1. `rc=` → **`processRc=`**;
  2. `main()` prints refusals as `{'event','rc','reason','detail': {…}}` instead of spreading the details at top level, so a detail field can never shadow `rc` or `reason`;
  3. the docstring stage name.
- **Audit:** I checked all 21 `Refuse(...)` calls in q2. No other call passes `rc` or `msg`; the remaining detail keys are `got`, `missing`, `extra`, `fixtures_decoy`, `expected` and `out`. q1 and q3 do not use `Refuse`.
- **Regression:** the existing `test_base_version_failure_refuses` **is** the regression. It exercises both the rc ≠ 0 and the empty-output paths, and fails with the old code exactly as root observed. No test was added; `test_q2_logic.py` is byte-identical to r2's.

## Counts unchanged from r2
- **Fixture map:** exactly **11** (positive control + 10 hostile families).
- **Logic tests:** **19** (`jobs/root-q2-logic-tests.sh` requires `Ran 19` and a bare `OK`; mocked; NOT native qualification).
- **Scratch prefix:** stays `/srv/enclave-base-holder/tmp/gsq-r2/` (fixture generator and q2 agree).

## Root job
```
jobs/q-exit-status.sh root-gsq-r3-logic 256 bash guest-state-qualification-stage/r3/jobs/root-q2-logic-tests.sh
```

## Still not covered
- Any guest run. There is no actual guest VM; the qualification VM is Claude370's stage, plus root admission.
- Q2b and Q4.
- All r2 inputs are still required: the frozen candidate unit and drop-in pins, the fixtures pin, the run name, the installed candidate paths, and the base pin `9c44836d…5e53f`.
