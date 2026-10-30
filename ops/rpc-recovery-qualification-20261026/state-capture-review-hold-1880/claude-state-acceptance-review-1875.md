# 1875: independent source review of state-helper-qualification-stage/r1 `acceptance.py` + tests vs base-state-readonly-stage/r11 (root 1872)

**Scope of MY activity:** source reading only.
- **What I read:**
  - `acceptance.py` (634 lines) and `tests/test_acceptance.py`;
  - the r11 sources it models: `src/main.rs` (report doc, `verify_cache`, `plain_vs_hashed`, exit), `jobs/positive.sh`, `jobs/fixtures.sh`, and `bsro_gate.py` `verify-binaries`;
  - `memory_gate.py` r10 (the `softStop` representation only);
  - root 1872.
- **Not done:** edits, tests, queue jobs, builds, mounts, processes, network, production or storage reads, or commits.

**Stage state:**
- `SHA256SUMS` = `25ca8ece…`; `sha256sum -c` OK.
- A retained run receipt (`runs/tests-20261027T093534Z-3031705/receipt.json`) records 38/38 tests, rc 0. I did not run it.

**Pins:** `R11_STAGE_SUMS` `246ff06b…`, `main.rs` `5a6fa214…`, `positive.sh` `24b8c3e9…` and `fixtures.sh` `fc1e2842…` all equal the actual r11 files.

**This module is pure.** Its results are never runtime provenance, never a compiled-fixture qualification, never canonical, and never reset authority. The code says so: `NOT_AUTHORITY` and `authenticated: False`.

## Verdict
**No fail-open defect found in the pure predicates themselves.**
- The r11 report schema, the derived exit, the production v2 predicate, the 30/34/35/7/8 classification order (root 1872 #2) and the loader (#3) match r11 behaviour.
- I found no input that yields 35 or `outputValid` when it should not.

**Two contract gaps should be fixed before any runner is built on `final_state_status`:**
- **(P1)** the evidence contract does not bind **which DB** was checked, or the **helper argv**;
- **(P2)** the representation of three evidence fields mismatches what r6/r10 actually record.

**Minor robustness items:** P3 and P4.

## Checked against r11 (no mismatch found)
**The report schema:**
- **The key sets match `main.rs:260-285`:** the 24 top-level keys, the tipHeader keys (6), the stateRoot keys (9), the trieCache keys (8, `main.rs:123-126`), plain v2 (4) and plain v1 (11, `:164-167`).
- **The constant strings** are byte-equal to source, which `test_37` checks against the frozen file.
- **The derived flags reproduce `main.rs`:**
  - `checkpointsCoherent` is computed over the 4 stages, as `main.rs` does;
  - `rocksdbClassification` follows v2 and `rocksdbCurrentPresent`;
  - ABSENT implies the index checkpoints are 0;
  - `historyIndexCheckpoints` == `checkpoints` (or null);
  - `matchesHeader`, `cachedWalk*` and `computed == fromHashedOnly` are consistent;
  - `trieCache.status` follows the counts, and the samples length == `min(n, 64)` (`main.rs:115-119`);
  - the v1 plain PASS rule equals `main.rs:163`;
  - `fullStateIntegrity` follows `main.rs:259`.
- **`derived_exit` = `main.rs:291`.**

**The production predicate:**
- it uses the root-1872 #1 nonnegative plain counts (zero not required);
- ABSENT plus index 0, the 5 checkpoints == finish == `tipHeader.number`, hashed root == header == cached walk, trie 0/0 with empty samples, never full, and a derived exit of 5.

**Classification** (root 1872 #2):
- lifecycle malformed → 7; post-use → 8; exec faults → 7;
- child 3 with no report → 30, with a report → 7;
- child 4 with a schema-valid report deriving 4 → 34;
- child 5 → the passing predicate → 35;
- everything else → 7;
- memory dirty or unreadable turns 34/35 into 7.
- The passing predicate is never applied before the rc3/rc4 classification.

**The loader** (root 1872 #3):
- it rejects BOM, non-UTF-8, duplicate keys, NaN/±Infinity and any float/exponent number (r11 emits only integer numbers);
- deep nesting (`RecursionError`) and >4300-digit ints (`ValueError`) become `Invalid`;
- `type(x) is int` excludes bool everywhere it matters.

**Capture parsers:**
- **The positive label order equals the `one` lines in `positive.sh`** (checked against the source in `test_37`). On success the script prints only the 26 `case X: PASS` lines plus `## runs=26 failed=0`, `## outputs <abs>` and `## bsro-r11-positive rc=0`. `verify-binaries` (`bsro_gate.py:580-581`) and `sha256sum -c --quiet` print nothing on success.
- **`fixtures.sh` prints exactly 6 `case` lines plus the 2 end markers.** Its `run` order equals `NEGATIVE_CASES`. Rejecting 124/137 for `nz` is stricter than `fixtures.sh` itself, which is correct.

**Exception paths:** every nested access is preceded by `exact_keys`/type checks or short-circuits. For JSON-derived inputs, which always have str keys, I found no uncaught exception.

## Actionable items

### P1: the final evidence does not bind the checked DB or the helper argv (contract gap)
**Where:** `final_state_status` (`:475-536`), `PROV_KEYS` (`:439-440`), `PIN_KEYS` (`:442-443`), `REPORT_EV_KEYS` (`:438`).

**What is missing:**
- **The DB identity:** there is no view, manifest or descriptor identity, logical size, part count or kind.
- **The argv:** only `report.outArg` is bound. The helper path executed and the `--db`, `--static-files`, `--rocksdb` and `--plain-hashed` arguments are not.
- **What is unbound as a result:**
  - `staticFilesBefore/After` and `rocksdbAbsentBefore/After` are not tied to the paths the helper actually received;
  - nothing ties the 35 report to the production view.

**The failure scenario:** a future runner that records correct pins and lifecycle, but whose session exposed a different DB (or passed a different static-files dir), produces evidence that passes `final_state_status` → 35. The report itself carries no DB identity.

**Minimal correction:**
1. Add `helperArgv` (an exact list) to the evidence, and `helperPath`, `dbDir`, `staticFilesDir` and `rocksdbPath` to the pins. Require exactly `argv == [helperPath, "--db", dbDir, "--static-files", staticFilesDir, "--rocksdb", rocksdbPath, "--out", reportPath, "--plain-hashed"]`, and derive `outArg` from it.
2. Add a `view` object to the evidence and pins: `kind == "production"`, `manifestSha256`, `descriptorSha256`, `logicalSize` (int), `parts == 265`, and `receiptSha256` (the fields r6 writes to `receipt["view"]`, `composite_session.py:218-221`). Require exact equality, with `postUseOk` still required.

**Regressions:** one mutation per new element (wrong `--db`, a different SF dir, a missing `--plain-hashed`, reordered argv, fixture kind, a different manifest or part count) → final 10.

### P2: three evidence fields do not match what r6/r10 record (false rejection, or a risky caller normalization)
- **`softStop`:** `evidence.softStop` must be literal `False` (`:498`), but r10 records `mem["softStop"]` as `None` or a reason **string** (`memory_gate.py:356,369`).
- **`cancelled`:** `evidence.cancelled` must be `False`, but r6 records `interrupted` as `None` or a string.
- **`countersReadable`:** `memory.countersReadable` does not exist in r10, which folds unreadable counters into `memoryDirty` via `dirty(before, after)`.

**The risk:** a caller passing r10's raw values is falsely rejected. A caller that "normalizes" with truthiness (`bool(x)`) re-introduces the coercion root 1872 #3 forbids.

**Minimal correction:** accept the native forms exactly:
- `softStop is None` (a string → fail);
- `interrupted is None`;
- `countersReadable` defined as both `eventsBefore` and `eventsAfter` being dicts.

Or keep the booleans, but document the exact mapping in the module docstring and add one regression per raw form.

### P3: exception robustness for caller-built (non-JSON) inputs (minor)
- **`exact_keys` (`:111-120`)** calls `sorted()` on the missing and extra key sets. A Python dict with mixed key types (for example `{1: …, "x": …}`) raises `TypeError` out of `classify_state`/`final_state_status`/`check_fixture_capture`, instead of returning 7/10/invalid. It is fail-closed **only if** the caller treats an exception as failure.
- **Correction:** `sorted(map(repr, …))`. Separately, wrap the bodies of the three public entry points in `try … except Exception` → 7 / 10 / `outputValid: False`.
- **Regression:** for each evidence/lifecycle/memory/pins key, substitute `None`, `[]`, `"x"`, `True`, `2**70`, `{1: 2}`. Assert there is no exception and the result is 10, 7 or invalid.

### P4: `final_state_status` preserves ANY non-35, non-0 int (minor)
- **Where:** `:485-486`. For example −9, 256 or 10⁹ are "preserved".
- **Why it matters:** a shell exit is 0..255, so other values indicate a caller bug.
- **Correction:** if not `1 <= runtime_rc <= 255`, return 10.
- **Regression:** −9, 256 and 35+256 → 10.

## Remaining limits (not defects in this module)
- **The golden report is synthetic** (`tests/test_acceptance.py:6,19`). No compiled r11 output exists, so the first real reports may still disagree on serialization details. The ones to check first: the `B256` Display form (expected `0x` plus 64 lowercase hex), `{o:?}` sample strings, and pretty-printed whitespace (harmless to the loader).
- **`check_fixture_capture` validates the caller's bytes only.** It does not bind the `## outputs` directory, the per-case result files or `binaries.sha256`, and `authenticated` stays `False`, correctly. A future trusted wrapper must run the frozen script and supply the identities itself.
- **No canonical claim:** a 35 from this module means "the supplied report and evidence are internally consistent". The other prerequisites stay open: the production structural CLEAN, header extraction, the full runner lifecycle integration, the canonical check and explicit recovery acceptance (root 1872 #6).
