# Bounded bridge for the isolated whole-restore harness (RESULT, 2026-10-23)

**Status: SOURCE + OFFLINE / LOOPBACK TESTS ONLY.**
- No SSH, no live Sia/indexd/DNS, no private file, no production action. Nothing was spent.
- The frozen harness `work/resume-after-checkpoint-20261022/sia-whole-restore-harness/` is unmodified: `runner.py`
  still `d11f7bca…`, `whole_restore.py` still `8a6cc0d3…` (re-hashed at the end).
- The Rust binary is unchanged; the candidate needs no rebuild.
- Root owns the new full attempt.

## 1. Why the run died, and what is inference

Root's kernel evidence (`ROOT-KERNEL-EVIDENCE.json`), from the VM run killed at 02:20:32Z by its 768 MiB cgroup:
- the outer Python bridge was at 363,756 KiB anonymous memory and the inner one at 356,768 KiB;
- `sia-s3` was at 39,236 KiB;
- file cache was 24 KiB.

So the two Python bridge processes filled the cgroup with anonymous memory. The restore binary did not, and neither did
the page cache.

**The old bridge design (`runner.py d11f7bca`):**
- each end runs one thread per listener (50) and one more thread per accepted connection;
- each relay loop calls `recv(256 KiB)`, which allocates a fresh bytes object on every read, then `sendall`;
- the code had no connection limit and no stall deadline;
- its only timeout is a 900 s `select()`, and that timeout does not apply while a `sendall` is blocked.

**Measured locally** (real TCP and AF_UNIX on loopback, generated data, the frozen runner run unchanged from its
original path):

| run | per-end anon peak (inside / outside) | threads per end | cgroup, sampled max | throughput / integrity |
|---|---|---|---|---|
| `old-all-1`: 50 streams (10 slow), 100 churn/s, 30 stallers, 30 idlers, 150 s, glibc default arenas | 85 / 78 MiB | 167 | current 601 MiB, **sock 316 MiB** | 74.4 GB, 0 mismatches |
| `m1-oldA16`: 50 streams (40 paced), 40 churn/s, `arena_max=16` (≈ a 2-vCPU VM), 150 s | 74 / 66 MiB, **creeping** (outside 57 → 65 MiB over 130 s) | 104 | current 330 MiB | 79.6 GB, 0 mismatches |
| `m1-newA16`: the same load against the new runner (`a9c26824`, a pre-fix tree) | **13 / 12 MiB, flat** | **2** | current 222 MiB | 74.5 GB, 0 mismatches |

The `memoryPeakBytes` that `m1` reports is cumulative over the shared queue scope (the old case ran first). It is not
a new-only peak. The sampled per-run maxima above are the comparable numbers.

**The mechanism:**
- **Inference.** The likely cause is per-connection threads that each allocate a 256 KiB recv buffer on every read, in
  shared glibc per-thread arenas, over hours of churn and streaming. That fits both bridges growing about equally, and
  the VM's 1.8 GB total-vm (about 16 arenas and about 95 threads).
- **Not reproduced.** The synthetic old bridge did **not** reach 360 MB; it plateaued at 66–87 MiB with a slow creep.
- **Interrupted.** The longer diagnostic `d-oldA16long` was interrupted by root at 02:58:20Z. It has no result and is
  **not a pass**; its log is `logs/d-INTERRUPTED.out` (with a README), and the other `d` cases never ran. By root's
  ruling, no comparative matrix was re-run.
- **The fix does not depend on this.** The new bridge removes every candidate mechanism: per-connection threads,
  per-read allocation, unbounded connections and stalled peers without a deadline.

**Other defects of the old bridge, found on the way (not claimed as the OOM cause):**
- **Half-close truncation.** The first EOF in either direction closed both directions.
- **The `select()` fd limit.** `select()` raises `ValueError` above fd 1024, and the code catches only `OSError`.
- **Idle timeout = keepalive interval.** 900 s equals the siamux keepalive interval (3/4 of its 20 min timeout).
- **Kernel socket memory.** Stalled peers held kernel socket memory with no limit (`sock` 316 MiB above).

## 2. The new bridge (`runner.py 6d243858`)

**Structure.** Each end is one `Bridge`: a single thread running one `selectors` loop over non-blocking sockets.
- **outside:** AF_UNIX listeners → the real `ip:port`;
- **inside:** loopback TCP listeners → AF_UNIX.

**Status handshake (unchanged meaning).**
- The outside dials the real host without blocking. Only when that connect completes does it send byte `1`; it sends `0`
  if the dial failed and `2` if a connection limit refused it.
- The inside relays nothing before it reads a `1`.
- The positive-control probe (`bridged()`) is unchanged, so it still requires the REAL host to accept.

**Backpressure.**
- Every read goes into one fixed scratch buffer (`recv_into`), so reads allocate nothing.
- Bytes the destination cannot take wait in that direction's 64 KiB chunk, and its source is not read until the chunk
  drains.
- Chunks come from a bounded pool, so the high-water mark is ≤ 2 × the live connections.

**Half-close.** An EOF becomes `shutdown(SHUT_WR)` once that direction's bytes are written; the other direction keeps
flowing.

**Limits.**
- `maxConns` (256) caps each end and `maxConnsPerEndpoint` (16) caps each endpoint.
- At a cap the **newcomer** is refused: RST inside, status 2 outside.
- **An existing connection is never evicted.** Root's half-close review found that the first candidate's `_room`
  evicted a healthy half-closed download. That eviction is removed. Section 4 lists the capacity tests and the mutant
  that proves them.
- The cap also shrinks to fit the inherited `RLIMIT_NOFILE`, which is left unchanged.

**Deadlines** (no absolute age limit):

| deadline | default | applies when |
|---|---|---|
| connect | 15 s | the outside's dial of the real host |
| status | 30 s | the inside waits for the status byte |
| stalled send | 300 s | bytes are waiting and none can be written. This is the **only** deadline while bytes wait |
| half-closed idle | 60 s | one direction has ended, nothing waits, nothing moves |
| idle | 1800 s | nothing waits, nothing moves |

**Kernel buffers.**
- `hostRecvBufBytes` (1 MiB) is the `SO_RCVBUF` of the host socket, set before connect.
- `localSendBufBytes` (256 KiB) is the `SO_SNDBUF` of the inside's accepted socket.

Both bound what can queue ahead of a slow restore; `0` means kernel autotuning.

**Errors.**
- The TCP sockets of the end that detects an error close with RST.
- Across the AF_UNIX hop an abort arrives as EOF, as before. siamux frames are authenticated, so a truncated stream is
  detected.

**Stop.**
- `stop()` closes every listener and connection and joins the thread.
- Both ends' stats (counts only) go into `result.json` under `bridge`.
- `success` now also requires `bridge.ok`: both loops ended and neither failed.

**`whole_restore.py 724cb639`.**
- **New flag:** an optional, repeatable `start --bridge KEY=INT`.
- **Validated early:** the runner's own `bridge_settings` checks each value before any pin, upload or unit. A bad value
  is refused with nothing started.
- **Recorded:** the values go into `plan.json` and the `start` output.
- **Unchanged:** handle, invocation id, pins, isolation and upload.

## 3. Inventory (candidate repo `work/storage-restore-memory/candidate`)

| file | sha256 | role |
|---|---|---|
| `runner.py` | `6d2438580b14b1b2beb29ee0b6cc51d74d9a6a10517296836089d3812dc937f2` | runs inside the unit; the new bridge |
| `whole_restore.py` | `724cb63918e07d7d3954c7ca577a8431f6da22f87f4a56537cc31161a806adc2` | the launcher; `--bridge` |
| `run-tests.sh` | `c327248f8803d5cfea18ff451db5d6606ea55caa8a7b71012b5a62bc0b6b8633` | offline suites inside `unshare -rn` (`harness`, `bridge`; `$TESTS` selects tests) |
| `test/test_harness.py` | `a44f14598b675837b0ea681fbb88cdfd4e6495eefcfbb2d8f1b39a5f551d46ad` | 18 tests: the 17 originals, plus bridge result assertions and a `--bridge` test |
| `test/test_bridge.py` | `300a84d5b0a9a4251cd7edd86dc36dd60d219bdbe20dbfe7d328738bcc75abe3` | 17 real-socket bridge tests |
| `test/test_real_systemd.py` | `548e5cd235748575e8e06e2246fe07b6f66582b8000498ddd2e800414280b6dc` | unchanged |
| `test/fake-sia-s3`, `test/stubs/*` | unchanged (`13b7ec74…`, …) | |
| `test/mutate.py` | `df2f7734d89243c5025f988d560ff3d6b3f00a4579ce98beff4b79b91808cb43` | mutation controls. Same as the `../mutate.py` (`9b30c7fe…`) that ran, except the line locating the repo |
| `load/siaload.py` | `20d4805138a99abac35308635b7ca69430adaebdc3a14cefe10bc35ff85d7baf` | fake Sia hosts, a load-generator "binary", and the namespace load driver |
| `load/unit-load.py` | `217387055fb1fe0eec85bf05a233300f2f0f924c0ef8d7a889e9b6be252ee3d1` | load through the real `whole_restore.py start` and a real `systemd-run --user` unit |
| `load/run-measure.sh` | `94a82e947d3ce26a35d31e9c0c017ec97598d5447e418e6316d5a135a0dbb760` | private-namespace wrapper for `siaload.py measure` |

**Commits.**
- Baseline `0d7e6b8`: the frozen files, imported unchanged.
- One fix commit on top (see `git log`). `../bridge.patch` is `git diff 0d7e6b8 HEAD`.
- Nothing was pushed or merged.

## 4. Terminal test receipts

Every run went through `work/claude-test-queue.py`. The logs are in `work/storage-restore-memory/logs/`.

| log | cap | what | result |
|---|---|---|---|
| `final-1` | 256 | **final hashes:** `run-tests.sh` (harness 18, bridge 17), the unbounded-queue mutant, `test_real_systemd.py` | **18/18 OK, 17/17 OK, mutant KILLED, real unit OK** (isolated, `Result=success`, `memoryPeakBytes` 28,983,296, no leftover unit) |
| `unit-sustained-1` | 512 job + a 256 MiB user unit | **the one sustained case** (details below) | **succeeded** |
| `mut-4`, `mut-5`, `tb-7` | 256 | mutants: status ignored; no stall deadline; EOF closes both; no idle deadline; no limits; **re-introduced half-closed eviction**; half-closed idle while bytes wait; stop leaves connections | **all KILLED.** The eviction mutant fails all 4 capacity tests |
| `mut-2` / `mut-3` | 256 | unbounded queue behind a slow reader | full suite: cgroup OOM (EXIT -15). Slow-reader test alone: assertion FAIL, so KILLED |
| `old-all-1`, `m1` | 768 | old vs new comparison (section 1) | valid baselines |
| `d-INTERRUPTED` | 768 | old long creep run | **INTERRUPTED by root, not a pass** |

**The sustained case (`unit-sustained-1`, runner `6d243858`):**
- **How it ran:** through the real `whole_restore.py start --target local` and a real `systemd-run --user` unit with
  `MemoryMax=256M`, on loopback only.
- **Load:** 50 endpoints; 50 streams of 4 MiB sectors (40 host-paced); 4 churn threads at 20 connects/s (close, RST
  abort, small, no data); 10 stallers; 10 idlers.
- **Duration and settings:** 420 s, with `--bridge stalledSendSecs=60 idleSecs=120 halfClosedIdleSecs=30` so that
  expiry happens inside the run.
- **Integrity:** 211,648,774,144 bytes in 50,461 requests, byte-compared, **0 mismatches**; 8,240 churn connects, 0
  errors.
- **Peers closed by their deadlines:** stallers 10/10 and idlers 10/10.
- **Each bridge end:**
  - **memory:** RssAnon **13 MiB, flat from 31 s to 409 s**;
  - **threads:** **2**;
  - **descriptors:** 156–202, plateaued;
  - **at stop:** `openAtStop` 0, `loopError` none.
- **Unit totals:** anon 59 MiB flat; memory.current ≤ 196 MiB; sock ≤ 124 MiB; `oom_kill` 0; tasks 59;
  `memoryPeakBytes` 232,480,768. After the run the unit was `not-found` / `inactive`.

**What the 17 bridge tests cover** (real sockets, no mocks):
- **Correctness:** 24 concurrent bidirectional transfers, byte-exact;
- **Slow peers:**
  - a slow reader holds exactly one chunk at each end;
  - a 7 s trickle is not cut by 1 s idle, half-closed or stall deadlines;
- **Half-close:**
  - a client half-close reaches the host and the response flows back;
  - a host half-close keeps the client → host direction open;
- **Handshake and dial:**
  - a down host is refused, and the probe requires the real host to accept;
  - the connect timeout works;
- **Deadlines:**
  - a stalled reader is dropped and its chunks are returned;
  - idle and half-closed idle connections end;
  - a backpressured half-closed response survives 3.5 s of no movement (half-closed idle 1 s; only the stall deadline
    applies);
- **Capacity pressure, at the inside and outside ends, per endpoint and globally:**
  - the clients `SHUT_WR`, then receive paced 16 MiB responses;
  - the newcomer is refused with no byte and never reaches the host;
  - both responses arrive complete and byte-exact, with no timeouts or resets;
  - the freed capacity then serves a new connection;
- **Lifecycle:**
  - a stop mid-transfer closes everything, with no thread or descriptor left;
  - 4000-connection churn returns to a plateau (anon change < 4 MiB, descriptors at baseline);
- **Settings:** settings are validated.

**Memory accounting for the real-unit runs.** The unit runs outside the queue scope, so the accounting is: queue job 512
or 256, plus the unit's own `MemoryMax` of 256 (the same pattern as the original `real-5`).

## 5. Remaining uncertainty and honest limits

- **Not reproduced.** The production ~360 MB per bridge was not reproduced; the mechanism in section 1 is inference.
- **Loopback only.** WAN latency and real Sia hosts were not exercised.
- **The 1 MiB host window** caps each host connection at about 10 MB/s at 100 ms RTT.
  - The total also depends on how many hosts the restore reads at once.
  - Pass `--bridge hostRecvBufBytes=0` for kernel autotuning, at the cost of unbounded per-connection kernel buffering.
- **Slow readers.** A peer that keeps making some progress at least once per stall window (300 s) is not cut. Its
  memory is bounded by the caps (one chunk per direction plus the kernel buffers).
- **Aborts.** An abort crosses the AF_UNIX hop as EOF (as before).
- **Throughput.** In `m1` the new bridge moved 74.5 GB against the old 79.6 GB in 150 s. The client was the bottleneck,
  so this is not a measured bridge limit.
- **Unchanged risks.** The debug `sia-s3` throughput, the sequential restore and the lack of resume are as before.

## 6. Root's new full attempt (preflight and start; the existing recipe with the candidate harness)

The old attempt and its ~12.4 GB of partial data stay untouched. `start` always creates a NEW attempt directory and a
NEW remote directory, and nothing below claims, reuses or erases the old one.

```bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work
H=storage-restore-memory/candidate
sha256sum $H/runner.py $H/whole_restore.py   # must be 6d243858… and 724cb639…
B=resume-after-checkpoint-20261022/sia-whole-bucket-recovery/target/x86_64-unknown-linux-gnu/debug/sia-s3   # 3ef760ed…
# preflight 1: the old unit is ended (FAILED / oom-kill) and nothing holds its name
#   (poll with the FROZEN harness, read-only, by the old run's handle)
python3 -I resume-after-checkpoint-20261022/sia-whole-restore-harness/whole_restore.py poll --run <OLD_RUN>   # expect a failed or ended state, never running
# preflight 2: read-only resources of the VM (one SSH)
python3 -I $H/whole_restore.py check --target vm --root /home/storageadmin/recovery-lab --total-bytes 21445494044 --binary $B \
  --ssh-dest storageadmin@127.0.0.1 --ssh-port 32422 --ssh-identity /home/steven/.ssh/minipc --ssh-known-hosts storage-vm/known_hosts
# fitsBudget must hold with the old partial data present (budget + 1 GiB)
# a fresh prepare (new run dir; re-resolves host addresses) — same arguments as the original RESULT.md §5
python3 -I $H/whole_restore.py prepare --root private/sia-whole-restore --blocked private/sia-whole-restore/blocked.json \
  --snapshot <SNAPSHOT> --snapshot-sha 0e5b28c9dc53a5ac65e1bace6cf7409c8f6369599c114fb1878503acec210da1 \
  --archive <ARCHIVE> --archive-sha 3cfb4f12991b3588d6c9b1317e08ef9613bac349f1a60073a2d835cad326c335 --key-file <KEY>
RUN=<run printed by prepare>
python3 -I $H/whole_restore.py start --run $RUN --target vm --vm-root /home/storageadmin/recovery-lab \
  --ssh-dest storageadmin@127.0.0.1 --ssh-port 32422 --ssh-identity /home/steven/.ssh/minipc --ssh-known-hosts storage-vm/known_hosts \
  --binary $B --binary-sha 3ef760ede4e46b5a944f429a78706b0822900434246bd8a24aeb22ceaba388aa \
  --max-total-bytes 23000000000 --deadline-secs <DEADLINE> --memory-max-mib 768     # the same 768: no cap increase
python3 -I $H/whole_restore.py poll --run $RUN   # repeat; exit 3 = running
```

**Bridge settings.** The defaults apply, and the `start` output prints them under `bridge`. To change one, pass
`--bridge KEY=INT`.

**What to watch.**
- **During the run:** `unitState.MemoryPeak` in `poll`.
- **On success:** `result.memoryPeakBytes`, and `result.bridge` (per end: `maxLive`, `buffersAllocated`, the timeout
  counters, `loopError: null`).
- **Expected memory:** each bridge end should stay at tens of MiB, against ~360 MB before.

**Success criteria** (unchanged from the original §5, plus one): `result.bridge.ok == true`.

## 7. Rollback and cleanup

- **Rollback** means using the frozen harness again: `work/resume-after-checkpoint-20261022/sia-whole-restore-harness`,
  unmodified. It keeps the known memory defect.
- **Separate files.** The candidate has its own path, so it shares nothing with the frozen files.
- **After an attempt:**
  - after a failure: `finish --run $RUN --abandon`, which removes staging and the uploaded key on the VM;
  - after a success: `finish --run $RUN`.
- **Restored data** is never removed automatically. `discard` is root's choice.
- **Test artefacts:**
  - `work/storage-restore-memory/runs` (1.1 MB of generated-data reports) and `logs/` can be deleted at any time;
  - nothing is staged on any VM;
  - every `sia-whole-restore-*` user unit from these tests is reset (`not-found`);
  - the two `/tmp` socket directories left by the interrupted and OOM-killed runs (`swr-bcn_ty84`, `brt-hq475ziu`)
    were removed;
  - older `/tmp/swr-test-*` directories from 10-22 17:58–18:01 local time predate this work and were left alone.
