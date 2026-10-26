# 1724: base-state-readonly-stage/r4, fixes for the known guaranteed build failures of r3 (SOURCE ONLY; frozen, NOT built)

**Stage:** `base-state-readonly-stage/r4/`, **SHA256SUMS sha256 `0d08803279d574515511970447c0c3a737dbd2cd3bb3ec30953131558e85ade7`** (files 0444, jobs 0555).
- **Frozen r3:** unchanged (`833c759e…`, re-verified).
- **What I did:** read source, wrote files, ran `bash -n`. No build, tests, live access, toolchain install or fetch. I only listed `~/.rustup/toolchains` names: 1.96.0 is installed.

## Guaranteed failures fixed (and nothing broader)
**1. Toolchain environment (root 1724).**
- **The r3 failure:** the build ran `env -i … HOME=$B` with no `RUSTUP_HOME` or `RUSTUP_TOOLCHAIN`, so the rustup shim `/home/steven/.cargo/bin/cargo` resolved an empty `$B/.rustup` and could never build.
- **r4 `jobs/env.sh`** copies the qualified `derivation-client-stage/combined-r1/jobs/build-test.sh` (lines 12, 24, 38):
  - `PATH=/home/steven/.cargo/bin:/usr/bin:/bin`;
  - `RUSTUP_HOME=/home/steven/.rustup`, `RUSTUP_TOOLCHAIN=1.96.0`;
  - the toolchain dir must exist, and **`rustc -V` must report `rustc 1.96.0 …`** under exactly the build env (recorded with `cargo -V` in `toolchain.txt`).
- **Added:**
  - `RUSTUP_AUTO_INSTALL=0`, so a missing toolchain is never installed or fetched;
  - a before/after manifest of the rustup home (directory listing plus `settings.toml`): any change gives rc 9.

**2. Compile error in `src/bin/mk_fixture.rs`.**
- **The error:** it called `tx.commit()` while importing only `DbTxMut`. At 7134be3, `commit(self)` is a method of **`DbTx`** (`crates/storage/db-api/src/transaction.rs`; `put` is on `DbTxMut`), so the method would not resolve (E0599).
- **The fix:** r4 imports `transaction::{DbTx, DbTxMut}`.

**Every other r3 → r4 diff is a label** (r3 → r4), checked with `diff`. The helper logic, fixtures, cases, expectations, read-only and refusal checks are unchanged.

## Other items checked against the cached primary source (no change needed)
| item | status |
|---|---|
| `reth_db::mdbx::DatabaseArguments` | ok: `db/src/mdbx.rs:8` re-exports `implementation::mdbx::*` |
| `reth_db::{init_db, open_db_read_only}` | ok |
| `reth_trie_db::{DatabaseHashedCursorFactory, DatabaseStateRoot, DatabaseTrieCursorFactory, LegacyKeyAdapter, PackedKeyAdapter, TrieTableAdapter}` | all exported (`trie/db/src/lib.rs:14-24`) |
| the `DatabaseStateRoot` impl | `impl<'a, TX: DbTx, A: TrieTableAdapter> … for StateRoot<DatabaseTrieCursorFactory<&'a TX, A>, DatabaseHashedCursorFactory<&'a TX>>` (`state.rs:152-158`): matches the helper's generic `state_root::<A, TX>` |
| `HeaderProvider` for `StaticFileProvider` | `impl<N: NodePrimitives<BlockHeader: Value>> HeaderProvider for StaticFileProvider<N>` (`manager.rs:2587`) |
| `StaticFileProviderBuilder`, `StaticFileWriter` | exported from `reth_provider::providers`; `get_writer`, `append_header` and `commit` as in the genesis insert (`init.rs:492-505`) |
| `reth_trie_common::root::{state_root_unsorted, storage_root_unsorted}` | re-exports of alloy-trie 0.9.5 (`trie/common/src/root.rs`) |
| type identity | `reth-primitives-traits 0.6.0`, `reth-ethereum-primitives`, `reth-trie-common` and `reth-db-api` all depend on **alloy-consensus 2.4.1** and the single **alloy-trie 0.9.5** (Base lock). The `Header`/`TrieAccount` types line up, and `alloy-consensus =2.4.1` in `Cargo.toml` matches |
| the cached store for `--offline` | `cargo/git/db/reth-babcd6134566c621` and `git/checkouts/…/7134be3` exist; `registry/{cache,index,src}` exist |

## New cheap preflight (256 MiB, no compilation)
```
bash jobs/q-exit-status.sh bsro-r4-preflight 256 unshare -Urn bash base-state-readonly-stage/r4/jobs/preflight.sh
```
- **Same setup as the build:** the same `env.sh`, the same isolated `CARGO_HOME` (symlinks to the cached `registry`/`git`), and the same seeded Base lock.
- **The check:** `cargo metadata --offline --format-version 1` (600 s), then **the Base-lock-only check:** every resolved package must be in the Base lock `f122da76…`, and the only reth git source must be `7134be3b…`.
- **Nothing may change:** the cached crate store manifest and the rustup home must be identical before and after.
- **What it settles:** toolchain resolution, offline resolution and lock pruning, i.e. the dependency side of the build, at metadata cost. It does **not** prove compilation. The scratch dir is removed.

## Root order (unchanged otherwise)
```
bash jobs/q-exit-status.sh bsro-r4-preflight 256  unshare -Urn  bash base-state-readonly-stage/r4/jobs/preflight.sh
bash jobs/q-exit-status.sh bsro-r4-build    4096  unshare -Urn  bash base-state-readonly-stage/r4/jobs/build.sh
bash jobs/q-exit-status.sh bsro-r4-fixtures  512  unshare -Urn  bash base-state-readonly-stage/r4/jobs/fixtures.sh <ABS runs/build-…/base-state-readonly>
bash jobs/q-exit-status.sh bsro-r4-positive  512  unshare -Urnm bash base-state-readonly-stage/r4/jobs/positive.sh <ABS runs/build-…/>
```
**The full build is unchanged:** 4096, `--offline -j 4 --bins`, 7200 s. Both binaries are copied 0555, and rc 9 if either is missing. The cache must be unchanged and the lock check must pass. The `/tmp` scratch is kept for review.

## Remaining unknowns (stated, not fixed blindly)
- **Unverified compile details:**
  - `cursor.first()/next()` and `seek_by_key_subkey` signatures;
  - `StageId` `Display` used as JSON keys;
  - the `StaticFileProviderRWRefMut` deref for `append_header`.

  None is known to be wrong. The first build log decides.
- **Runtime unknowns:**
  - whether reth's MDBX read-only open (`Mode::ReadOnly`) works on an ST_RDONLY mount without `mdbx.lck`;
  - whether `tx.put` on DupSort tables adds distinct subkeys.

  The positive fixtures will reveal both.
- **Unproven fit:** the 4096 MiB and 7200 s build bounds are estimates; the 256 MiB preflight memory is assumed sufficient for `cargo metadata`.
- **No change to what the fixtures qualify or not** (see 1719). Root/canonicality remains self-consistency only without our own L1 anchor.
