# 1674: recovery-overlay-stage/r2 (FROZEN, NOT run). Fixes root 1673, the 1660 prerequisites and da's review 1671

**Status:** source frozen, NOT run.
- **Stage:** `recovery-overlay-stage/r2/`, **`SHA256SUMS` sha256 `41b2c41a41206c94cd84e9a9e9d8f6b8f4d77c71509f04eaa7d4d284012793b0`** (10 files, read-only). r1 (`a8243779…`) is preserved and re-verified.
- **Executed by me:** text edits, `ast.parse`, `bash -n`, `sha256sum`.
- **Not done by me:** tests, builds, mounts, qemu, FUSE, live actions, USB, or reads of the original.

| file | sha256 |
|---|---|
| `overlay_plan.py` | `78e573f6…` |
| `overlay_session.py` | `40307e47…` |
| `fixture/make_fixture.py` | `3f41eb34…` |
| `fixture/make_jbd2_inputs.py` (new) | `dd2390a1…` |
| `tests/test_recovery_overlay.py` (**20 tests**) | `fa2890fd…` |
| `jobs/common.sh` | `a2023b99…` |
| `jobs/tests.sh` | `9a42bf87…` |
| `jobs/root-plan-real.sh` | `fe3ef2ed…` |
| `jobs/root-expose-real.sh` | `04b37980…` |
| `README.md` | `7e5a3181…` |

## Root 1673 (r1 fixture failed before any test)
- **Cause:** `make_fixture.sh()` returned stdout + **stderr**. `debugfs` writes its version banner (`debugfs 1.47.4 (…)`) to stderr, so `data_blocks` parsed `debugfs` as an int.
- **Fix:**
  - `sh()` returns **stdout only**;
  - any stderr line that the caller does not explicitly accept refuses the fixture (debugfs accepts **only** the banner regex), so real errors are no longer swallowed;
  - `blocks` output must be **only** decimal tokens.
- **What 1673 showed working:** everything before that point (mkfs, the punch script, the Python model == `debugfs dump`, stat/imap parsing). No mounts or peer changes occurred (`peersUnchanged` true).

## The 1660 prerequisites
1. **Hard pre-write bounds** (`overlay_session.prepare`, before any file exists):
   - ≤ 64 patches; ≤ 1 MiB in total; each 1..4096 bytes; **no overlaps**;
   - a worst-case qcow2 growth estimate within the cap: 64 KiB × (header + L1 clusters + 2 refcount + distinct data clusters + distinct L2 tables) + 1 MiB. For the real plan that is about 5 MiB against 64 MiB.
   - **`RLIMIT_FSIZE` = cap** (and `RLIMIT_CORE` 0) on **every** child: `qemu-img create`, `qemu-io`, `qemu-nbd`, `nbdfuse`, `fuse2fs`, the validator and short tools. No file a child writes, including the overlay and the logs, can exceed the cap.
2. **Real `ST_RDONLY`:** `--require-ro-mount` (always passed by `root-expose-real.sh`) requires `statvfs(parent).f_flag & ST_RDONLY` before anything, and again at cleanup.
3. **Owned process groups and timeouts:**
   - each child runs in its own session/group;
   - groups are signalled (TERM, then KILL) **only while the leader is our unreaped child** (`waitid(WNOWAIT)`), so the pgid cannot be reused;
   - the session is a **`PR_SET_CHILD_SUBREAPER`**: descendants that escape their group (setsid, double fork) are re-parented to us, then killed and reaped (they are our children, so there is no PID reuse);
   - `PR_SET_PDEATHSIG=SIGTERM` on every child.
4. **`--exec` result propagates:** the validator runs as a `Popen` with a bounded timeout (≤ 86400 s). **rc 6** if its exit status is not 0, it timed out, or it left any descendant (group leftovers or escaped orphans, all killed and reaped). Root's observation that `s.use()` was ignored is fixed: `main` sets rc 6.
5. **Synthetic JBD2-path tests (L1):** `fixture/make_jbd2_inputs.py` builds a journal-like file, a verifier-shaped `result.json` and a 1658-shaped `candidates.json` from the fixture capture, which exercises `plan_real` end to end.
6. **Chronology (L2):** the real plan refuses if:
   - a **newer committed image ≤ the inode's sequence** of any patched block is still valid for (ino, gen) (tree: checksum-valid at its depth and parent start; inode table: the same inode and generation, with a valid checksum);
   - the chosen image was **revoked** in that window;
   - an **unproven reference** falls in it (directory included).

## Review 1671 (da) incorporated
| finding | fix |
|---|---|
| **B1** abnormal termination | SIGTERM/SIGINT/SIGHUP raise `Stop`, so the full cleanup runs (**rc 5**) and further signals are ignored during cleanup. `PDEATHSIG` on all children (a SIGKILLed session still ends them; libfuse unmounts on TERM). Waits are ≤ 5 s per phase. The job uses `timeout -k 300`. **Tests 19/20** SIGTERM and SIGKILL the session mid-hold and assert no mount, no surviving child, and the parent sha unchanged. |
| **B2** validator group | `killpg` while unreaped, plus the subreaper, plus a leftover scan that reads `/proc/*/{cwd,root,fd}` links into the work dir. **Tests 16/17** cover a failing validator with a background child, a validator that succeeds but leaves a `setsid`'d child, and a timeout. |
| **B3** gate rigor | `root-expose-real.sh PLAN_DIR PLAN_SHA256 GO_FILE GO_SHA256`. Root writes `{"format":"recovery-overlay-go/v1","pass":true,"planSha256":…,"journalSha256":"d95d81fc…","gateReceiptSha256":<1659 receipt>}`. The session also requires `--plan-sha256`. |
| **B4** `--shared=1` vs multi-conn | `nbdfuse -C 1`, and the README wording is corrected (the peer uses command mode). The fixture run confirms it. |
| N1 `fuse2fs` swap | a bounded copy into the private work dir, sha-verified; that copy is executed |
| N2 `exec.out` unbounded | `RLIMIT_FSIZE` on the validator |
| N3 a shell inside the mount | documented: never `cd` into it; use the validator or STOP |

## Tests (20; root runs them)
| # | from | what it covers |
|---|---|---|
| 1 | r1 | the exact restored view, now with a successful `--exec` (rc 0) |
| 2 | r1 | reused data detected (rc 1) |
| 3 | r1 | CRC-tampered tree image refused |
| 4 | r1 | wrong directory generation refused |
| 5 | r1 | missing tree block refused |
| 6 | r1, changed | refused by the **pre-write estimate**; no work dir created |
| 7 | r1 | writable parent refused |
| 8 | r1 | read-only contract in the commands |
| 9 | new | **real-mode plan == fixture plan** (patch bytes, offsets, map digest), with chronology recorded |
| 10 | new | tampered `contentSha256` refused |
| 11 | new | a newer valid leaf makes the chosen one stale |
| 12 | new | revoked, unproven or partial chosen image refused |
| 13 | new | the latest directory image must validate |
| 14 | new | a JBD2-escaped image is restored before its sha check |
| 15 | new | `--require-ro-mount` refuses a writable filesystem |
| 16 | new | validator failure or escaped descendant gives rc 6, no descendants |
| 17 | new | validator timeout gives rc 6, group killed |
| 18 | new | `RLIMIT_FSIZE` stops a child file beyond the bound |
| 19 | new | SIGTERM mid-hold gives rc 5, full cleanup |
| 20 | new | SIGKILL mid-hold: `PDEATHSIG` ends all children and mounts |

**Root:**
```
bash jobs/q-exit-status.sh rov-r2-tests 512 bash recovery-overlay-stage/r2/jobs/tests.sh
```
Expect `## PASS (20)`, `peersUnchanged`, `noMountsLeft`. It has a 2 GiB free-space floor.

## Candid limits (what may still fail on first run)
- **None of this has been executed.** The most likely first-run failures are tool behaviour I could not confirm offline:
  - `nbdfuse` staying in the foreground with `-P` and `-C 1`;
  - `fuse2fs` option order with `-f`;
  - qemu `--image-opts` backing overrides (`backing.read-only`, `backing.file.locking`);
  - `qemu-io write -s`;
  - libfuse unmounting on the `PDEATHSIG` SIGTERM (test 20);
  - `debugfs stat` listing `(ETBn)` for depth-2 trees;
  - inode reuse by `debugfs write`.

  All of these fail closed with a receipt. A fix would go in an r3.
- **Test 20 timing:** it depends on libfuse cleaning up within 30 s after SIGTERM. If fuse2fs dies without unmounting, the test fails and reports the stale mount under `runs/`; the manual step is `fusermount3 -u` of that path, which is ours.
- **The subreaper applies to the test process too** (in-process sessions). The tests reap orphans after the SIGKILL case. Real jobs run the session as its own process.
- **The synthetic JBD2 inputs are not a JBD2 journal:** there are no descriptors or commits. JBD2 authenticity remains root 1649's verifier. The tests prove the plan's use of the verifier's records, not the verifier itself.
- **Chronology is limited to what the surviving journal shows:** overwritten history cannot prove absence (as 1650 and 1659 note). Root 1658's accounting PASS remains the supporting evidence.
- **The overlay estimate is conservative arithmetic, not qcow2 internals.** `RLIMIT_FSIZE` is the hard backstop.
- **Validator reads of the 1.14 TB file** (page cache, USB I/O) are bounded by the validator stage (1661), not here.
- **Data blocks are not authenticated:** this is a diagnostic view only.

## Order
1. Fixture tests (`rov-r2-tests`).
2. The offline real plan (`rov-r2-plan`; record its `plan.json` sha).
3. **Only after the 1659 gate** and root's explicit GO file: `rov-r2-expose PLAN_DIR PLAN_SHA GO GO_SHA -- <validator>`.
