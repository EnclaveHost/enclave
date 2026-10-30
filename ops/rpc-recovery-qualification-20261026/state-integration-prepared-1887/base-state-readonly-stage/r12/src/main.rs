//! base-state-readonly (base-state-readonly-stage/r6): OFFLINE, READ-ONLY integrity checks of a Base (reth 7134be3) datadir.
//! PREPARED by Claude, NOT compiled by Claude. Reuses ONLY official reth code paths:
//!   * open:   reth_db::open_db_read_only (MDBX RO; never creates) + StaticFileProviderBuilder::read_only (as common.rs RO)
//!   * root (r6, review 1730, MANDATORY): StateRoot::new(NoopTrieCursorFactory, DatabaseHashedCursorFactory).root() - the root
//!             recomputed from EVERY HashedAccounts / HashedStorages entry with NO trie table (the construction the upstream
//!             Verifier uses, crates/trie/trie/src/verify.rs:104-105); streaming, no updates retained
//!   * cache (r6, MANDATORY): reth_trie::verify::Verifier over the stored AccountsTrie / StoragesTrie (adapter chosen like
//!             reth_trie_db::with_adapter!), exactly as `db repair-trie --dry-run` (repair_trie.rs:127-169); every Output other
//!             than Progress is an inconsistency; bounded memory (root_with_progress threshold)
//!   * cachedWalk: DbStateRoot::from_tx(tx).root() (repair_trie.rs:356-368) - DIAGNOSTIC ONLY. It reuses stored branch hashes (walker
//!             skips every hash-flagged node; a stored root node with root_hash can be returned without reading any leaf) and
//!             therefore never makes a pass; it can only add a failure (cachedWalk != fromHashedOnly)
//!   * header: StaticFileProvider::header_by_number(Finish checkpoint).state_root (BasePrimitives::BlockHeader = alloy Header)
//! G7 plain -> hashed (FULL, no samples): every PlainAccountState / PlainStorageState entry must exist with an EQUAL value at
//!   keccak256(key) in HashedAccounts / HashedStorages, AND the entry counts must be equal (bijection). v1 layouts only; v2 =
//!   NOT_APPLICABLE (write_state_changes skips plain state when use_hashed_state()), never passed.
//! Refuses (exit 3) instead of reading an empty store: missing db/mdbx.dat, missing static_files dir or tip header. It never opens
//!   RocksDB and never creates anything (history indices are reported NOT CHECKED).
//! r11 (1858 audit + independent review 1861; pinned reth 7134be3). Every refusal below happens BEFORE the root/cache computation:
//!   * StageCheckpoints / StageCheckpointProgresses keys are the db-api String alias (db-api tables/mod.rs:518-527,623): `.to_string()`
//!   * Metadata "partial_state_trie_unwind" present (node/builder launch/common.rs:1444, an interrupted partial-trie unwind) -> refuse
//!   * Finish unit checkpoint: proceed ONLY on None or Finish(FinishCheckpoint{partial_state_trie: None}); ANY Some(frontier) (lt/eq/gt
//!     Finish: provider.rs save_blocks/:842-848 writes Some(p) while hashed state/trie lag, save_blocks.rs:8-30) or any other unit
//!     variant -> refuse. The pub FIELD is matched (not the accessor, which is None without the feature); decoding needs
//!     reth-stages-types/partial-persistence (Cargo.toml), without it the walk panics (fail-closed)
//!   * StageCheckpointProgresses[MerkleExecute] present AND non-empty -> refuse (repair_trie.rs verify_checkpoints); empty/absent is fine
//!   * v2 RocksDB (only the history indices live there: db-api models/metadata.rs:17-26,68-92): `--rocksdb` a real dir with a regular
//!     CURRENT -> PRESENT (not opened); path ABSENT -> proceed ONLY if TransactionLookup, IndexAccountHistory, IndexStorageHistory
//!     checkpoints are all PRESENT and 0 (the snapshot reset, cli download/config_gen.rs reset_index_stage_checkpoints_tx), else
//!     refuse; anything else at the path (a dir without CURRENT, a file, a symlink, an unreadable path) -> refuse. Zero index
//!     checkpoints are NOT a health signal: they only mean the history indices are absent (NOT CHECKED).
//!   * report-only: tip header parentHash / withdrawalsRoot (NOT verified, NOT canonical). The 5-way coherence, the hashed-only root,
//!     the Verifier and the exit logic are unchanged: v2 can only exit 3, 4 or 5 (never full).
//! Exit (r6): 0 = FULL: fromHashedOnly root == header AND trie cache 0 inconsistencies AND cachedWalk == fromHashedOnly AND
//!   checkpoints coherent AND plain->hashed PASS; 5 = PARTIAL: all of those pass but plain->hashed NOT_RUN or NOT_APPLICABLE (v2);
//!   4 = a check FAILED; 3 = refused. fullStateIntegrity can never be true without BOTH the hashed-only root and the Verifier.
//! NOT a chain-anchor check: the tip header is NOT proven canonical here (G8 is separate).
use alloy_consensus::Header;
use alloy_primitives::{keccak256, B256};
use reth_db::{mdbx::DatabaseArguments, open_db_read_only};
use reth_db_api::{
    cursor::{DbCursorRO, DbDupCursorRO},
    database::Database,
    models::{ClientVersion, StorageSettings},
    tables,
    transaction::DbTx,
};
use reth_ethereum_primitives::EthPrimitives;
use reth_provider::providers::{StaticFileProvider, StaticFileProviderBuilder};
use reth_stages_types::{FinishCheckpoint, StageId, StageUnitCheckpoint};
use reth_storage_api::HeaderProvider;
use reth_trie::{trie_cursor::noop::NoopTrieCursorFactory, verify::{Output, Verifier}, StateRoot};
use reth_trie_db::{
    DatabaseHashedCursorFactory, DatabaseStateRoot, DatabaseTrieCursorFactory, LegacyKeyAdapter, PackedKeyAdapter,
    TrieTableAdapter,
};
use serde_json::{json, Value};
use std::{io::Write, os::unix::fs::OpenOptionsExt, path::PathBuf, time::Instant};

// the typed `let header: Header = sfp.header_by_number(..)` below fixes EthPrimitives::BlockHeader == alloy Header at compile time
// (BasePrimitives::BlockHeader = Header, base crates/common/consensus/src/reth_compat.rs:521-526); no tx/receipt is decoded

struct Args { db: PathBuf, static_files: PathBuf, rocksdb: PathBuf, out: PathBuf, plain: bool }

fn refuse(msg: impl Into<String>) -> ! {
    eprintln!("REFUSED: {}", msg.into());
    std::process::exit(3)
}

fn parse_args() -> Args {
    let mut it = std::env::args().skip(1);
    let (mut db, mut sf, mut rk, mut out, mut plain) = (None, None, None, None, false);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--db" => db = it.next().map(PathBuf::from),
            "--static-files" => sf = it.next().map(PathBuf::from),
            "--rocksdb" => rk = it.next().map(PathBuf::from),
            "--out" => out = it.next().map(PathBuf::from),
            "--plain-hashed" => plain = true,
            _ => refuse(format!("unknown argument {a}")),
        }
    }
    let need = |p: Option<PathBuf>, n: &str| {
        let p = p.unwrap_or_else(|| refuse(format!("{n} is required")));
        if !p.is_absolute() { refuse(format!("{n} must be absolute")) }
        p
    };
    Args { db: need(db, "--db"), static_files: need(sf, "--static-files"), rocksdb: need(rk, "--rocksdb"), out: need(out, "--out"), plain }
}

fn dir_exists(p: &PathBuf) -> bool {
    std::fs::symlink_metadata(p).map(|m| m.is_dir()).unwrap_or(false)
}

/// DIAGNOSTIC ONLY: the cached walk over stored trie nodes (never a pass condition)
fn cached_walk_root<A: TrieTableAdapter, TX: DbTx>(tx: &TX) -> eyre::Result<B256> {
    Ok(StateRoot::<DatabaseTrieCursorFactory<&TX, A>, DatabaseHashedCursorFactory<&TX>>::from_tx(tx).root()?)
}

/// r6 MANDATORY: the root recomputed from the hashed tables only (no trie table is read)
fn hashed_only_root<TX: DbTx>(tx: &TX) -> eyre::Result<B256> {
    Ok(StateRoot::new(NoopTrieCursorFactory, DatabaseHashedCursorFactory::new(tx)).root()?)
}

/// r6 MANDATORY: the stored trie cache against a full recomputation from the hashed tables (= repair-trie --dry-run)
fn verify_cache<A: TrieTableAdapter, TX: DbTx>(tx: &TX) -> eyre::Result<Value> {
    let t0 = Instant::now();
    let tf = DatabaseTrieCursorFactory::<_, A>::new(tx);
    let (mut acct, mut stor, mut samples) = (0u64, 0u64, Vec::<String>::new());
    for o in Verifier::new(&tf, DatabaseHashedCursorFactory::new(tx))? {
        match o? {
            Output::Progress(_) => {}
            o @ (Output::AccountExtra(..) | Output::AccountWrong { .. } | Output::AccountMissing(..)) => {
                acct += 1;
                if samples.len() < 64 { samples.push(format!("{o:?}")) }
            }
            o => {
                stor += 1;
                if samples.len() < 64 { samples.push(format!("{o:?}")) }
            }
        }
    }
    Ok(json!({"status": if acct == 0 && stor == 0 { "PASS" } else { "FAIL" }, "accountInconsistencies": acct,
              "storageInconsistencies": stor, "samplesFirst64": samples, "seconds": t0.elapsed().as_secs(),
              "accountsTrieEntries": tx.entries::<tables::AccountsTrie>()?, "storagesTrieEntries": tx.entries::<tables::StoragesTrie>()?,
              "method": "reth_trie::verify::Verifier (repair-trie --dry-run): full recomputation from hashed tables, node-by-node vs the stored trie"}))
}

fn plain_vs_hashed<TX: DbTx>(tx: &TX) -> eyre::Result<Value> {
    let t0 = Instant::now();
    let (mut pa, mut acct_bad, mut bad_samples) = (0u64, 0u64, Vec::<Value>::new());
    let mut hashed = tx.cursor_read::<tables::HashedAccounts>()?;
    let mut plain = tx.cursor_read::<tables::PlainAccountState>()?;
    let mut cur = plain.first()?;
    while let Some((addr, acct)) = cur {
        pa += 1;
        let h = keccak256(addr);
        if hashed.seek_exact(h)?.map(|(_, v)| v) != Some(acct) {
            acct_bad += 1;
            if bad_samples.len() < 64 { bad_samples.push(json!({"table": "account", "address": addr.to_string()})) }
        }
        if pa % 10_000_000 == 0 { eprintln!("accounts {pa} {:?}", t0.elapsed()) }
        cur = plain.next()?;
    }
    let ha = tx.entries::<tables::HashedAccounts>()? as u64;
    let (mut ps, mut slot_bad, mut zero_plain) = (0u64, 0u64, 0u64);
    let mut hs = tx.cursor_dup_read::<tables::HashedStorages>()?;
    let mut pst = tx.cursor_dup_read::<tables::PlainStorageState>()?;
    let mut cur = pst.first()?;
    while let Some((addr, e)) = cur {
        ps += 1;
        if e.value.is_zero() { zero_plain += 1 }
        let (ha_, hk) = (keccak256(addr), keccak256(e.key));
        let ok = matches!(hs.seek_by_key_subkey(ha_, hk)?, Some(h) if h.key == hk && h.value == e.value);
        if !ok {
            slot_bad += 1;
            if bad_samples.len() < 64 { bad_samples.push(json!({"table": "storage", "address": addr.to_string(), "slot": e.key.to_string()})) }
        }
        if ps % 50_000_000 == 0 { eprintln!("slots {ps} {:?}", t0.elapsed()) }
        cur = pst.next()?;
    }
    let hsn = tx.entries::<tables::HashedStorages>()? as u64;
    let pass = acct_bad == 0 && slot_bad == 0 && pa == ha && ps == hsn && zero_plain == 0;
    Ok(json!({"status": if pass { "PASS" } else { "FAIL" }, "plainAccounts": pa, "hashedAccounts": ha, "accountMismatches": acct_bad,
              "plainSlots": ps, "hashedSlots": hsn, "slotMismatches": slot_bad, "zeroValuedPlainSlots": zero_plain,
              "mismatchSamplesFirst64": bad_samples, "seconds": t0.elapsed().as_secs(),
              "method": "every plain entry looked up at keccak256(key) with value equality + equal entry counts (bijection)"}))
}

fn main() -> eyre::Result<()> {
    let a = parse_args();
    if !std::fs::symlink_metadata(a.db.join("mdbx.dat")).map(|m| m.is_file()).unwrap_or(false) {
        refuse("db/mdbx.dat missing: refusing (an empty DB is never opened or created)")
    }
    if !dir_exists(&a.static_files) { refuse("static_files dir missing: refusing (headers live there)") }
    if std::fs::symlink_metadata(&a.out).is_ok() { refuse("--out must not exist") }

    let db = open_db_read_only(&a.db, DatabaseArguments::new(ClientVersion::default()))?;
    let mut tx = db.tx()?;
    tx.disable_long_read_transaction_safety();
    let settings: Option<StorageSettings> = tx
        .get::<tables::Metadata>("storage_settings".to_string())?
        .map(|b| serde_json::from_slice(&b).unwrap_or_else(|e| refuse(format!("unparseable storage_settings: {e}"))));
    // absent metadata = what reth treats as legacy; recorded explicitly
    let v2 = settings.map(|s| s.is_v2()).unwrap_or(false);
    // r11 (1861): an interrupted partial-state-trie unwind leaves this marker; Finish may already be lowered while the trie is not
    if tx.get::<tables::Metadata>("partial_state_trie_unwind".to_string())?.is_some() {
        refuse("Metadata partial_state_trie_unwind marker present: an interrupted partial state-trie unwind; not a complete state snapshot")
    }

    let mut checkpoints = serde_json::Map::new();
    let mut cc = tx.cursor_read::<tables::StageCheckpoints>()?;
    let mut cur = cc.first()?;
    while let Some((k, v)) = cur {
        checkpoints.insert(k.to_string(), json!(v.block_number));
        cur = cc.next()?;
    }
    // r11: the table key is the db-api `StageId = String` alias, not the reth_stages_types enum
    let fc = tx.get::<tables::StageCheckpoints>(StageId::Finish.to_string())?
        .unwrap_or_else(|| refuse("no Finish stage checkpoint"));
    let finish = fc.block_number;
    let finish_unit = match fc.stage_checkpoint {
        None => "none",
        Some(StageUnitCheckpoint::Finish(FinishCheckpoint { partial_state_trie: None })) => "Finish(partial_state_trie: None)",
        Some(StageUnitCheckpoint::Finish(FinishCheckpoint { partial_state_trie: Some(p) })) => refuse(format!(
            "Finish {finish} carries a partial state-trie frontier {p}: the hashed state/trie are not a complete snapshot (any frontier is refused)")),
        Some(other) => refuse(format!("unknown Finish unit checkpoint variant {other:?}: refusing")),
    };
    let merkle_progress = tx.get::<tables::StageCheckpointProgresses>(StageId::MerkleExecute.to_string())?;
    if let Some(v) = &merkle_progress {
        if !v.is_empty() { refuse(format!("MerkleExecute checkpoint progress is non-empty ({} bytes): a merkle stage is in progress", v.len())) }
    }
    let index_stages = [StageId::TransactionLookup, StageId::IndexAccountHistory, StageId::IndexStorageHistory];
    let index_cps: serde_json::Map<String, Value> =
        index_stages.iter().map(|s| (s.to_string(), checkpoints.get(&s.to_string()).cloned().unwrap_or(Value::Null))).collect();
    let rk_meta = std::fs::symlink_metadata(&a.rocksdb);
    let rocks_current = matches!(&rk_meta, Ok(m) if m.is_dir())
        && matches!(std::fs::symlink_metadata(a.rocksdb.join("CURRENT")), Ok(m) if m.is_file());
    let rocksdb_class = if !v2 {
        "NOT_APPLICABLE_V1: no table is routed to RocksDB (not inspected)"
    } else if rocks_current {
        "PRESENT: a directory with a regular CURRENT file; NOT opened"
    } else {
        match &rk_meta {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if index_stages.iter().all(|s| checkpoints.get(&s.to_string()).and_then(Value::as_u64) == Some(0)) {
                    "ABSENT: path absent and the 3 history-index checkpoints are present and 0 (snapshot reset shape); history indices NOT CHECKED"
                } else {
                    refuse(format!("storage v2, RocksDB path absent, but the history-index checkpoints are not all present and 0: {index_cps:?}"))
                }
            }
            Err(e) => refuse(format!("--rocksdb path unreadable: {e}")),
            Ok(_) => refuse("--rocksdb path exists but is not a directory with a regular CURRENT file: ambiguous or partial RocksDB copy"),
        }
    };
    let coherent = [StageId::MerkleExecute, StageId::AccountHashing, StageId::StorageHashing, StageId::Execution]
        .iter().all(|s| checkpoints.get(&s.to_string()) == Some(&json!(finish)));

    let sfp: StaticFileProvider<EthPrimitives> = StaticFileProviderBuilder::read_only(&a.static_files).build()?;
    // r3: a missing tip header is a REFUSAL whether the provider returns Ok(None) or an error (e.g. MissingStaticFileBlock)
    let header: Header = sfp.header_by_number(finish).ok().flatten()
        .unwrap_or_else(|| refuse(format!("tip header {finish} missing or unreadable in static files: refusing")));

    let t0 = Instant::now();
    let cached = if v2 { cached_walk_root::<PackedKeyAdapter, _>(&tx)? } else { cached_walk_root::<LegacyKeyAdapter, _>(&tx)? };
    let t_cached = t0.elapsed().as_secs();
    let t1 = Instant::now();
    let from_hashed = hashed_only_root(&tx)?;                           // r6: the ONLY root that can match the header for a pass
    let t_hashed = t1.elapsed().as_secs();
    let cache = if v2 { verify_cache::<PackedKeyAdapter, _>(&tx)? } else { verify_cache::<LegacyKeyAdapter, _>(&tx)? };
    let root_ok = from_hashed == header.state_root;
    let cache_ok = cache["status"] == "PASS";
    let cached_consistent = cached == from_hashed;                      // diagnostic; a disagreement can only FAIL, never pass
    let plain = if !a.plain { json!({"status": "NOT_RUN"}) }
        else if v2 { json!({"status": "NOT_APPLICABLE_V2", "why": "storage_v2: plain state is not written (provider.rs write_state_changes); hashed state is canonical",
                            "plainAccountsEntries": tx.entries::<tables::PlainAccountState>()?, "plainStorageEntries": tx.entries::<tables::PlainStorageState>()?}) }
        else { plain_vs_hashed(&tx)? };
    let plain_fail = plain["status"] == "FAIL";
    let full = root_ok && cache_ok && cached_consistent && coherent && plain["status"] == "PASS";
    let doc = json!({
        "format": "base-state-readonly/r11",
        "acceptance": "NOT A CHAIN ACCEPTANCE: the Finish header is NOT proven canonical here; history tables, receipts, transactions and RocksDB history indices are NOT checked",
        "storageSettings": settings.map(|s| json!({"storage_v2": s.is_v2()})), "storageSettingsPresent": settings.is_some(),
        "trieKeyAdapter": if v2 { "PackedKeyAdapter" } else { "LegacyKeyAdapter" },
        "rocksdbCurrentPresent": rocks_current, "rocksdbOpened": false, "rocksdbClassification": rocksdb_class,
        "historyIndexCheckpoints": index_cps,
        "historyIndices": "NOT CHECKED (zero index checkpoints only mean the indices are absent; they are NOT a health signal)",
        "unwindMarkerPresent": false, "finishUnitCheckpoint": finish_unit, "finishFrontier": "none",
        "merkleExecuteProgressBytes": merkle_progress.as_ref().map(|v| v.len()),
        "checkpoints": checkpoints, "finish": finish, "checkpointsCoherent": coherent,
        "tipHeader": {"number": header.number, "hash": header.hash_slow().to_string(), "stateRoot": header.state_root.to_string(),
                      "parentHash": header.parent_hash.to_string(), "withdrawalsRoot": header.withdrawals_root.map(|w| w.to_string()),
                      "note": "parentHash/withdrawalsRoot are REPORTED only: not verified; the header is NOT proven canonical"},
        "stateRoot": {"computed": from_hashed.to_string(), "fromHashedOnly": from_hashed.to_string(), "matchesHeader": root_ok,
                      "fromHashedOnlySeconds": t_hashed,
                      "cachedWalk": cached.to_string(), "cachedWalkMatchesHeader": cached == header.state_root,
                      "cachedWalkEqualsFromHashedOnly": cached_consistent, "cachedWalkSeconds": t_cached,
                      "note": "matchesHeader = root recomputed from ALL hashed accounts/storages with no trie table (NoopTrieCursorFactory). cachedWalk reuses stored branch hashes and is DIAGNOSTIC ONLY: it never makes a pass"},
        "trieCache": cache,
        "plainVsHashed": plain,
        "historyIntegrity": "INCOMPLETE: changesets/history indices/receipts/transactions not verified",
        "fullStateIntegrity": full,
        "exitMeaning": "0 FULL (hashed-only root == header + trie cache 0 inconsistencies + cachedWalk consistent + checkpoints + plain->hashed PASS); 5 PARTIAL (plain NOT_RUN/NOT_APPLICABLE: no full state claim); 4 FAILED; 3 refused",
    });
    let mut out = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&a.out)
        .unwrap_or_else(|e| refuse(format!("--out must be a NEW file: {e}")));
    out.write_all(serde_json::to_string_pretty(&doc)?.as_bytes())?;
    out.sync_all()?;
    println!("{}", json!({"written": a.out, "rootMatches": root_ok, "trieCache": cache["status"], "checkpointsCoherent": coherent,
                          "plain": plain["status"], "fullStateIntegrity": full}));
    std::process::exit(if !root_ok || !cache_ok || !cached_consistent || !coherent || plain_fail { 4 } else if full { 0 } else { 5 })
}
