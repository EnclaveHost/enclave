## Root execution update — 20:09 UTC

The 2560 MiB queue was installed at20:06:49 after review. Resume began at20:08, preserved completed objects, and stopped with code99: process-tree RSS2565 MiB exceeded2560 (rustc2252+cargo306). Host available memory remained at least18811 MiB. No artifact was produced. The following prepared instructions and test receipts are historical; a larger bounded allocation is under separate review. No application or VM allocation changed. See root-resume for unmodified execution evidence.

# M7 RUN 1 memory recovery: 2560 MiB queue candidate + RESUME script (PREPARED; nothing installed or launched)

**Status: for root review.**
- **Not done:** the queue is not installed, the big cap is not changed, and no compile was run.
- **Not touched:** `build.sh`, the source, the patch, the cargo home, `target-1/`, `out-1/` and `logs/build-1.*`.

## What failed (root's facts; recorded, not re-derived)

**Root journal, 19:57:03.**
- `run-p3891230-i37474689.scope` hit a **kernel OOM** at about 1.7G peak under the 1792 MiB cap.
- The child guard exited -15 and the outer process 143. There is **no guard receipt**.
- It was not an external termination.

**State checked read-only here** (`logs/dry-r1.out`):
- `logs/build-1.rc` = `143` (`9d9b1872…`);
- `logs/build-1.out` (`88a266b7…`):
  - its first line is `[queue] START … cap=1792MiB`;
  - its last line is `[queue] EXIT -15`;
  - it has no `## cargo build rc=` line;
  - the last unit started is `base-node-core`; 792 `Compiling` lines in all;
- no `logs/build-1.guard`;
- `target-1/m7-release-nolto/` retained, with 1303 fingerprints;
- `out-1/` empty: no artifact, and no `m7-release-nolto/base`.

**Copies:** the failed RUN 1 log and rc are copied unchanged to the publication's `failed-run-1/`. The originals stay in
place.

## 1. Queue candidate (`queue-candidate/claude-test-queue.candidate.py` `5f752320…`)

**Base:** the CURRENT `work/claude-test-queue.py` `b7de4344…`.

**Exactly two lines change:**
- `MAX_LARGE_MIB = 1792` becomes `2560`.
- `--mib` choices gain `2560`, and keep `1792`.

All other logic, floors and the guard invocation are unchanged.

**Consistent reservation** (`floor 16384` + `cap` + `256 headroom` + reserved):

| admission | candidate | current |
|---|---|---|
| large 2560, small lane idle | 16384+2560+256 = **19200** | (2560 rejected) |
| large 2560 while a small job holds its lane | 16384+2560+256+256 = **19456** | (n/a) |
| small 256 joining an occupied large lane | 16384+256+256+2560 = **19456** | 18688 (reserves only 1792: **under-reserves a 2560 job**) |
| large 1792, small idle | 18432 (unchanged) | 18432 |
| large 1792 while a small holds its lane (yield threshold) | **19456** (stricter) | 18688 |

**Side effects for root to weigh.** The large-lane reserve rises for ALL jobs, so:
- small jobs that join a running large job need 19456 instead of 18688;
- any large job with a small job waiting yields below 19456.

Host availability is about 20 GiB, so the margin is about 1.1–1.4 GiB. Exit 98 (not started) will be more frequent
while M10, A1 or readiness jobs are active.

**Tests:** `queue-candidate/test-queue-candidate.py` (`53ea2346…`) gave **8/8 PASS**, rc 0, peak 46 MiB
(`logs/queue-candidate.{out,guard,rc}`).
- **How it ran:** inside the CURRENT queue at 256 MiB. It used test-only clones: private lock files, a fixture
  `MemAvailable`, a 2 s deadline, and `systemd-run` replaced by an argv-recording stub.
- **Negative controls:**
  - the boundaries one MiB below each threshold give 98, with nothing started;
  - the current queue rejects 2560;
  - the current queue under-reserves at 18688;
  - a second small job gives 98.
- **Also covered:**
  - child exit codes propagate (7);
  - the stub argv shows `MemoryMax=2560M MemorySwapMax=0`, guard `--max-rss-mib 2560 --floor-available-mib 16384`;
  - SIGTERM gives 143, and the exact recorded child pid is gone.

**Earlier failing run:** `logs/queue-candidate-run1-FAILED.*`. Two test defects caused it, both fixed before the passing
run:
- test 1 expected an indentation that the source does not have;
- test 8 used a host-wide `pgrep` that matched an unrelated process.

**NOT tested:** the real kernel cgroup limit and memory-guard enforcement at 2560 MiB. No real 2560 MiB scope was created.
**Whether 2560 MiB is enough for the remaining units and the final link is unknown.**

## 2. RESUME (`resume.sh` `6c9c5e52…`, `resume-body.sh` `d350fe78…`, `make-resume-body.py` `f452b521…`)

**How the body is made:**
- `resume-body.sh` is derived from the **unchanged** `build.sh` `2ee8b8de…` by `make-resume-body.py`, using 11 counted
  line substitutions; each anchor must occur exactly once.
- `resume.sh` re-derives it and refuses any difference.

**What the substitutions change:**
- the fixed `production-build` location (the body lives in `recovery/`);
- RUN 1 only;
- "target/out must be new" becomes the retained-target and no-artifact checks;
- the source re-derivation goes to `recovery/derived-1-rN` instead of `out-1/derived`;
- the DRY branch no longer runs `rm -rf "$OUT"`;
- two echo texts mark the result as a RESUMED RUN 1.

**Everything else is byte-identical to RUN 1:**
- the pins, toolchain, source diff, source manifest `d8078bdf`, and reth checkout checks;
- profile `m7-release-nolto`, `SOURCE_DATE_EPOCH`;
- RUSTFLAGS/CFLAGS remaps (the same `target-1`, so the same `/target` remap);
- `CARGO_BUILD_JOBS=1`, the cargo command, the artifact facts and the bounded smokes.

**What cargo does on resume:** it keeps every unit whose fingerprint was written and rebuilds only unfinished ones,
including the unit killed mid-compile.

**`resume.sh` checks before the body runs:**
- the stage pins: `build.sh`, `dry-check.sh` `7a373ccb`, `jobs/env.sh` `cd1c6b56`, the generator and the body;
- the failed RUN 1 state above;
- new log names: `recovery/logs/build-1r<N>.*`; for attempt N > 1 the previous attempt must have ended non-zero;
- an optional `JOURNAL=<root's excerpt>`, which must name the OOM scope; it is hashed in the log;
- for a real run: the cgroup's `memory.max` must be exactly 2560 MiB (2684354560).

**Never removed:** `target-1`, `out-1`, the cargo home and all logs.

**DRY (`logs/dry-r1.out`): rc 0, peak 37 MiB, via the current queue at 256.**
- It ran every pre-compile check and the real source re-derivation, which matched.
- **Nothing was compiled**, and `target-1`/`out-1` were untouched (`out-1` is still empty).

**What a pass of the resume will mean:** a **resumed RUN 1** whose units come from two sessions in the same target.
- It is **not** a fresh independent build.
- It is **not** a provenance or reproducibility pass. That still needs an independent RUN 2 match.

## Exact root commands (nothing here was run except the 256 MiB DRY and tests)

```sh
W=/home/steven/Documents/Codex/2026-10-18/wo/work
PB=$W/rpc-production-final-20261025/finality-stage/client-integrity-next/production-build; R=$PB/recovery
# 1 queue (root decision). Install atomically; keep the backup.
[ "$(sha256sum < $W/claude-test-queue.py | cut -c1-64)" = b7de4344154fdd9f4e000059cc0d130426e67d5a34474cc714407c2f7e656c00 ]
[ ! -e $W/claude-test-queue.before-2560.py ] && cp -p $W/claude-test-queue.py $W/claude-test-queue.before-2560.py
cp $R/queue-candidate/claude-test-queue.candidate.py $W/claude-test-queue.py.new && mv -f $W/claude-test-queue.py.new $W/claude-test-queue.py
[ "$(sha256sum < $W/claude-test-queue.py | cut -c1-64)" = 5f752320e19ab092a0a320610ff1435ca90edf31f1fa086aed77f460d7bb58ce ]
#   then wait >= 65 s, so that no old-version job is still in its admission loop with the 1792 reserve
# 2 optional DRY again (no compile)
python3 $W/claude-test-queue.py --mib 256 --log $R/logs/dry-r1b.guard -- env RUN=1 RESUME=1 DRY=1 unshare -rn bash $R/resume.sh > $R/logs/dry-r1b.out 2>&1; echo $? > $R/logs/dry-r1b.rc
# 3 RESUME, foreground (optionally add JOURNAL=<path to root's journal excerpt> after RESUME=1)
python3 $W/claude-test-queue.py --mib 2560 --log $R/logs/build-1r1.guard -- env RUN=1 RESUME=1 unshare -rn bash $R/resume.sh > $R/logs/build-1r1.out 2>&1; echo $? > $R/logs/build-1r1.rc
```

**Outcomes:**
- **98** (not started): nothing ran. Retry with `RESUME=2` and `build-1r2.*` names.
- **99, 137/143, or OOM again:** stop. Do not raise the cap without a new root decision.
- **rc 0 with `## rc=0`:** the artifact is in `out-1/base`, its sha256 is in the log, and `out-1/SHA256SUMS` is written.

**Queue rollback:**

```sh
cp -p $W/claude-test-queue.before-2560.py $W/claude-test-queue.py
```

Then confirm the sha is `b7de4344…`. The build needs no rollback: everything is retained, and the failed attempts'
logs are kept.
