# state-fixture-capture-stage/r3: bound capture of the frozen r12 compiled fixtures (PREPARED by Claude 1889; NOT run; NOT PASS)
Report: `../../logs/claude-capture-binding-1889.md`.

r2 (`f07bd6da…`) is preserved unchanged: root 1886 put it on HOLD because of a test false positive. r12, acceptance r3 and the 1881 extractor are untouched.

## What r3 changes (from r2)
- **Parser bound** (the capture is no longer "PENDING"):
  - acceptance r3: `SHA256SUMS` `1e7eb636…`, `acceptance.py` `b2c10534…`;
  - root's actual 46-test receipt, `runs/tests-20261027T103556Z-3089837/receipt.json` `e2361fbb…`.
  - `gates` requires exactly: format r3, `expected` 46, `ran == ["46"]`, rc 0, every check true, and `stageSums` = the pinned SUMS. The acceptance SUMS entry must equal the module pin.
- **Exact `## outputs` line:** a positive capture must print exactly `## outputs <run dir>/work/out`, once. Acceptance r3 alone accepts any absolute path. A fixtures capture must print none.
- **Evidence manifest:** `work/out` is recorded in the receipt as name, size and sha256.
  - Only regular files with nlink 1 are allowed; no symlinks or subdirs. Limits: ≤ 256 files, each ≤ 1 MiB + 4 KiB.
  - The name set must be exactly the one derived from the pinned acceptance labels/cases.
  - The positive `binaries.sha256` must be exactly the expected helper and `mk_fixture` shas.
- **/vm binding:** BUILD_OUT_DIR's `st_dev`, the visible covering mount's maj:min, and `/dev/disk/by-uuid/aaae081c…` must all be 253:1, which is the multipart manifest's vm target pin. The covering mount must not be tmpfs, overlay, fuse or a network filesystem. This is checked outside and inside the namespace.
- **More read-only paths:** besides `/home/steven` and `/tmp`, `inner.sh` binds `/var/tmp`, `/dev/shm` and `/run/user/<uid>` read-only (each one that exists; a symlink refuses). `capture.py` verifies the same set with the pinned r12 `ns_checks`, both before and after the run.
- **Test fix (root 1886):** the source inspection now strips shell comments quote-aware and keeps here-document bodies. Test 15 is the regression: a comment mentioning `/tmp` passes, while every executable or quoted use of `/tmp` (and `mktemp`, `TMPDIR`, `$S/runs`, defaults) is still rejected.

**Unchanged from r2:**
- the lifecycle (r12 `run_capture`);
- the resource gates (512 MiB lane, 16 GiB host floor, root floor, /vm 40 GiB + 256 MiB);
- precheck outside the namespace, then `unshare -Urnm`, the pinned r12 `ns.sh`, and `run`;
- the NVMe-only layout `BUILD_OUT_DIR/fixture-captures/<kind>-<UTC>-<pid>/{capture.txt,receipt.json,work/{trees,out}}`.

## Commands (root)
```
bash jobs/q-exit-status.sh sfc-r3-tests    256 unshare -Urn bash state-fixture-capture-stage/r3/jobs/tests.sh                    # Ran 18, OK
# only after: all 265 CONFIRMED, r12 guard + ns PASS, a VERIFIED r12 build receipt (finalRc 0) naming BUILD_OUT_DIR:
bash jobs/q-exit-status.sh sfc-r3-positive 512 bash state-fixture-capture-stage/r3/jobs/run.sh positive <BUILD_OUT_DIR>
bash jobs/q-exit-status.sh sfc-r3-fixtures 512 bash state-fixture-capture-stage/r3/jobs/run.sh fixtures <BUILD_OUT_DIR>
```

Every receipt in the tests is SYNTHETIC: none is a compiled-fixture qualification, a state result, canonical proof, a recovery acceptance or reset authority.
