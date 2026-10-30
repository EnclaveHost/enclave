# 1738: recovery-sequential-probe-stage/r1, a SMALL bounded read-only sequential timing of the original (FROZEN, NOT run)

**Status:** source frozen, NOT run.
- **Stage:** `recovery-sequential-probe-stage/r1/`, **`SHA256SUMS` sha256 `9e2201f27ccfc68940a7c709a2aa4472f2bdb367a730cb4941418a0977ec302e`** (6 files, read-only).
- **Not done by me:** tests, builds, live actions or commits, and **no read of the original**.
- **Executed by me:** `qemu-io --help` and `qemu-io -c "help read"` (local help only, no image opened); reading the qcow-allocation r4 job, pins and receipt logs; text edits; `ast.parse`; `bash -n`; `sha256sum`.
- **Disclosure:** the stage was first frozen as `88ca99dd…`. Before this report I found that the two job usage comments said `unshare -Urn`. Under that namespace `id -u` is 0, and the job's own unprivileged guard would refuse. I removed `unshare` from those two comments only (as in qcow-allocation r4) and re-froze. **Valid: `9e2201f2…`.**

| file | sha256 (prefix) | role |
|---|---|---|
| `seqprobe.py` | `93f1a82a…` | selection, guards, bounded reads, result |
| `tests/test_seqprobe.py` | `a5d63049…` | 5 tiny fixtures |
| `jobs/common.sh` | `ba8224f9…` | pins (= qcow-allocation r4: qemu-io `085e254e…`, qemu-img `3a57bce6…`); unprivileged; SUMS; no bytecode |
| `jobs/tests.sh` | `b81417cf…` | fixtures; gate `Ran 5 tests` + `OK`, empty stdout, no ResourceWarning/skip/fail |
| `jobs/root-real.sh` | `051319d8…` | real timing; requires the fixture PASS receipt |
| `README.md` | `5f1fbffb…` | |

## Design (no new framework, no NBD server, no mount)
**Ranges** (`select`):
- **The input:** root's authenticated map (`ext4-candidate-checksums.json` `map.extentList` `[logical, blocks, physical, unwritten]`; 4096-byte blocks; the filesystem at disk offset 0). It must be sha **`70180b22…`**, **9001** extents, **276,959,557** blocks, and non-overlapping (the same checks as qcow-allocation r4).
- **Eligibility:** extents with `unwritten == false` and length ≥ 64 MiB. **Unwritten or short extents are never sampled.**
- **Choice:** 4 picks, deterministic: the extent containing (or nearest) each 1/8, 3/8, 5/8, 7/8 point of the eligible physical span. Each pick is a 64 MiB range **wholly inside** its extent, aligned to 1 MiB where the extent allows.
- **Refusals** (rather than shrinking, splitting or reusing): pairwise separation under 1 GiB, fewer than 4 eligible extents, or an aggregate over 256 MiB.

**Reads** (`run_ranges` / `run_bounded`):
- **The command:** for each range, one pinned `/usr/sbin/qemu-io -r --image-opts driver=qcow2,file.driver=file,file.filename=<orig>,file.locking=off,read-only=on -c "read <virtualOffset> 67108864"`.
- **No data is printed:** there is no `-v`, so qemu-io prints only `read N/N bytes at offset X` and its own rate line. `-C` was avoided because it prints CSV without that line, and the completeness check needs it.
- **Bounds:**
  - concurrency 1;
  - each process in its **own process group**: 45 s, then TERM to the group, +5 s, then KILL. Signals go only while the leader is our unreaped child, so there is no PID reuse; it is always reaped, and any group leftover is killed;
  - a range whose worst case cannot fit in the **240 s total budget** is skipped, never started;
  - aggregate ≤ 256 MiB.
- **Each row records:** rc, seconds (monotonic, including qemu-io start and image open), `timedOut`, `groupEmpty`, a bounded stdout/stderr tail (≤ 4 KiB, timings only), and MiB/s (only when complete).

**The original** (`real`):
- **Before:** the pinned qemu-io sha; the production manifest pinned (`a2843215…`, base backing `discard=ignore`, as in r4); the coverage sha; the original on an **ST_RDONLY** mount, not a symlink, not writable.
- **The refusal:** **if any other process's command line names `base-origin.qcow2`** (a VM, a peer server, anything), nothing is read.
- **Identity** (dev, ino, size, mtime_ns, ctime_ns) is taken before **and** after.
- **After:** the namers are re-listed and reported.
- **Result:** `result.json` (0600, create-exclusive).

**Exit codes:**

| rc | meaning |
|---|---|
| 0 | timings written |
| 3 | refused, nothing read |
| 4 | identity changed, a group left over, or a failure after reads began: STOP |

**Page cache: NOT controlled.** There is no cache drop and no O_DIRECT (`-n`): ntfs-3g O_DIRECT support is doubtful, and dropping caches needs root. A range already cached by an earlier reader (e.g. probe 1720's faulted pages) times as cached, so `pageCacheControlled: false` is recorded.

**What this is not:** **not** an integrity check, and **not** a whole-copy or validation ETA. Four 64 MiB samples say nothing reliable about 1.13 TB, fragmentation or contention. **No cold throughput is claimed.**

## Fixtures (5; root runs them)
1. **Selection:** deterministic; 4 ranges, each wholly inside a **written** extent; 1 MiB aligned; ≥ 1 GiB apart. The map mixes written 128 MiB extents, short extents and big **unwritten** ones.
2. **Refusals:**
   - only unwritten or short eligible extents ("written extents");
   - overlapping extents;
   - malformed extents (a non-bool `unwritten`, negative blocks);
   - crowded extents that cannot be 1 GiB apart;
   - more than 256 MiB aggregate.
3. **A read-only `qemu-io` read of a tiny known-pattern qcow2** (8 MiB, made with `qemu-img convert`, 0444): two 1 MiB reads complete with rc 0 and a rate; **the pattern text never appears in the captured output**; the fixture's sha256 is unchanged; the argv carries `-r` and `read-only=on`.
4. **Owned timeout cleanup:**
   - a child plus a background child: TERM ends the group;
   - a TERM-ignoring group: KILL after the grace period;

   in both cases `groupEmpty` and the run finishes in under 15 s. An over-aggregate request is refused before anything runs.
5. **The original guard:** a process whose command line names a fixture image is listed, then disappears once it is killed. A writable file on a writable filesystem is refused as "the original".

## Root commands
**Fixtures first** (512 lane; never touches the original):
```
bash jobs/q-exit-status.sh seqprobe-r1-tests 512 bash recovery-sequential-probe-stage/r1/jobs/tests.sh
```
Expect `## PASS (5)`.

**Then the real timing.** It refuses unless `logs/seqprobe-r1-tests.rc` = 0, and also if anything names the original (the overlay session and the peer server must be closed):
```
bash jobs/q-exit-status.sh seqprobe-r1-real 512 bash recovery-sequential-probe-stage/r1/jobs/root-real.sh
```
**Bounds:** at most 4 × (45 + 5) s inside a 240 s budget, under `timeout -k 10 300`.
**Memory:** qemu-io holds one 64 MiB buffer, well inside the 512 lane; the queue keeps the 16 GiB floor.

## Corrections to 1734 (root's)
- **The 48 days was arithmetic, NOT an ETA:** 276,959,557 pages at the observed 66 faults/s.
- **The history state:** it is the r5 **metadata reuse** finding (only metadata recoverable from the journal), not a generic "BLOCKED".
- **No proven split** between FUSE and HDD latency exists. The 15 ms per fault is an observed average only; its attribution was inference. This probe measures **sequential** reads of the original through qemu-io only, so it also does not prove the split.
