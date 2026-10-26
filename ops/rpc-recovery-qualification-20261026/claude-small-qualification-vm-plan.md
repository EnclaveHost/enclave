# Small (8 GiB) RPC qualification boot: plan + rpc-qualification-vm-stage/r1 (PREPARED; NOT run, 2026-10-26)

**Status:**
- Source only. I made no SSH or sudo calls, did not start or configure the VM, used no resources or mounts, and edited no existing file. No tests, builds or queue jobs.
- **Read-only reads:**
  - `logs/rpc-offline-os-1443.json` and `logs/rpc-snapshot-dropin-1444.json`;
  - frozen `rpc-memory-recovery-stage/r1`;
  - the pinned production launcher (`38f8dc89…`; I printed its `qemu_argv` for the pinned manifest `a2843215…`).
- **Stage:** `rpc-qualification-vm-stage/r1/`, `SHA256SUMS` = **`17a97a8103d52b254c30acfec34557d2b5b3c273bf6261e3028923facc4941c8`** (read-only):
  - `qualvm.py` `fb060fee…aaa9`;
  - `test/test_qualvm.py` (4) `259318fe…352e`;
  - `jobs/root-qualvm-r1-tests.sh` `b4af04da…640a`;
  - `README.md` `292bd996…4f18`.
- **The 64 GiB launcher, manifest, units and 16 GiB download profile:** untouched, and re-checked byte-exact by every command.

## What the boot records show (1443/1444, same OS disk inode 147981797, mtime …445722920013)
**Enabled at boot** (`multi-user.target.wants`):
- `enclave-l1-cl.service`
- `enclave-l1-el.path`
- `enclave-rpc-l1-snapshot.service`
- `enclave-rpc-base-snapshot.service`

**Not enabled:** `enclave-base-holder.{path,service}`, `enclave-base-retention.service` and `enclave-l1-el.service`.

**The snapshot unit:**
- It equals payload-v2 (`f7a193f1…`) but has a drop-in, `30-download-concurrency.conf`, which replaces only `ExecStart` (manifest-path, concurrency 16). So `bootSnapshotSafe=false`.
- The unit's guards stay: `RequiresMountsFor`, `ConditionPathIsMountPoint`, `!snapshot-complete`.

**fstab:** the base mount is `noauto`. **The L1 mount line was not captured.** `prepare` reads the whole fstab and refuses if any data filesystem auto-mounts.

**Consequence:** a normal boot of this OS at 8 GiB would start L1 CL and EL (EL via its `.path`), so chain sync, and could pull the base mount. The qualification boot must therefore prevent every one of these without editing the OS disk.

## Design (minimal, no OS-disk mutation)
**Same OS, unchanged disk:**
- The guest boots from a NEW qcow2 **overlay** whose backing is the production `os.qcow2` (opened read-only). All guest writes (journal, cloud-init state, fixtures) land in the overlay, and `discard` deletes it.
- The L1 and Base qcow2 are attached **read-only**, with no overlay and zero writes possible.
- The seed ISO is attached as in production (read-only), so cloud-init sees the same instance.

**Chain units off for this boot only:**
- Direct kernel boot with the OS disk's **own** kernel, initrd and default-GRUB-entry arguments:
  - read-only extraction through the frozen r1 inspector's GPT and debugfs helpers;
  - the BOOT or root partition chosen by ext4 label;
  - the arguments taken literally, with only Ubuntu's `$vt_handoff` dropped; any other variable refuses.
- Appended: `systemd.mask=` for the 8 chain/holder/retention units plus both data mount units (`srv-enclave\x2dl1\x2dpair.mount`, `srv-enclave\x2dbase\x2dholder.mount`; escaping equal to `systemd-escape`).
- These are **runtime** masks (systemd-debug-generator, in `/run`): no unit file or symlink on disk changes. The next normal boot is exactly as before. That is the rollback.

**Argv:** derived from the pinned launcher's `qemu_argv`. The tests assert the **only** differences:
- `-name enclave-rpc-qual`;
- memory: `size=8589934592,prealloc=on`, `-m 8192M`;
- console and QMP sockets in `/run/user/1000/enclave-rpc-qual/`;
- the os0 blockdev points at the overlay; l10/base0 have `read-only: true`;
- the guard monitor is removed;
- the netdev has the SSH `hostfwd` only (the RPC forwards 28545/28645/25052 are dropped) plus `restrict=on`;
- `-kernel`/`-initrd`/`-append`.

**Unchanged:** sandbox, CPU, SMP, rng, scsi devices and serials, MAC.

**Memory:**
- A transient user unit `enclave-rpc-qual-vm.service` via `systemd-run --user`, with `MemoryMax=10 GiB`, `MemorySwapMax=0`, `TasksMax`, `KillMode=mixed`, `NoNewPrivileges` and `RuntimeDirectory`. No unit file is written.
- **Launch refuses unless:** the production VM and guard units are inactive, and host **MemAvailable ≥ 26 GiB** (10 GiB cap + 16 GiB floor).

**Network:**
- **Default:** `restrict=on` (no outbound; only SSH in).
- **`--network apt`:** only for the signed `apt-get download b3sum` step. The chain units stay masked, so no chain sync either way.

**Commands** (root runs each one; outputs in a NEW dir, e.g. `/vm/enclave-volumes/rpc-qualification/run-<UTC>`):
1. `qualvm.py prepare OUT` (production off):
   - refuses if anything has `os.qcow2` open;
   - read-only nbdfuse/qemu-nbd/debugfs extraction of grub.cfg, kernel and initrd (sha256 recorded) and the full fstab;
   - `qemu-img create -f qcow2 -F qcow2 -b os.qcow2 OUT/os-qual.qcow2`;
   - re-checks that the OS disk is unchanged; writes `PREPARED.json`.
2. `qualvm.py plan OUT [--network restricted|apt]`: read-only; prints the argv, the `systemd-run` line and the memory check.
3. `qualvm.py launch OUT [...]`: the checks above, then `systemd-run`, then re-checks the production files.
4. `qualvm.py prove OUT`: read-only over the guest's own pinned SSH (`known_hosts` StrictHostKeyChecking).
   - **Requires:** every mask in `/proc/cmdline`; every chain unit `masked-runtime` + inactive; no data mount (`findmnt`).
   - Also records `free -b`.
5. **Qualification steps** (root; tiny fixtures only):
   - **Q1:** `apt-get download b3sum` with the signed chain, `dpkg-deb -x`, and the sha256 of `usr/bin/b3sum`. Then KAT: `b3sum` of an empty file must equal `af1349b9…3262`.
   - **Q2:** `systemd-analyze verify` on the gsi r2 units, then the real base binary on a small hostile `.tar.zst` under the extract unit's sandbox properties with **scratch** paths in the overlay and a decoy directory. Expect the decoy unchanged and rc 8 / EROFS.
   - **Q3:** the drop-in installed in the overlay only, then `systemctl show enclave-base-retention.service -p ExecStartPre` (guard last), then the guard by hand gives rc 2. **Never start retention** (it is masked as well).
   - **Copy every result and the b3sum binary out to the host** (with sha256) before discarding.
6. `qualvm.py stop`: ACPI powerdown over its own QMP socket. Then wait for the unit to become inactive.
7. `qualvm.py discard OUT`: deletes the overlay, kernel and initrd; re-checks that the production launcher, manifest and units are byte-exact and the OS disk inode/mtime unchanged.

**Root tests (not run):**
```
bash jobs/q-exit-status.sh qualvm-r1 256 bash rpc-qualification-vm-stage/r1/jobs/root-qualvm-r1-tests.sh
```
- **Coverage:**
  - grub parsing is literal (`$vt_handoff` only) and refuses otherwise;
  - the exact argv diff;
  - the transient unit caps;
  - launch refuses below 26 GiB, with the production VM or guard active, or with the qualification VM already active;
  - a changed kernel or an auto data mount refuses.
- Not under `unshare -U`, because the manifest uid check needs the real uid. HOME is not set. `prepare`/`launch`/`prove` are not exercised (they need the real tools).

## Why 8 GiB, and only for this
**Adequate for:**
- a minimal Ubuntu userspace;
- systemd and sshd;
- Python 3.12 running `guest_state.py` against KB/MB fixtures;
- `b3sum` on small files;
- a hostile `.tar.zst` of a few MB unpacked by the base binary's streaming tar-rs path;
- `systemd-analyze`/`systemctl show`.

None of this keeps large data resident, and all of it is far below 8 GiB.

**Not adequate for, and refused by design:**
- **L1 EL (reth) + CL (lighthouse):** today they use about 11 GiB plus page cache at 64 GiB.
- **The Base holder:** a 1.14 TB MDBX that is mmap- and page-cache bound. Its production RAM is unmeasured.
- **The real 1.14 TB extraction/BLAKE3 install (Q4).**

All chain units are masked and the data disks are read-only, so even an accidental start cannot sync or write. Q4 (the real install) belongs to the production-sized VM after capacity is restored.

## Blockers / mandatory coordination before activation
1. **Capacity (root + the KVM owner):**
   - production Qwen is using host memory; launch needs MemAvailable ≥ 26 GiB **at that moment**, and the 16 GiB floor must hold throughout;
   - sample host MemAvailable every 5 s while the qualification VM runs; stop it (step 6) if the margin is threatened;
   - the 8 GiB is preallocated at start.
2. **fstab:** the L1 mount line is unknown. If `prepare` reports an auto data mount, do not launch; review the line first.
3. **NVMe capacity:** the overlay grows only with guest writes (journal, fixtures; small). `prepare` does not check free space. Production's NVMe guard thresholds (300 GB floor) still apply to the host volume, so root confirms free space first.
4. **Unverified, checked by `prove` (fails closed):**
   - that this systemd honours `systemd.mask=` (debug generator; expected in noble's systemd 255);
   - that cloud-init keeps the host key (same seed and instance-id; a changed key makes SSH refuse);
   - that direct kernel boot finds the root device with the OS disk's own args.
5. **`--network apt`** opens outbound for the apt step only. Run that step, then relaunch with `restricted` if more steps follow, or accept the open network for the short session.
6. **Nothing persists:** results must be copied out before `discard`. Installing the qualified b3sum and the drop-in on the real OS disk is a later, separate, reviewed step on the production-sized VM.
