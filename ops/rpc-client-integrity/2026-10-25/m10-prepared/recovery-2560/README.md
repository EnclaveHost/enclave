# M10 tests: resume at 2560 MiB (PREPARED; DRY and refusal tests PASSED; real run NOT launched)

## The failure being resumed (kept unchanged in `../logs/`)

**Run:** root attempt `root-after4096-test-m10-1`, launched by `root-run-after-4096.py` with `CARGO_BUILD_JOBS=1` and
`RUSTFLAGS='-C link-arg=-Wl,--threads=1'` at cap 1792. Exit **99** at 21:15:38.

**Engine phase:** completed for real.
- `base_consensus_engine-22bbca68e14337e9` was REBUILT, sha256 `b21d891a…`.
- **152 passed, 0 failed**, including the 10 named M10 anchor tests (`logs/engine.test.out` `1b3d5d6b`).

**Node phase:** stopped in its test build, while compiling `base-node-core`.
- The guard stopped it at tree RSS 1818 MiB > 1792 (rustc 1483, cargo 331). The host minimum was 18654.

**Not yet run:** the node, sequencer, SafeDB, derivation and CLI phases, and both controls. **No M10 result is claimed
beyond the engine phase.**

**Records:**
- the `.out`, `.guard` and `.rc` of that attempt are pinned (`125ce2a1`, `02b66f4b`, 99);
- `node.build.err` is pinned (`46c807e1`);
- the original engine test binary is still present with sha `b21d891a` (checked in the DRY).

## Why the original job cannot simply be rerun

`jobs/root-test-m10.sh` (`51ffbda2`) refuses an existing `build/`, and `build/` must be kept so that its dependencies
can be reused.

## The resume (`resume-2560.sh` `75155500`, `resume-body.sh` `4064654e`, `make-resume-body.py` `005e22d4`)

**How the body is made:** `resume-body.sh` = the pinned original job with **11 counted substitutions in step 0 only**.
`resume-2560.sh` re-derives it and compares.

**Byte-identical to the original:**
- everything from `phase()` onward: every phase, filter and `--test-threads=2`;
- every named M10 test and both expected control failure sets;
- `cargo clean -p <crate>` before each build, and the **fresh=false** requirement for each test binary;
- the control-binary != patched-binary checks.

**What step 0 does now:**
1. Uses a new log directory: `recovery-2560/logs/run-<N>/`. The old logs are kept.
2. Requires the retained `build/` (tree, control, private cargo home, target) instead of creating it.
3. Checks the base repo HEAD `5476069f`, the M7 patch `e9dfb8c6` and the M10 patch (sha file), as the original does.
4. Regenerates pristine `git archive 5476069f` + M7 + M10 (with `git apply --check`) and its control (the frozen
   `disable-anchor-checks.py`) in a private `recovery-2560/regen-<N>/`. It then requires:
   - **build/tree == regenerated tree** and **build/control == regenerated control** (`diff -r` empty);
   - the original "exactly 3 lines differ" check on both pairs.
5. Requires the private cargo home's crate archives (`registry/cache`) to equal the M7 cargo home's. This is not a
   check of the extracted sources; `--locked --offline` is unchanged.
6. Removes only its own `regen-<N>`. `DRY=1` stops here.
7. Requires `CARGO_BUILD_JOBS=1` and exactly the original `RUSTFLAGS`, so there is one compiler and one link thread and
   the Cargo fingerprints are the same (completed dependencies are reused).

**What the wrapper also requires:**
- every frozen pin in `root-input-pins.json` `ead48b1d` (8/8);
- the failed attempt's records;
- new attempt names;
- for a real run, the cgroup's `memory.max` == **2684354560** (2560 MiB).

**The queue and patches are not modified.** 2560 is within the installed queue's maximum of 4096. Admission needs 19200
MiB when idle, or 19456 with a small job running.

## Evidence run here (shared 256 MiB queue, foreground)

**`logs/dry-1.*`: DRY rc 0, peak 37 MiB.**
- All frozen pins OK.
- `build/tree` == regenerated 5476069f+M7+M10; `build/control` == regenerated control.
- The control differs by exactly 3 lines; the crate archives == M7.
- **Nothing compiled;** `build/` is untouched. `logs/run-dry1/` was created empty by the DRY.

**`logs/refusals.*` (`test-refusals.sh` `9c5d8c7e`): 7/7, rc 0.** The tooling refuses each of these before cargo runs:
1. a changed job;
2. a tampered body (a different `--test-threads`);
3. missing `RUSTFLAGS`;
4. two compiler jobs;
5. a DRY that would consume a real attempt number;
6. a real run outside a 2560 MiB cgroup (`memory.max` 268435456 seen);
7. and no attempt directory is left behind.

## Exact root command (foreground)

```sh
M=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m10-bootstrap; R=$M/recovery-2560
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2560 --log $R/logs/resume-1.guard -- \
  env CARGO_BUILD_JOBS=1 RUSTFLAGS='-C link-arg=-Wl,--threads=1' RESUME=1 unshare -rn bash $R/resume-2560.sh \
  > $R/logs/resume-1.out 2>&1; echo $? > $R/logs/resume-1.rc
```

**Outcomes:**
- **Pass:** `## aggregate rc=0` and rc 0. The per-phase logs are in `logs/run-1/`.
- **98** (not admitted): nothing ran, but a `logs/resume-1.rc` file is written. Retry with `RESUME=2` and `resume-2.*`
  names; the previous attempt must have ended non-zero.
- **99** (guard) or **1** (a check or test failed): stop and review. Do not raise the cap without a decision.

**The engine phase runs again:** `cargo clean -p` and a fresh=false rebuild, so a fresh engine artifact is produced and
recorded. Its sha may or may not equal `b21d891a`; that comparison is informative only.

**Not established until root runs it:** that 2560 MiB suffices for the node, CLI and control builds. The earlier 1818
MiB peak gives about 740 MiB of headroom, but that is not a measurement of the later phases.
