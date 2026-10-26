# base-state-readonly-stage/r6: mandatory hashed-only root + mandatory trie-cache Verifier (review 1730 remedy). Source only - 2026-10-26

**Not done by me:** no build, test, live read, data copy or cache reuse. Nothing compiled.
- **Preserved and verified:** r4 and **r5 (`71e5fac4…`, the qualified disk guard)**.
- **Guard runtime unchanged:** `jobs/disk_guard.py`, `tests/test_disk_guard.py` and `tests/guard_wrapper.py` are **byte-identical to r5**, and r6's `build.sh` refuses unless they still `cmp`-equal r5 and r5 is still frozen.
- **r5's role:** r5 builds qualify only the dependency/build/API path. **r5's helper is known unsound for a full claim** (its root reused cached trie hashes); do not use it on real data.

## Stage: `base-state-readonly-stage/r6`, FROZEN
**`SHA256SUMS` = `c7315770f0a0cf92412cca7f65d08b91addc480c685a0e05197618e662ec22e0`.**

| file | sha256 |
|---|---|
| `src/main.rs` (helper) | `597a499acbc5405c00cff22033e2c4e976ad4ca9b7d5c8277508878d3428f0fa` |
| `src/bin/mk_fixture.rs` | `1db170dca1d856e26526aa4dcfdf7e8c230c7a8750a32128e6b02a03ec77f356` |
| `jobs/positive.sh` (13 cases / 14 runs) | `c29bf84dd0805a7ead876e1566276be556276719a07067252e26404211fc5272` |
| `jobs/build.sh` (+ r5 guard pin) | `423ec47fb0d140052bb3788f362ad1b772e8cb16262c4304fc180d1555222e47` |
| `jobs/build-inner.sh` / `env.sh` / `fixtures.sh` / `guard-tests.sh` / `preflight.sh` | r5 with the r6 labels only (`b58cfa65…` / `eb3abda3…` / `26641379…` / `aab853d4…` / `5ee36ce5…`) |
| `jobs/disk_guard.py`, `tests/*` | = r5 (`b42cf8fd…`, `366878f5…`, `6c6e231c…`) |
| `Cargo.toml` | `42dcdc8f…` (header comment only; dependencies identical to r5, so the Base-lock-only check is unchanged) |
| `README.md` | `f676f1d1…` |

## Helper changes (`src/main.rs`)
1. **The hashed-only root is mandatory:** `StateRoot::new(NoopTrieCursorFactory, DatabaseHashedCursorFactory::new(tx)).root()`.
   - **What it reads:** every HashedAccounts/HashedStorages entry and no trie table. This is the construction the upstream Verifier uses (`reth/crates/trie/trie/src/verify.rs:104-105`).
   - **Memory:** `root()` retains no updates, so it streams with bounded memory.
   - **It is the ONLY root compared with the header** (`stateRoot.matchesHeader`, `stateRoot.computed = fromHashedOnly`).
2. **The trie-cache Verifier is mandatory:** `reth_trie::verify::Verifier::new(&DatabaseTrieCursorFactory::<_, A>, DatabaseHashedCursorFactory)`, with A chosen exactly like `with_adapter!` (v2 → Packed), as `repair_trie.rs:127-169`.
   - **Counting:** every non-`Progress` output is an inconsistency; `trieCache {status, accountInconsistencies, storageInconsistencies, samplesFirst64, accountsTrieEntries, storagesTrieEntries}`.
   - **Memory:** bounded through the upstream `root_with_progress` threshold.
3. **The cached walk is diagnostic only:** `stateRoot.cachedWalk` (the old `DbStateRoot` value).
   - **It never makes a pass.** A disagreement with `fromHashedOnly` is an additional failure.
   - **Source fact** (subnode.rs:152-158): a stored root node with `root_hash` is hash-flagged, so the cached walk can return the stored root hash without reading a single leaf.
4. **Full claim and exit codes:**
   - **`fullStateIntegrity`** = `fromHashedOnly == header` **and** cache 0/0 **and** cachedWalk == fromHashedOnly **and** checkpoints coherent **and** plain→hashed PASS. **It cannot be true without both mandatory checks.**
   - **Exit 4** if any of these fails.
   - **Exit 5 PARTIAL** when plain is NOT_RUN or v2 NOT_APPLICABLE.
   - **Exit 3** for refusals, unchanged.
   - **Format** `base-state-readonly/r6`.
5. **Unchanged:** RO open, refusals, the plain↔hashed bijection, checkpoints, and the header source.

## Fixtures (`src/bin/mk_fixture.rs`, `jobs/positive.sh`)
**r5's 9 cases / 10 runs keep their exact r5 expectations.** The new trie-cache expectation for each is PASS with 0/0.
- **Why the empty trie is consistent for them:** their hashed keys have pairwise different first nibbles. I computed this offline with a reference Keccak-256 self-tested against keccak(""): accounts e2…/2a…/37…(/4c…), slots of 0x11 b1…/40…. So a full recomputation stores no node either.
- **The 6 refusal cases of `jobs/fixtures.sh` are unchanged.**

**The new cases use non-empty caches, built in mk_fixture:**
- **Keys:** a deterministic search adds a partner account (`Address` = 12 zero bytes + be64(i), smallest i whose keccak shares **exactly** the first nibble with keccak(0x11…); offline: i = 9, keccak e690… vs e2c0…) and a partner slot of 0x11 (smallest i ≥ 3; offline: 14, keccak bb7b… vs slot 1 b10e…).
- **The cache:** `StateRoot(NoopTrieCursorFactory, hashed).root_with_updates()` over the **original** hashed tables, written to `AccountsTrie` (`StoredNibbles` → `BranchNodeCompact`) and `StoragesTrie` (`StorageTrieEntry`), legacy v1 layout.
- **Self-checks** (mk_fixture exits 1 otherwise):
  - the reth root equals the independent alloy root;
  - the stored account root has a hash bit over 0x11's nibble;
  - the stored storage root of 0x11 has a hash bit over slot 1's nibble.
- **`expected.json` records:** `headerRoot` (= `canonicalRoot`, the independent alloy root of the ORIGINAL state before corruption), `expectedRoot` (the independent alloy root of the hashed tables as written), the trie node counts and the key search.

| case | construction | positive.sh requires |
|---|---|---|
| **P1 `v1-pass-cached-trie`** | consistent cache, plain = hashed | rc 0; fromHashedOnly == expectedRoot == header; cache PASS 0/0; written trie entries ≥ 1 / ≥ 1 and equal to the helper's counts; cachedWalk == header; plain PASS; fullStateIntegrity true |
| **N1 `v1-cached-trie-account-modified`** | cache + header from the original; then the SAME balance + 1 of 0x11 in plain AND hashed | rc 4; matchesHeader **false** (fromHashedOnly == expectedRoot ≠ header); cache FAIL with ≥ 1 account inconsistency; **cachedWalk == header (the r5 gap, documented)**; plain PASS; full false |
| **N2 `v1-cached-trie-storage-modified`** | the same, with slot 1 of 0x11: value + 1 in plain AND hashed (the hashed dup entry deleted and re-put) | rc 4; matchesHeader false; ≥ 1 account and ≥ 1 storage inconsistency; cachedWalk == header; plain PASS; full false |
| **N3 `v1-stale-trie-node`** | hashed/plain/header correct; `hashes[0]` of the stored account root flipped | rc 4; matchesHeader **true**; cache FAIL with ≥ 1 account inconsistency; cachedWalk not asserted (diagnostic) |

**Every case also checks:**
- the read-only bind mount and the tree byte-unchanged after the run;
- header == canonical root (except `v1-wrong-root`);
- legacy fixtures have no cache, cached fixtures a non-empty one;
- for N1/N2, that the corruption changed the hashed root.

**Totals:** 13 cases / 14 runs.

## Exact root commands (offline, as before; the cache reuse for the build is root's decision after the actual r5 build result)
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh bsro-r6-guard-tests 256 unshare -Urn bash base-state-readonly-stage/r6/jobs/guard-tests.sh        # "Ran 10 tests" (identical guard), r6 receipt
bash jobs/q-exit-status.sh bsro-r6-preflight 256 unshare -Urn bash base-state-readonly-stage/r6/jobs/preflight.sh            # offline metadata + Base-lock-only
bash jobs/q-exit-status.sh bsro-r6-build 4096 unshare -Urn bash base-state-readonly-stage/r6/jobs/build.sh                   # guarded on /vm; needs the r6 guard receipt; r5 must be frozen + guard files == r5
bash jobs/q-exit-status.sh bsro-r6-fixtures 512 unshare -Urn bash base-state-readonly-stage/r6/jobs/fixtures.sh <ABS runs/build-*/base-state-readonly>   # 6 refusals
bash jobs/q-exit-status.sh bsro-r6-positive 512 unshare -Urnm bash base-state-readonly-stage/r6/jobs/positive.sh <ABS runs/build-*/>                    # "## cases=14 failed=0"
```
- **Dependencies:** r6 uses no new crate (`reth-trie`/`reth-trie-db`/`reth-trie-common` were already dependencies), so a passing r5 build qualifies the resolution path. The new API uses (`NoopTrieCursorFactory`, `verify::{Verifier, Output}`, `StoredNibbles`, `StorageTrieEntry`, `BranchNodeCompact::new`, `TrieMask::is_bit_set`) were checked against the cached 7134be3 / alloy-trie 0.9.5 sources, but remain **uncompiled**.
- **Real data:** a real read-only run needs separate authorization. It costs two full passes over all hashed state (the recomputation plus the Verifier), with streaming/bounded memory; expect hours.

## Not claimed
- **Nothing compiled or run.**
- **The canonical chain anchor** (that the Finish header is canonical) remains separate and required.
- **Not checked:** history, receipts, transactions and RocksDB.
- **v2:** the hashed-only root and the Verifier apply, but plain stays NOT_APPLICABLE, so exit 5, never FULL.
- **No public RPC fallback.**
