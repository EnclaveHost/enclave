# 1715: recovery-overlay-stage/r9 (FROZEN, NOT run): review 1712 F1/F2/F4 on top of r8 (root: 20 + 13 PASS)

**Status:** source frozen, NOT run.
- **Stage:** `recovery-overlay-stage/r9/`, **`SHA256SUMS` sha256 `17b5528fc122203708dc3cce1ddfdf4e3151ff02ec21d09b55cd651fbcd103b3`** (16 files, read-only).
- **Preserved:** r1 through r8 all re-verify.
- **Executed by me:** reading the receipts and the review; text edits; `ast.parse`; `bash -n`; `sha256sum`; `diff`.
- **Not done by me:** tests, mounts, NBD/FUSE, USB, live actions or reads of the original.
- **Disclosure:** r9 was first frozen as `5815b80c…`. Before this report, my own check found that test D10 hardcoded the stage label `r8`, which would fail in r9. I corrected that one test (the label is now derived from the stage directory) and re-froze. `5815b80c…` was never reported or used. **The valid r9 is `17b5528f…`.**

## Inputs
- **Root's r8 receipt** `r8/runs/tests-20261026T213607Z-2379777/receipt.json`: `test_recovery_overlay` 20 PASS, `test_diagnostic` 13 PASS, `noMountsLeft`, `peersUnchanged`, `pass: true`.
- **Review `logs/claude-recovery-diagnostic-review-1712.md`.**

## F1 (real defect), fixed: `overlay_session.cleanup()` ends a live validator before any unmount
- **The cause:** a SIGTERM, SIGINT or SIGHUP (root cancel, the job's `timeout`, a queue stop) or an `OSError` raised out of `use()` while `--exec` was still running. `cleanup()` then ended only fuse2fs, nbdfuse and qemu-nbd; `reap_adopted()` skips live Popen children. So the validator kept the view open, the unmount hit EBUSY, and the run ended rc 4. It failed safe, with nothing written, but was not clean.
- **The fix** (`overlay_session.py` r8 `fe0bb752…` → r9 `65d45ab7…`; the only runtime change): the first thing `cleanup()` does is:
  1. `end_child("exec")`, i.e. `stop_group` of the validator's own process group (TERM then KILL, while its leader is our unreaped child);
  2. `reap_adopted()`, which kills and reaps escaped descendants re-parented to the subreaper session;
  3. **then** the existing order: unmount and end fuse2fs, nbdfuse, qemu-nbd.

  If the validator already finished normally, step 1 is a no-op check.
- **New tests** (`tests/test_diagnostic.py`, 13 → **15**). The session runs as a real subprocess on the REAL restored MDBX fixture. The exec is a holder that **mmaps the restored read-only `mdbx.dat`** (as `mdbx_chk` does) and spawns a second holder:
  - **F1a:** the second holder is in the **same group**;
  - **F1b:** the second holder is **escaped** via `setsid`.

  The test waits for both readiness markers, then sends **SIGTERM** to the session.
- **What the tests require:**
  - rc 5 with `interrupted`;
  - the exec reaped;
  - (F1b) `adoptedKilled` non-empty;
  - a **clean fuse2fs unmount** (`unmount.fuse2fs == 0`, meaning nothing held it any more);
  - `cleanupComplete`;
  - no leftover process and no mount under the run;
  - the parent sha256 unchanged.

## F4 (permissions on the real directory): the fixture now matches the original
**The real directory:** `/data/db` is **0750, owner 994:985**, and `mdbx.dat` is 0644.

**`fixture/make_mdbx_fixture.py`** (r8 `7989597f…` → r9 `dae826d3…`):
- sets exactly that with `debugfs sif` **before** the capture, also making `mdbx.lck` 0644 994:985, so the restored inode and directory carry it;
- verifies it with `debugfs stat`;
- E1 additionally asserts the fixture's recorded modes and owners.

**Why it should pass:** `fuse2fs 1.47.4` adds kernel `default_permissions` only with `-o kernel`, and we use `-o ro,norecovery,fakeroot`, so its own access checks treat the caller as root. E1 (the restored real MDBX DB validated by the pinned `mdbx_chk`) and F1a/F1b now prove traversal as the **unprivileged** runner on that ownership.

**If root's run shows EACCES instead:** the fix belongs on the read-only **view** side only (a representation change in the view). It never means a write to the original. I did not pre-build such a change, because the expected behaviour needs none.

## F2 (queue/guard cut cleanup short): documented, with a narrow helper
**`jobs/root-post-cancel-cleanup.sh RUN`** (new, `641e81c9…`). Use it only after the memory guard or `stop()` (TERM, then KILL 1–2 s later) has cut a session's cleanup short. It:
- accepts only a `diag-`, `expose-` or `tests-` run dir **of this stage**, owned by this user;
- **refuses while any process still names the run** (never kills anything);
- unmounts **only** `RUN/work/{mnt,view}` (and those of the fixture sub-runs) that are actually mounted (`fusermount3 -u`, then `-u -z`);
- requires that nothing under RUN remains mounted;
- prints the peer snapshot for comparison.

**Never** start a new session over a leftover.

**What stays covered without it:** qemu-nbd's death (by `PDEATHSIG`) already closed the original. The only residue a hard kill can leave is a dead FUSE mount of our own.

## G1 and G2
- **G1 (correcting the review's reading):** the standing pause covers **USB WRITES, download and VM boot** specifically. Read-only recovery access to the USB-backed original is authorized by the human's question and the prior context, so no new approval is needed for the read-only probe. Every write path stays closed (`ro` mount; `ST_RDONLY` before and after; not writable; `RLIMIT_FSIZE`; read-only qemu-nbd/nbdfuse/fuse2fs).
- **G2:** run **one bounded 1800 s throughput probe** once r9 qualifies, not a blind 24 h run. **No throughput figure is claimed:** the earlier ranges were estimates, and the probe is the measurement.

## Root commands
**1. Tests.** The runtime changed, so both suites run in full:
```
bash jobs/q-exit-status.sh rov-r9-tests 512 bash recovery-overlay-stage/r9/jobs/tests.sh
```
Expect `## PASS (20 + 15)`, `noMountsLeft`, `peersUnchanged`.

**2. The probe.** The same request JSON as in 1707 is valid unchanged: it binds the plan, journal, history and validator, not the stage. Use its sha256.
```
bash jobs/q-exit-status.sh rov-r9-diag-probe 4096 bash recovery-overlay-stage/r9/jobs/root-diagnostic-expose.sh /ABS/request.json <REQ_SHA256> 1800
```
**Expected:** `mdbx timedOut`, rc 6, `kind DIAGNOSTIC`, cleanup complete.
**Measure:** the `qemu-nbd` `/proc/PID/io` `read_bytes` rate and the guard's peak tree RSS.

**3. Only then decide on the full run** (VT ≤ 84600; 4096 lane).

**After an abnormal cancel:**
```
bash recovery-overlay-stage/r9/jobs/root-post-cancel-cleanup.sh <the run dir>
```

## Files (r9 vs r8)
| file | status |
|---|---|
| `overlay_session.py` | changed: F1 |
| `fixture/make_mdbx_fixture.py` | changed: F4 |
| `tests/test_diagnostic.py` | changed: 15 tests; D10 label derived from the stage |
| `jobs/tests.sh` | changed: 20 + 15 |
| `jobs/root-post-cancel-cleanup.sh` | new |
| `README.md` | changed: r9 section |
| `jobs/*.sh` | relabelled `r8`→`r9` |
| `overlay_plan.py`, `diagnostic_request.py`, `diag/run_validator.py`, `tests/test_recovery_overlay.py`, `fixture/make_fixture.py`, `fixture/make_jbd2_inputs.py` | byte-identical |
| `jobs/root-expose-real.sh` (strict GO) | still exactly r7's, relabelled (`diff`-verified) |

## Candid limits
- **Not run.** F1a/F1b and the F4 ownership are first executions. If fuse2fs does enforce 0750 against uid 1000 despite `fakeroot`, E1, F1a and F1b fail with EACCES (fail-closed). A view-side fix would then follow in r10.
- **A SIGKILL of the session during `--exec`** (guard KILL, or `timeout -k` after 300 s) cannot run any cleanup. The exec child gets `PDEATHSIG`, but an escaped grandchild does not inherit it and keeps the FUSE mount busy until it dies or the mount's server is gone. The result is a stale mount of ours only, handled with `root-post-cancel-cleanup.sh`; the original is closed. This is not testable without leaving that residue, so it is documented, not tested.
- **The diagnostic meaning is unchanged:** `structurallyClean` is structure only. With the history BLOCKED, reuse is unexcluded. There is no recovery, data-integrity or production claim, and the GO path stays strict and closed.
