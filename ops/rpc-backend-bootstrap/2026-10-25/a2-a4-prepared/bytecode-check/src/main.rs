//! base-bytecode-check: READ-ONLY verification of every row of the reth MDBX `Bytecodes` table (Base v2 datadir at the
//! authenticated block N, node + consensus + downloader STOPPED). SOURCE ONLY: NOT BUILT, NOT RUN, tests NOT RUN. The A2-A4
//! harness keeps gap G-a OPEN until this is built, its tests pass and a live run passed under root review.
//!
//! Pinned semantics (reth-primitives-traits 0.6.0 src/account.rs:180-224, revm-bytecode 42.0.0):
//!   tag 0 (raw)   decode = `new_raw(bytes)` (re-analysed; `ef01..` -> EIP-7702 or PANIC if malformed); trailing bytes ignored
//!   tag 2         decode = `new_analyzed(bytes, original_len, JumpTable::from_slice(rest, bit_len))`, STORED metadata trusted;
//!                 bit_len = L if rest.len()*8 >= L else original_len; from_slice PANICS if rest.len()*8 < bit_len
//!   tag 4 (7702)  decode = `new_raw(bytes)`; trailing bytes ignored
//!   tag 1 / other `unreachable!` (panic)
//! Checker rules (fail-closed; a row the client would decode differently from canonical code is a FAILURE):
//!   all:   key 32 bytes; L <= MAX_CODE_LEN (oversized rows refused before any slice); declared length present
//!   tag 0: no trailing bytes; `new_raw_checked` Ok (the canonical constructor, so legitimate raw 7702 is accepted the way the
//!          client decodes it); keccak(B) == key
//!   tag 4: no trailing bytes; `new_raw_checked` Ok AND `is_eip7702()`; L == 23; keccak(B) == key
//!   tag 2: L > 0; 8-byte original_len O <= L; keccak(B[..O]) == key; B[O..] all zero; B[..O] must NOT be 7702 bytes (the
//!          client would run it as legacy); rest.len()*8 >= decoded bit_len (else the client panics); fresh revm analysis
//!          `new_legacy(B[..O])`: its padded length <= L; every decoded bit i < bit_len equals fresh.is_valid(i) for i < O and
//!          is 0 for i >= O (bits past bit_len are never read); `canonical` = (L == fresh padded len && rest == fresh table bytes)
//!   completeness: every non-empty HashedAccounts.bytecode_hash has a row (a missing row silently becomes EMPTY code)
use std::path::PathBuf;

use alloy_primitives::{B256, Bytes, KECCAK256_EMPTY, keccak256};
use reth_db::{DatabaseEnv, mdbx::DatabaseArguments, open_db_read_only};
use reth_db_api::{
    cursor::DbCursorRO,
    database::Database,
    table::{RawKey, RawTable},
    tables,
    transaction::DbTx,
};
use revm_bytecode::Bytecode as Revm;

/// EIP-170 runtime code limit is 24,576 bytes; analysed padding adds at most 33. Anything far larger is malformed.
pub const MAX_CODE_LEN: usize = 64 * 1024;
const MAX_REPORTED_FAILURES: usize = 100;

#[derive(Debug, PartialEq, Eq)]
pub struct RowOk {
    pub tag: u8,
    pub canonical: bool,
}

pub fn check_row(key: &[u8], v: &[u8]) -> Result<RowOk, String> {
    if key.len() != 32 {
        return Err("key is not 32 bytes".into());
    }
    if v.len() < 5 {
        return Err("row shorter than u32 length + tag".into());
    }
    let l = u32::from_be_bytes([v[0], v[1], v[2], v[3]]) as usize;
    if l > MAX_CODE_LEN {
        return Err(format!("declared length {l} exceeds {MAX_CODE_LEN}"));
    }
    if v.len() < 4 + l + 1 {
        return Err("row shorter than its declared length".into());
    }
    let b = &v[4..4 + l];
    let tag = v[4 + l];
    let rest = &v[5 + l..];
    let key = B256::from_slice(key);
    match tag {
        0 | 4 => {
            if !rest.is_empty() {
                return Err(format!("tag {tag}: trailing bytes after the tag"));
            }
            let code = Revm::new_raw_checked(Bytes::copy_from_slice(b)).map_err(|e| format!("tag {tag}: not decodable: {e:?}"))?;
            if tag == 4 && (!code.is_eip7702() || l != 23) {
                return Err("tag 4: not a canonical EIP-7702 delegation".into());
            }
            if keccak256(b) != key {
                return Err(format!("tag {tag}: keccak(code) != key"));
            }
            Ok(RowOk { tag, canonical: tag == 4 })
        }
        2 => {
            if rest.len() < 8 {
                return Err("tag 2: no original_len".into());
            }
            let o = u64::from_be_bytes(rest[..8].try_into().expect("8 bytes")) as usize;
            let j = &rest[8..];
            if l == 0 || o > l {
                return Err("tag 2: original_len out of range".into());
            }
            if keccak256(&b[..o]) != key {
                return Err("tag 2: keccak(original bytes) != key".into());
            }
            if b[o..].iter().any(|x| *x != 0) {
                return Err("tag 2: non-zero padding (executed)".into());
            }
            if Revm::new_raw_checked(Bytes::copy_from_slice(&b[..o])).map(|c| c.is_eip7702()).unwrap_or(false) {
                return Err("tag 2: EIP-7702 bytes stored as legacy (delegation lost)".into());
            }
            let bit_len = if j.len() * 8 >= l { l } else { o };
            if j.len() * 8 < bit_len {
                return Err("tag 2: jump table shorter than its decoded bit length (client panics)".into());
            }
            let fresh = Revm::new_legacy(Bytes::copy_from_slice(&b[..o]));
            let fresh_padded = fresh.bytes_slice().len();
            if fresh_padded > l {
                return Err("tag 2: stored padding shorter than revm requires".into());
            }
            let jt = fresh.legacy_jump_table().ok_or("tag 2: revm produced no jump table")?;
            for i in 0..bit_len {
                let stored = j[i >> 3] & (1 << (i & 7)) != 0;
                let want = i < o && jt.is_valid(i);
                if stored != want {
                    return Err(format!("tag 2: jump table bit {i} is {stored}, fresh analysis says {want}"));
                }
            }
            Ok(RowOk { tag, canonical: fresh_padded == l && j == jt.as_slice() })
        }
        t => Err(format!("unsupported tag {t} (the client panics on it)")),
    }
}

/// Completeness over an iterator of account code hashes, with `has_row` answering presence. -> (accounts with code, missing)
pub fn completeness<I: IntoIterator<Item = Option<B256>>>(hashes: I, mut has_row: impl FnMut(B256) -> bool) -> (u64, u64) {
    let (mut with_code, mut missing) = (0, 0);
    for h in hashes.into_iter().flatten().filter(|h| *h != KECCAK256_EMPTY) {
        with_code += 1;
        if !has_row(h) {
            missing += 1;
        }
    }
    (with_code, missing)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let datadir = PathBuf::from(std::env::args().nth(1).ok_or("usage: base-bytecode-check <datadir>")?);
    let db: DatabaseEnv = open_db_read_only(
        &datadir.join("db"),
        DatabaseArguments::default().with_max_read_transaction_duration(Some(reth_db::mdbx::MaxReadTransactionDuration::Unbounded)),
    )?;
    let tx = db.tx()?;
    let (mut rows, mut tags, mut non_canonical, mut failures) = (0u64, [0u64; 5], 0u64, 0u64);
    let mut first = std::collections::BTreeMap::new();
    let mut cur = tx.cursor_read::<RawTable<tables::Bytecodes>>()?;
    for row in cur.walk(None)? {
        let (k, v) = row?;
        rows += 1;
        match check_row(k.raw_key(), v.raw_value()) {
            Ok(r) => {
                tags[r.tag as usize] += 1;
                if !r.canonical && r.tag == 2 {
                    non_canonical += 1;
                }
            }
            Err(e) => {
                failures += 1;
                if first.len() < MAX_REPORTED_FAILURES {
                    first.insert(alloy_primitives::hex::encode(k.raw_key()), e);
                }
            }
        }
    }
    let mut acc = tx.cursor_read::<tables::HashedAccounts>()?;
    let mut lookup_error = None;
    let (with_code, missing) = {
        let walker = acc.walk(None)?;
        let it = walker.map_while(|r| match r {
            Ok((_, a)) => Some(a.bytecode_hash),
            Err(e) => {
                lookup_error = Some(e.to_string());
                None
            }
        });
        completeness(it, |h| {
            matches!(tx.get::<RawTable<tables::Bytecodes>>(RawKey::from(h)), Ok(Some(_)))
        })
    };
    let ok = failures == 0 && missing == 0 && lookup_error.is_none() && rows > 0;
    println!("{}", serde_json::json!({
        "format": "base-bytecode-check/v1", "rows": rows, "tag0": tags[0], "tag2": tags[2], "tag4": tags[4],
        "nonCanonicalPadding": non_canonical, "failures": failures, "firstFailures": first,
        "accountsWithCode": with_code, "missingCode": missing, "readError": lookup_error, "ok": ok,
    }));
    std::process::exit(if ok { 0 } else { 1 });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A canonical tag-2 row exactly as the client writes it: u32 padded len | padded | 2 | u64 O | jump table bytes.
    fn analyzed_row(code: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let fresh = Revm::new_legacy(Bytes::copy_from_slice(code));
        let padded = fresh.bytes_slice();
        let mut v = (padded.len() as u32).to_be_bytes().to_vec();
        v.extend_from_slice(padded);
        v.push(2);
        v.extend_from_slice(&(code.len() as u64).to_be_bytes());
        v.extend_from_slice(fresh.legacy_jump_table().unwrap().as_slice());
        (keccak256(code).to_vec(), v)
    }
    fn raw_row(tag: u8, b: &[u8]) -> Vec<u8> {
        let mut v = (b.len() as u32).to_be_bytes().to_vec();
        v.extend_from_slice(b);
        v.push(tag);
        v
    }
    // PUSH1 0x04 JUMP INVALID JUMPDEST STOP: offset 4 is the only valid jump target
    const CODE: &[u8] = &[0x60, 0x04, 0x56, 0xfe, 0x5b, 0x00];
    const DELEGATION: [u8; 23] = [0xef, 0x01, 0x00, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

    #[test]
    fn canonical_analyzed_row_passes() {
        let (k, v) = analyzed_row(CODE);
        assert_eq!(check_row(&k, &v), Ok(RowOk { tag: 2, canonical: true }));
    }

    #[test]
    fn hash_padding_and_length_forgeries_fail() {
        let (k, v) = analyzed_row(CODE);
        let mut bad_key = k.clone();
        bad_key[0] ^= 1;
        assert!(check_row(&bad_key, &v).unwrap_err().contains("keccak"));
        let mut pad = v.clone();
        pad[4 + CODE.len()] = 0x5b; // a JUMPDEST in the padding
        assert!(check_row(&k, &pad).unwrap_err().contains("padding"));
        let mut olen = v.clone();
        let tag_at = 4 + u32::from_be_bytes([v[0], v[1], v[2], v[3]]) as usize;
        olen[tag_at + 8] = (CODE.len() - 1) as u8; // shorter original_len: the hash no longer covers the code
        assert!(check_row(&k, &olen).is_err());
        assert!(check_row(&k[..31], &v).unwrap_err().contains("32 bytes"));
        assert!(check_row(&k, &v[..6]).unwrap_err().contains("declared length"));
        let mut huge = v.clone();
        huge[..4].copy_from_slice(&((MAX_CODE_LEN as u32) + 1).to_be_bytes());
        assert!(check_row(&k, &huge).unwrap_err().contains("exceeds"));
    }

    #[test]
    fn jump_metadata_forgeries_fail_even_with_a_matching_hash() {
        let (k, v) = analyzed_row(CODE);
        let n = v.len();
        let mut add = v.clone();
        add[n - 1] |= 1 << 1; // mark PUSH1's immediate (offset 1) as a JUMPDEST
        assert!(check_row(&k, &add).unwrap_err().contains("jump table bit 1"));
        let mut del = v.clone();
        del[n - 1] &= !(1 << 4); // remove the real JUMPDEST at offset 4
        assert!(check_row(&k, &del).unwrap_err().contains("jump table bit 4"));
        let short = &v[..n - 1]; // jump table missing: the client would panic in from_slice
        assert!(check_row(&k, short).unwrap_err().contains("shorter than its decoded bit length"));
        let mut extra = v.clone();
        extra.push(0x00); // a longer, all-zero table: same execution, recorded non-canonical
        assert_eq!(check_row(&k, &extra), Ok(RowOk { tag: 2, canonical: false }));
        let mut past = v.clone();
        past.push(0x01); // a bit past the decoded bit_len (L = 6): never read by the client -> non-canonical, not unsafe
        assert_eq!(check_row(&k, &past), Ok(RowOk { tag: 2, canonical: false }));
        // JUMPDEST PUSH1<missing>: padded L > O, so bits in [O, L) ARE read; a set bit there must fail
        let code2: &[u8] = &[0x5b, 0x60];
        let (k2, v2) = analyzed_row(code2);
        assert_eq!(check_row(&k2, &v2).map(|r| r.tag), Ok(2));
        let l2 = u32::from_be_bytes([v2[0], v2[1], v2[2], v2[3]]) as usize;
        assert!(l2 > code2.len(), "fixture must have padding");
        let mut forged = v2.clone();
        let jt_at = 4 + l2 + 1 + 8;
        forged[jt_at] |= 1 << code2.len(); // bit O (first padding byte) marked valid
        assert!(check_row(&k2, &forged).unwrap_err().contains(&format!("jump table bit {}", code2.len())));
    }

    #[test]
    fn delegation_rows_follow_the_canonical_constructor() {
        let k = keccak256(DELEGATION).to_vec();
        assert_eq!(check_row(&k, &raw_row(4, &DELEGATION)), Ok(RowOk { tag: 4, canonical: true }));
        assert_eq!(check_row(&k, &raw_row(0, &DELEGATION)).map(|r| r.tag), Ok(0), "raw 7702 decodes as 7702 via new_raw");
        let mut trailing = raw_row(4, &DELEGATION);
        trailing.push(0);
        assert!(check_row(&k, &trailing).unwrap_err().contains("trailing"));
        let mut bad = DELEGATION;
        bad[2] = 0x01; // wrong 7702 version
        assert!(check_row(&keccak256(bad).to_vec(), &raw_row(4, &bad)).is_err());
        assert!(check_row(&keccak256(CODE).to_vec(), &raw_row(4, CODE)).unwrap_err().contains("7702"));
        // 7702 bytes stored as tag 2 legacy: the delegation would be lost
        let mut legacy = (23u32).to_be_bytes().to_vec();
        legacy.extend_from_slice(&DELEGATION);
        legacy.push(2);
        legacy.extend_from_slice(&23u64.to_be_bytes());
        legacy.extend_from_slice(&[0u8; 3]);
        assert!(check_row(&k, &legacy).unwrap_err().contains("delegation lost"));
    }

    #[test]
    fn raw_rows_unknown_tags_and_trailing_bytes() {
        let k = keccak256(CODE).to_vec();
        assert_eq!(check_row(&k, &raw_row(0, CODE)), Ok(RowOk { tag: 0, canonical: false }));
        let mut t = raw_row(0, CODE);
        t.push(9);
        assert!(check_row(&k, &t).unwrap_err().contains("trailing"));
        assert!(check_row(&k, &raw_row(1, CODE)).unwrap_err().contains("unsupported tag 1"));
        assert!(check_row(&k, &raw_row(7, CODE)).unwrap_err().contains("unsupported tag 7"));
    }

    #[test]
    fn completeness_counts_missing_code_and_ignores_empty() {
        let a = B256::repeat_byte(1);
        let b = B256::repeat_byte(2);
        let (with, missing) = completeness([Some(a), None, Some(KECCAK256_EMPTY), Some(b)], |h| h == a);
        assert_eq!((with, missing), (2, 1));
    }
}
