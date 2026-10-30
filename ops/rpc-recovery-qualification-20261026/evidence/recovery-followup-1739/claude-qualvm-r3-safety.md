# Qualification VM r3: safety design, rpc-qualification-vm-stage/r3 (PREPARED; NOT run by Claude, 2026-10-26)

**Status:**
- Source only. No live actions, SSH, network, mounts, tests, builds or queue jobs; no resources touched.
- **Checks I made:** `ast` parse (`qualvm.py` against the 3.12 grammar), `bash -n`, `sha256sum -c`.
- **r1 and r2 are frozen** (sums verified; the r3 job re-checks them). r1's stray `__pycache__` noted by the review is untracked; root may delete it, and I did not touch it.
- **Inputs:** `logs/claude-qualvm-independent-review.md` (B1-B7) and root 1478 (r2, 6 PASS).
- **This stays a temporary qualification VM, never a chain backend. No activation without root's KVM coordination.**

## Stage
`rpc-qualification-vm-stage/r3/`, `SHA256SUMS` = **`cc447dee70748f870ff424cb137860b2956d12b4ce62dd1613ed86b85b49ee62`** (read-only)

| file | sha256 |
|---|---|
| `qualvm.py` | `0d4d84bd788f3ab3dbba2798d89704d3e256f8caf8ff9527cd71fff1049a7585` |
| `test/test_qualvm.py` (13) | `ada0504484c59d0c9506671f83aaafb735f4be7b90482c873e3a9f14b3313e4f` |
| `jobs/root-qualvm-r3-tests.sh` | `8b5aba4f8712699c1d3310309cd832080f5fc07dcf21f337b13e6081cb70d53f` |
| `README.md` | `099b5fccb4fe86fde409db765886e2618bc612b5e67626a62263579edadf3f45` |

## Lifetime and memory ownership (B1)
**Why the queue can't hold the VM:** the shared queue cannot wrap a 10 GiB cgroup (its lanes go to 4096 MiB).

**So there are three nested, owned lifetimes:**
1. **The controller** (`qualvm.py controller OUT`):
   - **Where it runs:** **inside root's 512 MiB main queue lane** for the whole qualification. It reads its own cgroup `memory.max`, which must be exactly `536870912` (the queue's `MemoryMax=512M` scope); any other value refuses.
   - **Start token:** it records its PID plus the `/proc/<pid>/stat` start time.
2. **The floor unit** `enclave-rpc-qual-floor.service`:
   - **Started by** the controller via `systemd-run --user`, with `MemoryMax=64M`, `MemorySwapMax=0`, `Restart=no`, and `RuntimeMaxSec` = lifetime + 600 s.
   - **Every 1 s it exits 4** (recording `floor-trip.json`) on any of these:
     - `/proc/meminfo` unreadable, or MemAvailable **< 18 GiB**, the proactive stop that keeps the physical 16 GiB floor untouched;
     - the controller's PID/start token is gone (death or PID reuse);
     - the overlay's **allocated** bytes (`st_blocks × 512`) exceed 16 GiB;
     - NVMe available space is below the production guard's own **pause** threshold (`floorBytes + pauseMarginBytes` from the pinned manifest = 368,719,476,736 B; the T710 reserve);
     - the overlay or filesystem is unreadable.
3. **The VM unit** `enclave-rpc-qual-vm.service`:
   - **Started only after the floor unit**, with `BindsTo=` + `After=` that unit, `MemoryMax=10G`, `MemorySwapMax=0`, `TimeoutStopSec=30`, `RuntimeMaxSec`, `Restart=no`, `KillMode=mixed`.
   - **When the floor unit exits or dies for any reason** (trip, crash, its own 64 MiB OOM, RuntimeMaxSec), **systemd stops the VM**: SIGTERM to QEMU, then SIGKILL after 30 s.
   - That is prompt, and it is safe because all guest writes are in the disposable overlay while the original OS, L1 and Base images are read-only.

**There is no detached launch.** r2's `launch` is removed. The VM cannot outlive the floor unit, the floor unit cannot outlive the controller, and the controller lives inside root's lane.

**Admission** (all in the controller, before anything starts):
- MemAvailable readable and **≥ 27.75 GiB** = 16 GiB floor + 10 GiB VM cap + 512 MiB lane + 256 MiB (floor unit/misc) + 1 GiB margin;
- NVMe available ≥ pause threshold + 16 GiB overlay maximum;
- the production VM and guard **loaded** and inactive or failed (B7: a `not-found` production unit refuses);
- both qual units absent;
- the production OS disk not open by any process (B7: re-checked at launch);
- `PREPARED.json` re-verified (kernel and initrd sha, OS disk identity `(size, mtime_ns, ctime_ns, ino)`, no auto data mount).

**Orderly end** (SIGTERM from `qualvm.py stop OUT`, which signals only the recorded controller after checking its start token; or the 4 h lifetime; or VM exit):
1. ACPI `system_powerdown` over its own QMP socket;
2. ≤ 180 s grace;
3. then `systemctl --user stop` **only if the VM unit's InvocationID still equals the one recorded**; a foreign invocation is never stopped, and the receipt says so;
4. then the same for its own floor unit;
5. finally the receipt `controller.json`: admission values, both InvocationIDs, end reason, ACPI result, `floorTrip`, production pins and OS disk identity before and after (`productionUnchanged`), overlay allocated bytes, NVMe before and after. rc 4 if the floor tripped or production changed.

## The other blockers
**B2: `prove` failure rc.** `main` returns **3** whenever `prove` is not `ok: true`.

**B3: real mount and read-only checks.** `prove` is read-only. It fails unless all of the following hold:
- **Host:**
  - the controller is alive (token);
  - our **own** VM and floor InvocationIDs are active. Otherwise it never uses SSH, since the production and qual guests share `127.0.0.1:22850` and the host key;
  - the VM unit `BindsTo` contains the floor unit, with `MemoryMax=10737418240` and `MemorySwapMax=0`;
  - QMP `query-block` shows `ro: true` for `l10` and `base0`.
- **Guest, one shell line with shell-quoted unit names:**
  - `/proc/cmdline` **exactly** equals the prepared GRUB args plus all masks;
  - `uname -r` equals the prepared kernel version;
  - `MemTotal` is between 7 and 8 GiB;
  - `findmnt -rn --mountpoint <m>` is empty for each manifest mount;
  - `lsblk -rndo NAME,SERIAL,RO,MOUNTPOINTS`: by manifest serial, L1 and Base show `RO=1` with no mountpoint, and all three disks are present.

**B4: overlay capacity.**
- **At admission (prepare and controller):** `OUT` must be on the same filesystem as the production NVMe backing dir (`st_dev`), and available space ≥ pause threshold + `OVERLAY_MAX`.
- **During the run:** the floor unit enforces the allocated size and the pause threshold continuously.

**B5: complete unit inventory, empty allowlist.**
- **Unit files:** every `systemctl list-unit-files 'enclave-*'` entry must be `masked-runtime`.
- **Loaded units:** every `systemctl list-units --all 'enclave-*'` unit must be inactive.
- **Coverage:** the 8 known units and both mount units must appear in that inventory.
- **What this catches:** a new timer or service installed by another stage that is not masked fails the proof. A unit that is not in that inventory at all but is still chain-related cannot exist under the `enclave-*` naming.
- **Limit:** a differently named chain unit is not detected. It is fail-closed only for `enclave-*`, which is how every stage installs its units. Documented.

**B6: kernel binding (`prepare`; read-only, using the frozen r1 inspector's GPT and debugfs helpers).**
- **Search binding:** the default entry must contain exactly one `search … --fs-uuid --set=root <literal uuid>`, equal to the ext4 UUID (superblock `0x68`) of the partition the files are read from.
- **`root=` binding:** it must name exactly one real partition by `LABEL=` (ext4 label), `UUID=` (ext4 UUID) or `PARTUUID=` (GPT unique GUID). Device paths such as `/dev/sda1` are refused (never guessed).
- **Regular files:** `debugfs stat` must show `Type: regular` for kernel and initrd, so a symlink's text is never accepted.
- **Kernel format:** the kernel must have `HdrS` at `0x202`; the initrd must be ≥ 1 MiB.
- **Indented entries:** an indented `menuentry`/`submenu` before the first top-level entry refuses.
- **In-guest check:** `prove` checks the exact cmdline and `uname -r`.

**B7: unit LoadState and receipts.**
- Production must be `loaded` and inactive or failed.
- `prove` and `stop` check unit ownership first.
- `discard` refuses while either qual unit is active or the controller is alive, and writes `discard-receipt.json` with the OS disk identity `(size, mtime, ctime, ino)` against prepare, refusing on a mismatch.

## Scope labels (unchanged policy)
- **The qualified VM writes only the disposable OS overlay.** The production `os.qcow2` is its read-only qcow2 backing; L1 and Base are read-only, with their mounts masked; network is `restrict=on` with the SSH forward only. No production file is edited.
- **Q1 (b3sum):** the offline package route from `logs/claude-small-qualification-vm-r2.md` (host download, verified in the guest with `gpgv`).
- **Q2:** OS-overlay scratch only.
- **Q3 cannot be qualified here:** the retention unit is runtime-masked. A scratch-unit merge check shows systemd semantics only; it is labelled overlay-only and is **not** a qualification of the original installation. Q3 belongs to production activation.

## Tests (13 source fixtures; not run)
- **GRUB:**
  - an accepted Ubuntu-shaped fixture binds the search UUID and kernel version;
  - 9 adversarial cases are refused: an indented entry first; no search, two search lines, a search without `--set=root`, a search variable; a kernel without a version; two initrd files; default 1; an arg variable;
  - `root=` binding (LABEL/UUID/PARTUUID accepted; a device path, a missing label and an ambiguous label refused); regular file vs symlink stat; bzImage magic.
- **Floor:**
  - every trip condition: MemAvailable at 18 GiB − 1 KiB vs at 18 GiB, unreadable or garbage meminfo, a wrong token, a dead PID, NVMe reserve, overlay allocated size, an unreadable overlay;
  - the loop exits 4 and records the trip.
- **Controller:**
  - 7 admission refusals start nothing (no `systemd-run`): wrong lane, a production unit not loaded, production active, a qual unit existing, MemAvailable below 27.75 GiB, MemAvailable unreadable, NVMe;
  - lifecycle: floor first, the VM `BindsTo`/`After` the floor with `MemoryMax`/swap/`Restart`, both InvocationIDs recorded, its own floor stopped, production unchanged;
  - a stop request sends ACPI then a bounded stop of OUR invocation, and a foreign InvocationID is never stopped.
- **Prove:**
  - good sections pass; 11 defects each fail (extra cmdline token, missing mask, uname, MemTotal, unmasked unit, active unit, a mask absent from the inventory, data mounted, disk writable, disk mounted, disk missing);
  - the query quotes `\x2d` unit names and has 8 sections;
  - it never uses SSH for a foreign invocation; an unbound VM fails; `main` gives rc 3.
- **Discard:** refused while the floor unit or the controller is alive.
- **Argv:** the r2 diff shape, always `restrict=on`, `-append` equal to the expected cmdline.

**Root commands (not run):**
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh qualvm-r3 256 bash rpc-qualification-vm-stage/r3/jobs/root-qualvm-r3-tests.sh
# later, ONLY after root/KVM capacity coordination, from the 512 MiB MAIN lane, for the whole qualification:
#   python3 -I rpc-qualification-vm-stage/r3/qualvm.py prepare OUT        (production off)
#   bash jobs/q-exit-status.sh qual-controller 512 python3 -I rpc-qualification-vm-stage/r3/qualvm.py controller OUT
#   (from another shell) qualvm.py prove OUT  -> rc 0 required; Q1/Q2 steps; qualvm.py stop OUT; then qualvm.py discard OUT
```

## Limits / unknowns (fail closed where unverified)
- **systemd environment:** `systemd-run --user` from inside the queue's scope needs the user manager environment (`XDG_RUNTIME_DIR`). If it is absent, the controller refuses at the floor-unit start and starts nothing.
- **Floor reaction time:** about 1 s polling plus the systemd stop (SIGTERM, ≤ 30 s, SIGKILL). The 2 GiB band between 18 and 16 GiB is the budget for that interval.
- **Floor unit memory:** its own 64 MiB cap is not measured. If it OOMs, the VM stops (`BindsTo`), so it fails closed.
- **Real-system checks** (stubs only so far): `debugfs` output formats (`Type: regular`), lsblk `MOUNTPOINTS` (util-linux ≥ 2.37), and QMP `query-block` field names (`inserted.node-name`, `ro`). A mismatch fails `prepare`/`prove`; it never passes them.
- **The B5 inventory** covers `enclave-*` plus the two mount units only.
