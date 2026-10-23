# Isolated whole-snapshot Sia production restore: root-run harness (RESULT, 2026-10-23)

**Status: SOURCE + OFFLINE TESTS ONLY.**
- Nothing was run against production. No SSH, no live read, no DNS lookup of real hosts.
- No private file was read: not the snapshot, the archive, `app.seed` or `backup.pass`. The binary was not rebuilt.
- Root runs every step below.

## 1. Files (`work/resume-after-checkpoint-20261022/sia-whole-restore-harness/`)

| file | sha256 | role |
|---|---|---|
| `whole_restore.py` | `8a6cc0d30ce0cfdd8d2a9f1362d1b8f4eb24de630975f15a84a9f3184b5a0b9e` | root-run launcher: `check`, `prepare`, `start`, `poll`, `stop`, `finish`, `discard` |
| `runner.py` | `d11f7bca1a879fb9bf1583782d9456aedff70c55a30b1404480d0fb4d24b4587` | runs INSIDE the bounded unit: bridge, namespace, probes, restore, on-disk verification. Stdlib only, Python ≥ 3.8 grammar (checked) |
| `blocked.workstation.example.json` | `c2ce83a3…` | EXAMPLE deny/probe list for `--target local` (root completes it) |
| `blocked.vm.example.json` | `f2c03d74…` | the same, for `--target vm` |
| `run-tests.sh` | `903f5574…` | offline suite runner, inside `unshare -rn` |
| `test/test_harness.py` | `917a9d2b…` | 17 offline tests |
| `test/test_real_systemd.py` | `548e5cd2…` | 1 end-to-end test through the real `systemd-run --user` (loopback only) |
| `test/fake-sia-s3` | `13b7ec74…` | stand-in restore binary (real output format) |
| `test/stubs/{ssh,systemd-run,systemctl}` | `ab052426…`, `4f91c325…`, `9566f16c…` | record argv and stdin; run the "VM" locally |

The old tooling in `work/sia-direct-recovery/` and root's `production-run/` scripts were not modified.

## 2. What it does, and what is guaranteed

**`prepare`** (local; root's only live read here is public DNS for the Sia host names):
- **Pins first.** It checks the archive sha256 (`3cfb4f12…`) and the snapshot sha256 (`0e5b28c9…`). The key file must be
  a regular, non-symlink file owned by the user with mode 0600. The root path must be a 0700 directory.
- **Optional archive check:** `--archive-passphrase-file` stream-decrypts the archive with gpg. In memory, it confirms the
  archive holds exactly this `snapshot.json` and this `app.seed`. Nothing is written or printed.
- **Derivative.** It builds an **IP-pinned derivative**: each host's `siamux` addresses become the global IPv4 addresses
  they resolve to, on the same port.
  - Dropped and counted: non-siamux addresses (the native binary dials siamux), private/loopback/IPv6 addresses, and
    unresolved names.
  - `verify_derivative` refuses any difference beyond host addresses, and any address its host did not announce.
- **Original preserved.** The original snapshot is never written and is re-hashed afterwards. Both hashes are recorded.
- **Refusals before anything is written:**
  - any Sia host address equal to a blocked address;
  - no outside-reachable control endpoint;
  - no usable endpoint at all.
- **Output:** a NEW 0700 run directory `ROOT/<UTC>-<hex8>/` holding `snapshot-ip-pinned.json` (0600) and `run.json`.
  It prints counts and digests only.

**`start`** (explicit `--binary --binary-sha --max-total-bytes --deadline-secs --memory-max-mib --target`; nothing has a
default except `--cpu-quota 200`):
1. **Pins again, before anything is copied, uploaded or started:** the binary, the original snapshot, the archive, the
   derivative, and the key file's mode.
2. **Outside positive control.** Every `outsideMustConnect` endpoint (the indexer) must answer OUTSIDE the scope;
   otherwise nothing starts. On the workstation this is the storage-VM SSH forward; on the VM it is indexd at
   `127.0.0.1:9982`.
3. **Staging.**
   - A new attempt directory `run/attempts/NNN-<hex>/` (0700) holds a staged copy of the binary, re-hashed after copying.
   - **VM only:** a new `VM_ROOT/<run>-NNN-<hex>` is created with `mkdir -m 0700`, which fails if it exists. One upload
     follows: a tar on **SSH stdin** holding the staged binary, the key file, the derivative, the plan and the runner.
     Every uploaded file's sha256 is then compared before the unit starts.
4. **One unit, started without waiting.**
   - **Workstation:** `systemd-run --user`.
   - **VM:** `sudo -n systemd-run`, plus `IPAddressDeny=any` and `IPAddressAllow=<the pinned host IPs>`: a second,
     kernel-enforced allowlist covering the whole unit, bridge included.
   - **Both:** `Type=exec MemoryMax MemorySwapMax=0 TasksMax=512 CPUQuota RuntimeMaxSec KillMode=control-group
     NoNewPrivileges`. `RuntimeMaxSec` = deadline + 900 + one second per 25 MiB of budget (the on-disk re-hash).

**Inside the unit (`runner.py`):**
- **The network boundary.** The restore runs in a **new network namespace whose only interface is loopback**. Each
  pinned `ip:port` is an address on that loopback, served by a relay to an AF_UNIX socket.
- **The bridge.** Outside, the runner connects to **exactly that `ip:port`** and to nothing else. It first reports in
  one byte whether the real host answered.
- **Everything else has no route:** indexd, Nan, the four DO fronts and their gateways, LAN control, and DNS.
- **Checks from inside, before the restore:**
  - every blocked endpoint must fail. These are the same endpoints that `start` just proved reachable outside;
  - every blocked name must fail to resolve;
  - at least one real host must answer through the bridge;
  - the binary and derivative pins are checked again just before exec.
- **The restore** runs `sia-s3 recovery restore DERIVATIVE SHA OUTDIR BUDGET DEADLINE`. Its env is only
  `PATH`, `LANG` and `SIA_RECOVERY_KEY_FILE`, a path.
- **After the restore:** the free-space check (budget + 1 GiB, done before launching) has passed; the inventory is
  cross-checked against the disk (every file re-hashed and sized, no stray file); `memory.peak` is recorded.
- **Output:** `result.json` holds counts, sizes, digests (`inventorySha256` and a `filesDigest` over the sorted
  file/size/sha lines) and booleans. **The inventory (names) and the data stay private in `restored/`.**
- **Success requires all of:** exit 0, `complete`, `keys == restored`, 0 failed, 0 not attempted, every byte on disk
  matching, and isolation proven.
  - **A partial restore is a failure.**

**`poll` / `stop`.**
- The exact handle is the unit name plus the invocation id that the unit itself records (`started.json`, from
  `$INVOCATION_ID`).
- A different live invocation under that name is reported as `handle-mismatch`, and `stop`, `finish` and `discard`
  refuse it.
- `poll` prints progress: the file count and the bytes written so far. Exit codes: 0 succeeded, 3 running, 1 failed.

**`finish` / `discard`.**
- **`finish`** removes only staging: the binary copy and, on the VM, the uploaded key. It runs after a verified
  success, or with `--abandon` after a failure.
- **Restored data is never removed automatically.** `discard` removes one attempt's `restored/`, and only when root
  runs it.

## 3. The existing harness (`work/sia-direct-recovery/`): limitations, and what changed

| old (10-19, two known files) | here |
|---|---|
| old snapshot `7cc3e31a`/derivative `35d4b6a4`; fixed private paths `snapshot-ip-pinned.json`, `test-plan.json`, `live-handle.json` and `live-*.log`, overwritten by every run | the fresh snapshot is an argument; every run and attempt gets a NEW 0700 directory; nothing is overwritten |
| `recovery read` of 2 files, with sha/size from other records | `recovery restore` of every key; a partial restore is a failure |
| no binary hash check, locally or after upload | binary, snapshot, derivative and archive are pinned before upload; uploaded hashes are compared; the runner re-checks before exec |
| ONE blocking `systemd-run --wait --pipe` over SSH (930 s timeout); a dropped connection loses the status; resume = a new `-retry` unit, plus `str.replace` edits of the uploaded `run.py` | non-blocking start; short polls by unit + invocation id; resume = a new attempt with fresh copies |
| output and seed under `/run` (RAM) on the VM; `MemoryMax=512M`, `RuntimeMaxSec=900` | the output filesystem is the target's choice (`--vm-root`, never `/run`); memory and deadline are explicit |
| cgroup `IPAddressDeny/Allow` only; the positive control was indexd only; no DNS check | a namespace boundary (both targets), plus the cgroup allowlist on the VM; outside-positive and inside-negative checks on the same endpoints; a DNS check; a real-host positive check through the bridge |
| seed and binary deleted only after success; on failure, left in `/run` | the same rule, made explicit: `finish` after success, or `finish --abandon` |

**Failure domain: neither target is host-loss proof** (stated separately, as asked).
- **The storage VM** runs on the minipc, beside indexd and its database. A restore there proves only that the
  indexer *process* is not used. It does not prove survival of losing that host. The restored copy would also live on
  the machine whose loss it is meant to survive.
- **The workstation** is a different machine from the indexer's host. With indexd blocked (and the minipc unreachable
  from inside), it shows recovery without the indexer machine. It is still **the same site, owner and uplink**: no
  off-site or provider-loss proof.
- Recovery still depends on Sia contracts and host account balances being alive. Those are renewed only by the live
  indexer.

## 4. Workstation or storage VM?

| | workstation (`--target local`) | storage VM (`--target vm`) |
|---|---|---|
| free space for 21,445,494,044 B + 1 GiB | **266 GB** on LUKS-encrypted ext4 (`/`, read locally now) | 57.7 GB at `/home/storageadmin` (root's input, 00:44Z) |
| memory / CPUs | 31 GiB available / 32 | 3.2 GiB available (root's input) |
| key handling | none: the key file is used in place, by path | the key must be uploaded (SSH stdin, 0600 in a 0700 dir) until `finish` |
| isolation | unprivileged netns + bridge (kernel boundary for the binary). The user unit does **not** enforce `IPAddress*` (known; not claimed), so the bridge, a short reviewed Python code path, is the only egress | netns + bridge **and** the cgroup `IPAddressDeny=any`/`Allow` (system unit, via `sudo -n`) |
| host independence | different machine from indexd (same site) | same machine as indexd |
| other | the 180 MB debug binary runs where it was built | 180 MB upload; the glibc compatibility of an Arch-built binary must be checked (`check --binary`) |

**Recommendation: the workstation.**
- The VM fits on space, but it requires a seed upload, gives no host independence, and adds an upload and a glibc
  risk.

**The concrete, read-only resource check** (no restore, no upload; it prints JSON and exits 1 if unfit):

```bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work
H=resume-after-checkpoint-20261022/sia-whole-restore-harness
B=resume-after-checkpoint-20261022/sia-whole-bucket-recovery/target/x86_64-unknown-linux-gnu/debug/sia-s3   # 3ef760ed…
install -d -m 0700 private/sia-whole-restore            # a NEW private root of root's choosing
python3 -I $H/whole_restore.py check --target local --root private/sia-whole-restore --total-bytes 21445494044 --binary $B
# storage VM (one short read-only SSH running a Python snippet: statvfs, meminfo, cpus, sudo -n, unshare, ldd --version):
python3 -I $H/whole_restore.py check --target vm --root /home/storageadmin/recovery-lab --total-bytes 21445494044 --binary $B \
  --ssh-dest storageadmin@127.0.0.1 --ssh-port 32422 --ssh-identity /home/steven/.ssh/minipc --ssh-known-hosts storage-vm/known_hosts
```

The check prints `fitsBudget`, `isolationAvailable` (local: user systemd, an unprivileged netns with an address added,
and a delegated `memory` controller; VM: `sudo -n` and `unshare --net`), and `glibcCompatible`.

## 5. Root's run (workstation; exact commands)

```bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work
H=resume-after-checkpoint-20261022/sia-whole-restore-harness; P=private/sia-direct-recovery; R=$P/20261022T195643Z-c16c22ef
cp $H/blocked.workstation.example.json private/sia-whole-restore/blocked.json   # review; add any gateway/control address
python3 -I $H/whole_restore.py prepare --root private/sia-whole-restore --blocked private/sia-whole-restore/blocked.json \
  --snapshot $R/snapshot.json --snapshot-sha 0e5b28c9dc53a5ac65e1bace6cf7409c8f6369599c114fb1878503acec210da1 \
  --archive $R/sia-direct-recovery-20261022T195643Z-c16c22ef.tar.gpg \
  --archive-sha 3cfb4f12991b3588d6c9b1317e08ef9613bac349f1a60073a2d835cad326c335 \
  --key-file $P/app.seed --archive-passphrase-file $P/backup.pass        # the last flag is optional
RUN=<run printed by prepare>
python3 -I $H/whole_restore.py start --run $RUN --target local \
  --binary resume-after-checkpoint-20261022/sia-whole-bucket-recovery/target/x86_64-unknown-linux-gnu/debug/sia-s3 \
  --binary-sha 3ef760ede4e46b5a944f429a78706b0822900434246bd8a24aeb22ceaba388aa \
  --max-total-bytes 23000000000 --deadline-secs <DEADLINE> --memory-max-mib 768
python3 -I $H/whole_restore.py poll --run $RUN          # repeat: exit 3 = running (watch progress.bytes)
python3 -I $H/whole_restore.py stop --run $RUN          # only if root chooses to end it early
python3 -I $H/whole_restore.py finish --run $RUN        # after "succeeded": removes staging only
# keep $RUN/attempts/*/restored until root decides retention; then, explicitly:
python3 -I $H/whole_restore.py discard --run $RUN --attempt <NNN-hex>
```

- **For the VM:** `--target vm --vm-root /home/storageadmin/recovery-lab --ssh-dest storageadmin@127.0.0.1 --ssh-port
  32422 --ssh-identity /home/steven/.ssh/minipc --ssh-known-hosts storage-vm/known_hosts`, and
  `blocked.vm.example.json`. `prepare` is the same for both targets.
- **Expected `poll` success:** `state: succeeded`, then in `result`:
  - `success: true`;
  - `probes.isolated: true`, `probes.blocked == probes.blockedTried`, `namesResolved: 0`, `allowedReached ≥ 1`;
  - `restore.complete: true`;
  - `restore.keys == restore.restored == onDiskFiles`;
  - `restoredBytes == totalBytes == onDiskBytes` (expected 21,445,494,044);
  - `onDiskMismatches: 0`;
  - `originalSnapshotUnchanged: true`.
- **Printed for the receipt:** `inventorySha256` and `filesDigest`, and no names.

## 6. Risks root should weigh (not new gates)

- **The deadline.** Root's proposed 3600 s needs about 6 MB/s sustained across 1488 keys.
  - The restore reads keys **one after another**, so per-key latency adds up.
  - A deadline hit is a partial restore, so a failure. There is **no incremental resume**: the binary refuses an
    existing output directory, so a new attempt starts over.
  - Each attempt needs its own budget of free space (`start` checks budget + 1 GiB) until `discard`.
  - The deadline is an upper bound, not a target. A generous value (hours) with `poll` progress, and `stop` if the
    rate is clearly too low, wastes less than a re-run.
- **The binary.** `3ef760ed` is the dev profile (debug for this crate; dependencies at `opt-level = 2` per Cargo.toml),
  180 MB. Its throughput is not measured. A rebuild is root's call, so none was done here.
- **Memory.** 768 MiB is not measured against real hosts. `memory.peak` is recorded in `result.json` for the next
  sizing.
- **Workstation egress.** The user unit cannot enforce `IPAddress*` (systemd user units lack the BPF privilege).
  - The restore binary itself is still kernel-confined to the namespace.
  - Egress is the bridge, which only dials the plan's `ip:port` pairs.
- **The derivative is a point in time.** Host addresses resolved at `prepare`. A host that has moved since then is
  unreachable, and its sectors come from other hosts if redundancy allows.

## 7. Tests (offline; logs in `logs/`)

**Runs** (all through `work/claude-test-queue.py --mib 256`):

| run | what | result |
|---|---|---|
| `t-11` | `run-tests.sh`: 17 tests in `unshare -rn` (203.0.113.5 on the private loopback stands in for a Sia host), final bytes | **17/17 OK** |
| `real-5` | `test_real_systemd.py`: a real `systemd-run --user` unit (loopback only) | **OK**: invocation id handle, isolation probes, `memory.peak` 26.8 MB, no leftover units |
| `mut-status` | the bridge status byte ignored | 2 tests FAIL (killed) |
| `mut-pin` | the runner's pre-exec pin check removed | FAIL (killed) |
| `mut-outside` | the outside-indexer control removed | FAIL (killed) |
| `mut-finish` | `finish` without a verified success | 2 tests FAIL (killed) |

**What the 17 tests cover:**
- **Derivation:** only addresses change, only to announced global IPv4; any other difference is refused.
- **`prepare`:** pins, the key/root mode and symlink refusals, an overlap with a blocked address, a missing control
  endpoint, a malformed hash, all with nothing written; the archive-member check with real gpg (matching and
  mismatching key).
- **`start`:** wrong binary or snapshot pins mean zero SSH and zero units; an unreachable indexer outside means only
  the probe ran; invalid bounds are refused.
- **End to end:**
  - local success: the binary itself cannot reach the indexer or Nan, and the key is absent from every output, argv
    and file;
  - partial restore = failure, with staging kept until `--abandon`;
  - on-disk mismatch = failure;
  - a swapped binary at exec = 93, nothing restored;
  - dead hosts = 92, nothing restored;
  - a plan allowing a blocked IP never runs;
  - handle mismatch: never acted on.
- **VM:**
  - the remote verbs are exactly probe, mkdir, tar, sha256sum, systemd-run;
  - the tar members are exact, with the key at 0600 and only on stdin;
  - `IPAddressDeny=any` with the exact allow list;
  - `finish` deletes the uploaded key and keeps the data;
  - after a failure the key is kept until `--abandon`.
- **`check`:** fields reported; an impossible budget is unfit; the VM check is one read-only SSH.

**A defect found and fixed during testing:** the first positive control connected to the namespace's own loopback
listener, which always accepts. It therefore "reached" hosts that were down, and the fake restore wrote empty files.
The bridge now reports the real dial result, and both the probe and the restore's connections require it (`mut-status`
proves the test catches a regression).
