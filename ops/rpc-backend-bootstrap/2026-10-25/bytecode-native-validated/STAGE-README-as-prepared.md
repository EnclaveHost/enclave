# Bytecode-check native validation: PREPARED, NOT COMPILED, NOT RUN

This is the private stage for the bytecode-check helper; nothing has been built or run yet.
- **Done here:**
  - the source was audited against the pinned code;
  - Python helpers were dry-run on temporary copies;
  - shell syntax was checked;
  - the input sha256 values were computed.
- **Not done:** cargo/rustc invocation, queue use, SSH or live access, commit.
- **Frozen sources left alone:** `a2-a4-execution/`, the A2 publication, and the M7/M10 trees, builds and cargo homes were
  only read.
- **No production permission:** `OPEN_GAPS = ['bytecodes-content-unverified']` stays open until this job passes **and** a
  live run under root review passes.

## Layout
- **`crate/`**: the `base-bytecode-check` lib + bin.
  - Derived from the frozen `a2-a4-execution/bytecode-check`, with these fixes:
    - the import path (a **definite compile error** there: `reth_db_api::tables::{RawKey, RawTable}`, not `table`);
    - explicit features;
    - a cross-check of every accepted row against the pinned client decoder (`agrees_with_client`);
    - a `E_PADDING_SHORT_DUPN` class;
    - the scan moved into a testable `scan()`;
    - read errors are failures, never skips.
  - **Tests (13)** are in `crate/src/tests.rs`.
- **`jobs/root-build-test.sh`**: root's job. Shared settings are in `jobs/env.sh` (pins, private paths, `CARGO_BUILD_JOBS=1`).
- **`jobs/insert_lock_entry.py`**: adds exactly one `[[package]]` block to the copied lock. It was dry-run on a temporary
  copy of the base lock: the diff was exactly that block, inserted before `base-challenger`.
- **`jobs/verify_inputs.py`**: hashes the closure of 648 packages (632 registry, 16 git from `base/reth` `7134be3b`).
  - All 632 `.crate` sha256 values match the lock checksums, checked read-only against the M7 cache.
  - The result is `inputs/closure-manifest.json`.
- **`control/disable_check.py`**: 5 negative controls, each disabling one rule and expecting an exact set of failing tests.
- **`inputs/STAGE-SHA256SUMS`**: the job refuses to run if any stage file has changed.

## What the tests assert (assertion-only; no test relies on the checker's own model alone)
- **Real writer:** test rows are written by the **pinned client encoder** (`RawValue::new(reth_primitives_traits::Bytecode)`).
- **Every "harmful" forgery is first shown against the pinned client decoder.** Either it decodes it wrongly without
  panicking, or it panics (caught with `catch_unwind` in tests).
  - **Silently wrong decodes:**
    - forged JUMPDEST bits, in code and in padding;
    - executed non-zero padding;
    - tag-4 legacy bytes;
    - 7702 bytes stored as tag 2 (delegation lost);
    - trailing bytes;
    - short padding (UB risk; the client does not check it).
  - **Panics:**
    - a missing or short jump table;
    - tags 1 and 7;
    - malformed 7702 under tag 0;
    - L beyond the row;
    - O > L;
    - an empty tag-2 row;
    - a missing `original_len`.

  The checker must refuse each of these with its specific `E_*` code.
- **Canonical and random rows:** canonical rows must pass, and so must 1500 pseudo-random client-written codes. Every
  single read jump bit is flipped on a sample of positions (>10k flips), and each flip must be refused with `E_JUMPBIT`.
- **Padding classes:**
  - **DUPN/SWAPN/EXCHANGE endings:** revm 42 pads these one byte more. A row with one byte less is refused as
    `E_PADDING_SHORT_DUPN`; it is still a failure, and root reviews it.
  - **Other short padding:** refused as `E_PADDING_SHORT`.
- **Not failures:** extra table bytes, and bits past `bit_len`, are reported as non-canonical.
- **EIP-7702:** delegations follow `new_raw_checked`.
- **Code hash:** keccak of the original bytes must equal the key.
- **Account completeness:** a missing code row is counted; empty code and None are ignored.
- **Real MDBX** (`init_db` in a private `TMPDIR`, then the read-only `scan`):
  - forged rows and missing code are reported, keyed by hex;
  - `mdbx.dat` size and mtime are unchanged by the scan;
  - a clean DB is `ok`, and an empty table is never `ok`.
- **Controls:** each control must make **exactly** its listed tests fail (rc 101), with a rebuilt binary that differs from
  the patched one.

| control | rule disabled | must fail exactly |
|---|---|---|
| jumpbit | the stored-vs-fresh bit comparison | `forged_jump_bits…`, `mdbx_scan…`, `pseudo_random…` |
| padding | the `fresh_padded > l` check | `padding_shorter…` |
| client | the client cross-check | `client_cross_check…` |
| completeness | missing-row counting | `completeness_counts…`, `mdbx_scan…` |
| eip7702 | the tag-4 7702 requirement | `rows_the_client_misreads…` |

## Root command (after M10 finishes; foreground; offline)
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/bytecode-native-validation
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1792 --log $S/logs/root-build-test.guard -- unshare -rn bash $S/jobs/root-build-test.sh > $S/logs/root-build-test.out 2>&1
# later, separately, ONLY for a live-run candidate binary (not a test):
RELEASE=1 python3 .../claude-test-queue.py --mib 2560 --log $S/logs/root-release.guard -- unshare -rn bash $S/jobs/root-build-test.sh > $S/logs/root-release.out 2>&1
```
- **Pass:** `## aggregate rc=0`, with every step below succeeding.
- **Exit 98:** the job was not started, which is NOT a pass.

**Job steps, in order:**
1. **Inputs:** the toolchain is 1.96.0, the stage sums match, and the base repo is at `5476069f`.
2. **Private tree:** `git archive` into `build/tree`; the lock sha must equal `f122da76…`.
3. **Member:** copied into `etc/tools/base-bytecode-check`; the root `Cargo.toml` is NOT edited.
4. **Lock:** one entry inserted.
5. **Private cargo home:** `registry/index` + `registry/cache` + `git` are copied, about 1 G; `registry/src` is not copied.
6. **Closure check:** the closure manifest must equal `inputs/closure-manifest.json`.
7. **Resolution only (no compile):** `cargo tree --offline --locked`. Every compiled package must be inside the verified
   closure.
8. **Tests:** build at `-j1` and require that Cargo reports the test binary `rebuilt`; then 13/13 tests must be `ok`, by
   name.
9. **Controls:** run the 5 controls; `lib.rs` is restored and its sha checked after each.
10. **Lock unchanged:** `Cargo.lock` must not have changed at any point.

## Resource estimate (inferred from M7: workspace tests at `-j2` peaked at 1528 MiB; not measured for this crate)
- **Memory:** about 0.8–1.3 GiB at `-j1`; use the 1792 lane. The release build (thin-LTO) is about 1.5–2.5 GiB; use the
  2560 lane.
- **Time:** the test build (about 250–350 compiled crates, including the libmdbx C code and bindgen) takes 15–35 min. The
  6 later builds rebuild only this crate, a few min each. Release takes 30–60 min.
- **Disk:** about 1 G cargo home + 0.3 G tree + 2–4 G target, all under `build/` (884 G free).

## Clean retry / repro
- **Never reuse `build/`:** the job refuses to start if it exists. To retry, move it aside (`mv build build.failed-<UTC>`)
  and keep it and `logs/` as evidence. Don't delete them.
- **Same pinned inputs:** the job re-derives everything from the same pins, so a rerun is a reproduction.
- **Changes to any stage file** need `inputs/STAGE-SHA256SUMS` regenerated, a new review, and a note in the report.
- **Before the job:** the shared copy of the M7 cargo home must not be in use by a writer. It is only read.

## Known uncertainties (honest)
1. **Compile:** never compiled. API use was checked line by line against the pinned sources: `reth-db`/`db-api` at
   `7134be3`, `revm-bytecode 42.0.0`, `reth-primitives-traits 0.6.0`, `alloy-primitives 1.6.1`, `eyre 0.6.12`. A first
   run may still hit type or inference errors. Those are INVALID results that need a reviewed source fix, never a
   weakening.
2. **`--locked` with the inserted entry is unproven until step 7.**
   - **Static evidence for:**
     - all 6 dependencies have exactly one lock version;
     - the features requested are already activated: `reth-db-api` itself enables `reth-primitives-traits/reth-codec`,
       and the `revm-bytecode` lock entry already carries `phf`/`serde`.
   - **If it fails:** it is a BLOCKER, reported as-is. Don't drop `--locked`.
3. **Offline extraction:** `cargo tree` and the build must extract `.crate` files from the copied cache (offline). This
   is believed fine, but M7/M10 copied `registry/src`.
   - **If extraction fails offline,** the fallback is a reviewed job change that also copies `registry/src` (3.0 G),
     with the sha check kept.
4. **`reth-mdbx-sys` needs bindgen/libclang:** `/usr/lib/libclang.so.23.1` is present. Inside `unshare -rn` it is assumed
   to still load.
5. **MDBX tests:** `init_db` and the read-only open on `TMPDIR=build/tmp` are untested.
6. **Production checker run:** walking the real Base v2 datadir is NOT covered. That needs the release binary, a live run
   with clients stopped, and the A2–A4 `step_bytecodes` binding, all under root review.
7. **`E_PADDING_SHORT_DUPN` classification is heuristic:** a PUSH-data byte can look like DUPN. It is still a failure.
   If a real datadir shows such rows, root must decide; nothing is auto-accepted.
