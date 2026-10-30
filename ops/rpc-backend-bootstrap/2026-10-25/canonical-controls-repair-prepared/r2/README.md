# verifier-canonical-controls-repair/r2: footer parser corrected to the ACTUAL --no-fail-fast output (PREPARED; nothing run)

## Why r2

**The parent repair (kept unchanged; `../SHA256SUMS` verifies):**
- **What passed:** its 27 parser controls (`root-canonical-repair-parser-0013`, rc 0).
- **The native run:** the repaired native run `root-canonical-repaired-mutants-0013` (`../run/mutants-20261026T001203Z`)
  is ACTIVE.
- **What the actual `--no-fail-fast` output shows** is BOTH footer kinds:
  - after EACH failed binary's summary: `error: test failed, to rerun pass `-p helios-core --test B``;
  - at the end, an aggregate: `error: N targets failed:` (`1 target failed:`) plus N lines `    `-p helios-core --test B``, in run order.
  - Examples: M1 (one binary), M3 (two), M7 (three).
- **The v1 problem:** v1 assumed ONE footer shape, so it refused every such output (INVALID). **Those v1 verdicts stay
  recorded as they are; nothing in the parent stage, its runner, the product, tests or mutations changes.**

## r2 parser (`jobs/check_cargo_mutant_r2.py` `be0d73f3`)

It is v1 `4bfafa78` with only the docstring and the footer block replaced (`diff` 63 lines).

**Footer rules:**
- **Per-target footer:** exactly ONE per failed binary, inside that binary's own section after its summary, with only
  blank lines around it. None for a passing binary. In run order: no missing, duplicate, wrong-target or misplaced
  footer.
- **Aggregate footer:** then exactly ONE aggregate, with its count equal to the number of failed binaries, followed by
  exactly those targets in run order, with nothing non-blank after it.
- **The original single variant** (no `--no-fail-fast`): no aggregate, exactly one failed binary, and its per-target
  footer is the last non-blank line.
- **Any other `error` line is INVALID:** compiler `error[E..]`, `could not compile`, arbitrary text, or a per-target vs
  aggregate mismatch.

**Unchanged and still strict:**
- cargo exit exactly **101** (0 only for a survivor; 124, 128+N, 1, 2 are INVALID);
- every requested binary ran exactly once;
- every summary has 0 ignored, 0 measured, 0 filtered, with consistent counts and no ignored test line;
- each named test is FAILED once in its own binary with its own `panicked at` (a passing one is NOT KILLED).

## Controls (`tests/test_check_cargo_mutant_r2.py` `48470101`; 32 cases; PREPARED, NOT RUN)

**Fixtures** (`fixtures/`, `FIXTURES.sha256`; actual files, no secrets):
- `nff-M1`, `nff-M3`, `nff-M7`: `.out` + recorded cargo `.rc` (101) + v1 verdict, from the active repaired run (these
  files were complete);
- `orig-M1`: the original single-footer run.

**Cases:**
- **A1–A5, actual outputs:** M1/M3/M7 `--no-fail-fast` KILLED; the original single-footer M1 KILLED; M3 judged with a
  binary missing from the request INVALID.
- **X1–X16, footer controls:**
  - a per-target footer missing, duplicated, naming the wrong target, or present for a passing binary;
  - the aggregate missing, with the wrong count, short, out of order, duplicated, with trailing text, or placed before a
    per-target footer;
  - an arbitrary extra error, an E-code, `could not compile`, noise between the summary and the footer, or trailing
    text after a single footer.
- **R0/R1/R2/R124/R137, exit codes:** INVALID.
- **S1–S6:** ignored or filtered counts, a missing binary, a missing panic or test → INVALID; a passing named test → NOT
  KILLED.

## Re-evaluation of the COMPLETED run (`jobs/reevaluate_completed_run.py` `95ebda5c`; root, ONLY after the run ends)

**No recompilation and no native rerun claim:** it re-reads the SAME immutable outputs.

**It refuses (exit 2, no receipt) unless all of these hold:**
- **Pinned inputs:**
  - the product patch `41667ec9`, `PATCHED.sha256` `7e87fad8`, `EXPECTED-CONTROLS` `b0409b8a`;
  - the frozen runner `c2264d15` and `common.sh` `2c751494`;
  - the repaired runner `0709e69a` with its derivation re-checked, and v1 `4bfafa78`;
  - r2 `be0d73f3`.
- **The run ENDED:** the queue log has the `[ok] fresh <run>` line and a final `[queue] EXIT`, its `.rc` is not older
  than the `.out`, it has one `MUTANTS rc=` line, and no process uses the run dir.
- **The mutant set matches** the UNCHANGED runner (12 required M0–M8, M10–M12 + 3 informational I1–I3, with each
  binary/name mapping parsed from it).
- **Every run file is unchanged:** each top-level `.build`/`.out`/`.rc`/`.verdict` + `CACHE-REUSED-FROM` is hashed
  before AND after, must be unchanged, and is pinned in the receipt.

**Per mutant:**
- the `.build` must show `Finished` with no `error` line (otherwise INVALID), and the `.out` and integer `.rc` must
  exist;
- the r2 verdict is recorded next to the original runner's v1 verdict.

**Result:**
- **Exit 0 only if ALL 12 required are KILLED by r2.**
- **I1–I3** are reported separately and never counted.
- **A surviving or INVALID required mutant** is reported as such: exit 1, and the assertions are not weakened.

## Root commands

```sh
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; R2=$W/verifier-canonical-controls-repair/r2
(cd $R2 && sha256sum -c --quiet SHA256SUMS) && echo r2-ok
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $R2/logs/r2-parser-controls.guard -- \
  python3 -I $R2/tests/test_check_cargo_mutant_r2.py > $R2/logs/r2-parser-controls.out 2>&1; echo $? > $R2/logs/r2-parser-controls.rc   # must end "failed=0"
# ONLY after root-canonical-repaired-mutants-0013 has ENDED (its .rc written):
python3 -I $R2/jobs/reevaluate_completed_run.py --run $W/verifier-canonical-controls-repair/run/mutants-20261026T001203Z \
  --queue-log $W/logs/root-canonical-repaired-mutants-0013 --receipt $R2/logs/reevaluation-mutants-20261026T001203Z.json
```

**Native failure evidence:** the original stage's and the parent repair's outputs stay where they are; nothing is moved
or rewritten.
