# Offline VM-disk copy helper: the version EXECUTED for the RPC VM NVMe migration (publication candidate)

These are the exact bytes root ran on 2026-10-25 to copy the stopped `enclave-rpc-production-vm` disks from the USB HDD
(`/mnt/usb/enclave-rpc-production/`) to the NVMe target `/vm/enclave-volumes/rpc-production`.
- **OS disk:** done.
- **L1 disk:** in progress when this candidate was prepared (at 16:56:55Z, 14.6 of 495.6 GB at ~154 MiB/s).
- **The L1 receipt does not exist yet.** It will be `outputs/rpc-production-final-20261025/nvme-migration/copy-l1.receipt.json`.
  Nothing here claims the L1 copy completed.

## Contents

| file | sha256 | what |
|---|---|---|
| `executed/nvme_copy.py` | `e48a7cb8b954059e6530a3cca56b03e688f8239d0c42c68d658126fd8dfc6561` | the helper, byte-identical to root's frozen `nvme-copy-root-review/nvme_copy.py` |
| `executed/test_nvme_copy.py` | `0b032fc92265cb9f4648dda0a4d992e13387f4bb600c2cca76f6866aee9e8021` | its 13 tests, root's frozen copy |
| `executed/systemctl-user` | `e36214a0d0b6a3232f12d81ba044215ff906c327ee850af3947757e9446d299d` | root's wrapper: `exec /usr/bin/systemctl --user "$@"` |
| `executed/SHA256SUMS` | | the three hashes above |
| `evidence/root-tests/nvme-copy-root-final2.{out,guard}` | | root's run of the frozen tests: **13/13 OK**, shared queue, guard peak 40 MiB |
| `evidence/receipts/` | | public plans and receipts copied from `outputs/rpc-production-final-20261025/nvme-migration/` (details below) |

The receipts copied are:
- `copy-os.{plan,receipt}.json` and `copy-os.out`;
- `copy-l1.plan.json`;
- `source-{os,l1,base}-check.json` and `target-os-check.json` (`qemu-img check`);
- `offline-source-inventory.json` and `clean-stop-host.txt`.

## What the OS copy receipt shows (`evidence/receipts/copy-os.receipt.json`)

- **Copy:** `status: ok`, 3 110 666 240 bytes; the source SHA256 equals the re-read copy SHA256
  (`9a71081601d2a9820e422d6347736c93b98526d74a715a4a48074bdb79f33b2f`).
- **Holes:** 1 zero chunk kept as a hole (allocated 3 102 281 728 B).
- **Timing:** copy 22.4 s, verify 2.7 s.
- **Target check:** `qemu-img check` on the target shows 0 errors.
- **Lock:** a shared OFD read lock on QEMU's lock bytes 100–299, held through an O_RDONLY descriptor.
- **Process scan:** 557 `/proc` entries were unreadable (`realRoot: false`, `allowIncompleteProcScan: true`; see the limits).

## How it was run (root's choices, as recorded in the plans)

- **As uid 1000, not root, without sudo.**
  - The unit is a systemd **user** service. It was checked three times (before the lock, after the lock, after the copy)
    with `systemctl --user show` through `executed/systemctl-user`. No system-context query was involved.
- **`reserveBytes`:** 300 000 000 000, the operator policy floor. The earlier 250 GB NVMe cap was **removed by the user**;
  that removal is the user's explicit override, and the helper encodes no other cap.
- **Per-chunk space check (added by root):** the target's free space is re-checked before every 8 MiB chunk, and the copy
  refuses once it would fall below the reserve. The frozen tests include this case.

## What the helper guarantees, and what it does NOT

**Guarantees:**
- The exact planned source: absolute path, dev, ino, size; a regular file, not a symlink, nlink 1.
- The source is opened read-only and never modified.
- The source's dev, ino, size, mtime, ctime, nlink and mode are unchanged after the copy.
- The SHA256 of the copy, re-read after fsync, equals the source's SHA256.
- No overwrite and no resume: an existing final, partial or `.FAILED.json` is refused.
- Publication is link-then-unlink plus a directory fsync.
- A failed run leaves an INVALID `.partial` plus a `.FAILED.json` marker.

**Explicit limits:**
1. **The `/proc` opener scan is incomplete when run as a non-root user** (`allowIncompleteProcScan: true`). Root accepted
   this consciously for this offline copy. What covers it:
   - root kept the unit stopped;
   - QEMU's own lock protocol conflicts with the helper's OFD lock;
   - any source change is detected by the stat check and the copy re-hash.

   It is **not** a proof against every possible writer. Advisory locks bind only QEMU-style lockers.
2. **No claim about the guest filesystem.** A byte-exact copy of an image is only as consistent as the guest's last
   shutdown. Root separately recorded a clean guest power-off (`clean-stop-host.txt`) after an earlier unclean-shutdown
   defect.
3. **Termination by signal.** SIGTERM or SIGKILL ends the helper without writing the `.FAILED.json` marker or the
   receipt.
   - The `.partial` stays by name (never valid), and a rerun refuses because it exists.
   - Remove it by hand after checking.
4. **Not run as real root here.** As real root the helper refuses any unreadable `/proc` fd table.
5. **The generated tests use disposable fixtures (≤ 64 MiB)** and real `qemu-io`/`qemu-img`/`qemu-storage-daemon`. No VM
   and no KVM.

## Relation to the earlier stage variant (NOT used live)

- `nvme-copy-stage/nvme_copy.py` (`b69090f5…`) adds `unitScope: user` + `unitUser`
  (`systemctl --user --machine=<user>@.host`), so REAL root can query a user unit.
- It **lacks** root's per-chunk space check and was **never executed**. It is not part of this candidate.
- A future merged version must carry both features plus both tests.
