# composite-mdbx-validation-stage/r1: read-only MDBX diagnostic lifecycle for the composite multipart view (1782). FROZEN, NOT RUN, NOT PASS

**Status:** source only.
- **Executed by me:** `ast`, `bash -n` and sha256; and two read-only reads of official source (below).
- **Not done by me:** tests, builds, mounts, probes, live-process inspection, or touching the running preservation batch. No original read, download, VM or RPC.
- **No prior stage modified:** r9 `17b5528f…`, view r6 `18bab7be…`, recovery-multipart r3 `fcd8e097…` and mdbx validator r4 `82394b02…` all re-verified OK.
- **No commits or pushes.**

## Stage `composite-mdbx-validation-stage/r1/`, SHA256SUMS `7a9993d6a4629f5ba4a5b9b41add52cb32a8cd74a1f62bf6070b9a723de8bf1c`
| file | sha256 |
|---|---|
| `composite_session.py` (453 lines) | `2b6a474d13a8e5b146fa90db94693a580ac3f78708f3c41083f7e8ce75544fd2` |
| `tests/test_composite_session.py` (7 tests) | `1d6b4dc373929d7da3783cffcaaf51a2c4e8fdece857b368f84e7fda81fd4c6a` |
| `jobs/common.sh` (stage pins, guards, peer snapshot) | `4f591901…` |
| `jobs/tests.sh` | `9471bc8c…` |
| `jobs/root-composite-validate.sh` (production, gated) | `dff9efe0…` |
| `jobs/stop-session.sh` | `ba1568db…` |
| `README.md` | `9a1f3b1b…` |

## Reuse (no new framework); every input pinned
**Loaded from the exact hashed bytes** (`load_pinned`):
- **r9 `overlay_session.py` `65d45ab7…`:** `limits` (RLIMIT_FSIZE, no core, PDEATHSIG + parent check), `exited_nowait` (waitid WNOWAIT), `group_members`, `stop_group` (TERM then KILL of the group while the leader is unreaped; reap last), `mounted`, `slurp`, `all_pids`, `proc_fields`.
- **r9's control flow, re-expressed in about 40 lines:** subreaper, own groups, the validator group (and its adopted orphans) ended **before** the unmount, then nbdfuse, then qemu-nbd.
- **r6 `production_import.py` `4d48f74e…`** (with `view_descriptor.py` `23370c97…`): `load_view` (kind), `recheck` and `check-held` (every fd O_RDONLY, every bound inode + the descriptor).

**Executed unchanged:** the r4 wrapper `mdbx_check.py` `f0d27e40…` with `mdbx_chk` `c228b462…` (root 1685's run copy), `qemu-nbd` `b0f16ff7…`, `nbdfuse` `51c1a1fd…` and `fusermount3` `c3d04bdf…`. All sha-checked in code before use; stages are re-checked in `jobs/common.sh`.

**Exposure without ext4.** These come from **official libnbd v1.24.4 source** (`fuse/nbdfuse.c` `39b40d1a…`, `fuse/operations.c` `7a09ff29…`, fetched read-only) and the local `nbdfuse(1)`:
- `MOUNTPOINT/FILENAME` exposes the view as `<work>/db/mdbx.dat`;
- nbdfuse stays in the foreground and passes `-o` options to FUSE;
- there is no `direct_io`, so libmdbx's read-only mmap goes through the page cache.

`-o ro` is expected to make the mount ST_RDONLY. The r4 wrapper refuses otherwise, and libmdbx then takes its documented EROFS "without-lck" path. **This is unproven until root's test 1.**

## Lifecycle (`composite_session.py`)
1. **Before use:** pins; the view via `load_view(--expect-kind, default production)` + `recheck`; `session.pid` (PID + start time) for the stop helper.
2. **qemu-nbd** (`--read-only --shared=1`, the view's image-opts) as our own group child. It is bound by **pidfd + /proc start time + exact cmdline + /proc/PID/exe inode** of the pinned binary. **check-held** runs before the mount.
3. **nbdfuse** `-r -C 1 -o ro` must be our foreground child (pid file) and is bound the same way. The mount must be **ST_RDONLY**, contain exactly `mdbx.dat` of the view's logical size, and refuse an `O_WRONLY` open.
4. **check-held** again, then the validator: the pinned wrapper with its own `--timeout`, bounded by timeout + 600 s; its group and escaped descendants are ended and reaped.
5. **REQUIRED post-use:** our qemu child is still the same process (pidfd alive, start time), and check-held + recheck pass. **Otherwise the outcome is VOID and any validator result is discarded.**
6. **Cleanup always:** the validator, then adopted orphans, then `fusermount3 -u` of our mount only, then nbdfuse, then qemu-nbd. No mount and no process naming the work dir may remain; the socket is removed.
7. **Receipt always** (O_EXCL). Retained: `validator.out` (the wrapper's complete output), `mdbx-report.json` (sha in the receipt) and the child logs.

**Outcomes:**

| outcome | rc | when |
|---|---|---|
| **CLEAN** | 0 | mdbx_chk rc 0 + structurally clean + post-use OK |
| **PROBLEMS** | 2 | mdbx_chk rc 1/2/3 |
| **REFUSED** | 3 | nothing was used |
| **CLEANUP-INCOMPLETE** | 4 | |
| **CANCELLED** | 5 | |
| **EXEC-FAILED** | 6 | fixture exec only |
| **INCONCLUSIVE** | 7 | **any timeout**, truncated or held output, mdbx_chk rc 4/5, wrapper refusal or a missing report, validator leftovers |
| **VOID** | 8 | the post-use check failed |

**CLEAN is not chain, state, trie, canonical-root, RPC or SNP validation, and not a recovery acceptance.**

**Stop:** `jobs/stop-session.sh RUN_DIR` sends SIGTERM only to the recorded session PID, after checking its start time and that its cmdline is this run's `composite_session.py`. No peer is ever signalled.

## Tests (7; expected `Ran 7 tests`)
**Fixtures are real.** The pinned `mk_fixture` (libmdbx v0.13.12) makes a tiny MDBX. Its `mdbx.dat` is split into real r3 records (pinned r3 CLI plan/copy/verify, fixture kind, two targets) and imported as a real r6 fixture view. The session runs as a subprocess.

1. **The real wrapper + mdbx_chk on the composite view:**
   - CLEAN rc 0, with all 12 lifecycle checks true;
   - report rc 0 and `mdbxDatBytes` = the fixture size; report sha bound; output retained;
   - no mount or holder left; parts untouched.
2. **Kind:** the default production refuses a fixture view (no work dir); production + `--fixture-exec` refuses.
3. **Changed part:** changed before use → REFUSED with nothing exposed; changed during use (by the exec) → **VOID**, cleanup complete.
4. **Validator failure:** zeroed meta pages → **PROBLEMS** (report rc expected 3, accepted 1–3), never CLEAN. A failing exec gives EXEC-FAILED.
5. **Cancel:** SIGTERM while the exec mmaps/holds the file and an **escaped setsid holder** holds it → CANCELLED rc 5, holder killed before the unmount, cleanup complete.
6. **Exec timeout or a leftover background child** → INCONCLUSIVE.
7. **Pure classification:** a timeout, missing report, rc 4/5, truncated output, changed identity or wrapper signal is never CLEAN or PROBLEMS; VOID overrides everything.

**Job:** owner, NOT under unshare (FUSE). PASS requires all of:
- exactly 7 tests, last line OK, empty stdout, no ResourceWarning/skipped/FAIL/ERROR/Traceback, rc 0;
- **peers' FUSE mounts and qemu-nbd/nbdfuse/fuse2fs processes identical before and after**;
- no mount left under the run dir;
- the stage unchanged.

The receipt is retained.

## Root invocation (fixtures at a batch boundary)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh cmv-r1-tests 512 bash composite-mdbx-validation-stage/r1/jobs/tests.sh     # expect "## PASS (7)"
```
**Production (gated):**
```
bash jobs/q-exit-status.sh cmv-r1-prod 2048 bash composite-mdbx-validation-stage/r1/jobs/root-composite-validate.sh VIEW_DIR [TIMEOUT_SEC]
```
**Run it only after ALL of:**
- a passing cmv-r1 receipt for these SUMS (checked by the job);
- r3 status shows all 265 parts verified in CONFIRMED sessions;
- an r6 **production** view from `root-view-import.sh`;
- a memory and time window.

## Remaining limits
- **Unproven until root's fixture run:**
  - (a) `nbdfuse -o ro` gives ST_RDONLY. If not, the wrapper refuses → REFUSED/INCONCLUSIVE, never a false CLEAN;
  - (b) libmdbx opens the FUSE `mdbx.dat` (mmap, without-lck) through nbdfuse;
  - (c) the exact cmdline equality for qemu-nbd/nbdfuse (neither is known to rewrite argv);
  - (d) the corrupt-meta fixture yields mdbx_chk rc 1–3, not 4.

  Any of these failing is a test FAIL, not a silent pass.
- **Output retention:** the wrapper keeps only the last 8 KiB of `mdbx_chk` text in its report. Its full output is not retained beyond what the wrapper prints (`validator.out`). Keeping all of mdbx_chk's output would need a new validator revision, deliberately not done here.
- **Production cost is unmeasured:** one ~1.13 TB read through QEMU vmdk → NBD → FUSE, plus a ~556 MB pagemap. The memory cap of 2048 in the production line is a placeholder for root to set. The 16 GiB host floor stays with the queue guard.
- **Detection, not prevention:** parts stay same-user writable on read-write filesystems; post-use VOID detects a change.
- **No owned-node, chain, state, trie or canonical-root validation; no RPC or SNP readiness.**
