//! Unit + MDBX tests. Rows are written by the PINNED client encoder (reth-primitives-traits 0.6.0 `to_compact` via the
//! table codec), and every "harmful" forgery is first shown to be decoded by the PINNED client decoder (no panic, wrong
//! execution) or to panic it, so each refusal below is about real client behaviour, not about the checker's own model.
use super::*;
use alloy_primitives::U256;
use reth_db_api::transaction::DbTxMut;
use reth_primitives_traits::Account;
use std::panic::{AssertUnwindSafe, catch_unwind};

// PUSH1 0x04 JUMP INVALID JUMPDEST STOP: offset 4 is the only valid jump target
const CODE: &[u8] = &[0x60, 0x04, 0x56, 0xfe, 0x5b, 0x00];
const DELEGATION: [u8; 23] = [0xef, 0x01, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

/// (key, row) exactly as the pinned client writes it.
fn client_row(code: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let b = ClientBytecode(Revm::new_raw_checked(Bytes::copy_from_slice(code)).expect("valid code"));
    (keccak256(code).to_vec(), RawValue::new(b).into_value())
}
fn raw_row(tag: u8, b: &[u8]) -> Vec<u8> {
    let mut v = (b.len() as u32).to_be_bytes().to_vec();
    v.extend_from_slice(b);
    v.push(tag);
    v
}
fn l_of(v: &[u8]) -> usize {
    u32::from_be_bytes([v[0], v[1], v[2], v[3]]) as usize
}
/// byte offset of the jump table in a tag-2 row
fn jt_at(v: &[u8]) -> usize {
    4 + l_of(v) + 1 + 8
}
fn client_panics(v: &[u8]) -> bool {
    catch_unwind(AssertUnwindSafe(|| client_decode(v))).is_err()
}
fn code_of(e: Result<RowOk, String>) -> String {
    e.expect_err("must be refused").split(':').next().unwrap().to_string()
}

#[test]
fn client_written_rows_are_canonical_and_agree() {
    let corpus: &[&[u8]] = &[CODE, &[], &[0x5b, 0x60], &[0x7f, 1, 2], &[0x60, 1, 0], &[0x61, 0x5b, 0x5b, 0x5b], &[0x60, 1, 0xe6],
                             &[0xe7, 0x00], &[0x00], &[0x5b], &DELEGATION];
    for code in corpus {
        let (k, v) = client_row(code);
        let tag = if code.starts_with(&[0xef, 0x01]) { 4 } else { 2 };
        assert_eq!(verify_row(&k, &v), Ok(RowOk { tag, canonical: true }), "code {code:02x?}");
    }
}

#[test]
fn pseudo_random_client_rows_pass_and_every_read_jump_bit_flip_fails() {
    let mut s: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    let alphabet = [0x5bu8, 0x56, 0x57, 0x00, 0xe6, 0xe7, 0xe8, 0xfe, 0x60, 0x61, 0x7f, 0x6f];
    let mut flips = 0u64;
    for _ in 0..1500 {
        let n = (next() % 300) as usize;
        let code: Vec<u8> = (0..n).map(|_| { let r = next(); if r % 3 == 0 { (r >> 8) as u8 } else { alphabet[(r >> 8) as usize % alphabet.len()] } }).collect();
        if code.starts_with(&[0xef, 0x01]) {
            continue;
        }
        let (k, v) = client_row(&code);
        assert_eq!(verify_row(&k, &v), Ok(RowOk { tag: 2, canonical: true }), "code {code:02x?}");
        let (l, at) = (l_of(&v), jt_at(&v));
        let bit_len = if (v.len() - at) * 8 >= l { l } else { code.len() };
        for i in (0..bit_len).step_by(1 + bit_len / 48) {
            let mut f = v.clone();
            f[at + (i >> 3)] ^= 1 << (i & 7);
            assert_eq!(code_of(check_row(&k, &f)), "E_JUMPBIT", "flip bit {i} of {code:02x?}");
            flips += 1;
        }
    }
    assert!(flips > 10_000, "the generator must exercise many read bits ({flips})");
}

#[test]
fn forged_jump_bits_are_executed_by_the_client() {
    let (k, v) = client_row(CODE);
    let at = jt_at(&v);
    let mut add = v.clone();
    add[at] |= 1 << 1; // PUSH1's immediate (offset 1) marked as a JUMPDEST
    assert!(client_decode(&add).unwrap().legacy_jump_table().unwrap().is_valid(1), "harm: the client would accept a jump into data");
    assert_eq!(code_of(check_row(&k, &add)), "E_JUMPBIT");
    let mut del = v.clone();
    del[at] &= !(1 << 4); // the real JUMPDEST removed
    assert!(!client_decode(&del).unwrap().legacy_jump_table().unwrap().is_valid(4), "harm: a valid jump would fail");
    assert_eq!(code_of(check_row(&k, &del)), "E_JUMPBIT");
    // JUMPDEST PUSH1<missing>: padded L > O, so bits in [O, L) ARE read by the client
    let code2: &[u8] = &[0x5b, 0x60];
    let (k2, v2) = client_row(code2);
    assert!(l_of(&v2) > code2.len(), "fixture must have padding");
    let mut pad = v2.clone();
    pad[jt_at(&v2)] |= 1 << code2.len();
    assert!(client_decode(&pad).unwrap().legacy_jump_table().unwrap().is_valid(code2.len()), "harm: a jump into padding");
    assert_eq!(code_of(check_row(&k2, &pad)), "E_JUMPBIT");
}

#[test]
fn nonzero_padding_is_executed_by_the_client() {
    let code: &[u8] = &[0x60]; // PUSH1 with its immediate missing: padded
    let (k, v) = client_row(code);
    let mut p = v.clone();
    p[4 + code.len()] = 0x5b;
    assert_ne!(client_decode(&p).unwrap().bytes_slice()[code.len()], 0, "harm: the client executes the stored padding");
    assert_eq!(code_of(check_row(&k, &p)), "E_PADDING_NONZERO");
}

#[test]
fn client_panics_exactly_where_the_checker_predicts() {
    let (k, v) = client_row(CODE);
    let mut bad_version = DELEGATION;
    bad_version[2] = 1;
    let mut l_beyond = raw_row(0, CODE);
    l_beyond[..4].copy_from_slice(&100u32.to_be_bytes());
    let mut o_gt_l = v.clone();
    let o_at = 4 + l_of(&v) + 1;
    o_gt_l[o_at..o_at + 8].copy_from_slice(&((l_of(&v) + 1) as u64).to_be_bytes());
    let empty_tag2 = { let mut x = 0u32.to_be_bytes().to_vec(); x.push(2); x.extend_from_slice(&0u64.to_be_bytes()); x };
    let cases: Vec<(&str, Vec<u8>, Vec<u8>)> = vec![
        ("jump table missing", k.clone(), v[..jt_at(&v)].to_vec()),
        ("tag 1", k.clone(), raw_row(1, CODE)),
        ("tag 7", k.clone(), raw_row(7, CODE)),
        ("malformed 7702 as tag 0", keccak256(bad_version).to_vec(), raw_row(0, &bad_version)),
        ("declared length beyond the row", k.clone(), l_beyond),
        ("original_len > L", k.clone(), o_gt_l),
        ("empty tag-2 bytecode", KECCAK256_EMPTY.to_vec(), empty_tag2),
        ("no original_len", k.clone(), raw_row(2, CODE)),
    ];
    for (what, key, row) in cases {
        assert!(client_panics(&row), "{what}: the pinned client decoder must panic (model check)");
        assert!(check_row(&key, &row).is_err(), "{what}: the checker must refuse a row the client panics on");
    }
    assert!(!client_panics(&v), "a canonical row decodes");
}

#[test]
fn rows_the_client_misreads_silently_are_refused() {
    let k = keccak256(CODE).to_vec();
    let legacy_as_7702 = raw_row(4, CODE);
    assert!(!client_decode(&legacy_as_7702).unwrap().is_eip7702(), "the client runs tag-4 legacy bytes as legacy code");
    assert_eq!(code_of(check_row(&k, &legacy_as_7702)), "E_7702");
    let mut lost = 23u32.to_be_bytes().to_vec();
    lost.extend_from_slice(&DELEGATION);
    lost.push(2);
    lost.extend_from_slice(&23u64.to_be_bytes());
    lost.extend_from_slice(&[0u8; 3]);
    assert!(!client_decode(&lost).unwrap().is_eip7702(), "harm: the delegation is lost");
    assert_eq!(code_of(check_row(&keccak256(DELEGATION).to_vec(), &lost)), "E_7702_AS_LEGACY");
    for tag in [0u8, 4] {
        let body: &[u8] = if tag == 0 { CODE } else { &DELEGATION };
        let mut t = raw_row(tag, body);
        t.push(9);
        assert!(!client_panics(&t), "the client silently ignores trailing bytes");
        assert_eq!(code_of(check_row(&keccak256(body).to_vec(), &t)), "E_TRAILING");
    }
    let (k2, v2) = client_row(CODE);
    let mut wrong_key = k2.clone();
    wrong_key[0] ^= 1;
    assert_eq!(code_of(check_row(&wrong_key, &v2)), "E_HASH");
    let mut olen = v2.clone();
    let o_at = 4 + l_of(&v2) + 1;
    olen[o_at + 7] -= 1; // shorter original_len: the key no longer covers the executed code
    assert_eq!(code_of(check_row(&k2, &olen)), "E_HASH");
}

#[test]
fn client_cross_check_independently_refuses_harmful_rows() {
    let (k, v) = client_row(CODE);
    let mut add = v.clone();
    add[jt_at(&v)] |= 1 << 1;
    assert!(agrees_with_client(&k, &add).unwrap_err().starts_with("E_CLIENT"), "forged JUMPDEST");
    let mut pad = client_row(&[0x60]).1;
    let pk = keccak256([0x60u8]).to_vec();
    pad[5] = 0x5b;
    assert!(agrees_with_client(&pk, &pad).unwrap_err().starts_with("E_CLIENT"), "executed padding");
    let mut lost = 23u32.to_be_bytes().to_vec();
    lost.extend_from_slice(&DELEGATION);
    lost.push(2);
    lost.extend_from_slice(&23u64.to_be_bytes());
    lost.extend_from_slice(&[0u8; 3]);
    assert!(agrees_with_client(&keccak256(DELEGATION).to_vec(), &lost).unwrap_err().starts_with("E_CLIENT"), "lost delegation");
    assert_eq!(agrees_with_client(&k, &v), Ok(()));
}

#[test]
fn padding_shorter_than_revm42_is_refused_and_dupn_is_classified() {
    // revm 42 pads a DUPN-family ending one extra byte; an older writer's row has one byte less (client: NOT checked, UB risk)
    for code in [&[0x60u8, 1, 0xe6][..], &[0x60, 1, 0xe8, 0x00][..]] {
        let (k, v) = client_row(code);
        let l = l_of(&v);
        let mut old = ((l - 1) as u32).to_be_bytes().to_vec();
        old.extend_from_slice(&v[4..4 + l - 1]);
        old.extend_from_slice(&v[4 + l..]);
        assert!(!client_panics(&old), "the client accepts the shorter padding silently");
        assert_eq!(code_of(check_row(&k, &old)), "E_PADDING_SHORT_DUPN", "code {code:02x?}");
    }
    let code: &[u8] = &[0x61, 0x01]; // PUSH2 missing one immediate byte: overflow 1 + STOP 1
    let (k, v) = client_row(code);
    let l = l_of(&v);
    let mut short = ((l - 1) as u32).to_be_bytes().to_vec();
    short.extend_from_slice(&v[4..4 + l - 1]);
    short.extend_from_slice(&v[4 + l..]);
    assert_eq!(code_of(check_row(&k, &short)), "E_PADDING_SHORT");
}

#[test]
fn extra_table_bytes_and_bits_past_bit_len_are_non_canonical_not_failures() {
    let (k, v) = client_row(CODE);
    let mut extra = v.clone();
    extra.push(0x00);
    assert_eq!(verify_row(&k, &extra), Ok(RowOk { tag: 2, canonical: false }));
    let mut past = v.clone();
    past.push(0x01); // bit 8 > bit_len (L = 6): never read by the client
    assert_eq!(verify_row(&k, &past), Ok(RowOk { tag: 2, canonical: false }));
}

#[test]
fn size_key_and_length_guards() {
    let (k, v) = client_row(CODE);
    assert_eq!(code_of(check_row(&k[..31], &v)), "E_KEY");
    assert_eq!(code_of(check_row(&k, &v[..6])), "E_SHORT");
    assert_eq!(code_of(check_row(&k, &v[..3])), "E_SHORT");
    let mut huge = v.clone();
    huge[..4].copy_from_slice(&((MAX_CODE_LEN as u32) + 1).to_be_bytes());
    assert_eq!(code_of(check_row(&k, &huge)), "E_OVERSIZE");
}

#[test]
fn raw_tag0_rows_follow_new_raw() {
    let k = keccak256(CODE).to_vec();
    assert_eq!(verify_row(&k, &raw_row(0, CODE)), Ok(RowOk { tag: 0, canonical: false }));
    let kd = keccak256(DELEGATION).to_vec();
    assert_eq!(verify_row(&kd, &raw_row(0, &DELEGATION)), Ok(RowOk { tag: 0, canonical: false }), "raw 7702 decodes as 7702");
    assert!(client_decode(&raw_row(0, &DELEGATION)).unwrap().is_eip7702());
    let mut bad = DELEGATION;
    bad[2] = 0x01;
    assert_eq!(code_of(check_row(&keccak256(bad).to_vec(), &raw_row(4, &bad))), "E_DECODE");
}

#[test]
fn completeness_counts_missing_code_and_ignores_empty() {
    let a = B256::repeat_byte(1);
    let b = B256::repeat_byte(2);
    assert_eq!(completeness([Some(a), None, Some(KECCAK256_EMPTY), Some(b)], |h| h == a), (2, 1));
}

struct TmpDir(std::path::PathBuf);
impl Drop for TmpDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
/// Explicit small MDBX geometry for EVERY fixture DB (pinned reth-db 7134be3 API). The default geometry (8 TB max, 4 GiB
/// growth step) makes each fixture mdbx.dat a 4 GiB sparse file, which the byte-for-byte read-only test reads into memory
/// twice (the 1792 MiB cgroup OOM of the first native v2 run). Fixture-only: the product scan opens the DB as before.
const FIXTURE_MAX_BYTES: usize = 64 << 20;
const FIXTURE_GROWTH_BYTES: usize = 4 << 20;
fn fixture_args() -> DatabaseArguments {
    DatabaseArguments::default().with_geometry_max_size(Some(FIXTURE_MAX_BYTES)).with_growth_step(Some(FIXTURE_GROWTH_BYTES))
}
/// Every fixture mdbx.dat must be non-empty and within the fixture geometry; returns its size.
fn assert_bounded(f: &Path) -> u64 {
    let n = std::fs::metadata(f).expect("mdbx.dat").len();
    assert!(n > 0 && n <= FIXTURE_MAX_BYTES as u64, "fixture {} is {n} bytes: not within the {FIXTURE_MAX_BYTES}-byte fixture geometry", f.display());
    n
}
/// v2 fixture: every DB also carries the 5 stage checkpoints at N_CP unless a test asks otherwise (make_db_with).
fn make_db(name: &str, rows: &[(Vec<u8>, Vec<u8>)], accounts: &[Option<B256>]) -> TmpDir {
    make_db_with(name, rows, accounts, &all_cps())
}
fn make_db_with(name: &str, rows: &[(Vec<u8>, Vec<u8>)], accounts: &[Option<B256>], cps: &[(&str, u64)]) -> TmpDir {
    let d = TmpDir(std::env::temp_dir().join(format!("base-bytecode-check-{}-{name}", std::process::id())));
    let _ = std::fs::remove_dir_all(&d.0);
    let db = reth_db::init_db(d.0.join("db"), fixture_args()).expect("init_db");
    db.update(|tx| {
        for (k, v) in rows {
            tx.put::<RawTable<tables::Bytecodes>>(RawKey::from_vec(k.clone()), RawValue::from_vec(v.clone())).expect("put row");
        }
        for (i, h) in accounts.iter().enumerate() {
            tx.put::<tables::HashedAccounts>(B256::repeat_byte(i as u8 + 1), Account { nonce: 1, balance: U256::ZERO, bytecode_hash: *h }).expect("put account");
        }
        for (id, n) in cps {
            tx.put::<tables::StageCheckpoints>(id.to_string(), Cp::new(*n)).expect("put checkpoint");
        }
    })
    .expect("commit");
    drop(db);
    assert_bounded(&d.0.join("db/mdbx.dat"));
    d
}
fn identity(p: &Path) -> (u64, std::time::SystemTime) {
    let m = std::fs::metadata(p.join("db/mdbx.dat")).expect("mdbx.dat");
    (m.len(), m.modified().expect("mtime"))
}

#[test]
fn mdbx_scan_end_to_end_reports_failures_missing_code_and_is_read_only() {
    let (k1, v1) = client_row(CODE);
    let (k2, mut v2) = client_row(&[0x5b, 0x60]);
    let at = jt_at(&v2);
    v2[at] |= 1 << 1; // forged
    let (k3, v3) = client_row(&DELEGATION);
    let missing = B256::repeat_byte(0xaa);
    let accounts = [Some(B256::from_slice(&k1)), Some(B256::from_slice(&k2)), Some(B256::from_slice(&k3)), Some(missing), Some(KECCAK256_EMPTY), None];
    let d = make_db("bad", &[(k1.clone(), v1.clone()), (k2.clone(), v2), (k3.clone(), v3.clone())], &accounts);
    let before = identity(&d.0);
    let r = scan(&d.0.join("db")).expect("scan");
    assert_eq!(identity(&d.0), before, "the scan must not change mdbx.dat");
    assert_eq!((r.rows, r.tags[2], r.tags[4], r.failures, r.with_code, r.missing), (3, 1, 1, 1, 4, 1));
    assert!(r.first[&alloy_primitives::hex::encode(&k2)].starts_with("E_JUMPBIT"), "{:?}", r.first);
    assert!(r.read_error.is_none() && !r.ok() && r.json()["ok"] == false);
    let good = make_db("good", &[(k1.clone(), v1), (k3.clone(), v3)], &[Some(B256::from_slice(&k1)), Some(B256::from_slice(&k3)), None]);
    let r = scan_datadir(path(&good)).expect("scan");                    // v2: ok needs the datadir binding
    assert!(r.ok(), "{}", r.json());
    assert_eq!((r.rows, r.failures, r.missing, r.with_code), (2, 0, 0, 2));
    let empty = make_db("empty", &[], &[]);
    assert!(!scan(&empty.0.join("db")).expect("scan").ok(), "an empty Bytecodes table is never ok");
}

// ================================ v2 bindings (bytecode-v2-validation) ================================
const N_CP: u64 = 52_866_960;
type Cp = <tables::StageCheckpoints as reth_db_api::table::Table>::Value;
fn all_cps() -> Vec<(&'static str, u64)> {
    STAGES.iter().map(|(_, id)| (*id, N_CP)).collect()
}
fn path(d: &TmpDir) -> &str {
    d.0.to_str().expect("utf-8 temp path")
}
/// The digest the scan must produce, computed independently from the fixture inputs (MDBX key order = sorted keys).
fn expect_rows(rows: &[(Vec<u8>, Vec<u8>)]) -> B256 {
    let mut s = rows.to_vec();
    s.sort();
    let mut d = FramedDigest::new(ROWS_DOMAIN);
    for (k, v) in &s {
        d.item(&[k.as_slice(), v.as_slice()]);
    }
    d.finish()
}
/// make_db keys account i as repeat_byte(i + 1): ascending, i.e. cursor order.
fn expect_refs(accounts: &[Option<B256>]) -> B256 {
    let mut d = FramedDigest::new(REFS_DOMAIN);
    for (i, h) in accounts.iter().enumerate() {
        if let Some(h) = h.filter(|h| *h != KECCAK256_EMPTY) {
            d.item(&[B256::repeat_byte(i as u8 + 1).as_slice(), h.as_slice()]);
        }
    }
    d.finish()
}
fn good_report() -> Report {
    let mut r = Report {
        rows: 2, with_code: 1, txn_id: Some(3), bytecodes_entries: Some(2), hashed_accounts_entries: Some(5), accounts_scanned: 5,
        rows_digest: Some(B256::repeat_byte(1)), code_hashes_digest: Some(B256::repeat_byte(2)), datadir: Some("/d".into()), ..Default::default()
    };
    r.tags[2] = 2;
    for (k, _) in STAGES {
        r.checkpoints.insert(k, Some(7));
    }
    r
}

#[test]
fn framed_digest_is_stable_and_length_and_count_framed() {
    let d = |items: &[Vec<&[u8]>], dom: &[u8]| {
        let mut f = FramedDigest::new(dom);
        for it in items {
            f.item(it);
        }
        f.finish()
    };
    let (ab, c, a, b, bc): (&[u8], &[u8], &[u8], &[u8], &[u8]) = (b"ab", b"c", b"a", b"b", b"bc");
    assert_eq!(d(&[vec![ab, c]], ROWS_DOMAIN), d(&[vec![ab, c]], ROWS_DOMAIN), "deterministic");
    assert_ne!(d(&[vec![ab, c]], ROWS_DOMAIN), d(&[vec![a, bc]], ROWS_DOMAIN), "part lengths are framed");
    assert_ne!(d(&[vec![a, b]], ROWS_DOMAIN), d(&[vec![a], vec![b]], ROWS_DOMAIN), "the item count is framed");
    assert_ne!(d(&[], ROWS_DOMAIN), d(&[], REFS_DOMAIN), "the two digests are domain-separated");
}

#[test]
fn v2_scan_valid_fixture_is_ok_with_exact_counts_digests_and_checkpoints() {
    let (k1, v1) = client_row(CODE);
    let (k3, v3) = client_row(&DELEGATION);
    let rows = vec![(k1.clone(), v1), (k3.clone(), v3)];
    let accounts = [Some(B256::from_slice(&k1)), Some(B256::from_slice(&k3)), None, Some(KECCAK256_EMPTY)];
    let d = make_db("v2good", &rows, &accounts);
    let r = scan_datadir(path(&d)).expect("scan");
    assert!(r.ok(), "{}", r.json());
    assert_eq!((r.rows, r.bytecodes_entries, r.accounts_scanned, r.hashed_accounts_entries, r.with_code, r.missing), (2, Some(2), 4, Some(4), 2, 0));
    assert!(r.txn_id.is_some_and(|t| t > 0));
    assert_eq!(r.rows_digest, Some(expect_rows(&rows)), "every row, framed, in key order");
    assert_eq!(r.code_hashes_digest, Some(expect_refs(&accounts)), "every non-empty code reference, in address order");
    for (k, _) in STAGES {
        assert_eq!(r.checkpoints.get(k).copied().flatten(), Some(N_CP), "{k}");
    }
    assert_eq!(r.datadir.as_deref(), Some(path(&d)));
}

#[test]
fn v2_scan_leaves_every_byte_of_mdbx_dat_unchanged() {
    let (k1, v1) = client_row(CODE);
    let d = make_db("v2bytes", &[(k1.clone(), v1)], &[Some(B256::from_slice(&k1))]);
    let f = d.0.join("db/mdbx.dat");
    let size = assert_bounded(&f);
    let before = std::fs::read(&f).expect("read mdbx.dat");
    assert_eq!(before.len() as u64, size, "the whole fixture mdbx.dat must be read");
    let r = scan_datadir(path(&d)).expect("scan");
    assert!(r.ok(), "{}", r.json());
    let after = std::fs::read(&f).expect("read mdbx.dat");
    assert!(before == after, "the read-only scan changed mdbx.dat (keccak {} -> {}, {} -> {} bytes)", keccak256(&before), keccak256(&after), before.len(), after.len());
}

#[test]
fn missing_code_bad_row_and_empty_accounts_are_not_ok() {
    let (k1, v1) = client_row(CODE);
    let h1 = B256::from_slice(&k1);
    let m = make_db("v2missing", &[(k1.clone(), v1.clone())], &[Some(h1), Some(B256::repeat_byte(0xaa))]);
    let r = scan_datadir(path(&m)).expect("scan");
    assert_eq!((r.missing, r.with_code, r.failures), (1, 2, 0));
    assert!(!r.ok());
    let mut bad_key = k1.clone();
    bad_key[0] ^= 1;
    let b = make_db("v2badrow", &[(k1.clone(), v1.clone()), (bad_key.clone(), v1.clone())], &[Some(h1)]);
    let r = scan_datadir(path(&b)).expect("scan");
    assert_eq!(r.failures, 1);
    assert!(r.first[&alloy_primitives::hex::encode(&bad_key)].starts_with("E_HASH"), "{:?}", r.first);
    assert!(!r.ok());
    let e = make_db("v2noaccounts", &[(k1.clone(), v1.clone())], &[]);
    let r = scan_datadir(path(&e)).expect("scan");
    assert_eq!((r.accounts_scanned, r.hashed_accounts_entries, r.with_code), (0, Some(0), 0));
    assert!(!r.ok(), "rows with no account referencing any code are never ok: {}", r.json());
    let n = make_db("v2nocode", &[(k1.clone(), v1)], &[None, Some(KECCAK256_EMPTY)]);
    let r = scan_datadir(path(&n)).expect("scan");
    assert_eq!((r.accounts_scanned, r.with_code), (2, 0));
    assert!(!r.ok());
}

#[test]
fn missing_or_partial_checkpoints_are_not_ok() {
    let (k1, v1) = client_row(CODE);
    let acc = [Some(B256::from_slice(&k1))];
    let none = make_db_with("v2nocp", &[(k1.clone(), v1.clone())], &acc, &[]);
    let r = scan_datadir(path(&none)).expect("scan");
    assert!(STAGES.iter().all(|(k, _)| r.checkpoints.get(k).copied().flatten().is_none()));
    assert!(r.json()["checkpoints"]["execution"].is_null());
    assert!(!r.ok());
    let four: Vec<_> = all_cps().into_iter().filter(|(id, _)| *id != "MerkleExecute").collect();
    let part = make_db_with("v2partcp", &[(k1.clone(), v1)], &acc, &four);
    let r = scan_datadir(path(&part)).expect("scan");
    assert_eq!(r.checkpoints.get("execution").copied().flatten(), Some(N_CP));
    assert_eq!(r.checkpoints.get("merkle-execute").copied().flatten(), None);
    assert!(!r.ok());
}

#[test]
fn digests_change_with_one_row_one_byte_or_one_reference() {
    let (k1, v1) = client_row(CODE);
    let (k3, v3) = client_row(&DELEGATION);
    let (k4, v4) = client_row(&[0x5b, 0x00]);
    let (h1, h3) = (B256::from_slice(&k1), B256::from_slice(&k3));
    let base_rows = vec![(k1.clone(), v1.clone()), (k3.clone(), v3.clone())];
    let base = scan_datadir(path(&make_db("v2d0", &base_rows, &[Some(h1), Some(h3)]))).expect("scan");
    let mut more = base_rows.clone();
    more.push((k4, v4));
    let extra = scan_datadir(path(&make_db("v2d1", &more, &[Some(h1), Some(h3)]))).expect("scan");
    assert_ne!(base.rows_digest, extra.rows_digest, "one more row");
    assert_eq!(base.code_hashes_digest, extra.code_hashes_digest);
    let mut v1b = v1.clone();
    v1b.push(0); // one more byte in one row
    let byte = scan_datadir(path(&make_db("v2d2", &[(k1.clone(), v1b), (k3.clone(), v3.clone())], &[Some(h1), Some(h3)]))).expect("scan");
    assert_ne!(base.rows_digest, byte.rows_digest, "one byte");
    let swapped = scan_datadir(path(&make_db("v2d3", &base_rows, &[Some(h3), Some(h1)]))).expect("scan");
    assert_eq!(base.rows_digest, swapped.rows_digest);
    assert_eq!((swapped.with_code, swapped.missing), (base.with_code, base.missing), "same counts: only the digest sees the reference change");
    assert_ne!(base.code_hashes_digest, swapped.code_hashes_digest, "two accounts swapped their code");
}

#[test]
fn report_ok_requires_every_v2_binding() {
    assert!(good_report().ok(), "{}", good_report().json());
    let cases: [(&str, fn(&mut Report)); 11] = [
        ("Bytecodes entries != rows", |r| r.bytecodes_entries = Some(3)),
        ("Bytecodes entries unknown", |r| r.bytecodes_entries = None),
        ("HashedAccounts entries != scanned", |r| r.hashed_accounts_entries = Some(6)),
        ("more code accounts than accounts", |r| r.with_code = 6),
        ("no txn id", |r| r.txn_id = None),
        ("txn id 0", |r| r.txn_id = Some(0)),
        ("no rows digest", |r| r.rows_digest = None),
        ("no refs digest", |r| r.code_hashes_digest = None),
        ("no datadir", |r| r.datadir = None),
        ("empty datadir", |r| r.datadir = Some(String::new())),
        ("one checkpoint missing", |r| {
            r.checkpoints.insert("finish", None);
        }),
    ];
    for (why, f) in cases {
        let mut r = good_report();
        f(&mut r);
        assert!(!r.ok(), "{why}");
    }
}

#[test]
fn mutation_between_scans_changes_txn_id_entries_and_digests() {
    let (k1, v1) = client_row(CODE);
    let (k4, v4) = client_row(&[0x5b, 0x00]);
    let d = make_db("v2mut", &[(k1.clone(), v1)], &[Some(B256::from_slice(&k1))]);
    let a = scan_datadir(path(&d)).expect("scan");
    assert!(a.ok(), "{}", a.json());
    {
        let db = reth_db::init_db(d.0.join("db"), fixture_args()).expect("reopen read-write");
        db.update(|tx| {
            tx.put::<RawTable<tables::Bytecodes>>(RawKey::from_vec(k4.clone()), RawValue::from_vec(v4.clone())).expect("put row");
            tx.put::<tables::HashedAccounts>(B256::repeat_byte(0x77), Account { nonce: 1, balance: U256::ZERO, bytecode_hash: Some(B256::from_slice(&k4)) })
                .expect("put account");
        })
        .expect("commit");
    }
    assert_bounded(&d.0.join("db/mdbx.dat"));
    let b = scan_datadir(path(&d)).expect("scan");
    assert!(b.ok(), "{}", b.json());
    assert!(b.txn_id > a.txn_id, "a later committed state is read at a later txn id: {:?} -> {:?}", a.txn_id, b.txn_id);
    assert_eq!((b.rows, b.bytecodes_entries, b.accounts_scanned, b.hashed_accounts_entries), (2, Some(2), 2, Some(2)));
    assert_ne!(a.rows_digest, b.rows_digest);
    assert_ne!(a.code_hashes_digest, b.code_hashes_digest);
}

#[test]
fn read_errors_and_absent_databases_are_never_ok() {
    let mut r = good_report();
    r.read_error = Some("Bytecodes: io".into());
    assert!(!r.ok());
    let absent = std::env::temp_dir().join(format!("base-bytecode-check-{}-absent", std::process::id()));
    let _ = std::fs::remove_dir_all(&absent);
    assert!(scan_datadir(absent.to_str().expect("utf-8")).is_err(), "an absent DB is an error (no receipt), never an ok receipt");
}

#[test]
fn v2_json_has_exactly_the_a2_schema() {
    let j = good_report().json();
    let mut keys: Vec<String> = j.as_object().expect("object").keys().cloned().collect();
    keys.sort();
    let mut want: Vec<String> = [
        "format", "rows", "tag0", "tag2", "tag4", "nonCanonicalPadding", "failures", "paddingShortDupn", "firstFailures", "accountsWithCode",
        "missingCode", "readError", "ok", "bytecodesEntries", "hashedAccountsEntries", "accountsScanned", "rowsDigest", "codeHashesDigest",
        "mdbxTxnId", "checkpoints", "datadir",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    want.sort();
    assert_eq!(keys, want);
    assert_eq!(j["format"], "base-bytecode-check/v2");
    assert_eq!(j["ok"], true);
    let rd = j["rowsDigest"].as_str().expect("hex");
    assert!(rd.len() == 64 && rd.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{rd}");
    let mut cps: Vec<&String> = j["checkpoints"].as_object().expect("object").keys().collect();
    cps.sort();
    assert_eq!(cps, ["bodies", "execution", "finish", "headers", "merkle-execute"]);
}
