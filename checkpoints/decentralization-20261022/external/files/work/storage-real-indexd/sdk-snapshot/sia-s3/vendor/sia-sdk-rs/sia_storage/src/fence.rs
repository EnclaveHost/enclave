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
/// Domain separator appended to the request hash before the credential (only when `sf` is present).
pub(crate) const FENCE_HASH_DOMAIN: &[u8] = b"indexd/fence/v2";

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
}

/// The request hash an indexer verifies, for cross-implementation test vectors (interface v3 section 3): method,
/// `host[:port]`, path, `valid_until` (unix seconds, i64 little-endian), body, then `"indexd/fence/v2" || credential`
/// when a credential is given.
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
}

pub(crate) type FenceSlot = Arc<Mutex<FenceSlotState>>;

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
