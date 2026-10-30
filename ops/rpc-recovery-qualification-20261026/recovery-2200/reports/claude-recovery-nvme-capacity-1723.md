# 1723: NVMe capacity for a sequential copy of the restored `mdbx.dat`. Source and read-only metadata only

**Conclusion: IT DOES NOT FIT,** not even after every currently verified and authorized reclaim. No authorized cold original exists that frees ≥ 1.16 TB on one filesystem.

**What I did not do:** deletions, copies, mounts, sudo, SSH, production actions, or new frameworks. The live recovery probe (root 1720, until about 22:13) and the original were not touched.

**Read-only facts I used:**
- `df`, `lsblk`, `ls`;
- one bounded `du -d2/-d3` of `/vm` metadata;
- the receipts and logs named below.

**The large-file `find` (> 50 GB over `/vm` and `/home/steven`):** it was stopped at its 240 s bound ("[killed]") with **no file lines collected**, so that inventory is **PENDING**. It was not restarted, as instructed.

## Size required
**The restored file** (root 1658 map, plan 1706):
- logical 1,138,166,333,440 B;
- mapped data 1,134,426,345,472 B (276,959,557 × 4 KiB);
- a 3.74 GB sparse tail (holes).

**A sparse-aware sequential copy writes about 1,134.43 GB.** With ext4 metadata and a safety margin, plan for **≥ 1,160 GB free on ONE filesystem**: a single file cannot span `/vm` and `/`.

**Compression:** the ratio is **unknown and not assumed**. The validator `mmap`s the raw file, so a compressed copy would not help it anyway.

## Capacity now (root's latest, 21:51) and after the authorized reclaim
| filesystem | device | free now | + verified, authorized reclaim | best case |
|---|---|---|---|---|
| `/vm` | T710 `nvme0n1` (`cryptvm`) | **≈ 60 GiB** (64.4 GB; my 14:5x read was 113.19 GB; peer copies continue) | **+ 327,902,572,680 B** (the three cold originals) | **≈ 392 GB** |
| `/` | T500 `nvme1n1` (`cryptroot`) | **≈ 47 GiB** (50.5 GB; it holds the verified cold copies) | none (the copies stay there) | ≈ 50 GB |

**Shortfall on `/vm` even after the full cold reclaim:** ≈ **1,160 − 392 ≈ 768 GB**. If peer copies continue, it gets worse.

## The existing reclaim path: what supports it, and what is missing
- **The verified copies:** `logs/cold-copies-verified-1597.json` (root job 1579, rc 0).

  | subtree | bytes |
  |---|---|
  | `gguf-e2b` | 43,957,352,504 |
  | `gvs5h` | 125,195,719,424 |
  | `hf-convert` | 158,749,500,752 |
  | **total** | **327,902,572,680** |

  Each copy is verified (source, dest and logical identities); `cutover: false` for all three; `originalsRetained: true`; `reclaimedBytes: 0`; `usbWritesPaused: true`.
- **The authority:** `logs/cold-subtree-production-1530.json`, whose `subtrees` are exactly these three under `archive_root /vm/enclave-volumes/codex-archive` and whose `dest_root` is `/home/steven/.cold-archive/codex-archive`.
- **The reclaim tool:** `nvme-cold-reclaim-stage/r4` (SUMS `06cf9fd2…`, `logs/claude-cold-reclaim-r4.md`; root 1587 tests).
  - **Its scope** is exactly the three `.retire-*` originals, **each only after its r10 cut-over is `complete`**.
  - **It needs** a fresh r10 root writer-check (complete, no hits and no aliases) and a `confirm` re-hash.
- **The missing step (root owns the ask; I am not asking the user again):** the r10 **root read-only writer-check** requires the **user's local sudo**: `logs/claude-cold-scan-handoff-1595.md`, with the cold-scan v3 tests at 8 PASS. Then come the owner's record, the cut-over (the strong manual gate from root 1588: no `destAliases`/`fsWatchers`) and reclaim r4.
- **None of this has happened:** no cut-over, no reclaim.
- **Even completed, it frees only 327.9 GB.**

## Other holdings on `/vm` (GiB, from `du`): none is an authorized cold source
| path | GiB | status (from existing records; nothing declared cold by me) |
|---|---|---|
| `.pixel10/tensor-sdk` | 998 | **not authorized.** 1323/1510 and the NVMe capacity review describe a Sept project tree (163k files, hardlinks, 76 git repos, worktrees, inbound symlinks), to be moved **only as a verified tar to USB if its owner confirms it is cold**. USB writes are paused and no confirmation exists. **Missing authority:** the owner's explicit cold confirmation plus a disposition (a verified relocation target, or an explicit delete-without-copy decision). |
| `codex-archive` (other than the three) | ≈ 615 | **live backing store** (1510: 2,102 symlinks resolve into it): `home/Projects` 274 (includes the active `Projects/enclave`), `2026-09-04/lo` 182, `2026-09-07/i-w` 157. 1510 names `2026-09-07/i-w/work` + `hf-convert` (≈ 326.7 GB) only as a *fallback* under the same checks. There is no copy, and there is no room on `/` for one. |
| `rpc-production` (`l1-origin.qcow2` 528 GB, `os.qcow2` 18.6 GB) | 448 | the **production RPC VM's disks** (boot paused, **not cold**): the fallback, keep |
| `.shield-pads` (`*.padbank` 206 GB + 550 GB sparse) | 292 | **live** (modified 14:47 today) |
| `tr004-preservation-20261026` | 135 | the preserved TR004 recovery images: **backup work, keep** |
| `warden.qcow2` 67 GB; Ubuntu ISO 3.2 GB | 66 | a VM disk and an installer: **status unknown, not declared cold** |
| `qwen*/fable*/gemma*` model dirs | ≈ 290 total | model stores, **not authorized** for removal (no receipt) |

**Base archive and checkpoint holdings:** none identified beyond the RPC VM disks above. The `> 50 GB` inventory is **PENDING** (the search was stopped). No fallback was removed or proposed for removal.

## Answer and options (no action taken)
1. **No existing, safe, user-authorized cold originals can reclaim ≥ 1.14 TB** with the existing verified guards. The maximum is **327.9 GB**, which is gated on the pending local-sudo writer-check, then cut-over, then reclaim r4.
2. **A copy on `/vm` would need about 768 GB more** from sources that are not authorized today. The only single source large enough is `.pixel10` (≈ 1.07 TB).
   - **That needs:** the owner's explicit cold confirmation **and** a disposition decision. With USB writes paused, that means either deletion without a copy (the user's call alone) or waiting for USB writes to resume, then a verified tar to USB, then reclaim.
   - **Root owns that request.**
3. **Until then:** the read-only overlay view (r9, live) is the only full-validation path. The probe's throughput (about 53 MB of FUSE output in the first 150 s; provisional, not a full ETA) decides whether a bounded full run is worthwhile. **Do not start a large copy.**
