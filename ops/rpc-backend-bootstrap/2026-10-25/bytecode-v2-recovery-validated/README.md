# Bytecode checker receipt v2: memory-bounded test fixture, VALIDATED natively (2026-10-25)

## Result (root job `root-bytecode-v2-recovery-2259`; `receipts/`)

| item | value |
|---|---|
| outcome | **`## aggregate rc=0`**, rc 0 |
| tests | **`test result: ok. 23 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out`**, every one of the 23 named tests `ok` (`run-logs/patched.test.out`) |
| negative controls | **17/17 failed exactly as expected** (rc 101, the exact expected set, binary ≠ patched, `lib.rs` restored and sha-checked); `run-logs/control-*.test.out` |
| rebuilds | every test binary (patched + 17 controls) was **REBUILT** (`fresh=false` in Cargo's own record); see `run-logs/BUILD-JSON-ARTIFACTS.txt`, which records the excluded `*.build.json` by sha256 |
| patched test binary | `dae90e387d925e40f15befe2bf1ea599b6221f6fdbb28b4cb2f664d950ee4a07` (not included) |
| resources | the shared queue at the **same 1792 MiB** cap, offline (`unshare -rn`), one compiler job; guard **peak 702 MiB**, host minimum 21796 MiB (floor 16384) |
| precheck | rc 0: the original failure evidence, unchanged product, and both derivations (see below) |
| dependency closure | lock `91a9e762…` (base `5476069f` lock `f122da76` plus one entry), 648 verified packages, 367 compiled, all inside the closure |

## Scope (what this does and does not show)

**What it shows:** the checker's unit and fixture tests pass on synthetic MDBX databases that the tests themselves
create, and every disabled rule is caught by exactly its expected tests.
- **Read-only proof:** `v2_scan_leaves_every_byte_of_mdbx_dat_unchanged` reads the WHOLE fixture `mdbx.dat` before and
  after a scan, and asserts **byte-for-byte equality**.

**What it does not show:**
- **It is NOT a scan of a real node database.**
- **It is not a release:** a separate release job, root's `root-bytecode-v2-release-2303`, was still compiling when this
  was published. Its log is NOT included and **no release result is claimed**. Root reports that its receipt parser
  (11 tests) accepted this test receipt; the release preparation is published and updated separately (50cf).

## The fix: test fixture only (`FIXTURE-FIX.diff`)

**The original run's failure** (published, immutable, in commit `7d926055e`, `bytecode-v2-prepared/`; pinned again in
`stage/evidence/ORIGINAL-PINS.txt`):
- the default MDBX geometry (4 GiB growth step) made each fixture `mdbx.dat` a 4294967296-byte sparse file;
- the byte test read it twice into memory, giving a cgroup OOM at 1792 MiB;
- 20/23 tests were ok, there was no aggregate result, and rc was 143.

**The fix:** `stage/crate/src/tests.rs` `f1bd5c1c` = `stage/jobs/make-tests-fix.py` applied to the original `072a23a8`.
- **Small geometry:** every fixture DB is created, and reopened read-write, with the pinned reth-db `7134be3` API:
  `with_geometry_max_size(64 MiB)` and `with_growth_step(4 MiB)`.
- **Bounded size:** `assert_bounded` requires every fixture `mdbx.dat` to be `> 0` and `≤ 64 MiB`, and the byte test
  asserts it read the whole file.
- **Kept:** every test and every original assertion. No skip, no dependency change, no cap increase.

**Product UNCHANGED (byte-identical to the original v2 candidate):**
- `lib.rs` `ed9870e7c89b5b8f8ecc9d38ddbc36614dfdcde6fb13e91f1150612feb5312df`;
- `main.rs` `05dd717eb6da60ce38c9f852fe7656bb202f5ab985514001e72023eb192de25c`;
- `Cargo.toml` `e398c4f97e5f7fdd261a002ab705698f00a9fa086660f9909f42dfcc96e23fc8`;
- the control script, closure manifest and lock/artifact helpers.

**Job:** `stage/jobs/root-build-test-recovery.sh` `24bc6d5a` = `make-recovery-job.py` applied to the original job
`7c95ec5b`, with 3 counted insertions:
1. the read-only precheck;
2. a COPY of the ended original target for dependency reuse only;
3. a label.

**Kept from the original job:** a fresh `git archive` tree and member, the verified private cargo home, the 23 named
tests and the 17 exact controls.

## Contents

| path | what |
|---|---|
| `stage/` | the exact stage as run: `crate/` (`Cargo.toml`, `src/{lib,main,tests}.rs`), `control/disable_check.py`, `jobs/` (env, precheck, the two generators, the derived job, the unchanged helpers), `inputs/{STAGE-SHA256SUMS, closure-manifest.json}`, `evidence/` (original failure pins, the original receipt, the 20-ok log, the 3 journal OOM lines). The stage README is `STAGE-README-as-prepared.md`: the only `STAGE-SHA256SUMS` entry that does not verify here is `README.md`, because of that rename. |
| `run-logs/` | from the run: `patched.test.out`, `patched.build.err`, `control-*.test.out` (17), `control-*.build.err` (17), `cargo-tree.{txt,err}`, the generated `closure-manifest.json` (== `inputs/`), and `BUILD-JSON-ARTIFACTS.txt` |
| `receipts/` | `root-bytecode-v2-recovery-2259.{out,rc,guard}` |
| `FIXTURE-FIX.diff` | the original → recovery `tests.rs` diff |

**Excluded:** `build/` (tree, private cargo home, target, tmp), every binary, the `*.build.json` (recorded by sha256
only), and the release job's log.

## Reproduce (root, on the build host)

```sh
S=…/finality-stage/bytecode-v2-recovery    # the stage above, with the original ../bytecode-v2-validation present for the precheck
python3 …/work/claude-test-queue.py --mib 1792 --log $S/logs/root-build-test.guard -- unshare -rn bash $S/jobs/root-build-test-recovery.sh > $S/logs/root-build-test.out 2>&1; echo $? > $S/logs/root-build-test.rc
```

**What it needs:** the build host's pinned base repo, the M7 cargo home, the original v2 stage (its evidence and
ended target), and rust 1.96.0. Accept only `## aggregate rc=0`.

**Limitations:**
- dependency reuse from the copied target is incidental;
- the test binary is a debug test build; no release or reproducibility claim is made.
