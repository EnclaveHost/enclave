# Base state acceptance gate after `mdbx_chk`: what upstream reth/Base tooling can verify read-only (1678). SOURCE-ONLY, incomplete by turn limit

**Status:** written at the turn limit. The raw findings are preserved below.
- **Not done:** no build, test, mount, USB access, node boot, or execution of the binary.
- **Inputs:**
  - `logs/claude-mdbx-validator-1661.md` and `logs/claude-mdbx-validator-fix-1667.md`;
  - the reth source at the exact pinned revision: cargo checkout **`~/.cargo/git/checkouts/reth-babcd6134566c621/7134be3`** (= `base/reth` tag `base-v2.5.2.8`, `7134be3b…`, per 1661);
  - a bounded `grep -a -c` of strings in the pinned production binary (read, not executed).

**Production binary:** `/home/steven/Documents/Codex/2026-10-18/wo/work/fresh-witness-supply/staging/base-v1.5.1-20261023T053947Z/base`, sha256 **`9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f`** (= 1661, re-hashed here).

## 1. Upstream read-only tools that exist (source-verified at 7134be3)
**The `db` subcommands and their storage access** (`crates/cli/commands/src/db/mod.rs`):

| subcommand | access (`mod.rs` line) | use for the gate |
|---|---|---|
| `db version` | no open (`:195-209`) | `database.version` == 2 |
| `db stats` | `RO`, or `RoInconsistent` (`:121-125`) | table sizes and entries |
| `db stage-checkpoints` | `command.access_rights()` (`:223-226`, not read further) | `Finish` / `AccountHashing` / `StorageHashing` / `MerkleExecute` / `Execution` / `Headers` checkpoints |
| `db static-file-header` | `RoInconsistent` (`:190-191`) | static-file segment block ranges |
| **`db repair-trie --dry-run`** | **`RO`** only when `--dry-run`, else **RW** (`:183-185`) | trie tables vs hashed state |
| `db checksum`, `db get`, `db list`, `db diff`, `db state`, `db account-storage` | `RO` (`:131-155`, `:228-235`) | spot reads only; never full integrity |
| `db drop`, `db clear`, `db migrate-v2`, `repair-trie` without `--dry-run` | **RW: never on the candidate** | |

**`repair-trie --dry-run`, exactly** (`crates/cli/commands/src/db/repair_trie.rs`):
- `verify_only` (`:110-125`) logs `"Database block tip: {Finish checkpoint}"`;
- it opens one RO transaction (`disable_long_read_transaction_safety`) and runs `reth_trie::verify::Verifier` (trie cursors vs hashed cursors) over **all** account and storage trie nodes;
- every mismatch is logged as **`warn!("Inconsistency found: …")`** (`AccountExtra/Wrong/Missing`, `StorageExtra/Wrong/Missing`);
- the end is `info!("Found {} inconsistencies (dry run - no changes made)")`, **and it returns `Ok(())`: exit status 0 even with inconsistencies** (`:127-171`).
- **So the wrapper must parse the log** and require exactly `Found 0 inconsistencies` and no `Inconsistency found` line. Root must not rely on the rc.

**What `--dry-run` does NOT do:**
- It does **not** call `verify_checkpoints` (`:175-…`, used only by `verify_and_repair`, `:219`). That function requires `AccountHashing == StorageHashing == MerkleExecute`, so the gate must compare those checkpoints itself from `db stage-checkpoints`.
- It does **not** compare a state root with the header. Only the RW repair path does that (`verify_repaired_state_root`, `:343-372`: `DbStateRoot::from_tx(..).root()` vs the header's `state_root`, "Repaired trie state root mismatch …").
- **No read-only command found at 7134be3 computes the state root and checks it against a header:**
  - a `grep` for `state_root`/`StateRoot` in `crates/cli/commands/src` finds only `repair_trie.rs`;
  - `db state` (`state.rs`) dumps one account's state;
  - the `stage`, `re_execute`, `import`, `init_state` and other command directories were **not inspected**, for lack of turns.

**Side effects of a "read-only" environment** (`crates/cli/commands/src/common.rs`, `crates/config/src/config.rs`). These matter on a read-only view:
- **(a) Config file:** `Config::from_path` (`config.rs:55-75`) **creates the directory and writes a default `reth.toml`** when the config file is missing. **Pass `--config` to an existing copy of the original `reth.toml` in a scratch dir.** On a read-only view a missing file would fail with EROFS; it never writes into the original.
- **(b) RocksDB directory:** if the RocksDB dir does not exist, RO commands **create an empty RocksDB** there (`common.rs:146-158`, "RocksDB not found, initializing empty database"). **Pass `--datadir.rocksdb <scratch>`** (the flag exists: `crates/node/core/src/args/datadir_args.rs:32`). `--datadir.static-files` also exists (`:24`).
  - **Unknown:** whether the Base v1.5.1 datadir held real data in RocksDB (storage settings). If any tables live in RocksDB and that directory was deleted or not recovered, an empty scratch RocksDB would make reads of those tables silently "empty". **`db settings` / `StorageSettings` must be read first and must show no RocksDB-resident tables.**
- **(c) DB ↔ static-file consistency:** RO (not `RoInconsistent`) runs `static_file_provider().check_consistency(…)` (`common.rs:214-223`). On a read-only DB, an inconsistency only **`warn!("Inconsistent storage. Restart node to heal.")`** and **continues with exit 0**. **The wrapper must treat that log line as a failure.**
- **(d) MDBX open:** `open_db_read_only`, with the lock behaviour as `mdbx_chk` per 1661. The DB dir must be a read-only mount (the 1660 fuse2fs view is).

**These strings are present in the production binary** (bounded `grep -a -c`):
- "Only show inconsistencies without making any repairs" 1;
- `repair-trie` 1, `static-file-header` 2, `stage-checkpoints` 2;
- "Database block tip" 1;
- "Inconsistent storage. Restart node to heal" 1;
- "RocksDB not found, initializing empty database" 1;
- "Repaired trie state root mismatch" 1;
- "Inconsistency found" 2.

**What that shows:** the code is linked. It does **not** prove the `base` CLI exposes it as `base db …`; the production launch used `base --chain mainnet rpc …`. **Root's `--help` probe below decides that.**

## 2. The acceptance gate, by layer (what upstream covers, what is missing)
| # | property | tool | status |
|---|---|---|---|
| G0 | file bytes come from the deleted file | 1649/1658 checksum-valid extent map + 1659 transient-reuse gate | separate (root) |
| G1 | MDBX structure (all B-trees, page accounting) | `mdbx_chk` 0.13.12 (r2/r3 stage) | prepared; **no value checksums exist** (1661) |
| G2 | DB schema version | `base db version` → 2 | upstream, read-only |
| G3 | static files ↔ MDBX consistent | `db static-file-header` + RO-open `check_consistency` (treat the "Inconsistent storage" warn as a fail) | upstream; needs the **recovered or original `static_files/`** (stored **outside** `mdbx.dat`; their status is not established here) |
| G4 | stage checkpoints coherent | `db stage-checkpoints`: require `Finish == MerkleExecute == AccountHashing == StorageHashing == Execution`, ≤ the static-file header tip | upstream (the comparison is ours, trivial) |
| G5 | hashed state → trie | `db repair-trie --dry-run`: require `Found 0 inconsistencies` and no `Inconsistency found` | upstream, a **full** traversal |
| G6 | trie root == the tip header's `stateRoot` | **no RO upstream command found** | **MISSING** (see §3) |
| G7 | plain state → hashed state | **no upstream RO verifier found** | **MISSING**: full-scan code is needed, or state it as "plain state UNVERIFIED" (1667 rule: no sample may qualify) |
| G8 | the tip header is canonical Base | our L1-derived output root: `keccak(0‖stateRoot‖messagePasserStorageRoot‖blockHash)` vs the L1 anchor/dispute game | existing project path (finality/derivation stages); needs the tip header plus `messagePasserStorageRoot` from this DB |
| G9 | value bytes not corrupted inside valid pages | G5 + G6 + G7 together catch state corruption; history/receipt tables are not covered | partial: **say so** |

## 3. Gaps and the smallest options (no new large validator)
**G6, root vs header:**
- **Option A (smallest, no writes):** with G5 = 0 inconsistencies, the stored trie equals the trie of the hashed state. The root hash is then derived from the stored root branch node plus its child hashes.
  - That is a few lines **if** reth exposes the root computation read-only. `DbStateRoot::from_tx(tx).root()` is pure-read on a `DbTx` (`repair_trie.rs:368`), but no CLI wraps it read-only.
  - **The smallest real tool:** a tiny Rust binary against **this exact reth revision** that opens `open_db_read_only` and prints `DbStateRoot::root()` and the `Finish` header `state_root`. That is a new build, root's decision.
- **Option B:** the RW `repair-trie` (without `--dry-run`) does compare. It is **forbidden on the candidate**. It would only be acceptable on a disposable **writable** copy, which needs about 1.14 TB of scratch (the full file), and none is available (`/` ≈ 156 GiB free per HANDOFF).

**G7, plain vs hashed:** no upstream read-only tool found. Options:
- (1) state "plain state UNVERIFIED" explicitly; RPC answers from plain state would then be untrusted for unverified accounts;
- (2) a full read-only scan comparing `PlainAccountState`/`PlainStorageState` with `HashedAccounts`/`HashedStorages` (keccak of keys). That is a new tool and a full read of those tables.

**Static files:** the headers, transactions and receipts live in `static_files/`, outside `mdbx.dat`. Whether they still exist in the original or were deleted too, and their checksums, is **not established**. G3/G4/G8 need them.

## 4. Storage and inputs for the real run (no arbitrary plan)
- **Read-only inputs:**
  - the 1660 read-only view of `db/` (`mdbx.dat`; `mdbx.lck` absent or read-only);
  - the original `static_files/` read-only (to be located);
  - a copy of the original `reth.toml` and `database.version`.
- **Scratch:**
  - an empty `--datadir.rocksdb` dir (MBs; only if `StorageSettings` shows no RocksDB tables);
  - the `--config` copy;
  - logs.
- **No other writes:** RO commands write nothing else per the source above.
- **I/O:** `repair-trie --dry-run` reads all hashed and trie tables (most of the DB). `mdbx_chk` reads all used pages. Each is one full read of up to about 1.13 TB, at an unmeasured rate.
- **Memory:** not measured. `mdbx_chk` needs about 0.6 GB (1661); the reth RO tools are mmap plus cursors. Runs must sit in a queue lane with the 16 GiB floor.

## 5. Root probe (bounded; run only `--help`/`--version`; no data, no network)
**Stage:** `base-state-validator-probe-stage/r1`, `SHA256SUMS` sha256 **`bc621cdb19d46bc6d6451aa9cba43f6892e8c86166b05bd32923b5b7bb6d3988`**; `jobs/help-probes.sh` `b70a5d544530366f0b76837f846d39591658da4e2843c65f86048c683b836b0e`.
```
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
bash jobs/q-exit-status.sh base-help-probes 512 unshare -Urn bash base-state-validator-probe-stage/r1/jobs/help-probes.sh
```
- **Guards:** it verifies the binary sha `9c44836d…` and copies it to a fresh temp dir, with `HOME` and `XDG_*` pointed there. There is no network route (`unshare -Urn`), and it refuses if one exists.
- **Probes:** `--version`, `--help`, `db --help`, `db {version,stats,stage-checkpoints,static-file-header,repair-trie,checksum,get,state} --help`, `stage --help`, `node --help`, `rpc --help`. Each is limited to 30 s and 256 KiB.
- **Failure:** it fails if any probe wrote a file.
- **What it settles:**
  - whether `base db …` exists, and under which name;
  - whether `--dry-run`, `--datadir.rocksdb`, `--datadir.static-files` and `--config` are accepted;
  - whether anything RO exists that I did not inspect (`stage …`).

## 6. Unknowns, stated
- Whether `base` (the Base node CLI) exposes reth's `db` commands. To be decided by §5.
- The `stage`, `re_execute` and `init_state` command directories were not inspected; an RO root check might exist there.
- The status of `static_files/` and RocksDB in the original datadir.
- Whether `db stage-checkpoints` opens RO or `RoInconsistent` (`access_rights()` was not read).
- Run times and memory of the full read-only passes on the recovery view.

**Acceptance:** none of this proves value-level integrity of history tables. **No sample qualifies full integrity** (1667). Any layer that cannot be run fully is reported as **UNVERIFIED**, not passed.
