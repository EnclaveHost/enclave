//! mk_fixture (base-state-readonly-stage/r6): writes ONE DISPOSABLE tiny reth-7134be3 datadir for ONE named case, with the
//! exact pinned schema (reth_db::init_db + reth_db_api::tables, StaticFileProvider read_write headers like
//! reth_db_common::init::insert_genesis_header). PREPARED by Claude, NOT compiled by Claude. It never touches anything but the NEW
//! directory it creates (refuses if it exists). Roots are computed INDEPENDENTLY of reth_trie::StateRoot with alloy-trie's
//! HashBuilder (reth_trie_common::root::{state_root_unsorted, storage_root_unsorted}):
//!   headerRoot   = the CANONICAL root of the fixture (r6 cached cases: of the ORIGINAL hashed state, BEFORE any corruption)
//!   expectedRoot = the root of the hashed tables AS WRITTEN (what the helper's hashed-only root must equal)
//! r4/r5 cases (unchanged): trie tables empty. Their keys have pairwise different first nibbles (accounts keccak e/2/3/4..., slots
//! of 0x11 keccak b/4...), so a full recomputation stores no branch node either: the empty trie IS their consistent cache.
//! r6 cached cases (review 1730): a partner account and a partner slot are found by deterministic search so that two hashed keys
//! share EXACTLY the first nibble; the stored account root and the stored storage root of 0x11 then carry a hash bit over the
//! leaf that N1/N2 modify. The cache = StateRoot(NoopTrieCursorFactory, hashed).root_with_updates() over the ORIGINAL hashed
//! tables, written to AccountsTrie / StoragesTrie (legacy v1 layout); its root must equal the independent alloy root (self-check).
//!   v1-pass-cached-trie            consistent cache, plain = hashed, header = independent root
//!   v1-cached-trie-account-modified cache + header from the ORIGINAL; then the SAME new balance of 0x11 in plain AND hashed
//!   v1-cached-trie-storage-modified cache + header from the ORIGINAL; then the SAME new value of slot 1 of 0x11 in plain AND hashed
//!   v1-stale-trie-node             hashed/plain/header correct; hashes[0] of the stored account root node flipped
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
use reth_trie::{trie_cursor::noop::NoopTrieCursorFactory, StateRoot};
use reth_trie_common::{
    root::{state_root_unsorted, storage_root_unsorted},
    BranchNodeCompact, Nibbles, StorageTrieEntry, StoredNibbles, StoredNibblesSubKey,
};
use reth_trie_db::DatabaseHashedCursorFactory;
use serde_json::json;
use std::{collections::BTreeMap, path::PathBuf};

const CASES: &[&str] = &["v1-pass", "v1-plain-modified", "v1-hashed-missing", "v1-hashed-extra", "v1-wrong-root",
                         "v1-checkpoint-mismatch", "v1-no-header", "v2-not-applicable", "v2-no-rocksdb",
                         "v1-pass-cached-trie", "v1-cached-trie-account-modified", "v1-cached-trie-storage-modified", "v1-stale-trie-node"];
const TIP: u64 = 2;

type State = BTreeMap<Address, (Account, BTreeMap<B256, U256>)>;
type Hashed = BTreeMap<B256, (Account, BTreeMap<B256, U256>)>;

fn base_state() -> State {
    let a = |n: u64, b: u64, code: Option<B256>| Account { nonce: n, balance: U256::from(b), bytecode_hash: code };
    let s = |kv: &[(u64, u64)]| kv.iter().map(|(k, v)| (B256::from(U256::from(*k)), U256::from(*v))).collect::<BTreeMap<_, _>>();
    BTreeMap::from([
        (Address::repeat_byte(0x11), (a(1, 1_000_000_000_000_000_000, None), s(&[(1, 7), (2, 0x42)]))),
        (Address::repeat_byte(0x22), (a(0, 5, Some(keccak256(b"fixture-code"))), s(&[(0x10, 1)]))),
        (Address::repeat_byte(0x33), (a(9, 0, None), s(&[]))),
    ])
}

fn nib(b: &B256, i: usize) -> u8 { if i % 2 == 0 { b[i / 2] >> 4 } else { b[i / 2] & 0x0f } }

/// smallest i >= from whose key shares EXACTLY the first nibble with `target` (differs at the second): deterministic
fn partner(target: B256, from: u64, key: impl Fn(u64) -> B256) -> u64 {
    (from..from + 1_000_000).find(|&i| { let k = key(i); nib(&k, 0) == nib(&target, 0) && nib(&k, 1) != nib(&target, 1) })
        .expect("no partner key found")
}

fn to_hashed(s: &State) -> Hashed {
    s.iter().map(|(a, (acc, st))| (keccak256(a), (*acc, st.iter().map(|(k, v)| (keccak256(k), *v)).collect()))).collect()
}

fn independent_root(h: &Hashed) -> B256 {
    state_root_unsorted(h.iter().map(|(k, (acc, st))| (*k, acc.into_trie_account(storage_root_unsorted(st.iter().map(|(k, v)| (*k, *v)))))))
}

fn fail(msg: &str) -> ! { eprintln!("mk_fixture SELF-CHECK FAILED: {msg}"); std::process::exit(1) }

fn main() -> eyre::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 || !CASES.contains(&args[1].as_str()) || !args[2].starts_with('/') {
        eprintln!("usage: mk_fixture <{}> /abs/new/datadir", CASES.join("|"));
        std::process::exit(2)
    }
    let (case, root_dir) = (args[1].as_str(), PathBuf::from(&args[2]));
    std::fs::create_dir(&root_dir)?;                                 // NEW only: fails if it exists
    let v2 = case.starts_with("v2-");
    let cached = matches!(case, "v1-pass-cached-trie" | "v1-cached-trie-account-modified" | "v1-cached-trie-storage-modified" | "v1-stale-trie-node");
    let a11 = Address::repeat_byte(0x11);
    let slot1 = B256::from(U256::from(1u64));

    // the ORIGINAL (canonical) contents
    let mut plain = base_state();
    let mut search = json!(null);
    if cached {
        let ha = keccak256(a11);
        let pi = partner(ha, 1, |i| keccak256(Address::from_slice(&[[0u8; 12].as_slice(), &i.to_be_bytes()].concat())));
        let pa = Address::from_slice(&[[0u8; 12].as_slice(), &pi.to_be_bytes()].concat());
        let si = partner(keccak256(slot1), 3, |i| keccak256(B256::from(U256::from(i))));
        plain.insert(pa, (Account { nonce: 2, balance: U256::from(3u64), bytecode_hash: None }, BTreeMap::new()));
        plain.get_mut(&a11).unwrap().1.insert(B256::from(U256::from(si)), U256::from(0x99u64));
        search = json!({"partnerAccountLowU64": pi, "partnerAccount": pa.to_string(), "partnerSlot": si,
                        "sharedAccountNibble": nib(&ha, 0), "sharedSlotNibble": nib(&keccak256(slot1), 0)});
    }
    let mut hashed = to_hashed(&plain);
    match case {
        "v1-plain-modified" => { plain.get_mut(&a11).unwrap().1.insert(B256::from(U256::from(2)), U256::from(0x43)); }
        "v1-hashed-missing" => { hashed.get_mut(&keccak256(Address::repeat_byte(0x22))).unwrap().1.remove(&keccak256(B256::from(U256::from(0x10)))); }
        "v1-hashed-extra" => { hashed.insert(keccak256(Address::repeat_byte(0x44)), (Account { nonce: 1, balance: U256::from(1), bytecode_hash: None }, BTreeMap::new())); }
        _ => {}
    }
    if v2 { plain.clear(); }
    // r4/r5 semantics: the header root = the root of the hashed tables as written; r6 cached cases: of the ORIGINAL (pre-corruption)
    let original_hashed = hashed.clone();
    let canonical = independent_root(&original_hashed);
    let mut header_root = canonical;
    if case == "v1-wrong-root" { header_root.0[0] ^= 0xff; }

    // r6 corruptions: the SAME new value in plain AND hashed (applied after the cache is computed from the original)
    let mut acct_change: Option<(B256, Account)> = None;
    let mut slot_change: Option<(B256, B256, U256, U256)> = None;
    match case {
        "v1-cached-trie-account-modified" => {
            let e = plain.get_mut(&a11).unwrap();
            e.0.balance += U256::from(1u64);
            acct_change = Some((keccak256(a11), e.0));
        }
        "v1-cached-trie-storage-modified" => {
            let e = plain.get_mut(&a11).unwrap();
            let old = e.1[&slot1];
            e.1.insert(slot1, old + U256::from(1u64));
            slot_change = Some((keccak256(a11), keccak256(slot1), old, old + U256::from(1u64)));
        }
        _ => {}
    }
    let mut written_hashed = original_hashed.clone();
    if let Some((h, acc)) = acct_change { written_hashed.get_mut(&h).unwrap().0 = acc; }
    if let Some((h, k, _, new)) = slot_change { written_hashed.get_mut(&h).unwrap().1.insert(k, new); }
    let expected_root = independent_root(&written_hashed);              // what the helper's hashed-only root must equal

    // MDBX (exact pinned tables)
    let db_path = root_dir.join("db");
    let db = init_db(&db_path, DatabaseArguments::new(ClientVersion::default()))?;
    let (mut acct_nodes, mut stor_nodes) = (0usize, 0usize);
    {
        let tx = db.tx_mut()?;
        let settings = if v2 { StorageSettings::v2() } else { StorageSettings::v1() };
        tx.put::<tables::Metadata>("storage_settings".to_string(), serde_json::to_vec(&settings)?)?;
        for (a, (acc, st)) in &plain {
            tx.put::<tables::PlainAccountState>(*a, *acc)?;
            for (k, v) in st {
                tx.put::<tables::PlainStorageState>(*a, StorageEntry { key: *k, value: *v })?;
            }
        }
        for (h, (acc, st)) in &original_hashed {
            tx.put::<tables::HashedAccounts>(*h, *acc)?;
            for (k, v) in st {
                tx.put::<tables::HashedStorages>(*h, StorageEntry { key: *k, value: *v })?;
            }
        }
        if cached {
            // the cache from the ORIGINAL hashed tables (upstream StateRoot, no trie table read), then self-checks
            let (reth_root, updates) = StateRoot::new(NoopTrieCursorFactory, DatabaseHashedCursorFactory::new(&tx)).root_with_updates()?;
            if reth_root != canonical { fail("reth StateRoot over the original hashed tables != independent alloy root") }
            let root_node = updates.account_nodes.get(&Nibbles::default()).unwrap_or_else(|| fail("no stored account root node"));
            if !root_node.hash_mask.is_bit_set(nib(&keccak256(a11), 0)) { fail("account root node has no hash bit over 0x11") }
            let st = updates.storage_tries.get(&keccak256(a11)).unwrap_or_else(|| fail("no stored storage trie for 0x11"));
            let st_root = st.storage_nodes.get(&Nibbles::default()).unwrap_or_else(|| fail("no stored storage root node for 0x11"));
            if !st_root.hash_mask.is_bit_set(nib(&keccak256(slot1), 0)) { fail("storage root node has no hash bit over slot 1") }
            for (path, node) in &updates.account_nodes {
                let mut node = node.clone();
                if case == "v1-stale-trie-node" && path.is_empty() {
                    let mut hs: Vec<B256> = node.hashes.as_ref().clone();
                    hs[0].0[0] ^= 0xff;                              // stale/corrupt cache: one stored child hash flipped
                    node = BranchNodeCompact::new(node.state_mask, node.tree_mask, node.hash_mask, hs, node.root_hash);
                }
                tx.put::<tables::AccountsTrie>(StoredNibbles(*path), node)?;
                acct_nodes += 1;
            }
            for (h, st) in &updates.storage_tries {
                for (path, node) in &st.storage_nodes {
                    tx.put::<tables::StoragesTrie>(*h, StorageTrieEntry { nibbles: StoredNibblesSubKey(*path), node: node.clone() })?;
                    stor_nodes += 1;
                }
            }
        }
        // corruptions AFTER the cache: hashed (plain was written with its final value above)
        if let Some((h, acc)) = acct_change { tx.put::<tables::HashedAccounts>(h, acc)?; }
        if let Some((h, k, old, new)) = slot_change {
            if !tx.delete::<tables::HashedStorages>(h, Some(StorageEntry { key: k, value: old }))? { fail("old hashed slot not found") }
            tx.put::<tables::HashedStorages>(h, StorageEntry { key: k, value: new })?;
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
    let expected = json!({"case": case, "storageV2": v2, "tip": TIP, "expectedRoot": expected_root.to_string(), "headerRoot": header_root.to_string(),
                          "canonicalRoot": canonical.to_string(), "cachedTrie": cached, "accountsTrieNodes": acct_nodes, "storagesTrieNodes": stor_nodes,
                          "keySearch": search,
                          "plainAccounts": plain.len(), "plainSlots": plain.values().map(|(_, s)| s.len()).sum::<usize>(),
                          "hashedAccounts": written_hashed.len(), "hashedSlots": written_hashed.values().map(|(_, s)| s.len()).sum::<usize>()});
    std::fs::write(root_dir.join("expected.json"), serde_json::to_vec_pretty(&expected)?)?;
    println!("{expected}");
    Ok(())
}
