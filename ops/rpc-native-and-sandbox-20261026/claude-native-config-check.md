# Native config check: r4's two omitted checks, isolated (`derivation-native-config-check-stage/`; PREPARED; not run)

**What I did not do:** no build, no test run, no live action, no SSH, no commit. combined-r1 (sources and `build/`) and the running root build `root-combined-build-1025` were not touched. Admin rights are unchanged.

**Stage:** `SHA256SUMS` **7f41fdeccbde108ed977c88bf1c8a7165ef59222260107ac941c376b1b55b4bf**.

| File | sha256 |
|---|---|
| `src/examples/native_config_check.rs` | 17f8461f… |
| `jobs/run-check.sh` | d3579929… |

## Source pins and fidelity

- **Origin:** the two tests are copied from **r4** `derivation-client-stage/r4/src/examples/derivation_harness.rs` (sha **6554926f…**, r4 `SHA256SUMS` verified), extracted programmatically:
  - `compiled_mainnet_config_hash_is_the_source_pin`;
  - `bridge_schedule_keys_are_the_upstream_serde_keys_in_contract_order`, with its `BRIDGE_SCHEDULE_KEYS` (15 keys).
- **Same upstream:**
  - workspace base/base 5476069f, tarball 9784e20a, Cargo.lock f122da76, as an EXAMPLE of `base-proof-zk-utils`;
  - its existing dependency `base-common-genesis` (serde on, via `base-proof`) and dev-dependency `base-common-chains`;
  - no new dependency.
- **The pin `1607709d…3c57` is upstream's own** Base-mainnet vector (`crates/proof/zk/utils/src/boot.rs` `test_config_hash_matches_nitro_enclave`, equal to the Nitro enclave `CONFIG_HASH`).

**ONE compile fix from inspection (meaning preserved):**
- `rollup_config!(8453)` → `rollup_config!(8453u64)`, at both call sites.
- **Why:** `RollupConfigSource` is implemented only for `u64`, `&u64`, `Chain` and `ChainConfig` (`crates/common/chains/src/macros.rs:17-57`). An unsuffixed literal falls back to `i32`, so r4's form would most likely not compile. Upstream passes a `u64`.

**Inspected and left unchanged:**
- `BaseUpgrade::CONTRACT_VARIANTS` (15) is used by value; `BaseUpgrade` is `Copy` (upstream `boot.rs` uses each value twice).
- `UpgradeConfig::activation_timestamp` exists (`genesis/src/chain/upgrade.rs:799`).
- `RollupConfig.upgrades` is `serde(flatten)`.
- `RollupConfig` and `BaseUpgrade` are root exports.

No network, witness or mock: both tests read only the compiled Base mainnet config.

## Root job (after the combined build has FINISHED)

```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
jobs/q-exit-status.sh claude-native-config-check-1 1536 unshare -rnm bash derivation-native-config-check-stage/jobs/run-check.sh
```

Use 1536 MiB, because the example may compile `base-common-chains` (a dev-dependency) and anything not yet built. The job:

**1. Refuses** on any of these:
- a stage `SHA256SUMS` mismatch;
- the tarball is not 9784e20a;
- the toolchain is not rustup 1.96.0;
- combined-r1's `build/deps-43698236e9186750/.copied` is missing;
- **the combined build still holds its lock**;
- the build tree's Cargo.lock **before** is not f122da76.

**2. Reuses dependencies without writing combined sources.** Inside `unshare -rnm` it bind-mounts combined's dependency copy over r3's path, giving identical paths so the compiled dependencies are reused. It then bind-mounts a **private** examples directory holding only `native_config_check.rs` over `zk/utils/examples`. No combined-r1 source file is written; only the shared `target/` gains this example's artifacts.

**3. Runs** `cargo test -p base-proof-zk-utils --example native_config_check --frozen --offline -j1 -- --test-threads=1`.

**4. Passes only if all of these hold:**
- rc 0;
- Cargo.lock **after** is f122da76;
- both exact lines `test tests::<name> ... ok` appear;
- there is exactly one `test result:` line, and it is `test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out[; finished in …]`.

A zero-test, filtered or skipped "success" fails.

**Output:** `logs/run-*/{cargo-test.txt, test-summary.txt, lock.txt, RESULT}`. `RESULT` = `PASS native-config-check 2/2 lock f122da76`.

## Combined recipe gaps (observed; the running job is not changed; root wraps these externally in `jobs/root-combined-build-1025.sh`)

`combined-r1/jobs/build-test.sh` (2c0da529):
1. **Lock check is recorded, not enforced.** Cargo.lock is compared only **after** the build, and a "CHANGED" result is written to `lock.txt` without failing the exit code.
2. **No pre-build check of the build tree's Cargo.lock.** Only the tarball's lock is checked.
3. **No exact test count.** It passes on rc 0; nothing requires `9 passed; 0 failed`.
4. `exec 8>$B/.combined-lock` truncates the (empty) lock file, which is harmless.

**Status:** config validation is pending root's run. Nothing is production-ready.
