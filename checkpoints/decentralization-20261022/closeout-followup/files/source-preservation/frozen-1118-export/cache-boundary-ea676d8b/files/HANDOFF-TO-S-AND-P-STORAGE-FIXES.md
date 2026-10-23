# Handoff to S (holder storage template owner) and P (l1pair re-vendor): two template fixes from the real kernel test

From `work/cache-native-boundary-20261023`. This is a file note only; S's and P's trees were not edited. Root reviews and
decides adoption.

## Fixes (each an isolated commit here; cumulative fixed template `fixes/holder-storage.sh.in`)

**0001: `create` free-space preflight credits blocks already allocated to adopted owned cache files.**
- **Before:** after an interrupted or repeated `create`, the preflight demanded the FULL cache size free again and
  refused ("not enough NVMe free space"), although `budget.py admit/allocate` would ADOPT the owned files. Measured
  vm-2/vm-3 on a near-full share: production exit 2, fixed exit 0, `verify-cap` 0.

**0002: TERM/INT/HUP take the existing unwind path.**
- **Before:** SIGTERM to the process group (what systemd sends) killed bash WITHOUT running the EXIT trap. 3/7 mid-create
  interrupts left the origin image + an attached loop.
- **After:** 8/8 interrupted runs exit 143 with nothing left. Killed `budget.py` markers are adopted by the next
  `create`.

## Measured facts for the runbooks

- **After an abrupt guest power loss with the cache mapped:**
  - **direct `assemble`** (the boot unit): exit 0, 0 dirty, all fsynced data correct;
  - **reviewed `cache-loss` → `assemble`:** also correct.
- **A corrupted cache device is SERVED by dm-cache** (no checksums):
  - 10,688 / 40,960 4 KiB blocks wrong, and the filesystem unmountable, when read without `cache-loss`;
  - **"suspect cache device ⇒ `cache-loss` before `assemble`"** must be in the runbook.
- **`cache-loss` leaves the origin loop it attached still attached;** the next `assemble` reuses it. Is that intended?
- **`create` does not `modprobe loop`** (only `assemble` does). It relies on kmod static-node autoload in production.

## Not changed / not proven

- S's immutable template `eb6a209d` and `budget.py` `529e155f` are unchanged.
- Not run on real `/vm` + `/mnt/usb` (NTFS), and not a real power cut of the USB RAID enclosure.
