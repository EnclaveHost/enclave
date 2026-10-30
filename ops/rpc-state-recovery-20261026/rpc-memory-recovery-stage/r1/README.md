# rpc-memory-recovery-stage/r1 (PREPARED by Claude; nothing run). Reversible guest-RAM change for the STOPPED RPC VM; root runs everything

**Starting point:** the root stopped the VM cleanly (ACPI, 16:00:53, Result success); host MemAvailable was about 81 GiB.
- **Pinned origin:** launcher `38f8dc89…`, manifest `a2843215…`, and both units equal to the original launcher's render (all verified read-only).
- **The 64 GiB VM cannot relaunch** at the 16 GiB floor: the launcher's own check needs 66 + 16 = 82 GiB available.

**Files:**
- `resize_vm_memory.py`: `stage` / `install` / `rollback` / `check-memory`.
  - **48 GiB** default; 32 GiB; **16 GiB = download-only** (refused without a fresh offline record showing no L1 unit enabled).
  - **What may change:** the `GUEST_MEM` line only; manifest `vm.guestMemBytes`/`memoryMaxBytes` plus `files.launcher`/`qemuArgv`; both units re-rendered by the NEW launcher (ExecStart sha, plus the VM unit's MemoryMax). Anything else is refused.
  - **`install`:**
    - refuses unless both units are inactive, the live files are the pinned originals, the staged files equal a fresh rebuild, and MemAvailable ≥ new MemoryMax + 16 GiB;
    - backs up the originals (new 0700 dir, `BACKUP.json`) and installs atomically;
    - re-verifies under the installed launcher; any failure restores the originals.
  - **Never** reloads, starts, enables or stops a unit. Returning to 64 GiB is `rollback` (exact originals); it never auto-starts.
- `inspect_os_disk.py`: READ-ONLY, rootless.
  - Refuses while the VM or guard is active, or while the OS qcow2 is open.
  - Mounts `nbdfuse -r` over `qemu-nbd -r -f qcow2`, parses the GPT, finds the ext4 `cloudimg-rootfs` partition, and reads with `debugfs -c` at that offset.
  - Reports the installed `enclave-rpc-base-snapshot.service` bytes vs payload-v2's, its drop-ins, its guards, every `.wants` symlink (L1/holder/snapshot/retention), and the fstab base mount line. Always unmounts.
- `test_rpc_memory_r1.py` (11 tests) and `jobs/root-rpc-memory-r1-tests.sh` (256 MiB, not under `unshare -U`, no HOME override).
