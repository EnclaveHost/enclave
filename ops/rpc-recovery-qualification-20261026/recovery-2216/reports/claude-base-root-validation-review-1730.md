# What the base-state-readonly r4 root check actually authenticates (reth 7134be3): independent source review - 2026-10-26

**What I did:** read source only.
- **Read:** base-state-readonly-stage/r4 (SUMS verified, unchanged); the cached reth checkout `derivation-client-stage/combined-r1/build/deps-…/cargo/git/checkouts/reth-babcd6134566c621/7134be3` (HEAD `7134be3b51cf9d9504f988bff3266a23085f0bd9`); and the locked `alloy-trie-0.9.5` from the same cargo registry.
- **Not done:** no build, test, live read or edit of any stage.
- **The r5 stage of 6d was not touched.**

## Verdict
1. **The helper's `DbStateRoot::root()` reuses cached trie hashes.** With non-empty `AccountsTrie`/`StoragesTrie`, it does NOT recompute from all `HashedAccounts`/`HashedStorages`.
   - **On a real-sized trie,** it reads almost no hashed leaves. It authenticates the header root only against the cached top of the trie.
   - **`fullStateIntegrity = true` therefore OVERCLAIMS for the real candidate.** The r4 fixtures cannot show this, because their trie tables are empty, so the cached walk degenerates into a full recomputation.
2. **`db repair-trie --dry-run` DOES independently recompute every branch node from all hashed leaves,** with the trie tables unused, and compares node by node with the stored trie.
   - **It never compares anything to the header state root.**
   - **What it proves:** stored trie == trie(hashed state). It does not prove that the hashed state == the header.
3. **What authenticates the hashed state against the header:** a root computed from the hashed tables ONLY (`StateRoot::new(NoopTrieCursorFactory, DatabaseHashedCursorFactory)`), equal to the header `stateRoot`.
   - **Plus, for usability of the cached trie:** the Verifier (= repair-trie dry-run) with 0 inconsistencies.
   - **Both must be gates for any full claim** (see the remedy).

## Code trace
**A. What the helper computes:** `base-state-readonly-stage/r4/src/main.rs:74-76` / `:156` → `StateRoot::<DatabaseTrieCursorFactory<&TX, A>, DatabaseHashedCursorFactory<&TX>>::from_tx(tx).root()`.
- **Constructor:** `from_tx` = `Self::new(DatabaseTrieCursorFactory::new(tx), DatabaseHashedCursorFactory::new(tx))` (`crates/trie/db/src/state.rs:152-157`).
- **Defaults:** `new` sets `prefix_sets: TriePrefixSets::default()`, i.e. **empty** (`crates/trie/trie/src/trie.rs:56-66`).
- **Call path:** `root()` → `calculate(false)` (`trie.rs:154-160`, `:171`) → `TrieWalker::state_trie(trie_cursor, self.prefix_sets.account_prefix_set)` (`trie.rs:269-272`) over the **stored** account trie.

**B. When the walker skips a subtree.** `crates/trie/trie/src/walker.rs:194-221` `update_skip_node`:
```
can_skip_current_node = !self.changes.contains(node.full_key()) && !branch_path_matches_prefix_set && node.hash_flag() && !key_is_only_nonremoved_child
```
- **Consequence:** with an empty prefix set, `changes.contains` is always false, so **every stored child whose hash bit is set is skipped.**
- **Effect in the node iterator** (`crates/trie/trie/src/node_iter.rs:205-222`): a skipped node is returned as `TrieElement::Branch(… self.walker.hash().unwrap() …)`, i.e. the **cached hash** goes into the HashBuilder (`trie.rs:276-279`, `add_branch`).
  - **The hashed cursor then seeks past the whole subtree:** `next_unprocessed_key` → `key.increment()` when skipping (`walker.rs:184-190`; `node_iter.rs:254-266`).
  - **Leaves are fed from the hashed cursor only outside skipped subtrees** (`node_iter.rs:226-240`).
- **Storage tries:** each account leaf that is reached gets its storage root through `StorageRoot::calculate_with_cursors` with the **stored storage trie** and the same empty prefix set (`trie.rs:284-311`, `:804-807`), so the same rule applies there.

**C. Which children carry a cached hash.** alloy-trie 0.9.5 `src/hash_builder/mod.rs`:
- `store_branch_node` (`:429-455`) sets the parent's `hash_mask` bit for every **branch** child (`:430-434`).
- A branch is written to the DB only if its own `tree_mask` or `hash_mask` is non-empty (`:436`). The root node additionally carries `root_hash` (`:451`).
- A hash read back from the DB keeps its hash bit (`:303-312`).
- **Leaves never get a hash bit;** bottom-level branches (only leaf children) are not stored, but their hash is stored in their parent.
- **Consequence:** in a trie with millions of accounts, almost every leaf lies below a hash-flagged branch child. The cached walk then reads only the stored nodes plus a handful of leaves. **Hashed leaves (and their storage) under cached subtrees are not read at all.**

**D. What repair-trie --dry-run does.**
- **Path:** `crates/cli/commands/src/db/repair_trie.rs:100-104` (`dry_run` → `verify_only`) → `:110-123` (a read tx; `with_adapter!` picks the legacy or packed adapter) → `do_verify_only` `:127-169`.
  - It builds `Verifier::new(&DatabaseTrieCursorFactory::<_, A>, DatabaseHashedCursorFactory)`, counts every `Output` other than `Progress` as an inconsistency, and only logs "Found N inconsistencies (dry run - no changes made)".
- **`Verifier`** (`crates/trie/trie/src/verify.rs`):
  - its doc says the hashed tables are the source of truth (`:25-27`, `:310-312`);
  - `StateRootBranchNodesIter::next` runs `StateRoot::new(NoopTrieCursorFactory, hashed_cursor_factory).root_with_progress()` (`:100-118`). That is a **full recomputation from hashed accounts and storages**, with bounded memory via the progress threshold, and it yields every branch node it would store, ordered depth-first (`:119-150`).
  - **The comparison:** each recomputed node is compared with the stored trie in depth-first order (`SingleVerifier::next` `:236-280`) → `AccountWrong`/`StorageWrong` (unequal `BranchNodeCompact`, whose `PartialEq` includes the masks, the child `hashes` and the root `root_hash`, alloy-trie `nodes/branch.rs:260-307`), `…Missing`, `…Extra` (`finalize` `:283-295`).
  - **It also checks** that accounts without storage have no stored storage nodes (`verify_empty_storages` `:338-385`).
  - **What it discards:** the recomputed root (`Ok(StateRootProgress::Complete(_, _, updates))`, `:109-112`). **No header comparison exists anywhere in the dry-run path.**
  - **Where the header IS used:** `verify_repaired_state_root` (`:349-378`, `DbStateRoot::root()` vs the header) runs only in the **repair** path, after a write (`:340-343`).
- **A changed hashed leaf** changes the hash of every ancestor branch, so a stored ancestor (at least the stored root) differs → `AccountWrong`. When no node is stored at all (a tiny trie), the Verifier compares nothing, but then the cached walk recomputes everything.

## The gap, concretely (the real candidate)
- **The scenario:** hashed AND plain state both differ from what the stored trie encodes (for example, plain+hashed written for a later block than MerkleExecute, or the same value corrupted in both), while the stored trie still encodes the header's root.
- **What r4 reports:** `root == header` (cached), plain→hashed PASS, checkpoints coherent → **exit 0 FULL**.
- **Why that is wrong:** neither statement involves the hashed leaves under cached subtrees.
- **The only safeguard today:** the helper's own note (`main.rs:173`: "FULL trie-vs-hashed coverage needs `db repair-trie --dry-run`"). It is not a gate; `full` (`main.rs:163`) does not require it.
- **Don't trust the cache:** we must not trust cached hashes from a deleted, recovered DB.

## Minimal remedy for the next revision (no framework, upstream code paths only)
**1. A full root from the hashed tables only (mandatory):**
```rust
use reth_trie::{trie_cursor::noop::NoopTrieCursorFactory, verify::{Output, Verifier}};
fn full_root<TX: DbTx>(tx: &TX) -> eyre::Result<B256> {          // reads EVERY HashedAccounts/HashedStorages entry, no trie table
    Ok(StateRoot::new(NoopTrieCursorFactory, DatabaseHashedCursorFactory::new(tx)).root()?)
}
```
- **The exported paths exist:** `reth_trie::trie_cursor::noop` is `pub mod` (`crates/trie/trie/src/trie_cursor/mod.rs:12`), and `NoopTrieCursorFactory` is `Clone + Default` (`noop.rs:7-9`). This is the same construction the Verifier uses (`verify.rs:104-105`).
- **The streaming `root()`** keeps no updates (`retain_updates = false`).

**2. Trie-cache consistency (mandatory for a usable node):** the upstream Verifier in-process, exactly as `do_verify_only` (`repair_trie.rs:127-169`). Alternatively, the pinned `base db repair-trie --dry-run` with "Found 0 inconsistencies" and no error.
```rust
fn verify_cache<A: TrieTableAdapter, TX: DbTx>(tx: &TX) -> eyre::Result<(u64, u64, Vec<String>)> {
    let tf = DatabaseTrieCursorFactory::<_, A>::new(tx);
    let (mut acct, mut stor, mut samples) = (0u64, 0u64, Vec::new());
    for o in Verifier::new(&tf, DatabaseHashedCursorFactory::new(tx))? {
        match o? {
            Output::Progress(_) => {}
            o @ (Output::AccountExtra(..) | Output::AccountWrong { .. } | Output::AccountMissing(..)) => { acct += 1; if samples.len() < 64 { samples.push(format!("{o:?}")) } }
            o => { stor += 1; if samples.len() < 64 { samples.push(format!("{o:?}")) } }
        }
    }
    Ok((acct, stor, samples))
}
```
- `Output` derives `Debug, Clone, PartialEq, Eq` (`verify.rs:154`).
- **Adapter selection** is as in the existing code (v2 → `PackedKeyAdapter`).

**3. Report and exit:**
- **Report three things:** `stateRoot.cachedWalk` (the current value, diagnostic only), `stateRoot.fromHashedOnly` (with `matchesHeader`), and `trieCache {accountInconsistencies, storageInconsistencies, samples}`.
- **The full claim:** `fullStateIntegrity = fromHashedOnly == header && inconsistencies == 0 && coherent && plain PASS` (v1). v2 stays PARTIAL, because plain is NOT_APPLICABLE.
- **Failures:** a mismatch of either → **4 FAILED**.
- **No full claim without both:** never `0` without both. If root wants a faster partial run, it may be labelled `PARTIAL (cached walk only)` with exit 5, never FULL.
- **Cost:** two full passes over the hashed state (the recomputation and the Verifier, which recomputes again). They are bounded-memory and stream from MDBX read-only, so expect hours on the real DB. Cheaper is not sound: the cached walk plus repair-trie is logically sufficient only if the Verifier's node coverage is complete. The independent `fromHashedOnly` root avoids depending on that argument, so keep both.

**4. Header canonicality** stays separate and required (G8, user chain anchor). The above proves only hashed (and, for v1, plain) state == the root of that header.

## Fixtures that would expose the gap (mk_fixture additions; positives must NOT use a same-input-derived expected root only)
**Trie shape (deterministic search, recorded in expected.json, and the fixture self-checks):**
- Pick account addresses `Address::from_low_u64_be(i)` (smallest i) so that two hashed addresses share **exactly** the first nibble and differ at the second.
  - **Result:** the stored account root has a `hash_mask` bit for that nibble, because that child is a branch.
- The same for three storage slots of one account (two keccak(slot) sharing exactly the first nibble), so a stored storage-root node with a hash bit exists.
- **Writing the stored trie:** compute `StateRoot::new(NoopTrieCursorFactory, DatabaseHashedCursorFactory::new(&tx)).root_with_updates()` over the **original** hashed tables inside the write tx, and write `updates.account_nodes` → `tables::AccountsTrie` (`StoredNibbles(path)` → `BranchNodeCompact`; `db-api tables/mod.rs:497-500`) and `updates.storage_tries[*].storage_nodes` → `tables::StoragesTrie` (`hashed_addr`, `StorageTrieEntry { nibbles: StoredNibblesSubKey(path), node }`; `:503-507`). That is the legacy layout (the v1 case).
- **The fixture refuses itself** unless the stored trie is non-empty and the root node's `hash_mask` covers the nibble of the leaf it will modify. Without that, it could silently degrade into the r4 empty-trie case.
- **The expected/header root** = the independent alloy `state_root_unsorted` over the **original** hashed contents (as r4, `mk_fixture.rs:59-63`), which is the "canonical" root in these fixtures.

**Cases:**

| case | construction | must give |
|---|---|---|
| **P1 `v1-pass-cached-trie`** | consistent cached trie, plain = hashed, header = independent root | rc 0; `fromHashedOnly == cachedWalk == header`; 0 inconsistencies; AccountsTrie > 0 and StoragesTrie > 0 entries reported |
| **N1 `v1-cached-trie-plain-hashed-account-modified`** | trie and header from the original; then the SAME new balance written to plain AND hashed for one account in the hash-flagged sub-branch | plain→hashed PASS and (documenting the gap) `cachedWalk == header`, but `fromHashedOnly != header` and ≥ 1 `AccountWrong` → rc 4, fullStateIntegrity false. *r4 would return 0 here.* |
| **N2 `v1-cached-trie-plain-hashed-storage-modified`** | the same with one storage value of the slot in the hash-flagged storage sub-branch | as N1, with ≥ 1 `StorageWrong` (and the account path wrong) → rc 4 |
| **N3 `v1-stale-trie-node`** | hashed/plain/header correct; one hash in the stored root node flipped | `fromHashedOnly == header`, but ≥ 1 `AccountWrong` → rc 4 (an unusable cache is never FULL) |

**N1 and N2 are the required corruption fixtures:** the cached trie is unchanged, plain and hashed are modified to the same value, and the result must be a canonical-root mismatch. Keep r4's existing negatives unchanged.

## Not claimed
- **Nothing compiled or run.** The line numbers refer to the cached 7134be3 checkout and alloy-trie 0.9.5.
- **v2 limit:** for v2 the hashed-only root still applies, but plain remains NOT_APPLICABLE and history and RocksDB remain NOT CHECKED.
- **Separate gates still required:** canonical chain anchor, MDBX structure, and the post-delete/qcow evidence.
