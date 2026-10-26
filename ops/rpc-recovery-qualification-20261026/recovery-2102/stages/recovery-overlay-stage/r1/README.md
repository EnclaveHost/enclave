# recovery-overlay-stage/r1: a disposable READ-ONLY recovery view of the deleted `/data/db/mdbx.dat` (prepared by Claude 1660; NOT run)

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

   That is 30 patches, 118,272 bytes.
2. **`overlay_session.py`:**
   - **The overlay:** a **new** qcow2 overlay in the run's private dir (`qemu-img create -u -F qcow2 -b ORIGINAL`). `qemu-io write -s` writes exactly the plan's sources **into the overlay only** (the backing is read-only, with backing locking off, so the peer's read-only users are undisturbed). The overlay must be **≤ 64 MiB** (expected about 2 MiB: 30 × 64 KiB clusters plus metadata) and pass `qemu-img check`.
   - **Exposure** uses exactly the peer's proven pattern, but with **our own foreground children**: `qemu-nbd --read-only` (a unix socket in our work dir), then `nbdfuse -r`, then the pinned peer `fuse2fs -f -o ro,norecovery,fakeroot,cache_size=64M`.
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
Offline; expect 30 patches, 118,272 bytes, 9001 extents.

**Only after the transient-reuse gate (1659) passes:**
```
bash jobs/q-exit-status.sh rov-r1-expose 512 bash recovery-overlay-stage/r1/jobs/root-expose-real.sh PLAN_DIR GATE_RECEIPT -- <validator…>
```
