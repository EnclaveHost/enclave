# G3: what pinned reth and base actually verify about an untrusted snapshot (source-level findings)

Written 2026-10-25. These are read-only source findings. **No command was run against any DB, and no gate is accepted here.**

## Sources

| Name | Source | Notes |
|---|---|---|
| **base-reth** | `~/.cargo/git/checkouts/reth-babcd6134566c621/7134be3` | `base/reth` tag `base-v2.5.2.8`, the reth that base v1.5.1 (5476069f) links; the `base reth …` subcommands run it. Shared cache, read-only. |
| **upstream reth v2.8.0** | Narrow read-only fetch of 5 files from `raw.githubusercontent.com/paradigmxyz/reth/v2.8.0`, not copied here; commit and content sha256 values are in README.md §1 | The L1 EL binary pin `8cdd1f35…`. That binary has not been rebuilt from this tag, so source correspondence is assumed, not proven. |

## Findings (identical in both, except where noted)

1. **`db repair-trie --dry-run` does not authenticate a snapshot.**
   - `do_verify_only` (`crates/cli/commands/src/db/repair_trie.rs:110-172`) runs `trie::verify::Verifier`. It recomputes the trie from the **hashed** tables and diffs it against the stored **trie** tables, treating the hashed tables as the source of truth (`crates/trie/trie/src/verify.rs:151-153`).
   - It never reads the plain state, and in dry-run mode never compares against a header `stateRoot`. The `verify_repaired_state_root` check (`:343-375`) runs only in repair (write) mode.
   - So a forged but internally consistent hashed state plus trie passes.
2. **`re-execute --from --to` checks blocks against the DB's own history.**
   - It runs each block on `history_by_block_number(chunk_start-1)`, which is plain state plus changesets **from the same DB** (`re_execute.rs:150-200`), then calls `validate_block_post_execution` against the stored header (gas used, receipts root, logs bloom, requests).
   - It computes **no state root**.
   - It compares stored receipts only to explain a failure. **Stored receipts are therefore not verified by it,** yet they are exactly what `eth_getLogs`/`eth_getBlockReceipts` serve.
   - Headers are read from the DB, with no linkage to any external anchor.
3. **A full hashing plus merkle rebuild does authenticate the state at one block N against that block's header.**
   - `AccountHashingStage`/`StorageHashingStage` with `from_block == 1` (or a range above `clean_threshold`) **clear** `HashedAccounts`/`HashedStorages` and rehash from `PlainAccountState`/`PlainStorageState` (`hashing_account.rs:176-192`, `hashing_storage.rs:106-116`, same lines in v2.8.0).
   - A merkle rebuild clears `AccountsTrie`/`StoragesTrie` (`merkle.rs:245`), recomputes, and calls `validate_state_root(root, SealedHeader::seal_slow(target), to)` (`merkle.rs:367`; v2.8.0 `:362`). That fails unless the root equals the DB header's `stateRoot`.
   - **This is a write operation** (`stage drop` / `stage run`). Run it only on an owned **copy**, never on the live DB.
4. **None of these link the header to anything.** "Header N" is whatever the snapshot stores. It must be checked externally: recompute hash(header N), then link it by parent hashes to an authenticated anchor (L1: beacon-finalized payload hash; Base: a finalized output root, or the derived chain).

## Minimum snapshot-authentication procedure

Run this on a disposable copy, VM stopped. It is not executed here, and its cost on the HDD (Base) is unmeasured.

1. **Anchor.** Obtain an authenticated block hash H_N for a block N at or above the snapshot head.
   - L1: Lighthouse/Helios finalized.
   - Base: a finalized output root via verified L1 reads (PLAN.md §3).

   Then walk headers from the snapshot head down to N, recomputing hashes, until they link to H_N.
2. **State.** On the copy:
   - `reth stage drop account-hashing`, `storage-hashing` and `merkle`;
   - `reth stage run hashing --from 1 --to N`;
   - `reth stage run merkle --from 1 --to N`.

   Accept the state only if merkle returns OK, which means plain state hashes to `header(N).stateRoot`. Base uses the same commands under `base reth …`, with its own `--chain`.
3. **Receipts and logs needed for completeness.** For every block of the required ranges:
   - Base: from `LEDGER16D_FROM_BLOCK` 52,515,705.
   - L1: the derivation window of at least 140,000 blocks.

   Recompute the receipts root from the **stored** receipts and require it to equal the linked header. reth has no such command, so this needs a small new tool (L1 encoding exists in coverage-stage kzgcheck; Base needs OP receipt encoding). `re-execute` alone is not enough, per finding 2.
4. **Not covered by 1-3:**
   - historical state (changesets) below N, which historical `eth_call`/`eth_getProof` read;
   - tx-lookup and other indexes.

   Either refuse historical-state queries below N or re-execute from the anchor.

## Gate status

| Gate | Status |
|---|---|
| G3 | Semantics established from source. The procedure is defined but **not executed** (needs a DB copy, write access and root authorization). Cost on the Base HDD is unknown. |
| Live DB | No claim that any current DB, snapshot or the running VM is authenticated. Attestation does not authenticate a DB. |
