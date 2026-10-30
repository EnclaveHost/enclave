# 1919: state-production-validation-stage/r5 = r4 + the ACTUAL archived extractor e2e 8 PASS (SOURCE ONLY; FAIL-CLOSED)

## Status
- **Created:** `state-production-validation-stage/r5` only.
- **No execution by me:** no test, queue job, build, network, mount/VM action, commit, or chain/backup/part/header-content read. The only checks were static: `ast.parse`, `bash -n`, `sha256sum` / `-c`.
- **Small named files read:**
  - the 1918 archive (README, `che-r3-e2e-1915.*`, `e2e/*`, `che-r3-extract-1916.out`, the archived inner/outer receipts);
  - `logs/che-r3-e2e-1915.*`;
  - the original e2e run dir's stderr/stdout (hashes only);
  - the two ORIGINAL production extraction receipts (hashes only).
- **Untouched:** r4 (SUMS `5b543e00…`, re-verified), every other stage, the Rust code.
- **Results:** **no r5 test has run.** The structural r10 scan is RUNNING and is not treated as passed. No Rust build and no fixture captures exist.

## Files (frozen, a-w)
| file | sha256 |
|---|---|
| `SHA256SUMS` | **`5dd83dd914406e41ee06e1db8558cf4b693325aa53b850c263da9bcd22756baa`** |
| `state_gate.py` | `54ec3e6292225923f4db6134fe159ffed2a35c8eb8e3042f3041f493e0741632` |
| `tests/test_state.py` (**27 tests**) | `42dd2d79515afbe22c0553985d42cd4f0e296bce06dae081413e374b680be7b2` |
| `jobs/tests.sh` (exactly `Ran 27 tests`, format `state-production-test-receipt/r5`) | `0b629e016140074e02f75630562678b8b5b400669543c0e7b97b74d2d11467fb` |
| `jobs/root-state-validate.sh` (r5 paths, r5 tests-receipt message) | `9a8bfbc45f6c6e411633cc9332b846c3c5a8389f27d5527513f6233e47e14be6` |
| `jobs/stop-session.sh` (r5 path) | `d81aa4ccc7ddbd8d973f0bd74956f921d081c8d2f52beb57ee92cefe41f125c8` |
| `composite_session.py` (byte-identical to r4; pin unchanged) | `52099d9f70a69d80fb96862a23c6316439a619ca7f2c9f92a88c0b8fe9856e9a` |
| `README.md` (r5 header, then r4's text) | `6001a2ae33babb3d91542093875e0278ed5cb69b9c808f16f959b0c9e13d3da3` |

## Exact diff `state_gate.py` r4 → r5 (everything else is unchanged; `PINS` unchanged)
1. **Docstring:** the r5 line. The "fail-closed now" text says `PRODUCTION_INPUTS` is None because there is no r12 build, no real 26/6 captures, and the structural run has no result.
2. **`OWN_TESTS`:** `("state-production-test-receipt/r4", 26)` → `("state-production-test-receipt/r5", 27)`.
3. **`EXTRACTOR_E2E_RAW = None` →**
   ```
   EVID_E2E = W + "/source/ops/rpc-recovery-qualification-20261026/recovered-view-extraction-1918"
   EXTRACTOR_E2E_ORIGIN_DIR = EX3 + "/runs/e2e-20261027T133216Z-3242045"
   EXTRACTOR_E2E_RAW = {
     "out":    (EVID_E2E + "/che-r3-e2e-1915.out",   "ee40de431d4b26f14f39e5b4f4652b54af33d2926b687faf7eeebc26f1c4f95e"),
     "rc":     (EVID_E2E + "/che-r3-e2e-1915.rc",    "9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa"),
     "guard":  (EVID_E2E + "/che-r3-e2e-1915.guard", "5f55951292b5f6cf74295678ca98f22908eda13ddd48edd7179c85c37b00cb1b"),
     "stderr": (EVID_E2E + "/e2e/stderr",            "007c655c805fc49c06a14d081851388c934473fb4328943b026a95e5b0845f0c"),
     "stdout": (EVID_E2E + "/e2e/stdout",            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")}
   ```
   - **`out`, `rc`, `guard`:** byte-identical to `logs/che-r3-e2e-1915.{out,rc,guard}`.
   - **`stderr`, `stdout`:** byte-identical to the original `<extractor r3>/runs/e2e-20261027T133216Z-3242045/{stderr,stdout}`. `stdout` is empty; that sha is the empty-file sha.
   - **The origin dir is taken from the preserved log's own line** `## outputs /home/steven/…/compact-header-extraction-stage/r3/runs/e2e-20261027T133216Z-3242045`, never from the archive path. It matches r4's unchanged `E2E_OUT_DIR_RE`.
   - **A comment block (DOCUMENTATION ONLY, not an input)** records the production extraction receipts (below).
4. **`BLOCKED["extractorE2E"]` message:** now says "unpinned → explicit block". The dict and the defensive `None` branch are kept.
5. **`verify_extractor_stage`:**
   - `read_raw_test(EXTRACTOR_E2E_RAW, 8, E2E_OUT_DIR_RE, e2e=True, origin_dir=EXTRACTOR_E2E_ORIGIN_DIR)`. This is r4's unchanged origin handling, the same as the archived unit receipts; `raw_test_errors` is not loosened.
   - **New:** the pinned stderr is re-read and its sha re-checked, and it must contain exactly 8 `… ok` lines. That gives exactly 8 PASS: no skip or expected-failure line can hide inside "Ran 8 / OK", on top of the existing `skipped` marker refusal.
6. **Comment** on the `verify_extractor_stage()` call.

**Why the actual bytes pass r4's unchanged parser** (checked by reading them):
- rc is `0\n`;
- stderr holds 8 `… ok` lines, one `Ran 8 tests in 25.690s`, and `OK` last;
- no ResourceWarning, skipped, Traceback, FAIL or ERROR;
- **the log (`out`)** runs, in order:
  1. `[queue] START …`;
  2. stderr's tail;
  3. exactly one `## PASS (8)`;
  4. `## workspace /vm/…/compact-header-e2e-20261027T133216Z-3242045 (kept for review; owned; remove after review)`;
  5. `## outputs <origin>`;
  6. two `[memory-guard]` lines (the guard file's single line among them);
  7. `[queue] EXIT 0`.

## Tests (27)
- **04 (updated):**
  - `EXTRACTOR_E2E_RAW` is pinned and `PRODUCTION_INPUTS` stays None;
  - with the REAL extractor stage check (SUMS + unit 25 + archived e2e 8 passing), the REAL `verify_extraction` refuses the placeholder pins ("the extraction receipt is not …");
  - a private instance with `EXTRACTOR_E2E_RAW = None` still refuses "BLOCKED extractorE2E" (never a skip);
  - the all-stubbed case still returns True.
- **22 (updated):** synthetic parser cases (unchanged), plus: the ACTUAL archived e2e passes `read_raw_test` with its origin, and `verify_extractor_stage()` returns the pinned module (with `state_pins`).
- **27 (new) — archived e2e origin/hash regressions:**
  - the exact origin dir and the 5 exact pins, all under the archive;
  - the log contains `\n## outputs <origin>\n` and no archive path;
  - 8 `… ok` lines, and no skipped / expected failure / unexpected success / FAIL / ERROR;
  - rc `0\n`; passes with its origin;
  - **refusals:**
    - no origin (archive physical dir ≠ the run dir);
    - 8 wrong or malformed origins: another ID, the unit origin, the archive e2e dir, a subdir, relative, non-normalized, the extract run dir, a non-str;
    - n 7 / n 25 / non-e2e; the unit dir regex;
  - **copies:** a byte-identical copy passes; each of the 5 files with one changed byte (pins unchanged) refuses;
  - **changed AND re-pinned** (skip injected, Ran 7, a different `## outputs` origin) refuses through the unweakened parser;
  - **a stage instance** with a wrong pinned guard sha, or a wrong `EXTRACTOR_E2E_ORIGIN_DIR`, refuses in `verify_extractor_stage`.

**Root command (focused, 256):**
```
bash jobs/q-exit-status.sh spv-r5-tests 256 unshare -Urn bash state-production-validation-stage/r5/jobs/tests.sh     # expect "Ran 27 tests", OK, receipt pass
```

## The actual production extraction (root 1916), for a future `PRODUCTION_INPUTS`. NOT bound, NOT trusted from metadata
- **Inner receipt (original):** `/vm/enclave-volumes/tr004-base-recovery-20261026/compact-header-extraction-20261027T133308Z-3243320/EXTRACTION-RECEIPT.json`, sha256 `18494bbdffcf468441398051559f54cbeeee3d38a3905cbfc390d3e75960e416`.
  - The archive copy `…/recovered-view-extraction-1918/extraction/EXTRACTION-RECEIPT.json` has the same sha.
  - Content: format v1, rc 0, CLEAN, `totalBytes` 362900885, `backupReceiptSha256` `928d09ba…`, 7 files.
- **Outer job receipt (original):** `<extractor r3>/runs/extract-20261027T133307Z-3243269/JOB-RECEIPT.json`, sha256 `50e433f82bf1b50939edfd78f169839affe097554d0fa7be2484f11c9ed4fd2e` (same as the archive copy `extract-job/JOB-RECEIPT.json`).
  - Content: `finalRc` 0, `extractRc` 0, `extractionReceiptPath` = the inner path, `extractionReceiptSha256` = `18494bbd…`, stage SUMS before = after = `ee657a9d…` (= our `extractorSums` pin), `peersEqual` true, `jobDir` = its own parent, no authority.
- **The pins a future reviewed revision would put in `PRODUCTION_INPUTS`:**
  - `"extraction": [<inner original path>, "18494bbd…"]`;
  - `"extractionJob": [<outer original path>, "50e433f8…"]`;
  - `"staticFilesDir": "/vm/enclave-volumes/tr004-base-recovery-20261026/compact-header-extraction-20261027T133308Z-3243320/files/data/static_files"`;
  - `"staticFiles"`: the six header entries in allowlist order, as `state_pins` derives them from the inner receipt:

| name | size | sha256 |
|---|---|---|
| `static_file_headers_52500000_52999999` | 318751407 | `a50b7a37496cae527f460635259b7d6cd4d6c9efe8dc343490df1ae4d2156e50` |
| `static_file_headers_52500000_52999999.conf` | 75 | `fa1fa21e667484e16970733cfeffea9c70ac83ec45adf8f87a168634fa74d7be` |
| `static_file_headers_52500000_52999999.off` | 12000009 | `02ceb930f34dc57e3e3e7e35966dcc4be866570ee0df6272e472e39c58af53b7` |
| `static_file_headers_53000000_53499999` | 30982072 | `aea3a6334d373c721ef1eb9d3adc032812617754ba9a9bef07dcb27938874652` |
| `static_file_headers_53000000_53499999.conf` | 75 | `f84fe41406d7df2072eb6a61ec5ce0880905ae9ff5aa3c1db30e898b86d2659a` |
| `static_file_headers_53000000_53499999.off` | 1164657 | `515fd24a31206ccf32ea88f51b250a3bcfe009fa1e8db4d4fc530147f1562b91` |

`data/reth.toml` (2590 B) is excluded by `state_pins`.

**I did not execute `state_pins`.** The table is read from the receipt JSON, so the reviewed revision must take it from the function's actual output.

**The runtime still verifies the actual bytes and identities.** It does not trust archive metadata:
- `verify_extraction` re-reads the ORIGINAL inner/outer files once (sha-pinned, unchanged afterwards) through the pinned extractor's `state_pins(receipt_raw, run_dir, job_raw, stage_sums)`;
- it checks the path shapes, no symlink ancestors and /vm 253:1;
- `staticFilesDir`/`staticFiles` must equal the inputs exactly;
- `static_identities` re-hashes every static file, plus dev/ino/mtime/ctime, before and after the helper.

## Pending gates (unchanged controls; `PRODUCTION_INPUTS = None`)
1. **The r12 Rust build:** not run. It must be a verified `finalRc` 0 build receipt.
2. **Capture r3 positive 26 / fixtures 6:** not run; they need the build.
3. **The structural cmv-r10 production run (1917):** RUNNING, with no result. It needs final 0 + a CLEAN session of the same ID over the production view.
4. **The production view record:** it must equal the structural session's `receipt["view"]` bytes.
5. **`spv-r5-tests`:** actual 27/27.
6. **Then** a reviewed revision fills `PRODUCTION_INPUTS` from those ACTUAL receipts (incl. the extraction pins above).

**Already satisfied:**
- all 265 parts verified (root);
- extractor unit 25 + e2e 8 actual (now bound);
- production extraction inner + outer CLEAN (to be pinned, and re-verified at runtime).

**No authority claimed:** none of this is a structural, canonical-state, recovery, readiness or reset acceptance.
