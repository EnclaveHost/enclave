# Independent read-only re-review: `rpc-qualification-vm-stage/r4` (2026-10-26 17:42Z)

## Bytes reviewed
- **Stage:** `SHA256SUMS` `663bddf3…9b9a`; `sha256sum -c` OK.
  - `qualvm.py` `4ef8bc9f…b2b1`
  - `test/test_qualvm.py` `3458a640…3886`
  - `jobs/root-qualvm-r4-tests.sh` `5edbf200…9d9f`
  - `README.md` `df0c124c…de2`
- **Diff against r3:** 140 lines, additions only.
- **Also read:** `logs/claude-qualvm-r4.md`, and the frozen inspector's `parse_ls_p`/`debugfs` (`rpc-memory-recovery-stage/r1/inspect_os_disk.py:69-86`).
- **Root 1506:** 18 mocked logic tests passed (archived `b78b79200`). Those are logic tests, not live evidence.
- **Not done:** no tests, builds, VM, network, mounts or edits.

## Capacity: activation forbidden
- **Requirement:** NVMe available ≥ the production guard pause threshold 368,719,476,736 B + 16 GiB = **385,899,345,920 B**. Root reports **79.9 GB** on `/vm` now.
- **Effect:** `prepare` (`nvme_policy`/`avail_bytes`) and `controller` both refuse. The threshold must not be lowered.
- **Consequence:** the N1 inventory of `os.qcow2` is still **unknown**, because only `prepare` records it.

## N1 (disk-derived masks): fixed in source, with two gaps
**Fixed:**
- `prepare` lists the unit dirs and every `/etc/systemd/system/*.wants|*.requires` dir read-only (`disk_inventory`);
- it keeps files, symlinks and drop-in dirs as unit names, and refuses non-literal names;
- the cmdline masks MASKS ∪ inventory ∪ both mounts and is refused above 2047 bytes (in `prepare`, `checked()` and the controller);
- `prove` requires the guest inventory to **equal** that set.

**N1a. Missing listings pass silently.**
- **Why:** `debugfs` return codes are ignored, and an empty listing is fatal only for `/etc/systemd/system`. A failed or empty listing of `/usr/lib/systemd/system` (always populated on noble) therefore passes and can miss packaged `enclave-*` units.
- **Fix:** require a non-empty parse for `/usr/lib/systemd/system` too, and record each listing's debugfs rc in `unitDirsListed`.

**N1b. The search path is incomplete.**
- **Missing system unit directory:** `/usr/local/lib/systemd/system`, which systemd also loads, is not in `UNIT_DIRS`. Add it; an absent directory is an empty listing.
- **User-manager units cannot be masked:** a lingering user's units (from `/etc/systemd/user`, `/usr/lib/systemd/user`, `/var/lib/systemd/linger/*`) start at boot, and `systemd.mask=` cannot mask them.
- **Fix:** in `prepare`, list `/var/lib/systemd/linger` and both user unit dirs read-only. Refuse if any user lingers or any `enclave-*` user unit exists.

## N2 (floor ready before the VM; ownership): fixed in source
**Fixed:**
- **Controller:**
  - deletes stale receipts **before** starting the floor;
  - waits ≤ 15 s for `floor-ready.json`, which must carry the recorded floor InvocationID, a live PID with a matching start token, and the unit still active with that InvocationID;
  - only then starts the VM; otherwise stops its own floor and refuses (`:547-557`).
- **Floor:** writes the receipt only after a clean first check, and only with a 32-hex `INVOCATION_ID` (`:461-467`).

**Non-blocking residue:**
- **The race:** the floor can trip between the ready check and the VM start.
- **What systemd then does:** starting the VM with `BindsTo=` a collected unit fails, which is fail-closed. If the unit is still loaded, systemd may instead start a **new** floor invocation; it still guards, but it is not the recorded one.
- **One-line fix:** after `vm_unit_cmd`, re-read the floor unit; if it is not active with `rec['floorInvocation']`, call `own_stop(VM)` and then refuse.

## N3 (console cap): fixed in source
- The floor trips when `console.log` allocation exceeds 256 MiB, or when overlay + console together exceed 16 GiB (`floor_reasons`).
- NVMe admission still requires pause threshold + 16 GiB.
- No regression found.

## Regressions
- **None found in source.** r4 refuses r3 `PREPARED` records (format plus `unitInventory`), so `prepare` must be re-run.
- **Ordering note:** `prove` must run **before** any Q1/Q2 step, and Q2's scratch units must not be named `enclave-*`. Otherwise the inventory equality fails (fail-closed, but it would block the proof).

## Necessary live evidence (root's run, after capacity is restored; each fails closed)
- **E1.** The real `enclave-*` inventory and the resulting cmdline length (≤ 2047 bytes).
  - **Optional, to learn it now without the overlay:** a read-only inventory-only step (no qcow2 created; the same debugfs path as `prepare`).
- **E2.** Kernel-cmdline masks appear in guest `list-unit-files` as `masked-runtime`, **including** names found only as wants links or drop-in dirs, so that guest inventory == mask set holds.
- **E3.** The `\x2d` mount-unit masks are honoured by name.
- **E4.** Real formats:
  - `debugfs ls -p` and `stat`, and the usr-merge `/lib` path;
  - lsblk `SERIAL`/`MOUNTPOINTS` for the data disks;
  - QMP `query-block` `node-name`/`ro`.
- **E5.** `systemd-run --user` works from inside the queue scope, and the floor sees `INVOCATION_ID`. Otherwise no VM starts.
- **E6.** SSH into the guest still works with **all** `enclave-*` units masked: if any of them configures sshd or a firewall, `prove` cannot run.
- **E7.** Admission evidence:
  - MemAvailable ≥ 27.75 GiB at admission, and ≥ 18 GiB throughout;
  - recorded KVM coordination;
  - NVMe ≥ 385,899,345,920 B.
