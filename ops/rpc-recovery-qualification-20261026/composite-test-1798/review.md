# composite-mdbx-validation-stage/r6: test-9-only close correction (1797). FROZEN, NOT RUN, NOT PASS

**Status:** source only.
- **Executed by me:** `ast`, `bash -n`, `cmp` and sha256. I read metadata and logs of the retained r5 run only.
- **Not done by me:** tests, mounts, production actions or original writes.
- **Untouched:** the driver.
- **Preserved (`sha256sum -c` OK):** r5 (`b3a318d6…`) and its failed run.

## Evidence (root's actual r5 run, `composite-mdbx-validation-stage/r5/runs/tests-20261027T013310Z-2582681`)
**Receipt:**
- `test_session_guard`: Ran 4, OK, **pass**.
- `test_composite_session`: Ran 12, rc 1 (`.........E`, one ERROR).
- `environment`: `peersUnchanged: true`, `noMountLeft: true`.
- `stageSums` = r5's.

**stderr:** test 9, line 264, in the test's `finally`: `os.close(held)` → `OSError: [Errno 107] Transport endpoint is not connected`. That exception **skipped test 9's outcome assertions**, so I checked them against the retained session receipt.

**Test 9's own session receipt:** `tmp/cx6tbk_ggf/run1/receipt.json`, sha256 `339f7bdd317bb2fbd0abb3f8675304a165a8094536f0ccc38dd82b5bd6f3661b`. It is identified by the fixture's `go` file and `run1/ready`, which only test 9 creates; test 11 uses `go11`.
- `outcome` **CLEANUP-INCOMPLETE**, `rc` **4**, `cleanupComplete` false;
- `unmount.normal` = `"1: /usr/bin/fusermount3: failed to unmount …"` (the real busy failure). There is **no `lazy` entry**: libfuse detached the mount itself, which r4 T1 allows;
- `childrenAlive: []`, `mountLeft: false`, `leftoverProcesses: []`, `cleanupErrors: []`;
- children: qemu-nbd rc 0, nbdfuse rc 1, exec rc 0; `/proc/<nbdfuse pid>` is gone;
- no mount of that fixture remains in mountinfo.

**Conclusion:** the runtime met every test-9 assertion. The only failure was the TEST closing its own handle on a FUSE file whose server the session had deliberately ended underneath it (ENOTCONN). This is a **test-only** defect.

## r6 change (test 9 only)
**Stage `composite-mdbx-validation-stage/r6/`, SHA256SUMS `06705b02eab351a718234f22c9a53acdbefe3977122682f8f3f7ac25d5b9914a`**

| file | sha256 | vs r5 |
|---|---|---|
| `composite_session.py` | `407aa7e98fe18f913112b9f49369416e98524ff28f4e44cde788958f314fdbf6` | **identical** |
| `jobs/session_guard.py` | `f64c6115ab8ac871d1813d53d45d3b03369c330c45617763824a4bb3fef287ce` | **identical** |
| `tests/test_session_guard.py` (4) | `6a66be0d0a2ff88d58dbff0d7d2b0c2ead3693a6ac12042901719304f273994b` | **identical** |
| `jobs/stop-session.sh` | `ba1568db…` | identical |
| `tests/test_composite_session.py` (12) | `0e087dea4f8768e60d482035f61e010db360cc1a08dee90225444c6d5f5c1fd5` | test 9's close only (plus the header and the `errno` import) |
| `jobs/common.sh` / `jobs/tests.sh` / `jobs/root-composite-validate.sh` | `158b2163…` / `336ad921…` / `b34be78f…` | stage path, job name and receipt format r6 only |
| `README.md` | `3c474b24…` | |

**Test 9's `finally`:**
- **Close:** `os.close(held)` is called once. **Only `errno.ENOTCONN` is accepted**; any other `OSError` is re-raised and fails the test. It is never retried.
- **Release check:** the descriptor is then proven released by `os.fstat(held)` → `EBADF`. Linux frees the fd even when close reports an error, and no other open happens in between.
- **After the `finally`:** `assertIn(close_errno, (None, ENOTCONN))` and `assertFalse(fd_still_open)`.
- **Unchanged assertions:** rc 4 CLEANUP-INCOMPLETE, a failed normal unmount, lazy absent or 0, both servers ended and reaped, `childrenAlive == []`, no mount, no holder.
- **Scope:** no runtime, production or other test close path changes.

## Root invocation (512 MiB main lane; as the owner, not under unshare)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cmv-r6-tests 512 bash composite-mdbx-validation-stage/r6/jobs/tests.sh     # expect "## PASS (4+12)"
```
- **PASS requires:** Ran 4 and Ran 12, OK, empty stdout, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0, peers unchanged, no mount left, and the stage unchanged.
- **Fixture retention:** fixtures are retained on any failure.
- **Production:** DISABLED.
- **Keep** the failed r5 run for the archive.

## Limits
- **ENOTCONN is accepted only for the test's own intentionally disconnected handle in test 9.** Production and runtime close behaviour is unchanged.
- **Fixture assumptions still to be confirmed by r6's run:** in r5, 11 of 12 composite tests passed, and test 9's receipt is as above.
- **Unchanged composite limits:** no production scale; no chain, state, RPC or SNP validation.
