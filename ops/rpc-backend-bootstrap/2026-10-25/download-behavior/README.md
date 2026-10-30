# Base snapshot download: actual client behaviour (source audit plus one root read-only observation)

## Status

| Item | State |
|---|---|
| Existing downloader | **Continues unchanged.** No restart, no concurrency change, no other downloader. |
| Concurrency | **No blind increase is recommended.** |
| aria2 side copy | A **proposed** plan only: not executed, and its `file://` assumption is untested. |
| Live access by this work | None: no live diagnostics beyond root's one read-only run, no downloads, no restarts. |

**Client:** `/opt/enclave-rpc/bin/base snapshot download --manifest-path <pinned 1f0c4e6c…> --download-concurrency 16 --resumable=true`.
- base v1.5.1 (`https://github.com/base/base`, commit `5476069f1eb74a56bccb56fdefd4b4bb0e3cda42`), `crates/execution/cli/src/commands/download.rs`;
- which delegates to base/reth `7134be3b51cf9d9504f988bff3266a23085f0bd9` (`https://github.com/base/reth`, tag `base-v2.5.2.8`), `crates/cli/commands/src/download/`.

All line references below are to that reth revision.

## 1. Already parallel by byte range

- **Archive scheduling.** Manifest (modular) mode uses one session with a **global** `DownloadRequestLimiter(--download-concurrency)`, processes archives with `buffer_unordered(16)`, and always uses Cached mode (`<datadir>/.download-cache`) (archive.rs:22, 25-90, 324-338).
- **Per archive** (`ArchiveFetcher::download`, fetch.rs:124-157):
  - it probes with `GET Range: bytes=0-0`;
  - a 206 answer plus size ≥ 128 MiB means **segmented**: 64 MiB pieces (32 MiB under 2 GiB), with `workers = min(concurrency, pieces)`;
  - every piece request takes a permit from the **same** global limiter (fetch.rs:28-43, 468-477, 695-736, 904-930);
  - otherwise it falls back to sequential.
- **Consequence:** at most `--download-concurrency` range **requests** are in flight across all archives. One monolithic archive (`state.tar.zst`, 761.2 GB) can use all of them.

## 2. The segmented path is NOT durably resumable

- **Truncated on start.** `run()` re-creates (truncates) `<file>.part` and `set_len(total)`s it (fetch.rs:576-583).
- **Deleted on failure.** A piece has 3 attempts (fetch.rs:28), each with a **120 s total** request timeout (fetch.rs:43). On final failure `.part` is deleted (`cleanup_partial`, fetch.rs:623-629), and the archive is retried **from scratch**, up to 10 times (archive.rs:145-195).
- **A service restart loses all in-progress segmented archive bytes.**
- **`--resumable=true` (mod.rs:451-458)** only selects download-to-disk-then-extract. Byte resume from the `.part` length exists only on the **sequential** path (fetch.rs:194-300).
- **What does survive:** archives whose extracted outputs already verified by BLAKE3 are reused at startup (`partition_reusable`, mod.rs:556-562; verify.rs:32-96).

> **Warning: earlier handoff and notes are wrong on this.** Any earlier statement that the `.part` "resumes" or that "partials are preserved across restart" is incorrect for this segmented path. Only verified extracted outputs are reused.

## 3. HTTP/2: sockets are not requests

- **HTTP/2 is compiled in.** The pinned binary (sha256 `9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f`) embeds the h2 0.4.15 client and reqwest 0.13.4 (`test-evidence/binary-strings.out`). That is consistent with base's `Cargo.lock`, and `bin/base` takes reqwest with default features. Negotiation with the CDN (ALPN) is likely but **not observed**.
- **One TCP connection can multiplex many concurrent range requests.** One TCP socket does **not** mean one active HTTP stream.
- **Per-request speed and the timeout margin cannot be inferred from socket counters.**
- **Guest networking is QEMU user-mode** (`-netdev user`), so guest socket rtt/cwnd describe the guest↔QEMU hop only.

## 4. Root's single read-only observation (`root-evidence/`)

`read-only-1914.json` (verbatim) and `read-only-1914.ANNOTATION.md`.

**Actual measurements:**
- process write 11.5 MB/s;
- whole-link RX 16.6 MB/s;
- disk 5.3% busy;
- state `.part` at full apparent size (= manifest), 36.95 GB allocated and growing 11.5 MB/s, i.e. the segmented path;
- 15 headers `.part` segmented and not progressing during the window.

**UNSUPPORTED (v1 heuristics, not measurements):** the "not request-limited" hint, per-connection rates read as per-request rates, and the `pieceTimeoutMargin` of 20.61.

**Bottleneck undetermined:** QEMU user networking, one HTTP/2 connection, or the uplink.

## 5. Decisions

**No blind concurrency increase.** On one HTTP/2 connection, more streams can lower each stream's rate and raise the 120 s piece-timeout risk.

**Proposed only (not executed): durable side copy with aria2c.** Its `.aria2` control file resumes completed segments.
1. Stop the service first.
2. Download into a separate directory (never `.download-cache`), and wait for the exact size 761,228,785,915.
3. Derive a manifest that changes only `components.state.file` to an absolute `file://` URL.
4. Restart. Content integrity remains the pinned per-output **BLAKE3** verification (`manifest-summary.json` lists the 4 state outputs and their BLAKE3). There is no archive hash.

**Untested:** that `resolve_archive_url`'s `Url::join` (manifest.rs:540-562) keeps an absolute `file://`. Also unchecked: space (+761 GB) and installing aria2 in the guest (a live change).

## 6. Files

| File | Content |
|---|---|
| `diagnostics/download_diag.py` | v1, corrected: socket hints conditional, margin labelled an upper bound |
| `diagnostics/download_diag2.py` | `parts` / `pieces` (O_RDONLY SEEK_DATA/SEEK_HOLE) / `journal` (whitelist, no URLs). Read-only and bounded; never run live. |
| `diagnostics/test_*.py` and `test-evidence/diag-tests-all.*` | real output: **8/8 OK** on the shared queue at 256 MiB |
| `test-evidence/binary-strings.{sh,out,guard,rc}` | read-only grep of the pinned binary |
| `manifest-summary.json` | public manifest metadata summary; source manifest sha256 `1f0c4e6c…` (root's pin) |
| `SHA256SUMS` | every file |
