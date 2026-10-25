# Required native helper work: `base-bytecode-check` receipt v2 (PROPOSAL; not applied, not compiled)

The tested checker (`bytecode-native-validation`, `lib.rs` `739c3245…`, release `42d692d4…`) stays frozen. Its v1 receipt proves:
- per-row hash and codec semantics;
- account-code completeness over `HashedAccounts`.

It does **not** prove the following, so v1 can never close `bytecodes-content-unverified`.

| Missing in v1 | Why it matters | v2 field | Change in `scan()` (same read transaction `tx`) |
|---|---|---|---|
| The raw table size | The walked count cannot be compared with what the table holds | `bytecodesEntries`, `hashedAccountsEntries` | `tx.entries::<RawTable<tables::Bytecodes>>()?` and `tx.entries::<tables::HashedAccounts>()?` |
| The total number of accounts scanned | An empty or partly walked `HashedAccounts` yields `accountsWithCode = 0`/`missing = 0` with `ok` still true | `accountsScanned` | Count every `HashedAccounts` row in the `completeness` iterator (not only those with code) |
| Which bytes were checked | The receipt cannot be bound to a table state | `rowsDigest` | sha256 over `u32be(len(k))‖k‖u32be(len(v))‖v` for every row, in cursor order |
| Which code hashes were required | Completeness cannot be re-derived | `codeHashesDigest` | sha256 over the sorted, deduplicated non-empty `bytecode_hash` set (or over cursor order, documented) |
| The DB state of the scan | The receipt cannot show that it read the DB at N | `mdbxTxnId`, `checkpoints{headers,bodies,execution,merkle-execute,finish}` | `tx.inner.id()` (pinned reth-mdbx API, to be checked against the source), and `tx.get::<tables::StageCheckpoints>(StageId::…)` for the 5 stages, in the **same** `tx` |
| Its target | Prevents a receipt for another datadir being used | `datadir` | Echo argv[1] exactly |

**Exit and fail-closed rules:**
- These are unchanged: the checker exits 0 only if `ok`.
- `ok` additionally requires:
  - `rows == bytecodesEntries`;
  - `accountsScanned == hashedAccountsEntries`;
  - `accountsWithCode > 0`;
  - every listed checkpoint present.
- `a2a4.py` re-checks every one of these, and never trusts `ok` alone.

**Required before `BYTECODE_CHECKER_V2_SHA256` may be set (a reviewed source change):**
1. A reviewed v2 `lib.rs`/`main.rs` diff, with new tests:
   - the entries cross-check, using a forged count via a test-only hook or a real MDBX with known rows;
   - the digest is stable across two scans and changes with one byte;
   - the checkpoints are read in the same transaction;
   - an empty `HashedAccounts` is not `ok`.
2. Controls disabling each new rule.
3. The full 13 + new tests and the controls pass on the shared queue (native lane).
4. A pinned release build and its sha.
5. A live read-only run on the stopped datadir at N under root review.

## Verified coverage (pinned reth `7134be3`; read-only source inspection)

- **Under v2 storage, execution reads accounts from `HashedAccounts`** (`providers/state/latest.rs:73-80`) and **code from MDBX `Bytecodes`** (`latest.rs:300`, `get_by_encoded_key::<tables::Bytecodes>`).
- **RocksDB holds only** `TransactionHashNumbers`, `AccountsHistory` and `StoragesHistory` (`providers/rocksdb/provider.rs:324-330`). `Bytecodes` and `HashedAccounts` are not in RocksDB or in static files.
- **What authenticates what:**
  - A4 rebuilds the trie from `HashedAccounts` (`--from 0`) and must reproduce the authenticated header-N state root. Every account's code hash (its `bytecode_hash`, or `KECCAK_EMPTY`) is part of that root, so the **set of referenced code hashes is authenticated**.
  - The checker's per-row `keccak(code) == key` authenticates each row's content.
  - Its completeness walk ensures every referenced non-empty hash **has a row**, so the absence hole is covered.
- **The remaining coverage gaps are binding gaps, not semantic gaps:**
  - nothing in v1 proves which DB state the scan transaction saw (the table above);
  - the A4→scan link rests on `db_identity` (mdbx `dev`/`ino`/size/mtime + stage-checkpoint text + header-N hash) plus the step-ordered mutation journal. That is root-custody evidence, not a cryptographic binding; an attacker with root write access to the datadir is outside the model.
- **Not covered by any scan here** (stated rather than closed): code that our own EL writes **after N** during derivation. It is written by our executing client, not downloaded.
