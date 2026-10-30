# RPC VM memory recovery: restoring the 16 GiB host floor (read-only diagnosis + reversible plan; root executes, 2026-10-26)

**Scope:**
- Read-only. I did not touch the VM, QMP, units, guest, caches, processes or files, and ran no tests, builds or queue jobs. I sent no QMP commands.
- **Sources:** `/proc`, `ps`, `systemctl --user cat/show`, the installed launcher `~/.local/state/enclave-rpc-production/provision_vm.py` (sha `38f8dc89…`, = manifest `files.launcher`), `manifest.json` (sha `a2843215…`, pinned in both units), `guard-status.json`, and root's guest evidence (`logs/root-retention-live-20261026T145821Z-1929639/units-now.txt`, `production-cutover-inventory-stage/evidence/guest-units-config.txt`).
- **Guest figures** (used 11,468 MiB, cache 49,536 MiB, MemAvailable 52,834 MiB) are root's. I did not SSH.

## 1. Facts
**Host** (`/proc/meminfo`, read at the time of writing):
- MemTotal 127,807 MiB; MemAvailable about 14.8 GiB (15,479,384 kB; root saw 15,039 MiB); swap 4,095/4,095 MiB used.
- AnonPages 76.3 GiB, of which the RPC VM is about 64 GiB. **Unevictable 19.5 GiB** (Mlocked only 80 kB), Shmem 8.0 GiB.
- The other production VMs show small RSS. For example, two `memory-backend-memfd` QEMUs (6 GiB and 8 GiB) show about 0.6 GiB RSS each. Their memory is largely unevictable or shared, not visible in RSS.
- **I do not attribute the unevictable 19.5 GiB further** and do not suggest touching those apps.

**RPC VM** (PID 3695222, unit `enclave-rpc-production-vm.service` in the user manager, `NRestarts=0`, running 22 h):
- **QEMU argv:**
  - `-object memory-backend-ram,id=rpcmem,size=68719476736,prealloc=on` and `-m 65536M`, so all 64 GiB is touched and resident (RSS 67.3 GB);
  - `-machine q35`, `-nodefaults`, **no balloon device and no `pcie-root-port`**;
  - `-sandbox on,…`;
  - disks os (NVMe), l1-origin (NVMe), base-origin (`/mnt/usb`, HDD), and the seed ISO;
  - hostfwd ssh 22850, base-rpc 28545, l1-el 28645, l1-cl 25052;
  - QMP `qmp.sock` plus the guard's `guard-qmp.sock`.
- **The cgroup is at its cap:** `memory.current` 70,864,367,616 vs `MemoryMax` 70,866,960,384 (66 GiB), with `MemorySwapMax=0`. QEMU's host page cache (qcow2 `cache.direct=false`) is reclaimed inside the cgroup. That is not dangerous now (anon is fixed after prealloc), but it leaves the VM no slack.

**Unit policy:**
- `ExecStart` = `provision_vm.py launch <manifest> a2843215…`; `ExecStop` = `provision_vm.py powerdown` (ACPI `system_powerdown`, waits up to 2280 s, pauses if NVMe free falls to the pause threshold).
- `TimeoutStopSec=2400`, `KillMode=mixed`, `Restart=on-failure` with `RestartSec=60`, `StartLimitBurst=3` per 3600 s.
- `Requires/BindsTo=enclave-rpc-production-guard.service`. The guard has `Restart=no` and the same manifest pin; `guard-status.json` reports `state: armed`.

**The launcher pins memory as code constants** (`provision_vm.py:73-75`):
- `GUEST_MEM = 64 GiB`, `MEMORY_MAX = GUEST_MEM + 2 GiB`, `HOST_RESERVE = 16 GiB`.
- `cmd_launch` (`:869-893`) refuses unless:
  - the unit's cgroup `memory.max/swap.max` == (MEMORY_MAX, 0);
  - **`MemAvailable ≥ MEMORY_MAX + 16 GiB`** (`check_memory`, `:193-198`);
  - the QEMU argv sha == manifest `qemuArgv`;
  - the manifest sha == the unit's pin.
- `cmd_verify` (`:831-867`) also requires the unit and guard unit files to equal their renders and the launcher sha to equal the manifest's.

**Guest** (root's 14:58 evidence):

| unit | file state | active state |
|---|---|---|
| `enclave-l1-el.service` | disabled | active (PID 8111; started by `enclave-l1-el.path`, `PathExists=/srv/enclave-l1-pair/snapshot-complete`) |
| `enclave-l1-cl.service` | enabled | active (PID 87041) |
| `enclave-base-holder.service` / `.path` | disabled | — |
| `enclave-base-retention.service` | static | (now stopped by root at 15:53:59) |
| **`enclave-rpc-base-snapshot.service`** | **enabled** | inactive, success |

I have not seen what that last unit does at boot (see §4).

## 2. Options assessed
**A. Hot-add a virtio balloon over QMP: NOT possible.**
- On `q35` the root bus `pcie.0` does not accept hotplug, and the argv has no `pcie-root-port` (or `-nodefaults` bridge) to plug a `virtio-balloon-pci` into. A `device_add` would be refused.
- A balloon also needs the guest driver. It is present (`virtio_balloon` exists), but that is moot without a device.
- No other reclaim path exists: `prealloc=on` anonymous RAM is not returned by the guest dropping caches, and there is no free page reporting without a balloon.
- **Not recommended; not testable without a relaunch anyway.**
- An optional read-only confirmation is QMP `query-pci` (only `pcie.0`, no root ports). Root's choice; I sent nothing.

**B. Graceful shutdown and relaunch at 64 GiB (unchanged): DOES NOT restore the floor, and the launcher will very likely REFUSE it.**
- After a stop, host MemAvailable ≈ 14.8 + about 64 (the VM's anon) − up to 4 swap-ins ≈ **75–79 GiB**.
- The launcher needs **82 GiB** (66 + 16). So the VM would stay down, and L1 with it, until other host memory frees.
- Even if it launched, the host would be back at about 15 GiB.

**C. Graceful shutdown and relaunch at 48 GiB (recommended, reversible).**
- **Effect:** the VM shrinks by 16 GiB. Host MemAvailable after launch ≈ 75–79 − (48 + about 1 GiB QEMU) ≈ **26–30 GiB**, i.e. the 16 GiB floor plus 10–14 GiB.
- **Launch check:** needs 50 + 16 = 66 GiB ≤ 75–79, so it passes.
- **Guest headroom at 48 GiB:** L1 EL + CL + system use about 11.2 GiB today, leaving **about 35 GiB** for page cache and the Base backend. The Base holder stays stopped/disabled. The retention `.download-cache/*.part` and data stay on the base disk; a reboot changes no disk content.
- **It requires a reviewed launcher change**, since memory is a code constant pinned through 4 hashes. No command exists to resize an existing VM. `prepare` is NOT usable: it creates disks (`mkfs`/`qemu-img`, `:726-800`).
- **Minimal, reviewed edit (root, or a stage I can prepare on request):**
  1. In a reviewed copy of `provision_vm.py`, set `GUEST_MEM = 48 * GIB`. `MEMORY_MAX` follows at 50 GiB; `HOST_RESERVE` stays 16 GiB.
  2. New `manifest.json` (byte-for-byte except): `vm.guestMemBytes` = 51539607552, `vm.memoryMaxBytes` = 53687091200, `files.launcher` = the new launcher's sha, `files.qemuArgv` = the sha of `canonical(qemu_argv(m))` from the new launcher. Disks, paths, ports, MAC, seed, backings and capacity are unchanged.
  3. Re-render both units with the new launcher's `render_unit(m, newsha)` / `render_guard_unit(m, newsha)`. Only the manifest sha in `ExecStart` and `MemoryMax=53687091200` change.
  4. Keep the old launcher, manifest and both unit files in a backup dir (as the existing `backup-*` dirs do).
  5. `provision_vm.py verify` must pass before any start.

## 3. Exact candidate sequence for C (root executes; each step has a check)
0. **Preconditions:**
   - No RPC production consumer cutover (true today).
   - The Base retention unit is inactive and stays so.
   - Record the guest `systemctl show` for `enclave-l1-el`, `enclave-l1-cl`, `enclave-base-holder.{service,path}`, `enclave-rpc-base-snapshot.service` and `enclave-base-retention.service`, plus `ls -la /srv/enclave-base-holder{,/data,/data/.download-cache}` (sizes of the `*.part` files).
   - Record host `/proc/meminfo` and the guard status.
1. **Resolve the boot-time unknown (§4)** before any reboot.
2. **Prepare and verify** the 48 GiB launcher, manifest and units as in §2 C, staged next to the live files. Do not install them yet.
3. **Graceful stop:** `systemctl --user stop enclave-rpc-production-vm.service`.
   - That runs the reviewed `powerdown`: ACPI, waits for a clean guest halt; reth/lighthouse flush on SIGTERM inside the guest.
   - `BindsTo` stops the guard too.
   - **Check:** the unit is `inactive` with Result `success`, the journal shows "powerdown: QEMU exited after guest shutdown", and there was no SIGTERM fallback.
4. **Check the host has room:** MemAvailable ≥ 66 GiB, which is what the new launch requires.
5. **Install the reviewed files** (launcher, manifest, the 2 units), then `systemctl --user daemon-reload`, then `provision_vm.py verify` (must pass).
6. **Start:** `systemctl --user start enclave-rpc-production-guard.service enclave-rpc-production-vm.service`, i.e. the normal start of the existing pair, with the guard armed first as before.
7. **Check after start:**
   - **Host:** MemAvailable ≥ 16 GiB, sampled every 5 s for at least 10 min (swap may page back in), then periodically.
   - **VM cgroup:** `memory.max` = 53687091200.
   - **QEMU argv:** `size=51539607552`, `-m 49152M`.
   - **Guest:** `MemTotal` ≈ 48 GiB; `enclave-l1-el` (via its `.path`) and `enclave-l1-cl` active and syncing.
   - **Forwards:** host ports 28645 and 25052 answer.
   - **Base:** holder still disabled; retention inactive; the `*.part` sizes equal step 0.

## 4. Unknowns that must be resolved first (not assumed)
- **`enclave-rpc-base-snapshot.service` is `enabled`.** It is the first-download unit. I have not seen its `[Install]`/`Condition*`/`ExecStartPre` for a boot.
  - If it runs at boot over the current datadir, that is the destructive re-download class (`logs/claude-retention-state-redownload.md`).
  - **Root must read its unit and drop-ins (read-only) before step 3.** If it can run at boot, root decides whether to `disable` it first (reversible: `enable` restores it).
- **`enclave-base-holder.path`:** disabled at 14:58; confirm it is still disabled. It starts the holder on `snapshot-complete`, which exists.
- **`enclave-l1-el.service`** is disabled and started by its `.path`. Confirm the `.path` is enabled, or L1 EL will not come back after the reboot.
- **Sizing:** the guest `used` figure is per root's sample. Peak L1 RSS during sync and the Base holder's production RAM need are **not measured here**.

## 5. Failure modes and rollback
- **Powerdown hangs or times out:** `ExecStop` returns 1 and systemd SIGTERMs QEMU (`KillMode=mixed`), which is crash-consistent for the guest DBs. Mitigation: confirm the guest has no stuck I/O first. The 40 min stop timeout is the existing reviewed bound.
- **The 48 GiB launch refuses** (verify or memory check):
  - restore the backed-up 64 GiB files and `daemon-reload`;
  - the 64 GiB launch then needs ≥ 82 GiB available. Otherwise the VM stays down until host memory frees: an L1 outage.
  - **So step 4's check must pass before step 5, and step 2's `verify` before step 3.**
- **The guest misbehaves at 48 GiB** (OOM in reth or lighthouse): stop the VM, restore the 64 GiB files, and relaunch when host MemAvailable ≥ 82 GiB.
- **Start limit:** `StartLimitBurst=3`/h. Do not loop restarts.
- **Disks, ports, security, the L1 DB and the base `.part` files:** unchanged by every step. Only RAM size and the 4 hashes change.

## 6. Capacity outlook (not a permanent target)
- **48 GiB is a temporary step** for the download/sync phase.
- Production with all three backends (L1 EL + CL + Base holder) needs the Base holder's RAM, which is unmeasured. Today's L1 pair uses about 11 GiB plus cache.
- **The current maximum guest size is set by the host:**
  - with today's other host usage, guest RAM ≤ host MemAvailable-without-the-VM (about 75–79 GiB) − 16 GiB floor − about 2 GiB QEMU/cgroup slack, i.e. **about 57–61 GiB at most**, and the launcher additionally needs MemoryMax + 16 at launch;
  - **64 GiB is only restorable once host MemAvailable-without-the-VM ≥ 82 GiB.**
- Before the Base holder is enabled, measure its RSS (it is a reth node) and decide whether to return to 64 GiB or rebalance other host workloads (root/KVM).
- **How to prove the floor afterwards:** host `MemAvailable ≥ 16 GiB` sustained, sampled at 5 s through peak L1 sync and any later Base start. Record it in root's controller log alongside the VM cgroup `memory.current`.
