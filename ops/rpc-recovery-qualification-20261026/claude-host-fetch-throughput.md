# Host fetch r3.1 throughput: read-only diagnosis and a bounded 2-range proposal (NOT implemented)

**Scope:** source reading of `resumable-state-recovery-stage/r3.1/srr3_fetch.py` (466 lines), `jobs/host-state-fetch-r3.sh` and `test/test_srr3.py` (30 tests), plus root's samples `logs/host-fetch-timing-1477.json`.
- **Not done:** no network, no signals to PID 2022706 or its curl, no tests, builds, queue or commits.
- **The running download** is untouched and must continue unmodified. Nothing here changes it.
- **No speed claim:** root benchmarks actual parallel ranges before any decision.

## 1. Where the time goes (from root's 80 samples, 0.25 s apart, 19.79 s, 4 committed chunks = 268,435,456 bytes, ≈ 13.6 MB/s)
**Per 64 MiB chunk, observed:**

| phase | samples (≈ time) | share | details |
|---|---|---|---|
| curl alive (parent in `anon_pipe_read`) | 17–21 (≈ 4.3–5.3 s) | ≈ 84% of chunk wall time | per-connection body rate **11.4–16.3 MB/s** |
| commit (no curl) | 3–4 (≈ 0.75–1 s) | ≈ 16% | `rq_qos_wait`, `bio_await`, `__sync_dirty_buffer`: the copy into the archive + `fsync` + the `committed.json` fsync/rename/dir-fsync |
| start of every chunk | ≈ 1 sample | | 0 bytes, then about 16 KB 0.25 s later, then the ramp: a **new curl process and TLS connection per chunk** (connect + TLS + first byte + TCP slow start) |

**Why the phases add up rather than overlap:** the loop is strictly serial (`cmd_fetch`):
1. curl range S..E into `chunk.tmp` through a pipe (`run_curl`, `read1(1 MiB)` + `os.write`);
2. headers validated (`classify`);
3. `pread`/`pwrite` of the chunk into `state.tar.zst`;
4. `fsync`;
5. `atomic_json(committed.json)`;
6. the next request.

The network is idle during the commit, and the disk is mostly idle during the transfer.

**What the evidence supports:**
- **Supported:** the transfer on ONE connection dominates. The disk is a minority (about 16%), serialized, and is not the primary bottleneck. That agrees with root's reading.
- **Not determinable from these samples:** whether the server, path or TCP limit is per-connection. Only the benchmark can tell whether 2 connections approach twice one connection, or whether a shared limit caps them.
- **Bound on what overlap alone could give:** overlapping the commit with the next transfer removes at most the ≈ 16% serial commit share, plus the per-chunk connection ramp.

## 2. Proposal: bounded 2-concurrent HTTP-range staged chunks (a design for review, not code)
**Invariant kept unchanged:** the committed-prefix file format.
- `committed.json`: same `FMT`, `offset` = the contiguous committed prefix, the pins, url, total and manifest sha;
- `state.tar.zst` only ever grows by an in-order, validated, fsynced chunk at exactly `offset`.

**Design:**
- **Two staged slots, each a range of ≤ 64 MiB:**
  - slot 0 uses the existing names `chunk.tmp`/`chunk.hdr`; slot 1 uses new `chunk.1.tmp`/`chunk.1.hdr` (added to `OWN_FILES`);
  - each runs the **unchanged** `run_curl`: `If-Range`, `--max-filesize`, `--max-redirs 0`, `--proto`, PDEATHSIG, and the over-limit kill;
  - each is validated by the **unchanged** `classify` (206, exact Content-Range and total, numeric Content-Length = received, identity encoding, no duplicated critical headers, no redirect, strong ETag and Last-Modified equal to the pins).
  - **Concurrency:** two threads (a `ThreadPoolExecutor(max_workers=2)` around `run_curl`). The GIL is released in pipe reads and file writes, so no new framework is needed.
- **Commit strictly in order, from the main thread only:**
  - the slot holding range [offset, …) commits exactly as today: copy, `fsync`, `atomic_json`, then delete its staged files;
  - only then may the other slot's (already validated, staged) range commit;
  - **out-of-order completion:** if range k+1 finishes first, it **waits on disk, not in memory**. It never touches the archive before k is committed. No bytes are ever written into the archive ahead of the committed offset (unlike a write-then-truncate scheme), so "validated before touching the archive" stays true.
- **Failure handling per slot:**
  - **transient (429/5xx, truncation, stall):** retry only that range, with the existing backoff and consecutive-failure bound;
  - **stop (pins, Content-Range, encoding, redirect, oversize):** terminate both curls, delete both staged files, and keep the committed prefix. A stop on k+1 after k committed is fine: no splice, because k+1 was never written to the archive.
  - **signals:** `STOP['proc']` becomes a list; `on_term` terminates every live curl. Every stop keeps the committed prefix (rc 143 as today).
- **Bound:** at most 2 ranges in flight, i.e. at most 128 MiB staged on disk. A `--parallel {1,2}` option, **default 1 = byte-for-byte today's behaviour**; the job opts in explicitly.

**Kept:**
- strong ETag / If-Range / header validation;
- atomic fsynced progress;
- the 16 GiB floor (job start check + queue guard);
- the `--max-hours` deadline;
- ≥ 500 GB reserve (the capacity check adds the 128 MiB of staging to `remaining`, which is dwarfed by the reserve);
- full archive retention (nothing deleted except the tool's own staged attempt files);
- no new secret, auth or load use.

## 3. Memory, file cache and the 256 MiB lane
- **Process memory:** the data path is streaming. Each slot holds about a 1 MiB `read1` buffer plus pipe buffers; the copy loop uses 4 MiB (`COPY`).
  - **Estimate, not measured:** Python plus two curl processes (TLS) is about 60–90 MiB RSS, versus about 40–50 today with one curl. That fits the 256 MiB tree-RSS cap the queue guard measures.
  - **Must be verified** by root's benchmark: peak tree RSS under the guard.
- **Page cache:** staging means every byte is written twice (`chunk*.tmp`, then the archive). That is today's design too; with 2 slots there are at most 2×64 MiB of staged dirty or clean pages plus the archive's dirty pages until `fsync`.
  - **If the lane is a cgroup with `memory.max` 256 MiB** (not a pure RSS guard), the file pages are charged to it. Dirty pages are throttled or written back, and clean pages are reclaimed.
  - **The guard's evidence so far is `peakTreeRssMiB`** (an RSS measure). Root should confirm which mechanism the lane uses before the benchmark.
  - **If cgroup-charged:** `posix_fadvise(DONTNEED)` on the staged file after the copy, and on the archive range after `fsync`, keeps the cache footprint bounded. That is a two-line addition.
- **Host floor:** MemAvailable includes reclaimable cache. At tens of MB/s the dirty volume is small relative to the 16 GiB floor, and the start check stays at floor + lane.

## 4. Crash semantics (any point; SIGKILL included)
- **Committed state:** `committed.json.offset` only ever advances by one contiguous, validated, fsynced chunk, so a crash at any point leaves exactly the committed prefix.
- **Restart (unchanged logic, extended file list):**
  - delete own `chunk*.tmp`/`chunk*.hdr`/`committed.json.tmp`;
  - truncate any archive tail beyond `offset`. With in-order commit no out-of-order bytes ever reach the archive, so the tail can only be today's interrupted copy;
  - then resume at `offset`.
- **Staged-but-uncommitted range k+1:** discarded and re-fetched. Correctness wins over saving one 64 MiB range.
- **Switchover from the running r3.1:** the same `FMT` and pins, so a future r3.2 resumes the r3.1 work dir at its committed offset without conversion. Two cautions:
  - r3.1 refuses unknown files, so after an r3.2 **crash**, run r3.2 again (it removes its own `chunk.1.*`) rather than reverting to r3.1;
  - the switchover is root's controlled stop (any stop keeps progress) and is **not** proposed now.

## 5. Minimum regression tests (added to the existing 30, which run unchanged with `--parallel 1`)
The loopback server is already threaded (`socketserver.ThreadingMixIn`). It needs only a per-range delay or fault mode.
1. **2-range happy path:** byte-identical archive; `committed.json` offsets strictly contiguous and increasing (event log).
2. **Out-of-order completion** (range k delayed so k+1 finishes first): k+1 is staged, the archive is untouched beyond `offset` while k is in flight, and k then k+1 are committed in order.
3. **SIGKILL while k+1 is staged and k is in flight:** restart truncates and cleans, committed offset = before k, final archive identical.
4. **SIGKILL after k's `pwrite`, before its commit** (existing kill point, parallel mode): the tail is truncated and resume is identical.
5. **A stop fault on k+1 only** (ETag change / wrong Content-Range / oversize): k may commit, nothing beyond it, both curls gone, both staged files removed, rc 6.
6. **A transient fault on k only** (503, truncation): only k is retried, k+1 stays staged, order is kept.
7. **SIGTERM with both curls live:** both terminated, committed kept, rc 143.
8. **Leftover `chunk.1.*` on start:** removed when owned; a foreign file of that name refuses.
9. **`--parallel 1`:** identical event sequence to r3.1 on the existing happy-path test (regression guard for the default).

## 6. Feasibility and recommendation
- **Feasibility:** a bounded, minimal change to one file (about 80–120 lines), with the same validation, commit format and safety properties. The 256 MiB lane is plausible by estimate; root's benchmark must confirm both the RSS and whether the lane charges page cache.
- **Recommendation:** first run root's planned benchmark of actual parallel ranges (2 concurrent `curl -r` against the same pinned URL, with `If-Range` and the pins) and compare it with the single-connection 11–16 MB/s seen here.
  - **If 2 connections do not clearly exceed one:** the remaining serial gain is at most the ≈ 16% commit share plus the per-chunk TLS ramp. A cheaper option is reusing one connection, or overlapping commit with a single next transfer.
  - **Only if parallel helps:** implement the design above in a NEW stage with the tests above, leaving the running r3.1 download untouched until root's controlled switchover.
