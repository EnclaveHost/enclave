# recovery-overlay-stage/r6: a disposable READ-ONLY recovery view of the deleted `/data/db/mdbx.dat` (prepared by Claude 1660/1674/1694/1699; NOT run)

This is a **diagnostic recovery view**, not a recovery, a restore or a production acceptance.
- **The data blocks are not authenticated** (`data=ordered`: never journaled). The view only lets a read-only validator (1661) read the 1.14 TB file without copying it.
- **The original image stays read-only:** it is opened only as a read-only qcow2 backing on its read-only mount.
- **Nothing is ever written** to the original filesystem, a device, the USB, a guest or a peer.

## Design (existing purpose-built tools; minimal new code)
1. **`overlay_plan.py` (offline):** builds the patch plan from root's proofs and verifies every patched byte twice.
   - **Authentic:** it is the exact JBD2 image root's verifier proved (1649 `result.json`: journal block + sequence, committed, not partial). Its unescaped content is re-read from the sha-pinned local journal copy and must equal `contentSha256`.
   - **Consistent** (the frozen `ext4-recovery-checksum-stage/r2` checker, sha-pinned, crc32c cross-checked against libext2fs):
     - the 256-byte inode 1950053 for generation 3326586236, live, regular, extent-mapped, 1,138,166,333,440 bytes;
     - the **exact** set of 28 tree blocks it references (index 499155449 plus 27 leaves; no missing, no extra), each block-checksum-valid with the right parent logical start;
     - the leaf extents **equal root 1658's `map.extentList`**;
     - the `/data/db` directory block 499122346: its `ext4_dir_entry_tail` checksum must verify for dir inode 1949710 **generation 1611750745**, and it must hold exactly one live `mdbx.dat` → 1950053, file type 1. It is the **latest** proven image at or before the inode's sequence 17169; an older image is never chosen silently.

   **Patches:**
   - **the 256 inode bytes only** (block 499122230 + 1024; the 15 other inodes in that table block stay current);
   - the 28 tree blocks;
   - the directory block.

   That is 30 patches, 119,040 bytes (256 + 28 × 4096 + 4096; root 1680 measured 119,040 - the earlier 118,272 was an arithmetic error).
2. **`overlay_session.py`:**
   - **The overlay:** a **new** qcow2 overlay in the run's private dir (`qemu-img create -u -F qcow2 -b ORIGINAL`). `qemu-io write -s` writes exactly the plan's sources **into the overlay only** (the backing is read-only, with backing locking off, so the peer's read-only users are undisturbed). The overlay must be **≤ 64 MiB** (expected about 2 MiB: 30 × 64 KiB clusters plus metadata) and pass `qemu-img check`.
   - **Exposure** uses the same tools as the peer (the peer runs nbdfuse in command mode; here they are separate processes, with `nbdfuse -C 1` to match `--shared=1`), as **our own foreground children**: `qemu-nbd --read-only` (a unix socket in our work dir), then `nbdfuse -r`, then the pinned peer `fuse2fs -f -o ro,norecovery,fakeroot,cache_size=64M`.
     - **No `--fork`, no daemon.** Signals go only through our unreaped `Popen` handles, so a PID can never be reused under us.
     - An `nbdfuse` that daemonizes is refused.
   - **Checks:**
     - every patched region reads back exactly;
     - writes to the nbd file and to the mount are refused (`EROFS`/`EACCES`/`EPERM`);
     - the target is a regular file of the planned size;
     - **fixture:** a whole-file sha256 equals the expected value;
     - **real:** ≤ 64 bounded samples read through the filesystem equal the same blocks at the restored map's physical addresses.
   - **Then:** `--exec VALIDATOR…` (`RECOVERY_TARGET=<path>`), or `--hold-seconds N` (stop early with `touch RUN/STOP`).
   - **Cleanup always runs:**
     - `fusermount3 -u` of **our two mountpoints only**;
     - our children reaped (TERM, then KILL, through our handles);
     - our socket removed and the overlay **deleted**.
   - **Then verified:**
     - no process still names our work dir;
     - no mount of ours remains;
     - the parent's identity is unchanged (dev, ino, size, mtime_ns, ctime_ns; plus sha256 for the fixture);
     - the job also compares the **peers'** mounts and processes before and after.

## Why the qcow2 overlay + fuse2fs (and not a custom FUSE extent file)
| | **A: overlay + qemu-nbd/nbdfuse/fuse2fs (chosen)** | B: a minimal custom FUSE extent file |
|---|---|---|
| new code in the read path | **none**: libext2fs walks the restored tree, and **re-verifies** inode/extent/dir checksums on every read | new mapping and read code (unreviewed) |
| proven in this deployment | the peer's identical chain serves `base-files` today | no |
| independent check | libext2fs's own csum verification versus our plan checker | only our own map |
| cost | about 2 MiB overlay; the target path only | none |
| risk | the overlay makes OTHER current files inconsistent (inode-table neighbours unchanged; reused blocks/bitmaps), so it is **never** mounted RW, booted or used for anything but this file | small |

**B is the fallback** if fuse2fs refuses the restored file. Its map would be the same verified `extentList`, served read-only over the same nbdfuse view.

## Files
- `overlay_plan.py`
- `overlay_session.py`
- `fixture/make_fixture.py`
- `tests/test_recovery_overlay.py` (8 tests)
- `jobs/common.sh` (pins and guards)
- `jobs/tests.sh`, `jobs/root-plan-real.sh`, `jobs/root-expose-real.sh`

**Pinned:**
- the peer `fuse2fs` 1.47.4 `6e3b5404…`;
- `qemu-img` `3a57bce6…`, `qemu-io` `085e254e…`, `qemu-nbd` `b0f16ff7…` (11.1.2);
- `nbdfuse` `51c1a1fd…` (1.24.4);
- the checker `662291e5…`;
- the journal copy `d95d81fc…`, result `f2ea7adc…`, candidates `70180b22…`.

## Fixture (`make_fixture.py`, unprivileged, image files only)
1. **The filesystem:** a 96 MiB ext4 with the same features (metadata_csum without a seed, 64bit, extent, huge_file, a journal).
2. **The target:** `/data/db/mdbx.dat` has 3000 blocks with every odd block 1..2799 punched, giving 1401 extents and a **depth-2** tree like the real one.
3. **The capture:** pre-delete images are taken from debugfs's own `(ETBn)` listing (independent of the code under test). The expected content comes from a Python model, which must equal `debugfs dump`.
4. **The delete:** `debugfs rm`, then the **same inode number reused** by a new empty `mdbx.dat` with another generation, giving `parent-clean.qcow2`.
5. **A reused-data variant:** a filler that must overwrite freed target blocks, giving `parent-reused.qcow2`.

**Tests:**
1. **The exact restored view:** sha256 equal, every write refused, overlay ≤ cap, cleanup complete, parent sha256 unchanged.
2. **Reused data:** **detected** (`targetExact` false, rc 1), with cleanup complete.
3. **A tampered tree image** with updated hashes: refused by its **CRC**.
4. **A wrong directory generation:** refused.
5. **A missing tree block:** refused.
6. **Over the cap:** refused before any exposure, with cleanup complete.
7. **A writable parent:** refused before anything is created.
8. **The read-only contract** is present in the commands.

## Root order
```
bash jobs/q-exit-status.sh rov-r1-tests 512 bash recovery-overlay-stage/r1/jobs/tests.sh
```
Expect `## PASS (8)`.

```
bash jobs/q-exit-status.sh rov-r1-plan 256 unshare -Urn bash recovery-overlay-stage/r1/jobs/root-plan-real.sh
```
Offline; expect 30 patches, 119,040 bytes (256 + 28 × 4096 + 4096; root 1680 measured 119,040 - the earlier 118,272 was an arithmetic error), 9001 extents.

**Only after the transient-reuse gate (1659) passes:**
```
bash jobs/q-exit-status.sh rov-r1-expose 512 bash recovery-overlay-stage/r1/jobs/root-expose-real.sh PLAN_DIR GATE_RECEIPT -- <validator…>
```

## r2 changes (root 1673, review 1671, the 1660 report)
- **Fixture parsing (root 1673):** debugfs STDOUT only is parsed. STDERR may hold only the version banner; any other line refuses. `blocks` must be only numbers.
- **Hard bounds before writing:**
  - ≤ 64 non-overlapping patches and ≤ 1 MiB in total;
  - a worst-case qcow2 growth estimate (header, L1, refcounts, data clusters, L2 tables, plus 1 MiB) must be within the cap **before any file exists**;
  - **`RLIMIT_FSIZE` = cap** and no core files on **every** child (qemu-img, qemu-io, servers, validator).
- **Real mode:** `--require-ro-mount`, i.e. the parent's filesystem is `ST_RDONLY` before and after; plus `--plan-sha256` and a root **GO file** bound to the plan sha, the journal sha and the 1659 gate receipt sha.
- **Process ownership:**
  - every child runs in its own process group, signalled only as a group while its leader is still our **unreaped** child (`waitid WNOWAIT`);
  - the session is a **child subreaper**, so escaped descendants (setsid or double fork) are adopted, killed and reaped;
  - `PR_SET_PDEATHSIG=SIGTERM` on every child;
  - SIGTERM/SIGINT/SIGHUP run the full cleanup (rc 5);
  - waits are ≤ 5 s per phase;
  - the leftover scan includes `/proc/*/{cwd,root,fd}`.
- **Validator:** `--exec` failure, timeout or a left-behind descendant gives **rc 6** (everything killed and reaped).
- **`fuse2fs`:** a private, sha-verified copy is executed.
- **Chronology:** the real plan refuses if a newer committed image ≤ the inode's sequence is still valid for (ino, gen), if a chosen image was revoked in that window, or if an unproven reference falls in it.
- **Tests:** 20 in total:
  - real-mode plans on **synthetic** verifier/candidate inputs built from the fixture capture (`fixture/make_jbd2_inputs.py`): equality with the fixture plan, a tampered sha, a newer valid leaf, revoked/unproven/partial images, an invalid latest dir image, and JBD2 escape;
  - `ST_RDONLY`, validator failure, escape and timeout, `RLIMIT_FSIZE`, and SIGTERM/SIGKILL mid-hold.
- **Never** `cd` a shell into the mount (EBUSY); inspect only through the validator or STOP.

Root r3 fixes the incompatible GNU df -P/--output combination in the fixture free-space guard; runtime and tests are byte-identical to r2.

Root r4 removes debugfs dump -p in the disposable fixture: preserving root ownership fails under an unprivileged user; only exact file bytes are needed and their independent hash check remains unchanged. Runtime unchanged from r2/r3.

## r5 (root 1692)
- **The cause:** `qemu-nbd` refused `--socket=<absolute path>` because the test run dir made the path longer than the 108-byte `AF_UNIX` limit, so 6 of the 20 tests failed for that one reason.
- **The fix:** `qemu-nbd` and `nbdfuse` are spawned with `cwd` = our private work dir and both use the relative name `nbd.sock`. `self.sock` stays absolute for the readiness check and the cleanup. Every image, mount and pid-file path stays absolute. No new external path, no `/tmp`. Bounds, process ownership and cancellation, and the read-only protections are unchanged.
- **Test 8** also asserts the relative socket and that `cwd=self.work` is used exactly for these two children.

## r6 (root 1697)
- **The socket path:** `qemu-nbd` refuses a relative `--socket` ("socket path must be absolute"). Both children now get **`SOCK_ARG = /proc/self/cwd/nbd.sock`**, which is absolute and 23 bytes, and both are started with `cwd` = our private work dir.
  - **Resolution:** the kernel resolves `/proc/self/cwd` per process, i.e. to our work dir.
  - **Before `nbdfuse` connects,** the full path `self.sock` must be a **socket owned by this user** in the work dir.
  - **Unchanged:** cleanup uses the full path; all image, mount and pid paths stay absolute; no `/tmp`, no shared path.
- **The peer snapshot** (`jobs/common.sh`): it uses the **exact process names** (`pgrep -x qemu-nbd|nbdfuse|fuse2fs`), so command-line text that merely mentions a tool no longer counts. The command line is used only to exclude this stage's own `runs/`. Any other change, a disappeared or new peer, still fails the run.
- **Test 8** asserts `SOCK_ARG` and its use by both children.
