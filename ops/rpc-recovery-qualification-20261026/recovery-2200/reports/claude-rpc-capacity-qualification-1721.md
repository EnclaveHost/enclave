# RPC capacity qualification (1721): source and read-only findings; no files prepared

**Status:** this report is the only file written. There is no harness, launcher, manifest or unit. Nothing was run, built, tested, copied, or reached over SSH. The original manifest, launcher and units are untouched. **No capacity success is claimed, and there is no public-RPC fallback.**

## 1. Sources read (read-only)
| what | path | sha256 |
|---|---|---|
| original manifest (64 GiB) | `~/.local/state/enclave-rpc-production/manifest.json` | `a28432151c9a24bd207d9adaab401ca4e24a9cdc39807489f12c3000b0936441` |
| deployed launcher (pinned by the manifest `files.launcher`) | `~/.local/state/enclave-rpc-production/provision_vm.py` | `38f8dc891bfa9f5f74fcd8eb4ba50ea6f5f70342c49e3c7e2944a10c504436d7` |
| guest unit generator | `work/rpc-production-final-20261025/stage_node_units.py` | `6067edda3acc7126deb7ee91b4f0d783ca4e07302a91ad7068330d41cc5b1589` |
| chain service (client argv) | `work/rpc-production-final-20261025/chain_service.py` | `6d93c8b76fc4d26fe4ca69b2d722a727e6dfe42571134a1a3b06057fdc0e4b9e` |
| reth v2.8.0 `node --help` (commit `05ba4812…`; binary `8cdd1f35…`) | `work/rpc-hdd-storage-compose-20261023/p/evidence/reth-help-20261023T061904Z/node-help.txt` | `a13c6de2…` |
| Lighthouse v8.3.2 `bn --help` (binary `11b7bca8…`) | `…/p/evidence/lighthouse-help-20261023T080333Z/bn-help.txt` | `314b685a…` |
| versioned docs fetched at the pinned commits (`sha256sum -c` OK today) | `…/p/evidence/sources/{reth-v2.8.0,lighthouse-v8.3.2}` | `SHA256SUMS` |
| prior audit | `logs/claude-rpc-memory-layout-audit-1664.md` | |
| existing snapshot job (a pattern to reuse) | `jobs/root-live-health-0400.py` | `edbc01e1aa4998c9b8d0263abcc4bf62e2169f09f35ca6355a63f781990ebb48` |

## 2. Configured ceilings vs documented requirements vs observed

| component | configured (file) | documented minimum / recommendation (versioned doc) | observed |
|---|---|---|---|
| VM | 64 GiB guest, `prealloc=on`, unit `MemoryMax` 66 GiB; **launch refuses unless MemAvailable ≥ 66 + 16 GiB** (`provision_vm.py:73-75, 193-197, 292`) | none | the guest filled RAM with page cache: 11.0–12.7 GiB used plus 35–49 GiB buff/cache (1664 §2) |
| L1 EL reth v2.8.0 | `MemoryMax` 16G (`stage_node_units.py:28`) | reth `docs/.../run/system-requirements.mdx`, Ethereum mainnet: **archive 16GB+, full 8GB+**; "recommended at least 16GB"; RAM mainly helps caching | L1 EL+CL plus the Base downloader used **11.0–12.7 GiB** in total (no per-process RSS) |
| L1 CL Lighthouse v8.3.2 | `MemoryMax` 10G | `book/src/installation.md`: **32 GB RAM** for the node; "16 GB … likely result in out of memory errors" during spikes or non-finality | (included in the 11.0–12.7 GiB above) |
| Base holder (base v1.5.1, built from reth `base-v2.5.2.8`) | `MemoryMax` 28G | same reth doc, Base mainnet **minimum 128GB+ (archive and full)**, plus 5+ cores | **never run or measured** |

**Hard requirements:**
- the 16 GiB host floor;
- the pinned binaries;
- L1 synced before Base (`chain_service.py:59-69`);
- no public RPC.

**Not hard requirements:** 64 GiB, `prealloc`, and the 16/10/28G ceilings are author-chosen settings.

**Key decoupling fact:** the only versioned primary source for Base says **≥ 128 GB**. That is above the entire 64 GiB VM, not just the 28G ceiling. The figure comes from the reth v2.8.0 docs; Base's own docs for v1.5.1 are not available locally. Any Base deployment below 128 GB is below the documented minimum and could only be justified by measurement. **Base also has no data today** (state DB deleted, recovery pending, download paused).

## 3. Resource constraints today (figures from root/user, not re-measured)
- **Desktop:** about 24 GiB available. Minus the 16 GiB floor, at most about **8 GiB** is left for any VM including QEMU overhead. **L1 alone was observed at 11–12.7 GiB used, so nothing fits without freeing memory** (Qwen must stay).
- **NUC:** about 17 GiB free, about 1 GiB above the floor. **Does not fit.**
- **Conclusion: no candidate can run on either host now.** Every option below needs a user/KVM-agreed memory window (apps paused by agreement), or more RAM.

## 4. Structural constraints found in the source (they block a "just lower the number" change)
1. **The guest size is hard-coded, not taken from the manifest.**
   - `GUEST_MEM`, `MEMORY_MAX`, `HOST_RESERVE` and `VCPUS` are module constants (`provision_vm.py:72-76`).
   - The manifest pins the launcher sha (`files.launcher`) and the QEMU argv sha (`files.qemuArgv`, checked at `:858` and in `cmd_launch`).
   - The unit file renders `MemoryMax={MEMORY_MAX}` (`:571`), and launch refuses unless the unit cgroup equals `MEMORY_MAX` (`:874`).
   - **So any smaller guest requires a new reviewed launcher and a new manifest.** Editing the original is not allowed; it is preserved.
2. **`NAME`, the state dir, the unit names and the ports are fixed constants** (`:57-61, 83-89`). A variant must use a different `NAME` (separate state dir and unit) and must never run concurrently with the original; `check_ports` refuses busy ports anyway.
3. **The VM always attaches `base-origin.qcow2`** (the `DISK_ROLES` loop, `:306-312`; manifest `disks.base`). **Booting the current VM, or any copy of it, would open the original under recovery read-write.** The candidate must drop the base disk.
4. **`prepare` (v1) creates its images on `/mnt/usb`, so it is blocked by the USB pause.** v2 manifests are written only by the migration adapter. **There is no existing supported command that writes a variant manifest.** Root would need a small reviewed adapter, analogous to the migration adapter.
5. **The existing guard watches NVMe free space only, not host memory.** The only memory check is at launch, and a clean stop can take up to 38 min (`TimeoutStopSec=2400`).

## 5. The selected candidate: C1, an L1-only qualification VM (SPLIT; Base deferred)
This is the only candidate that the docs, the observations and the data state together allow measuring now.

**Proposed config diff vs the deployed launcher `38f8dc89…`.** Written as a new copy with a new name; the original is untouched.
```
NAME       = 'enclave-rpc-production'   ->  'enclave-rpc-l1qual'   (separate state dir / unit / runtime dir)
GUEST_MEM  = 64 * GIB                   ->  32 * GIB
MEMORY_MAX = GUEST_MEM + 2 * GIB           (unchanged formula -> 34 GiB)
HOST_RESERVE = 16 * GIB                    (UNCHANGED; check_memory unchanged -> launch needs MemAvailable >= 50 GiB)
VCPUS      = 8                             (unchanged)
DISK_ROLES : l1 + base                  ->  l1 only  (base-origin.qcow2 never attached)
prealloc=on                                (KEPT, see below)
```

**The guest side needs no change for L1.** The existing EL 16G and CL 10G ceilings sum to 26G, below a 32 GiB guest. The Base holder and the Base snapshot downloader must stay inactive.

**Why 32 GiB:**
- it is Lighthouse v8.3.2's documented node recommendation, and it covers reth's recommended 16GB;
- 24 GiB would sit below Lighthouse's recommendation. Consider it only if C1's measured peaks justify it.

**Why keep `prealloc=on`, rejecting a non-preallocated guest for now:**
- the guest was observed filling RAM with page cache (35–49 GiB), so a non-preallocated guest would converge to nearly its full size anyway;
- with `prealloc`, the launch-time floor check (≥ guest + 2 + 16 GiB) covers the whole VM footprint;
- without it, the VM erodes the floor *after* admission, and nothing watches host memory at runtime (§4.5).

**Reservation:**
- **at least 50 GiB of host MemAvailable at launch** (34 VM + 16 floor), plus a margin for other apps' growth during the run;
- the desktop needs about 26 GiB more than today, which requires user/KVM coordination.

**Rollback:**
- stop and disable the variant unit, then remove its unit file and state dir;
- the original manifest, launcher, unit and disks are unchanged, though the L1 qcow2 will have advanced its chain state, which is expected.

**Root must verify before using C1** (I have not verified these):
- **a)** `check_images` does not pin mtime/size/sha of `l1-origin.qcow2` or `os.qcow2` in a way the variant run would break for the original manifest;
- **b)** the guest fstab/cloud-init mount of `enc-base-origin` is `nofail`. Otherwise a guest without the base disk may enter emergency mode. Fix it in the variant seed, never in the original;
- **c)** `enclave-rpc-base-snapshot` and `enclave-base-holder` cannot start (downloads are paused);
- **d)** NVMe headroom for L1 catch-up growth. **Worker 50's NVMe space audit owns this; it is not duplicated here.**

## 6. Measurement plan for C1 (root implements later if justified; nothing written)
**Reuse the `root-live-health-0400.py` pattern** (one SSH snapshot command plus host placement). Do not create a new service.

**Host, every 10 s, read-only:**
- `/proc/meminfo` MemAvailable;
- the variant unit cgroup `memory.current`, `memory.peak` and `memory.events`;
- `/proc/pressure/memory`.

**Floor action:**
- if MemAvailable < 16 GiB + 4 GiB margin, run `systemctl --user stop enclave-rpc-l1qual-vm` (ACPI powerdown);
- if MemAvailable < 16 GiB + 1 GiB, QMP `stop` (pause) first. **The floor is host MemAvailable, not guest RAM.**

**Guest, every 60 s (SSH by root):**
- `systemctl show enclave-l1-el enclave-l1-cl -p MemoryCurrent -p MemoryPeak -p NRestarts`;
- `/proc/pressure/memory`;
- `free -m`;
- the OOM count from `journalctl -k`;
- reth/Lighthouse process RSS (`/proc/<pid>/status` VmRSS, RssAnon, RssFile);
- L1 health exactly as in `chain_service.l1_ready()`.

**Phases** (each aborts on the floor action):
1. L1 catch-up from the 2026-10-26 05:02 state (head 26,274,641) to head;
2. 6 h steady state;
3. local L1 RPC plus beacon blob load at the configured `--rpc.max-connections 64`;
4. a 24 h soak.

**PASS (all required):**
- `l1_ready()` true at the end of phases 2–4;
- 0 OOM kills and 0 unit restarts;
- no sustained `MemoryHigh` throttling (memory.events `high` not increasing over 10 min intervals);
- per-unit peak RssAnon + 25 % ≤ its `MemoryMax`;
- the host never below 16 GiB.

**Output:** the measured peaks. **Only then** choose final sizes; a smaller guest would be a further reviewed variant.

## 7. Base: not qualifiable now
- **Blockers:** there is no Base data, and the documented minimum is **≥ 128 GB**.
- **Options:**
  - a host with ≥ 128 GB available above the floor;
  - **or** an explicit user decision to *measure* Base below its documented minimum on a split host, after L1 passes, with the same harness, an L1 RPC path across hosts, and the floor action.
- **No cutover** until the actual Base sync, `eth_getProof` load at the 1800-block window, and the 24 h soak all PASS.

## 8. Next human/root decisions
1. **A memory window:** a user/KVM-agreed window with ≥ 50 GiB MemAvailable on one host for C1 (after the recovery probe ends, about 22:13 UTC, and with VM boot unpaused).
2. **If approved:** root writes and reviews the variant launcher, its manifest adapter and the harness (§4–6), after checks 5a–5d.
3. **The Base path decision** (§7).
