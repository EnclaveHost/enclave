# Independent read-only review: `rpc-qualification-vm-stage/r3` (2026-10-26 17:15-17:18Z)

## Bytes reviewed
- **Stage:** `SHA256SUMS` `cc447dee…ee62`; `sha256sum -c` OK at 17:15:31Z.
  - `qualvm.py` `0d4d84bd…`
  - `test/test_qualvm.py` `ada05044…`
  - `jobs/root-qualvm-r3-tests.sh` `8b5aba4f…`
  - `README.md` `099b5fcc…`
- **Also read:** `logs/claude-qualvm-r3-safety.md`, and root 1492's `logs/guest-trust-1492/` (`record.json`, `fstab`).
- **Not done:** no tests, VM, mounts, network, SSH or edits. Root 1493 is running and was not touched; Claude370 owns the stage.
- **Status:** nothing here is closed until root's actual tests and live evidence.

## B1-B7 in r3 source (not re-litigated; status only)
| item | r3 | remaining |
|---|---|---|
| **B1** lifetime floor | The controller runs in the 512 MiB main lane (`cgroup_max`, `:443-444`). It starts the floor unit, then the VM with `BindsTo=`/`After=` the floor (`:345-355`, `:464-472`). The floor checks every 1 s and trips at 18 GiB (`:372-403`). Admission is 27.75 GiB (`:31`, `:451-453`). | readiness gap, **N2** |
| **B2** prove rc | rc 3 unless `ok is True` (`:636-637`) | none |
| **B3** mounts/RO/memory | `findmnt --mountpoint` per manifest mount; lsblk by serial; QMP `ro`; MemTotal; unit caps (`:505-590`) | real-format checks, V1-V4 |
| **B4** capacity | OUT must be on the NVMe backing filesystem; admission requires the pause threshold + 16 GiB; the floor trips on the overlay's allocated size or on the threshold (`:115-120`, `:381-388`) | `console.log`, **N3** |
| **B5** inventory | every `enclave-*` unit file masked-runtime and inactive, empty allowlist (`:515-528`) | **N1** (the mask set does not come from the real disk) |
| **B6** kernel binding | search fs-uuid = partition, `root=` binding, regular file, `HdrS`, initrd ≥ 1 MiB, indented entry, exact cmdline, `uname -r` (`:146-212`, `:258-273`, `:508-511`) | none in source |
| **B7** states/receipts | production `loaded`+inactive; qual absent; `open_by_others` at launch; ownership checked before SSH/QMP; `discard` receipt with `(size, mtime, ctime, ino)` (`:90-101`, `:446-449`, `:563-574`, `:601-619`) | none in source |

**Ownership of starts and stops:**
- the two units are started only by the controller;
- stops apply only to our own InvocationID (`own_stop`, `:422-430`);
- `stop` signals only the recorded controller after checking its start token (`:593-598`).

**Controller death** (crash, SIGKILL, or the queue guard's SIGTERM followed by SIGKILL 2 s later, `work/enclave/test/helpers/memory-guard.mjs:38-39`):
- the floor sees the PID/start token gone within about 1 s, exits 4, and `BindsTo` stops the VM. That is fail-closed; ACPI is skipped, and the overlay is disposable.

**QMP handling** (`:410-419`):
- the greeting is consumed and asynchronous events are skipped;
- a 10 s timeout applies, and EOF or bad JSON raises `ValueError`, which is caught;
- **controller:** a failed ACPI leads to a bounded `own_stop` after 180 s;
- **prove:** a failure gives `ok: false`;
- a `prove` connection at the same moment as the controller's end-of-run ACPI can make one of them fail. Both fail closed, so this is acceptable.

## New activation blockers (minimal fixes)
**N1. The mask set is fixed in code, not derived from the actual OS disk.**
- **The gap:** `MASKS` is 8 names (`:43-44`). B5's proof requires **every** `enclave-*` unit file in the guest to be masked-runtime. The real inventory on `os.qcow2` was never recorded: 1492 recorded only fstab, keyring, sources and os-release.
- **Other stages name more guest units:** for example `enclave-base-restart-permit.service`, `enclave-base-readiness.timer`, `enclave-base-finality-reproof.timer`, `enclave-base-consumer-gate.timer`, `enclave-base-forward-sync*.service`, `enclave-base-recover.service` (from `logs/*.md`; which of them are installed is **unknown**).
- **If any exists on the disk:**
  - (a) it is **not masked** in this boot, so a timer or service can run on the overlay;
  - (b) `prove` can never pass.
- **Fix, in `prepare` (read-only debugfs, as the existing GRUB/fstab reads):**
  - enumerate unit **files and symlinks** named `enclave-*` in `/etc/systemd/system` (including `*.wants`/`*.requires` link names), `/usr/lib/systemd/system` and `/lib/systemd/system` on `cloudimg-rootfs`;
  - record the set in `PREPARED.json`;
  - mask **the union** of that set and `MASKS` plus the two mount units on the cmdline (`expected_cmdline`).
- **Fix, in `prove`:** the guest `enclave-*` inventory must **equal** the recorded set (plus the two mounts).
- **Fix, guard:** refuse if `' '.join(expected_cmdline)` is ≥ 2048 bytes (the x86 `COMMAND_LINE_SIZE`), rather than relying on QEMU's error.
- **Tests:** an extra timer on the disk is masked and proven; a guest unit absent from the record fails `prove`.

**N2. The floor is not ready before the VM starts.**
- **Why:** `systemd-run` (Type=simple) returns once the floor process has started, and `After=` orders only on that. The floor then runs `production()` (two sha256 hashes, module load, unit renders) and `nvme_policy` **before** its first check (`:392-397`). So the VM (8 GiB prealloc) can start before any floor check has passed.
- **If the floor's setup refuses:** it exits 2 and `BindsTo` stops the VM. That is fail-closed but racy.
- **Fix:**
  - the floor writes `OUT/floor-ready.json` (`{invocation: $INVOCATION_ID, pid, firstCheck: []}`) after its first clean `floor_reasons`;
  - the controller waits ≤ 15 s for that file, re-reads the floor unit, and requires it to be active with the recorded InvocationID **before** `vm_unit_cmd`;
  - otherwise `own_stop(FLOOR)` and `Refuse`.
- **Tests:** a floor that never becomes ready starts no VM; a floor whose setup refuses starts no VM.

**N3. `console.log` is an unbounded write outside the overlay budget.**
- **Why:** QEMU appends the serial console to `OUT/console.log` (`:321`, `logappend=on`) with no size limit. Only `os-qual.qcow2` is counted against `OVERLAY_MAX` (`:382-384`); console growth eats the 16 GiB admission margin until the NVMe pause threshold trips.
- **Fix:** in `floor_reasons`, count `st_blocks` of `os-qual.qcow2` **plus** `console.log` against `OVERLAY_MAX`, or give the console its own cap (for example 256 MiB) and trip on it.
- **Test:** an oversized console log trips the floor.

## Must be shown by root's actual run (all fail closed if wrong; not blockers in source)
- **V1:** kernel-cmdline masks (systemd-debug-generator) are reported as `masked-runtime` by `list-unit-files`/`is-enabled`.
- **V2:** the `\x2d` escapes in `systemd.mask=srv-enclave\x2dl1\x2dpair.mount` reach systemd unaltered. `prove` checks that the exact mount-unit name is masked.
- **V3:**
  - lsblk `SERIAL` is populated for virtio disks with the manifest serials, and `MOUNTPOINTS` is supported;
  - QMP `query-block` exposes `inserted.node-name` = `l10`/`base0` with `ro: true` for `-blockdev` devices;
  - the debugfs `stat` output contains `Type: regular`.
- **V4:** `systemd-run --user` works from inside the queue scope (user bus environment). If not, the floor start refuses and nothing runs.
- **Before the controller run** (preconditions; the controller enforces them but cannot create capacity):
  - MemAvailable ≥ 27.75 GiB;
  - NVMe available ≥ pause threshold + 16 GiB;
  - **KVM resource coordination is recorded**, because the floor stops the VM when other host consumers push MemAvailable below 18 GiB.

**Verdict:**
- **r3 addresses B1-B7 in source,** except the readiness gap N2.
- **Blocks activation:** N1-N3, plus the V1-V4 evidence from root's run.
- **Scope labels are correct:** OS-overlay only; Q3 is not qualifiable here; Q1 is offline.
