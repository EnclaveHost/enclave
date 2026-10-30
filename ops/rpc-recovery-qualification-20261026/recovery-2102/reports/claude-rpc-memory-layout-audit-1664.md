# RPC backend memory layout audit (1664): source/read-only, no resource actions

## Scope and limits
**What I did:** read local files only. The production VM was OFF and USB writes were paused; I did not read USB.
- **No changes:** no tests, builds, VM start, or app or manifest changes.
- **Unchanged:** the original 64 GiB manifest, admin controls and the 16 GiB floor.
- **The task stopped at its turn limit before reaching the official client documentation.** No official-doc requirement is cited; everything marked **[REC]** is my recommendation, not verified fact.

**Marking:** **[FILE]** = verified in a local file, cited by path and line. **[OBS]** = a recorded guest observation (local snapshot files). **[REC]** = recommendation / unverified.

## 1. What the 64 GiB is made of [FILE]
**`/home/steven/.local/state/enclave-rpc-production/manifest.json`** (sha256 `a28432151c9a24bd…` now; `vm-verified.json` recorded `ecbe7b65…` before the 22:39 base-disk growth):
- `vm.guestMemBytes` 68,719,476,736 (64 GiB);
- `memoryMaxBytes` 70,866,960,384 (64 + 2 GiB QEMU);
- `hostReserveBytes` 17,179,869,184 (16 GiB);
- 8 vCPUs.

**`provision_vm.py`:**
- `:73` `GUEST_MEM = 64*GIB`, `:74` `MEMORY_MAX = GUEST_MEM + 2*GIB`, `:75` `HOST_RESERVE = 16*GIB`;
- **the launch is refused unless MemAvailable ≥ 66 + 16 GiB** (`:194-196`);
- `memory-backend-ram … prealloc=on` (`:292`): **all 64 GiB is touched at start**, so it is held regardless of client use.
- **No comment justifies 64 GiB** as a client requirement.

**`stage_node_units.py:28`, the per-service systemd ceilings inside the guest** (`MemoryMax`, `MemoryHigh` = 0.9×, `MemorySwapMax=0`):

| unit | client [FILE] | MemoryMax |
|---|---|---|
| `enclave-l1-el` | reth **v2.8.0** (`chain_service.py:124-132`; version strings in logs) | **16 G** |
| `enclave-l1-cl` | Lighthouse **v8.3.2** (`chain_service.py:59`, `:134-138`; `--target-peers 100 --semi-supernode --prune-blobs`) | **10 G** |
| `enclave-base-holder` | `base … rpc` (`chain_service.py:157-167`): Base **v1.5.1**, built from reth `base-v2.5.2.8` (#7134be3b, from the build log in `sync-0010/guest.out`); **not Erigon** (see 370's `logs/claude-mdbx-validator-1661.md`) | **28 G** |

So the "≈ 60 GiB of clients" is **16 + 10 + 28 = 54 GiB of configured ceilings** plus guest OS headroom inside 64 GiB. **These are author-chosen caps, not measured needs.**

**Cache controls actually set [FILE]:**
- **No database-cache flags at all:** no reth `--db.*` cache size, no Lighthouse cache flags.
- **QEMU:** disk `cache.direct=false` (host page cache), and `nvme.cacheBytes 0`.
- **L1 reth:** uses the snapshot's `reth.toml` prune profile (`chain_service.py:108-123`), plus `--prune.transaction-lookup.distance 140000` and `--rpc.max-connections 64`.
- **Base:** `--rpc.eth-proof-window 1800`, `--rpc.max-connections 64`, the same transaction-lookup prune distance.
- **MDBX is memory-mapped:** under cgroup v2 its file pages count toward `MemoryCurrent`, but they are reclaimable. `MemoryMax`/`MemoryHigh` therefore limit page cache and throttle; they do not reserve RAM.

## 2. What was actually observed [OBS]
These are 22 guest snapshots, `outputs/rpc-production-final-20261025/sync-*/guest.out` (2026-10-25 22:41 → 2026-10-26 05:02).
- **What was running:** L1 reth + Lighthouse active, plus the Base **snapshot downloader** (`enclave-rpc-base-snapshot`). **`enclave-base-holder` was inactive** (`sync-0413`).
- **Guest `free -m`:**

  | used (MiB) | buff/cache (MiB) | available (MiB) |
  |---|---|---|
  | 11,047–12,652 | ≈ 35.6–49.6 k | ≈ 51.6–53.3 k |

  The guest's `MemTotal` is 64,302 MiB.
- **One unit's `MemoryCurrent`:** 2.3–4.3 GB.
- **L1 health at 05:02** (`sync-post-trim-0501/l1-health.json`):
  - head `0x190eb51` (block 26,274,641);
  - finalized `0x190eafc`;
  - CL `is_syncing false`, `is_optimistic false`, sync distance 1.
- **Not measured, ever:**
  - the Base node (reth/Base) running RPC, proofs or sync;
  - any concurrent proof or RPC serving load;
  - per-process RSS under load.

**Meaning:** with L1 synced plus a downloader, the processes needed about 11-12.6 GiB. The rest was reclaimable cache. The memory for a running Base node is **unknown**.

## 3. Current cached state (local metadata only)
- **L1:**
  - `l1-origin.qcow2` sits on NVMe `/vm` (manifest `disks.l1.backing: nvme`), 4 TB virtual;
  - it was synced at the 05:02 observation, and the VM has been OFF since ≈ 09:00;
  - on restart it must catch up the gap; the duration is unmeasured.
- **Base:**
  - the state DB was deleted (`mdbx.dat`, recovery under separate assessment);
  - the download checkpoint holds 122,742,112,256 of 761,228,785,915 B (≈ 16.1%), with 22 history archives (256,149,630,611 B) still needed (HANDOFF);
  - the USB pause stopped root 1562.
  - **There is no usable Base node today.**
- **Consensus:** Lighthouse data is on the L1 pair volume, last observed synced (as above).

## 4. Capacity facts given by root/user (not re-measured by me)
- the desktop has ≈ 24 GiB available;
- the NUC has ≈ 17 GiB free after native 32 + legacy apps;
- the 16 GiB floor applies on both;
- the old desktop Qwen `gdf8abad99…` (≈ 64,281 MiB) must stay.

**Conclusion:** the unchanged 64 GiB VM (66 GiB + 16 GiB floor needed at start, preallocated) **does not fit** either host now. **I make no new capacity arithmetic claims.**

## 5. Hard requirements vs tunables
- **Hard (from code/policy) [FILE]:**
  - the 16 GiB host floor (`provision_vm.py` refuse; queue guard);
  - pinned binaries (`chain_service.py:35-39`);
  - L1 must be synced before Base (`chain_service.py:59-69` asserts);
  - Base depends on L1 EL+CL RPC (`--l1-eth-rpc`, `--l1-beacon`);
  - no public execution RPC.
- **Tunable (configuration, not requirements) [FILE]:**
  - the guest size and `prealloc=on`;
  - the per-unit `MemoryMax` 16/10/28 G;
  - `--target-peers 100`, `--rpc.max-connections 64`;
  - `--rpc.eth-proof-window 1800`;
  - the semi-supernode / blob settings.
- **Unknown:**
  - the real minimum RAM of each client under real sync and proof serving;
  - whether lower ceilings cause throttling, OOM or slow sync.

**Can the source support a bounded lower deployment? Yes, mechanically.** The sizes are constants and unit fields, so a reviewed new manifest or stage could set lower values. **Whether it works is unproven until measured.** No lowered value is declared successful here.

## 6. Options that keep all apps and the 16 GiB floor [REC]
| option | idea | risk / what it needs |
|---|---|---|
| **A. Split L1 from Base** | L1 EL+CL first, then Base separately with its own ceiling, possibly on another host | Needs a reviewed new manifest/stage (the original stays unchanged) and a cross-host L1 RPC path. Base RAM is unmeasured. |
| **B. Smaller single VM without prealloc** | lower guest RAM; drop `prealloc=on` so unused RAM is not pinned | Host MemAvailable then varies with guest page cache, so it needs a host-side floor guard while it runs. |
| **C. Schedule** | run the RPC VM only when apps can be paused by agreement | The user authorized some app downtime **with KVM coordination**; Qwen and the existing deployments are kept. |

**Not acceptable:** relaxing the 16 GiB floor; retiring Qwen; public RPC fallback as a substitute.

## 7. Memory qualification plan [REC]: measure, don't assume
**Gate:** run only after a reviewed lower-memory manifest exists (a new file; the original stays untouched) and with root's guard.

**Record every 10 s:**
- host `MemAvailable`, plus the VM cgroup `memory.current` and `memory.peak`;
- guest per-unit `MemoryCurrent`/`memory.peak`, process RSS (anon vs file), PSI memory pressure, OOM and throttle events.

**Phases, each with an abort when host MemAvailable < 16 GiB + margin:**
1. **L1 catch-up** from the 05:02 state to head.
2. **L1 steady state.**
3. **Base sync** (after its data exists).
4. **Base RPC + `eth_getProof`** at the real 1800-block window under concurrency up to the configured 64 connections.
5. **A 24 h soak.**

**Pass criteria:**
- peak anonymous RSS per unit, plus margin, ≤ its new ceiling;
- no OOM and no sustained `memory.high` throttling;
- sync rate not degraded beyond an agreed bound;
- host floor never crossed.

**Results:** report the measured peaks; only then choose the sizes.

## 8. What still needs resources, the user, or a schedule
- **Base data:** the re-download (≈ 639 GB remaining) or a recovery outcome, both blocked by the USB pause and space (`/` ≈ 156 GiB available at 20:25 per HANDOFF).
- **Host RAM window:** a window with enough MemAvailable for the qualification runs. That needs a user/KVM-agreed schedule, or Option A on separate hosts.
- **A reviewed lower-memory manifest/stage:** not written here, by request.
- **Base node memory measurement:** never done (§2), so no Base RAM figure exists.
