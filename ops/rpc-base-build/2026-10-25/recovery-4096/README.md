## Root update — 20:15 UTC

Root ran the candidate tests (8/8) and dry source-rederivation successfully under the existing256MiB queue. Installed queue969d9273 at20:15:08, preserving the2560versionbackup. The foreground root-resume.py waits65s and then retries only admission code98 with distinct attempt logs; any started failure stops. Native compilation has not completed. Existing apps and VM allocations are unchanged;16GiB host floor remains. These files archive local execution paths and are not a standalone portable installer.

# M7 RUN 1, second resume: 4096 MiB queue candidate + RESUME (PREPARED; nothing installed or launched)

**Status: for root review.**
- **Not done:** no queue installed, no cap changed, no compile.
- **Not touched:** `build.sh`, the source, the patch, the cargo home, `target-1/`, `out-1/`, `logs/build-1.*`, and the
  whole of `recovery/` (including its logs and root's journal excerpt).
- **No result is claimed.**

## History (exact records; pinned by `resume-4096.sh`)

| attempt | cap | outcome | record |
|---|---|---|---|
| RUN 1 | 1792 | **kernel OOM** of `run-p3891230-i37474689.scope`, 1.7G peak (root journal, 12:57:03 local / 19:57:03Z); child guard -15; outer rc **143**; no guard receipt | `logs/build-1.out` `88a266b7`, `build-1.rc` 143, `recovery/logs/root-oom-journal.txt` `57da8c0b` |
| resume 1 (`recovery/build-1r1`) | 2560 | **memory-guard stop, rc 99**: process tree 2565 MiB > 2560 (at peak: rustc 2252, cargo 306); host minimum available 18811 (> floor) | `recovery/logs/build-1r1.out` `b3a2ba27`, `.guard` `202e157b`, `.rc` 99 |

**What resume 1 compiled:**
- It recompiled **only `base-node-core`**, its single `Compiling` line. The 1303 completed units were reused.
- The unit that exceeds the cap is therefore `base-node-core` (or the units after it), and rustc alone reached
  ≥ 2252 MiB.

**How much the remaining units and the final link need is unknown.** 4096 is root's choice, not a measured
requirement.

**State now:** `target-1/` retained (1303 fingerprints), `out-1/` empty, no `m7-release-nolto/base`.

## 1. Queue candidate (`queue-candidate/claude-test-queue.candidate-4096.py` `969d9273…`)

**Base:** the CURRENT installed `work/claude-test-queue.py` `5f752320…` (the 2560 version).

**Exactly two lines change:**
- `MAX_LARGE_MIB = 2560` becomes `4096`.
- The choices gain `4096` and keep `2560` and `1792`.

**The 16 GiB floor is unchanged.**

| admission | candidate | current (5f752320) |
|---|---|---|
| large 4096, small lane idle | 16384+4096+256 = **20736** | (4096 rejected) |
| large 4096 while a small job holds its lane | 16384+4096+256+256 = **20992** | (n/a) |
| small 256 joining an occupied large lane | 16384+256+256+4096 = **20992** | 19456 (under-reserves a 4096 job) |
| large 2560, small idle | 19200 (unchanged) | 19200 |
| large 2560 with a small job waiting (yield threshold) | **20992** | 19456 |

**Expected effects for root to weigh:**
- **Admission:** the host had about 20880 MiB available after the build. A 4096 job admits only if 20736 (idle) or 20992
  (small job active) is available. Otherwise it **waits up to 60 s and exits 98**. No app or VM is stopped, and the
  floor is not overridden.
- **Floor margin during the build:** if the build approaches 4096 MiB, host availability falls to about 16.8 GiB, only
  about 400 MiB above the 16384 floor.
  - Small queue jobs cannot join during the build (they need 20992).
  - Growth outside the queue could still trip the guard's floor stop (rc 99, "host available below floor").
- **Other workers:** the 20992 reserve applies to all large/small overlap, so more 98s while M10/A1/readiness work.

**Tests: `queue-candidate/test-queue-candidate-4096.py`.**
- **Derivation:** from the reviewed 2560 test `53ea2346` by counted substitutions of the constants only; same fixture
  recipe.
- **Fixture:** private locks, fixture `MemAvailable`, a 2 s deadline, and an argv-recording `systemd-run` stub. It runs
  inside the CURRENT queue at 256 MiB.
- **The 8 cases:**
  1. the pins and the 2-line diff;
  2. the choices: 3072 rejected, the current queue rejects 4096 (control), and 1792/2560/4096 start;
  3. large 4096 alone: 20736 starts with stub argv `MemoryMax=4096M` and guard 4096/16384, 20735 gives 98;
  4. large 4096 with a small job held: 20992 starts, 20991 gives 98;
  5. small joining an occupied large lane: 20992 starts, 20991 gives 98; control: the current queue starts at 19456;
  6. a second small job gives 98;
  7. large 2560: unchanged alone, and it yields at 20991 where the current queue starts;
  8. SIGTERM gives 143 and the exact child is gone.
- **NOT tested:** real cgroup and guard enforcement at 4096. No real 4096 MiB scope was created.

**Test status: NOT RUN by me.** My foreground attempt exited **98: "small allocation held"**, because another worker held
the small lane (`logs/queue-candidate-4096-attempt{1,2}-NOTSTARTED.*`: two single foreground attempts, both 98). I did not retry in a loop. Root runs it; command
0 below.

## 2. RESUME 2 (`resume-4096.sh` `0321879a…`, `resume-body-4096.sh` `09fda204…`, `make-resume-body-4096.py` `3b760157…`)

**The body:**
- `resume-body-4096.sh` == the reviewed `recovery/resume-body.sh` `d350fe78`, except that the derivation dir is
  `recovery-4096/derived-1-rN` (2 lines).
- It is re-derived from the **unchanged** `build.sh` `2ee8b8de` and compared at start.
- **Unchanged:** source pins and re-derivation, `SOURCE_DATE_EPOCH`, profile `m7-release-nolto`, remaps (the same
  `target-1`), flags, the cargo command and the bounded smokes.

**`resume-4096.sh` checks before the body:**
- **Pins:** every original file and the reviewed recovery files: `build.sh`, `dry-check.sh`, `env.sh`,
  `recovery/{make-resume-body.py, resume-body.sh, resume.sh}`, the new generator and the new body.
- **RUN 1:** rc 143, its log pin, no guard receipt, and root's journal (pinned, naming `oom-kill`).
- **Resume 1:** rc 99, out and guard pins, cap 2560, the guard-stop line, no cargo result, `EXIT 99`. Only that
  attempt is in `recovery/`.
- **Retained state:** target kept, `out-1` empty, no linked binary.
- **Collision-free new logs:** `recovery-4096/logs/build-1r<N>` with N ≥ 2, nothing of that name in `recovery/`, and
  for N > 2 the previous attempt must have ended non-zero.
- **Real run only:** the cgroup's `memory.max` must be exactly **4294967296**.

**Never** removes `target-1`, `out-1`, the cargo home or any log, and never writes into `recovery/`.

**DRY: NOT RUN by me.** It also exited **98 (small lane held)** on both attempts; see `logs/dry-r2-attempt{1,2}-NOTSTARTED.*`.

**What a pass will mean:** a **resumed RUN 1** with units from three sessions. It is NOT a fresh independent build and
NOT a provenance or reproducibility pass (that needs an independent RUN 2 match).

## Exact root commands (foreground)

```sh
W=/home/steven/Documents/Codex/2026-10-18/wo/work
PB=$W/rpc-production-final-20261025/finality-stage/client-integrity-next/production-build; R4=$PB/recovery-4096
# 0 tests and DRY on the CURRENT queue (256): both must end rc 0 before step 1
python3 $W/claude-test-queue.py --mib 256 --log $R4/logs/queue-candidate-4096.guard -- python3 $R4/queue-candidate/test-queue-candidate-4096.py > $R4/logs/queue-candidate-4096.out 2>&1; echo $? > $R4/logs/queue-candidate-4096.rc
python3 $W/claude-test-queue.py --mib 256 --log $R4/logs/dry-r2.guard -- env RUN=1 RESUME=2 DRY=1 unshare -rn bash $R4/resume-4096.sh > $R4/logs/dry-r2.out 2>&1; echo $? > $R4/logs/dry-r2.rc
# 1 install the candidate (root decision), atomically, with a backup
[ "$(sha256sum < $W/claude-test-queue.py | cut -c1-64)" = 5f752320e19ab092a0a320610ff1435ca90edf31f1fa086aed77f460d7bb58ce ]
[ ! -e $W/claude-test-queue.before-4096.py ] && cp -p $W/claude-test-queue.py $W/claude-test-queue.before-4096.py
cp $R4/queue-candidate/claude-test-queue.candidate-4096.py $W/claude-test-queue.py.new && mv -f $W/claude-test-queue.py.new $W/claude-test-queue.py
[ "$(sha256sum < $W/claude-test-queue.py | cut -c1-64)" = 969d9273e53c79abf8604c363daa58b41a462bc4b7f3d03d813980edb771f6f4 ]
#   then wait >= 65 s, so that no old-version job is still admitting against the 2560 reserve
# 2 RESUME 2
python3 $W/claude-test-queue.py --mib 4096 --log $R4/logs/build-1r2.guard -- env RUN=1 RESUME=2 unshare -rn bash $R4/resume-4096.sh > $R4/logs/build-1r2.out 2>&1; echo $? > $R4/logs/build-1r2.rc
```

**Outcomes:**
- **98** (not admitted): nothing ran. Retry later with `RESUME=3` and `build-1r3.*` names.
- **99** (cap or floor), **143**, or an OOM: stop; no further cap without a new root decision.
- **rc 0 with `## rc=0`:** `out-1/base`, its sha256 in the log, and `out-1/SHA256SUMS`.

**Rollback:** copy `claude-test-queue.before-4096.py` back, then confirm `5f752320`. The original is also kept as
`claude-test-queue.before-2560.py` (`b7de4344`). The build needs no rollback, since everything is retained.
