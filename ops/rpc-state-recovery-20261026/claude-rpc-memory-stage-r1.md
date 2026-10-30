# RPC VM memory recovery: rpc-memory-recovery-stage/r1 (PREPARED; NOT run by Claude, 2026-10-26)

**Status:**
- Source only. I did not touch the VM, QMP, units, the guest or the OS disk, and ran no tests, builds or queue jobs.
- **Read-only checks I made:**
  - `systemctl --user show`: both units inactive/dead, Result success;
  - `/proc/meminfo`: MemAvailable about 79.9 GiB at the time;
  - the live file hashes and modes;
  - that the installed launcher reproduces the manifest sha `a2843215…`, its `qemuArgv`, both unit files and the canonical manifest exactly;
  - one `qemu-img info -U` metadata read of the stopped `os.qcow2`: standalone, no backing file.
- My only checks of the stage's own files were `ast` parse, `bash -n` and `sha256sum -c`.

## Stage
`rpc-memory-recovery-stage/r1/`, `SHA256SUMS` = **`32aa7c94a93e322ea485099428fc9d2fef4134ef71665c3abec450086dc5f169`**

| file | sha256 |
|---|---|
| `resize_vm_memory.py` | `e8efd2fb4779d3b58c06d19a35f25360c949ddaf1bf641bce0fc9131cadec335` |
| `inspect_os_disk.py` | `287c09ba2b3bebd3c1feddb995306bf2fe13a6be073f6b17bdeda257b98a0531` |
| `test_rpc_memory_r1.py` (11 tests) | `dd0985198ea5345521b706c859a730077bbd7fe940b2a24249955f6678a23647` |
| `README.md` | `ece6d247fe30b54b133b12ccb1cf7280f0ac0851b98c08dfd138282b775e7419` |
| `jobs/root-rpc-memory-r1-tests.sh` | `8d40c554986057a565818effc658b45827fd1e5e48f03c7dc9b8043e9491223d` |

## `resize_vm_memory.py`
**Origin check:** the live files must equal the pin. That means launcher `38f8dc89…` and manifest `a2843215…`, with the manifest canonical and pinning that launcher, its `qemuArgv` reproduced by the original launcher, both unit files equal to the original renders, and `vm` 64/66/16 GiB.

**`stage --gib {48 (default) | 32 | 16} --out DIR`** writes only DIR:
- **Launcher:** `GUEST_MEM = 64 * GIB` (exactly one occurrence) is replaced by `N * GIB`. `MEMORY_MAX = N + 2 GiB` follows; `HOST_RESERVE` stays 16 GiB.
- **Manifest:** `vm.guestMemBytes`, `vm.memoryMaxBytes`, `files.launcher` (sha of the new launcher), and `files.qemuArgv`, computed by the NEW launcher's `qemu_argv`/`canonical`/`sha256_text`. It is written with the launcher's own `canonical`.
- **Units:** rendered by the NEW launcher's `render_unit` / `render_guard_unit` with the new manifest sha.
- **Refusal:** a diff check refuses anything but those lines and fields: the launcher's 1 line; the manifest's 2 + 2 fields; the VM unit's `ExecStart` + `MemoryMax`; the guard unit's `ExecStart`.
- **Output:** `PLAN.json` holds the original and new sha of every file, the new manifest sha, `launchNeedsMemAvailable` = new MemoryMax + 16 GiB, and the unified diffs.

**`install --staged DIR [--l1-off EVIDENCE.json]`:**
- **Refuses unless:**
  - both units are `inactive`/`failed` (`systemctl --user show` is the only systemctl call);
  - the live files are still the pinned originals;
  - the staged files equal a fresh rebuild from the live originals and the plan;
  - for 16 GiB, the offline inspection record is of the current OS disk (path, inode, mtime) and shows `enclave-l1-el.path`, `enclave-l1-el.service` and `enclave-l1-cl.service` all `enabled: false`;
  - MemAvailable ≥ new MemoryMax + 16 GiB, the launcher's own launch check.
- **Then:**
  1. backs up the 4 originals into a NEW `~/.local/state/enclave-rpc-production/backup-memory-<UTC>-a28432151c9a/` (0700; files 0400; `BACKUP.json` with paths, sha and modes);
  2. installs atomically (tmp + fsync + rename + dir fsync) with the original modes (0500, 0600, 0644, 0644);
  3. re-verifies the bytes and modes, and their consistency under the INSTALLED launcher (renders, launcher sha, argv sha, vm fields).
- **Any failure restores the originals** and re-verifies them.
- **It never runs** `daemon-reload`, start, stop or enable. It prints the next steps.

**`rollback --backup DIR`:**
- Requires both units inactive and a backup that is exactly the pinned originals for these paths.
- Restores them, re-verifies them as the pinned origin, and prints that a 64 GiB start needs ≥ 82 GiB available.
- Never starts anything.

**`check-memory --gib N`:** read-only. Reports MemAvailable vs the launch need, and the projected host available after start.

## `inspect_os_disk.py` (resolves the boot-unit unknown offline; root runs it before any restart)
- **Refuses** unless the VM and guard units are inactive and no process has `/vm/enclave-volumes/rpc-production/os.qcow2` open.
- **Records** the size, inode, mtime and sha256 of the first MiB (the full 18.6 GB image is not hashed).
- **Mount:** `nbdfuse -r -P <pid> <tmp>/os.raw [ qemu-nbd -r -f qcow2 <os.qcow2> ]` (socket activation; read-only at both layers; QEMU image locking also refuses a disk in use).
- **Partition:** GPT parse, then exactly one Linux-filesystem partition whose ext4 label is `cloudimg-rootfs`, then `debugfs -c -R … "<raw>?offset=<bytes>"`.
- **Reads:**
  - `/etc/systemd/system/enclave-rpc-base-snapshot.service`: sha vs payload-v2's (`f7a193f1…`);
  - its `.d` drop-ins;
  - its `Condition*`/`RequiresMountsFor`/`ExecStart*` lines;
  - every `/etc/systemd/system/*.wants` dir, with `enabled` (a symlink with that name) for the snapshot, L1, holder and retention units, plus link targets;
  - the `/etc/fstab` base mount line.
- **`bootSnapshotSafe`** is true only if the unit is byte-identical to payload-v2 (`RequiresMountsFor` + `ConditionPathIsMountPoint` + `ConditionPathExists=!…/snapshot-complete`) with no drop-in.
- **Cleanup:** always `fusermount3 -u`, and waits for exit.
- **Command:** `python3 -I rpc-memory-recovery-stage/r1/inspect_os_disk.py > os-disk-inspection.json`. It needs `/dev/fuse` (present, 0666) and fusermount3.

## Tests (11; not run)
1. **Build, per size (48/32/16):**
   - the manifest's vm fields are new and every other top-level field is equal;
   - `files` is equal except `launcher`/`qemuArgv`, and both are consistent under the new launcher;
   - both units carry the new manifest sha;
   - VM MemoryMax = N + 2 GiB; guard MemoryMax=256M is unchanged;
   - the QEMU argv differs from the original only in the `memory-backend-ram size` and `-m` entries;
   - the security and unit policy lines are present.
2. **Refusals:** unreviewed sizes (64, 24, 0, 8) and tampered live launcher, manifest or units are refused.
3. **Install 48 and roll back:**
   - after install, the live files equal the plan with their modes, and the backup is the byte-exact originals;
   - only `systemctl show` was called;
   - a second install is refused;
   - rollback restores the exact originals, and the origin check passes.
4. **Install refusals write nothing:** VM active, activating or deactivating; guard active; MemAvailable below need; a tampered staged file.
5. **Failure after 1, 2 or 3 written files:** every original is restored.
6. **16 GiB:** refused without evidence, and with an L1 unit enabled, missing L1 entries, a stale mtime, or a wrong format. Installs only with fresh all-false evidence.
7. **Rollback refusals:** VM active; a tampered backup (nothing restored).
8. **Installed 48 GiB launcher:**
   - `check_memory` refuses at 66 GiB − 1 and passes at 66 GiB;
   - `cmd_launch` refuses the OLD 66 GiB cgroup cap and a non-zero swap cap;
   - the unit has `MemoryMax=53687091200` and `MemorySwapMax=0`.
9. **GPT:** the root partition is found; 0 or 2 `cloudimg-rootfs` partitions are refused.
10. **Inspection parsing** (debugfs stub):
    - an identical unit is safe;
    - a drop-in or a changed unit is unsafe;
    - an absent unit is reported;
    - enabled is true only for symlinks;
    - the guard lines are reported.
11. **Inspector refusal:** refuses while the VM or guard is active.

**Root test job (not run):**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh rpc-memory-r1 256 bash rpc-memory-recovery-stage/r1/jobs/root-rpc-memory-r1-tests.sh
```
- **Not under `unshare -U`:** the launcher's manifest uid check (1000) must see the real uid. No network is used, `TMPDIR` is set only for the test command, and HOME is not set.
- **Checks:** the stage sums; the live files are still the pinned originals, and are unchanged after the run; `Ran 11 tests` plus `OK`.

## Root sequence (root executes; nothing here starts the VM)
1. Run the test job above.
2. **Inspect the OS disk:** `inspect_os_disk.py > os-disk-inspection.json`.
   - **Required before any restart:** `bootSnapshotSafe: true`.
   - Check `enabled` for `enclave-base-holder.path` (must be false) and for `enclave-l1-el.path`/`enclave-l1-cl.service`. Root stopped them but did not necessarily disable them; if enabled, they start at boot.
3. Run `resize_vm_memory.py check-memory --gib 48`. `launchWouldPass` must be true.
4. `resize_vm_memory.py stage --gib 48 --out <dir>`, then review `PLAN.json`.
5. `resize_vm_memory.py install --staged <dir>`.
6. `systemctl --user daemon-reload`, then `/usr/bin/python3 -I ~/.local/state/enclave-rpc-production/provision_vm.py verify` (must pass).
7. **Root decision:** the normal start of the guard + VM units.
8. **Prove the floor:**
   - host MemAvailable ≥ 16 GiB, sampled every 5 s for at least 10 min and through L1 resync;
   - VM cgroup `memory.max` = 53687091200;
   - QEMU argv `size=51539607552` / `-m 49152M`.
9. **Rollback:** stop the VM (its own ExecStop), then `rollback --backup <dir>`, then `daemon-reload`. A 64 GiB start needs ≥ 82 GiB available.

**16 GiB (download-only):** only after the L1 units are disabled in the guest. That needs a boot, so it is not reachable offline today. The install refuses without that evidence.

## Limits / unknowns
- **nbdfuse behaviour:** whether nbdfuse stays in the foreground or daemonizes is not verified (no man page locally). The script handles both: it waits for the raw file, unmounts with `fusermount3 -u`, and waits or kills its child.
- **debugfs `?offset=`:** the `"<raw>?offset=N"` io-option form (e2fsprogs unix_io) is relied on; untested here.
- **First-MiB sha:** the inspection record's sha covers the first MiB only. Freshness is enforced by inode and mtime at install.
- **Base marker:** `snapshot-complete` is on the BASE disk, not read here. Root's 14:58 guest listing showed it present.
- **Capacity:** 48 GiB is temporary, and the Base holder's production RAM is unmeasured (see `logs/claude-rpc-memory-recovery.md` §6).
