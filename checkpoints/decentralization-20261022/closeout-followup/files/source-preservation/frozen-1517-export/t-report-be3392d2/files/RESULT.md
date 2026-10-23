# Network-HDD storage composition and runtime supervision (RESULT)

**Status.**
- The source composition is committed and tested on a LOCAL fixture: a KVM guest on the installed kernel 7.2.11 with the
  host's systemd 262 as PID 1, and real qemu-nbd/kernel NBD/dm-cache/ext4.
- Nothing is installed, activated or allocated. There was no production, SSH, host root, modprobe, mount, RAID write,
  format, VM restart, sync, wallet or contract change.
- **Not tested here:**
  - Hyper-V, ntfs3 and the USB RAID5;
  - the Ubuntu VM's own qemu-utils version;
  - real reth/Lighthouse/Base;
  - power loss;
  - throughput.

  Root owns activation.

## 1. Exact source

| Clone | Pinned base | Composition commits (canonical SteveDeFacto) |
|---|---|---|
| `t/` transport | `a9f0155c` (immutable final, tree `a5cb6fff`) | `29c6de8`, `cfa165f`, `c55917d`, `4bb7231` |
| `s/` S holder | `92b71784` (template `cab32bbe` unchanged) | `9775844`, `fb9ce4a` |
| `p/` P L1 pair | `f8c999ed` | `1db4d40`, `ed814e5` |

The root compose `dd5c9a59` and kernel proof `e8e86801` are read-only references. Final HEADs and hashes are in
`PROVENANCE.json`.

**What changed:**
- **`t` (transport):**
  - `hddattach.py verify-attached` checks the raw device only;
  - `detach` refuses while a dm mapping holds the device, and while it is mounted anywhere;
  - `hddwatch.py` is a new supervisor;
  - `enclave-rpc-hdd-attach@.service` is now raw-attach only.
- **`s` (S holder):**
  - layout `network-hdd-nbd` in `holder.py`: validation with the placement pin and false-placement refusals, rendering,
    unit gating, and the network placement branch of preflight;
  - `storage_nbd.py`.
- **`p` (P L1 pair):**
  - `l1pair.py`: the network layout (l1 role only), with both node units gated on the supervisor;
  - S's files re-vendored, with pins in `VENDOR.json`.
- **Local layout preserved.** The local loop-image layout renders byte-identically to `92b71784` and `f8c999ed`. Unit
  tests assert this for both, cached and uncached.

## 2. Gap 1: storage/cache composition

- **One explicit network layout:**
  1. The transport attaches the authenticated export RAW (`/dev/nbd0` = l1, `/dev/nbd1` = base).
  2. `storage_nbd.py` verifies the attach and the pinned placement statement.
  3. Optionally, it puts dm-cache (writethrough, smq) ON THE RAW DEVICE.
  4. It then mounts the ONE filesystem from the top device. The bare mount point is created 0000.
- **Two writable views are impossible on the composed path:**
  - the tool refuses to map an origin that is mounted, or to mount over a held one;
  - the kernel refused a direct mount of the mapped origin (`Can't open blockdev`, measured).
- **Placement:**
  - The renderer pins the export host's placement statement by sha256, and refuses `requireRotational` ≠ true, a non-HDD
    filesystem type, a wrong export/size/path/role, and malformed fingerprints (unit-tested).
  - Preflight in the VM never uses the nbd rotational flag (measured 0). It requires instead:
    - the datadir resolving to exactly the configured origin, plus only non-rotational cache leaves;
    - the pinned statement;
    - a passing supervisor check.

  This is an operator-configured, authenticated statement by the export host, **not cryptographic proof of physical
  media**. There is no udev faking and no "any NBD".
- **Cache:**
  - **Opt-in**, through the ONE canonical ledger (`budget.py` admit/allocate/verify unchanged): a cap of
    250,000,000,000 B including metadata/temp/spill, and a 200 GB target, summed across hosts. The cache files are on
    the NVMe-class disk; there is zero authoritative data there.
  - **Reuse** needs a marker whose O_DIRECT origin superblock fingerprint still matches. A marker comes from `create`
    (empty cache), a clean `disassemble` (no supervisor failure and no new ext4 errors in the session), or `cache-loss`
    (metadata zeroed FIRST, then a read-only fsck).
  - **After a transport loss, or any uncached mount/write,** assemble refuses until `cache-loss` (measured).
  - **Known limit:** raw block writes that bypass a mount do not change the superblock. The rule is: if in doubt, run
    `cache-loss`.
- **No reformat or overwrite:** create needs `--first-format`, formats only a blank export once, and a second create is
  refused. No production file was allocated. A refused start never consumes the cache marker; the guest test found and
  fixed this ordering bug (run 3 → `fb9ce4a`).

## 3. Gap 2: runtime failure supervision

**The supervisor:** `hddwatch.py run` (Type=notify, Restart=no). It re-checks every 2 s:
- the owned attach daemon (pid + start time + argv);
- the dm table and status (cached);
- the mount and its source;
- the superblock read-only/`emergency_ro` state;
- the ext4 error counter;
- an O_DIRECT read of the raw origin with a 10 s bound.

The node units carry the generated `Requires=` + `BindsTo=` + `After=` on the watch, and `ReadWritePaths` only inside
the mounted filesystem.

**Sandbox:** `CapabilityBoundingSet=` (empty) for uncached; `CAP_SYS_ADMIN` only for dm ioctls when cached;
`DevicePolicy=closed` + `DeviceAllow=<nbd> r`; `ProtectSystem=strict`.

**Measured under real systemd 262 (run 4, `receipts/run4/`):**

| Event | l1 (uncached) | base (cached) |
|---|---|---|
| Export stopped by the host while the stand-ins were writing | stand-ins: EIO, then **EROFS**; superblock `rw,emergency_ro` while the mount was still listed `rw` | stand-in: EIO |
| What the supervisor saw | "ext4 … 1 new error" | "direct read of /dev/nbd1 failed: EIO" |
| systemd stopped every node unit after the stop request | 1.27 / 1.28 s | 1.01 s |
| Stand-in behaviour | logged errors and **kept running** | same |

- The stop came from the unit binding, not from the process; this proves supervision, not native-client behaviour.
  Real clients' reaction to EIO was not tested.
- **No automatic restart or resync:** the node units stayed inactive 5 s later.
- **Operator recovery:**
  1. stop storage (umount, and unmap when cached);
  2. stop attach (detach);
  3. refused while the export is down: the node start fails and the mount point stays bare and empty, with no fallback
     write to the VM disk;
  4. export back, then `cache-loss` (cached only);
  5. start.

  All fsynced stand-in data verified afterwards (l1: 10 and 9 files; base: 19).
- **Generated ordering:** stopping `enclave-rpc-hdd-attach@l1` stopped storage, watch and both node units (A7).
- **Foreign and role cases:** the l1 storage refuses the base attach (C1). An unpinned placement statement (C2), a
  foreign tmpfs on the mount point (C3) and a stray file in the bare mount point (C4) are refused. A foreign
  `qemu-nbd -c /dev/nbd2` is neither verified nor detached (C5). The transport's detach is refused while storage holds
  the device, both the dm mapping and the mount (C6).

**Corrected claim.** Earlier I recorded "ext4 stays listed rw, no read-only remount" (transport test). Both are true
observations: ext4 did NOT necessarily go read-only, and this run it did (`emergency_ro`, EROFS). The supervisor handles
either; neither is relied on.

## 4. Tests (all through `work/claude-test-queue.py`; receipts in `receipts/`)

| Job | What | Result |
|---|---|---|
| `unit-1` (256) | S `run-tests.sh holder` (existing 18/30/19) + new `test_network_layout` (4); P `test_l1pair` (20) + new (3) | all OK |
| `itest-1`..`itest-3` (1024) | development runs; each failure was a real finding | see §5 |
| **`itest-4`** (1024) | full composition, guest 39/39, host 16/16; queue peak 434 MiB RSS | **PASS** |
| `mutate-1` (1024) | control + 5 new-guard mutants (below) | control PASS; G1, G2, G3 killed; G4 survived as specified; G5 assessed |
| **`mutate-2`** (1024) | **final control on the FINAL commits** (guest 39/39, host 16/16, peak 139,022,336 B) + G4b | control PASS; **G4b killed at C4** |
| `unit-2` (256) | unit suites on the final commits | all OK (18/30/19 + 4; 20 + 3) |

**Mutants:**

| Mutant | What it removes | Outcome |
|---|---|---|
| G1 | `BindsTo=` on the watch | killed: both disconnect steps and everything after |
| G2 | the cache gate | killed: the uncached write was not detected (B3a) |
| G3 | detach's holder/mount refusals | killed: C6 |
| G4 | only the early non-empty check | survived its target C4, because the mount-time check still refuses. Its real effect (the cache marker consumed by a refused start) showed as C6 failing |
| G4b | both non-empty checks | killed at C4 (final commits) |
| G5 | the direct-read probe | still detected both losses through the ext4 error counter and the other checks. The probe is defence in depth for idle or cache-served cases, not proven necessary here |

**Allocation (temporary, actual, peak).** The `du` of the run directory was sampled every ~2 s and after the guest, before cleanup. Peak **136,429,568 B in run 4** and **139,022,336 B in the final control**, against the 512 MiB cap. After cleanup it was ~0.6 MB (logs only). The QEMU RSS peak was 353 MiB; queue tree RSS peaks were 434 MiB (run 4) and 457 MiB (mutate-2), within the 1024 MiB lane.

## 5. Findings during development (receipts kept)

- **Run 1.**
  - The capability-less supervisor could not `readlink /proc/<pid>/exe` of the root daemon (ptrace access check). It now
    identifies the daemon by pid + start time + argv, and is not granted CAP_SYS_PTRACE.
  - The test relay's traceback leaked into the NBD stream; it now closes silently.
- **Run 2.** In the supervisor's own `ProtectSystem=strict` namespace every mount reads `ro`. The read-only judgement now
  uses the superblock options.
- **Run 3.** A refused start (foreign mount) had already consumed the cache marker. Every mount-point refusal now runs
  before mapping.
- **Run 4.** ext4 reported `emergency_ro` while the mount was listed `rw`. The supervisor now treats that as fatal
  (`4bb7231`, final control in `mutate-2`).
- **Existing S/P unit defect, not fixed (P/B scope).** systemd 262 logs `Unknown key 'StartLimitIntervalSec' in section
  [Service], ignoring` for the node units, so the intended start-rate limit is not applied as written.
- **Fixture artifacts, not production behaviour:**
  - host `/usr` over 9p makes setuid mount/umount run as the host user, so root-owned copies are bound over them in the
    guest;
  - no udev trigger, and the guest has no `/var/lock`.

## 6. Limits that remain separate gates

- **Untested platforms and versions:**
  - the real NucBox Hyper-V Linux VM and its flush semantics;
  - ntfs3 on the TR-004 USB RAID5 behind qemu-nbd;
  - 1 GbE throughput;
  - the Ubuntu noble qemu-utils (8.2) client vs the tested 11.1.2.
- **Untested behaviour:** real node clients, physical power loss of the enclosure or desktop, and a full-size cache.
- **Capacity:** NucBox memory (placement plan d429ef2d) and the RAM-96 restart that is awaiting approval are unchanged.
- **D1 is still open:** the HDD-only vendor support.
- **Full-chain sync was not started.**
- **Rollback:** nothing is installed. The local layout is unchanged; configs that keep `loop-ext4-image` render
  byte-identically.
