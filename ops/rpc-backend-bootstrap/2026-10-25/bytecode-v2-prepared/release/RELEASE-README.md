# Bytecode checker v2: release-only runner (PREPARED; NOT run)

## Status

- **Tests:** root's v2 test job `root-bytecode-v2-native-2249` is **running or pending; no result yet**.
- **Release:** **NOT built.**
- **This stage holds only the runner and its pins.** It does not edit `bytecode-v2-validation` (source, logs, build or input hashes), v1 `bytecode-native-validation`, or A2. The A2 source pin `BYTECODE_CHECKER_V2_SHA256` stays `None`.

## Why a separate runner

`bytecode-v2-validation/jobs/root-build-test.sh` refuses an existing `build/`. So `RELEASE=1` cannot be re-run after the test job, and **must not** be used for that. This runner follows root's reviewed v1 pattern (`bytecode-native-validation/release/root-release.sh`) and **reuses the verified private `build/` of the v2 test job**: tree, cargo home and target. It adds only `target/release`.

## What `root-release.sh` requires before compiling (any failure: `## INVALID`, `## release rc=1`)

1. **Its own files** match `inputs/RELEASE-STAGE-SHA256SUMS`. Toolchain `rustc/cargo 1.96.0` exactly; no `CARGO_PROFILE_RELEASE_*` and no preset `RUSTFLAGS`.
2. **Test receipt pinned by root:** `inputs/PASSED-TEST-RECEIPTS.sha256` covers `logs/root-bytecode-v2-native-2249.{out,rc,guard}` and verifies.
3. **The test job is a complete pass** (`check_test_receipt.py`):
   - the final `## ` line is the single `## aggregate rc=0`;
   - no INVALID, failed, abnormal or missing marker;
   - exactly one `test result: ok. 23 passed; 0 failed`;
   - each of the **23 pinned test names** `ok` exactly once;
   - each of the **17 controls** with `rc=101 failing: <exact pinned set>` (read from the v2 stage's `disable_check.py` via `runpy`, which writes no bytecode) plus `failed exactly as expected`;
   - the pinned names and control order equal the v2 job's own lists;
   - the lock/closure line (`lockSha256 91a9e762…`, `problems=0`) and the "compiled graph inside the verified closure of 648" line;
   - `.rc` is `0`, the guard log ends `[memory-guard] exit=0`, and there is exactly one `[queue] EXIT 0`.

   The stage's own `logs/patched.test.out` must also show 23/23.
4. **The tested source, restored:**
   - v2 `STAGE-SHA256SUMS` is `051e8fcc…` and verifies;
   - the member `lib.rs` and `build/lib.rs.orig` are `ed9870e7…`, and `main.rs` is `05dd717e…`;
   - `diff -r crate/ member` is empty.
5. **The tested graph:**
   - `Cargo.lock` is `91a9e762…`;
   - the tree equals `git archive 5476069f` apart from `Cargo.lock`;
   - the workspace `[profile.release]` is exactly `{opt-level 3, lto thin, debug none, strip symbols, panic unwind, codegen-units 16}`;
   - there is no existing `target/release`;
   - the prepared closure is `e901720a…`, and `verify_inputs.py` over the private cargo home reproduces it byte-identically.

## Build (single compiler job, offline, `--locked`, `RUSTFLAGS=-C link-arg=-Wl,--threads=1` as in v1)

- `cargo tree` for the release graph, then `cargo build --release -p base-bytecode-check --bin base-bytecode-check --message-format=json`.
- **Artifact checks:**
  - **every** compiled package must be inside the verified closure, and **no** artifact may be `fresh`;
  - exactly one bin artifact under `target/release/`;
  - profile fields `opt_level 3`, no debug assertions, no overflow checks, not a test;
  - a successful `build-finished`.
- **After the build:** the lock and source are unchanged, and the v2 stage sums still verify. A usage smoke test (no argument) must be refused. The sha and size must be unchanged after the smoke test.
- **Output:** `release-logs/release-manifest.json` (format `base-bytecode-check-release/v2`): sha256, size, cargo profile fields, toolchain, lock, closure, lib/main sha, stage sums, the patched test-binary sha from the receipt, and `notTested`.

## Root steps (after 2249 finishes and passes)

```
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; R=$P/finality-stage/bytecode-v2-release
cd $P && sha256sum logs/root-bytecode-v2-native-2249.out logs/root-bytecode-v2-native-2249.rc logs/root-bytecode-v2-native-2249.guard > $R/inputs/PASSED-TEST-RECEIPTS.sha256
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2560 --log $R/root-release.guard -- unshare -rn bash $R/root-release.sh > $R/root-release.out 2>&1
```

- **Accept only `## release rc=0`.** Exit 98 means not started.
- **Writes:** `release-logs/` here, and `target/release` (plus any cargo-home extraction) inside the v2 private `build/`.

## Not verified here (marked for the actual root run)

1. **Untested runner code:** the receipt checker and the artifact parser have **not been executed**, by instruction (no execution). The cargo 1.96 `package_id` parsing (`…#name@version`) in particular is unverified.
2. **Fail-closed on mismatch:** a format mismatch makes the run INVALID; it is never accepted. Fix it by reviewed edits here, then re-pin `inputs/RELEASE-STAGE-SHA256SUMS`.
3. **Resources:** expected as for v1 (thin-LTO, `-j1`, 2560 lane); not measured.
