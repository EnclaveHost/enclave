//! base-bytecode-check (library): READ-ONLY verification of every row of the reth MDBX `Bytecodes` table of a Base v2
//! datadir at the authenticated block N (node + consensus + downloader STOPPED). PREPARED, NOT BUILT, tests NOT RUN.
//! Derived from `finality-stage/a2-a4-execution/bytecode-check/src/main.rs` (frozen; not edited) with the audited fixes in
//! ../README.md (import path, explicit features, pinned-client cross-check, DUPN padding class, MDBX scan as a library fn).
//!
//! Pinned semantics (reth-primitives-traits 0.6.0 src/account.rs `from_compact`, revm-bytecode 42.0.0):
//!   tag 0 (raw)   `new_raw(bytes)` (re-analysed; `ef01..` -> EIP-7702 or PANIC if malformed); trailing bytes ignored
//!   tag 2         `unsafe new_analyzed(bytes, O, JumpTable::from_slice(rest, bit_len))`, STORED metadata trusted;
//!                 bit_len = L if rest.len()*8 >= L else O; from_slice PANICS if rest.len()*8 < bit_len; padding NOT checked
//!   tag 4 (7702)  `new_raw(bytes)`; trailing bytes ignored
//!   tag 1 / other `unreachable!` (panic)
//! Checker rules (fail-closed; a row the client would decode differently from canonical code is a FAILURE):
//!   all:   key 32 bytes; L <= MAX_CODE_LEN (before any slice); declared length present
//!   tag 0: no trailing bytes; `new_raw_checked` Ok; keccak(B) == key
//!   tag 4: no trailing bytes; `new_raw_checked` Ok AND `is_eip7702()`; L == 23; keccak(B) == key
//!   tag 2: L > 0; u64 O <= L; keccak(B[..O]) == key; B[O..] all zero; B[..O] not 7702 bytes; rest.len()*8 >= bit_len;
//!          fresh `new_legacy(B[..O])` padded length <= L (else E_PADDING_SHORT, with a DUPN/SWAPN/EXCHANGE sub-class because
//!          revm 42 pads those endings one byte more than older writers); every bit i < bit_len equals fresh.is_valid(i)
//!          for i < O and 0 for i >= O; canonical = (L == fresh padded len && rest == fresh table bytes)
//!   client: an accepted row is ALSO decoded by the pinned client decoder and must execute identically to canonical code
//!   completeness: every non-empty HashedAccounts.bytecode_hash has a row (a missing row silently becomes EMPTY code)
use std::path::Path;

use alloy_primitives::{B256, Bytes, KECCAK256_EMPTY, keccak256};
use reth_db::{DatabaseEnv, mdbx::DatabaseArguments, open_db_read_only};
use reth_db_api::{
    cursor::DbCursorRO,
    database::Database,
    tables::{self, RawKey, RawTable, RawValue},
    transaction::DbTx,
};
use reth_primitives_traits::Bytecode as ClientBytecode;
use revm_bytecode::Bytecode as Revm;

/// EIP-170 runtime code limit is 24,576 bytes; analysed padding adds at most 34. Anything far larger is malformed.
pub const MAX_CODE_LEN: usize = 64 * 1024;
pub const MAX_REPORTED_FAILURES: usize = 100;
/// DUPN, SWAPN, EXCHANGE (revm-bytecode 42.0.0 `is_dupn_swapn_exchange`: `op.wrapping_sub(DUPN) < 3`, DUPN = 0xe6).
const DUPN: u8 = 0xe6;

#[derive(Debug, PartialEq, Eq)]
pub struct RowOk {
    pub tag: u8,
    pub canonical: bool,
}

fn dupn_family(op: u8) -> bool {
    op.wrapping_sub(DUPN) < 3
}

pub fn check_row(key: &[u8], v: &[u8]) -> Result<RowOk, String> {
    if key.len() != 32 {
        return Err("E_KEY: key is not 32 bytes".into());
    }
    if v.len() < 5 {
        return Err("E_SHORT: row shorter than u32 length + tag".into());
    }
    let l = u32::from_be_bytes([v[0], v[1], v[2], v[3]]) as usize;
    if l > MAX_CODE_LEN {
        return Err(format!("E_OVERSIZE: declared length {l} exceeds {MAX_CODE_LEN}"));
    }
    if v.len() < 4 + l + 1 {
        return Err("E_SHORT: row shorter than its declared length".into());
    }
    let b = &v[4..4 + l];
    let tag = v[4 + l];
    let rest = &v[5 + l..];
    let key = B256::from_slice(key);
    match tag {
        0 | 4 => {
            if !rest.is_empty() {
                return Err(format!("E_TRAILING: tag {tag}: trailing bytes after the tag"));
            }
            let code = Revm::new_raw_checked(Bytes::copy_from_slice(b)).map_err(|e| format!("E_DECODE: tag {tag}: not decodable: {e:?}"))?;
            if tag == 4 && (!code.is_eip7702() || l != 23) {
                return Err("E_7702: tag 4: not a canonical EIP-7702 delegation".into());
            }
            if keccak256(b) != key {
                return Err(format!("E_HASH: tag {tag}: keccak(code) != key"));
            }
            Ok(RowOk { tag, canonical: tag == 4 })
        }
        2 => {
            if rest.len() < 8 {
                return Err("E_OLEN: tag 2: no original_len".into());
            }
            let o = u64::from_be_bytes(rest[..8].try_into().expect("8 bytes")) as usize;
            let j = &rest[8..];
            if l == 0 || o > l {
                return Err("E_OLEN: tag 2: original_len out of range".into());
            }
            if keccak256(&b[..o]) != key {
                return Err("E_HASH: tag 2: keccak(original bytes) != key".into());
            }
            if b[o..].iter().any(|x| *x != 0) {
                return Err("E_PADDING_NONZERO: tag 2: non-zero padding (executed)".into());
            }
            if Revm::new_raw_checked(Bytes::copy_from_slice(&b[..o])).map(|c| c.is_eip7702()).unwrap_or(false) {
                return Err("E_7702_AS_LEGACY: tag 2: EIP-7702 bytes stored as legacy (delegation lost)".into());
            }
            let bit_len = if j.len() * 8 >= l { l } else { o };
            if j.len() * 8 < bit_len {
                return Err("E_JUMPTABLE_SHORT: tag 2: jump table shorter than its decoded bit length (client panics)".into());
            }
            let fresh = Revm::new_legacy(Bytes::copy_from_slice(&b[..o]));
            let fresh_padded = fresh.bytes_slice().len();
            if fresh_padded > l {
                let ends_dupn = o > 0 && (dupn_family(b[o - 1]) || (b[o - 1] == 0 && o > 1 && dupn_family(b[o - 2])));
                return Err(if ends_dupn && fresh_padded == l + 1 {
                    "E_PADDING_SHORT_DUPN: tag 2: one byte less padding than revm 42, last bytes look like a DUPN/SWAPN/EXCHANGE ending (heuristic: may be PUSH data; older writer?) - still a FAILURE, root review".into()
                } else {
                    "E_PADDING_SHORT: tag 2: stored padding shorter than revm requires".into()
                });
            }
            let jt = fresh.legacy_jump_table().ok_or("E_INTERNAL: tag 2: revm produced no jump table")?;
            for i in 0..bit_len {
                let stored = j[i >> 3] & (1 << (i & 7)) != 0;
                let want = i < o && jt.is_valid(i);
                if stored != want {
                    return Err(format!("E_JUMPBIT: tag 2: jump table bit {i} is {stored}, fresh analysis says {want}"));
                }
            }
            Ok(RowOk { tag, canonical: fresh_padded == l && j == jt.as_slice() })
        }
        t => Err(format!("E_TAG: unsupported tag {t} (the client panics on it)")),
    }
}

/// Decode with the PINNED client decoder (reth-primitives-traits 0.6.0 `Bytecode::from_compact` via the table codec).
/// Only called on rows `check_row` accepted, whose checks precede every known panic condition; a panic here means the
/// model is wrong and (release profile, panic=unwind, not caught) ends the process without a receipt: fail-closed.
pub fn client_decode(v: &[u8]) -> Result<ClientBytecode, String> {
    RawValue::<ClientBytecode>::from_vec(v.to_vec()).value().map_err(|e| format!("E_CLIENT: client decode error: {e}"))
}

/// The client-decoded row must execute exactly like canonical code: same kind, same original bytes (hash == key), the
/// executed byte array is the original followed only by zero padding of at least revm's length, and every pc has the
/// same JUMPDEST validity as a fresh analysis.
pub fn agrees_with_client(key: &[u8], v: &[u8]) -> Result<(), String> {
    let c = client_decode(v)?;
    let orig = c.original_byte_slice();
    if keccak256(orig).as_slice() != key {
        return Err("E_CLIENT: client original bytes do not hash to the key".into());
    }
    let fresh = Revm::new_raw_checked(Bytes::copy_from_slice(orig)).map_err(|e| format!("E_CLIENT: {e:?}"))?;
    if c.kind() != fresh.kind() {
        return Err(format!("E_CLIENT: client kind {:?} != canonical {:?}", c.kind(), fresh.kind()));
    }
    let (cb, fb) = (c.bytes_slice(), fresh.bytes_slice());
    if cb.len() < fb.len() || cb[..orig.len()] != *orig || cb[orig.len()..].iter().any(|x| *x != 0) {
        return Err("E_CLIENT: client executed bytes differ from canonical code + zero padding".into());
    }
    if let (Some(cj), Some(fj)) = (c.legacy_jump_table(), fresh.legacy_jump_table()) {
        for pc in 0..cb.len().max(fb.len()) + 8 {
            if cj.is_valid(pc) != fj.is_valid(pc) {
                return Err(format!("E_CLIENT: JUMPDEST validity at pc {pc} differs (client {})", cj.is_valid(pc)));
            }
        }
    } else if c.legacy_jump_table().is_some() != fresh.legacy_jump_table().is_some() {
        return Err("E_CLIENT: jump table presence differs".into());
    }
    Ok(())
}

/// One row: the structural check, then the pinned-client equivalence check.
pub fn verify_row(key: &[u8], v: &[u8]) -> Result<RowOk, String> {
    let r = check_row(key, v)?;
    agrees_with_client(key, v)?;
    Ok(r)
}

/// Completeness over account code hashes, with `has_row` answering presence. -> (accounts with code, missing)
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

#[derive(Debug, Default)]
pub struct Report {
    pub rows: u64,
    pub tags: [u64; 5],
    pub non_canonical: u64,
    pub failures: u64,
    pub padding_short_dupn: u64,
    pub first: std::collections::BTreeMap<String, String>,
    pub with_code: u64,
    pub missing: u64,
    pub read_error: Option<String>,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.failures == 0 && self.missing == 0 && self.read_error.is_none() && self.rows > 0
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "format": "base-bytecode-check/v1", "rows": self.rows, "tag0": self.tags[0], "tag2": self.tags[2], "tag4": self.tags[4],
            "nonCanonicalPadding": self.non_canonical, "failures": self.failures, "paddingShortDupn": self.padding_short_dupn,
            "firstFailures": self.first, "accountsWithCode": self.with_code, "missingCode": self.missing,
            "readError": self.read_error, "ok": self.ok(),
        })
    }
}

/// Read-only scan of `<datadir>/db` (MDBX). Any cursor/read error is a failure, never a skipped row.
pub fn scan(db_path: &Path) -> Result<Report, Box<dyn std::error::Error>> {
    let db: DatabaseEnv = open_db_read_only(db_path, DatabaseArguments::default().with_max_read_transaction_duration(Some(reth_db::mdbx::MaxReadTransactionDuration::Unbounded)))?;
    let tx = db.tx()?;
    let mut r = Report::default();
    let mut cur = tx.cursor_read::<RawTable<tables::Bytecodes>>()?;
    for row in cur.walk(None)? {
        let (k, v) = match row {
            Ok(kv) => kv,
            Err(e) => {
                r.read_error = Some(format!("Bytecodes: {e}"));
                break;
            }
        };
        r.rows += 1;
        match verify_row(k.raw_key(), v.raw_value()) {
            Ok(ok) => {
                r.tags[ok.tag as usize] += 1;
                if !ok.canonical && ok.tag == 2 {
                    r.non_canonical += 1;
                }
            }
            Err(e) => {
                r.failures += 1;
                if e.starts_with("E_PADDING_SHORT_DUPN") {
                    r.padding_short_dupn += 1;
                }
                if r.first.len() < MAX_REPORTED_FAILURES {
                    r.first.insert(alloy_primitives::hex::encode(k.raw_key()), e);
                }
            }
        }
    }
    let mut acc = tx.cursor_read::<tables::HashedAccounts>()?;
    let mut acc_error = None;
    let (with_code, missing) = {
        let walker = acc.walk(None)?;
        let it = walker.map_while(|row| match row {
            Ok((_, a)) => Some(a.bytecode_hash),
            Err(e) => {
                acc_error = Some(format!("HashedAccounts: {e}"));
                None
            }
        });
        let mut lookup_error = None;
        let counts = completeness(it, |h| match tx.get::<RawTable<tables::Bytecodes>>(RawKey::from(h)) {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(e) => {
                lookup_error.get_or_insert(format!("Bytecodes lookup: {e}"));
                false
            }
        });
        if r.read_error.is_none() {
            r.read_error = lookup_error;
        }
        counts
    };
    if r.read_error.is_none() {
        r.read_error = acc_error;
    }
    r.with_code = with_code;
    r.missing = missing;
    Ok(r)
}

#[cfg(test)]
mod tests;
