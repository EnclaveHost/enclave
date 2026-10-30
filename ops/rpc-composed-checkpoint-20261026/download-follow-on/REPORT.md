# Base snapshot: restart-resume semantics, what remains, next-batch options (read-only follow-up, 2026-10-26 ~05:28 UTC)
Nothing was restarted, signalled, downloaded, installed or reconfigured. The earlier report `claude-download-throughput-0524.md` is preserved.
Raw evidence is in `logs/download-next-batch-0528/`: manifest structure, component sizes, journal restart lines, flag list and source excerpts.

## Source used
- The local cargo checkout `~/.cargo/git/checkouts/reth-babcd6134566c621/7134be3`, `crates/cli/commands/src/download/{mod,fetch,session}.rs`.
- Its commit 7134be3 equals the manifest's `reth_version "2.5.2-dev (7134be3)"`.
- **Caveat:** the running binary reports `base 1.5.1`. That it was built from exactly this reth commit is inferred, not proven.

## 1. Restart-resume of the segmented `state.tar.zst` (the current archive): NOT resumable across a process restart
- **Source:** the segmented path (`download_segmented` → setup, `fetch.rs:580-581`) does `fs::create_file(part_path)` then `file.set_len(total_size)`. It recreates the `.part` at full size and keeps no piece-completion record. Only the **sequential** path (`fetch.rs:205-232`) reads the existing `.part` length and sends `Range: bytes=<existing>-`. The `--resumable` help text ("HTTP Range resume") describes that sequential/in-process retry behaviour.
- **Actual evidence (journal):** this service was restarted at 11:19:41, 16:39, 17:54:51, 18:17:01 and 18:19:06 UTC. Every start printed `Starting queued segmented download total_size=708.95 GB … pieces=11344` again: the full archive (761.23 GB decimal = 708.95 GiB), never the remainder.
  - Across restarts, `Startup integrity summary` reused only **finished, verified plain output files**: reusable 1 → 20 → 37.
- **Conclusion:** root's earlier finding holds. A restart now would lose about 541 GB of `state` progress. **Do not restart.**

## 2. What remains: the CURRENT run (116 archives) vs the planned FINAL second run (134 archives)
_Amended 2026-10-26: the earlier text here said "no 18 further archives". That holds for the CURRENT run only. The 18 belong to root's reviewed SECOND run._

- **Current run** (PID 4061, profile `first-pass-distance-140000`, journal `archives=116 download_total=770.80 GB`): 115/116 are done, and only `state.tar.zst` remains (about 230 GB at 05:27, then extraction to 1138.17 GB).
  - The observations in §1 and in `claude-download-throughput-0524.md` stand: segmented restart loses progress, a single CDN connection, about 18 MB/s, disks and CPU not limiting.
- **Planned second run:** profile `final-h48000000-s52500000` (`base-reanchor-recovery-stage/r7/harness/selection.py`: `--with-txs-since 48000000 --with-receipts-since 48000000 --with-state-history-since 52500000`; source base-retention-stage/v2).
  - Derived on the **live** manifest `/opt/enclave-rpc/snapshots/base-1792886410-manifest.json` (block 53048526) with that file's own `derive()`.
  - Machine-readable: `download-next-batch-0528/selection-diff-final-vs-current.json`.

| | archives | compressed | output (extracted) |
|---|---|---|---|
| current (first-pass-distance-140000) | 116 | 827.64 GB | 1274.29 GB |
| final (final-h48000000-s52500000) | 134 | 1049.26 GB | 1684.28 GB |
| **extra = final − current** (nothing removed) | **18** | **221.62 GB** (221 616 054 366 B) | **409.99 GB** (409 990 674 216 B) |

  **The 18 extra archives** (compressed / output GB):
  - receipts:
    - `static_files/receipts-48000000-48499999.tar.zst` 7.70/16.66;
    - `-48500000-48999999` 7.60/16.45;
    - `-49000000-49499999` 6.51/14.72;
    - `-49500000-49999999` 6.57/15.81;
    - `-50000000-50499999` 9.50/21.76;
    - `-50500000-50999999` 8.74/20.04;
    - `-51000000-51499999` 9.10/20.67;
    - `-51500000-51999999` 9.55/21.28;
    - `-52000000-52499999` 9.42/21.61.
  - transactions:
    - `static_files/transactions-48000000-48499999.tar.zst` 15.04/24.29;
    - `-48500000-48999999` 14.50/23.33;
    - `-49000000-49499999` 12.66/21.25;
    - `-49500000-49999999` 12.96/22.36;
    - `-50000000-50499999` 20.18/34.32;
    - `-50500000-50999999` 18.81/30.85;
    - `-51000000-51499999` 18.81/30.80;
    - `-51500000-51999999` 18.00/28.66;
    - `-52000000-52499999` 15.97/25.11.
  - The account/storage changesets need 0 extra: since 52.5M = chunks 105–106, already in the current selection.
- **Existing reviewed command path:** `base-retention-stage/v2/cached_download_preflight.py --manifest <manifest> --datadir /srv/enclave-base-holder/data --history-from 48000000 --state-history-from 52500000` (read-only; statvfs).
  - **Emitted command:** `/opt/enclave-rpc/bin/base snapshot download --chain base --manifest-path /opt/enclave-rpc/snapshots/base-1792886410-manifest.json --datadir /srv/enclave-base-holder/data --with-txs-since 48000000 --with-receipts-since 48000000 --with-state-history-since 52500000 --download-concurrency 16 --resumable=true -y`. It contains no `--force` or `--prune-unlisted`.
  - **`selection.check_argv`** pins exactly this token set.
  - **This run's preflight:** run read-only in the guest at about 05:31: rc 0, `admitted: true`, missing = 18 archives (receipts 9, transactions 9).

## 2a. Physical disk headroom (Base disk, guest `/srv/enclave-base-holder`, 3097.86 GB)
- **Now:** free 2414.64 GB. `state.tar.zst.part` is 761.23 GB apparent but 516.08 GB allocated.
- **Still to be consumed by the CURRENT run:**
  - about 245.15 GB more `.part` allocation;
  - 1138.17 GB of state output.
  - Free afterwards: **about 1031.3 GB if the archive is kept**, or about 1792.5 GB if the tool deletes it after extraction. `extract.rs:529` calls `cleanup_downloaded_files()`, which suggests deletion, but the call context was not read, so this is unconfirmed.
- **The second run's preflight requirement** is `needBytes` 1043.16 GB: 221.62 compressed + 409.99 extracted + 161.04 index reserve (an estimate) + 250.52 for 30-day growth.
- **Why today's `admitted: true` is not final:** it was computed against today's free space and does **not** count the current run's remaining state allocation and extraction.
- **Worst case** (archive kept): 1031.3 GB free < 1043.16 GB needed, so the run is **about 12 GB short**. With the archive deleted it is admitted with about 750 GB to spare.
- **Root must re-run the same preflight after the current run finishes and before starting the second run.** It measures statvfs at that time.

## 2b. Recommendation to root
**Yes, follow the existing reviewed second run** (`final-h48000000-s52500000`) **after** the current 116-archive run completes and its extraction finishes. Do not restart the current run.
- **Why it fits:**
  - It is a separate invocation. The integrity pass reuses the 116 verified outputs ("reusable"/"Skipping already verified"), so only the 18 archives download: 221.62 GB, about 3.4 h at the measured about 18.3 MB/s on the same single-connection path.
  - Its chunk archives are 6.5–20 GB each, so a failure loses at most one chunk, not hundreds of GB.
  - The command is already pinned by `selection.check_argv`.
- **Gate:** re-run `cached_download_preflight.py` immediately before starting, and start only if `admitted: true` holds at that moment (see 2a).
- **Throughput:** no faster supported path is available today (see §3). Network/CDN single-connection throughput remains the limit; it is not disk or CPU.

## 3. Supported ways to speed a NEXT batch (none applied; each needs root authority)
| Option | Support in the tool/source | Notes |
|---|---|---|
| Pre-fetched **archives** from a local directory | **No flag.** The download flags are `--url`, `--manifest-url`, `--manifest-path`, `--resumable`, `--download-concurrency`, `--archive` (`--archive` = all components, not a local path) | Unsupported as a direct option. |
| Reuse of pre-placed **extracted outputs** | **Supported by the existing integrity pass.** "Startup integrity summary … reusable=N" plus "Skipping already verified plain files": outputs matching the manifest's `output_files` (path, size, blake3) are skipped | Would mean extracting archives outside the tool. That is a new procedure; it is safe only because the tool re-verifies blake3, but it is untested here. |
| A **local mirror** via `--manifest-path` | The manifest's `base_url` is the download origin; `--manifest-path` takes a local file | A reviewed copy of the manifest with `base_url` pointing at a host-local HTTP server with Range support, serving archives the host pre-fetched with several connections. Output blake3 verification remains. Untested; needs root review of the manifest edit, the HTTP server and the prefetch tool. |
| More connections inside the tool | `--download-concurrency` sets pieces/workers, but the host showed **one** TCP connection to the CDN (HTTP/2 multiplexing, see 0524) | No flag found to force HTTP/1.1 or several connections in this read. Unsupported as far as shown. |
| VM networking tap/vhost-net instead of slirp | n/a (QEMU) | Needs a VM restart. Only at a planned window, never during a segmented download. |

**Required checks for any future option:**
1. Start only **between** archives or before a run; never during a segmented download.
2. Pin the manifest (sha256), and keep output blake3 verification on.
3. Use no credentials.
4. Use bounded disk headroom: the Base disk holds `.part` plus extraction, so state needs about 761 GB + 1138 GB.
5. Get root's explicit authorization for the host-side prefetch and the HTTP server.

**Simplest safe action now:** let the current download finish. About 230 GB at the measured about 18 MB/s is about 3.5 h, plus extraction.
