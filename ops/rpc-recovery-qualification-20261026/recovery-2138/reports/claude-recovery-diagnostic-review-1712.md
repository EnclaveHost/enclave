# 1712: independent read-only review of the diagnostic full-MDBX exposure: overlay r7, MDBX validator r4, overlay r8

**Scope:** source review only. No tests, builds, mounts or reads of live data, and no edits to any stage.

**Metadata I read:**
- `findmnt` and `lsblk` for the original's mount;
- the SHA256SUMS of each stage.

**Stages:**

| stage | SHA256SUMS | status |
|---|---|---|
| `recovery-overlay-stage/r7` | `ea84f64a…` | verified; root 1704 20 PASS, plan 1706 PASS (from the brief) |
| `mdbx-recovery-validator-stage/r4` | `82394b02…` | verified; 20 PASS per the brief |
| `recovery-overlay-stage/r8` | `6fcb7a6d…` | **froze at 14:35 during this review** (15 entries), verified |

**r8 vs r7:** `overlay_session.py` and `overlay_plan.py` are **byte-identical to r7**. The new parts are `diagnostic_request.py`, `diag/run_validator.py`, `jobs/root-diagnostic-expose.sh`, `common.sh` (`mdbx_guards`) and `tests/test_diagnostic.py`.

**Not available:** `logs/claude-diagnostic-exposure-1707.md` did not exist at 14:35, and root has not run r8's tests.

## Verdict
- **No path that writes to the original was found.** Diagnostic results cannot be labelled as acceptance.
- **Before running:**
  - **one authorization gate:** the reads go to a USB device while the USB pause is active;
  - **one robustness defect:** an interrupted validator is not stopped;
  - **one realistic expected failure:** the deadline.
- **To check cheaply (possible guaranteed failure):** whether the read-only mount can traverse `/data/db` at all, which depends on permissions.

## Findings
**G1. AUTHORIZATION: the original is on a USB device.**
- **The device:** `base-origin.qcow2` is on `/dev/sda2` (`fuseblk`, `ro`), and `lsblk` reports `sda TRAN=usb`, a "JMicron H/W RAID5" of 32.7 T.
- **What reads it:** every r7/r8 exposure reads that USB array through qemu-nbd.
  - `qemu-img info` is a small read.
  - The diagnostic is a **full read of about 1.13 TB** of MDBX pages, for up to about 24 h.
- **The conflict:** the standing **USB pause** has to be **explicitly lifted for read-only access** before `rov-r8-diag` runs. Writes remain impossible: the mount is `ro`, the jobs check `findmnt ro` and `! -w`, and the session refuses a writable parent and requires `ST_RDONLY` before and after.
- **Also consider:** a peer uses the same array, so a day of contention is expected.

**G2. EXPECTED FAILURE: the deadline (not provable from source; probe first).**
- **What the deadline requires:** 1.13 TB within `VALIDATOR_TIMEOUT ≤ 84,600 s` needs **≥ 13.4 MB/s and ≥ 3,285 4-KiB pages/s on average**.
- **Why that is unlikely:** `mdbx_chk` walks B-trees through mmap faults, in tree order, which is largely random by physical page. Each miss crosses four FUSE/NBD hops: fuse2fs → nbdfuse → qemu-nbd → the qcow2 file on ntfs-3g `fuseblk` → USB → HDD RAID5. Random 4-KiB reads there are plausibly **100–1000 pages/s, i.e. 3–30 days**. Only largely sequential access with effective readahead would finish in time.
- **What a timeout looks like:** it ends as `mdbx timedOut`, `structurallyClean false`, session rc 6. That is **inconclusive**, correctly not a pass.
- **Recommendation:** first run the same job with **VT = 1800–3600** as a throughput probe. Use the observed rate to decide, rather than spending about a day of USB reads on a probable timeout.

**F1. DEFECT: an interrupted validator is not stopped before unmount (`overlay_session.py` r7 = r8, `use()` and `cleanup()`).**
- **When it happens:** a SIGTERM, SIGINT or SIGHUP (root cancel, the job's `timeout`, a queue stop) or an `OSError` while `--exec` is running raises out of `use()`.
- **What cleanup does wrong:**
  - `cleanup()` ends only `fuse2fs`, `nbdfuse` and `qemu-nbd` (`:471-473`). The live `exec` child (its own session) is **never `stop_group`ed**.
  - `reap_adopted()` explicitly skips live Popen children (`:398`).
  - `fusermount3 -u` then meets EBUSY, because `mdbx_chk` holds the mapped file.
  - fuse2fs is TERMed, so its unmount is libfuse's own. The validator survives until I/O errors kill it.
  - The leftover scan then most likely sets `cleanupComplete=false`, giving **rc 4**.
- **Impact:** it **fails safe**. Nothing is written, and the original's fds close when qemu-nbd dies. But cancellation is not clean, and the run is flagged rc 4.
- **Fix (one line, a new revision):** at the start of `cleanup()`, `if "exec" in self.children: self.end_child("exec")` (`stop_group` of the validator's group), then `reap_adopted()`, then the unmounts.
- **Add a test:** SIGTERM to the session during `--exec` (the existing SIGTERM tests cover `--hold-seconds`).

**F2. QUEUE AND GUARD CANCELLATION: stale FUSE mounts are possible.**
- **The kill timing:**
  - `memory-guard.mjs` SIGTERMs **every** process in the tree at once and SIGKILLs it 2 s later (`:38-39`);
  - `claude-test-queue.py` `stop()` does TERM, then KILL after 1 s.
- **The consequence:** the session's cleanup (up to a 20 s unmount grace per child) can be cut short. The job shell's final mount and peer checks then never run, and `runs/diag-*/work/{mnt,view}` can remain as dead FUSE mounts.
- **The original is not held:** qemu-nbd is dead, so its fd is closed.
- **Recommendation:** document a post-cancel step for root. Run `grep runs/diag- /proc/self/mountinfo`, then `fusermount3 -u -z` on **only those two paths**, then re-run the peer snapshot. Never run the overlay on top of a leftover.

**F3. MEMORY.**
- **The settings:** the r8 header says queue **4096**; the brief says a 2560 MiB cap. The guard kills on the **sum of `VmRSS`** of the tree, which **includes mapped file pages**. The scope sets `MemoryMax=<cap>` with `MemorySwapMax=0`.
- **Anon estimate:** `mdbx_chk` pagemap ≈ 556 MB (r4 README), plus fuse2fs `cache_size=64M`, plus qemu-nbd, nbdfuse and python: well under 1 GiB.
- **Why it should fit:** file pages are reclaimable within the cgroup. Unmapped page cache (fuseblk, nbd) is also charged, so the cgroup limit tends to keep `VmRSS` below the cap.
- **Verdict:** **2560 is plausible, not proven.** Its risk is heavy reclaim that slows the run further (G2), not a guaranteed guard kill. 4096 gives margin.
- **Host floor:** 16 GiB plus the cap plus the reservations is enforced at start and every 250 ms. Page cache counts as `MemAvailable`, so it is not consumed.

**F4. POSSIBLE GUARANTEED FAILURE (verify cheaply): permissions on the real directory.**
- **The setup:** the real `/data/db` directory inode 1949710 is **mode 0750, owner 994:985** (`logs/base-journal-copy-1626/db-inode.out`). The session runs **as uid 1000**, the jobs refuse root, and it uses `fuse2fs -o ro,norecovery,fakeroot`.
- **What decides it:** whether uid 1000 can traverse `/data/db` depends on whether fuse2fs 1.47.4 enables **kernel `default_permissions`**. If the kernel checks against uid 994 / 0750, `os.stat(target)` and `mdbx_chk` fail with EACCES.
  - That gives session rc 3 or 1 **every time**.
  - The fixture tests would not catch it if the fixture's `/data/db` is 0755 or owned by the runner.
  - The file itself is 0644 in the tid-17169 slot I read for 1659.
- **What to check:** whether `fuse2fs` 1.47.4 adds `default_permissions` or `fakeroot` bypasses it, or add a fixture with `/data/db` 0750 owned by another uid (debugfs `sif`).
- **Not determined by me** within the turn limit.

## Confirmed correct (source)
- **The original cannot be modified:**
  - read-only mount (`findmnt ro`, `ST_RDONLY` before and after) and not writable by the user;
  - `qemu-img create -u` (the backing file is not opened); `qemu-io` writes **only the overlay**, with `backing.read-only=on,locking=off`;
  - `qemu-nbd --read-only --shared=1`; `nbdfuse -r`; `fuse2fs ro,norecovery`;
  - `RLIMIT_FSIZE` = cap on every child;
  - the parent's identity (dev/ino/size/mtime/ctime) is re-checked; the overlay is deleted; peer mounts and processes are compared by exact `comm`.
- **No BLOCKED → pass mislabel:**
  - The request must have `recoveryAccepted: false` and `productionUse: false` exactly.
  - Its history must re-hash to the pinned `postdelete-bitmap-stage/r2` check (`25abe05e…`) **and** carry its own `verdict == "BLOCKED"`; a PASSED history is refused.
  - A GO file and a request are mutually refused.
  - The summary says `kind: DIAGNOSTIC`, `recoveryAccepted false`, with explicit meaning text; the job's rc legend says "DIAGNOSTIC ONLY".
- **Pins:**
  - plan `c4e38213…` (and `overlay_plan.py` `cmp` against r7), journal `d95d81fc…`, history sha;
  - MDBX r4 SUMS, `mdbx_chk` `c228b462…`, `mdbx_check.py` `f0d27e40…` (copied, then re-hashed before `execv`);
  - fuse2fs and the qemu/nbdfuse binaries.
- **Deadlines nest:** `mdbx_check --timeout` ≤ 84,600 < `--exec-timeout 86400` < `timeout -k 300 90000`. `mdbx_check` kills its own `mdbx_chk` group on its deadline or on cancellation (r3), and orphans are reaped by the session as subreaper.
- **Output fits the file-size limit:** `mdbx_check` `OUTPUT_CAP` 16 MiB < the 64 MiB `RLIMIT_FSIZE` of the exec child.
- **The distinctions are kept:**
  - JBD2-authenticated metadata patches ≠ authenticated data blocks;
  - an MDBX structural check (no page checksums) ≠ value integrity ≠ state or chain validity;
  - nothing makes the candidate canonical without our own L1 anchor.

## Minor
- **Stale README:** r8's README is r7's (it still says "r6", with r1 commands). It has no r8 or diagnostic section, and the request format is documented only in `diagnostic_request.py`.
- **Path pinned, not file:** the history path points into `postdelete-bitmap-stage/r2/runs/…`, which is outside that stage's SUMS. It is pinned by sha, which is fine.
- **Test count:** not checked for r8's `tests.sh`/`test_diagnostic.py`. Root still has to run r8's tests with an exact-count gate.

## Order recommended to root
1. Run r8's tests and record the receipt.
2. **F4 check.**
3. **Fix F1** in a new revision (or accept rc-4 cancellations knowingly).
4. **Explicit USB-read authorization (G1).**
5. **Probe run** with VT ≤ 3600 (G2).
6. Only then the full run, at 4096 or a justified 2560.

**Main state helper:** `base-state-readonly-stage/r2` remains **prepared and unbuilt**. Negative fixtures alone do not qualify its algorithm; positive cases are needed later.
