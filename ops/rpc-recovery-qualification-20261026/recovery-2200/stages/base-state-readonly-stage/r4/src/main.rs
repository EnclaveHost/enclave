//! base-state-readonly (base-state-readonly-stage/r4): OFFLINE, READ-ONLY integrity checks of a Base (reth 7134be3) datadir.
//! PREPARED by Claude, NOT compiled by Claude. Reuses ONLY official reth code paths:
//!   * open:   reth_db::open_db_read_only (MDBX RO; never creates) + StaticFileProviderBuilder::read_only (as common.rs RO)
//!   * root:   reth_trie::StateRoot<DatabaseTrieCursorFactory<&TX, A>, DatabaseHashedCursorFactory<&TX>>::from_tx(tx).root()
//!             = the `DbStateRoot` of crates/cli/commands/src/db/repair_trie.rs:356-368, with A chosen exactly like
//!             reth_trie_db::with_adapter! (v2 -> PackedKeyAdapter, else LegacyKeyAdapter) from the PERSISTED storage settings
//!   * header: StaticFileProvider::header_by_number(Finish checkpoint).state_root (BasePrimitives::BlockHeader = alloy Header)
//! G7 plain -> hashed (FULL, no samples): every PlainAccountState / PlainStorageState entry must exist with an EQUAL value at
//!   keccak256(key) in HashedAccounts / HashedStorages, AND the entry counts must be equal (with keccak injective that is a
//!   bijection: both directions). Only meaningful for v1 layouts: at 7134be3 `write_state_changes` skips plain state when
//!   `use_hashed_state()` (= storage_v2), so on v2 the check is reported NOT_APPLICABLE, never passed.
//! Refuses (exit 3) instead of reading an empty store: missing db/mdbx.dat, missing static_files dir or tip header, v2 with no
//!   RocksDB CURRENT file. It never opens RocksDB (history indices are reported NOT CHECKED).
//! Exit (r3): 0 = FULL: root == header AND checkpoints coherent AND plain->hashed PASS; 5 = PARTIAL: root and checkpoints pass but
//!   plain->hashed NOT_RUN or NOT_APPLICABLE (v2) - never a full state-integrity claim; 4 = a check FAILED; 3 = refused. One NEW JSON.
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
use reth_stages_types::StageId;
use reth_storage_api::HeaderProvider;
use reth_trie::StateRoot;
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

fn state_root<A: TrieTableAdapter, TX: DbTx>(tx: &TX) -> eyre::Result<B256> {
    Ok(StateRoot::<DatabaseTrieCursorFactory<&TX, A>, DatabaseHashedCursorFactory<&TX>>::from_tx(tx).root()?)
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
    let rocks_current = a.rocksdb.join("CURRENT").exists();
    if v2 && !rocks_current { refuse("storage v2 but RocksDB CURRENT missing: refusing (history indices would read empty)") }

    let mut checkpoints = serde_json::Map::new();
    let mut cc = tx.cursor_read::<tables::StageCheckpoints>()?;
    let mut cur = cc.first()?;
    while let Some((k, v)) = cur {
        checkpoints.insert(k.to_string(), json!(v.block_number));
        cur = cc.next()?;
    }
    let finish = tx.get::<tables::StageCheckpoints>(StageId::Finish)?
        .unwrap_or_else(|| refuse("no Finish stage checkpoint")).block_number;
    let coherent = [StageId::MerkleExecute, StageId::AccountHashing, StageId::StorageHashing, StageId::Execution]
        .iter().all(|s| checkpoints.get(&s.to_string()) == Some(&json!(finish)));

    let sfp: StaticFileProvider<EthPrimitives> = StaticFileProviderBuilder::read_only(&a.static_files).build()?;
    // r3: a missing tip header is a REFUSAL whether the provider returns Ok(None) or an error (e.g. MissingStaticFileBlock)
    let header: Header = sfp.header_by_number(finish).ok().flatten()
        .unwrap_or_else(|| refuse(format!("tip header {finish} missing or unreadable in static files: refusing")));

    let t0 = Instant::now();
    let computed = if v2 { state_root::<PackedKeyAdapter, _>(&tx)? } else { state_root::<LegacyKeyAdapter, _>(&tx)? };
    let root_ok = computed == header.state_root;
    let plain = if !a.plain { json!({"status": "NOT_RUN"}) }
        else if v2 { json!({"status": "NOT_APPLICABLE_V2", "why": "storage_v2: plain state is not written (provider.rs write_state_changes); hashed state is canonical",
                            "plainAccountsEntries": tx.entries::<tables::PlainAccountState>()?, "plainStorageEntries": tx.entries::<tables::PlainStorageState>()?}) }
        else { plain_vs_hashed(&tx)? };
    let plain_fail = plain["status"] == "FAIL";
    let full = root_ok && coherent && plain["status"] == "PASS";
    let doc = json!({
        "format": "base-state-readonly/r4",
        "acceptance": "NOT A CHAIN ACCEPTANCE: the Finish header is NOT proven canonical here; history tables, receipts, transactions and RocksDB history indices are NOT checked",
        "storageSettings": settings.map(|s| json!({"storage_v2": s.is_v2()})), "storageSettingsPresent": settings.is_some(),
        "trieKeyAdapter": if v2 { "PackedKeyAdapter" } else { "LegacyKeyAdapter" },
        "rocksdbCurrentPresent": rocks_current, "rocksdbOpened": false,
        "checkpoints": checkpoints, "finish": finish, "checkpointsCoherent": coherent,
        "tipHeader": {"number": header.number, "hash": header.hash_slow().to_string(), "stateRoot": header.state_root.to_string()},
        "stateRoot": {"computed": computed.to_string(), "matchesHeader": root_ok, "seconds": t0.elapsed().as_secs(),
                      "note": "uses stored trie nodes (same as repair_trie's DbStateRoot); FULL trie-vs-hashed coverage needs `db repair-trie --dry-run` = Found 0 inconsistencies"},
        "plainVsHashed": plain,
        "historyIntegrity": "INCOMPLETE: changesets/history indices/receipts/transactions not verified",
        "fullStateIntegrity": full,
        "exitMeaning": "0 FULL (root+checkpoints+plain->hashed PASS); 5 PARTIAL (plain NOT_RUN/NOT_APPLICABLE: no full state claim); 4 FAILED; 3 refused",
    });
    let mut out = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&a.out)
        .unwrap_or_else(|e| refuse(format!("--out must be a NEW file: {e}")));
    out.write_all(serde_json::to_string_pretty(&doc)?.as_bytes())?;
    out.sync_all()?;
    println!("{}", json!({"written": a.out, "rootMatches": root_ok, "checkpointsCoherent": coherent, "plain": plain["status"], "fullStateIntegrity": full}));
    std::process::exit(if !root_ok || !coherent || plain_fail { 4 } else if full { 0 } else { 5 })
}
