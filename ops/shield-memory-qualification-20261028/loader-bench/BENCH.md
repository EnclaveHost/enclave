# Loader-only SNP A/B harness (shieldmodel drop-cache marker)

Initial source preparation: 2026-10-27. **Updated qualification: see README.md and RESULTS.json for October 28 tests and four actual loader boots.**
No command, VM, service, device, network or credential was touched while writing it. The model
was not read or hashed. Production (`/home/steven/enclave-prod/release-5cab66e4`) was only
looked at: the file names were listed, and `release.json` was grepped for its cmdline. This
harness only reads `kernel` and `firmware.fd` from there (pinned digests). It never writes,
stops or signals anything in production. The old run-canary scripts were not reused.

## What this measures

LOADER.md "Benchmark this separately", reduced to the loader only. Each arm is one SNP boot in
which `shieldmodel` runs and nothing else. There is no dominit, inference, GPU, network, chain,
lease or signing. Both arms use the same `shieldmodel` binary, built from `loader-candidate/`.
The production `template/shieldmodel` cannot be used because it predates the drop-cache marker.

| Arm | `/rt/shield-original-source-reclaim.enabled` | `/rt/shield-model-drop-cache.enabled` |
|---|---|---|
| A | present | absent |
| B | present | present |

The two initramfs images differ only by that one marker file (a fixture test asserts this). Init,
loader, cmdline, kernel, firmware, VM shape and model are identical. The arms run serially, A
then B (`--order BA` is available). One boot per arm per run.

**SNP claim: configured, not attested.** QEMU is given `sev-snp-guest … kernel-hashes=on`.
Nothing requests or verifies an attestation report. A successful receipt therefore shows only
that a configured-SNP boot loaded the model. It does not show that SNP was active, and it does
not show production measurement readiness. The bench cmdline and initramfs differ from
production, so the launch measurement differs as well. Every receipt carries this statement as
`snp_claim`.

## Files

| File | Role |
|---|---|
| `init/main.go` | Static Go `/init`. It refuses unless it is PID 1. It mounts only `proc`, `sysfs`, `devtmpfs` and `cgroup2` (no host filesystems) and latches `modules_disabled=1`. Preflight checks: the reclaim marker is present; the arm comes from the drop-cache marker alone; the only disk is `vda`, which is read-only and at least the model size; there is no network interface besides `lo`; the models dir is empty. It creates `/sys/fs/cgroup/shieldmodel` with `memory.max=45 GiB` and `memory.swap.max=0` (or `unsupported` if the kernel lacks swap accounting), reads both back, and fails closed on any error. It starts `/bin/shieldmodel` with an empty env directly in that cgroup (`clone3` `CLONE_INTO_CGROUP`) and confirms `/proc/PID/cgroup`. It relays stdout and stderr (at most 64 lines of 4 KiB each), kills the child after 150 s, emits metrics, a result and a final `poweroff` record, then calls `reboot(POWER_OFF)`. It never exits: if poweroff fails, the host's RuntimeMaxSec ends the VM, and that is never counted as success. |
| `init/main_test.go` | Record format and CRC, meminfo/stat parsing, MODEL-line parser (legacy and drop-cache formats, duplicate and spoof lines rejected), the guest classification table, cgroup setup failing closed (no cgroup2, no memory controller, subtree not enabled, missing `memory.max`, existing child cgroup), control files never created, and relay bounding and draining. Uses temp files only, with no mounts and no cgroups. |
| `benchlib.py` | Pins, RAM floor arithmetic, static-ELF check, NEWC writer and reader, deterministic gzip, USB/removable storage check via sysfs (partitions, dm/md slaves, btrfs `0:N` via mountinfo), stat-only model identity, QEMU and `systemd-run` argv builders, serial parser, guest report, host verdict. Side-effect free. |
| `build_initramfs.py` | Stage-only builder (details below). |
| `run_snp_ab.py` | Host helper: `plan`, then `execute` (dry run by default). |
| `test_harness.py` | Python fixture tests. The host is faked, and sysfs and mountinfo are temp trees. No VM, unit or process is started. |
| `resource_guard.py` | Read-only `/proc` inventory of `qemu-system*` processes: pid, start time, `-m` RAM, cgroup. `check` refuses if the inventory differs from the plan's `production_guests`, or if the pending reserve is below the sum of their nominal RAM. A `-m` that is not plain `N`, `NM` or `NG` raises, which refuses the run. |
| `test_resource_guard.py` | Unit parsing, inventory and own-PID exclusion, plus run-level cases: a new guest during the run stops only the owned unit (`identity_changed`); the reserve floor is enforced; an early failure still cleans up. Both unittest discovery and direct invocation include the runtime guard tests. |

## Guest record format (serial, `ttyS0`)

```
BENCH seq=N t_ns=<CLOCK_BOOTTIME ns> kind=K key=value ... crc=<crc32 IEEE of everything before " crc=">
```

Keys and values are query-escaped. The host accepts a log as **complete** only under these
conditions:
- Every record's CRC matches.
- `seq` runs 1..N with no gap or duplicate.
- Record N is `poweroff`.
- There is exactly one `result`.
- Nothing was malformed.

Kernel noise before `BENCH` on a line is tolerated. A record torn by interleaving makes the log
incomplete, never "successful". The cmdline keeps production's `loglevel=3` to keep the console
quiet.

Records by phase:
- `boot`: cmdline and modules.
- `preflight`: arm, block devices, vda read-only flag and size, net.
- `meminfo`, `cgroup` and `cgroupfile` for phases `boot`, `before` and `after`. These cover:
  - all of `/proc/meminfo` (`m.*`, kB)
  - root and child `memory.current/peak/max/swap.current/swap.max` (or `absent`)
  - `memory.stat` (`s.*`)
  - `memory.events` (`oom`, `oom_kill`, …)
- `child-start`.
- `child-stdout` and `child-stderr`: loader lines verbatim, including `MODEL verified … copy_verify_ms=… [source_dontneed_*]`.
- `child-exit`: exit, signal, timed_out, wall_ms, cgroup.
- `result`: status, reason, arm, digest_verified, model_bytes, model_sha256, copy_verify_ms, advised_bytes, advice_failures, child_wall_ms.
- `poweroff`.

The guest sets `digest_verified=true` only after all of these: a clean loader exit, exactly one
MODEL line whose bytes and sha256 equal the pins, and the loader's own whole-file check passing.
`ok` additionally requires that the MODEL-line format matches the arm (arm B must report
advice counters, arm A must not) and that the 0444 private copy and both symlinks exist.

## Builder (`build_initramfs.py`)

The builder only stages: it checks inputs and writes two archives plus a manifest. Its inputs
are explicit paths: `--init`, `--loader`, `--init-source`, `--loader-source`, `--kernel`,
`--firmware`, `--out`. It refuses:
- a binary that is not ELF64 x86-64 `ET_EXEC` with no `PT_INTERP`/`PT_DYNAMIC` (that is, not what `CGO_ENABLED=0` emits)
- the same file passed as both init and loader
- a kernel or firmware sha256 that differs from the pins

It then `mkdir`s `--out`, which fails if the directory exists, and writes these files `O_EXCL`
with mode 0444:
- `arm-{A,B}.initramfs.cpio.gz`: newc, uid/gid/mtime 0, sequential inodes, sorted paths, `dev/console` c 5:1 created only in the archive (no host `mknod`), gzip level 9 with mtime 0 and no filename.
- `build-manifest.json`: sha256 of init, loader, kernel and firmware; sha256 of every `*.go`/`*.py` in the source dirs and in this directory; per-arm archive sha256 and listing; cmdline; model pins with `host_check: stat identity only`.

The model is never opened or copied. Output is byte-reproducible for the same inputs and
Python/zlib. The digest is recorded rather than assumed portable across zlib versions.

## Run helper (`run_snp_ab.py`)

`plan` runs no command. It does the following:
- reads the manifest
- hashes kernel, firmware and qemu (small files; never the model)
- `stat`s the model (size must equal the pin; records dev/ino/size/mtime_ns/ctime_ns)
- generates a random 128-bit run id and the unit names `shield-snp-ab-<runid>-<arm>.service`
- builds both argv lists
- creates `--out` (fails if it exists, and is refused inside the production release)
- writes `plan.json` with mode 0444 in a 0755 directory, so root can inspect it
- prints its sha256 and any current preflight problems

`execute` runs only after the plan has been reviewed:
- It needs `--plan` and `--approve-plan-sha256` equal to the reviewed digest.
- **Without `--execute` it is a dry run.** It prints the preflight results and the exact argv.
- With `--execute` it also needs `--coordinated-slot <id>`, because the 48 GiB VM is not a small-queue job. It refuses an existing `receipt.json`.

**Strict per-boot preflight (before each arm). Any problem refuses the boot:**
- The helper is not running as root.
- The kernel and firmware digests equal the pins.
- The qemu digest and the arm's initramfs digest equal the plan.
- The QEMU argv passes the independent invariants (below), and the unit argv carries every limit.
- The model's stat identity is unchanged.
- No input path, nor the plan dir, is on USB-attached or removable storage, and each resolves to a block device.
- `/dev/kvm` and `/dev/sev` are read/write for this user.
- **`MemAvailable` ≥ 48 GiB + 2 GiB + pending production RAM + 18 GiB**. Pending production RAM is `--pending-production-ram-mib`, and a value below 1551 is refused rather than clamped, so the minimum is 69.5 GiB.
- The `qemu-system` process inventory equals the plan's `production_guests`, and the pending reserve covers their nominal RAM (`resource_guard`).
- The serial log does not exist yet.
- The unit is `not-found`.

**VM (the only shape possible: `qemu_violations` rejects anything else):**

```
qemu-system-x86_64 -nodefaults -no-user-config -no-reboot -display none -monitor none -parallel none -nic none
  -serial file:<plan>/serial-<arm>.log
  -machine q35,accel=kvm,confidential-guest-support=sev0,memory-backend=ram0,vmport=off -cpu <pinned> -smp 2 -m 48G
  -object memory-backend-memfd,id=ram0,size=48G,share=true
  -object sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on
  -bios <release>/firmware.fd -kernel <release>/kernel -initrd <arm initramfs>
  -append "console=ttyS0 rdinit=/init loglevel=3 panic=-1"
  -drive if=none,id=model,file=<public model>,format=raw,readonly=on,cache=none
  -device virtio-blk-pci,drive=model,disable-legacy=on,iommu_platform=on
```

There is no other disk, NIC, chardev, QMP or monitor. Paths containing `,`, `=` or whitespace
are refused.

**Unit:**

```
systemd-run --user --unit shield-snp-ab-<runid>-<arm>.service --service-type=exec \
  -p MemoryMax=50G -p MemorySwapMax=0 -p CPUQuota=200% -p RuntimeMaxSec=180 -p KillMode=control-group -p RemainAfterExit=yes -- <qemu argv>
```

After start, the helper records the unit's `InvocationID`, `ControlGroup`, `MainPID` and the
PID's start time. It checks that `/proc/PID/exe` is the planned qemu. It checks that the
unit cgroup really has `memory.max=53687091200`, `memory.swap.max=0` and `cpu.max=200000 100000`;
otherwise it stops the unit as `limits_not_enforced`.

**Watchdog, every 1 s:**
1. Read host `MemAvailable` and the unit's `memory.current`, `memory.peak` and `memory.stat`. Samples go to `host-samples-<arm>.jsonl`, and the last full `memory.stat` goes to the receipt.
2. If the `qemu-system` inventory (excluding our own QEMU PID) differs from the plan, stop **only this unit** as `identity_changed`. If `MemAvailable` drops below **18 GiB + pending production RAM**, stop **only this unit** as `killed_low_host_memory`. The code does this as of the concurrent edit. It is stricter than the brief's "< 18 GiB", because it keeps the pending image's RAM free as well as the 18 GiB floor. To get the literal brief, change `run_snp_ab.watch` back to `avail < B.HOST_FLOOR`; it was left as found here.
3. Also stop it after 200 s (a backstop behind RuntimeMaxSec).
4. If the InvocationID changes, report `identity_changed` and stop nothing.

**Cleanup always runs.** It stops the owned unit only if the InvocationID still matches. If
the unit failed, it runs `reset-failed` on it. If the exact QEMU PID is still alive with the
same start time, it `SIGKILL`s that PID. It then checks that the unit is gone or inactive.
Every `systemctl` call names the planned unit. The fake host fails the tests on any other
target.

The run stops after the first non-success arm, and the remaining arm is recorded as `not_run`.
The host's `memory.peak` is the last 1 Hz sample, because the cgroup disappears when QEMU exits.
That is a lower bound sampled at most 1 s before exit.

## Receipt (`<plan>/receipt.json`)

The receipt records `plan_sha256`, `coordinated_slot` and `snp_claim`. For each arm it records:
- `outcome`, `success`, `error`
- `guest_poweroff`: the poweroff record was seen, QEMU exited with status 0, and the watchdog did not stop the unit
- `digest_verified`: from a complete, CRC-checked guest log only, and forced false if the watchdog stopped the unit
- `metrics_available`: before and after meminfo, child cgroup and memory.stat, plus a numeric child `memory.peak`
- full `host` and `guest` detail

Top-level `success` requires both arms to succeed.

Outcomes, in precedence order (host kills win over anything the guest printed):

`preflight_refused`, `start_failed`, `helper_error`, `limits_not_enforced`, `identity_changed`,
`killed_low_host_memory`, `killed_host_deadline`, `unit_timeout`, `qemu_failed`,
`serial_incomplete`, `arm_mismatch`, `guest_error`, `digest_not_verified`,
`metrics_unavailable`, `model_identity_changed`, `cleanup_failed`, `success`.

## Review steps

All of these are for you to run. None was run here.

1. **Read the source.** In particular:
   - `init/main.go`: `run`, `preflight`, `setupChildCgroup`, `classify`.
   - `benchlib.qemu_argv` and `systemd_run_argv`.
   - `run_snp_ab.qemu_violations`, `preflight`, `watch`, `stop_owned`, `cleanup`.

   Confirm there are no mounts besides proc/sys/devtmpfs/cgroup2, no shell, and nothing that
   targets units other than the planned names.
2. **Offline tests**, submitted through the existing shared queue as small jobs. They need no
   root, devices or network, and write only to `$TMPDIR`:
   ```sh
   H=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/shield-memory-20261028
   cd $H/bench-harness/init && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOTOOLCHAIN=local GOPROXY=off GOFLAGS= \
     timeout 300 go test -count=1 -timeout 120s -v main.go main_test.go
   cd $H/loader-candidate && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOTOOLCHAIN=local GOPROXY=off GOFLAGS= \
     timeout 300 go test -count=1 -timeout 120s -v main.go fadvise_linux_amd64.go main_test.go
   cd $H/bench-harness && timeout 300 python3 -m unittest -v test_harness test_resource_guard
   ```
3. **Static builds** (shared queue), into a new stage dir:
   ```sh
   S=$H/bench-stage-$(date +%Y%m%d%H%M%S); mkdir "$S"
   GO="env CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOTOOLCHAIN=local GOPROXY=off GOFLAGS="
   (cd $H/bench-harness/init && $GO go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$S/init" main.go)
   (cd $H/loader-candidate && $GO go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o "$S/shieldmodel" main.go fadvise_linux_amd64.go)
   ```
4. **Stage the initramfs images** (shared queue):
   ```sh
   python3 $H/bench-harness/build_initramfs.py --init "$S/init" --loader "$S/shieldmodel" \
     --init-source $H/bench-harness/init --loader-source $H/loader-candidate \
     --kernel /home/steven/enclave-prod/release-5cab66e4/kernel \
     --firmware /home/steven/enclave-prod/release-5cab66e4/firmware.fd --out "$S/build"
   ```
   Inspect `$S/build/build-manifest.json`. Rebuilding into another `--out` should give
   identical archive digests.
5. **Plan.** This runs no command:
   ```sh
   python3 $H/bench-harness/run_snp_ab.py plan --build-dir "$S/build" --out "$S/run1" \
     --qemu /usr/bin/qemu-system-x86_64 --cpu-model EPYC-v4 --pending-production-ram-mib <current, >=1551>
   ```
6. **Root or operator inspection.** Read `$S/run1/plan.json`: pins, argv, unit names,
   `required_available_bytes`, `model_identity`, `plan_time_problems`. Note its sha256.
7. **Dry run:** `run_snp_ab.py execute --plan $S/run1/plan.json --approve-plan-sha256 <sha>`.
8. **Execute only inside a separately coordinated 48 GiB / 2 CPU slot** from the KVM
   coordinator, not a small-queue budget. Run it as the normal user, from a session with a
   `systemd --user` bus:
   `… execute --plan … --approve-plan-sha256 <sha> --execute --coordinated-slot <slot id>`
9. **Read `receipt.json`, `serial-*.log` and `host-samples-*.jsonl`.** Compare the arms on:
   - after-phase guest `Cached`, `MemFree`, `Unaccepted`
   - child `memory.peak` and `memory.stat` `file`
   - host unit `memory.peak` and max `memory.current`
   - `copy_verify_ms` and `child_wall_ms`

   Per LOADER.md, never quote `advised_bytes` as RAM saved. For a claim, use ≥2 runs per arm.

## Prerequisites and open items (not verified here)

- **Go ≥ 1.20** for `SysProcAttr.UseCgroupFD`, `strings.CutPrefix` and `errors.Join`.
- **Guest kernel `clone3` `CLONE_INTO_CGROUP` (Linux ≥ 5.7).** The release kernel's version was not read. If the kernel lacks it, the guest reports `child_start: …` and powers off (fail closed). Other kernel requirements: `CONFIG_DEVTMPFS`, cgroup2 with memory (stated as supported), gzip initramfs support, and virtio-blk built in. The release ships no virtio-blk `.ko`, which suggests it is built in. Unverified.
- **`-cpu` model.** Production's QEMU argv is not in `release.json`, so the CPU model is a required, pinned plan parameter. `EPYC-v4` is only an example. Match the production launcher.
- **QEMU/OVMF.** This needs a QEMU with `sev-snp-guest` (upstream 9.1+), and the release `firmware.fd` must support SNP kernel hashes. Both are assumed from the production setup, not checked.
- **User systemd delegation.** The `memory` and `cpu` controllers must be delegated to `user@.service`. If they are not, the helper refuses with `limits_not_enforced` instead of running unbounded. `/dev/sev` must also be accessible to the user, otherwise preflight refuses. Nothing escalates privileges.
- **Shared queue.** `run_coordinated.py` holds both coding-lane locks during an explicitly coordinated VM run; small builds/tests use the existing bounded queue.
- **Pending production RAM** is operator supplied but must cover the full nominal RAM of every observed existing QEMU. The inventory is checked before each boot and during the watchdog. These experiments reserved 13 GiB again, conservatively above already resident guests. With `resource_guard`, it must also be at least the summed `-m` of every `qemu-system` process running at plan time, or preflight refuses.
- **Production QEMU `-m` format.** `resource_guard` accepts only `-m N`, `-m NM` or `-m NG`, given exactly once. Any other form (`size=`, `maxmem`, `slots`) refuses every run. Check this against the production launcher before booking a slot.
- The host-side `memory.peak` is a ≤1 s-old lower bound (see above). Guest-side `memory.peak` is exact for the child cgroup.

## Limitations (honest)

1. Loader-only builds/tests and four boots passed; full inference and independently verified attestation remain unqualified.
2. One boot per arm per run. There is no repetition or interleaving logic.
3. SNP is configured, not attested (see above). Load-only success says nothing about inference, decode speed or production admission.
4. Host USB detection relies on `/usb` in the sysfs path and on `removable`. Exotic stacks (for example, network block devices or multi-device btrfs beyond the mount source) are refused when they cannot be resolved, but may be missed when they resolve oddly.
