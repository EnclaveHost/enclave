# NVMe (T710 /vm) capacity review for Base: read-only handoff (2026-10-26, about 04:25 local)

Nothing was deleted, moved, copied, stopped, restarted or reconfigured. No SSH, network, queue tests, or recursive scan of a whole disk. Evidence comes from `df`/`lsblk`/`stat`, `/proc` (own-user processes only), one-level directory listings, bounded `du -s` on flat model directories, `readlink` over the 2,102 manifest entries, and the launcher's own `manifest.json`/`guard-status.json` (no secrets read). The figures for the prior `.pixel10` tree (998 GiB) come from `logs/claude-nvme-capacity-review-result.md` and were **not** re-measured. The reader composition e0d90dab4 is untouched.

## 0. Headline (candid)
1. **The usable `/vm` budget is not 521 GiB; it is about 90 GB.** The running RPC VM's capacity guard (`guard-status.json`, state `armed`) has the following `/vm` thresholds:

   | Threshold | Bytes |
   |---|---|
   | floor | 300.0 GB |
   | pause | 368.7 GB |
   | **ACPI shutdown** | **468.7 GB** |
   | start | 488.7 GB |

   - Free space now is **558.85 GB**, so only about **90 GB** remains before the guard powers the VM down.
   - The guard's measured instantaneous `/vm` growth rate is 1.5 MB/s (L1 and OS, discard=unmap).
   - **Warning:** a guard shutdown would kill Base's in-progress run, and segmented `state.tar.zst` progress does not survive a restart (`claude-download-next-batch-0528.md` §1). L1 growth alone can consume that 90 GB, so this needs root's attention **now**, independent of any Base move.
2. **Relocating codex-archive alone is INSUFFICIENT** for any Base-on-NVMe plan under the current guard policy.
3. **Relocating codex-archive and `.pixel10` together** makes a database-only split (§4, plan B) fit with margin. It makes a whole-image move (§4, plan A) only marginal.
4. **No plan needs to delete unique data.** Both candidates are already single copies on one NVMe. Relocating them to verified copies on the USB RAID5 does not reduce their copy count, but it does **not create a second copy** either (see §5).
5. **Free space is not RPC completion.** Moving Base to NVMe removes the random-I/O bottleneck for MDBX. It proves nothing about extraction completion, the second (134-archive) run, node sync, or finality.

## 1. Actual devices and usage (read-only evidence)
| Device | Filesystem / mount | Size | Used | Free (df, bytes) |
|---|---|---|---|---|
| T710 nvme0n1p1 LUKS → cryptvm | ext4 `/vm` | 3.67 TB | 2.93 TB | **559.05 GB** (guard read 558.85 GB) |
| T500 nvme1n1p3 LUKS → cryptroot | ext4 `/` (includes /home) | 3.93 TB | 2.90 TB | **833.98 GB** |
| USB JMicron HW RAID5 sda2 (rotational, mq-deadline) | ntfs3 `/mnt/usb` (uid 1000, fmask/dmask 0022) | 36.0 TB | 1.90 TB | **34.10 TB** |

T710 also has p3 (236.5G NTFS), p4/p5 (780M NTFS) and p6 (12G vfat). They are unmounted and presumably Windows/recovery partitions. They are **excluded**, because reusing them would be irreversible repartitioning.

**`/vm` top level** (sizes in decimal GB unless marked GiB):

| Path | Size | Notes |
|---|---|---|
| `enclave-volumes/codex-archive` (0700) | **985.2 GB** of artifacts + 1.86 GB git bundles + docs | ONLY copy. Manifest `recovery-documents/artifact-relocation-manifest.json` |
| `enclave-volumes/.pixel10/tensor-sdk` | **998 GiB ≈ 1,072 GB** (prior du; not re-measured) | ONLY copy (prior report). 120 top-level entries; venv, symlinks, hardlinks |
| `enclave-volumes/rpc-production/l1-origin.qcow2` | 528.4 GB apparent / **447.0 GB allocated** | Open by the RPC VM (pid 3695222), discard=unmap |
| `enclave-volumes/rpc-production/os.qcow2` | 18.6 GB / 18.2 GB allocated | Open by the RPC VM |
| model dirs `qwen*`, `fable-*`, `gemma-*` (16 dirs) | about **270 GiB** (`du -s`, rounded up per dir) | Not open by any visible process; inbound references **not checked** |
| `.shield`, `.shield-src`, `.src`, `.shield-pads` | about 48 GiB | Same caveat as the model dirs |
| `warden.qcow2` (libvirt-qemu) | 67.3 GB | No warden qemu process is running (ps lists all users) |
| `ubuntu-24.04.2-live-server-amd64.iso` | 3.2 GB | Re-downloadable |
| `build-tmp-recovery/20261025` | not sized | Within rounding of the residual |

**Base (still on HDD):** `/mnt/usb/enclave-rpc-production/base-origin.qcow2`.
- **Size:** 1,388.6 GB allocated, equal to its apparent size (fully allocated qcow2 file). A second stat about 4 min later read **1,408.6 GB**, so it is growing on the order of tens of MB/s. These are two stat points, **not** a benchmark.
- **Disk settings:** the launcher manifest now declares the disk **4.0 TB virtual** (the backup `backup-base-growth-20261026T0536` shows 3.1 TB before). It is attached with **`discard: ignore`**.

**Recovery copies on USB (must be kept; no plan here touches them):**
- `/mnt/usb/enclave-rpc-production/l1-origin.qcow2` (495.6 GB) and `os.qcow2` (3.1 GB), both pre-move, from Oct 25 09:41;
- `/mnt/usb/enclave-cold-recovery/20261022T195643Z-c16c22ef`;
- `/mnt/usb/enclave-rpc-bootstrap-20261025/*.part`.

## 2. Active-use evidence (and what it does not cover)
- **Open files under `/vm` or `/mnt/usb`, across all readable (user steven) processes:** only qemu pid 3695222, holding `l1-origin.qcow2`, `os.qcow2` and `base-origin.qcow2`.
  - No process has its cwd or a mapping under `codex-archive` or `.pixel10`.
  - Root-owned processes could **not** be inspected without sudo. `sudo lsof +D` was deliberately not run, because it is a recursive walk.
- **codex-archive inbound links:** all **2,102** manifest sources are **symlinks resolving exactly to their archive destination** (985.2 GB in total). The heaviest roots by size:
  - `~/Documents/Codex/2026-09-04` (195 GB)
  - `~/Projects/enclave/shielded` (187 GB)
  - `~/Documents/Codex/2026-09-07` (168 GB)
  - `~/Projects/enclave/.consolidation` (107 GB)
  - `~/hf-convert/gguf/*`
  - `~/gvs5h/model/*.gguf`

  Any app reading those paths reads the archive. "Not open now" does **not** mean "never used".
- **`.pixel10` inbound links:**
  - `~/Documents/Codex/2026-09-07/i-w/work/tensor-sdk` is a symlink to `/vm/enclave-volumes/.pixel10/tensor-sdk`.
  - Three `~/.cache/stale-compiler-tmp/compiler_*/third_party` links (Sept 16) point through that path.
  - The tree's newest mtime is about Sept 22 (prior report). Whether it is cold is **the owner's call**; this review cannot establish it.
- **Model dirs:** no inbound-reference check was done (it would need a home-wide symlink scan). They are therefore **not** proposed as candidates in this round.
- **QMP:** `/run/user/1000/enclave-rpc-production/qmp.sock` is owned by steven and currently has no client. `guard-qmp.sock` is held by the capacity guard; do not touch it.

## 3. Capacity math (decimal GB; guard-aware)
Usable for new RPC data = free − 468.7 GB (the guard's shutdown threshold) − L1 headroom.
- **L1 headroom:** 100 GB is assumed. The earlier observation of 28 GB in 11.6 h was catch-up sync, and the current 1.5 MB/s is an instantaneous figure; neither is a steady-state rate.
- **Usable** (free − 468.7 − 100):

| Scenario | `/vm` free | Usable |
|---|---|---|
| Now | 559 | **≈ 0 (−10)** |
| + codex-archive relocated (+987) | 1,546 | **≈ 977** |
| + `.pixel10` relocated (+1,072) | 2,618 | **≈ 2,049** |
| (optional, after a reference check) + model and shield dirs (+≈340) | 2,958 | ≈ 2,389 |

**Base needs** (evidence: `claude-download-next-batch-0528.md` §2/2a):
- **Current run:** 1,274.29 GB extracted in total, of which state `db/mdbx.dat` is 1,138.17 GB and the remaining ≈136 GB is static files.
- **Final second run:** adds 409.99 GB of static files (221.62 GB compressed archives during download). The preflight also counts an index reserve of 161.04 GB (an estimate) and 30-day growth of 250.52 GB.
- **The two placements need:**
  - **A. Whole Base qcow2 on NVMe.** The qcow2 cannot shrink while it is attached with `discard: ignore`, so it reaches the guest's **high-water mark**. If the 761 GB `state.tar.zst` coexists with the full extraction, that is about **2.07 TB**. After that, with discard enabled on the new node plus a guest `fstrim`, it settles at about 1.68 TB data + 0.16 index + growth ≈ **2.1 TB at 30 days**.
    - Fits only with both relocations (2,049 usable), and **without margin** at the 2.07 TB peak.
    - **Not recommended unless root raises the guard floor policy** (root's decision).
  - **B. Database on NVMe, static files stay on HDD.** MDBX is 1,138 GB, plus the index reserve (≈161 GB, which may be RocksDB, `--datadir.rocksdb`), plus the MDBX share of growth (≈100–150 GB per 30 days, an estimate). That is about **1.40–1.45 TB**.
    - With codex-archive only (977 usable): **does NOT fit**.
    - With codex-archive and `.pixel10` (2,049 usable): **fits with ≈ 0.6 TB margin** for L1 and Base growth.
- **The T500 root (834 GB free)** cannot take either candidate whole. It also hosts /home and the running apps, so its headroom should not be spent on cold data.

## 4. Realistic fix for the HDD bottleneck (not a cache layer)
**The problem:** the bottleneck is MDBX random page I/O (state, tries, history indices) on a parity RAID5 of spinning disks. Static-file segments (headers, transactions, receipts, changesets) are append-only and read by offset, and are far less sensitive to disk type. The source supports a split directly: reth 7134be3 `crates/node/core/src/args/datadir_args.rs` has `--datadir.static-files <PATH>` and `--datadir.rocksdb <PATH>`. The running binary's provenance is inferred, not proven, so `--help` should be checked in the guest.

### Recommended: plan B, a database-only split
Its preconditions are that the relocations in §5 are done and verified, the current run's extraction has finished, and the second run has not started (or has finished). Steps 1, 3, 4 and 7 are guest-side changes for root.
1. **Add the disk.** Create a new qcow2 on `/vm/enclave-volumes/rpc-production/` (as steven, no sudo). Hot-add it to the running VM through the user-owned `qmp.sock`: `blockdev-add` with file + qcow2 nodes, `discard: unmap`, then `device_add scsi-hd`. This needs **no VM restart**, so L1 and OS keep running.
   - The manifest/`provision_vm.py` must also be updated to carry the disk as an `nvme`-backed role, or it is lost at the next boot. That is a **resource-config change** for root.
2. **Gate on guest discard.** In the guest, `lsblk -D` must show discard support; otherwise the bounded-growth accounting is wrong.
3. **Prepare the new filesystem.** Create the guest filesystem on the new disk and mount it (for example `/srv/enclave-base-db`).
4. **Move the database.** Stop **only** the Base holder/node unit (Base is not serving yet). Copy `db/` (and the RocksDB directory, if the layout has one) from the HDD datadir to the new mount, and verify it: `cmp`, or the snapshot tool's own integrity check.
5. **Swap the path.** Point the datadir's `db` at the new location (a guest-side symlink, or the documented flags), then restart the Base unit.
6. **Keep the HDD copy as rollback.** Rename the original `db/` on the HDD instead of deleting it.
7. **Roll back if needed.** Stop the Base unit, restore the original `db` path, and start it again.

**Effect:**
- **Gained:**
  - Base MDBX random I/O moves onto the T710.
  - The NVMe Base footprint is only the live database, which avoids the qcow2 high-water problem.
  - The guard's bounded accounting covers the new disk.
- **Unchanged:**
  - Base download throughput, which remains network/CDN-bound (≈18 MB/s, single connection).
  - Static-file reads, which stay on HDD.

### Alternative: plan A, a whole-image live mirror
`blockdev-mirror` (QEMU 11.1.2) of node `base0` to a new qcow2 on `/vm`, with `sync: full`, `copy-mode: write-blocking`, a `speed` throttle and the target node set to `discard: unmap`. Then `block-job-complete` pivots it, with no guest change and no restart.
- **Rollback:** mirror back the same way. The old USB file stays as a crash-consistent copy taken at pivot time, until verified.
- **Why it is not recommended:** it needs ≈2.07 TB at peak against ≈2.05 TB usable. The manifest must also be repointed immediately after the pivot; otherwise the next boot silently reattaches the stale USB image.

## 5. Relocation candidates: exact plan (prepared; NOT executed)
**Target:** one sparse ext4 image on the USB RAID, loop-mounted, so that owner, modes (0700), exec bits, symlinks and hardlinks survive. ntfs3 cannot keep them: fmask/dmask 0022 and uid 1000 would turn codex-archive from 0700 into world-readable 0755 and strip exec bits from the venv.

**Sudo the user must run** (nothing else needs root, because `/vm/enclave-volumes` is owned by steven):
```
sudo install -d -m 0755 /mnt/vm-cold
sudo mount -o loop,noatime /mnt/usb/vm-cold/cold-20261026.ext4 /mnt/vm-cold
sudo install -d -o steven -g steven -m 0700 /mnt/vm-cold/enclave-volumes
# persistence (fstab; review before adding):
# /mnt/usb/vm-cold/cold-20261026.ext4 /mnt/vm-cold ext4 loop,noatime,nofail,x-systemd.requires-mounts-for=/mnt/usb 0 2
```
(Optional, for root-owned open-file evidence: `sudo lsof /vm/enclave-volumes/codex-archive /vm/enclave-volumes/.pixel10`. This lists only those two directory paths, not a recursive walk.)

**Steps, as steven** (prepared commands; the image is created before the sudo mount):
1. **Create and format the image:** `install -d /mnt/usb/vm-cold && truncate -s 2400G /mnt/usb/vm-cold/cold-20261026.ext4 && mkfs.ext4 -m 0 -L vm-cold -E nodiscard /mnt/usb/vm-cold/cold-20261026.ext4`. The image is sparse on ntfs3, with 34 TB free.
2. **Copy:** `ionice -c2 -n7 rsync -aHAX --sparse /vm/enclave-volumes/codex-archive /mnt/vm-cold/enclave-volumes/`, and the same for `.pixel10`. **Schedule this when Base HDD I/O is low** (for example during the network-bound second-run download). Otherwise the ≈2.06 TB of writes land on the same RAID5 spindles as Base. mq-deadline ignores ionice classes; rsync `--bwlimit` is the effective throttle.
3. **Verify:**
   - **codex-archive:** `sha256sum -c` against `recovery-documents/artifact-sha256.txt`, run inside the copy (paths rebased), plus `cmp` of the 3 git bundles. Also check that a `find -printf '%y %m %s %P'` listing is identical on both sides.
   - **`.pixel10`:** a full `rsync -aHAXc --dry-run --itemize-changes` must print nothing. Check the counts too: 163,114 files, 2,324 symlinks and 1,609 hardlinks (from the prior report).
4. **Reversible swap** (same filesystem, instant):
   - `mv /vm/enclave-volumes/codex-archive /vm/enclave-volumes/.retire-codex-archive && ln -s /mnt/vm-cold/enclave-volumes/codex-archive /vm/enclave-volumes/codex-archive`. All 2,102 absolute links keep resolving through this single symlink. Re-run the 2,102-entry readlink/exists check and sha256 spot checks.
   - Do the same for `.pixel10`. `~/…/tensor-sdk` then resolves through it.
5. **Hold period:** the owner exercises the users of these paths. **Space is freed only at the final step**: `rm -rf /vm/enclave-volumes/.retire-<name>` after the verify step and the hold. This is the only irreversible step, and the data still exists in the verified image.
6. **Rollback:**
   - Before the final step: `rm` the symlink and `mv .retire-<name> <name>`.
   - After it: `rsync -aHAX` back from the image (capacity permitting).

**Unique-data statement:**
- **What is lost:** nothing. Every byte stays in exactly one verified place: the USB RAID5 (single-disk redundancy, same enclosure, **not a backup**) instead of a single NVMe.
- **What is not achieved:** a true second copy. It would need ≈2.06 TB on an independent device, and none exists locally: the T500 has 834 GB and needs it for live work. If the user wants a second copy, that is a new device; that is the honest gap.

## 6. Permission versus unknowns
| Item | Status |
|---|---|
| Reversible relocation of codex-archive and `.pixel10` (copy, verify, symlink, hold) | Technically ready. Needs the **user's go-ahead plus the sudo mount**. Root review comes first. |
| Whether `.pixel10` is cold (Sept work) and whether codex-archive's users tolerate HDD speed | **Unknown**; the owner decides. Not provable from open-file state. |
| Root-owned processes holding those paths | **Unknown** without `sudo lsof` (command above). |
| Model and shield dirs (≈340 GB) | **Not proposed**: inbound references are unchecked. |
| Guard thresholds (shutdown at 468.7 GB free; the 300 GB floor is "operator policy") | Root/user policy. The plans above assume they are **unchanged**. |
| Base disk changes (hot-add, manifest/provision update, guest unit stop and copy, path swap) | Root-only resource-config and guest actions. **Not prepared as code here.** |
| Whether the guest sees discard on the new disk; RocksDB layout; the running binary's flag set | **Unknown**. Verify in the guest before plan B. |
| Whether the extraction deletes `state.tar.zst` after extracting | Unconfirmed (`extract.rs:529` suggests it does). This affects the plan A peak. |

**Not given:** a migration or copy ETA. No throughput was measured; the two stat samples are not a rate guarantee.

## 7. Immediate recommendation to root
1. **Now:** treat the ≈90 GB gap to the guard's shutdown threshold as a live risk to the current Base run. The reversible relocation of codex-archive (≈987 GB) is the fastest safe relief. It needs no Base change, but it adds USB write load: throttle it.
2. **Then:** relocate `.pixel10` (owner confirms it is cold) and execute plan B after the current extraction finishes. That gives the T710 MDBX placement with ≈0.6 TB margin and keeps every app and recovery copy.
3. **Afterwards:** re-run `cached_download_preflight.py` before the second run. Judge RPC readiness only by sync, finality and qualification evidence, not by free space.
