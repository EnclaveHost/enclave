# Independent read-only review: `rpc-qualification-vm-stage` r1/r2 (2026-10-26 16:57-17:00Z)

## Bytes reviewed
- **r2:** `SHA256SUMS` `485c527d…`; `sha256sum -c` OK; `qualvm.py` `ba29d858…`; `test/test_qualvm.py` `a21a29cf…`.
- **r1:** `SHA256SUMS` `17a97a81…`; OK. It also holds a stray `r1/__pycache__/qualvm.cpython-314.pyc` that is not in its SUMS; that is harmless but should be removed.
- **Context, read-only:**
  - the pinned production launcher `~/.local/state/enclave-rpc-production/provision_vm.py` `38f8dc89…`: `blockdev` `:281-285`, `qemu_argv` `:288-315`, the guard `:1100-1110`, `:1238-1256`, `:1360-1372`;
  - `manifest.json`: os `/vm/…/os.qcow2` (nvme backing `/vm`), l1 `/vm/…`, base `/mnt/usb/…/base-origin.qcow2` (hdd backing `/mnt/usb`);
  - `work/claude-test-queue.py:22`, `:134-136`.
- **Not done:** no tests, builds, queue jobs, network, SSH, sudo, mounts or edits. Claude370 owns the stage.

## Verdict
**r2 fixes r1's parser bug.** It also never sends outbound traffic, and the scope labels are honest (OS overlay only).

**Not activatable yet.** The items below are actual gates, not preferences.

## Blockers (each with file/line and minimal fix)
**B1. No lifetime 16 GiB host floor.**
- **The gap:** `launch` checks `MemAvailable ≥ 26 GiB` once (`qualvm.py:264-265`) and removes the guard monitor (`:227`). Nothing stops the VM if the host later falls below 16 GiB.
- **The queue can't hold it:** the shared queue's lanes stop at 4096 MiB (`claude-test-queue.py:22`, a `MemoryMax` scope, `:134-136`), so it cannot wrap a 10 GiB VM cgroup.
- **Minimal fix:** an owned external floor unit, bound to the VM's lifetime.
  1. **`launch` first starts** `systemd-run --user --unit=enclave-rpc-qual-floor.service -pMemoryMax=64M -pRestart=no … qualvm.py floor OUT`. It loops at most every 2 s over `/proc/meminfo`.
  2. **On MemAvailable < 16 GiB or an unreadable value:** it runs `systemctl --user stop enclave-rpc-qual-vm.service` and exits non-zero. It applies B4's capacity rule in the same loop.
  3. **Then it starts the VM** with `-pBindsTo=enclave-rpc-qual-floor.service -pAfter=enclave-rpc-qual-floor.service`. If the floor unit dies, systemd stops the VM.
- **Proof:** `prove` requires the floor unit to be active and the VM's `BindsTo` to contain it (`systemctl --user show -p BindsTo,MemoryMax,MemorySwapMax`).
- **Tests:** fake meminfo below or at the floor, unreadable meminfo, and floor-unit death each lead to the VM being stopped.

**B2. `prove` can fail and still exit 0.**
- `cmd_prove` returns `{"ok": false}` (`:286`), but `main` returns 0 for any non-exception result (`:322`).
- **Fix:** `main` returns 3 when `out.get('ok') is False`, or `cmd_prove` raises `Refuse` with the details.

**B3. `prove` does not actually check the data mounts or the disks' read-only state.**
- **Vacuous mount check:** `findmnt -rno TARGET,OPTIONS /srv/enclave-l1-pair /srv/enclave-base-holder` (`:278`) treats two positional arguments as **source and target**, so it never matches and `mounts` is always empty.
- **Mount masks not verified:** the mount-unit masks are put on the cmdline (`:230-231`), but `prove` verifies only `MASKS` (`:283-284`).
- **Hard-coded paths:** they are not taken from the manifest.
- **Memory is only reported** (`:277`, `free`).
- **Fix:**
  - one `findmnt -rn --mountpoint <m>` per manifest mount (`m['disks'][k]['mount']`); any output fails;
  - require `systemd.mask=<mount unit>` in `/proc/cmdline` and `is-enabled` = `masked-runtime` for both mount units;
  - `lsblk -rno NAME,RO,MOUNTPOINTS`: every non-OS disk has `RO=1` and no mountpoint;
  - guest `MemTotal` ≤ 8 GiB, plus the host unit's `MemoryMax=10G`/`MemorySwapMax=0` from `systemctl show`.

**B4. Overlay capacity is unguarded.**
- **What was dropped:** the production guard is the thin-provisioning capacity guard: it pauses or powers down before the NVMe/HDD floor (`provision_vm.py:1100-1110`, `:1360-1372`). The qual boot removes it (`:227`).
- **What is unchecked:** the overlay `OUT/os-qual.qcow2` grows without bound, `OUT`'s filesystem is never checked, and `/vm` also hosts the production os/l1 disks.
- **Fix:**
  - `prepare` and `launch` refuse unless `statvfs(OUT).avail ≥ root's 300 GB reserve (T710) + OVERLAY_MAX` (a declared constant);
  - the B1 floor loop stops the VM when the overlay is larger than `OVERLAY_MAX` or the filesystem's available space falls below the reserve;
  - record the free bytes before and after in the run receipt.

**B5. Chain-service exclusion is a curated list with no check for completeness.**
- `MASKS` (`:34-35`) are 8 names. The launcher itself only knows 3 guest units, so units installed by other stages (timers, new services) are not covered, and `prove` checks only the 8.
- **Fix:** `prove` enumerates `systemctl list-unit-files 'enclave-*'` and `systemctl list-units --all 'enclave-*'`. Each one must be `masked-runtime` and `inactive`; otherwise refuse. The allowlist is empty.

**B6. Kernel/initrd extraction and cmdline are not gated against the boot that actually happens.**
- **(a) Partition binding:** the entry's `search … --set=root <uuid>` is not bound to the partition the paths are read from (`:154-161`, `:166-170`). The partition is assumed from where `grub.cfg` was found.
  - **Fix:** parse `search` and require the uuid to equal that partition's ext4 UUID (`debugfs -R stats`).
- **(b) Symlinks:** `debugfs dump` of a **symlink** writes the link text, which passes the `size > 0` check (`:169`).
  - **Fix:** `debugfs -R 'stat <path>'` must show a regular file. The kernel must carry the bzImage `HdrS` magic at offset 0x202; the initrd must be non-trivial in size.
- **(c) Indented entries:** an indented `menuentry`/`submenu` before the first column-0 entry is not detected (`:108`).
  - **Fix:** refuse if any `^\s+(menuentry|submenu)` precedes it.
- **(d) No in-guest check:**
  - **Fix:** `prove` checks that `uname -r` equals the version in the kernel path, and that `/proc/cmdline` **equals exactly** `cmdlineFromGrub + masks`, not merely contains the masks (`:283`).
- **Result:** with these, the literal-parse result is gated against the boot that actually happens.

**B7. The "production unchanged" and launch-state gates are partial.**
- **`require_inactive`** maps `systemctl` failure to `unknown`, which refuses (fail-closed, correct). A never-loaded name reports `ActiveState=inactive` (`LoadState=not-found`) and passes.
  - That is right for the new qual unit, but it cannot tell an unloaded production unit from a stopped one (`:74-82`).
  - **Fix:** read `LoadState,ActiveState,SubState`; production units must be `loaded` and inactive or failed; the qual unit may be `not-found`.
- **`launch`** does not re-run `I.open_by_others(osd)`; only `prepare` does (`:139`).
  - **Fix:** re-run it in `launch`.
- **`prove`/`stop`** do not check unit states before SSH/QMP.
  - **Why it matters:** the qual and production guests share the forward `127.0.0.1:22850` and the same host key.
  - **Fix:** require the qual unit active and production inactive first.
- **`discard`** compares only mtime and inode (`:306-307`).
  - **Fix:** use `(size, mtime_ns, ctime_ns, ino)` before and after, plus the existing `production()` pins, written as a receipt.
- **Read-only already in place:**
  - the data blockdevs get `read-only: true` (`:220-221`);
  - seed0 is already read-only (`provision_vm.py:313`);
  - the overlay's backing is opened read-only by qcow2.
- **Fix:** record the host-side `query-block` (QMP) `ro` flags for os0's backing, l10 and base0 in `prove`.

## Q2/Q3 scope (labels must match what the boot can show)
**Q2** (extract confinement with the real base binary):
- It can only run as a **scratch copy on the OS overlay**: `systemd-run` with the extract unit's exact `[Service]` properties against overlay paths.
- The shipped extract unit cannot start here: it has `RequiresMountsFor`/`ConditionPathIsMountPoint=/srv/enclave-base-holder`, and that mount is masked.
- **Label:** overlay-only; it says nothing about the production disk.

**Q3** (drop-in ordering) **cannot be qualified in this VM:**
- `enclave-base-retention.service` is masked (`:35`), so it loads as masked and `systemctl show -p ExecStartPre` cannot show the drop-in.
- Q3 belongs to production activation: a read-only `systemctl show` on the production guest after the drop-in is installed there.
- **README fix:** stop listing Q3 as a purpose of this VM (`qualvm.py:4-5`).

## Tests to add (none run by me)
The stage has 6 tests, and none cover `prove`, `stop`, `discard`, the launch state or the lifetime floor. Add:
- `prove` with ok false gives rc ≠ 0;
- a mounted data path gives a refusal;
- an unknown `enclave-*` unit gives a refusal;
- a cmdline mismatch (not exact) gives a refusal;
- the floor loop trips on fake meminfo, on overlay size, and on filesystem reserve, and floor-unit death stops the VM;
- `LoadState` not-found for a production name gives a refusal;
- a symlinked kernel, or a `search` uuid that differs from the partition, gives a refusal in `prepare`;
- `discard` refuses while the qual unit is active.

**No activation until B1-B7 are fixed and qualified by root's actual run.** I did not run anything.
