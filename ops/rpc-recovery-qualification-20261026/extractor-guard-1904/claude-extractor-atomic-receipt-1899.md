# 1899: compact-header-extraction-stage/r3 = r2 + review 1894 X1 (SOURCE ONLY; nothing run; NOT PASS)

**Scope of MY activity:**
- **Created** the new stage `compact-header-extraction-stage/r3` only.
- **The only checks I ran:** `ast.parse`, `bash -n` and `sha256sum -c`.
- **Not done:** tests, queue jobs, builds, mounts, network, data/backup/part reads, a production request, or commits.
- **Untouched and re-verified clean:** r1 and r2. r2's actual 16 unit tests PASSED (recorded in `source/runtime-components-prepared-1898`); review 1894's "not run" wording is outdated on that point.
- **Still unrun:** the r2/r3 E2E.
- **No recovery, canonical-state, structural or reset claim.** Owner-mutable receipts are local evidence, not authentication.

| r3 file | sha256 |
|---|---|
| **`SHA256SUMS`** | **`ee657a9d1c0c120e058f49e77a3cdb67a8394d927ffa7a7807e514716fc9ca84`** |
| `extract.py` | `cf1264cc0756c6cad85b14a4f20a9ba1edf40413ed6e6a90b9d07b10251b7edf` |
| `jobs/coordination.py` (byte-identical to r2) | `208c0825d76eeae2f4303855bbedb39d0da6023ed1cd552a7da8ab97632d05b2` |
| `jobs/root-extract.sh` | `bd0ea38faab2146e68244c5564362206d7d9797a8c793314871efd480dd19fa3` |
| `jobs/e2e-tests.sh` (labels only) | `f97258c31e2c6c5eee04a5ebfa07e46912d8268cd0ea1221f4203924c59ed548` |
| `jobs/tests.sh` (exactly 25) | `54f4336d80afd216c852d9178aea28554df4a1a17b384518b7764bc5bfb8a571` |
| `tests/test_extract_unit.py` (25) | `34b267b6a5330db5666a7250cd77a6b19508e3652f930d504c4cd732fa83fd43` |
| `tests/test_extract_e2e.py` (8; docstring label only) | `fd0d8d3153aef1ac4dacea10b11043db37ea1988cdf0b962e7774c432f6958be` |
| `tests/make_meta_fixture.py` (docstring label only; fixture bytes unchanged) | `c227931107b6f9f4c96bea07cc93d289a05c2c83d6f427696a70738a0459a546` |
| `README.md` | `6da6ac937426aa6adee8fd53d3c831b25f18347f65b808e1f0ce7edb2ae57ef8` |

**Unchanged** (`diff r2 r3`; the only removed lines are the old `write_json`, the old `state_pins` header, its CLI read and the docstring):
- the resource gates and the 1024 lane;
- `coordination.py` (all 265 + inactive driver, mandatory before e2e and production);
- the r9 lifecycle, the allowlist, the backup binding and the fixture guards.

## 1. X1: atomic, non-overwriting publication (`extract.py publish_json`)
**The steps:**
1. Open `<name>.partial` with `O_CREAT|O_EXCL|O_NOFOLLOW` (0600), and record its inode.
2. Write the full bytes (looped `os.write`), then `fsync`, then `close`.
3. `os.link(partial → <name>)`. EEXIST means **an existing final is never overwritten or touched.**
4. Unlink the partial, then fsync the directory.
5. Return `(True, None)` only after all of the above.

**Any failure → `(False, reason)`:**
- our fd is closed and our partial removed (only while its inode is ours; a foreign `.partial` is never removed);
- **if the failure came after publication** (the dir fsync, or the partial unlink), the published final is removed again, also only while it is still our inode.

**In `cmd_run`:** `written, why = publish_json(run_fd, "EXTRACTION-RECEIPT.json", out)`, then `final_rc` → 4 when not published, with a stderr line.

**The seams** `_fsync_file`, `_close`, `_link` and `_fsync_dir` exist only so the tests can inject failures.

## 2. The wrapper job receipt and the state-runner API
**Why both are needed:** a process can die after the inner receipt is published but before the wrapper's own checks. So **consumption requires BOTH receipts.**

**The wrapper (`root-extract.sh`):**
- it keeps `xrc` (the extract rc) and `sc` (`sha256sum -c` after);
- after peers-after, the stage check and the rc folding, its **last step** is `extract.py job-receipt --job-dir $O --extract-rc $xrc --final-rc $rc --stage-sums-before $SUMS --stage-check-after $sc`.

**That step publishes `$O/JOB-RECEIPT.json` atomically** (`publish_json`), format `compact-header-extraction-job-receipt/v1`, with exactly the keys:
- `finalRc`, `extractRc`;
- `stageSumsBefore`, `stageSumsAfter` (the sha of `SHA256SUMS` re-read now), `stageCheckAfterOk`;
- `peersBeforeSha256`, `peersAfterSha256`, `peersEqual` (byte equality);
- `runDir` (from `extract.out`), `extractionReceiptPath` (`<runDir>/EXTRACTION-RECEIPT.json`), `extractionReceiptSha256` (the bytes on disk now);
- `jobDir`, `canonicalAuthority: false`, `resetAuthority: false`, `createdUtc`.

**The rc it returns:**
- a candidate 0 becomes **4** if extract rc ≠ 0, the SUMS changed, the check failed, peers differ, or the receipt is absent;
- the wrapper exits with this rc;
- if it cannot publish (incl. an existing `JOB-RECEIPT.json`, never overwritten): 4 (other nonzero codes are kept).

**THE API for the state runner:**
- **Python:** `state_pins(receipt_raw: bytes, run_dir: str, job_raw: bytes, stage_sums: str)`.
- **CLI:** `extract.py state-pins --run-dir R --job-receipt J --stage-sums S` (all three are required by argparse).

**What `state_pins` checks:**
- **Strict JSON for both:** UTF-8, an object, duplicate keys and NaN/Infinity refused.
- **`job_receipt_errors(job, run_dir, sha256(receipt_raw), stage_sums)`** (pure) must be `[]`:
  - exact keys and format;
  - `finalRc` and `extractRc` exact int 0 (bool refused);
  - `stageSumsBefore == stageSumsAfter == stage_sums` (64 hex), and `stageCheckAfterOk is True`;
  - `peersEqual is True` with equal 64-hex shas;
  - `runDir == run_dir`, `extractionReceiptPath == run_dir + "/EXTRACTION-RECEIPT.json"`, `extractionReceiptSha256 ==` the bytes' sha;
  - no authority.
- **`inner_state_pins(receipt, run_dir)`** = r2's mapping (CLEAN, rc 0, `session.rc` 0 with no reasons, no error or `finalizationErrors`, the exact 7-entry allowlist in order, sizes, 64-hex shas, `totalBytes`) **plus** the 1894 extras:
  - `format == "compact-header-extraction-receipt/v1"`;
  - `backupReceiptSha256 ==` the pinned owner receipt `928d09ba…`;
  - `sourcePre`/`sourcePost` are objects with int dev/ino/size/mtimeNs/ctimeNs that are equal.
- **The CLI** still accepts only `--run-dir` under `/vm/enclave-volumes/tr004-base-recovery-20261026/compact-header-extraction-*` (fixture runs cannot map). It reads both files with `O_NOFOLLOW`, regular files only, ≤ 4 MiB.

**It returns:** `{format: "compact-header-static-files/v1", staticFilesDir: <run>/files/data/static_files, staticFiles: [6 × {name, size, sha256}] (allowlist order, reth.toml excluded), allowlistSha256, extractionReceiptSha256, jobReceiptSha256, stageSums}`.

**A CLEAN inner receipt alone never suffices.** `job_raw=None` is refused, and so is any outer mismatch.

**Wiring for `state-production-validation-stage` (a later reviewed revision; its BLOCKED `extractionReceipt`):**
1. Pin this stage's SUMS `ee657a9d…`, `extract.py` `cf1264cc…`, and its actual `che-r3-unit` (25) and `che-r3-e2e` (8) PASS receipts.
2. Pin the production `EXTRACTION-RECEIPT.json` path + sha AND the `runs/extract-*/JOB-RECEIPT.json` path + sha.
3. Load `extract.py` pinned and call `state_pins(receipt_bytes, run_dir, job_bytes, "ee657a9d…")`.
4. Require that its `staticFilesDir`/`staticFiles` equal `PRODUCTION_INPUTS["staticFilesDir"/"staticFiles"]` and that `extractionReceiptSha256` equals the `extraction` pin sha. Also pin `jobReceiptSha256`, which needs one new input field (`extractionJob`) in that revision.

## 3. Prepared tests (NOT run)
**Unit (25; `che-r3-unit`, 256 lane):**
- **1–16:** r2's, with test 14 adapted to `inner_state_pins` and the new production markers, and its CLI case using the three-argument form.
- **New:**

| test | what it checks |
|---|---|
| 17 | publish: final complete, 0600, no partial left |
| 18 | file fsync failure → nothing left |
| 19 | close failure → nothing left |
| 20 | link/publication failure → nothing left |
| 21 | directory fsync failure AFTER publication: the final was visible, then removed; nothing left |
| 22 | an existing final is preserved byte-for-byte; a foreign `.partial` is preserved; after-publication failure with a swapped (foreign) final never removes it |
| 23 | inner CLEAN + outer missing / each outer field wrong (finalRc 4/True/None, extractRc, SUMS before/after, check, peers, runDir, path, sha, format, authority) / malformed outer (extra/missing key, duplicate key, not an object, garbage, truncated) / another stage / inner bytes ≠ bound sha → refused; the CLI requires `--job-receipt` and `--stage-sums` |
| 24 | format / owner-receipt sha / `sourcePre ≠ sourcePost` / missing / bool ino → refused (inner and bound) |
| 25 | the `job-receipt` subcommand: all good → 0 and a receipt passing `job_receipt_errors`; peers differ / stage check failed / extract rc 4 / no `extract.out` → 4; a nonzero candidate is kept; an existing `JOB-RECEIPT.json` is never overwritten (rc 4) |

**E2E (8; `che-r3-e2e`, 1024 lane):** r2's 8 unchanged. It runs only after `coordination.py` passes (all 265 committed + verified, no driver/batch/session), and never touches the backup.

**Commands (for root; not executed):**
- `bash jobs/q-exit-status.sh che-r3-unit 256 unshare -Urn bash compact-header-extraction-stage/r3/jobs/tests.sh` (expects `Ran 25 tests` + OK, the stage unchanged, no bytecode);
- `bash jobs/q-exit-status.sh che-r3-e2e 1024 bash compact-header-extraction-stage/r3/jobs/e2e-tests.sh` (expects `Ran 8 tests`; refuses unless coordination passes).

## 4. Limits
- **Test-only seams:** the injected failures exercise `publish_json` through its four seams, not a real EIO.
- **Best-effort removal:** removing a published final after a dir-fsync failure is itself best-effort. **That is exactly why the separately bound wrapper job receipt is mandatory.**
- **Process death:** a death between publishing `JOB-RECEIPT.json` and the wrapper's `exit` leaves a valid job receipt that matches its measurements. A death before it leaves no job receipt, so the state runner refuses.
- **Production stays on HOLD:** the r3 unit + e2e actual PASS, review, all 265 CONFIRMED, a coordinated window, and the root-reviewed request (not created here) are all required.
