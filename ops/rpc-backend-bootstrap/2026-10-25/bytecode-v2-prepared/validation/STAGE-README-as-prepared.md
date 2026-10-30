# Bytecode checker receipt v2 (native): PREPARED, NOT COMPILED, NOT RUN

- **Done:** the source is written. Root must review it before any compile.
- **Not done:** cargo/rustc, tests, queue, live access or commits. Only Python static checks of the control anchors and test names, plus `bash -n`.
- **Frozen sources unchanged:** `bytecode-native-validation` (v1 source, jobs, controls, the private cargo home and the release `42d692d4…`), root's A2 inputs and every publication were only read (`frozen-v1-sources.sha256`).

## What v2 adds to the tested v1 checker

**Unchanged:** `check_row`, `client_decode`, `agrees_with_client`, `verify_row` and `completeness` are **byte-identical** to v1 `lib.rs` `739c3245…`. The DUPN class, padding, client and completeness rules are unchanged.

**New:** all of the following is read in **one** MDBX read transaction (`db.tx()`):

| Field | Source (pinned reth `7134be3`) | Meaning |
|---|---|---|
| `mdbxTxnId` | `Tx::id()` (`mdbx/tx.rs:71`) | The snapshot that was read |
| `bytecodesEntries`, `hashedAccountsEntries` | `DbTx::entries::<T>()` (MDBX stat, `transaction.rs:46`) | Independent table counts. They are **not** derived from the walk. |
| `accountsScanned` | Every `HashedAccounts` row walked, with or without code | Compared with `hashedAccountsEntries` |
| `rowsDigest` | Framed keccak over **every** `Bytecodes` row (raw key, raw value), in cursor order | Binds the exact table bytes |
| `codeHashesDigest` | Framed keccak over every `(hashed address, bytecode_hash)` with non-empty code, in cursor order | Binds every code reference |
| `checkpoints` | `tx.get::<tables::StageCheckpoints>("Headers" / "Bodies" / "Execution" / "MerkleExecute" / "Finish")` (`StageId = String`, `tables/mod.rs:623`) | The block each stage was at in this snapshot (or `null`) |
| `datadir` | argv[1], exactly (UTF-8 required) | The target |

**`ok`** requires everything v1 required, plus:
- `accountsWithCode > 0`;
- `rows == bytecodesEntries`;
- `accountsScanned == hashedAccountsEntries`;
- `accountsWithCode <= accountsScanned`;
- a transaction id > 0;
- both digests;
- all 5 checkpoints present;
- a non-empty datadir.

The checker does **not** compare checkpoints with N; A2 does (`check_bytecode_receipt`).

### Digest framing (stable v2 definition; any change is a new receipt version)

```
digest = keccak256( domain || item_1 || ... || item_n || u64be(n) )
item   = for each part: u32be(len(part)) || part
rowsDigest:       domain "base-bytecode-check/v2/bytecodes-rows\0"; one item per Bytecodes row; parts [raw key, raw value]
codeHashesDigest: domain "base-bytecode-check/v2/code-hash-refs\0"; one item per HashedAccounts row whose bytecode_hash is
                  Some(h) with h != KECCAK256_EMPTY; parts [hashed address (32), h (32)]
```
- **Encoding:** hex, lowercase, without `0x`.
- **Order:** MDBX cursor (key) order.
- **No new dependency:** `alloy_primitives::Keccak256` is the streaming hasher.

## Receipt format vs. the A2 proposal (coordination)

- The **field names and the 21-key set are exactly** A2's `BYTECODE_V2_KEYS` (test `v2_json_has_exactly_the_a2_schema`).
- **One deviation:** the A2 proposal text said *sha256* for the digests; v2 uses **keccak-256** with the framing above. This avoids adding `sha2`, which would change the lock entry and closure.
- The A2 gate checks only 64 lowercase hex, so **no A2 code change is required**. Only the wording in `a2-bytecode-integration/NATIVE-V2-PROPOSAL.md` (frozen; not edited) is outdated.

## Tests (`crate/src/tests.rs`: 13 v1 + 10 new = 23)

**v1 tests are unchanged except for two fixture changes:**
1. `make_db` now also writes the 5 stage checkpoints (at 52,866,960).
2. The v1 end-to-end test's good-DB scan uses `scan_datadir`, because v2 `ok` needs the datadir binding. Its assertions are unchanged.

**New tests:**
- `framed_digest_is_stable_and_length_and_count_framed`: the digest is deterministic; part lengths, item count and domain each change it.
- `v2_scan_valid_fixture_is_ok_with_exact_counts_digests_and_checkpoints`: on a real MDBX fixture, it checks exact counts (rows 2 = entries; accounts scanned 4 = entries, including None and the empty hash; 2 with code), the transaction id, both digests **recomputed independently from the fixture inputs**, all checkpoints, and the datadir.
- `v2_scan_leaves_every_byte_of_mdbx_dat_unchanged`: the **full `mdbx.dat` contents** are compared byte for byte before and after a read-only scan, which is stronger than v1's size/mtime check and than a hash comparison.
- `missing_code_bad_row_and_empty_accounts_are_not_ok`: missing code, a bad row (`E_HASH`), an empty `HashedAccounts`, and accounts with no code are all not ok.
- `missing_or_partial_checkpoints_are_not_ok`: none present, or 4 of 5 present, is not ok, and a missing checkpoint is JSON `null`.
- `digests_change_with_one_row_one_byte_or_one_reference`: one extra row or one extra byte changes the rows digest. Two accounts swapping their code leave every count the same but change the refs digest.
- `report_ok_requires_every_v2_binding`: 11 single-field breaks.
- `mutation_between_scans_changes_txn_id_entries_and_digests`: a read-write commit between two scans increases the transaction id and the counts, and changes both digests.
- `read_errors_and_absent_databases_are_never_ok`.
- `v2_json_has_exactly_the_a2_schema`.

## Negative controls (`control/disable_check.py`; each removes ONE rule and must fail EXACTLY the listed tests, with rc 101)

| Control | Rule removed | Must fail exactly |
|---|---|---|
| jumpbit, padding, client, eip7702 | v1 rules (v1 anchors) | v1 sets (unchanged) |
| completeness | missing-row counting | v1 set **+ `missing_code_bad_row_and_empty_accounts_are_not_ok`** |
| entries | `bytecodesEntries == rows` | `report_ok_requires_every_v2_binding` |
| accounts | `hashedAccountsEntries == accountsScanned` | `report_ok…` |
| codele | `accountsWithCode <= accountsScanned` | `report_ok…` |
| withcode | `accountsWithCode > 0` | `missing_code_bad_row_and_empty_accounts…` |
| txnid | transaction id > 0 | `report_ok…` |
| checkpoints | all 5 present | `missing_or_partial_checkpoints…`, `report_ok…` |
| datadir | non-empty datadir | `report_ok…` |
| rowsdigest | the row item in the scan | `v2_scan_valid…`, `digests_change…`, `mutation_between…` |
| refsdigest | the reference item in the scan | the same 3 |
| framing | the per-part length prefix | `framed_digest…` |
| count | the item-count suffix | `framed_digest…` |
| scanned | counting every account | `v2_scan_valid…`, `v2_scan_leaves_every_byte…`, `mutation_between…`, `missing_code_bad_row…`, `mdbx_scan_end_to_end…` |

These sets are **predicted by reading the code; they have not been observed.** A mismatch makes the job INVALID (rc 1), never a pass.

## Build and test job (root; offline; ONE compiler job)

`jobs/root-build-test.sh` is the v1 job with three changes: S points to this stage, the names list has 23 tests, and the loop runs 17 controls. It is otherwise identical:
- toolchain 1.96.0;
- the stage sums must verify;
- the base repo at `5476069f`, with the lock sha `f122da76…`;
- the member at `etc/tools/base-bytecode-check`, with **the same single lock entry** (same 6 dependencies, so `insert_lock_entry.py` is unchanged);
- a **private copy** of the cargo home (index, cache and git) from the same source `client-integrity-next/build/cargo-home`, which is only read;
- the closure manifest must equal `inputs/closure-manifest.json` (byte-identical to v1, since the dependencies are identical);
- `cargo tree --locked` inside the closure;
- every build must be reported `rebuilt` (never fresh), with the lock unchanged;
- 23/23 tests ok by name;
- 17 controls, each with an exact failing set, and `lib.rs` restored and sha-checked after each.

```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/bytecode-v2-validation
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1792 --log $S/logs/root-build-test.guard -- unshare -rn bash $S/jobs/root-build-test.sh > $S/logs/root-build-test.out 2>&1
# release candidate only (separately, later):
RELEASE=1 python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2560 --log $S/logs/root-release.guard -- unshare -rn bash $S/jobs/root-build-test.sh > $S/logs/root-release.out 2>&1
```

- **Pass:** only `## aggregate rc=0`. Exit 98 means not started.
- **Build directory:** `build/` must not exist; never reuse it.
- **Time and memory:** the v1 job's figures apply (same dependency graph); the 12 extra controls each rebuild only this crate. No v2 numbers have been measured.

## Known uncertainties (honest)

1. **Not compiled.** Every API was checked against the pinned source, but type inference has not been proven, notably:
   - the `[(&str, fn(&mut Report)); 11]` closures;
   - the `Cp::new` alias;
   - the `Option` comparisons.

   A compile error is INVALID and needs a reviewed fix, never a weakening.
2. **The byte-for-byte `mdbx.dat` check assumes a read-only MDBX open never writes the data file**; v1 showed only that size and mtime do not change. If the bytes do change, that is a real finding to review, not something to relax.
3. **Transaction-id monotonicity** across a read-write commit is assumed from MDBX semantics.
4. **Root sets `BYTECODE_CHECKER_V2_SHA256`** only after this job and a release build pass, plus a live run under review. Nothing here closes the A2 gap.
