# Retention job 1394: `.part` resume semantics and the actual throughput bottleneck (read-only, 2026-10-26 ~15:20–15:35 UTC)

**Scope: read-only.**
- **Pinned reth source:** `~/.cargo/git/checkouts/reth-babcd6134566c621/7134be3/crates/cli/commands/src/download/` and `crates/cli/runner`.
- **Controller source:** `retention-live-controller-stage/r3/retention-live-controller.sh`.
- **Guest unit:** `base-retention-stage/activation-r2/enclave-base-retention.service` and `retention_activate.sh`.
- **Live observations:**
  - two 10 s counter samples (guest, then host) plus 2 × 5 s host rx samples;
  - `ss -tnpi` socket state for PID 110490 on the guest and for QEMU PID 3695222 on the host;
  - `/proc` reads and bounded `journalctl` greps;
  - the names (not values) of proxy variables.

**Not done:** no downloads, benchmarks, ping or other network tests, hashing, DB opens, tuning or stops. No credential or key material was read.

**Snapshot download is not readiness.**

## 1. EARLY FINDING: nothing survives a stop for an in-flight archive. The controller's "resumable" label is wrong for `state`

**Segmented `.part` semantics in reth 7134be3** (`fetch.rs`):
- Any archive larger than the segmented minimum, fetched from a server that supports Range requests (the state archive, 761,228,785,915 bytes, from `mainnet-v2-snapshots.base.org` qualifies), uses `SegmentedDownload::run`.
- That path is always taken in modular mode, because `run_modular_downloads` always installs a `DownloadRequestLimiter` (`archive.rs:44`). Legacy `--url` mode installs one too (`mod.rs:~512`).
- **Start (`fetch.rs:578-582`):** `fs::create_file(part_path)` (create **or truncate**) then `set_len(total_size)`. Any existing `.part` is truncated to zero, then re-extended as a sparse file.
- **No persisted progress:** the piece queue is an in-memory `VecDeque` (`SegmentedDownloadState`). There is no map, bitmap or per-piece digest on disk, and the manifest has no compressed-archive digest at all.
- **Graceful stop** (`systemctl stop` → SIGTERM; reth's runner cancels on SIGINT/SIGTERM, `runner/src/lib.rs:253-259`):
  1. Each in-flight piece observes cancellation and returns `PieceAttemptFailure::Terminal("Download cancelled")` (`fetch.rs:787-788`).
  2. `run()` sees the terminal failure and calls `paths.cleanup_partial()`, which **deletes the `.part`** (`fetch.rs` run, `cleanup_partial` at 93-96).
  3. The cached path also calls `fetcher.cleanup_downloaded_files()` on any error (`archive.rs:263`).
  4. Result: **every in-flight archive's downloaded bytes are deleted.**
- **Abrupt kill** (SIGKILL, including systemd's escalation after `TimeoutStopSec=120`): the sparse `.part` stays on disk with unknown holes. It cannot be resumed, because the next run's `create_file` truncates it.
- **What is preserved across any stop:** only archives that completed download, extraction **and** output verification. The next run reuses them through `OutputVerifier`, and only if the next run uses the **same manifest and selections**: the same `--manifest-path` (sha `1f0c4e6c…`) and the same `--with-*` floors. A different floor changes the planned set.
- **Sequential Range resume** (`download_sequential`, which resumes from the `.part` length) is reached only when the server lacks Range support or the file is too small. Neither applies here. **`--resumable=true` therefore gives no cross-run resume for this job.**

**Controller semantics** (`retention-live-controller.sh`):
- `deadline = start_t + MAXH*3600` (line 148). With start at 14:58:24 that is **20:58:24 UTC**.
- At the deadline: `fail "...--max-hours=6 reached: stopping our invocation (resumable)" 7` (line 151), then the EXIT trap, then `stop_own`, then `retention_activate.sh stop` (SIGTERM, then SIGKILL after 120 s).
- The memory watchdog (USR1 when host MemAvailable < 16 GiB) takes the same path. Host MemAvailable was about 21.5 GiB (`memory.txt`), so the margin is about 5.5 GiB.
- It stops only its own InvocationID. It never adopts or stops a foreign unit (lines 60-71, 94-96). Good.
- **The unit itself has no runtime limit:** `TimeoutStartSec=infinity`, no `RuntimeMaxSec`, `KillMode=control-group`, `TimeoutStopSec=120`.
- **Consequence:** at 20:58 the state archive will not be finished (see §2). Its `.part` is deleted on stop, so all state bytes fetched by then are lost. The "(resumable)" wording in the controller and in `retention_activate.sh stop` ("re-run start to resume") holds only for completed archives.
- **Also note for the terminal validation:** the controller asserts `archives == 26` in the marker (line ~190). The CLI's actual plan is 30 chunked archives plus `state` (selection audit). Review that before relying on this controller's SUCCESS path.

## 2. Actual bottleneck: the WAN path upstream of this host is saturated (evidence), not disk, CPU, SLIRP or reth concurrency

**Topology (observed):**
- The guest is QEMU PID 3695222 **on this host**: SSH alias `127.0.0.1:22850` is a QEMU `hostfwd`.
- **Network:** `-netdev user` (SLIRP), guest `10.0.2.15` via `10.0.2.2`, virtio-net. This host's uplink is a USB NIC, `enp162s0u1u3`, at 1000 Mb/s.
- **Data disk:** guest `/dev/sdc` (ext4) = `-blockdev qcow2 /mnt/usb/enclave-rpc-production/base-origin.qcow2` on host `/dev/sda2` (ntfs3, USB RAID), `cache.direct=false`, `aio=threads`.

**Samples at about 15:23–15:35 UTC:**

| layer | measurement | reading |
|---|---|---|
| guest NIC enp0s3 | rx 19.4 MB/s (≈155 Mbit/s), tx 0.56 MB/s | |
| downloader PID 110490 | write_bytes 17.2 MB/s; CPU 0.11 cores (cgroup and proc agree) | not CPU-bound |
| guest disk sdc | write 46.9 MB/s at 34% busy; iowait 4%; PSI io some 13% | not disk-bound (bursty writeback; host flushes later) |
| guest CPU | 91% idle (8 vCPU); MemAvailable 51.5 GiB; cgroup `memory.max` 4 GiB | idle |
| guest sockets | 9 TCP connections to Cloudflare (104.18.40.153, 172.64.147.103), RTT ≈ 0.07 ms | sockets end at local SLIRP: the guest side is not the limit |
| QEMU process | main loop (SLIRP) thread 41% of one core; vCPU threads < 5% | SLIRP not saturated |
| QEMU's host sockets to the CDN | 8 connections, **minrtt 15–23 ms but smoothed RTT 58–69 ms**; rcv_wnd 3.7–19 MB; bytes_received about 0.4–1.8 GB each | **≈40+ ms of queueing under load: a saturated link upstream.** Open windows rule out window/buffer limits (7.7 MB / 60 ms ≈ 128 MB/s per connection possible). |
| host NIC enp162s0u1u3 | rx 19.0 / 19 / 18 MB/s over 10 s + 5 s + 5 s; tx 1.3 MB/s | the whole host inbound load; the 1 Gb/s NIC itself is not full |
| host disk, CPU | sda (USB RAID) 5.7 MB/s at 8% busy (bursty); CPU 90% idle; PSI io some 1% | not the limit |
| throttling | 0 journal lines matching throttl/retry/429/503/timed out since 15:15:41; no proxy variables set on the downloader | no CDN throttling observed |

**Conclusion:**
- Aggregate throughput (≈18–19.4 MB/s ≈ 150–155 Mbit/s) is capped by **the access path between this host and Cloudflare** (ISP or upstream link). The evidence is RTT inflation with open windows and an otherwise idle machine.
- Whether that is a line-rate cap or ISP shaping cannot be told without network tests, which were not done.
- **No evidence-backed speed fix exists inside the host, the guest or reth:**
  - more concurrency would only deepen the queue on a saturated link;
  - SLIRP, disk and CPU have headroom.
- A faster or less-loaded uplink is the only lever; that is not a configuration change. Side effect: this queueing also adds about 40 ms to everything else on this host's uplink.

**Pending bytes and ETA** (the log's ETA counts reused bytes and is misleading):
- **Pending compressed at 15:15:40:** state 761,228,785,915 + 22 history archives 256,149,630,611 = **1,017,378,416,526 bytes**.
- **Download time at 18.0–19.4 MB/s:** 52,400–56,500 s = **14.6–15.7 h**, so download completes ≈ 05:50–06:57 UTC on 2026-10-27, if the rate holds. That is based on three short samples and **low confidence** over hours.
- **After that** (not measured; disk headroom suggests ≥ 130 MB/s, unverified):
  - state extraction: 1,138,167,361,549 bytes of zstd output written to qcow2 on USB RAID, ≳ 2.4 h at ≥ 130 MB/s;
  - full blake3 verification read of the same size, ≳ 2.4 h;
  - total wall time ≈ **20–22 h** from 15:15 (low confidence).
- **By the 20:58 deadline:** about 5.7 h × 18–19.4 MB/s ≈ **370–400 GB** fetched in total.
  - History is 256 GB, and its archives share the 16-request limiter with `state`. How much of either is complete at 20:58 is not predictable from source alone.
  - Completed history archives survive the stop. **The state `.part` does not.**

## 3. Minimal, reviewed continuation (nothing changes the active run; all of this needs root review and a local test first)

**A. Before 20:58 (root decision):**
- Letting the controller stop at 20:58 discards all state bytes, but keeps the history archives that completed and verified.
- No action can carry the state `.part` across a stop in reth 7134be3.
- **Do not plan another 6 h window for a run that includes `state`.** It needs about 21–24 h of uninterrupted window at the measured rate, plus the 16 GiB floor holding throughout.

**B. Byte-preserving continuation** (recommended to design and test; uses reth's own verification, no reth patch):
1. **Fetch the archive resumably.** Download `state.tar.zst` with a resumable HTTP client that persists progress by file length (sequential Range resume, e.g. `curl --continue-at -`), into `/srv/enclave-base-holder/tmp/`, inside a root-owned window.
   - The exact URL must be derived from the pinned manifest's `base_url` + `file` per `manifest.rs` URL construction. Verify that construction before use.
   - Compare the final size to the manifest's 761,228,785,915.
   - Interruptions then lose at most the in-flight request.
2. **Extract only.** Run reth's legacy single-archive path on the local file: `base snapshot download --url file:///…/state.tar.zst --datadir …`, **without `--force`**.
   - `--url` with `file://` goes to `extract_from_file` (no download).
   - Legacy mode returns after extraction **without** `finalize`/`init_db` (`mod.rs:~505-532`).
3. **Normal manifest run.** Re-run the normal unit (same manifest, same floors).
   - `partition_reusable` blake3-verifies the extracted `db/*` against the manifest and **reuses** `state`. This is the integrity check, since the manifest has only output digests.
   - Only the missing history is fetched. `finalize` then writes the checkpoints once.
   - If the verification fails, reth re-plans state; nothing is silently accepted.
4. **Test locally first** (offline, small synthetic manifest/archive): that legacy `file://` extraction lands at `db/…` and that a following manifest run reuses it. **Never open the DB between steps 2 and 3**, or the blake3 changes.

**C. Controller and guard corrections for future runs** (tested before use):
- Replace "(resumable)" with the truth: completed archives survive; in-flight archives, including `state`, are discarded.
- Before starting, compute pending bytes (the plan via `--print-plan-json` is a planning-only output path, `mod.rs:~537`; confirm it performs no download) divided by a measured rate. Refuse a window shorter than that, or require root's explicit acceptance.
- Keep the 16 GiB watchdog and the own-InvocationID-only stop. Never adopt a foreign unit.
- Fix the marker check, which expects 26 archives where the CLI plans 30 + state.
- For any finalized datadir, use the state-free derived manifest from `logs/claude-retention-state-redownload.md`, so the MDBX is never deleted again.

**Root-note items:**
- **Holder off:** the controller's precheck logged holder inactive and disabled, and the unit `Conflicts=` it. The guest `ps` showed only the downloader in the unit. I did not run `fuser`/`lsof`; `db/` is empty anyway.
- **Recoverable copy:** I found no existing copy of the old MDBX and did no broad filesystem scan. The only known source is the snapshot server (`1792886410/state.tar.zst`).
- **No chain state is preserved.**
