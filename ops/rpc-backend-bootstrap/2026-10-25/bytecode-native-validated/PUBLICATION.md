# base-bytecode-check: native unit validation PASSED (root run 2202); release build PENDING; no live DB run

This is the source and evidence only.
- **Excluded:** build cache, cargo home, target directory, binaries, keys.
- **Unchanged:** OPEN_GAPS (`bytecodes-content-unverified`) and the published `a2-a4-prepared/`. There is **no** production
  permission.

## Actual result (root, `logs/root-bytecode-native-2202.*` → `evidence/`)
- **Run:** offline (`unshare -rn`), queue lane 1792, `CARGO_BUILD_JOBS=1`, `rustc 1.96.0 (ac68faa20 2026-05-25)`.
- **Resource use:** peak 684 MiB RSS (rust-lld 301 MiB), host minimum 19680 MiB available. The `.rc` file is 0, and the
  log ends with `## aggregate rc=0`.
- **Lock and resolution:**
  - the private `git archive 5476069f` plus the member at `etc/tools/base-bytecode-check`;
  - `Cargo.lock` = the base lock (`f122da76…`) + ONE inserted entry, giving `91a9e7626b5f361faed8f5226268ffae177970575e8ecd243d09cb077bd23bab`;
  - `--locked` held throughout.
- **Closure:** 648 packages, all 632 registry `.crate` sha256 values equal to the lock checksums. 367 compiled packages,
  all inside that closure (`evidence/cargo-tree.txt`).
- **Tests:** the patched test binary (`8f59bea2…6e39`) was **rebuilt** (fresh=false) and passed **13/13**
  (`evidence/patched.test.out`).
- **Controls (5),** each with a rebuilt binary that differs from the patched one, rc 101, and **exactly** the expected
  failing tests:

  | control | rule disabled | exact failing tests |
  |---|---|---|
  | jumpbit | jump-bit comparison | forged_jump_bits, mdbx_scan, pseudo_random |
  | padding | padding-length check | padding_shorter |
  | client | client cross-check | client_cross_check |
  | completeness | missing-code counting | completeness_counts, mdbx_scan |
  | eip7702 | tag-4 7702 requirement | rows_the_client_misreads |

- **Source restored after the controls:** the member `lib.rs` = `build/lib.rs.orig` = `crate/src/lib.rs` = `739c3245…`.
- **Failure history:** none in this lane. It was prepared once and passed on root's first run, so no failed logs exist.
  The frozen A2–A4 `bytecode-check/` source was never compiled.

## What the tests are (and are not)
**Tested:**
- **Rows:** rows come from the pinned client encoder. Each harmful forgery is proven against the pinned client decoder
  (`reth-primitives-traits 0.6.0`), either as a silent misdecode or as a panic.
- **Coverage:**
  - malformed rows;
  - canonical padding;
  - jump tables (1500 pseudo-random codes, >10k bit flips);
  - EIP-7702;
  - code hash;
  - account completeness;
  - a real MDBX DB built in a temp directory and scanned read-only, with `mdbx.dat` unchanged.

**NOT tested:**
- any real or live Base datadir;
- the release binary;
- runtime on mainnet volume.

## Fixes vs the frozen A2–A4 helper (`finality-stage/a2-a4-execution/bytecode-check`, not edited)
1. **API import (definite compile error there):** `RawKey`/`RawTable` are in `reth_db_api::tables`, not `table`, at reth
   `7134be3`.
2. **Features:** requested explicitly (`reth-primitives-traits/reth-codec`; `std` for alloy-primitives, revm-bytecode and
   serde_json). All were already active in the workspace lock, which `--locked` confirmed.
3. **Client cross-check:** every accepted row is also decoded by the pinned client decoder and must execute identically.
4. **Failures:** read errors are failures, never skips. Each failure carries a coded `E_*` reason.

## Known limitation: conservative padding false positive
- **The rule changed in `revm-bytecode 42.0.0`:** `analyze_legacy` pads code ending in DUPN/SWAPN/EXCHANGE (`0xe6..0xe8`,
  or such an opcode just before a final STOP) one byte more than older revm did.
- **Effect on old rows:** a row written by an older client can have one byte less padding. The client does NOT check
  padding (`unsafe new_analyzed`), so the row decodes silently.
- **The checker refuses it** as `E_PADDING_SHORT_DUPN`, and it still counts as a failure (`paddingShortDupn` count).
- **Probable false positive before Amsterdam:** EIP-8024 is not active on Base, so these opcodes have no immediate.
  But the checker never auto-accepts the row.
- **Imprecise classification:** the check looks at the last bytes, so PUSH data can look like DUPN. Any such row in a
  real datadir needs a root decision.

## Release build (prepared, NOT run): `release/root-release.sh`
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/bytecode-native-validation
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2560 --log $S/release/root-release.guard -- unshare -rn bash $S/release/root-release.sh > $S/release/root-release.out 2>&1
```
- **It reuses** the verified private tree, cargo home and target (see `release/README.md`).
- **It re-checks every pin:** toolchain, stage sums `9effed77…`, the passed receipts, `lib.rs` `739c3245…`, lock
  `91a9e762…`, tree == archive, and the closure.
- **It refuses** profile overrides and any pre-existing `target/release` or `release/logs`.
- **Build settings:** offline, `--locked`, `-j1`, `-Wl,--threads=1` (lld), and the workspace thin-LTO release profile
  unchanged.
- **It records** the artifact sha256, the fresh flag (must be false), the toolchain and the manifest.
- **Estimate:** about 1.0–2.2 GiB and 20–50 min.

Even after that, the binary is only a candidate: a live run under root review is still required before G-a can close.
