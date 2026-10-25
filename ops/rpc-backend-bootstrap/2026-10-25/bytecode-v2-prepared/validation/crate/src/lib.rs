//! base-bytecode-check (library), RECEIPT v2 (finality-stage/bytecode-v2-validation; PREPARED, NOT BUILT, tests NOT RUN).
//! v2 = the tested v1 checker (bytecode-native-validation lib.rs 739c3245..., row/client/padding/completeness rules
//! byte-identical) + bindings read in the SAME read transaction: MDBX transaction id, independent table entry counts
//! (`DbTx::entries`), every HashedAccounts row counted, framed keccak digests of all Bytecodes rows and of all code-hash
//! references, the 5 stage checkpoints, and the datadir. Original v1 header follows.
//!
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

use alloy_primitives::{B256, Bytes, KECCAK256_EMPTY, Keccak256, keccak256};
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

pub const FORMAT: &str = "base-bytecode-check/v2";
/// Digest domains (part of the stable v2 definition; a change is a new receipt version).
pub const ROWS_DOMAIN: &[u8] = b"base-bytecode-check/v2/bytecodes-rows\0";
pub const REFS_DOMAIN: &[u8] = b"base-bytecode-check/v2/code-hash-refs\0";
/// (receipt key, reth StageId string) for the checkpoints read in the scan transaction (reth `tables::StageId = String`).
pub const STAGES: [(&str, &str); 5] =
    [("headers", "Headers"), ("bodies", "Bodies"), ("execution", "Execution"), ("merkle-execute", "MerkleExecute"), ("finish", "Finish")];

/// Streaming framed digest, STABLE DEFINITION (v2):
///   keccak256( domain || item_1 || ... || item_n || u64be(n) ),  item = for each part: u32be(len(part)) || part
/// Rows:  domain ROWS_DOMAIN, one item per Bytecodes row in MDBX cursor (key) order, parts [raw key, raw value].
/// Refs:  domain REFS_DOMAIN, one item per HashedAccounts row whose bytecode_hash is non-empty (not None, not
///        KECCAK256_EMPTY), in cursor (hashed-address) order, parts [hashed address (32 B), bytecode_hash (32 B)].
pub struct FramedDigest {
    h: Keccak256,
    n: u64,
}
impl FramedDigest {
    pub fn new(domain: &[u8]) -> Self {
        let mut h = Keccak256::new();
        h.update(domain);
        Self { h, n: 0 }
    }
    pub fn item(&mut self, parts: &[&[u8]]) {
        for p in parts {
            self.h.update((p.len() as u32).to_be_bytes());
            self.h.update(p);
        }
        self.n += 1;
    }
    pub fn finish(mut self) -> B256 {
        self.h.update(self.n.to_be_bytes());
        self.h.finalize()
    }
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
    // ---- v2: all read in the SAME read transaction as the rows ----
    pub txn_id: Option<u64>,
    pub bytecodes_entries: Option<u64>,
    pub hashed_accounts_entries: Option<u64>,
    pub accounts_scanned: u64,
    pub rows_digest: Option<B256>,
    pub code_hashes_digest: Option<B256>,
    pub checkpoints: std::collections::BTreeMap<&'static str, Option<u64>>,
    pub datadir: Option<String>,
}

impl Report {
    /// ok only if every row and reference verified AND every count equals the table's own entry count in the same
    /// transaction (a walk cannot claim rows it did not see), with all checkpoints, the transaction id and the datadir.
    pub fn ok(&self) -> bool {
        self.failures == 0 && self.missing == 0 && self.read_error.is_none() && self.rows > 0
        && self.with_code > 0
        && self.bytecodes_entries == Some(self.rows)
        && self.hashed_accounts_entries == Some(self.accounts_scanned)
        && self.with_code <= self.accounts_scanned
        && self.txn_id.is_some_and(|t| t > 0)
        && self.rows_digest.is_some() && self.code_hashes_digest.is_some()
        && STAGES.iter().all(|(k, _)| self.checkpoints.get(k).copied().flatten().is_some())
        && self.datadir.as_deref().is_some_and(|d| !d.is_empty())
    }
    pub fn json(&self) -> serde_json::Value {
        let hex = |d: &Option<B256>| d.map(|d| alloy_primitives::hex::encode(d));
        let cps: serde_json::Map<String, serde_json::Value> =
            STAGES.iter().map(|(k, _)| (k.to_string(), serde_json::json!(self.checkpoints.get(k).copied().flatten()))).collect();
        serde_json::json!({
            "format": FORMAT, "rows": self.rows, "tag0": self.tags[0], "tag2": self.tags[2], "tag4": self.tags[4],
            "nonCanonicalPadding": self.non_canonical, "failures": self.failures, "paddingShortDupn": self.padding_short_dupn,
            "firstFailures": self.first, "accountsWithCode": self.with_code, "missingCode": self.missing,
            "readError": self.read_error, "ok": self.ok(),
            "bytecodesEntries": self.bytecodes_entries, "hashedAccountsEntries": self.hashed_accounts_entries,
            "accountsScanned": self.accounts_scanned, "rowsDigest": hex(&self.rows_digest), "codeHashesDigest": hex(&self.code_hashes_digest),
            "mdbxTxnId": self.txn_id, "checkpoints": cps, "datadir": self.datadir,
        })
    }
}

/// Read-only scan of `<datadir>/db` (MDBX) in ONE read transaction. Any cursor/read error is a failure, never a skipped row.
pub fn scan(db_path: &Path) -> Result<Report, Box<dyn std::error::Error>> {
    let db: DatabaseEnv = open_db_read_only(db_path, DatabaseArguments::default().with_max_read_transaction_duration(Some(reth_db::mdbx::MaxReadTransactionDuration::Unbounded)))?;
    let tx = db.tx()?;
    let mut r = Report::default();
    fn err(r: &mut Report, e: String) {
        if r.read_error.is_none() {
            r.read_error = Some(e);
        }
    }
    match tx.id() {
        Ok(id) => r.txn_id = Some(id),
        Err(e) => err(&mut r, format!("txn id: {e}")),
    }
    match tx.entries::<RawTable<tables::Bytecodes>>() {
        Ok(n) => r.bytecodes_entries = Some(n as u64),
        Err(e) => err(&mut r, format!("Bytecodes entries: {e}")),
    }
    match tx.entries::<tables::HashedAccounts>() {
        Ok(n) => r.hashed_accounts_entries = Some(n as u64),
        Err(e) => err(&mut r, format!("HashedAccounts entries: {e}")),
    }
    let mut rows_digest = FramedDigest::new(ROWS_DOMAIN);
    let mut cur = tx.cursor_read::<RawTable<tables::Bytecodes>>()?;
    for row in cur.walk(None)? {
        let (k, v) = match row {
            Ok(kv) => kv,
            Err(e) => {
                err(&mut r, format!("Bytecodes: {e}"));
                break;
            }
        };
        r.rows += 1;
        rows_digest.item(&[k.raw_key().as_slice(), v.raw_value()]);
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
    r.rows_digest = Some(rows_digest.finish());
    let mut refs = FramedDigest::new(REFS_DOMAIN);
    let mut scanned = 0u64;
    let mut acc = tx.cursor_read::<tables::HashedAccounts>()?;
    let mut acc_error = None;
    let (with_code, missing) = {
        let walker = acc.walk(None)?;
        let it = walker.map_while(|row| match row {
            Ok((addr, a)) => {
                scanned += 1;
                if let Some(h) = a.bytecode_hash.filter(|h| *h != KECCAK256_EMPTY) {
                    refs.item(&[addr.as_slice(), h.as_slice()]);
                }
                Some(a.bytecode_hash)
            }
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
        if let Some(e) = lookup_error {
            err(&mut r, e);
        }
        counts
    };
    if let Some(e) = acc_error {
        err(&mut r, e);
    }
    r.with_code = with_code;
    r.missing = missing;
    r.accounts_scanned = scanned;
    r.code_hashes_digest = Some(refs.finish());
    for (key, id) in STAGES {
        match tx.get::<tables::StageCheckpoints>(id.to_string()) {
            Ok(cp) => {
                r.checkpoints.insert(key, cp.map(|c| c.block_number));
            }
            Err(e) => {
                r.checkpoints.insert(key, None);
                err(&mut r, format!("StageCheckpoints {id}: {e}"));
            }
        }
    }
    Ok(r)
}

/// The CLI entry: scan `<datadir>/db` and bind the receipt to `datadir` exactly as given.
pub fn scan_datadir(datadir: &str) -> Result<Report, Box<dyn std::error::Error>> {
    let mut r = scan(&Path::new(datadir).join("db"))?;
    r.datadir = Some(datadir.to_string());
    Ok(r)
}

#[cfg(test)]
mod tests;
