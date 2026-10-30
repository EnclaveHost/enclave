# state-helper-qualification-stage/r2: r1 + review 1875 P1-P4 (PREPARED by Claude 1878; NOT run; NOT PASS)
Report: ../../logs/claude-state-acceptance-fix-1878.md. Frozen r1 (`SHA256SUMS` `25ca8ece…`) is unchanged; r1's receipt does NOT carry over.

**Unchanged from r1:** the r11 report schema, `derived_exit`, the production v2 predicate, the classification order, the fixture-capture
parsers and the r11 pins (SUMS `246ff06b…`, `main.rs` `5a6fa214…`, `positive.sh` `24b8c3e9…`, `fixtures.sh` `fc1e2842…`).
The r12 fixture-script work by another author is NOT reflected here.

**r2 changes:**
- **P1 (final evidence binds the DB and the argv).** Evidence format `state-final-evidence/r2` adds `helperArgv` and `view`; the pins
  add `helperPath` (absolute, normalized, basename `base-state-readonly`), `runDir`, `staticFilesDir` (outside the run dir) and `view`
  (the r6 `receipt["view"]` fields), and drop `reportPath`. The argv must equal EXACTLY
  `[helperPath, --db, <runDir>/work/db, --static-files, staticFilesDir, --rocksdb, <runDir>/rocksdb-absent, --out,
  <runDir>/state-report.json, --plain-hashed]`. The report path is `<runDir>/state-report.json`. The view must be `kind: production` with
  `parts: 265`, 64-hex manifest/descriptor/receipt shas, a positive `logicalSize`, and must equal the pinned view exactly.
- **P2 (native fields, exact).** `evidence.interrupted` = r6 `receipt["interrupted"]` (`null` or a string; only `null` passes).
  `memory` = r10 `receipt["memory"]` subset `{memoryDirty, softStop, eventsBefore, eventsAfter}`: only `softStop: null`,
  `memoryDirty: false` and counters re-derived clean (both objects; `oom`/`oom_kill`/`oom_group_kill` exact ints; no increase) pass,
  and `memoryDirty` must agree with that re-derivation. r1's `cancelled`/`softStop` booleans and `countersReadable` are gone.
- **P3 (fail closed).** Every public function catches `Exception` only: malformed input gives 7 / 10 / an error list / `None` /
  `outputValid: false` / `Invalid`. `SystemExit`, `KeyboardInterrupt` and `GeneratorExit` always propagate. `exact_keys` sorts reprs.
- **P4.** `final_state_status` returns 10 for a runtime rc outside 0..255.

**Tests:** `jobs/tests.sh` requires exactly `Ran 46 tests` (r1's 38 adapted + 8 regressions, 39-46).

**Limits (unchanged in kind):** everything here is pure and every input is SYNTHETIC or caller-supplied. Nothing here runs or captures
the helper, exposes a view, or records evidence. The future runner must produce these fields from the real r6/r10 receipts. Nothing
is a compiled-fixture qualification, a state result, canonical proof, recovery acceptance or reset authority.

---
(r1 README follows, unchanged)

# state-helper-qualification-stage/r1: pure acceptance predicates for the base-state-readonly r11 state helper (PREPARED by Claude 1873; NOT run; NOT PASS)
Report: ../../logs/claude-state-acceptance-implementation-1873.md. Plan 1867, review 1869, root 1868 + 1872 (the root corrections take precedence).

**What this is:** the FIRST reusable component of the state-runner plan. `acceptance.py` is stdlib-only and **pure**:
- it never executes a process;
- it never opens a file or touches a mount;
- it never reads production, part or backup data.

Every input is a value handed over by a future trusted caller.

**What this is NOT:**
- a production runner, header extraction, child-process control, or a compiled-fixture run;
- any qualification of them.

Passing its tests qualifies these pure functions only. Real process, output and provenance capture is unimplemented and must be bound by the future runner. No result is canonical-chain proof, recovery acceptance or original-reset authority (`canonical: false`, `resetAuthority: false` on every result).

## Functions
| function | contract |
|---|---|
| `load_json_strict(raw, cap)` | bytes → object. Rejects: not UTF-8, a BOM, duplicate keys (at any depth), NaN/Infinity, ANY float, a non-object top level, more than `cap` bytes. |
| `report_schema_errors(doc)` | the exact r11 report schema (24 top keys, every nested key set; missing or extra fails), exact types, and the r11 literal constants. The report's own derived flags must agree with its values, as `main.rs` derives them. Schema validity ≠ passing (a valid report may describe failed checks). |
| `derived_exit(doc)` | `main.rs`'s exit rule recomputed from the report: 4 / 0 / 5 |
| `production_v2_errors(doc)` | the passing PARTIAL-v2 predicate (below) |
| `classify_state(lifecycle, child_rc, report_raw, memory)` | the precedence below |
| `final_state_status(runtime_rc, evidence, report_raw, pins)` | the final gating below |
| `check_fixture_capture(kind, captured, rc, timed_out, truncated, observed, expected)` | exact frozen-r11 `positive.sh` (26 runs) / `fixtures.sh` (6 cases) output and identities; `authenticated: false` |

**Exact types:** `bool` is never an int (`type(x) is int`), and flags must be literally `true`/`false`. Integers are 0..2^64−1; hashes are `0x` + 64 lowercase hex.

**The passing predicate (`production_v2_errors`):**
- v2 (`storageSettings == {storage_v2: true}`, present), `PackedKeyAdapter`;
- RocksDB ABSENT with `rocksdbCurrentPresent: false`, and the 3 index checkpoints exactly 0;
- `finishUnitCheckpoint` ∈ {`none`, `Finish(partial_state_trie: None)`}; frontier `none`; no unwind marker; progress null or 0;
- Execution, AccountHashing, StorageHashing, MerkleExecute and Finish all == `finish`, and coherent;
- `tipHeader.number == finish`;
- `fromHashedOnly == computed == tipHeader.stateRoot` with `matchesHeader`; `cachedWalk == fromHashedOnly`;
- trie cache PASS with 0/0 and no samples;
- plain `NOT_APPLICABLE_V2` with **nonnegative counts, NOT required zero** (root 1868/1872);
- `fullStateIntegrity: false`; derived exit 5.

**`classify_state` precedence:**
1. A malformed lifecycle record → 7.
2. Post-use false → **8 VOID**.
3. A timeout, leftovers, a non-empty group, orphans or escaped processes → 7.
4. **Then** the child rc:
   - 3 **without** a report → **30 STATE-REFUSED**;
   - 4 with a schema-valid report deriving 4 → **34 STATE-FAILED**;
   - 5 with a schema-valid report passing the predicate → **35 STATE-PARTIAL-V2**;
   - anything else (0, 1, 101, signals, bools, a missing/malformed/contradictory report) → **7**.
5. Memory dirty, unreadable or malformed turns 34/35 into 7.

**`final_state_status`:**
- runtime 35 stays 35 **only** with:
  - the exact typed evidence record (`state-final-evidence/r1`): cleanup complete, not cancelled, no soft stop, snapshots OK, peers unchanged, no mount or process left;
  - report path == pin == the helper `--out`; sha and size bind the bytes; a regular non-symlink file;
  - the helper sha before/after, SUMS, build/positive/fixtures receipt shas == the pins;
  - the static files before == after (incl. ctime) == the pinned extraction;
  - the RocksDB path absent before/after;
  - a re-classification of the bound inputs == 35.
- Otherwise → **10**.
- Runtime 0 or a non-int → 10.
- Every other nonzero runtime rc is preserved and never usable.

**Pins (frozen r11):** SUMS `246ff06b…`, `src/main.rs` `5a6fa214…`, `jobs/positive.sh` `24b8c3e9…`, `jobs/fixtures.sh` `fc1e2842…`. Test 37 re-hashes them and checks every constant, key, label and case against that source.

## Tests (PREPARED, NOT RUN)
**Suite:** `tests/test_acceptance.py`, 38 pure tests (loader 3, schema/predicate 14, classify 10, final 4, fixture capture 5, source/purity 2).

`GOLDEN` there is a **synthetic** report literal, written from the documented r11 schema. It is not runtime evidence; all captures are synthetic parser inputs.
```
bash jobs/q-exit-status.sh sq-r1-tests 256 unshare -Urn bash state-helper-qualification-stage/r1/jobs/tests.sh     # PASS: Ran 38, OK
```
