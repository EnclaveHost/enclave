# 1878: state-helper-qualification-stage/r2 = frozen r1 + review 1875 P1-P4 (SOURCE ONLY; NOT run; NOT PASS)

**Scope of MY activity:**
- **Created** `state-helper-qualification-stage/r2` (README, `acceptance.py`, `jobs/tests.sh`, `tests/test_acceptance.py`, SUMS; an empty `runs/`).
- **Read:** `composite-mdbx-validation-stage/r6/composite_session.py` (`Session.__init__` paths, `receipt["view"]`, `interrupted`) and `r10/memory_gate.py` (`OOM_KEYS`, `dirty()`, `mem["softStop"]`/`memoryDirty`/`eventsBefore`/`eventsAfter`).
- **The only checks I ran:** `ast.parse` syntax checks of the two Python files, and `sha256sum -c`.
- **Not done:** tests, builds, queue jobs, mounts, network, data access or commits.
- **Untouched:** frozen r1 (`sha256sum -c` OK), r11, the r12 fixture-script work, the capture stages and shared source.
- **No r2 test has run.** No state, compiled-fixture or production qualification is claimed.

| r2 file | sha256 |
|---|---|
| `SHA256SUMS` | `70144b83eb7a70184cf34c48b5d116940dde942af583416ac2800db3284b879e` |
| `acceptance.py` | `69944121b345fc0ef4dc15e765ef176894ffa00d05e1965dde2cab869bef8d04` |
| `tests/test_acceptance.py` (46 tests) | `a626382c33881305cd0ec156c1f76f3df8e3fc9327282970dd3f39fd03cfc169` |
| `jobs/tests.sh` (requires exactly `Ran 46 tests`) | `364457473a3c87b5808ccbb622b6171ae03ed76a34bcc82fcab206fdd5b0d4f6` |
| `README.md` | `041b21f69a276a136c387f55c37715213fbb915d61d20bed26fd14c597ebd5aa` |

**Unchanged vs r1** (by diff): `load_json_strict`'s accept set, `report_schema_errors`, `derived_exit`, `production_v2_errors`, the `classify_state` order (only its memory test changed), `check_fixture_capture`, and all r11 pins and constants.

## P1: the final evidence binds the DB and the exact helper argv (`acceptance.py` final-evidence section)
**Pins:** `PIN_KEYS` now = stage/helper/build/positive/fixtures shas + `helperPath`, `runDir`, `staticFilesDir`, `staticFiles` and `view`. **`reportPath` is removed;** it derives from `runDir`.
- `is_abs_path`: absolute, already normalized (no empty, `.` or `..` components, no trailing `/`), and no control or whitespace characters.
- `helperPath` must have the basename `base-state-readonly`.
- `staticFilesDir` must lie outside `runDir`.

**The argv:** `expected_argv(pins)` = `[helperPath, "--db", runDir+"/work/db", "--static-files", staticFilesDir, "--rocksdb", runDir+"/rocksdb-absent", "--out", runDir+"/state-report.json", "--plain-hashed"]`.
- `/work/db` is r6 `Session.db` (`composite_session.py:179-180`).
- The flags are r11 `main.rs:75-79`.
- `evidence.helperArgv` must equal it **exactly** (a list of str, same order, nothing extra).

**The report path:** `evidence.report.path` must equal `runDir + "/state-report.json"`. The r1 `outArg` field is removed; the argv carries it.

**The view:** `evidence.view` and `pins.view` must have exactly r6's `receipt["view"]` keys (`composite_session.py:218-221`): `dir, kind, manifestSha256, descriptorSha256, logicalSize, parts, receiptSha256`.
- `kind == "production"` and `parts == 265`, with exact types;
- 64-hex shas and a positive u64 `logicalSize`;
- evidence == pins exactly.

## P2: native fields, exact, no truthiness
**`evidence.interrupted`** is r6 `receipt["interrupted"]` (`None` or a str). **Only `None` passes.** Any string, including `""`, fails, and so does any other type (`False`, `0`, `[]`). r1's `cancelled` and `softStop` keys are removed, and supplying them is an extra-key failure.

**`memory`** = `{memoryDirty, softStop, eventsBefore, eventsAfter}`, the r10 `receipt["memory"]` subset (`memory_gate.py:350-356,369`, plus `memory_classify`'s `eventsAfter`/`memoryDirty` update).
- `counters_dirty` is r10 `dirty()` (`:178-182`) with exact types: both objects, `oom`/`oom_kill`/`oom_group_kill` exact nonnegative ints, and no increase.
- `memory_errors` requires the exact keys and native types, and `memoryDirty` must equal the re-derivation.
- `memory_clean` = no errors, `memoryDirty is False`, `softStop is None`, and counters clean.
- It is used by both `classify_state` (34/35 → 7 otherwise) and `final_state_status`.
- `countersReadable` is gone.

## P3: malformed public inputs fail closed
**Every public function is wrapped by `_fail_closed`, which catches `Exception` only:**

| function | on malformed input |
|---|---|
| `report_schema_errors`, `production_v2_errors`, `lifecycle_errors`, `memory_errors`, `pins_errors` | `[reason]` |
| `derived_exit` | `None` |
| `memory_clean` | `False` |
| `counters_dirty` | `True` |
| `classify_state` | 7 |
| `final_state_status` | 10 |
| `check_fixture_capture` | `outputValid: false` |
| `load_json_strict` | `Invalid` (its generic catch was added) |

- **What still propagates:** `SystemExit`, `KeyboardInterrupt` and `GeneratorExit`.
- **Reasons record the exception type only.**
- **`exact_keys`** sorts `repr`s, so mixed key types no longer raise.

## P4: the shell exit range
`final_state_status` returns 10 for a non-int runtime rc, or one outside 0..255. Otherwise: 0 → 10; 1..255 other than 35 is preserved; 35 is gated as before.

## Prepared tests (46; `jobs/tests.sh` requires exactly `Ran 46 tests`)
**r1's 38, adapted:**
- the native `MEM`/`MEM_DIRTY` and the r2 `PINS`/`evidence`/`ARGV`/`VIEW` fixtures;
- tests 18, 27, 29 and 31 were changed for the new fields. Test 29 adds the interrupted string, interrupted `False`, an extra `outArg`, a soft stop, a popped argv element, and a 264-part view.

**8 new tests:**

| test | what it checks |
|---|---|
| 39 | the argv is exact: each element altered, reordering, extra or missing elements, wrong types |
| 40 | the view is bound: each field altered in the evidence; production-invalid values in both evidence and pins; an extra or missing key |
| 41 | the pinned paths: the helper basename, relative, `..`, trailing `/`, `//`, whitespace, the SF dir inside the run dir; `is_abs_path` cases |
| 42 | the native memory mapping: well-formed but dirty; soft-stop strings; non-native `False`/`0`; disagreement; unreadable counters; an extra or missing key; via `classify_state` and `final_state_status` |
| 43 | the native `interrupted` field; the r1 boolean keys are rejected |
| 44 | a fail-closed sweep: every evidence, pins, lifecycle and memory key replaced by junk (`None`, `[]`, str, bool, 2⁷⁰, `{1: 2}`, mixed keys, an object whose `__eq__` raises, bytes, a float). Hash-colliding raising keys go to every public function |
| 45 | `KeyboardInterrupt` and `SystemExit` propagate from `final_state_status`, `classify_state`, `check_fixture_capture` and `report_schema_errors` |
| 46 | runtime rc −1, −9, 256, 291, 2⁶⁴ and −2⁷⁰ → 10; 1, 255, 30 and 34 preserved; a valid 35 stays 35 |

**Root runs them:** `bash jobs/q-exit-status.sh sq-r2-tests 256 unshare -Urn bash state-helper-qualification-stage/r2/jobs/tests.sh`.

**Unrun.** My only checks were the syntax checks. A wrong expectation in a new test would show as a FAIL, not a silent pass, because the runner requires exactly 46 and OK.

## Limits (plain)
- **Pure functions only.** All inputs are SYNTHETIC or caller-supplied. Nothing here runs the helper, exposes or rechecks a view, captures argv or output, or reads a receipt. The future runner must fill these fields from the real r6/r10 receipts.
- **Mapping assumptions:** `lifecycle` still uses r1's mapping (r6 `exec_info` names + `postUseOk` = r6 `checks.postUseRecheck.ok`); only the P2 fields changed. The `events` dict shape follows r10 `dirty()`'s keys. The synthetic `EV0` also carries `low`/`high`/`max`, which are ignored.
- **The pins are still r11.** The r12 fixture-script changes are not reflected, so `check_fixture_capture` and the `positive.sh`/`fixtures.sh` pins must be revisited when r12 lands.
- **No authority:** nothing here is a compiled-fixture qualification, a state result, canonical proof, recovery acceptance or original-reset authority. Production structural CLEAN, header extraction, the runner lifecycle and final acceptance all remain open.
