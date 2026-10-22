# parser-r2: strict libtest re-evaluation of a TERMINAL sdk_regression_runner run (root validates)

The live run (runId 20261022T074318-2c83b92890fa) and its pinned package are not touched:
- `sdk_regression_runner.py` 8138486d, `config.json` 243bf3c2, `case-group.sh`, and harnesses cac66513 / 3c8374c4;
- `../PINS.sha256` verifies.

This is a re-evaluation of existing evidence; NO test is re-run.

## After the run is terminal (its results dir has `summary.json`), one 256 MiB queue job

    W=work/claude-resumed-20261022/storage-sdk-regressions
    python3 work/claude-test-queue.py --mib 256 --log $W/parser-r2/logs/reeval-20261022T074318-2c83b92890fa.guard.log -- \
      python3 -B $W/parser-r2/reevaluate.py --run-dir $W/runs/20261022T074318-2c83b92890fa-results \
        --config $W/config.json --out $W/parser-r2/reevaluations/20261022T074318-2c83b92890fa.json

- **Inputs:** read only. Each `<group>.out` and `<group>/driver.log` is hashed into the output, along with the
  summary.json hash, the config pin and the parser hashes.
- **Output:** a new file, created with O_EXCL outside the run dir.
- **Refusals:** exit 2 if the run is not terminal, the config is not 243bf3c2, or the output exists or lies inside the
  run dir.
- **Per group:**
  - the ORIGINAL runner record (verdict, real return code, harness exit) is copied unchanged;
  - the corrected verdict is separate. NOT_RUN stays NOT_RUN. A missing or duplicate GROUP-RESULT line gives
    INCOMPLETE. Any non-zero return code or harness exit stays FAIL. PASS needs all of rc 0, harness 0,
    GROUP-RESULT driver=0 agreeing with the rc, and a strict libtest_r2 parse with every configured case ok.
- **Exit:** 0 only if every group is corrected-PASS.

## libtest_r2 rules

Serial `--test-threads=1` output, with or without `--nocapture`; inline and multiline outcomes.
- **Running line:** exactly one `running N tests`, with N equal to the configured case count.
- **Closing a test:** a test opened by `test NAME ... <output>` is closed only by a standalone `ok` / `FAILED` /
  `ignored`. A new header, the summary, or EOF while it is open → unclosed error.
- **Stray terminal:** an outcome token outside any open test is an error.
- **Case set:** the exact configured set, each case once. No duplicates, missing or unexpected tests; every case must be `ok`.
- **Summary:** exactly one `test result:` line. Its passed/failed/ignored counts must equal the per-case tallies, and it
  must say ok iff 0 failed. No header may follow it.
- **Failures:** the `failures:` name list must equal the FAILED set. Such a section with no failure is an error.

An aggregate count alone is never accepted.

## Limits of parsing human-readable libtest output

- A test printing a line that is exactly `ok`/`FAILED`/`ignored` closes early. The real outcome then becomes a stray
  terminal → false FAIL, never a false PASS (the summary counts must also agree).
- An outcome glued to unterminated output (`...textok`) is not recognised → unclosed / mismatch → FAIL.
- Parallel test output (`--test-threads>1`) is not supported. The runner pins `--test-threads=1`.
- The text format is libtest's, not a stable machine interface. JSON output is nightly-only and was not used by the
  pinned driver build.
