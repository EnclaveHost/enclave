//! PATCH (sia-s3 writer fencing, work/storage-fencing-implementation-interface.txt v3): the client side of an
//! indexer's per-account writer fence.
//!
//! A fence token is `gen (u64 BE) || counter (u64 BE) || iid (16 bytes)`, ordered bytewise. The indexer installs a
//! token only if it is strictly greater than the installed one, and then issues a random receipt. Every fenced
//! mutation carries the credential `token || receipt` in the signed query parameter `sf`, and the indexer applies it
//! only if both equal what is installed now. A client that holds no credential sends no `sf`.

use std::fmt;
use std::sync::{Arc, Mutex};

/// Query parameter carrying the credential on fenced mutations.
pub(crate) const QUERY_PARAM_FENCE: &str = "sf";
/// Domain tag that starts the fenced request hash stream (indexd-fence R5 "indexd/fence/v3"; only when `sf` is present).
pub(crate) const FENCE_HASH_DOMAIN: &[u8] = b"indexd/fence/v3";

/// A writer's fence token: gen, counter, instance id.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct FenceToken(pub [u8; 32]);

impl FenceToken {
    /// Builds a token. `gen` and `counter` must be below 2^63 (the indexer refuses a set top bit).
    pub fn new(generation: u64, counter: u64, iid: [u8; 16]) -> Result<Self, String> {
        if generation >> 63 != 0 || counter >> 63 != 0 {
            return Err("fence generation and counter must be below 2^63".into());
        }
        let mut b = [0u8; 32];
        b[..8].copy_from_slice(&generation.to_be_bytes());
        b[8..16].copy_from_slice(&counter.to_be_bytes());
        b[16..].copy_from_slice(&iid);
        Ok(FenceToken(b))
    }
    pub fn generation(&self) -> u64 {
        u64::from_be_bytes(self.0[..8].try_into().unwrap())
    }
    pub fn counter(&self) -> u64 {
        u64::from_be_bytes(self.0[8..16].try_into().unwrap())
    }
    pub fn iid(&self) -> [u8; 16] {
        self.0[16..].try_into().unwrap()
    }
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }
    /// Strict parse: exactly 64 lowercase hex characters, top bits clear.
    pub fn parse_hex(s: &str) -> Result<Self, String> {
        let b = strict_hex::<32>(s)?;
        let t = FenceToken(b);
        if t.generation() >> 63 != 0 || t.counter() >> 63 != 0 {
            return Err("fence token has a top bit set".into());
        }
        Ok(t)
    }
}

impl fmt::Debug for FenceToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "FenceToken(gen {}, counter {}, iid {})", self.generation(), self.counter(), hex::encode(&self.0[16..20]))
    }
}

/// The receipt an indexer issued when it installed a token (never chosen by the client).
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct FenceReceipt(pub [u8; 16]);

impl fmt::Debug for FenceReceipt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "FenceReceipt(<redacted>)")
    }
}

/// What a fenced mutation presents: the installed token and the receipt for it.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FenceCredential {
    pub token: FenceToken,
    pub receipt: FenceReceipt,
}

impl FenceCredential {
    pub fn bytes(&self) -> [u8; 48] {
        let mut b = [0u8; 48];
        b[..32].copy_from_slice(&self.token.0);
        b[32..].copy_from_slice(&self.receipt.0);
        b
    }
    pub fn query_value(&self) -> String {
        hex::encode(self.bytes())
    }
}

/// The outcome of `POST /fence`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FenceRaise {
    /// Installed; the credential to present from now on.
    Installed(FenceCredential),
    /// Refused (the installed token is equal or greater); what is installed.
    Refused(Option<FenceToken>),
}

/// What `GET /fence` reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FenceState {
    pub fence: Option<FenceToken>,
    /// SHA-256 of the installed receipt (the receipt itself is never returned)
    pub receipt_sha256: Option<[u8; 32]>,
    /// PATCH C2 (indexd G-C2 v4.0 section 5): the account's event sequence head (None: not reported)
    pub seq: Option<u64>,
    /// PATCH C2: the operation id of the last head-advancing mutation (None: none since the last raise)
    pub last_op: Option<[u8; 16]>,
    /// PATCH C2: that mutation's server-computed operation digest
    pub last_op_digest: Option<[u8; 32]>,
    /// PATCH C2: the account is enrolled ("mode": "cas")
    pub cas_mode: bool,
    /// PATCH C2: what the indexer implements ("fence-v3", "cas-v4", ...)
    pub capabilities: Vec<String>,
}

/// PATCH C2 (canonical wire: work/indexd-c2-implementation-interface.txt DRAFT v4.0): query parameters of a v4 request.
pub(crate) const QUERY_PARAM_OP: &str = "op";
pub(crate) const QUERY_PARAM_SEQ: &str = "sq";
/// The v4 request-hash domain, and the operation-digest domain.
pub(crate) const C2_HASH_DOMAIN: &[u8] = b"indexd/fence/v4";
pub(crate) const C2_OP_DOMAIN: &[u8] = b"indexd/fence/v4/op";
/// The capability an indexer must report before this SDK enrols an account.
pub const C2_CAPABILITY: &str = "cas-v4";

/// PATCH C2: the v4 fields of one request: a fresh 16-byte operation id, and the expected head (head-advancing routes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct C2Op {
    pub op: [u8; 16],
    pub sq: Option<u64>,
}

impl C2Op {
    pub(crate) fn flags(&self) -> u64 {
        self.sq.is_some() as u64
    }
}

/// PATCH C2: the server-computed operation digest (G-C2 v4.0 section 3), recomputed here: BLAKE2b-256 over
/// WriteString("indexd/fence/v4/op") WriteString(method) WriteString(host) WriteString(path) Write(credential 48)
/// WriteUint64(flags) WriteUint64(sq) Write(op 16) WriteBytes(body). Only the validity time is excluded.
pub fn c2_op_digest(method: &str, host: &str, path: &str, cred: &FenceCredential, v4: &C2Op, body: Option<&[u8]>) -> [u8; 32] {
    let mut state = blake2b_simd::Params::new().hash_length(32).to_state();
    let mut write_string = |b: &[u8]| {
        state.update(&(b.len() as u64).to_le_bytes());
        state.update(b);
    };
    write_string(C2_OP_DOMAIN);
    write_string(method.as_bytes());
    write_string(host.as_bytes());
    write_string(path.as_bytes());
    state.update(&cred.bytes());
    state.update(&v4.flags().to_le_bytes());
    state.update(&v4.sq.unwrap_or(0).to_le_bytes());
    state.update(&v4.op);
    let body = body.unwrap_or(&[]);
    state.update(&(body.len() as u64).to_le_bytes());
    state.update(body);
    state.finalize().as_bytes().try_into().unwrap()
}

/// PATCH C2: the v4 request hash, for cross-implementation vectors (the signature covers it).
pub fn request_hash_v4_vector(method: &str, url: &str, body: Option<&[u8]>, valid_until_unix: i64, cred: &FenceCredential, v4: &C2Op) -> [u8; 32] {
    let url = reqwest::Url::parse(url).expect("vector url");
    let method = reqwest::Method::from_bytes(method.as_bytes()).expect("vector method");
    let vu = chrono::DateTime::from_timestamp(valid_until_unix, 0).expect("vector time");
    let h: sia_core::types::Hash256 = crate::app_client::request_hash_c2(&url, method, body, vu, Some(&cred.bytes()), Some(v4));
    let b: &[u8] = h.as_ref();
    b.try_into().unwrap()
}

/// PATCH C2: what a freshness or load check finds for one indexer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum C2Check {
    /// the indexer's head is exactly the one this client's own mutations produced; the state it reported
    Confirmed(FenceState),
    /// another holder of the credential mutated this account (or the indexer lost acknowledged state): this client
    /// never mutates it again (latched)
    Forked(String),
    /// an earlier mutation's outcome is still unknown and could not be settled now
    Unresolved(String),
    /// the indexer holds another fence or receipt than this client's: another writer was installed (not a fork; the
    /// caller's fence logic decides); the state it reported
    OtherFence(FenceState),
}

/// PATCH C2: the one mutation whose outcome is unknown (sent, answer lost or abandoned). It is settled by replaying it
/// byte for byte (same expected head): the indexer applies it once at most (interface rule 1c).
#[derive(Clone, Debug)]
pub(crate) enum C2Pending {
    Pin(crate::SealedObject, [u8; 16]),
    Delete(sia_core::types::Hash256, [u8; 16]),
}

/// PATCH C2: this client's conditional-head state for its indexer.
#[derive(Clone, Debug, Default)]
pub(crate) enum C2State {
    /// not enrolled: mutations carry no `sq` (legacy / unfenced / v3)
    #[default]
    Off,
    /// every mutation so far is accounted for: the indexer's head is `head`
    Ready { head: u64 },
    /// `op` was sent with expected head `head` and its outcome is unknown
    Pending { head: u64, op: C2Pending },
    /// latched for the life of this client
    Forked(String),
}

/// The request hash an indexer verifies, for cross-implementation test vectors. Without a credential: the 0.6.0 raw
/// form. With one: the indexd-fence R5 length-prefixed "indexd/fence/v3" stream (app_client::request_hash_fenced).
pub fn request_hash_vector(method: &str, url: &str, body: Option<&[u8]>, valid_until_unix: i64, cred: Option<&FenceCredential>) -> [u8; 32] {
    let url = reqwest::Url::parse(url).expect("vector url");
    let method = reqwest::Method::from_bytes(method.as_bytes()).expect("vector method");
    let vu = chrono::DateTime::from_timestamp(valid_until_unix, 0).expect("vector time");
    let c = cred.map(|c| c.bytes());
    let h: sia_core::types::Hash256 = crate::app_client::request_hash_fenced(&url, method, body, vu, c.as_ref());
    let b: &[u8] = h.as_ref();
    b.try_into().unwrap()
}

/// Exactly `2 * N` lowercase hex characters.
pub(crate) fn strict_hex<const N: usize>(s: &str) -> Result<[u8; N], String> {
    if s.len() != 2 * N || !s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
        return Err(format!("expected {} lowercase hex characters", 2 * N));
    }
    let v = hex::decode(s).map_err(|e| e.to_string())?;
    Ok(v.try_into().unwrap())
}

/// Client-side fence state, one per SDK instance (shared by its clones).
#[derive(Default, Debug)]
pub(crate) struct FenceSlotState {
    /// the credential every fenced mutation carries (None: no `sf`)
    pub cred: Option<FenceCredential>,
    /// the first fenced refusal seen: the token the indexer holds instead (None inside: no fence at all)
    pub conflict: Option<Option<FenceToken>>,
    /// PATCH C2: the conditional-head state
    pub c2: C2State,
    /// PATCH C2: held across each conditional mutation (and each check), so this client has at most one in flight
    pub c2_serial: Arc<tokio::sync::Mutex<()>>,
}

pub(crate) type FenceSlot = Arc<Mutex<FenceSlotState>>;

/// PATCH C2: the kind of a 412 body: {"conflict": "seq"|"op"|"mode", "seq": n|null, ...}; None when absent.
pub(crate) fn parse_conflict(body: &str) -> Option<(String, Option<u64>)> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let o = v.as_object()?;
    let kind = o.get("conflict")?.as_str()?.to_string();
    Some((kind, o.get("seq").and_then(|s| s.as_u64())))
}

/// The JSON body of a fenced refusal: `{"fence": "<64 hex>" | null}`.
pub(crate) fn parse_refusal(body: &str) -> Option<Option<FenceToken>> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let f = v.as_object()?.get("fence")?;
    match f {
        serde_json::Value::Null => Some(None),
        serde_json::Value::String(s) => FenceToken::parse_hex(s).ok().map(Some),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_order_by_generation_counter_iid_and_parse_strictly() {
        let a = FenceToken::new(16 << 48, 5, [9; 16]).unwrap();
        let b = FenceToken::new(16 << 48, 5, [10; 16]).unwrap();
        let c = FenceToken::new(16 << 48, 6, [0; 16]).unwrap();
        let d = FenceToken::new(17 << 48, 0, [0; 16]).unwrap();
        assert!(a < b && b < c && c < d);
        assert_eq!(FenceToken::parse_hex(&a.to_hex()).unwrap(), a);
        assert!(FenceToken::parse_hex(&a.to_hex().to_uppercase()).is_err(), "uppercase is not canonical");
        assert!(FenceToken::parse_hex(&a.to_hex()[1..]).is_err());
        assert!(FenceToken::new(1 << 63, 0, [0; 16]).is_err());
        let mut top = [0u8; 32];
        top[8] = 0x80;
        assert!(FenceToken::parse_hex(&hex::encode(top)).is_err(), "a counter top bit is refused");
        assert_eq!(parse_refusal(r#"{"fence":null}"#), Some(None));
        assert_eq!(parse_refusal(&format!(r#"{{"fence":"{}"}}"#, d.to_hex())), Some(Some(d)));
        assert_eq!(parse_refusal(r#"{"error":"x"}"#), None);
    }
}
