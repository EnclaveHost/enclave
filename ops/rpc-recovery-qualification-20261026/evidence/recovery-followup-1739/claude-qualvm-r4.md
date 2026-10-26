# Qualification VM r4: rpc-qualification-vm-stage/r4 (PREPARED; NOT run by Claude, 2026-10-26)

**Status:**
- Source only. No tests, builds, VM, mounts, network, live commands or commits, and no edits outside the new stage and this report.
- **Checks I made:** `ast` parse (`qualvm.py` against the 3.12 grammar), `bash -n`, `sha256sum -c`.
- **r1, r2 and r3 are frozen** (sums verified; the r4 job re-checks all three).
- **Input:** `logs/claude-qualvm-r3-review.md` (N1-N3, V1-V4).
- **ACTIVATION IS FORBIDDEN NOW.** NVMe available is about 59 GB, while the controller and `prepare` both require ≥ the production guard pause threshold (368,719,476,736 B) + 16 GiB = **385,899,345,920 B**. Both refuse, and must not be bypassed.

## Stage
`rpc-qualification-vm-stage/r4/`, `SHA256SUMS` = **`663bddf3b1386a0f822ae855b3f833c3d0d52f13d7a31d8a298ccf3d012a9b9a`** (read-only)

| file | sha256 |
|---|---|
| `qualvm.py` | `4ef8bc9f9a0431ef63cd9147b85695e5c44bc43aa74d6f4999029aee8e2eb2b1` |
| `test/test_qualvm.py` (18) | `3458a640bf738e2c06a5db024cce7f1a1661a312781d42afddd028f5067c3886` |
| `jobs/root-qualvm-r4-tests.sh` | `5edbf200c9b080c276c21758f0b427f1b5a2f27473864a1089d62a3424519d9f` |
| `README.md` | `df0c124c131e29912a273c0a249a9a3be015fc110f16940f667321db05caede2` |

## Fixes
**N1, masks derived from the actual OS disk:**
- **What `prepare` reads:** `disk_inventory` uses read-only `debugfs -c ls -p` through the frozen r1 inspector, on the `cloudimg-rootfs` partition, which is the same nbdfuse/qemu-nbd `-r` exposure as the GRUB/fstab reads. It reads:
  - `/etc/systemd/system`, `/usr/lib/systemd/system`, `/lib/systemd/system`;
  - **every** `/etc/systemd/system/*.wants` and `*.requires` directory.
- **What `inventory_from_listings` keeps:** each `enclave-*` name with a unit suffix, whether a **regular file or a symlink** (including wants/requires link names), plus drop-in directories (`enclave-x.service.d` maps to `enclave-x.service`).
- **Refusals:**
  - a name that is not literal (`^enclave-[A-Za-z0-9:_.@\\-]+$`) refuses, because it must go verbatim on the kernel command line;
  - an empty or unreadable `/etc/systemd/system` listing refuses (fail closed).
- **Record:** `unitInventory` (name → where found) and `unitDirsListed` go into `PREPARED.json` (format `enclave-rpc-qual-prepared/r4`; `checked()` refuses older records).
- **Command line:** `mask_set` = the reviewed `MASKS` ∪ every disk unit (no duplicates), then both data-mount units. `expected_cmdline` masks all of them. `cmdline_ok` refuses above **2047 bytes** (x86 `COMMAND_LINE_SIZE` 2048 including NUL) in `prepare`, `checked()` and therefore the controller.
- **`prove`:** the guest's `systemctl list-unit-files 'enclave-*'` plus the two mount units must **equal** `mask_set`. A missing unit and an unrecorded unit both fail, and each must be `masked-runtime`; every loaded `enclave-*` unit must be inactive.

**N2, the floor is ready before the VM:**
- **The floor unit** (`cmd_floor`):
  - after its **first clean** `floor_reasons` it writes `floor-ready.json` atomically: `invocation` = its systemd `INVOCATION_ID` (32 hex), plus `pid`, `startToken` and `firstCheck: []`;
  - without an `INVOCATION_ID` it refuses (exit 4, no receipt);
  - if the first check trips, there is no receipt.
- **The controller:**
  - deletes stale `floor-ready.json*`/`floor-trip.json` **before** starting the floor;
  - waits ≤ 15 s (`floor_ready`) for a receipt whose `invocation` equals the recorded floor InvocationID, with a live PID whose start token matches (a missing token fails), and the floor unit still `active` with that InvocationID;
  - **only then** runs `vm_unit_cmd`. Otherwise it calls `own_stop(FLOOR)` and refuses, so **no VM is started**;
  - copies the receipt into `controller.json` (`floorReady`).

**N3, console allocation is capped:** `floor_reasons` now counts `console.log` `st_blocks`.
- It trips if the console alone exceeds **256 MiB** (`CONSOLE_MAX`), or if overlay + console together exceed **16 GiB** (`OVERLAY_MAX`).
- NVMe admission stays at pause threshold + 16 GiB, which covers both.

**Unchanged from r3:**
- the controller only in root's 512 MiB main lane (`memory.max` == 536870912), with a PID/start token;
- the 64 MiB floor unit with `Restart=no` and `RuntimeMaxSec`; the VM `BindsTo=`/`After=` the floor, `MemoryMax=10G`, `MemorySwapMax=0`, `TimeoutStopSec=30`;
- admission ≥ 27.75 GiB; the continuous 18 GiB proactive stop above the 16 GiB physical floor; MemAvailable unreadable fails closed; NVMe below the pause threshold trips;
- stops only for our own InvocationID; ACPI then bounded force on the disposable overlay;
- `prove` rc 3; GRUB/kernel/`root=` binding; read-only L1/Base; `restrict=on`;
- OS-overlay-only scope; Q3 not qualifiable here; not a chain backend.

## Regressions added (18 tests in total, source fixtures: stubs for systemctl, systemd-run, ssh and QMP)
- **N1:**
  - **Inventory:** a symlinked service, a wants-dir path, a timers.target.wants timer, a drop-in dir, a `/usr/lib` template unit are all found; `other.service`, `enclave-notes.txt` and `sshd.service` are ignored; a quoted name refuses; an empty `/etc/systemd/system` refuses.
  - **Command line:** a disk-only timer is masked on the cmdline; a unit in both sets appears exactly once; a 60-long-name inventory exceeds 2047 bytes and refuses.
  - **`prove`:** an unrecorded guest unit, or a recorded unit missing from the guest, fails.
- **N2:**
  - **Controller:** never ready, another invocation, a dead PID (r4 fixed a None == None pass that this test would have caught), or only a stale previous receipt: in each case exactly one `systemd-run` (the floor), never the VM, and our floor is stopped.
  - **Floor:** writes its receipt only after a clean first check and only with an `INVOCATION_ID`; a first-check trip gives exit 4 and no receipt.
  - **Lifecycle and stop-request tests:** they now pass through the ready gate.
- **N3:** a console above `CONSOLE_MAX` trips; overlay and console each within limits but together above `OVERLAY_MAX` trip.

## Exact commands (root only)
**Offline tests (allowed now; host only, no VM):**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh qualvm-r4 256 bash rpc-qualification-vm-stage/r4/jobs/root-qualvm-r4-tests.sh
```
PASS = `Ran 18 tests` + `OK`, with the r4 sums intact and r1-r3 frozen. It runs outside `unshare -U` (the manifest uid check) and does not set HOME.

**Activation (FORBIDDEN until NVMe avail ≥ 385,899,345,920 B and root/KVM capacity coordination is recorded):**
```
python3 -I rpc-qualification-vm-stage/r4/qualvm.py prepare OUT            # production off; OUT on the NVMe backing fs
bash jobs/q-exit-status.sh qual-controller 512 python3 -I rpc-qualification-vm-stage/r4/qualvm.py controller OUT
python3 -I rpc-qualification-vm-stage/r4/qualvm.py prove OUT              # rc 0 required (another shell)
python3 -I rpc-qualification-vm-stage/r4/qualvm.py stop OUT
python3 -I rpc-qualification-vm-stage/r4/qualvm.py discard OUT
```

## Unresolved evidence (only root's real run can show it; every path fails closed)
- **V1:** `systemd.mask=` from the kernel command line shows as `masked-runtime` in `list-unit-files`, including for units found only as wants links or drop-in dirs.
- **V2:** the `\x2d` escapes in the mount-unit masks reach systemd unaltered.
- **V3:** real formats:
  - `debugfs ls -p` and `stat` (`Type: regular`);
  - lsblk `SERIAL`/`MOUNTPOINTS` for the scsi-hd disks;
  - QMP `query-block` `inserted.node-name`/`ro`;
  - whether `/lib/systemd/system` resolves through the usr-merge symlink in debugfs. If it does not, `/usr/lib/systemd/system` is listed anyway.
- **V4:** `systemd-run --user` works from inside the queue scope, and systemd sets `INVOCATION_ID` for the floor unit. Without it, the floor never becomes ready and no VM starts.
- **The real `enclave-*` inventory on `os.qcow2` is still unknown**; it is recorded only when `prepare` runs. Its size determines the command-line length (refused above 2047 bytes).
- **Capacity:** NVMe is about 59 GB now (activation forbidden). Host MemAvailable ≥ 27.75 GiB is needed at admission, and ≥ 18 GiB throughout, alongside production Qwen; this needs KVM coordination.
