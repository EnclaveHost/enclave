# Bytecode checker v2: release-only runner for the MEMORY-RECOVERY test job (PREPARED; NOT run)

## Status

- **Test job:** root's `root-bytecode-v2-recovery-2259` (1792 MiB) is **running; no result yet**.
- **Release:** NOT built.
- **This stage has not been executed:** no runner, checker or test here has run, by instruction.
- **Not edited:** `bytecode-v2-recovery`, `bytecode-v2-validation` (its OOM-143 attempt is kept), `bytecode-v2-release` (stays as it is and refuses) and the published `bytecode-v2-prepared` (`7d926055e`).
- **A2:** the source pin stays `None`.

## Why

- `../bytecode-v2-release/root-release.sh` is bound to the original 2249 attempt, which failed with an OOM and rc 143. It refuses by design, and is **not** edited or reused.
- This runner is that runner **adapted only to the recovery job**:
  - environment `bytecode-v2-recovery/jobs/env.sh`;
  - the recovery `build/` (tree, cargo home, target);
  - receipts `logs/root-bytecode-v2-recovery-2259.{out,rc,guard}`;
  - pins:

    | Item | sha256 |
    |---|---|
    | Recovery stage sums | `4a58ecfd…` |
    | Product (identical to the original v2) | `lib.rs` `ed9870e7`, `main.rs` `05dd717e`, `Cargo.toml` `e398c4f9`, controls `26f7e4d0` |
    | Fixture-only `tests.rs` | `f1bd5c1c` |
    | Recovery job | `24bc6d5a` |
    | Lock | `91a9e762` |
    | Closure | `e901720a` |

## Refusals before any compile (all `## INVALID` → `## release rc=1`)

1. **Own pins:** `inputs/RELEASE-STAGE-SHA256SUMS` (README, checker, runner, tests) must verify. The exact toolchain must be in use, with no profile or RUSTFLAGS override.
2. **Receipt pins:**
   - `inputs/PASSED-TEST-RECEIPTS.sha256` (written by root) must list **exactly** the three 2259 files and **no** 2249 file, and must verify.
3. **`check_test_receipt.py`** must find **all of**:
   - **Not the original attempt:** the out-file sha is not the original failed `2a5aca4e…`.
   - **The recovery job ran and passed its precheck:** the recovery patched-step label and the three precheck lines are present, ending with `## recovery precheck rc=0`.
   - **Aggregate:** the single final `## aggregate rc=0`, with no INVALID, REFUSE, failed, abnormal or missing marker.
   - **Tests:** exactly one `test result: ok. 23 passed; 0 failed`; each of the 23 pinned names `ok` exactly once; no other test line.
   - **Controls:** each of the 17 controls appears once, as `rc=101 failing: <exact pinned set>`, plus `failed exactly as expected`. The pinned lists equal the recovery job's own `TESTS` and loop.
   - **Graph:** the lock line with `problems=0`, and the graph-inside-closure line.
   - **Patched test binary:** one sha line.
   - **Exit records:**
     - the job's last queue record is the only `[queue] EXIT 0`;
     - the **outer rc file is 0**;
     - the guard log ends `[memory-guard] exit=0`.
4. **The recovery stage's own state:** its sums are `4a58ecfd`; its `logs/patched.test.out` is 23/23; the tests, `Cargo.toml`, control file and job hashes equal the pins.
5. **Restored source:** the member `lib.rs` and `build/lib.rs.orig` are `ed9870e7`; `main.rs`, `tests.rs` and `Cargo.toml` are pinned; `diff -r crate member` is empty.
6. **Tested graph:**
   - the lock is `91a9e762`, and the tree equals `git archive 5476069f` apart from `Cargo.lock`;
   - the workspace `[profile.release]` is exactly as pinned;
   - no `target/release` exists;
   - the closure manifest is reproduced from the private cargo home.

## Build and outputs

The build is unchanged from `../bytecode-v2-release`:
- one compiler job, offline, `--locked`, linker threads 1;
- every compiled package must be inside the closure, and none may be fresh;
- one release bin, with the profile fields checked;
- the lock, source and stage sums must be preserved;
- the usage smoke test must refuse, and the sha and size must be stable afterwards.

**Outputs:**
- **`release-logs/release-manifest.json`** (`base-bytecode-check-release/v2`). It records `testsRsSha256`, `recoveryJobSha256`, `testReceiptOutSha256` and `patchedTestBinarySha256`, and notes that 2249 is not used.
- **Writes outside this stage:** `target/release` inside the recovery private `build/`, written only after 2259 ends.

## Tests (prepared; root runs them; no queue needed: pure Python, reads only)

```
python3 -I -B /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/bytecode-v2-release-recovery/test/test_check_test_receipt.py
```

- **Pass case:** a **synthetic** full-pass transcript in the recovery job's print format must be accepted. This shows what the checker accepts; it is not evidence of a pass.
- **Adversarial refusal cases:**
  - **Original attempt substituted:** **root's real 2249 OOM receipt** (from `bytecode-v2-recovery/evidence/`), and the original non-recovery job label.
  - **Outer rc and guard:** outer rc 143/1/empty/98; a guard log of exit -15, empty, or missing.
  - **Queue records:** still running, killed (`EXIT -15`), or two EXIT records.
  - **Aggregate:** aggregate 1, missing or doubled; an INVALID line after the aggregate; bad markers.
  - **Precheck:** precheck rc 1, a missing section, a missing recovery label.
  - **Tests:** a test missing, FAILED or doubled; 22 passed; one failed; two summaries; an extra ignored test.
  - **Controls** (`completeness`/`checkpoints`/`scanned`/`framing`): rc 0, one test fewer, one more, an empty set, not confirmed, absent, doubled.
  - **Lock and graph lines:** another lock, closure problems, no graph line, no binary sha.
  - **Stage lists:** a stage whose job `TESTS` or control order was tampered with.
- **Runner pins:** each pin must equal the recovery stage files; the product pins must equal the original v2 product; the runner must use 2259 and never the original stage; the release sums must cover exactly the 4 files.

## Root steps (only after 2259 ends with a full pass)

```
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; R=$P/finality-stage/bytecode-v2-release-recovery
python3 -I -B $R/test/test_check_test_receipt.py
cd $P && sha256sum logs/root-bytecode-v2-recovery-2259.out logs/root-bytecode-v2-recovery-2259.rc logs/root-bytecode-v2-recovery-2259.guard > $R/inputs/PASSED-TEST-RECEIPTS.sha256
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2560 --log $R/root-release.guard -- unshare -rn bash $R/root-release.sh > $R/root-release.out 2>&1
```

- Accept only `## release rc=0`.
- **Receipt file names:** if root's 2259 receipt files are named differently, the runner refuses. Adapt it by a reviewed edit and re-pin; never by substituting another run.
