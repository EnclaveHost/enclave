# 1890: state-production-validation-stage/r1, the production state-runner integration (SOURCE ONLY; NOT run; NOT PASS; FAIL-CLOSED)

**Scope of MY activity:**
- **Created** the new stage `state-production-validation-stage/r1` only.
- **Read:** roots 1868/1872, my 1869, composite r6 `composite_session.py`, r10 `memory_gate.py`/jobs, and acceptance r3.
- **The only checks I ran:** Python/bash syntax checks and `sha256sum -c`.
- **Not done:** tests, builds, queue jobs, mounts, namespaces, network, data/backup/part reads, or commits.
- **Untouched and re-verified clean:** frozen acceptance r3, bsro r12, composite r6 and r10.
- **Not touched at all:** capture r3 (task 1889) and the compact extractor (under review).
- **Not claimed:** any compiled helper, fixture run or production run.

| file | sha256 |
|---|---|
| **`SHA256SUMS`** | **`47a87af0e87b981b832ddedc020d1e56251900e8062f839b334cc08931cab355`** |
| `composite_session.py` (r6 + seam) | `52099d9f70a69d80fb96862a23c6316439a619ca7f2c9f92a88c0b8fe9856e9a` |
| `state_gate.py` | `23ecd4cff10e5b16778171b283a9ec476a1a5095768f84f2cdbf87944a9a2249` |
| `jobs/root-state-validate.sh` | `50c4fd5d57dd4ded1545416570131950bbee6e0e09826583507e68152a2041c5` |
| `jobs/stop-session.sh` | `73464606f96c2fef74625c92d8385ff5813d7d7cbe695a87470de43f467af65c` |
| `jobs/tests.sh` (exactly `Ran 14 tests`) | `4686676074b95180233a0caec022d8963d776f8017ebf810ffdba4a129dd2c6d` |
| `tests/test_state.py` (14) | `1ca397383a104c7d4dea9d11b774be74e2021dc6886425716671636e4d93a6db` |
| `README.md` | `fd9b77f9d743f110781f2bd263a0aee1919a40d91d026c7de2a26ae83bfd9d27` |

## 1. The seam (argv AND report path, one place; no `fixture_exec`)
**What changed:** `composite_session.py` = r6 (`407aa7e9…`) with ONE refactor:
- `Session.exec_plan()` returns `(argv, limit, report_path)`. Its default is r6's exact choice: the fixture exec, or the pinned `mdbx_check.py` + `mdbx_chk` writing `<run>/mdbx-report.json`.
- `use()` takes both values from it, keeps `report_raw` (the exact bytes it hashed), and records `reportPath`.
- `OUTPUT_NAMES` gains `state-report.json`, so a used run dir is refused.

**Everything else is r6.** Test 1 checks this by AST over every module and class node. Test 2 checks that the default plan equals r6's literal argv, and that `use()` neither references `fixture_exec` nor contains the `mdbx-report.json` literal.

**`StateSession.exec_plan`** is built on r10's `MemorySession` (from `make_memory_session`) and calls `state_exec_plan`:
- **It refuses:** a kind other than production, any `fixture_exec`/`fixture_unmount_exe`, or a db dir that is not `<run>/work/db`.
- **The argv:** `argv = acceptance r3 expected_argv(pins)` = `[helperDir/base-state-readonly, --db <run>/work/db, --static-files <pinned dir>, --rocksdb <run>/rocksdb-absent, --out <run>/state-report.json, --plain-hashed]`. The report path is `<run>/state-report.json`. **No CLI argument can change any element**; the runtime's own args before `--` are only `--tree-root-pid`.
- **Before the exec:** `state-report.json` and `rocksdb-absent` must be absent. The helper's streamed sha must equal the pin. The static-files dir must hold EXACTLY the pinned files, matching name/size/sha in pinned order, plus dev/ino/mtime/ctime.
- **After the exec (`use` wrapper):** the helper sha, the static identities and RocksDB absence are re-read into the acceptance `PROV` record. Any mismatch or read failure sets `post_ok` false, which gives VOID 8.

## 2. Classification and final status (acceptance r3 is the only judge)
**The runtime (`make_state_classify`, replacing r6 `classify` with the same signature):**
- **r6 `main` precedence comes first:** 4 CLEANUP-INCOMPLETE, then 5 CANCELLED (incl. the r10 soft stop), then 3 REFUSED / 7.
- **Then:** the OOM counters are sampled exactly as r10's `memory_classify` does (`eventsAfter`, `memoryDirty = r10 dirty()`), and `A.classify_state(lifecycle, child rc, report_raw, memory)` decides:

| condition | code |
|---|---|
| post-use failure | 8 |
| lifecycle faults | 7 |
| helper 3 with no report | 30 |
| helper 4 with a schema-valid failing report | 34 |
| helper 5 with the full passing predicate | 35 |
| everything else | 7 |
| dirty or unreadable counters, a soft-stop string, or a malformed memory record (on 34/35) | 7 |

**The native mapping is exact:**
- `interrupted`, and `memory.{memoryDirty, softStop, eventsBefore, eventsAfter}`.
- A missing field makes the record malformed; a missing `softStop` is never read as "no soft stop".
- `lifecycle` uses r6's `exec_info` names plus `postUseOk` = (post-use recheck ok AND `stateProvenance` ok).

**The final status (`state_gate.py final O J RC ARC`, run under `ulimit -f 1024`):** `A.final_state_status` over evidence built from:
- the session receipt: `view`, the **observed** `children.exec.argv`, `stateProvenance`, `memory`, `interrupted`, `cleanupComplete`, `exec`;
- the r10 snapshot rules (the pinned `job-receipt.py` `status_ok`/`text`);
- the report bytes, read with no symlink follow. They must also equal the runtime's recorded `reportSha256`/`reportPath`; otherwise the sha is nulled, giving 10.

**Final codes:**
- 35 only if everything binds, else 10;
- runtime 0 → 10;
- other 1..255 → preserved;
- unpinned inputs → 10 for 35;
- any exception → 10, or the preserved non-35 code.

## 3. Reuse, resources, guards (no new framework)
**`gate`** mirrors r10 `gate` and calls the **pinned r10 functions**:
- `fsize_ok`;
- `check_qualifications` (r7/r4 receipts);
- `bind_scope` (the 4096 MiB lane, MemAvailable ≥ the 16 GiB floor + lane + headroom);
- `reservation` (the root target: remaining + floors incl. 40 GiB + 8 GiB native + the output budget; the /vm floor);
- r7 `check_view` (all 265 CONFIRMED, the incident manifest);
- `set_memory_high` as the only mutation, last.

It then execs `state_gate.py runtime --tree-root-pid P -- <r6 args> --expect-kind production`.

**`runtime`** repeats the scope checks, then installs `C.Session = StateSession(MemorySession(C.Session))` and `C.classify = state classify`, then calls `C.main`, the unchanged r6 lifecycle.

**Stop and guard:**
- **`stop`** = r10 `stop_session(session, script=THIS)`. Test 13 shows r10's `runtime_identity` accepts our runtime argv and refuses a fixture argv.
- **`guard`:** our `state_gate.py` gate/runtime processes (via the r6 `session_guard.script_of`), plus r10's own guard.

**The job (`root-state-validate.sh`)** follows r10's shape:
- the r6 `guards`;
- the state + memory guards;
- this stage's passing tests receipt;
- the r10 `collect-evidence.sh`, pinned `9f532285…`, run BEFORE and AFTER with `EVID_S6` = this stage, so our own session is not counted as a peer;
- `ulimit -f 32768` + `timeout -s TERM -k 600 (H*3600+1800)`;
- `final`, and `exit $final`.

**No original writes.** The root writes are the job files and the session's bounded logs and report (`CHILD_FSIZE` = r10 `CHILD_LOG_CAP`).

## 4. Fail-closed status and the precise remaining wiring (nothing synthesized)
**`PRODUCTION_INPUTS = None`.** `gate` refuses FIRST, after only the run-dir check, writing only `gate-refused.json` (test 3), and so does `runtime`.

**When a reviewed revision fills it, `verify_production_inputs` checks:**
- the exact shape (`input_shape_errors`, the same typed rules as acceptance `pins_errors`);
- r12 `verify_binaries(helperDir)`;
- that the build receipt binds r12 SUMS / `outDir` / helper sha, and the helper bytes equal the pin;
- **the structural prerequisite** (`verify_structural`): the pinned cmv-r10 job receipt passes r10 `evidence(…, 0, 0)`, and the pinned session receipt is a CLEAN, rc 0, cleanup-complete run over **the same view**.

**It then ALWAYS refuses on the two BLOCKED interfaces** (test 4):
- **`captureReceipts`:**
  - pin capture r3's SUMS/`capture.py` + its passing tests receipt, and load it pinned;
  - require `receipt_errors(rec, kind, expected) == []` for both kinds, with `expected` = {r12 SUMS, the r12 positive/fixtures script pins, helperSha256, mkFixtureSha256, the build receipt sha};
  - require `rec.buildOutDir == helperDir`.
- **`extractionReceipt`:** pin the extractor stage + its tests receipt, and require its per-file name/size/sha256 list == `staticFiles` and its destination == `staticFilesDir`.

**Then remove those two `refuse` lines and fill `PRODUCTION_INPUTS`** from the ACTUAL receipts: helperDir/sha, build receipt, the two capture receipts, the extraction receipt + static files, the structural job/session receipts, and the production view's r6 identity.

## 5. Prepared tests (14; root runs: `bash jobs/q-exit-status.sh spv-r1-tests 256 unshare -Urn bash state-production-validation-stage/r1/jobs/tests.sh`)

| test | what it checks |
|---|---|
| 1 | the seam copy is r6 except `use`/`exec_plan`/`OUTPUT_NAMES` (AST) |
| 2 | the default `exec_plan` is r6's literal argv; `use` takes argv + report from the seam |
| 3 | `gate`/`runtime` refuse first while inputs are unpinned; fixture/non-production args refuse |
| 4 | the BLOCKED tail always refuses, even with stubbed valid inputs |
| 5 | the exact argv/report from the pins; PROV keys |
| 6 | `exec_plan` refusals: fixture, kind, unmount, db, an existing report/RocksDB path, helper/static-file changes, an extra file |
| 7 | the after-provenance detects RocksDB creation, a helper change, an identity change, a deletion |
| 8 | the code table 30/34/35/7/8 |
| 9 | OOM increase, unreadable counters, a soft stop or a missing field downgrade 34/35 to 7 |
| 10 | final 35 only with complete evidence; 14 single mutations → 10 |
| 11 | runtime 0 → 10; codes preserved; out-of-range → 10; a missing native field → 10; report bytes, path, symlink and absence bound to the runtime's record |
| 12 | the input shape |
| 13 | `stop`/`guard` reuse and the job wiring (pinned `collect-evidence` sha, `ulimit`, `timeout`, `final`) |
| 14 | every pin equals the actual frozen bytes; the acceptance receipt is 46/46 |

**Synthetic inputs only:** the GOLDEN/failing reports come from acceptance r3's synthetic test module. **None is runtime evidence.**

## 6. Limits
- **No authority:** a 35 is self-consistent PARTIAL v2 state at the DB's own Finish header, never canonical proof, recovery acceptance or reset authority. The structural CLEAN is a separate required prerequisite.
- **Unmeasured:** memory fit (mmap page cache vs the 3840 MiB tree-RSS soft stop) and the duration of a full hashed-state + Verifier scan over FUSE/nbd. A soft stop is CANCELLED (5).
- **Exercised by unit tests only:** the lifecycle reuse (`make_memory_session` over the seam copy). No mount, view or helper has run.
- **Two gaps carried from 1884, for capture r3:** the `/vm` NVMe device binding, and RO for paths other than `/home/steven` and `/tmp`.
