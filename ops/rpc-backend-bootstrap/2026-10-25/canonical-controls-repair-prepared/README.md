# verifier-canonical-controls-repair: HARNESS-ONLY repair of the canonical-block mutant runner (PREPARED; nothing run)

## What root observed (actual run `verifier-canonical-stage/run/mutants-20261026T000505Z`, root-canonical-mutants-0006, still active)

**Defect 1: the footer was read as a compiler error.**
- **Observation:** M1–M4 (and others) were classified **INVALID "compiler error"**, although the `--no-run` build passed
  and the named tests failed by their own assertions.
- **Cause:** the frozen `check_cargo_output.py mutant` (`d1093dae`) matches `^error(\[E\d+\])?:`, which includes cargo's
  ORDINARY footer `error: test failed, to rerun pass `-p helios-core --test canonical_block_gate``.
- **Evidence:** `fixtures/actual-M1-…out` line 89; its original verdict is in `fixtures/*.original-verdict`.

**Defect 2: multi-binary runs stopped early.** Multi-binary mutants (M3, M6, M7) ran without `--no-fail-fast`, so cargo
stopped after the first failing binary.
- **Evidence:** actual M3 ran only `tests/canonical_block_gate.rs`, so `node_canonical_methods` (which holds
  `node_stale_head_refuses_true_only`) **never ran**.

**Defect 3: cargo's exit code and timeouts were never checked.**

**The original run's FAIL/INVALID verdicts stay recorded as they are.** Nothing in `verifier-canonical-stage` (jobs,
patch, `PATCHED.sha256`, `EXPECTED-CONTROLS`, run dirs) was or will be edited by this stage.

## Repair (harness only; product patch `41667ec9`, `PATCHED.sha256` `7e87fad8`, the 35 named tests and all mutants unchanged)

**`jobs/check_cargo_mutant.py` (`4bfafa78`).** It replaces only the `mutant` mode.

| outcome | when |
|---|---|
| **KILLED** (0) | cargo exit exactly **101**; every requested binary ran exactly once (no other binaries, no doc-tests); each binary has one summary with **0 ignored / 0 measured / 0 filtered** and consistent counts; the ONLY `error` lines are cargo's exact footer, listing EXACTLY the failed binaries; each named test is `FAILED` once in its own binary (from `EXPECTED-CONTROLS.txt`), with its own `panicked at` block |
| **NOT KILLED** (1) | a named test ran and passed |
| **INVALID** (3) | everything else, never a kill: exit 0 with failures, exit 124, 128+N, 1, 2; a compiler error `error[E..]`; `error: could not compile`; any other `error` line; a footer naming other targets; a missing, duplicated or unexpected binary; an ignored or filtered test; a missing named test; a failure without its panic |

**The three footer shapes**, all present as strings in the pinned cargo 1.96 binary:
- `error: test failed, to rerun pass `…``, the observed form, for one failed binary without `--no-fail-fast`;
- `error: 1 target failed:`;
- `error: N targets failed:`, followed by exactly N lines `    `-p helios-core --test B``.

**What is observed and what is not:** only the first shape has actually been observed in a run. The `--no-fail-fast`
list shapes come from the binary's strings and cargo's known format. If the real output differs, the checker refuses
with INVALID (fail-closed), never a false kill.

**`jobs/canonical-mutants-repaired.sh` (`0709e69a`).** It is `jobs/make-repaired-mutants.py` (`12306a14`) applied to the
FROZEN `canonical-mutants.sh` (`c2264d15`), 18 diff lines:
- it sources the ORIGINAL `common.sh` read-only;
- work dirs go under this stage's `run/`;
- `cargo test … --no-fail-fast`, with the real cargo exit recorded in `<M>.rc`;
- verdicts come from the corrected checker, mapping exit codes as 0 KILLED, 1 SURVIVED, other INVALID;
- informational runs are labelled as never counted.

**Unchanged and byte-identical:** every `mutate`, every named test list, `restore`, M0 and I1–I3 (diffed).

**What stays as before:**
- **Compile check:** the `--no-run` build still has to compile first; a compile failure is INVALID.
- **M0:** still the unpatched base `eeffcc9` + the self-contained patched `block_cache_exact_hash.rs`, which must
  compile and then fail its 4 named tests by assertion.

## Parser controls (`tests/test_check_cargo_mutant.py` `56831b7a`; PREPARED, NOT RUN)

There are 27 cases (`exit` == expected and empty stderr). They use the **ACTUAL** outputs of the running original job
(`fixtures/`, 48K, `FIXTURES.sha256`; no secrets) plus synthetic variants:
- **Actual outputs:** M1 KILLED; M4 KILLED; M3 INVALID (node binary never ran); I1 NOT KILLED (exit 0); I2 NOT KILLED
  (its named test passed while 2 others failed).
- **Exit codes:** 124, 137, 143, 1, 2, 0-with-failures, and 101-with-nothing-failed are all INVALID.
- **Errors:** `error[E0425]`, `error: could not compile` (no code), an arbitrary footer, a footer naming another
  target, and a missing footer are all INVALID.
- **`--no-fail-fast` footers:** `1 target failed:` is KILLED; two binaries with `2 targets failed:` is KILLED; a short
  list or trailing text is INVALID.
- **Test-level refusals:** a panic missing, a test missing, an ignored test line or count, or a filtered count is
  INVALID.
- **Binary refusals:** a requested binary missing, a binary run twice, a name of an unrequested binary, or a name not in
  the controls is INVALID; a named test that passed is NOT KILLED.

## Informational mutants I1–I3 (expected survivors; reported separately, never counted)

They are defence-in-depth equivalents. In the original run:
- **I1:** NOT KILLED (all 4 ok).
- **I2:** its named test passed (NOT KILLED), while 2 other cache tests failed.
- **I3:** still running at review time.

**No kill is claimed for them.**

## Root commands (all foreground; after review)

```sh
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; RS=$W/verifier-canonical-controls-repair; S=$W/verifier-canonical-stage
cd $W
python3 $RS/jobs/make-repaired-mutants.py --check $S/jobs/canonical-mutants.sh $RS/jobs/canonical-mutants-repaired.sh && echo derivation-ok
(cd $RS && sha256sum -c --quiet SHA256SUMS) && echo stage-ok
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 256 --log $RS/logs/parser-controls.guard -- \
  python3 -I $RS/tests/test_check_cargo_mutant.py > $RS/logs/parser-controls.out 2>&1; echo $? > $RS/logs/parser-controls.rc   # must end "failed=0"
# ONLY after root-canonical-mutants-0006 has ENDED (its .rc written; it holds the reuse lock until then):
CANONICAL_CACHE_FROM=$S/run/tests-20261025T234358Z ./jobs/q-exit-status.sh canonical-mutants-repaired-1 2560 \
  unshare -rn bash $RS/jobs/canonical-mutants-repaired.sh
```

**Cache reuse:** it uses the ORIGINAL `common.sh` `reuse_cache`. That refuses (exit 23, never a verdict) unless
`tests-20261025T234358Z` has ended per its queue log, no process uses it, no other job holds its reuse lock, and its
cargo-home sources equal CH0. Its cargo-home and target are mutable caches; the fresh clone, patch, closure and logs are
under `$RS/run/mutants-*`.

**Pass:** `MUTANTS rc=0`, i.e. M0–M12 KILLED, and the I1–I3 lines reported separately.

---

## CURRENT STATUS: ACTUAL RESULT (appended 2026-10-26)

**The prepared text above is preserved** byte-identical in `PREPARED-README.md`. The prepared manifest is
`PREPARED-SHA256SUMS`; its `README.md` entry is the text now at `PREPARED-README.md`. r2 and its own manifest
`r2/SHA256SUMS` are unchanged.

**Result:** **12/12 REQUIRED critical controls KILLED** (M0–M8, M10–M12).
- **How:** by the corrected r2 classifier, over the COMPLETED native outputs of `root-canonical-repaired-mutants-0013`
  (`actual/run-mutants-20261026T001203Z/`, all 62 run files).
- **The receipt:** `actual/reevaluation-mutants-20261026T001203Z.json`, sha256
  `93c65ee9e21f2c984bc1c822d182b43a5c0e3efe5fd95c36cfc5219219e1f491`, with `"nativeRerun": false`.
- **The jobs:** root's `root-canonical-r2-reevaluate-0018` (rc 0) and `root-canonical-r2-parser-0018` (the 32 r2 parser
  controls, rc 0).
- **Root's independent checks:** root rehashed every run file and verified every required test named FAILED with its
  own panic, cargo exit 101, r2 exit 0 and empty stderr.

**This is a RE-EVALUATION of completed native outputs, not a new native run.**

**The original runners' verdicts are preserved as recorded:**
- **`root-canonical-mutants-0006`** (frozen v0 runner/classifier): rc 1, FAIL. Its outputs are in
  `verifier-canonical-stage/run/mutants-20261026T000505Z`; its queue receipt is in `actual/receipts/`.
- **`root-canonical-repaired-mutants-0013`** (v1 classifier, single-footer assumption): rc 1, FAIL. Every required
  mutant was INVALID only because of the footer. Its verdict files are kept unchanged in
  `actual/run-mutants-20261026T001203Z/*.verdict`.
- **The v1 parser controls** `root-canonical-repair-parser-0013` (27 cases) passed.

| mutant | r2 (re-evaluation) | original v1 runner | cargo rc |
|---|---|---|---|
| M0-base-eeffcc9, M1, M2, M3, M4, M5, M6, M7, M8, M10, M11, M12 (12 required) | **KILLED** (each named test FAILED by its own assertion panic; every requested binary ran; exact per-target + aggregate footers) | INVALID (footer) | 101 |
| I1-cache-filter-only-removed (informational) | NOT KILLED (never counted) | SURVIVED | 0 |
| I2-cache-unindex-only-removed (informational) | NOT KILLED (its named test passed; 2 other cache tests failed) | INVALID | 101 |
| I3-gate-no-above-head-check (informational) | NOT KILLED (never counted) | SURVIVED | 0 |

**Earlier native result** (referenced; published by its own worker): `root-canonical-native-build-tests-0000`, rc 0.
- **35 named tests** in 5 binaries PASS;
- **regression:** 20 summaries, **91 passed**, 0 failed, 0 ignored, 0 filtered.

**What is now established:** the 35 named tests pass on the patched tree, and the 12 required critical controls prove
that those tests detect each targeted defect.

**NOT claimed:** no full EVM, no reth-reorg end-to-end, no SNP/attestation, no production or deployment claim. The I1–I3
defence-in-depth survivors are informational only.

**Actual evidence added** (`actual/`, 360K, bounded text; no cache, binary, `metadata.json`, helios or vendor tree):
- `run-mutants-20261026T001203Z/`: all 15 × `.build/.out/.rc/.verdict`, plus `CACHE-REUSED-FROM` and `fetch.out`
  (empty). These are exactly the 62 files pinned in the receipt.
- `receipts/`: the `.out/.rc/.guard` of `root-canonical-repaired-mutants-0013`, `root-canonical-repair-parser-0013`,
  `root-canonical-r2-parser-0018`, `root-canonical-r2-reevaluate-0018` and `root-canonical-mutants-0006`.
- `reevaluation-mutants-20261026T001203Z.json`: the compound receipt.
- `root-scripts/root-canonical-repaired-0013.sh`, `root-scripts/root-canonical-r2-evidence-0018.sh`: root's coordinator
  scripts.

**Verify:** `sha256sum -c SHA256SUMS` covers EVERY file here, including the nested `r2/` files and `actual/`.
