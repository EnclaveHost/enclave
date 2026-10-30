# 1906: state-production-validation-stage/r3 = r2 + the compact-header extractor r3 adapter (SOURCE ONLY; NOT run; NOT PASS; FAIL-CLOSED)

**Scope of MY activity:**
- **Created** the new stage `state-production-validation-stage/r3` only.
- **Read:** report 1900; r2's actual 20/20 receipt (`r2/runs/tests-20261027T113056Z-3145879/receipt.json`: format r2, pass, rc 0, expected 20, ran `["20"]`, 5 checks true, stageSums `e1353cdc…`); report 1899; and the raw che-r3-unit outputs.
- **The only checks I ran:** `ast.parse`, `bash -n` and `sha256sum -c`.
- **Not done:** tests, queue jobs, builds, mounts, network, data/backup/part reads, or commits.
- **Untouched and re-verified clean:** r1, r2, extractor r3, capture r3, acceptance r3. The original r12 and capture r3 pins are unchanged.
- **No canonical/reset/acceptance claim.** A 35 stays PARTIAL v2 self-consistency only.

| r3 file | sha256 |
|---|---|
| **`SHA256SUMS`** | **`5d24dd4ba64042c78547110dd72101eabbf3041393ff1a880eaf46000892c0a5`** |
| `state_gate.py` | `0c55b6f670c2abd746ba945f3f8ed9573da4a6e264cc4025d761342e761d2cc9` |
| `composite_session.py` (byte-identical to r1/r2; pin unchanged) | `52099d9f70a69d80fb96862a23c6316439a619ca7f2c9f92a88c0b8fe9856e9a` |
| `tests/test_state.py` (**25**) | `6ecfdf19e58ec49555fe334273447947435f13d6b07d1bcce7ee97f7e474b9f8` |
| `jobs/tests.sh` (exactly `Ran 25 tests`; receipt `state-production-test-receipt/r3`) | `5e2abd59f6349a286d157e5dc9d461174c4b2fc8733b59c36e16750b3d068e22` |
| `jobs/root-state-validate.sh` (labels/count only) | `9a20012d6d5e2c42f5c25a0463ae0552f5e3593862d583791c290a39b47883a7` |
| `jobs/stop-session.sh` (label only) | `40033fe538ca1a8f39abe6e07f526edaf4b116eb22fb87a8be16c4821a3b5604` |
| `README.md` | `2477ee1635895e6551caf239f24f6fbb69eeba36ddbfeda2f8c9d61a9959f920` |

## 1. Actual extractor qualification: RAW outputs, bound by exact bytes (no invented schema)
**The actual format I inspected:**
- **`logs/che-r3-unit.out`** (q-exit-status log, 45 lines): `[queue] START …`, then the last 40 lines of stderr (`tests.sh`'s `tail -40`), `## PASS (25)`, `## outputs /tmp/che1881-unit-GnvMSyRq`, 2 `[memory-guard]` lines, and `[queue] EXIT 0`.
- **`.rc`** = `0\n`.
- **`.guard`** = one `[memory-guard] exit=0 …` line.
- **`/tmp/che1881-unit-GnvMSyRq/stderr`** (3464 B): unittest verbose output, ending `Ran 25 tests in 0.732s`, blank, `OK`.
- **`stdout`** (493 B): two REFUSED summary JSON lines printed by the tests; `tests.sh` does not require it to be empty.
- **No marker anywhere:** ResourceWarning, skipped, Traceback, FAIL, ERROR.

**`EXTRACTOR_UNIT_RAW`** (path, sha256):

| key | path | sha256 |
|---|---|---|
| out | `logs/che-r3-unit.out` | `d00104275c5584fd49e1385816ffbd97d79d62940913a9914f42c0ba82feee7a` |
| rc | `logs/che-r3-unit.rc` | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` |
| guard | `logs/che-r3-unit.guard` | `3fa1f405044ac908af579c12338c9bffc5dede6e3d062693daeb0065ade3f1a0` |
| stderr | `/tmp/che1881-unit-GnvMSyRq/stderr` | `e090ee4b45b29b18552b1fed88051659611d973463d9c1916e82779300bcec5a` |
| stdout | `/tmp/che1881-unit-GnvMSyRq/stdout` | `60c3cb56a286182eb1f22ec905e6d3d66e2f2be8174db02a6b2440565ae85659` |

**`raw_test_errors(files, n, out_dir_re, e2e=False)`** (pure, reusable) requires:
- the rc file == `b"0\n"`;
- in stderr: exactly one `Ran n tests in` line, last non-empty line `OK`, and no bad marker (in stderr or out);
- in out:
  - first line `[queue] START `;
  - stderr's last ≤ 40 lines **immediately before** exactly one `## PASS (n)` (this binds stderr to the queue log);
  - then, for e2e only, `## workspace <abs> (kept for review; owned; remove after review)`;
  - then `## outputs <outDir>` with `outDir` matching `out_dir_re`;
  - then only `[memory-guard] …` lines, including the guard file's single `exit=0` line;
  - `[queue] EXIT 0` last;
- no `## FAIL`/`## REFUSED`.

**`read_raw_test(pins, n, re, e2e)`** reads each pinned file (`O_NOFOLLOW`, regular, ≤ 8 MiB, sha == pin). stderr/stdout must be `<outDir>/stderr|stdout`.

**The output dirs:**
- unit: `/tmp/che1881-unit-[A-Za-z0-9]{8}` (r3 `tests.sh` `mktemp`);
- e2e: `<extractor r3>/runs/e2e-<UTC>-<pid>` (r3 `e2e-tests.sh`).

**`EXTRACTOR_E2E_RAW = None`** is an explicit production block (`BLOCKED extractorE2E`): che-r3-e2e (8) has NOT run, and must not run before all 265 are committed+verified with no driver. Later, a reviewed revision pins the actual same-stage run's `{out, rc, guard, stderr, stdout}`, and `read_raw_test(…, 8, E2E_OUT_DIR_RE, e2e=True)` accepts it.

## 2. The extraction consumer (exact API)
**`PRODUCTION_INPUTS`** (still `None`) gains `"extractionJob": [<extractor r3>/runs/extract-<ID>/JOB-RECEIPT.json, <sha256>]` next to `"extraction": [<inner receipt>, <sha256>]`. `input_shape_errors` requires both as `[abs path, 64-hex]`.

**`verify_extractor_stage()`:**
1. `verify_sums(EX3, "extractorSums")` (`ee657a9d…`);
2. `read_raw_test(EXTRACTOR_UNIT_RAW, 25, unit)`;
3. if `EXTRACTOR_E2E_RAW is None`, refuse `BLOCKED extractorE2E`; else `read_raw_test(EXTRACTOR_E2E_RAW, 8, e2e, e2e=True)`;
4. `load_exact("extractor")` (`extract.py` `cf1264cc…`, exec'd from the hashed bytes).

**`verify_extraction(inp, EXM)`:**
- **Paths:**
  - inner `== <EXM.PROD["destParent"]>/compact-header-extraction-<ID>/EXTRACTION-RECEIPT.json`;
  - outer `== <extractor r3>/runs/extract-<ID>/JOB-RECEIPT.json`.
- **Filesystem:** `no_symlink_ancestors` for both and for `<run>/files/data/static_files`; `on_vm` (253:1) for the run dir and the static dir.
- **Reading:** both read ONCE; sha == pins.
- **The outer's `jobDir`:** must be its own parent (strict JSON via `EXM.strict_json`).
- **The pinned call:** `pins = EXM.state_pins(receipt_raw, run_dir, job_raw, PINS["extractorSums"][1])`. That is the extractor's own API: both receipts, `job_receipt_errors` (final/extract rc int 0, unchanged stage, equal peers, exact path + sha) plus `inner_state_pins` (CLEAN, allowlist, format, owner-receipt sha, `sourcePre == sourcePost`).
- **Exact equality:** `pins.staticFilesDir == inp.staticFilesDir`, `pins.staticFiles == inp.staticFiles` (order, sizes, shas), `extractionReceiptSha256 ==` the inner pin, `jobReceiptSha256 ==` the outer pin, and `stageSums ==` the extractor SUMS.
- **Afterwards:** both files are re-read and must be byte-identical.

**`verify_production_inputs`** now ends: D5 → capture stage → D2 → helper bytes → captures → D3 → `verify_extractor_stage()` → `verify_extraction(inp, EXM)` → **`return True`**. Once every future input is actually present and passing (incl. the e2e pin), nothing refuses unconditionally. Test 4 shows this with the stubs; with the real stage check it refuses only `BLOCKED extractorE2E`.

## 3. Independent review of the r2 runtime wiring (scope: gate, runtime, final/O1, D2, D3, the capture wiring, `exec_plan` D1)
**No concrete bug found.** Each function was read against its stated contract:
- `check_view_binding` runs before any scope change, and in `exec_plan` before Popen;
- the runtime rest is exact;
- the D2 single read + uniqueness, and the D3 same-ID / byte-identical-around-evidence check, are as described;
- `cleanup_verified` / `wrapper_code` behave as root decided (O1);
- the capture wiring re-hashes `capture.txt` and `work/out`.

**Observations (not bugs; no change made):**
1. **Ephemeral pins.** Two of the actual unit pins live under `/tmp` (`tests.sh`'s `mktemp` dir). If `/tmp` is cleaned or rebooted, the gate and runtime REFUSE (fail closed), and tests 4/21/22/25 fail. **Recommended:** root copies those two files to a durable, owned location, and a reviewed revision re-pins them (same bytes, sha unchanged).
2. **Two reads per run.** The gate and the runtime each re-run the full prerequisite verification (incl. the raw `/tmp` files and `work/out` re-hash). A change between the two reads refuses (fail closed). That is intended, but it lengthens the pre-exec window.
3. **Non-strict parsing of pinned receipts.** The build and capture receipts are parsed with plain `json.loads` (duplicate keys last-wins). Their bytes are sha-pinned, so a later change is detected; strict parsing would only harden against a malformed but pinned receipt.

## 4. Tests (25; NOT run; root: `bash jobs/q-exit-status.sh spv-r3-tests 256 unshare -Urn bash state-production-validation-stage/r3/jobs/tests.sh`)
**1–20:** r2's, adapted:
- **4** now checks the AST order ending `verify_extractor_stage()`, `verify_extraction(inp, EXM)`, `return True`. It shows the real stage refuses only `BLOCKED extractorE2E`, and returns True with every prerequisite stubbed passing.
- **12** adds the `extractionJob` shape cases (wrong, None, missing).
- **15** uses `OWN_TESTS` (r3, 25).
- **Fixtures** gain `extractionJob`.

**21–25 (new):**

| test | what it checks |
|---|---|
| 21 | the ACTUAL raw unit outputs pass `read_raw_test(…, 25)`; 14 single mutations fail (rc, Ran 24, OK removed, ResourceWarning, skipped, FAIL line, EXIT 1, outputs dir, a duplicate PASS, guard exit 1, a tampered tail, the outDir regex, non-UTF-8), plus a missing key, None, n = 24 and the e2e regex |
| 22 | the future e2e acceptance function on a SYNTHETIC e2e-shaped output: pass; workspace line required only for e2e; count/rc/dir mutations fail. `EXTRACTOR_E2E_RAW is None`, and `verify_extractor_stage` refuses `BLOCKED extractorE2E` after the actual SUMS + unit checks |
| 23 | a synthetic inner + outer pair in a tempdir (path roots overridden, `vm` stub) through the REAL pinned `extract.state_pins`: the exact pins are returned; the AST shows the pinned call |
| 24 | refusals: outer missing / nonzero / extract rc / mismatched sha / peers / other stage; `jobDir ≠` parent; swapped inner bytes (pin unchanged), and re-pinned but with the outer bound to the old sha; reordered / size-changed / different-dir static pins; a wrong job pin; a wrong run path; a job outside `runs/extract-ID`; a symlinked `files`; the real `on_vm` on tmp |
| 25 | qualification pins missing/malformed: None, a missing or extra key, a wrong sha, a relative path, a missing file, the same bytes outside the job's own output dir, and the unit run standing in for the e2e |

**All extraction/e2e inputs are SYNTHETIC.** Only test 21 (and 4/22/25, through `verify_extractor_stage`) reads the actual pinned raw unit outputs.

## 5. Still blocked (intentional)
- **`PRODUCTION_INPUTS = None`:** no ACTUAL r12 build, positive/fixtures captures, structural CLEAN, production extraction (inner + outer job receipt) or production view record exists yet.
- **`EXTRACTOR_E2E_RAW = None`:** no actual che-r3-e2e 8 PASS, and it may only run after all 265 + no driver.

No E2E is run while the 265 are incomplete.
