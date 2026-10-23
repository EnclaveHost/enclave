# Cache kernel gate: real dm-cache writethrough + budget v2 accounting, bounded local test (RESULT, 2026-10-23)

**Status: REAL KERNEL TEST of the unmodified production storage logic, in a throwaway QEMU/KVM guest; host untouched.**
- **Not done:** no production cache, no `/etc/enclave-rpc-cache` ledger on the host, no host loop, dm or mount, no host
  module load, no sysctl, no SSH, no live chain, no physical-disk write, no push.
- **Not edited:** S's and P's trees (immutable sources vendored read-only); the browser work.
- **Commits:** repo `work/cache-native-boundary-20261023`, author SteveDeFacto; pins in §7.

## 1. Why a guest, and what that means

**Host capability, measured** (`logs/cap-1.out`):
- `sudo -n` → "a password is required" (no password request was made);
- not in the `disk` group (`/dev/loop-control` is `root:disk 660`);
- `/dev/mapper/control` is `root 600`;
- an ext4 loop mount in a user namespace → "Permission denied";
- `dm_cache` is not loaded, and loading host modules is forbidden.

**So the host kernel cannot run this test within the rules.**
- Docker-group escalation was **not** used: it would bypass the privilege model and would still need a host module load.

**Instead** (`logs/vmp-1.out`): QEMU 11.1.2 + KVM (I'm in the `kvm` group) boots the host's **installed kernel package**
`/boot/vmlinuz-linux` = **7.2.11-arch1-1**. The host still runs 7.2.8 because it hasn't rebooted since the upgrade, so
7.2.11 is the kernel production gets on its next boot.

**The guest:**
- **Root:** a tmpfs with the host `/usr` mounted **read-only** over 9p (the real tools, Python and modules).
- **Exports:** `/src` = this repo, read-only; `/out` = the run's owned output directory.
- **No network device.**
- **Two virtual SCSI disks** backed by **owned sparse files** in `run/<ts>/`:
  - `hdd.img` 256 MiB, `rotation_rate=7200` → guest `rotational=1`;
  - `nvme.img` 160 MiB, `rotation_rate=1` → `rotational=0`.
- **Devices:** every loop, dm-crypt, ext4 and dm-cache device is created inside the guest, on those files only.
- **Modules** load in the GUEST kernel only.

**Scale and environment seams:**
- **Origin filesystem:** `/usbtest` is ext4 on the rotational disk, standing in for NTFS `/mnt/usb`. NTFS is not tested.
- **Cache filesystem:** `/vmtest` is **ext4 on a dm-crypt LUKS2 mapping** (a fixture key generated in the guest and
  deleted afterwards) on the non-rotational disk, matching production `/vm` (`cryptvm`).
- **`loop` and `dm-crypt` are preloaded** in the guest. Production relies on kmod static-node autoload, because `create`
  does not `modprobe loop`, and this guest has no udev or static nodes.

## 2. Exact production logic and the only seam

**Scripts:** rendered by **S's own `holder.storage_script()`** (`holder.py` `c73a4351`, S `959e56fd`) and **P's own
`l1pair.storage_script()`** (`l1pair.py` `a25bd4ea`, P `f835148`) from S's template `eb6a209d`.
- `harness/render.py` asserts the template body is byte-identical; only `@CONSTANTS@` differs.

**Budget:** S's **`budget.py` `529e155f`** (format v2), unmodified.

**Seam** (`run/<ts>/out/render/seam.json`):
- **Sizes:**
  - origin 160 MiB / 32 MiB;
  - cache data 64 MiB / 8 MiB;
  - metadata 16 MiB / 8 MiB;
  - free margins 0.
  - Production is 3.1 TB / 198 GB / 1 GiB, with margins 500e9 / 200e9. **The validators' minima were not changed and
    not run.**
- **Paths:** `/usbtest`, `/vmtest`, and the budget tool at `/src/vendor/holder/budget.py`.

**Ledger:** a FIXTURE at the canonical path `/etc/enclave-rpc-cache/nvme-cache-budget.json`, inside the **guest's private
tmpfs `/etc`**, with a fixture machine-id.
- Both reservations' slack equals `required_headroom()` exactly, and the host share is exactly full: 101,027,840 B =
  bookkeeping 77,824 + holder 84,115,456 + pair 16,834,560.

**Everything else is production code:** commands, order, checks, mapping table, names, ledger rules.

## 3. Results

Final run vm-3, `run/20261023T094842Z/`. Every rendered-script exit code is in `receipts-*.jsonl`. vm-2 repeated all
non-interruption checks with the same results.

| Check | Result (actual) |
|---|---|
| Next reservation at a full share | **refused**, exit 3: "reservations plus bookkeeping 101048320 exceed its share 101027840" |
| holder / pair `create` (exact scripts) | exit 0 / 0. `verify-cap` exit 0, chargedBytes = share |
| **Budget actual vs max, real ext4 on dm-crypt** | holder files+markers 83,894,272 ≤ max 84,115,456 (declared 83,886,080, slack 229,376). Pair 16,785,408 ≤ 16,834,560. `budget.py` actual incl. directory charge: 83,902,464 / 16,793,600 |
| ext4 free-block delta for both creates | 104,873,984 B including a 4 MiB foreign fixture → **100,679,680 B for the reservations ≤ the summed maxBytes 100,950,016** |
| Foreign mapping with OUR name | `assemble` **refused** ("not this holder's … leaving it untouched"), exit 2. The foreign table is unchanged afterwards, and no holder loop is left |
| `assemble` | exit 0. Table `0 327680 cache 7:3 7:2 7:1 512 1 writethrough smq 0`. `dmsetup status` shows writethrough, 0 dirty |
| Deterministic I/O | 6 × 4 MiB SHA-256-stream files, each fsynced. Verified after `drop_caches` twice, after orderly `disassemble` + `assemble`, and after `cache-loss` + `assemble` |
| Orderly removal | `disassemble` exit 0: no mapping, no loops, no mount. Foreign loop, mapping and file intact (inode, sha256, loop) |
| Stale-cache hazard (origin mounted WITHOUT the cache) | `assemble` **refused**, exit 2: "run cache-loss first". `cache-loss` exit 0 (metadata zeroed, then `e2fsck -fn`). Then `assemble` exit 0 and data verified |
| Budget verify, grown cache file (+4096) | **refused**, exit 3: "is 16781312 bytes, declared 16777216". Restored → exit 0 |
| **Abrupt power loss** (guest `sysrq b`: no sync or unmount, cache mapped + mounted; second boot) | **direct `assemble` (what the boot unit does)**: exit 0, `needs_check` not set, 0 dirty, **all 10 fsynced files verified**. The non-fsynced file was absent (allowed). **Reviewed procedure** (`disassemble`, `cache-loss`, `assemble`): exit 0, all verified |
| **Corrupted cache device** (garbage over all of cache data, metadata still mapping blocks), read-only probe WITHOUT `cache-loss` | **dm-cache serves the garbage.** vm-2: 167/256 blocks cached → **10,688 of 40,960 4 KiB blocks differ** from the origin and **ext4 cannot be mounted**. vm-3: 1 cached block → 64 blocks differ, mount fails (superblock in the cached block). **Reviewed `cache-loss` → `assemble`: all data verified.** So a suspect cache device must go through `cache-loss`; dm-cache has no content checksums |
| Final teardown | `disassemble` (holder, pair), the test's own foreign fixtures removed, umount, `cryptsetup close`: **no loops, no dm devices, no test mounts** in the guest |
| Host before/after | identical: no loops; dm `control cryptroot cryptvm`; the same block devices and mountinfo hash; 0 QEMU processes; images and key deleted |
| **Allocation cap** | `du` of the test directory: start 2.2 MB, peak **219,762,688 B** after phase two, **≤ 536,870,912 B (512 MiB)**, end 2.4 MB. Disk images: 268,435,456 + 167,772,160 B apparent (sparse) |

**Host filesystem, unprivileged, without a guest** (`logs/hostfs-1.out`):
- **Setup:** S's `budget.py` on the REAL workspace filesystem (ext4 on dm-crypt `cryptroot`, block size 4096), inside a
  private user and mount namespace whose `/etc` is an overlay (canonical ledger path + fixture machine-id). The real
  `/etc` is unchanged, and `/etc/enclave-rpc-cache` was absent before and after.
- **Results:**
  - `admit` / `allocate` / `verify` all exit 0;
  - files exactly sized and fully allocated (8,388,608 / 4,194,304);
  - actual 12,599,296 ≤ max 12,640,256;
  - free delta 12,591,104 (noisy shared filesystem);
  - the next reservation is refused, and a grown file is refused (exit 3);
  - files removed.

## 4. Interruption and source bugs found (fixes in isolated commits; S's immutable template unchanged)

**SIGTERM to the whole process group** (as systemd sends it) during a fresh `create` of the pair, swept across its
measured uninterrupted duration (0.273 s in vm-3, 0.56 s in vm-2):

| Template | Interrupted attempts | Leftovers |
|---|---|---|
| **Production `eb6a209d`** | vm-3: 7 (4 before the origin existed) | **3 of 7 left the origin image AND an attached loop (`/dev/loop1`)**, at 0.191 / 0.232 / 0.259 s; plus owned markers at 0.259 s. Exit -15, no unwind message: **bash does not run the EXIT trap on SIGTERM**. The next `create` refuses ("origin exists"), so recovery needs a manual loop detach and origin removal |
| **Fixed (0001 + 0002)** | vm-3: 8 (0.12–0.37 s; 4 others completed before the signal) | **none**: exit 143, "undid only what this run created/attached/…". In one case (0.37 s) the killed `budget.py` left its owned markers, and the next fixed `create` **adopted** them: exit 0, `verify-cap` 0 |

**Fix 0001** (`fixes/0001-create-free-space-credits-adopted-cache-files.patch`):
- **The bug:** `create`'s NVMe free-space preflight required the FULL cache size even when this reservation's owned files
  already exist (an interrupted or repeated create).
- **Measured:** vm-2/3: production `create` → exit 2 "not enough NVMe free space" while `budget.py` would adopt the
  files. The fixed `create` → exit 0, `verify-cap` 0.
- **The fix:** only the not-yet-allocated bytes need free space.

**Fix 0002** (`fixes/0002-signals-take-the-unwind-path.patch`):
- **The fix:** `trap 'exit 143' TERM; trap 'exit 130' INT; trap 'exit 129' HUP`, so signals take the existing unwind.
- **Measured:** 8/8 interrupted fixed runs left nothing.

**Residual, documented:**
- If the shell is killed with SIGKILL or by power loss, nothing can unwind. The recovery is: detach the loop bound to
  the run's origin file, remove the unmarked origin, then re-run `create`, which adopts owned cache files and markers.
- Root should decide whether `cache-loss` should also detach the origin loop it attaches. It currently leaves it
  attached, and the next `assemble` reuses it.

## 5. What this does NOT establish (remaining hardware gates)

- **Not the production hardware:** the real NVMe (`/vm`, `cryptvm`), the real USB RAID5 HDD, or NTFS on `/mnt/usb`.
  Behaviour of the origin image on ntfs3 is untested.
- **Not a real host power loss:** host page cache, USB-bridge FUA/flush behaviour, and the QNAP RAID write cache (S
  measured QD1 and no FUA) are not exercised. The guest crash test proves dm-cache/ext4 semantics, not the physical
  write ordering of that enclosure.
- **No throughput, sizing or full-scale result:**
  - no throughput, hit rates or HDD full-sync performance;
  - no 198 GB cache;
  - the scale is 64 MiB data, 16 MiB metadata, 256 KiB blocks, 256 cache blocks.
- **Not the host's own kernel or devices:** the host kernel 7.2.8 and host device-mapper were not exercised; the guest
  ran the installed 7.2.11 package kernel.
- **No production ledger and no other cache:** the production ledger was not written, and nothing integrates a Sia or
  other cache.
- **Open items unchanged:** the RAM decision is still open; nothing here changes resource limits.

**Remaining gates for root, before any production cache:**
- **H1:** review and adopt fixes 0001 + 0002 into S's template (S's owner); P re-vendors.
- **H2:** create the canonical ledger with real host shares.
- **H3:** run the same harness (or the root-run `drill-cache.sh`) on the real `/vm` + `/mnt/usb` with root, at a bounded
  scratch size.
- **H4:** a physical power-cut test of the USB enclosure, if HDD durability claims are needed.
- **H5:** the operator runbook must say "suspect cache device ⇒ `cache-loss` before `assemble`" (measured hazard, §3).

## 6. Tests and disclosure

All runs went through `work/claude-test-queue.py` (16 GiB floor, one large + small 256 MiB, cap ≤ 1536).

| Run | What | Result |
|---|---|---|
| cap-1 | host capability probe | no sudo, no loop, dm or ext4 mount; dm_cache not loaded |
| vmp-1 | guest feasibility | QEMU 11.1.2 + KVM; kernel 7.2.11; modules on disk; 9p + scsi `rotation_rate` |
| render-1 | renderer dry run | next reservation refused |
| vm-1 | first guest run | all core checks pass. Interruption design flaw: retries hit the free-space bug, which revealed fix 0001's bug |
| hostfs-1 | host-filesystem budget | pass |
| vm-2 | fresh-create sweep + block probe | production: leftovers on SIGTERM (fix 0002's bug); probe 10,688 blocks differ |
| **vm-3** | **final**: production + fixed sweeps | **all pass**; fixed sweep leaves nothing |

**Notes:**
- My first guest init lacked `chmod` in the initramfs (harmless: the ledger mode was set by the harness). Fixed in vm-2.
- **Guest memory:** 640 MiB.
- **Queue memory peaks:** whole process tree (QEMU + guest) 470 / 716 / 715 MiB for vm-1 / vm-2 / vm-3, each ≤ the 1536 lane.

## 7. Pins

- **Source:** commits in this repo (`git log`).
- **Harness:** `harness/{render.py,guest.py,init,build-initramfs.sh,run.sh,host_budget.py}`.
- **Fixes:** `fixes/holder-storage.sh.in` (fixed template), patches `0001` and `0002`.
- **Vendored read-only:**
  - S `959e56fd`: `holder.py` `c73a4351…`, `budget.py` `529e155f…`, `holder-storage.sh.in` `eb6a209d…`;
  - P `f835148`: `l1pair.py` `a25bd4ea…`.
- **Evidence:** `run/<ts>/out/*` (receipts, results, consoles, host identity), `logs/`.
- **Handoff:** `HANDOFF-TO-S-AND-P-STORAGE-FIXES.md`.

## 8. Note on the NucBox target (root's note, 09:45Z; read after the tests)

Root records NucBox (Windows host, Hyper-V, Linux client VM) as the chosen RPC deployment target. The 33 TB HDD stays on
the local desktop unless the inventory shows otherwise.

**For this gate:**
- **What carries over:** the tested shape (dm-cache + ext4 + budget inside a Linux guest, on virtual disks backed by host
  files) is closer to a Linux client VM than the desktop-native plan was.
- **Not measured:**
  - Hyper-V's virtual-disk flush/FUA semantics;
  - NucBox's physical NVMe;
  - any HDD reachable from NucBox: an origin on the desktop's USB RAID would cross hosts, and that is not covered.
- **Added gate H6:** before a NucBox cache is enabled, run this harness's checks inside the actual NucBox Linux VM,
  using its real virtual disks at a bounded scratch size (crash test included). Decide where the durable HDD origin lives
  for that VM. Nothing here allocates on NucBox or assumes its 96 GB.
