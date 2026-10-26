//! mk_fixture (base-state-readonly-stage/r5): writes ONE DISPOSABLE tiny reth-7134be3 datadir for ONE named case, with the
//! exact pinned schema (reth_db::init_db + reth_db_api::tables, StaticFileProvider read_write headers like
//! reth_db_common::init::insert_genesis_header). PREPARED by Claude, NOT compiled by Claude. It never touches anything but the NEW
//! directory it creates (refuses if it exists). The expected root is computed INDEPENDENTLY of reth_trie::StateRoot with alloy-trie's
//! HashBuilder (reth_trie_common::root::{state_root_unsorted, storage_root_unsorted}) over the HASHED contents as written, so that
//! plain-vs-hashed defects are isolated from the root check. Trie tables are left empty (StateRoot then derives every node from the
//! hashed tables, as for genesis).
//!     mk_fixture CASE /abs/new/datadir      -> datadir/{db/mdbx.dat, static_files/, [rocksdb/CURRENT], expected.json}
use alloy_consensus::Header;
use alloy_primitives::{keccak256, Address, B256, U256};
use reth_db::{init_db, mdbx::DatabaseArguments};
use reth_db_api::{
    database::Database,
    models::{ClientVersion, StorageSettings},
    tables,
    transaction::{DbTx, DbTxMut},                 // r4: commit() is a DbTx method (db-api transaction.rs)
};
use reth_ethereum_primitives::EthPrimitives;
use reth_primitives_traits::{Account, StorageEntry};
use reth_provider::providers::{StaticFileProviderBuilder, StaticFileWriter};
use reth_stages_types::{StageCheckpoint, StageId};
use reth_static_file_types::StaticFileSegment;
use reth_trie_common::root::{state_root_unsorted, storage_root_unsorted};
use serde_json::json;
use std::{collections::BTreeMap, path::PathBuf};

const CASES: &[&str] = &["v1-pass", "v1-plain-modified", "v1-hashed-missing", "v1-hashed-extra", "v1-wrong-root",
                         "v1-checkpoint-mismatch", "v1-no-header", "v2-not-applicable", "v2-no-rocksdb"];
const TIP: u64 = 2;

type State = BTreeMap<Address, (Account, BTreeMap<B256, U256>)>;

fn base_state() -> State {
    let a = |n: u64, b: u64, code: Option<B256>| Account { nonce: n, balance: U256::from(b), bytecode_hash: code };
    let s = |kv: &[(u64, u64)]| kv.iter().map(|(k, v)| (B256::from(U256::from(*k)), U256::from(*v))).collect::<BTreeMap<_, _>>();
    BTreeMap::from([
        (Address::repeat_byte(0x11), (a(1, 1_000_000_000_000_000_000, None), s(&[(1, 7), (2, 0x42)]))),
        (Address::repeat_byte(0x22), (a(0, 5, Some(keccak256(b"fixture-code"))), s(&[(0x10, 1)]))),
        (Address::repeat_byte(0x33), (a(9, 0, None), s(&[]))),
    ])
}

fn main() -> eyre::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 || !CASES.contains(&args[1].as_str()) || !args[2].starts_with('/') {
        eprintln!("usage: mk_fixture <{}> /abs/new/datadir", CASES.join("|"));
        std::process::exit(2)
    }
    let (case, root_dir) = (args[1].as_str(), PathBuf::from(&args[2]));
    std::fs::create_dir(&root_dir)?;                                 // NEW only: fails if it exists
    let v2 = case.starts_with("v2-");

    // plain (v1 only: at 7134be3 v2 does not write plain state) and hashed contents
    let mut plain = base_state();
    let mut hashed: BTreeMap<B256, (Account, BTreeMap<B256, U256>)> = base_state()
        .into_iter()
        .map(|(a, (acc, st))| (keccak256(a), (acc, st.into_iter().map(|(k, v)| (keccak256(k), v)).collect())))
        .collect();
    match case {
        "v1-plain-modified" => { plain.get_mut(&Address::repeat_byte(0x11)).unwrap().1.insert(B256::from(U256::from(2)), U256::from(0x43)); }
        "v1-hashed-missing" => { hashed.get_mut(&keccak256(Address::repeat_byte(0x22))).unwrap().1.remove(&keccak256(B256::from(U256::from(0x10)))); }
        "v1-hashed-extra" => { hashed.insert(keccak256(Address::repeat_byte(0x44)), (Account { nonce: 1, balance: U256::from(1), bytecode_hash: None }, BTreeMap::new())); }
        _ => {}
    }
    if v2 { plain.clear(); }

    // the expected root: alloy-trie HashBuilder over the hashed contents as written (independent of reth_trie::StateRoot)
    let root = state_root_unsorted(hashed.iter().map(|(h, (acc, st))| {
        (*h, acc.clone().into_trie_account(storage_root_unsorted(st.iter().map(|(k, v)| (*k, *v)))))
    }));
    let mut header_root = root;
    if case == "v1-wrong-root" { header_root.0[0] ^= 0xff; }

    // MDBX (exact pinned tables)
    let db_path = root_dir.join("db");
    let db = init_db(&db_path, DatabaseArguments::new(ClientVersion::default()))?;
    {
        let tx = db.tx_mut()?;
        let settings = if v2 { StorageSettings::v2() } else { StorageSettings::v1() };
        tx.put::<tables::Metadata>("storage_settings".to_string(), serde_json::to_vec(&settings)?)?;
        for (a, (acc, st)) in &plain {
            tx.put::<tables::PlainAccountState>(*a, acc.clone())?;
            for (k, v) in st {
                tx.put::<tables::PlainStorageState>(*a, StorageEntry { key: *k, value: *v })?;
            }
        }
        for (h, (acc, st)) in &hashed {
            tx.put::<tables::HashedAccounts>(*h, acc.clone())?;
            for (k, v) in st {
                tx.put::<tables::HashedStorages>(*h, StorageEntry { key: *k, value: *v })?;
            }
        }
        for s in [StageId::Execution, StageId::AccountHashing, StageId::StorageHashing, StageId::MerkleExecute, StageId::Finish] {
            let n = if case == "v1-checkpoint-mismatch" && s == StageId::StorageHashing { TIP - 1 } else { TIP };
            tx.put::<tables::StageCheckpoints>(s, StageCheckpoint::new(n))?;
        }
        tx.commit()?;
    }
    drop(db);
    let lck = db_path.join("mdbx.lck");                              // like the real candidate view: no lock file
    if lck.exists() { std::fs::remove_file(&lck)?; }

    // static-file headers 0..=TIP (v1-no-header: 0..TIP only, so the Finish header is missing)
    let sf_path = root_dir.join("static_files");
    std::fs::create_dir(&sf_path)?;
    let mut headers = Vec::new();
    let mut parent = B256::ZERO;
    let last = if case == "v1-no-header" { TIP - 1 } else { TIP };
    for n in 0..=last {
        let h = Header { number: n, parent_hash: parent, state_root: if n == TIP { header_root } else { B256::ZERO }, ..Default::default() };
        parent = h.hash_slow();
        headers.push(h);
    }
    {
        let sfp = StaticFileProviderBuilder::read_write(&sf_path).build::<EthPrimitives>()?;
        {
            let mut w = sfp.get_writer(0, StaticFileSegment::Headers)?;
            for h in &headers {
                w.append_header(h, &h.hash_slow())?;
            }
        }
        sfp.commit()?;
    }
    if v2 && case != "v2-no-rocksdb" {
        // placeholder ONLY so the helper's presence check passes; the helper never opens RocksDB (history = NOT CHECKED)
        std::fs::create_dir(root_dir.join("rocksdb"))?;
        std::fs::write(root_dir.join("rocksdb").join("CURRENT"), b"MANIFEST-000001\n")?;
    }
    let expected = json!({"case": case, "storageV2": v2, "tip": TIP, "expectedRoot": root.to_string(), "headerRoot": header_root.to_string(),
                          "plainAccounts": plain.len(), "plainSlots": plain.values().map(|(_, s)| s.len()).sum::<usize>(),
                          "hashedAccounts": hashed.len(), "hashedSlots": hashed.values().map(|(_, s)| s.len()).sum::<usize>()});
    std::fs::write(root_dir.join("expected.json"), serde_json::to_vec_pretty(&expected)?)?;
    println!("{expected}");
    Ok(())
}
