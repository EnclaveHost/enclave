# RPC client integrity (2026-10-25): G3 snapshot-verification findings and M7 candidate patch

## Status

**Source only. These are candidates, not production.**

| Item | State |
|---|---|
| M7 Rust tests | **NOT COMPILED and NOT RUN.** |
| Self-check | Only syntax and patch application were checked (§3). |
| Root queue run | Prepared and **launched by root**. It is waiting behind the native reproduction build; its outcome is **pending** and is not reported here (§4). |
| Gates, live conversion, authority | None accepted. No live conversion, no VM change, no measured-image change. This grants no finality or DB authority. **SNP attestation does not authenticate a database or snapshot.** |

## 1. Pinned sources

| Component | Upstream | Revision | How it was read |
|---|---|---|---|
| base v1.5.1 | https://github.com/base/base | tag `v1.5.1` = commit `5476069f1eb74a56bccb56fdefd4b4bb0e3cda42` | local clone |
| base/reth (what base v1.5.1 links; `base reth …`) | https://github.com/base/reth | tag `base-v2.5.2.8` = `7134be3b51cf9d9504f988bff3266a23085f0bd9` (from base's `Cargo.lock`) | local cargo git checkout |
| upstream reth v2.8.0 (the L1 EL binary pin `8cdd1f35…`) | https://github.com/paradigmxyz/reth | tag `v2.8.0` → tag object `4186179b…`, commit `05ba48120a0ce8d6beb65f0b2a7ad4710f4f2915` (`git ls-remote`) | **not local**; 5 files fetched read-only from `raw.githubusercontent.com/paradigmxyz/reth/v2.8.0/<path>` |

The upstream reth v2.8.0 files are not copied here. Their content sha256 values as fetched are:
- `crates/stages/stages/src/stages/merkle.rs` `34a877845f9f764e21bff30960ec61a2bb6ce1aa15d8cdba84e749dcd0d04910`
- `crates/stages/stages/src/stages/hashing_account.rs` `e89f3fc5570debac13c47904fe8f0c5f063a8787059ca5928c39278575b52d4c`
- `crates/stages/stages/src/stages/hashing_storage.rs` `2e4f5e8c1de1b207ac5c87b2c16067e86d38b4bfedc104c70a46bb7c7b4b850f`
- `crates/cli/commands/src/db/repair_trie.rs` `ec6a1a6e00adf86dcd67e055ddfa35410119a04c4134a73f626a98e58ac610cd`. This is identical to base/reth 7134be3.
- `crates/cli/commands/src/re_execute.rs` `31c8dc458c12f9361229fc710d5cce1ce5f258684c122284f433910ea33e6ecc`

**The L1 reth binary was not rebuilt from that commit,** so the binary/source correspondence is assumed, not proven.

base/reth 7134be3 file sha256 values (local checkout):

| File | sha256 |
|---|---|
| repair_trie.rs | `ec6a1a6e…10cd` |
| re_execute.rs | `2060e25f…be18` |
| merkle.rs | `6734828b…ac7f` |
| hashing_account.rs | `59325a2b…47be` |
| hashing_storage.rs | `2cf16f43…d731` |
| trie/src/verify.rs | `5db72b63…4768` |

## 2. G3: what the pinned clients verify about an untrusted snapshot

Read-only source findings. **No DB was touched.**

- **`db repair-trie --dry-run`** (`repair_trie.rs:110-172`, `trie/src/verify.rs:151-153`)
  - It recomputes the trie from the **hashed** tables and diffs that against the stored trie tables, treating the hashed tables as the source of truth.
  - It never reads plain state and never compares against a header `stateRoot`. The header-root check (`:343-375`) exists only in repair (write) mode.
  - **This is not snapshot authentication.**
- **`re-execute --from --to`** (`re_execute.rs:150-212`)
  - It executes on `history_by_block_number`, which comes from the **same DB**, then runs `validate_block_post_execution` against the DB's own headers.
  - It computes no state root.
  - It compares **stored receipts** only to explain a failure, so they are not verified, and they are what log queries serve.
  - Headers are not anchored to anything.
- **Full hashing plus merkle rebuild (writes).**
  - Hashing stages with `from_block == 1` clear `HashedAccounts`/`HashedStorages` and rehash from `PlainAccountState`/`PlainStorageState` (`hashing_account.rs:176-192`, `hashing_storage.rs:106-116`, same in v2.8.0).
  - A merkle rebuild clears the trie tables (`merkle.rs:245`) and calls `validate_state_root(root, SealedHeader::seal_slow(target), to)` (`merkle.rs:367`; v2.8.0 `:362`).
  - This authenticates **current state at block N against the DB's header N** only.
- **Still required, and missing from every command above:**
  - external header-to-anchor linkage;
  - a check of each block's stored receipts against its receipts root over the needed ranges (Base from 52,515,705; L1 derivation window of at least 140,000 blocks). reth has no command for this.
  - refusing, or re-executing, historical state below N.
- **Procedure status:** defined in `G3-SNAPSHOT-VERIFICATION.md`, on a disposable copy only. **Not executed**, and its cost on the Base HDD is unmeasured.

## 3. M7 candidate: base v1.5.1 L1 data verification (`patch/base-l1-verify.patch`)

**Patch:** sha256 `e9dfb8c6f950222fb8dee6a42d55612d10bd2cf8c2a68646c9aca8a581485312`. It applies to commit `5476069f`.

**Exact pristine inputs** (`git show 5476069f:<path>`):
- `crates/consensus/providers/src/chain_provider.rs` `aa1b384bca35382eb77a5b7051235254e648440e9921323356d04ddaea0c61f2`
- `crates/consensus/cli/src/l1.rs` `fc47f745098feebd5959287bd5764718010670066ae66855c78c8c54bfbf33ff`

**Patched outputs:** `chain_provider.rs` `201d9b8c16b080a4f7111ca29ec5ece8f02a2b9be807bb06e24e7eb1248bb3b2`, `l1.rs` `f40e2accc7e60ffe53b26a004a1c1b1e4e6e56f056a4385fddef47344e28d88f`.

**Upstream behaviour being changed:** derivation's `AlloyChainProvider` is built with `l1_config.trust_rpc` (`service/src/service/node.rs:213, 239`; file sha `f0421620…b121`). `DEFAULT_L1_TRUST_RPC = true`. Even with trust off, upstream checks only header hashes; receipts and transactions are never root-checked.

**The patch** (with `trust_rpc` false):
- `receipts_by_hash` requires `calculate_receipt_root(typed envelopes) == receipts_root` of the hash-verified header.
- `block_info_and_transactions_by_hash` requires `calculate_transaction_root(txs) == transactions_root`.
- Neither caches anything before verification.
- Mismatches return `ReceiptsRootMismatch`/`TransactionsRootMismatch`, which map to `Temporary`: derivation stalls and never derives from or resets onto the served data.
- The default becomes `DEFAULT_L1_TRUST_RPC = false`, with `--l1.trust-rpc` as the explicit opt-out.

**Unchanged:** L2 trust, traversal, the L1 finalized-tag source, and writer fencing.

**Out of scope:** the sequencer-only `actors/sequencer/l1_origin/provider.rs:113` (`91c850df…`) also reads receipts unverified.

**Tests in the patch: NOT COMPILED, NOT RUN.**
- 7 in `chain_provider::tests` (httpmock JSON-RPC): consistent, omitted, altered, reordered, forged header, explicit-trust opt-out, transactions root.
- 1 in `l1::tests`: default false, flag sets true.

The fixtures were written against alloy 2.4.1 sources but never compiled; fix-ups may be needed.

**Self-check evidence** (`evidence/selfcheck.*`; shared queue 256 MiB in `unshare -rn`; rc 0):
- the patch applies to a pristine archive of `5476069f`;
- both patched files **parse** under rustfmt 1.96.0. **That is syntax only**: no type check, no compile, no test.

## 4. Job recipes and root's queued run (as prepared, not results)

**Jobs:** `jobs/env.sh`, `prepare-fetch.sh`, `test-offline.sh`, `selfcheck.sh`.
- **prepare-fetch** (network, 1024 MiB; writes only the stage's `build/`):
  - pristine archive plus the patch;
  - a **negative-control** copy with both new checks disabled;
  - a private `CARGO_HOME` seeded by *copying* `~/.cargo/{registry,git}`;
  - `cargo fetch --locked`.
- **test-offline** (`unshare -rn`, 1536 MiB): requires the patched provider and cli tests to pass, **and** the control to fail exactly `altered_log_is_refused`, `omitted_receipt_is_refused_and_not_cached`, `reordered_receipts_are_refused` and `transactions_must_match_the_verified_transactions_root`.

**Root's queued run:** `root-queue/run.py` and `root-queue/pins.json` are copied exactly as root prepared them. The run:
1. waits for the native reproduction `r3-eeffcc9.rc`;
2. re-checks the pinned job hashes before every step;
3. runs prepare-fetch, then test-offline, through `work/claude-test-queue.py` with `CARGO_BUILD_JOBS=1`, retrying only on queue rc 98.

Its last line states that even exit 0 "requires log/source/root review, NOT production activation". At publication it was **waiting** (no compile started). **No result is claimed here;** the logs come later and may need fixups.

## 5. Applying M7, only after the queued tests pass and root reviews them

1. `git apply patch/base-l1-verify.patch` on `5476069f`.
2. Reproducible `base` build: root's native build process, not done here.
3. Run without `--l1.trust-rpc` and without `BASE_NODE_L1_TRUST_RPC=true`.

Any new binary is a new pin and needs its own review. This does not touch the installed RPC VM.
