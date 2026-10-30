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
