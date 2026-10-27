# 1873: state-helper-qualification-stage/r1, pure acceptance predicates for the r11 state helper (SOURCE ONLY; tests PREPARED, NOT RUN)

**Scope:** the first reusable component of the state-runner plan. Inputs: plan 1867, review 1869, and root 1868 and **1872 (which takes precedence)**.

**What I did not do:**
- no tests, builds, queue jobs, mounts, network, installs, data/part/backup reads or commits;
- no edits to any older stage. Verified intact afterwards:
  - bsro r9/r10/r11;
  - cmv r6/r10;
  - mvv r6.
- the r10/r11 namespace queues are untouched.

**What this stage is NOT:**
- a production runner, header extraction, child-process control or compiled-fixture run;
- any qualification of those.

Nothing here is canonical proof, recovery acceptance or original-reset authority.

## Frozen stage
- **SHA256SUMS sha256:** `state-helper-qualification-stage/r1/` → **`25ca8ece39facad5b1ffc4b1c1ef821324f205f9c8b0d8b5c58b23111edf52a7`**
- **Contents:** 4 files, all a-w; SUMS excludes itself; no runs/`__pycache__`.

| file | sha256 |
|---|---|
| `acceptance.py` | `81c3fd3c9d25bfd0ed2c3a92ddf098fa3902fdd7f4e2ab0ddab50b5245636769` |
| `tests/test_acceptance.py` | `60f38a4184669c44a07b43eabffc7f8c7af1d35b1c623193247f249081328951` |
| `jobs/tests.sh` | `a8fbb824d98d1c2d45420ca9ea502fb2543efb42082376d2b3a22fe59c3e46aa` |
| `README.md` | `cbf54f5988a039f0b2e8558ac1b1d513063dbb9cab25c90326beff847ccbcf38` |

**Pins inside `acceptance.py` (frozen r11, which test 37 re-hashes):**
- SUMS `246ff06b…`;
- `src/main.rs` `5a6fa214…`;
- `jobs/positive.sh` `24b8c3e9…`;
- `jobs/fixtures.sh` `fc1e2842…`.

## `acceptance.py`: stdlib only (`hashlib`, `json`, `re`); never runs a process or opens a file (test 38 checks this by AST)
**`load_json_strict`:** accepts bytes only, with a size cap (32 MiB). It rejects:
- strict-UTF-8 failures and a BOM;
- duplicate keys at any depth (`object_pairs_hook`);
- NaN/±Infinity (`parse_constant`);
- **any float** (`parse_float`; the r11 report has none);
- malformed or trailing text, excessive nesting, and a non-object top level.

**`report_schema_errors`: schema validity (pass OR fail)**
- **Keys:** the exact 24 top-level keys and every nested key set: `tipHeader`, `stateRoot`, `trieCache`, `plainVsHashed` (NOT_RUN / NOT_APPLICABLE_V2 / v1 PASS|FAIL), `historyIndexCheckpoints` and `storageSettings`. Missing or extra keys fail.
- **Types are exact:** `type(x) is int` (a bool is never an int); u64 range; flags literally `true`/`false`; hashes `0x` + 64 lowercase hex.
- **Constants:** every r11 literal string.
- **The report's own derived flags must agree with its values,** as `main.rs` derives them:
  - `computed == fromHashedOnly`;
  - `matchesHeader`, `cachedWalkMatchesHeader`, `cachedWalkEqualsFromHashedOnly`;
  - `checkpointsCoherent`, and `checkpoints.Finish == finish`;
  - the index checkpoints == the `checkpoints` entries;
  - the RocksDB classification vs v2 / `CURRENT`;
  - ABSENT ⇒ the 3 index checkpoints are 0;
  - the adapter vs v2;
  - the trie status vs counts, and the sample count;
  - the plain status vs layout;
  - `fullStateIntegrity`.

**`derived_exit`:** `main.rs`'s rule (4 / 0 / 5) recomputed from the report.

**`production_v2_errors`: the passing PARTIAL-v2 predicate, separate from the schema.**
- v2 and Packed;
- RocksDB ABSENT and not present; the 3 index checkpoints exactly 0;
- the 5 checkpoints == `finish`, and coherent; `tipHeader.number == finish`;
- hashed-only root == computed == the header `stateRoot`; cached walk == hashed-only root;
- trie cache 0/0 with no samples;
- plain `NOT_APPLICABLE_V2` with **nonnegative counts, not required zero** (root 1868/1872);
- not full; derived exit 5.

**`classify_state(lifecycle, child_rc, report_raw, memory)`:** typed contracts `lifecycle{postUseOk,timedOut,groupLeftovers,groupEmpty,orphansGone,escapedKilled}` and `memory{memoryDirty,countersReadable}`. Precedence:

| step | condition | result |
|---|---|---|
| 1 | malformed lifecycle | 7 |
| 2 | post-use false | 8 VOID |
| 3 | lifecycle faults | 7 |
| 4 | child 3 with **no** report | **30** (child 3 with a report → 7) |
| 5 | child 4 with a schema-valid report deriving 4 | **34** |
| 6 | child 5 with a schema-valid report deriving 5 that passes the predicate | **35** |
| 7 | anything else (0, 1, 101, signals, bool/str rc, a missing/malformed/contradictory report) | 7 |
| 8 | memory dirty/unreadable/malformed, applied to 34/35 only | 7 |

The predicate is never applied before the rc 3/4 classification (root 1872 #2). Every result carries `canonical: false, resetAuthority: false`.

**`final_state_status(runtime_rc, evidence, report_raw, pins)`:**
- **runtime 35:** stays 35 only with the exact typed `state-final-evidence/r1` record and typed pins. Required:
  - cleanup complete, not cancelled, no soft stop, snapshots OK, peers unchanged, no mount or process left;
  - the report path == the pin == the `--out` arg; sha256 and size bind the bytes; a regular non-symlink file;
  - helper sha before/after, SUMS, and the build/positive/fixtures receipt shas == the pins;
  - the static files before == after (incl. dev/ino/mtime/ctime) == the pinned name/size/sha list;
  - the RocksDB path absent before/after;
  - a **re-classification == 35**.

  Anything else → **10**.
- **runtime 0 or a non-int:** 10.
- **Any other nonzero rc:** preserved and never usable. **35 is never preserved on missing evidence.**

**`check_fixture_capture`:**
- **positive:** exactly the 26 `case <label>: PASS` lines in `positive.sh` order, then `## runs=26 failed=0`, `## outputs /abs`, `## bsro-r11-positive rc=0`.
- **fixtures:** exactly the 6 `case <name> rc=… expect=… unchanged=y PASS` lines in order (rc 3; corrupt-mdbx nonzero, not 124/137), then the two end markers.
- **Common rules:**
  - rc exactly 0; `timed_out`/`truncated` exactly false; ≤ 1 MiB; UTF-8; LF only; a final newline;
  - no missing, duplicate, extra or failed labels;
  - the observed identities (SUMS, script, helper, mk_fixture, build receipt) == the caller's expected ones; the expected SUMS/script must be the frozen r11 pins.
- **The result is `outputValid` with `authenticated: false`.** It is NOT a receipt; only a future wrapper that itself ran and captured the script can make one.

## Prepared tests (NOT run): 38, `jobs/tests.sh` on the 256 lane
| group | count | tests |
|---|---|---|
| loader | 3 | duplicates; nonfinite/floats; malformed |
| schema/predicate | 14 | golden valid + passing; each top or nested key missing/extra; bool-vs-int both ways; wrong types/ranges/hex; every constant; every internal consistency; **nonzero plain counts accepted**; negative/bool counts rejected; altered roots; altered checkpoints (incl. header number); trie inconsistencies; production-specific shapes (PRESENT, v1 full → derived 0, NOT_RUN, the old typo); frontier/marker/progress |
| classify | 10 | rc3 no report → 30 (memory-independent); rc3 with report → 7; rc4 valid failing → 34; rc4 missing/malformed/inconsistent → 7; rc5 → 35 (not canonical); rc5 predicate failures → 7; other codes (incl. bool/str/float) → 7; post-use → 8 before everything; lifecycle faults and malformed lifecycle → 7; memory dirty/unreadable → 34/35 to 7 |
| final | 4 | complete evidence → 35; 35 with ~30 individual evidence/binding faults → 10; runtime 0 / non-int → 10 and others preserved; bad pins → 10 |
| fixture capture | 5 | exact positive (26); positive faults (missing, duplicate, extra, FAIL, mk failure, failed=1, rc=1, CRLF, no newline, noise, order, relative outputs, empty, rc/timeout/truncated, > 1 MiB, unknown kind); exact negative (6); negative faults (124/0/137, wrong rc, unchanged=n, FAIL, missing/duplicate/order, markers, extra line, expectation); identity mismatches |
| source/purity | 2 | the pins re-hashed against frozen r11; every constant/key/StageId/label/case found in that source; the module imports only hashlib/json/re and uses no open/os/subprocess/exec/eval |

**The job's gate:** "Ran 38", last line "OK", empty stdout, no ResourceWarning/skipped/FAIL/ERROR/Traceback. It writes `state-acceptance-test-receipt/r1` bound to SUMS.

**Command:**
```
bash jobs/q-exit-status.sh sq-r1-tests 256 unshare -Urn bash state-helper-qualification-stage/r1/jobs/tests.sh
```

**Golden and captures are synthetic.** `GOLDEN` is a literal, written from the documented r11 schema; it does not import the module's constants, so a typo in a module constant fails test 04 and test 37. It is never runtime evidence. All captures are synthetic parser inputs and never qualify compiled fixtures.

## Static checks done (no execution of the code under test)
- `ast.parse` of both Python files; `bash -n` on `tests.sh`; 38 `test_*` functions counted by AST.
- Each mutation was traced against the module **by reading only. The tests have not been run,** so a logic or test bug may still surface on the first run.

## Limitations
- **Unimplemented, and must be bound by the future runner:**
  - real process/output/provenance capture;
  - the production state runner (the 1869 §2 seam);
  - header extraction (1869 §4, root 1871/1872 #5);
  - the fixture-capture wrapper that turns `check_fixture_capture` into an authenticated receipt.
- **The evidence and pin contracts are my definition** (`state-final-evidence/r1`; static-file identity fields). The future runner must emit exactly these, or the contract must be revised and reviewed together.
- **`classify_state` covers exec/post-use/memory only.** Cleanup-incomplete (4), cancellation/soft stop (5) and refusals before the exec stay with the reused r6 `main` precedence; they are also required by `final_state_status`.
- **The positive capture accepts only a fully passing run's exact text.** Any stderr noise interleaved in a real capture fails it, which is fail-closed.
- **Test 37 reads the frozen r11 source files** (source, not data). If that stage is moved, the test fails; it is never skipped.
- **No real r11 report exists.** The real values (Finish, the index checkpoints, plain counts, `withdrawalsRoot`) are unknown; a real report that differs in shape (e.g. a serde key order or representation not covered here) would be 7, which is fail-closed.
- **Production stays on HOLD.** A 35 remains self-consistency only. The structural CLEAN, the G8 canonical check and the final recovery acceptance are still required.
