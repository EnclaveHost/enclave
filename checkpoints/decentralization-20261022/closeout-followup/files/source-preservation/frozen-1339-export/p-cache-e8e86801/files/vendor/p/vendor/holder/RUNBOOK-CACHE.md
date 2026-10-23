# Holder storage: NVMe cache operations (writethrough dm-cache over an HDD origin)

This runbook is root-only and applies to any package that renders `holder-storage.sh.in`: the Base holder
`enclave-base-holder` and the L1 pair `enclave-l1-pair`.

**Evidence:** `work/cache-native-boundary-20261023` (real 7.2.11 kernel in a throwaway guest, scale-only sizes) and the
seam tests in `holder/test/test_storage.py`. None of it was on the production `/vm` NVMe, the USB RAID or NTFS.

## Principles

- **The HDD origin is authoritative.** In writethrough mode every write completes on the origin before it is
  acknowledged, so the cache holds no data that the origin lacks. Measured: 0 dirty blocks at all times.
- **dm-cache does NOT checksum cache content.**
  - It serves whatever the cache device returns for a block it believes is cached.
  - Measured with garbage written over the cache data device: 10,688 of 40,960 4 KiB blocks read wrong through the
    cache, and ext4 could not be mounted.
  - **A cache device you do not trust must never be assembled.**
- **`cache-loss` is always safe.** It zeroes the cache metadata BEFORE the origin is touched, then runs a read-only
  `e2fsck -fn` of the origin. The only cost is a cold cache.

## Which situation are you in?

### 1. Power loss / unclean host shutdown, cache device believed healthy

This is NOT automatically the same as cache corruption.

1. Let the storage unit's `assemble` run at boot. Measured: exit 0; all fsynced data correct; data that was never
   fsynced may be lost.
2. Then check `dmsetup status <NAME>`. It must show **all** of:
   - `writethrough`;
   - dirty = 0;
   - no `needs_check`;
   - mode `rw`, not `ro` or `Fail`.
3. Also check the kernel log for errors on the cache images' device.
4. **Any deviation** → treat it as §2.
5. **If in doubt** → §2. It is cheap.

### 2. Suspect or corrupted cache device

**Triggers:**
- media or I/O errors;
- SMART warnings on the NVMe;
- `needs_check`;
- dirty > 0 (impossible in writethrough);
- `e2fsck` or ext4 errors;
- unexpected data;
- the cache images were modified, copied or restored;
- the cache filesystem was repaired.

**Procedure — STOP THE CONSUMER FIRST:**

1. `systemctl stop <holder or l1 units>`. Nothing may read through the mapping while you work.
2. `holder-storage.sh disassemble`. It refuses, and stops, if:
   - the mount or mapping is not this holder's own;
   - any of its loops is still mounted or held by another device.

   Resolve the user it reports. Never force it.
3. `holder-storage.sh cache-loss`: invalidate the cache metadata, then the read-only origin check.
   - It refuses while the mount point is mounted.
   - It detaches only the origin loop it attached itself.
4. If the cache DEVICE itself is bad, stop here and replace it (§4). Otherwise run `holder-storage.sh assemble`. The
   cache starts empty.
5. Start the consumer.

### 3. The origin was accessed WITHOUT the cache

For example: mounted directly, fsck'd, or restored. `assemble` refuses ("run cache-loss first (stale-cache hazard)").
Run `cache-loss`, then `assemble`. **Never re-attach an old cache after uncached origin writes.**

### 4. Replacing or dropping the cache device

1. Stop the consumer, then run `disassemble` and `cache-loss`.
2. Delete the two cache images and their `.enclave-budget-owner` markers.
3. Root removes or adjusts the reservation in the shared ledger `/etc/enclave-rpc-cache/nvme-cache-budget.json`.

**To run without a cache:** render the config with `cache.mechanism: none`.

**To re-create cache files for an EXISTING origin there is no single command.** `create` refuses while the origin
exists. Root's manual steps:
1. `budget.py allocate <ledger> <reservation>`;
2. zero the first 8 MiB of the metadata image (as `create` does);
3. `assemble`.

That is a known gap: a `create-cache` verb would be a source change for review.

### 5. An interrupted `create`

- **SIGTERM, SIGINT or SIGHUP** (e.g. `systemctl stop`, Ctrl-C) now runs the normal unwind: exit 143/130/129. It removes
  exactly what that run created and detaches exactly what it attached.
- **SIGKILL or power loss** cannot unwind. Then:
  1. detach the loop bound to the run's origin file (`losetup -j <origin>`);
  2. remove that **unmarked** origin image;
  3. re-run `create`.

  The re-run adopts this reservation's owned cache files and markers. Its free-space check credits only owned regular
  files on the cache filesystem.

## Loop policy (why loops are left or removed)

- **`assemble`:** attaches or adopts this holder's three loops and keeps them under the mapping.
- **`disassemble`:** detaches this holder's loops after unmapping, but **never** a loop that is still mounted anywhere
  or held by another device. `losetup -d` on a busy loop only defers the detach (autoclear) under its user.
- **`cache-loss`:** detaches only the origin loop it attached for its check. A loop that existed before is left alone.
- **Unwind (error or signal):** detaches only loops this run attached, and stops at the first failed teardown, keeping
  images under live users (root fixes `b1b6f18`, `c3efff4`).

## Budget

- **One aggregate:** every cache of this work (Base holder, L1 pair, any other) is ONE ledger, capped at
  250,000,000,000 B with a 200 GB target.
- **Charging:** each reservation is charged its maxBytes: files + markers + directory entries + extent metadata +
  allocation-step spill.
- **Node temp:** goes to the HDD mount (`TMPDIR`), never to NVMe.
- **Measured** (guest ext4 on dm-crypt, and the host's ext4 on dm-crypt): actual allocation ≤ maxBytes, and the next
  reservation at a full share is refused.
