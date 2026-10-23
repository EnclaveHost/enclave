//! The S3 key space over Sia objects, with no local state.
//!
//! Every Sia object this app pins carries JSON metadata (sealed by the SDK, so
//! the indexer sees ciphertext). That metadata lists the S3 keys the object
//! serves, which makes the indexer's object feed the whole index:
//!
//!   - PUT uploads the body as one object whose metadata names the key.
//!   - CopyObject adds an entry to the source's host object: no data moves.
//!   - DELETE removes the entry; an object left with no entries is deleted.
//!   - Multipart parts are objects tagged `mp`; Complete writes the key's entry
//!     on the first part and lists the others (`x`) in order.
//!   - The compactor repacks small single-object keys into shared slabs (a
//!     lone small upload occupies a full slab: 4 MiB sectors on 30 hosts).
//!
//! indexd caps sealed object metadata at 1 KiB (and refuses objects without
//! data). A key whose entry does not fit (many multipart parts, a long key,
//! a copy onto a crowded host) gets a manifest instead: a small object whose
//! *data* is the entry and its part list, and whose metadata (`mf`) holds only
//! the key's hash, version, and the body's length and SHA-256. The SDK
//! encrypts that body and Sia's sector proofs bind it to the signed object,
//! so it is exactly as private and tamper-evident as the metadata.
//!
//! Remote writes happen first; the in-memory index changes only after they
//! succeed. A remote change whose outcome is unknown (an error, or no answer
//! before the deadline) may still have happened or may still happen, at any
//! later time: it marks the store ambiguous (`ambiguous_ms`), and replica.rs
//! re-reads the indexer's object feed to bring the index up to date. No safety
//! decision depends on how long ago that was.
//!
//! One `Store` is one indexer (a replica). Every entry carries a version
//! (`h` clock + `i` write id) so replicas can be merged and repaired by
//! replica.rs. A DELETE leaves a tombstone (`d`, naming the key by hash) in
//! the deleted key's own host object, and later a *deletion floor* in a ledger
//! object (`lg`): a small encrypted object whose body lists floors (key hash +
//! the deletion's version) and whose signed metadata holds the body's length
//! and SHA-256. Any version of a key older than its floor is dead wherever and
//! whenever it appears, so a write that lands arbitrarily late, or old data an
//! indexer replays, cannot bring a deleted key back. Floors are kept for good;
//! once one is pinned, the payload it covers is reclaimed.
//!
//! A *membership record* (`ms`) states which replica set this replica's
//! contents are complete for (replica.rs, "Membership"). It lives in metadata
//! alone, on a one-byte object, and is never rewritten: a newer record is a new
//! object.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::io::Cursor;
use std::rc::Rc;
use std::time::Duration;

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sia_storage::{DownloadOptions, Object, ObjectsCursor, PackedUploadOptions, Sdk, UploadOptions};
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

pub type Res<T> = Result<T, String>;
/// (bucket, key)
pub type KK = (String, String);

/// A conditional PUT (If-Match / If-None-Match: *): checked against the merged view before the upload, and again under
/// the write lock when the new version is committed (replica.rs), so a writer that lost a race in between gets
/// PreconditionFailed instead of overwriting.
#[derive(Clone, Debug, PartialEq)]
pub enum Cond {
    None,
    IfMatch(String),
    IfNoneMatch,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    pub b: String,
    pub k: String,
    /// size in bytes
    pub s: u64,
    /// ETag (no quotes)
    pub t: String,
    /// last modified, unix seconds
    pub m: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub c: Option<String>,
    /// further part objects after the host, in order (multipart keys); for a manifest key, every data object
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub x: Vec<String>,
    /// version clock in ms, strictly increasing per writer (0 before 0.2.0: `m` * 1000 is used)
    #[serde(default, skip_serializing_if = "is_zero")]
    pub h: u64,
    /// random write id: names the version across replicas and breaks clock ties
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub i: String,
}

/// A key version's position in the total order every replica merges by.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Ver {
    pub h: u64,
    pub i: String,
}

fn ver_of(h: u64, m: i64, i: &str) -> Ver {
    Ver { h: if h > 0 { h } else { (m.max(0) as u64) * 1000 }, i: i.to_string() }
}

impl Entry {
    pub fn ver(&self) -> Ver {
        ver_of(self.h, self.m, &self.i)
    }
}

/// A deletion, newer than every version it removes. It names the key by hash (`qkey`), so it fits whatever the
/// key's length, and stays in an object until every configured replica is known to hold no older version.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Tomb {
    pub q: String,
    pub h: u64,
    pub i: String,
}

impl Tomb {
    pub fn ver(&self) -> Ver {
        Ver { h: self.h, i: self.i.clone() }
    }
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct PartTag {
    pub u: String,
    pub b: String,
    pub k: String,
    pub n: u32,
    pub t: String,
}

/// The metadata of a manifest object: which key version its body describes, and the body's length and SHA-256.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MfRef {
    pub q: String,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub h: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub i: String,
    pub m: i64,
    pub n: u64,
    pub z: String,
}

impl MfRef {
    pub fn ver(&self) -> Ver {
        ver_of(self.h, self.m, &self.i)
    }
}

/// The metadata of a ledger object: its body's length and SHA-256, and how many floors it lists.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct LgRef {
    pub n: u64,
    pub z: String,
    pub c: u64,
}

/// A membership: its epoch, write quorum and members (`member_id` of each canonical indexer URL, sorted).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MsDef {
    pub s: u64,
    pub w: u32,
    pub m: Vec<String>,
}

/// A membership record, in a record object's metadata. `k` is "a" (admitted: this replica held the complete
/// history when membership `d` admitted it) or "s" (sealed: this replica belonged to membership `p`, which `d`
/// replaced). `p` is absent when `d` replaced a deployment that had no records. `c` carries the version ceiling.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MsRec {
    pub k: String,
    pub d: MsDef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p: Option<MsDef>,
    /// the highest version-range ceiling the writer knew when it wrote this record (its own acknowledged one, or any
    /// it observed): a later writer's clock starts above it (replica.rs, "Versions", M2)
    #[serde(default, skip_serializing_if = "is_zero")]
    pub c: u64,
}

impl MsRec {
    pub fn admit(&self) -> bool {
        self.k == "a"
    }
}

/// A replica's name in membership records: 64 bits of SHA-256 over its canonical indexer URL.
pub fn member_id(indexer: &str) -> String {
    hex::encode(&Sha256::digest(indexer.as_bytes())[..8])
}

/// The body of a ledger object: deletion floors, each a key hash and the version of its newest deletion.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Ledger {
    pub v: u32,
    pub f: Vec<Tomb>,
}

/// The body of a manifest object.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub v: u32,
    pub b: String,
    pub k: String,
    pub s: u64,
    pub t: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub c: Option<String>,
    /// the data objects, in order
    pub x: Vec<String>,
}

/// Object metadata. `v` is 1 when the object names inline entries or is a multipart part (what 0.1.x understands);
/// 2 for everything newer (manifests, manifest data, tombstone carriers, ledgers), which 0.1.x leaves alone as
/// foreign.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Meta {
    pub v: u32,
    /// already packed with others (compactor output, or large)
    #[serde(default, skip_serializing_if = "is_false")]
    pub p: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub e: Vec<Entry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mp: Option<PartTag>,
    /// tombstones (replicated deployments only)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub d: Vec<Tomb>,
    /// this object is a manifest
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mf: Option<MfRef>,
    /// this object is a ledger of deletion floors
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lg: Option<LgRef>,
    /// this object is a membership record
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ms: Option<MsRec>,
    /// this object is a version-range ceiling: the writer that pinned it stamps no version above this (ms clock), and
    /// a later writer starts strictly above the highest ceiling its boot set holds (replica.rs, "Versions")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ck: Option<u64>,
    /// PATCH C2: this object's ledger or membership record is TENTATIVE (phase 1 of a two-phase write; replica.rs, "C2")
    #[serde(default, skip_serializing_if = "is_false")]
    pub z: bool,
}

/// PATCH C2: the write-id prefix that marks a key entry, tombstone or manifest reference TENTATIVE: written in phase 1
/// of a two-phase write and ignored by every reader until phase 2 removes the prefix (replica.rs, "C2").
pub const TENTATIVE: &str = "~";

pub fn is_tentative(i: &str) -> bool {
    i.starts_with(TENTATIVE)
}

impl Entry {
    /// PATCH C2: this entry as phase 1 writes it.
    pub fn tentative(&self) -> Entry {
        Entry { i: format!("{TENTATIVE}{}", self.i), ..self.clone() }
    }
}

impl Tomb {
    /// PATCH C2: this tombstone as phase 1 writes it.
    pub fn tentative(&self) -> Tomb {
        Tomb { i: format!("{TENTATIVE}{}", self.i), ..self.clone() }
    }
}

impl Meta {
    /// Does the object mean something by its metadata alone (not counting being some key's data)?
    fn purposeful(&self) -> bool {
        !self.e.is_empty() || self.mp.is_some() || !self.d.is_empty() || self.mf.is_some() || self.lg.is_some() || self.ms.is_some() || self.ck.is_some()
    }

    /// PATCH C2: v 3 for metadata holding anything tentative (versions before C2 read only 1 and 2, so they ignore such
    /// an object rather than take a tentative write for a committed one); otherwise as before.
    fn normalized(mut self) -> Meta {
        self.v = if self.has_tentative() {
            3
        } else if self.e.is_empty() && self.mp.is_none() {
            2
        } else {
            1
        };
        self
    }

    /// PATCH C2: does this metadata hold a tentative entry, tombstone, manifest reference, ledger or record?
    pub fn has_tentative(&self) -> bool {
        self.z || self.e.iter().any(|e| is_tentative(&e.i)) || self.d.iter().any(|t| is_tentative(&t.i)) || self.mf.as_ref().is_some_and(|m| is_tentative(&m.i))
    }

    /// PATCH C2: this metadata with every tentative item dropped (the cleanup of phase-1 leftovers).
    pub fn without_tentative(&self) -> Meta {
        let mut m = self.clone();
        m.e.retain(|e| !is_tentative(&e.i));
        m.d.retain(|t| !is_tentative(&t.i));
        if m.mf.as_ref().is_some_and(|mf| is_tentative(&mf.i)) {
            m.mf = None;
        }
        if m.z {
            m.lg = None;
            m.ms = None;
            m.z = false;
        }
        m
    }
}

/// PATCH C2: the two-phase gate of one replicated write (replica.rs, "C2"). Each replica's job reports whether its
/// phase-1 pin (tentative) succeeded; phase 2 (the committing pin) runs only once `need` VOTERS have phase 1, and never
/// if that becomes impossible. Under the indexer's head CAS a replica takes phase-1 pins of at most one holder of a
/// credential after a fork, so with 2W > N at most one holder can ever open a gate: only it commits.
pub struct Gate {
    need: usize,
    voters: Vec<usize>,
    total: Cell<usize>,
    sealed: Cell<bool>,
    ok: Cell<usize>,
    reported: Cell<usize>,
    tx: tokio::sync::watch::Sender<Option<bool>>,
}

impl Gate {
    pub fn new(voters: Vec<usize>, need: usize) -> Rc<Gate> {
        Rc::new(Gate {
            need,
            voters,
            total: Cell::new(0),
            sealed: Cell::new(false),
            ok: Cell::new(0),
            reported: Cell::new(0),
            tx: tokio::sync::watch::channel(None).0,
        })
    }

    /// All jobs are created: decide as soon as the outcome is certain.
    pub fn seal(&self) {
        self.sealed.set(true);
        self.decide();
    }

    fn report(&self, i: usize, ok: bool) {
        self.reported.set(self.reported.get() + 1);
        if ok && self.voters.contains(&i) {
            self.ok.set(self.ok.get() + 1);
        }
        self.decide();
    }

    fn decide(&self) {
        if self.tx.borrow().is_some() {
            return;
        }
        if self.ok.get() >= self.need {
            self.tx.send_replace(Some(true));
        } else if self.sealed.get() && self.reported.get() >= self.total.get() {
            self.tx.send_replace(Some(false));
        }
    }

    async fn wait(&self) -> bool {
        let mut rx = self.tx.subscribe();
        loop {
            if let Some(v) = *rx.borrow_and_update() {
                return v;
            }
            if rx.changed().await.is_err() {
                return false;
            }
        }
    }
}

/// PATCH C2: one replica's handle on a gate. It reports phase 1 exactly once: success or failure, or failure when the
/// job ends (or is dropped) without reaching it.
pub struct GateRef {
    gate: Rc<Gate>,
    i: usize,
    reported: Cell<bool>,
}

impl GateRef {
    pub fn new(gate: &Rc<Gate>, i: usize) -> GateRef {
        gate.total.set(gate.total.get() + 1);
        GateRef { gate: gate.clone(), i, reported: Cell::new(false) }
    }

    fn phase1(&self, ok: bool) {
        if !self.reported.replace(true) {
            self.gate.report(self.i, ok);
        }
    }

    /// This replica already holds the write durably (committed): it counts, and has nothing to do in phase 2.
    pub fn already_durable(&self) {
        self.phase1(true);
    }
}

impl Drop for GateRef {
    fn drop(&mut self) {
        self.phase1(false);
    }
}

/// What a gated write answers when its gate stays shut: phase 1 reached too few voters (or another holder of the
/// credential holds the replicas); only tentative content was written, which no reader takes and cleanup removes.
pub const NOT_COMMITTED: &str = "ServiceUnavailable: the write's first phase did not reach a write quorum; nothing was committed";

pub struct Key {
    /// the object whose metadata names the key: its first data object, or its manifest
    pub host: String,
    pub entry: Entry,
    pub manifest: bool,
}

impl Key {
    /// Every object the key depends on.
    pub fn objects(&self) -> Vec<String> {
        std::iter::once(self.host.clone()).chain(self.entry.x.iter().cloned()).collect()
    }

    /// The objects holding the key's bytes, in order.
    pub fn data(&self) -> Vec<String> {
        if self.manifest { self.entry.x.clone() } else { self.objects() }
    }
}

pub struct Upload {
    pub b: String,
    pub k: String,
    pub started: i64,
    /// part number -> (object id, etag, size)
    pub parts: BTreeMap<u32, (String, String, u64)>,
}

#[derive(Default)]
pub struct Index {
    pub keys: BTreeMap<KK, Key>,
    pub objs: HashMap<String, (Object, Meta)>,
    pub uploads: HashMap<String, Upload>,
    /// objects with our metadata that serve nothing (found at load)
    pub orphans: Vec<String>,
    /// every tombstone this replica holds, by key hash: (holding object, tombstone)
    pub tombs: BTreeMap<String, Vec<(String, Tomb)>>,
    /// the oldest version of each key (by hash) any object names, live, superseded or hidden by a tombstone, as
    /// listed: a key's tombstones are needed while an older version of it survives anywhere
    pub oldest: HashMap<String, Ver>,
    /// the bodies of the manifests read at load, by object
    pub manifests: HashMap<String, Manifest>,
    /// manifest objects whose body could not be read: their keys and parts are unknown, so nothing is swept
    pub unresolved: Vec<String>,
    /// deletion floors from this replica's ledgers, by key hash (the newest per key)
    pub floors: HashMap<String, Tomb>,
    /// ledger objects read, by object id
    pub ledgers: Vec<String>,
    /// ledger objects whose body could not be read: their floors are unknown, so nothing is swept or merged
    pub unread_ledgers: Vec<String>,
    /// membership records, by object id
    pub records: Vec<(String, MsRec)>,
    /// version-range ceiling objects: (object id, ceiling)
    pub ceilings: Vec<(String, u64)>,
    /// the highest version-range ceiling this replica holds (0: none, a legacy replica)
    pub ceiling: u64,
    /// PATCH C2: objects holding tentative content (phase-1 leftovers of writes that never committed), as listed
    pub tentative: Vec<String>,
    /// PATCH U1-B (blocked listing): objects the indexer listed as blocked by its operator, by id. Their metadata is
    /// withheld, and any object's metadata may carry key entries, tombstones, a manifest, a ledger, a membership
    /// record or a ceiling, so an index with any of them is incomplete in a way that cannot be bounded: it is never
    /// attached as a replica (replica.rs, "Blocked objects"), only read to see which key versions it still vouches for.
    pub blocked: Vec<String>,
}

#[derive(Default, Clone, Serialize)]
pub struct Stats {
    pub compactions: u64,
    pub compacted_objects: u64,
    pub last_compaction: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct Opts {
    /// (data, parity) shards per slab
    pub shards: (u8, u8),
    /// how a replica's objects are listed at load and at a re-read (PATCH U1)
    pub listing: Listing,
    /// longest wait for one indexer metadata call (pin, delete, a page of the object feed)
    pub meta_timeout: Duration,
    /// longest wait for one upload or download
    pub upload_timeout: Duration,
}

impl Default for Opts {
    fn default() -> Self {
        Opts { shards: (10, 20), listing: Listing::Current, meta_timeout: Duration::from_secs(120), upload_timeout: Duration::from_secs(1800) }
    }
}

/// How a replica's objects are listed (PATCH U1). indexd 0.6.0's event feed leaves out every object whose latest
/// pin or delete has not been published yet (published at most once a second, stalled while the database clock is
/// behind the last published second), so a feed listing is not a superset of the pins the indexer acknowledged,
/// which the boot quorum and every re-read rely on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Listing {
    /// the indexer's current objects, read from its object table (the U1 endpoint, GET /current/objects): every
    /// pin acknowledged before the listing began. An indexer without the endpoint fails the load (fail closed).
    Current,
    /// the event feed (GET /objects): misses unpublished pins. Kept only to demonstrate the defect.
    Feed,
}

pub struct Store {
    pub sdk: Sdk,
    pub idx: Mutex<Index>,
    pub stats: RefCell<Stats>,
    pub compact_max_object: u64,
    pub opts: Opts,
    /// when the listing behind `idx` began (ms)
    pub listed_ms: u64,
    /// when a remote change of ours last had an unknown outcome (ms; 0: none since this process loaded)
    pub ambiguous_ms: Cell<u64>,
    /// bumped by every remote change that succeeded
    pub changes: Cell<u64>,
    /// set once, when `Cluster::reconcile` replaces this store with a fresh listing: from then on no call through this
    /// store reaches the indexer (`remote` refuses before sending), so a caller still holding the old `Rc` (the
    /// compactor, an UploadPart, a DELETE's floor) cannot change durable state the fresh index does not know about
    retired: Cell<bool>,
    /// remote calls sent and not yet answered (or abandoned): `reconcile` swaps only when this is 0
    inflight: Cell<u32>,
}

/// Counts one remote call in flight. Dropped before the answer (the caller's future was abandoned, e.g. by `fan_out`):
/// the call may still be applied, so the store is marked ambiguous.
struct InFlight<'a> {
    store: &'a Store,
    answered: bool,
}

impl<'a> InFlight<'a> {
    fn new(store: &'a Store) -> Self {
        store.inflight.set(store.inflight.get() + 1);
        InFlight { store, answered: false }
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.store.inflight.set(self.store.inflight.get().saturating_sub(1));
        if !self.answered {
            self.store.mark_ambiguous();
        }
    }
}

/// What a call on a replaced store answers: nothing was sent.
pub const RETIRED: &str = "this replica's index was replaced while the call was prepared; nothing was sent; retry";

/// How a new version's entry is stored on one replica.
pub enum Placement {
    /// in the metadata of its host object
    Inline,
    /// in an uploaded (not yet pinned) manifest object over data objects `x`
    Manifest { obj: Object, n: u64, z: String, x: Vec<String> },
}

/// A multipart completion staged on one replica (validated, manifest uploaded if one is needed).
pub struct Completion {
    pub b: String,
    pub k: String,
    pub etag: String,
    pub size: u64,
    pub ids: Vec<String>,
    unused: Vec<String>,
    pub placement: Placement,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

/// indexd stores at most 1024 bytes of sealed object metadata (slabs.MaxMetadataSize), and sealing adds a 24-byte
/// nonce and a 16-byte tag.
pub const MAX_META: usize = 1024 - 24 - 16;
/// A manifest body: room for 10,000 parts (S3's limit) and a 1 KiB key.
pub const MAX_MANIFEST: u64 = 1 << 20;
/// A ledger body: about 3.5 million floors.
pub const MAX_LEDGER: u64 = 256 << 20;
/// Ledgers per replica before they are merged into one.
const MERGE_LEDGERS_AT: usize = 16;

pub fn meta_bytes(meta: &Meta) -> Res<Vec<u8>> {
    let raw = serde_json::to_vec(meta).map_err(e2s)?;
    if raw.len() > MAX_META {
        return Err(format!("EntityTooLarge: the object's metadata would be {} bytes; the indexer stores at most {MAX_META}", raw.len()));
    }
    Ok(raw)
}

fn fits(meta: &Meta) -> bool {
    meta_bytes(&meta.clone().normalized()).is_ok()
}

fn e2s<E: std::fmt::Display>(e: E) -> String {
    redact(&e.to_string())
}

/// `s` with the query and fragment cut from every http(s) URL in it. The SDK authenticates each indexer request
/// with a signature in its URL's query (`sv`, `sc`, `ss`), and an HTTP client error names the URL it failed on;
/// error text reaches the unauthenticated status page and /healthz, so it never carries a query.
pub fn redact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let at = match (rest.find("http://"), rest.find("https://")) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) | (None, Some(a)) => a,
            (None, None) => break,
        };
        out.push_str(&rest[..at]);
        let url = &rest[at..];
        // the URL runs to whitespace or a character that ends it in prose and error text
        let end = url.find(|c: char| c.is_whitespace() || matches!(c, ')' | '(' | '"' | '\'' | '<' | '>' | ',' | ';' | '`')).unwrap_or(url.len());
        let token = &url[..end];
        match token.find(['?', '#']) {
            Some(q) => {
                out.push_str(&token[..q]);
                out.push_str("?[redacted]");
            }
            None => out.push_str(token),
        }
        rest = &url[end..];
    }
    out.push_str(rest);
    out
}

pub fn md5_hex(b: &[u8]) -> String {
    hex::encode(Md5::digest(b))
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// A key's name in tombstones and manifest metadata: 128 bits of SHA-256 over the length-prefixed bucket and key.
pub fn qkey(b: &str, k: &str) -> String {
    let mut h = Sha256::new();
    for part in [b.as_bytes(), k.as_bytes()] {
        h.update((part.len() as u64).to_be_bytes());
        h.update(part);
    }
    hex::encode(&h.finalize()[..16])
}

pub fn new_id() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("wasi random");
    hex::encode(b)
}

/// A write id: short, because it is stored in every entry and metadata is capped at 1 KiB.
pub fn new_wid() -> String {
    let mut b = [0u8; 8];
    getrandom::fill(&mut b).expect("wasi random");
    hex::encode(b)
}

/// `e` with the longest version stamp it could get, to decide its placement before it is stamped.
fn stamped(e: &Entry) -> Entry {
    Entry { m: 9_999_999_999, h: 9_999_999_999_999, i: "f".repeat(16), ..e.clone() }
}

fn manifest_of(e: &Entry, x: Vec<String>) -> Manifest {
    Manifest { v: 1, b: e.b.clone(), k: e.k.clone(), s: e.s, t: e.t.clone(), c: e.c.clone(), x }
}

/// Read and check a manifest body against its signed metadata.
pub fn parse_manifest(raw: &[u8], mf: &MfRef) -> Res<Manifest> {
    if raw.len() as u64 != mf.n || sha256_hex(raw) != mf.z {
        return Err("manifest body does not match its metadata".into());
    }
    let man: Manifest = serde_json::from_slice(raw).map_err(|e| format!("manifest: {e}"))?;
    if man.v != 1 || qkey(&man.b, &man.k) != mf.q || man.x.is_empty() {
        return Err("manifest names another key, or no data".into());
    }
    Ok(man)
}

fn note_oldest(oldest: &mut HashMap<String, Ver>, q: String, v: Ver) {
    let o = oldest.entry(q).or_insert_with(|| v.clone());
    if v < *o {
        *o = v;
    }
}

/// The newest deletion this replica knows for a key hash: a tombstone in an object, or a ledger floor.
fn deletion<'a>(tombs: &'a BTreeMap<String, Vec<(String, Tomb)>>, floors: &'a HashMap<String, Tomb>, q: &str) -> Option<&'a Tomb> {
    let held = tombs.get(q).and_then(|ts| ts.iter().map(|(_, t)| t).max_by_key(|t| t.ver()));
    match (held, floors.get(q)) {
        (Some(a), Some(b)) => Some(if a.ver() >= b.ver() { a } else { b }),
        (a, b) => a.or(b),
    }
}

/// Build an index from listed objects and the manifest and ledger bodies that could be read.
pub fn build_index(objs: HashMap<String, (Object, Meta)>, manifests: HashMap<String, Manifest>, ledgers: HashMap<String, Ledger>) -> Index {
    let mut idx = Index { objs, manifests, ..Default::default() };
    for (id, (_, m)) in &idx.objs {
        if let Some(c) = m.ck {
            idx.ceilings.push((id.clone(), c));
            idx.ceiling = idx.ceiling.max(c);
        }
        if m.lg.is_some() && !m.z {
            match ledgers.get(id) {
                Some(l) => {
                    idx.ledgers.push(id.clone());
                    for f in &l.f {
                        if idx.floors.get(&f.q).is_none_or(|c| f.ver() > c.ver()) {
                            idx.floors.insert(f.q.clone(), f.clone());
                        }
                    }
                }
                None => idx.unread_ledgers.push(id.clone()),
            }
        }
    }
    let mut cands: Vec<(KK, Key)> = Vec::new();
    for (id, (_, m)) in &idx.objs {
        // PATCH C2: tentative content (phase 1 of a write that never committed) is not taken; cleanup removes it
        if m.has_tentative() {
            idx.tentative.push(id.clone());
        }
        for e in m.e.iter().filter(|e| !is_tentative(&e.i)) {
            note_oldest(&mut idx.oldest, qkey(&e.b, &e.k), e.ver());
            cands.push(((e.b.clone(), e.k.clone()), Key { host: id.clone(), entry: e.clone(), manifest: false }));
        }
        if let Some(mf) = m.mf.as_ref().filter(|mf| !is_tentative(&mf.i)) {
            note_oldest(&mut idx.oldest, mf.q.clone(), mf.ver());
            match idx.manifests.get(id) {
                Some(man) => {
                    let entry = Entry { b: man.b.clone(), k: man.k.clone(), s: man.s, t: man.t.clone(), m: mf.m, c: man.c.clone(), x: man.x.clone(), h: mf.h, i: mf.i.clone() };
                    cands.push(((man.b.clone(), man.k.clone()), Key { host: id.clone(), entry, manifest: true }));
                }
                None => idx.unresolved.push(id.clone()),
            }
        }
        for t in m.d.iter().filter(|t| !is_tentative(&t.i)) {
            idx.tombs.entry(t.q.clone()).or_default().push((id.clone(), t.clone()));
        }
        if let Some(r) = m.ms.as_ref().filter(|_| !m.z) {
            idx.records.push((id.clone(), r.clone()));
        }
    }
    let mut dups = 0;
    for (kk, key) in cands {
        match idx.keys.get(&kk) {
            Some(cur) => {
                dups += 1;
                if key.entry.ver() > cur.entry.ver() {
                    idx.keys.insert(kk, key);
                }
            }
            None => {
                idx.keys.insert(kk, key);
            }
        }
    }
    // a tombstone or floor hides any older version of its key (one the DELETE did not reach, a write that landed
    // late, or old data replayed)
    let (tombs, floors) = (&idx.tombs, &idx.floors);
    idx.keys.retain(|kk, k| deletion(tombs, floors, &qkey(&kk.0, &kk.1)).is_none_or(|t| t.ver() < k.entry.ver()));
    let referenced: HashSet<String> = idx.keys.values().flat_map(|k| k.objects()).collect();
    for (id, (obj, m)) in &idx.objs {
        // objects holding tombstones stay until the tombstones are collected; unread manifests are unknown
        if referenced.contains(id) || !m.d.is_empty() || m.lg.is_some() || m.ms.is_some() || m.ck.is_some() || (m.mf.is_some() && !idx.manifests.contains_key(id)) {
            continue;
        }
        if let Some(t) = &m.mp {
            let u = idx.uploads.entry(t.u.clone()).or_insert_with(|| Upload {
                b: t.b.clone(),
                k: t.k.clone(),
                started: obj.created_at.timestamp(),
                parts: BTreeMap::new(),
            });
            u.parts.insert(t.n, (id.clone(), t.t.clone(), obj.size()));
            u.started = u.started.min(obj.created_at.timestamp());
        } else {
            idx.orphans.push(id.clone());
        }
    }
    if !idx.unresolved.is_empty() || !idx.unread_ledgers.is_empty() {
        // an unread manifest's data objects and parts look unreferenced, and an unread ledger's floors are
        // unknown: delete nothing
        idx.orphans.clear();
    }
    eprintln!(
        "[sia-s3] index: {} objects, {} keys, {} open uploads, {} orphans, {} tombstoned keys, {} floors in {} ledgers ({} unread), {} manifests ({} unread), {dups} superseded entries",
        idx.objs.len(),
        idx.keys.len(),
        idx.uploads.len(),
        idx.orphans.len(),
        idx.tombs.len(),
        idx.floors.len(),
        idx.ledgers.len(),
        idx.unread_ledgers.len(),
        idx.manifests.len(),
        idx.unresolved.len()
    );
    idx
}

impl Index {
    /// The (object, offset, length) reads that cover [start, start+len) of a key.
    pub fn segments(&self, k: &Key, start: u64, len: u64) -> Res<Vec<(Object, u64, u64)>> {
        let mut out = Vec::new();
        let (mut pos, end) = (0u64, start + len);
        let data = k.data();
        for id in &data {
            let (obj, _) = self.objs.get(id).ok_or_else(|| format!("part {id} is missing from the index"))?;
            // single-object keys may hold a 1-byte placeholder for an empty body
            let size = if data.len() == 1 { k.entry.s } else { obj.size() };
            let (a, b) = (pos, pos + size);
            if b > start && a < end {
                let from = start.max(a) - a;
                let to = end.min(b) - a;
                out.push((obj.clone(), from, to - from));
            }
            pos = b;
            if pos >= end {
                break;
            }
        }
        Ok(out)
    }

    fn referenced_elsewhere(&self, id: &str, except: &KK) -> bool {
        self.keys.iter().any(|(kk, k)| kk != except && (k.host == id || k.entry.x.iter().any(|x| x == id)))
    }

    /// Is the object some key's part (a data object behind a manifest, or a later multipart part)?
    fn is_part(&self, id: &str) -> bool {
        self.keys.values().any(|k| k.entry.x.iter().any(|x| x == id))
    }

    /// The newest deletion this replica holds for a key hash: a tombstone in an object, or a ledger floor.
    pub fn tomb(&self, q: &str) -> Option<&Tomb> {
        deletion(&self.tombs, &self.floors, q)
    }

    /// Is everything this replica could know about deletions read (no unread ledger)?
    pub fn floors_complete(&self) -> bool {
        self.unread_ledgers.is_empty()
    }

    /// Is every key and deletion this replica holds known: no unread ledger, and no unread manifest that may hold a
    /// live version (`blocking_unresolved`; a superseded one is dead whatever it holds)?
    pub fn complete(&self) -> bool {
        self.unread_ledgers.is_empty() && self.blocking_unresolved().is_empty() && self.blocked.is_empty()
    }

    /// PATCH U1-B: does this index show version `v` of `kk` (or a newer one) with every object it depends on listed and
    /// not blocked? A version it does not vouch for may be one its operator blocked.
    pub fn vouches(&self, kk: &KK, v: &Ver) -> bool {
        self.keys.get(kk).is_some_and(|k| k.entry.ver() >= *v && k.objects().iter().all(|o| self.objs.contains_key(o)))
    }

    /// The newest membership record here: highest epoch, an admission over a seal.
    pub fn newest_record(&self) -> Option<&MsRec> {
        self.records.iter().map(|(_, r)| r).max_by_key(|r| (r.d.s, r.admit()))
    }

    /// The highest version ceiling this replica holds evidence of: its ceiling objects, and the ceilings its
    /// membership records carry.
    pub fn version_floor(&self) -> u64 {
        self.records.iter().map(|(_, r)| r.c).fold(self.ceiling, u64::max)
    }

    /// Unresolved manifests (body unreadable) that may hold a key's newest version here: their signed metadata names a
    /// version that no resolved entry of the same key, and no tombstone or floor, matches or supersedes. Without
    /// their bodies this index would serve an older version (or none) of those keys, and could delete or move data
    /// objects only those manifests name. A superseded one is harmless: its version is dead whatever it holds.
    pub fn blocking_unresolved(&self) -> Vec<String> {
        if self.unresolved.is_empty() {
            return Vec::new();
        }
        let live: HashMap<String, Ver> = self.keys.iter().map(|(kk, k)| (qkey(&kk.0, &kk.1), k.entry.ver())).collect();
        self.unresolved
            .iter()
            .filter(|id| {
                let Some(mf) = self.objs.get(*id).and_then(|(_, m)| m.mf.as_ref()) else { return false };
                let v = mf.ver();
                let superseded = live.get(&mf.q).is_some_and(|lv| *lv >= v) || self.tomb(&mf.q).is_some_and(|t| t.ver() >= v);
                !superseded
            })
            .cloned()
            .collect()
    }

    fn superseded(&self, kk: &KK, v: &Ver) -> bool {
        self.keys.get(kk).is_some_and(|k| k.entry.ver() >= *v) || self.tomb(&qkey(&kk.0, &kk.1)).is_some_and(|t| t.ver() >= *v)
    }
}

/// List the indexer's objects and read every manifest body: the durable state, independent of any in-memory index.
/// Objects the indexer reports blocked are in `Index::blocked`, not in `objs`.
pub async fn fetch_index(sdk: &Sdk, opts: &Opts) -> Res<Index> {
    let (latest, blocked) = match opts.listing {
        Listing::Current => list_current(sdk, opts).await?,
        // the feed leaves blocked objects out without a trace (and misses unpublished pins): demonstration only
        Listing::Feed => (list_feed(sdk, opts).await?, Vec::new()),
    };
    index_listed(sdk, opts, latest, blocked).await
}

/// Every current object, page by page in ID order (keyset pagination over the indexer's object table), and the IDs of
/// the objects listed as blocked (PATCH U1-B). The listing ends only at an empty page: a page shorter than asked (a
/// server with a lower page cap) or made only of blocked entries is not the end. The next page starts after the last
/// entry, blocked or not; the SDK has checked that every page is in order and well formed.
async fn list_current(sdk: &Sdk, opts: &Opts) -> Res<(HashMap<String, Option<Object>>, Vec<String>)> {
    let mut latest: HashMap<String, Option<Object>> = HashMap::new();
    let mut blocked = Vec::new();
    let mut after = None;
    loop {
        let page = tokio::time::timeout(opts.meta_timeout, sdk.current_objects(after, Some(500)))
            .await
            .map_err(|_| format!("object listing: no answer within {:?}", opts.meta_timeout))?
            .map_err(|e| {
                let e = e2s(e);
                if e.contains("404") {
                    "the indexer has no consistent object listing (GET /current/objects, indexd patch U1); a feed listing can miss acknowledged pins, so this replica is not loaded".to_string()
                } else {
                    e
                }
            })?;
        for e in &page {
            if e.blocked {
                blocked.push(e.id.to_string());
            } else {
                latest.insert(e.id.to_string(), e.object.clone());
            }
        }
        match page.last() {
            Some(last) => after = Some(last.id),
            None => break,
        }
    }
    Ok((latest, blocked))
}

/// The event feed (indexd 0.6.0's only listing): misses objects whose latest event is unpublished.
async fn list_feed(sdk: &Sdk, opts: &Opts) -> Res<HashMap<String, Option<Object>>> {
    let mut latest: HashMap<String, Option<Object>> = HashMap::new();
    let mut cursor: Option<ObjectsCursor> = None;
    loop {
        let evs = tokio::time::timeout(opts.meta_timeout, sdk.object_events(cursor.take(), Some(500)))
            .await
            .map_err(|_| format!("object feed: no answer within {:?}", opts.meta_timeout))?
            .map_err(e2s)?;
        if evs.is_empty() {
            break;
        }
        for e in &evs {
            latest.insert(e.id.to_string(), if e.deleted { None } else { e.object.clone() });
        }
        let last = evs.last().unwrap();
        cursor = Some(ObjectsCursor { id: last.id, after: last.updated_at });
        if evs.len() < 500 {
            break;
        }
    }
    Ok(latest)
}

async fn index_listed(sdk: &Sdk, opts: &Opts, latest: HashMap<String, Option<Object>>, blocked: Vec<String>) -> Res<Index> {
    let mut objs = HashMap::new();
    for (id, obj) in latest {
        let Some(obj) = obj else { continue };
        match serde_json::from_slice::<Meta>(&obj.metadata) {
            Ok(m) if m.v == 1 || m.v == 2 || m.v == 3 => {
                objs.insert(id, (obj, m));
            }
            Ok(_) => {}
            Err(_) if unreadable_record(&obj.metadata) => {
                // a membership record (from a newer version?) that cannot be read: what this replica was admitted
                // to, or sealed against, is unknown. It stays unloaded rather than be counted wrongly.
                return Err(format!("membership record {id} cannot be read by this version"));
            }
            Err(_) => {}
        }
    }
    // manifest and ledger bodies, eight downloads at a time
    // PATCH C2: tentative manifests and ledgers are not read (nothing takes them)
    let wanted: Vec<(String, Object, Meta)> = objs
        .iter()
        .filter(|(_, (_, m))| m.mf.as_ref().is_some_and(|mf| !is_tentative(&mf.i)) || (m.lg.is_some() && !m.z))
        .map(|(id, (o, m))| (id.clone(), o.clone(), m.clone()))
        .collect();
    let mut manifests = HashMap::new();
    let mut ledgers = HashMap::new();
    for chunk in wanted.chunks(8) {
        let read = crate::replica::join_all(
            chunk
                .iter()
                .map(|(id, o, m)| async move {
                    let r = match (&m.mf, &m.lg) {
                        (Some(mf), _) => read_body(sdk, o, mf.n, &mf.z, MAX_MANIFEST, opts.upload_timeout).await.and_then(|raw| parse_manifest(&raw, mf)).map(Ok),
                        (None, Some(lg)) => read_body(sdk, o, lg.n, &lg.z, MAX_LEDGER, opts.upload_timeout).await.and_then(|raw| parse_ledger(&raw, lg)).map(Err),
                        (None, None) => unreachable!(),
                    };
                    (id.clone(), r)
                })
                .collect(),
        )
        .await;
        for (id, r) in read {
            match r {
                Ok(Ok(man)) => {
                    manifests.insert(id, man);
                }
                Ok(Err(lg)) => {
                    ledgers.insert(id, lg);
                }
                Err(e) => eprintln!("[sia-s3] object {id}: {e}"),
            }
        }
    }
    let mut idx = build_index(objs, manifests, ledgers);
    if !blocked.is_empty() {
        // PATCH U1-B: never attached (replica.rs, "Blocked objects"); nothing in it may be swept: objects only a
        // blocked one references look unreferenced
        idx.orphans.clear();
        idx.blocked = blocked;
        return Ok(idx);
    }
    if !idx.unread_ledgers.is_empty() {
        // a ledger's floors are what keeps deleted keys deleted: without them this replica would serve versions
        // they hide. It stays unloaded (and is retried) rather than risk that.
        return Err(format!("{} ledger(s) could not be read", idx.unread_ledgers.len()));
    }
    let blocking = idx.blocking_unresolved();
    if !blocking.is_empty() {
        // a manifest body is read from Sia hosts, not the indexer: a host outage at load is no indexer fault. Loaded
        // without it, this replica would count toward the boot quorum while missing (possibly acknowledged) newest
        // versions, serve older ones, and let maintenance delete data objects only that manifest names. Like an
        // unread ledger, it stays unloaded and is retried; the replicas that can read theirs serve.
        return Err(format!("{} manifest(s) of live key versions could not be read", blocking.len()));
    }
    Ok(idx)
}

/// PATCH U1-B: why a replica whose listing has `n` blocked objects is not used. Public (status page): no key names.
pub fn blocked_error(n: usize) -> String {
    format!(
        "AdminBlocked: the indexer lists {n} object(s) of this account as blocked by its operator, with their metadata withheld; this replica is not used (not read, counted, repaired or written) and the key versions it cannot vouch for are withheld on every replica"
    )
}

/// Is this metadata (which did not parse as `Meta`) a membership record all the same?
fn unreadable_record(raw: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(raw).is_ok_and(|v| v.get("ms").is_some())
}

/// Download an object's whole body, refusing one whose size disagrees with its signed metadata.
async fn read_body(sdk: &Sdk, obj: &Object, n: u64, z: &str, max: u64, deadline: Duration) -> Res<Vec<u8>> {
    if n > max || n != obj.size() {
        return Err("body size does not match its metadata".into());
    }
    let raw = tokio::time::timeout(deadline, async {
        let mut rd = sdk.download(obj, DownloadOptions { max_buffered_chunks: Some(2), ..Default::default() }).map_err(e2s)?;
        let mut raw = Vec::with_capacity(n as usize);
        (&mut rd).take(max + 1).read_to_end(&mut raw).await.map_err(e2s)?;
        Ok::<_, String>(raw)
    })
    .await
    .map_err(|_| "download timed out".to_string())??;
    if raw.len() as u64 != n || sha256_hex(&raw) != z {
        return Err("body does not match its metadata".into());
    }
    Ok(raw)
}

/// Read and check a ledger body against its signed metadata.
pub fn parse_ledger(raw: &[u8], lg: &LgRef) -> Res<Ledger> {
    if raw.len() as u64 != lg.n || sha256_hex(raw) != lg.z {
        return Err("ledger body does not match its metadata".into());
    }
    let l: Ledger = serde_json::from_slice(raw).map_err(|e| format!("ledger: {e}"))?;
    if l.v != 1 || l.f.len() as u64 != lg.c {
        return Err("ledger version or count does not match".into());
    }
    Ok(l)
}

impl Store {
    /// Rebuild the index from the indexer's object feed.
    pub async fn load(sdk: Sdk, compact_max_object: u64) -> Res<Store> {
        Self::load_with(sdk, compact_max_object, Opts::default()).await
    }

    /// Load a replica. A listing with blocked objects is refused (fail closed): only `Cluster::load` takes one, to
    /// withhold what it may hide (replica.rs, "Blocked objects").
    pub async fn load_with(sdk: Sdk, compact_max_object: u64, opts: Opts) -> Res<Store> {
        let mut s = Self::load_listing(sdk, compact_max_object, opts).await?;
        let n = s.idx.get_mut().blocked.len();
        if n > 0 {
            return Err(blocked_error(n));
        }
        Ok(s)
    }

    /// Load a replica's listing, blocked objects included (`Index::blocked`).
    pub async fn load_listing(sdk: Sdk, compact_max_object: u64, opts: Opts) -> Res<Store> {
        let listed_ms = now_ms();
        let idx = fetch_index(&sdk, &opts).await?;
        Ok(Store {
            sdk,
            idx: Mutex::new(idx),
            stats: Default::default(),
            compact_max_object,
            opts,
            listed_ms,
            ambiguous_ms: Cell::new(0),
            changes: Cell::new(0),
            retired: Cell::new(false),
            inflight: Cell::new(0),
        })
    }

    /// This store has been replaced (see `retired`). Irreversible.
    pub fn retire(&self) {
        self.retired.set(true);
    }

    pub fn is_retired(&self) -> bool {
        self.retired.get()
    }

    /// Remote calls sent through this store and not yet answered.
    pub fn in_flight(&self) -> u32 {
        self.inflight.get()
    }

    /// Has a remote change had an unknown outcome since the listing behind the index began?
    pub fn dirty(&self) -> bool {
        self.ambiguous_ms.get() >= self.listed_ms
    }

    pub fn mark_ambiguous(&self) {
        self.ambiguous_ms.set(self.ambiguous_ms.get().max(now_ms()));
    }

    fn upload_opts(&self) -> UploadOptions {
        UploadOptions { data_shards: self.opts.shards.0, parity_shards: self.opts.shards.1, max_buffered_slabs: Some(1), ..Default::default() }
    }

    /// One indexer call that changes durable state. Its outcome is unknown when it errs or does not answer in time:
    /// the indexer may have applied it, or may still. Every pin and delete goes through here.
    ///
    /// On a retired store the call is refused before `fut` is polled: the SDK's calls are `async fn`s, so nothing has
    /// been sent, and the outcome is known (nothing happened). Error text never carries the SDK's signed request URLs.
    async fn remote<T, E: std::fmt::Display>(&self, what: &str, fut: impl Future<Output = Result<T, E>>) -> Res<T> {
        if self.retired.get() {
            return Err(format!("{what}: {RETIRED}"));
        }
        let mut flight = InFlight::new(self);
        let r = tokio::time::timeout(self.opts.meta_timeout, fut).await;
        flight.answered = true;
        drop(flight);
        match r {
            Ok(Ok(v)) => {
                self.changes.set(self.changes.get() + 1);
                Ok(v)
            }
            Ok(Err(e)) => {
                let e = redact(&e.to_string());
                // a fenced refusal is a known outcome: the indexer applied nothing (writer fencing); so is a C2 refusal
                // (another head or operation, or a client forked for good), but not a C2 outcome still unresolved
                let c2_definite = e.contains("c2: ") && !e.contains("c2: unresolved");
                if !e.contains("Fenced(") && !e.contains("fenced: the indexer holds fence") && !c2_definite {
                    self.mark_ambiguous();
                }
                Err(format!("{what}: {e}"))
            }
            Err(_) => {
                self.mark_ambiguous();
                Err(format!("{what}: no answer within {:?}", self.opts.meta_timeout))
            }
        }
    }

    async fn pin_with(&self, obj: &mut Object, meta: Meta) -> Res<Meta> {
        let meta = meta.normalized();
        obj.metadata = meta_bytes(&meta)?;
        self.remote("pin", self.sdk.pin_object(obj)).await?;
        Ok(meta)
    }

    async fn delete(&self, obj: &Object) -> Res<()> {
        self.remote("delete", self.sdk.delete_object(&obj.id())).await
    }

    /// PATCH C2: one object's pin in a replicated write. Without a gate (unfenced mode, or maintenance that only
    /// rewrites committed state): `committed`, once. With a gate: phase 1 pins `tentative` and reports it; phase 2 pins
    /// `committed` only once the gate opens (W voters have phase 1). Returns the metadata now pinned.
    async fn pin_gated(&self, obj: &mut Object, tentative: Meta, committed: Meta, gate: &Option<GateRef>) -> Res<Meta> {
        let Some(g) = gate else {
            return self.pin_with(obj, committed).await;
        };
        let r = self.pin_with(obj, tentative).await;
        g.phase1(r.is_ok());
        r?;
        if !g.gate.wait().await {
            return Err(NOT_COMMITTED.into());
        }
        self.pin_with(obj, committed).await
    }

    /// PATCH C2: remove what writes left tentative (their phase 2 never ran) from the objects this replica's last listing
    /// found: such content was never acknowledged and no reader takes it. Objects left serving nothing go. Never touches
    /// a write of this process in progress (the listing holds none: replica.rs, "C2"). Stops at the first failure.
    pub async fn abort_tentative(&self) -> Res<usize> {
        let mut idx = self.idx.lock().await;
        let todo = std::mem::take(&mut idx.tentative);
        let none: KK = (String::new(), String::new());
        let mut n = 0;
        for (k, id) in todo.iter().enumerate() {
            let Some((obj, meta)) = idx.objs.get(id).cloned() else { continue };
            let clean = meta.without_tentative();
            if clean == meta {
                continue;
            }
            let r = if clean.purposeful() || idx.referenced_elsewhere(id, &none) {
                let mut o = obj.clone();
                self.pin_with(&mut o, clean).await.map(|m| {
                    idx.objs.insert(id.clone(), (o, m));
                })
            } else {
                self.delete(&obj).await.map(|_| {
                    idx.objs.remove(id);
                })
            };
            if let Err(e) = r {
                idx.tentative.extend(todo[k..].iter().cloned());
                return Err(e);
            }
            n += 1;
        }
        Ok(n)
    }

    pub async fn upload(&self, body: Rc<[u8]>) -> Res<Object> {
        // the indexer refuses slab-less objects: an empty body is stored as one
        // placeholder byte and served as empty (the entry's size is 0)
        let data: Rc<[u8]> = if body.is_empty() { Rc::from(&[0u8][..]) } else { body };
        self.upload_reader(Cursor::new(data)).await
    }

    /// Upload a body streamed from `reader`. Nothing is pinned as an object until a commit, so an upload that fails or
    /// is abandoned leaves only slabs, which `prune_slabs` reclaims.
    pub async fn upload_reader<R: tokio::io::AsyncRead + Unpin + 'static>(&self, reader: R) -> Res<Object> {
        tokio::time::timeout(self.opts.upload_timeout, self.sdk.upload(Object::default(), reader, self.upload_opts()))
            .await
            .map_err(|_| format!("upload: no completion within {:?}", self.opts.upload_timeout))?
            .map_err(e2s)
    }

    async fn upload_manifest(&self, man: &Manifest) -> Res<(Object, u64, String)> {
        let raw = serde_json::to_vec(man).map_err(e2s)?;
        if raw.len() as u64 > MAX_MANIFEST {
            return Err(format!("EntityTooLarge: the key's manifest would be {} bytes, above {MAX_MANIFEST}", raw.len()));
        }
        let z = sha256_hex(&raw);
        let n = raw.len() as u64;
        Ok((self.upload(raw.into()).await?, n, z))
    }

    async fn pin_manifest(&self, mobj: &mut Object, e: &Entry, n: u64, z: String, gate: &Option<GateRef>) -> Res<Meta> {
        let mf = |e: &Entry| MfRef { q: qkey(&e.b, &e.k), h: e.h, i: e.i.clone(), m: e.m, n, z: z.clone() };
        let tentative = Meta { p: true, mf: Some(mf(&e.tentative())), ..Default::default() };
        let committed = Meta { p: true, mf: Some(mf(e)), ..Default::default() };
        self.pin_gated(mobj, tentative, committed, gate).await
    }

    /// Remove a key's entry from its host object (remote first), deleting objects
    /// left serving nothing. The caller removes the key from `idx.keys` after.
    async fn detach(&self, idx: &mut Index, kk: &KK) -> Res<()> {
        let Some(key) = idx.keys.get(kk) else { return Ok(()) };
        let (host, entry, manifest) = (key.host.clone(), key.entry.clone(), key.manifest);
        let Some((obj, meta)) = idx.objs.get(&host).cloned() else { return Ok(()) };
        let mut nm = meta.clone();
        if manifest {
            nm.mf = None;
        } else {
            nm.e.retain(|e| !(e.b == entry.b && e.k == entry.k));
        }
        if nm.purposeful() || idx.referenced_elsewhere(&host, kk) {
            let mut o = obj.clone();
            let nm = self.pin_with(&mut o, nm).await?;
            idx.objs.insert(host.clone(), (o, nm));
        } else {
            self.delete(&obj).await?;
            idx.objs.remove(&host);
        }
        self.drop_parts(idx, &entry.x, kk).await;
        Ok(())
    }

    /// Delete a removed key's parts that nothing else uses.
    async fn drop_parts(&self, idx: &mut Index, parts: &[String], kk: &KK) {
        for x in parts {
            if idx.referenced_elsewhere(x, kk) {
                continue;
            }
            let Some((o, m)) = idx.objs.get(x).cloned() else { continue };
            if !m.e.is_empty() || !m.d.is_empty() || m.mf.is_some() {
                continue;
            }
            match self.delete(&o).await {
                Ok(()) => {
                    idx.objs.remove(x);
                }
                Err(e) => eprintln!("[sia-s3] {}/{}: part {x} left behind: {e}", kk.0, kk.1),
            }
        }
    }

    /// Decide how a new single-object version is stored here: inline on its data object, or (when the entry does not
    /// fit) behind a manifest, uploaded now, outside any lock.
    pub async fn stage_put(&self, data: &Object, proto: &Entry) -> Res<Placement> {
        let inline = Meta { p: true, e: vec![stamped(proto)], ..Default::default() };
        if fits(&inline) {
            return Ok(Placement::Inline);
        }
        let x = vec![data.id().to_string()];
        let (obj, n, z) = self.upload_manifest(&manifest_of(proto, x.clone())).await?;
        Ok(Placement::Manifest { obj, n, z, x })
    }

    /// Make an uploaded object the key's content at `entry`'s version: pin it (and its manifest), then replace the
    /// key's older entry. Ok(false) when this replica already holds that version or a newer one, or a newer
    /// tombstone. The caller (replica.rs) has already checked any condition against the merged view.
    /// PATCH C2: with a gate, the entry (or its manifest) is pinned tentative first and committed only once the gate
    /// opens; the older entry is detached only after that (destructive steps follow committed state).
    pub async fn commit_put(&self, mut data: Object, placement: Placement, mut entry: Entry, packed: bool, gate: Option<GateRef>) -> Res<bool> {
        entry.x.clear();
        let kk = (entry.b.clone(), entry.k.clone());
        if self.idx.lock().await.superseded(&kk, &entry.ver()) {
            return Ok(false); // nothing was pinned: the upload's slabs are pruned
        }
        let mut pinned = Vec::new();
        let (host, manifest) = match placement {
            Placement::Inline => {
                let tentative = Meta { p: packed, e: vec![entry.tentative()], ..Default::default() };
                let committed = Meta { p: packed, e: vec![entry.clone()], ..Default::default() };
                let meta = self.pin_gated(&mut data, tentative, committed, &gate).await?;
                let id = data.id().to_string();
                pinned.push((id.clone(), data, meta));
                (id, false)
            }
            Placement::Manifest { obj: mut mobj, n, z, x } => {
                let dmeta = self.pin_with(&mut data, Meta { p: packed, ..Default::default() }).await?;
                pinned.push((data.id().to_string(), data, dmeta));
                let mmeta = self.pin_manifest(&mut mobj, &entry, n, z, &gate).await?;
                let id = mobj.id().to_string();
                pinned.push((id.clone(), mobj, mmeta));
                entry.x = x;
                (id, true)
            }
        };
        let mut idx = self.idx.lock().await;
        // the new object is pinned and authoritative (newest version) even if the
        // old entry cannot be removed now; a stale entry loses at the next load
        if let Err(e) = self.detach(&mut idx, &kk).await {
            eprintln!("[sia-s3] put {}/{}: old entry left behind: {e}", kk.0, kk.1);
        }
        for (id, o, m) in pinned {
            idx.objs.insert(id, (o, m));
        }
        idx.keys.insert(kk, Key { host, entry, manifest });
        Ok(true)
    }

    /// Stage CopyObject here: inline on the source's host when the source is inline and the entry fits there, else
    /// a manifest over the source's data objects (uploaded now). Ok(None) when this replica does not hold the source
    /// at `src_ver` (it is behind; repair brings it up).
    /// PATCH C2 (`c2`): always a manifest, never an entry beside the source's (a tentative entry there would have to fit
    /// next to the destination's current one).
    pub async fn stage_copy(&self, src: &KK, src_ver: &Ver, proto: &Entry, c2: bool) -> Res<Option<Placement>> {
        let (inline, x) = {
            let idx = self.idx.lock().await;
            let Some(k) = idx.keys.get(src).filter(|k| k.entry.ver() == *src_ver) else { return Ok(None) };
            let inline = !c2
                && !k.manifest
                && idx.objs.get(&k.host).is_some_and(|(_, meta)| {
                    let mut nm = meta.clone();
                    nm.e.retain(|e| !(e.b == proto.b && e.k == proto.k));
                    nm.e.push(Entry { x: k.entry.x.clone(), ..stamped(proto) });
                    nm.p = true;
                    fits(&nm)
                });
            (inline, k.data())
        };
        if inline {
            return Ok(Some(Placement::Inline));
        }
        let (obj, n, z) = self.upload_manifest(&manifest_of(proto, x.clone())).await?;
        Ok(Some(Placement::Manifest { obj, n, z, x }))
    }

    /// CopyObject on this replica: `entry` (stamped by the caller) is served by the source's objects. Ok(false) when
    /// the source is no longer at `src_ver` or no longer where the staged placement assumed.
    pub async fn commit_copy(&self, src: &KK, src_ver: &Ver, mut entry: Entry, placement: Placement, gate: Option<GateRef>) -> Res<bool> {
        let mut idx = self.idx.lock().await;
        let dkk = (entry.b.clone(), entry.k.clone());
        let Some((host, sx, smanifest, sdata)) =
            idx.keys.get(src).filter(|k| k.entry.ver() == *src_ver).map(|k| (k.host.clone(), k.entry.x.clone(), k.manifest, k.data()))
        else {
            return Ok(false);
        };
        if idx.superseded(&dkk, &entry.ver()) {
            return Ok(false);
        }
        match placement {
            Placement::Inline => {
                if smanifest || gate.is_some() {
                    return Ok(false); // C2 copies are staged as manifests
                }
                // the destination's current entry goes first: it may live on this same host
                if idx.keys.contains_key(&dkk) {
                    self.detach(&mut idx, &dkk).await?;
                    idx.keys.remove(&dkk);
                }
                let (obj, meta) = idx.objs.get(&host).cloned().ok_or("source object missing from the index")?;
                entry.x = sx;
                let mut nm = meta.clone();
                nm.e.retain(|e| !(e.b == entry.b && e.k == entry.k));
                nm.e.push(entry.clone());
                let mut o = obj.clone();
                let nm = self.pin_with(&mut o, nm).await?;
                idx.objs.insert(host.clone(), (o, nm));
                idx.keys.insert(dkk, Key { host, entry, manifest: false });
            }
            Placement::Manifest { obj: mut mobj, n, z, x } => {
                if sdata != x {
                    return Ok(false); // the source's objects moved (compaction) since the manifest was written
                }
                let mmeta = self.pin_manifest(&mut mobj, &entry, n, z, &gate).await?;
                if let Err(e) = self.detach(&mut idx, &dkk).await {
                    eprintln!("[sia-s3] copy to {}/{}: old entry left behind: {e}", dkk.0, dkk.1);
                }
                let id = mobj.id().to_string();
                idx.objs.insert(id.clone(), (mobj, mmeta));
                entry.x = x;
                idx.keys.insert(dkk, Key { host: id, entry, manifest: true });
            }
        }
        Ok(true)
    }

    /// Record a replicated DELETE: the key's live entry (older than `t`) becomes tombstone `t` in its host object's
    /// metadata, in one pin, and the key's other parts go. Ok(true) when a tombstone was recorded here, Ok(false)
    /// when this index holds no live version of the key.
    ///
    /// PATCH C2: with a gate, phase 1 adds the tombstone tentative and KEEPS the entry; phase 2 commits the tombstone
    /// and removes the entry in one pin (or, with no room, in a carrier object, then the entry is detached).
    pub async fn tombstone(&self, kk: &KK, t: &Tomb, gate: Option<GateRef>) -> Res<bool> {
        let mut idx = self.idx.lock().await;
        let Some(key) = idx.keys.get(kk) else { return Ok(false) };
        if key.entry.ver() >= t.ver() {
            return Err("the replica holds a version newer than the deletion".into());
        }
        let (host, entry, manifest) = (key.host.clone(), key.entry.clone(), key.manifest);
        let (obj, meta) = idx.objs.get(&host).cloned().ok_or("host object missing from the index")?;
        let mut nm = meta.clone();
        if manifest {
            nm.mf = None;
        } else {
            nm.e.retain(|e| !(e.b == entry.b && e.k == entry.k));
        }
        nm.d.retain(|d| d.q != t.q);
        nm.d.push(t.clone());
        let mut tm = meta.clone();
        tm.d.push(t.tentative());
        let carrier = if fits(&nm) && (gate.is_none() || fits(&tm)) {
            let mut o = obj.clone();
            let nm = self.pin_gated(&mut o, tm, nm, &gate).await?;
            idx.objs.insert(host.clone(), (o, nm));
            host.clone()
        } else {
            // no room beside the host's other entries: the tombstone gets an object of its own, then the entry goes
            let mut c = self.upload(Rc::from(&[0u8][..])).await?;
            let tentative = Meta { p: true, d: vec![t.tentative()], ..Default::default() };
            let cm = self.pin_gated(&mut c, tentative, Meta { p: true, d: vec![t.clone()], ..Default::default() }, &gate).await?;
            let id = c.id().to_string();
            idx.objs.insert(id.clone(), (c, cm));
            if let Err(e) = self.detach(&mut idx, kk).await {
                eprintln!("[sia-s3] delete {}/{}: entry left behind (hidden by its tombstone): {e}", kk.0, kk.1);
            }
            id
        };
        idx.keys.remove(kk);
        let held = idx.tombs.entry(t.q.clone()).or_default();
        held.retain(|(id, _)| *id != carrier);
        held.push((carrier, t.clone()));
        self.drop_parts(&mut idx, &entry.x, kk).await;
        Ok(true)
    }

    /// PATCH C2: a replicated DELETE here, as one gated write: a tombstone when this replica holds an older version of
    /// the key, else a floor in a new ledger. Ok(true) once the deletion is committed here.
    pub async fn record_deletion(&self, kk: &KK, t: &Tomb, gate: GateRef) -> Res<bool> {
        let (held, recorded) = {
            let idx = self.idx.lock().await;
            (idx.keys.get(kk).map(|k| k.entry.ver()), idx.tomb(&t.q).is_some_and(|x| x.ver() >= t.ver()))
        };
        match held {
            Some(v) if v >= t.ver() => Err("the replica holds a version newer than the deletion".into()),
            Some(_) => self.tombstone(kk, t, Some(gate)).await,
            None if recorded => {
                gate.already_durable();
                Ok(true)
            }
            None => self.write_ledger(vec![t.clone()], Some(gate)).await.map(|_| true),
        }
    }

    /// Collect this replica's tombstones for key hash `q` for which `keep` is false, deleting objects left serving
    /// nothing. Stops at the first failure.
    pub async fn drop_tombs(&self, q: &str, keep: impl Fn(&Tomb) -> bool) -> Res<usize> {
        let mut idx = self.idx.lock().await;
        let Some(held) = idx.tombs.get(q).cloned() else { return Ok(0) };
        let none: KK = (String::new(), String::new());
        let mut dropped = 0;
        for (id, t) in held.iter().filter(|(_, t)| !keep(t)) {
            let Some((obj, meta)) = idx.objs.get(id).cloned() else { continue };
            let mut nm = meta.clone();
            nm.d.retain(|d| d != t);
            if nm.purposeful() || idx.referenced_elsewhere(id, &none) {
                let mut o = obj.clone();
                let nm = self.pin_with(&mut o, nm).await?;
                idx.objs.insert(id.clone(), (o, nm));
            } else {
                self.delete(&obj).await?;
                idx.objs.remove(id);
            }
            if let Some(v) = idx.tombs.get_mut(q) {
                v.retain(|(i, d)| !(i == id && d == t));
            }
            dropped += 1;
        }
        if idx.tombs.get(q).is_some_and(|v| v.is_empty()) {
            idx.tombs.remove(q);
        }
        Ok(dropped)
    }

    /// Remove dead versions this index knows of: entries and manifests older than the key's live version or
    /// tombstone on this replica (a superseded duplicate, or a write that landed after its DELETE). Until they go, a
    /// key's tombstones cannot be collected. At most `cap` objects per call; stops at the first failure.
    pub async fn purge_dead(&self, cap: usize) -> Res<usize> {
        let mut idx = self.idx.lock().await;
        // keys a floor pinned since the load has made dead stop being served first
        let dead_keys: Vec<KK> =
            idx.keys.iter().filter(|(kk, k)| idx.tomb(&qkey(&kk.0, &kk.1)).is_some_and(|t| t.ver() > k.entry.ver())).map(|(kk, _)| kk.clone()).collect();
        for kk in dead_keys {
            idx.keys.remove(&kk);
        }
        let live_by_q: HashMap<String, Ver> = idx.keys.iter().map(|(kk, k)| (qkey(&kk.0, &kk.1), k.entry.ver())).collect();
        // equal versions on two objects are compaction leftovers, left to the orphan sweep
        let dead = |q: &str, v: &Ver| live_by_q.get(q).is_some_and(|lv| *lv > *v) || idx.tomb(q).is_some_and(|t| t.ver() > *v);
        let mut todo: Vec<(String, Meta, Vec<String>)> = Vec::new();
        for (id, (_, m)) in &idx.objs {
            let mut nm = m.clone();
            let mut parts = Vec::new();
            nm.e.retain(|e| {
                let d = dead(&qkey(&e.b, &e.k), &e.ver());
                if d {
                    parts.extend(e.x.iter().cloned());
                }
                !d
            });
            if let Some(mf) = &m.mf {
                if dead(&mf.q, &mf.ver()) {
                    parts.extend(idx.manifests.get(id).map(|man| man.x.clone()).unwrap_or_default());
                    nm.mf = None;
                }
            }
            if nm != *m {
                todo.push((id.clone(), nm, parts));
            }
            if todo.len() >= cap {
                break;
            }
        }
        let none: KK = (String::new(), String::new());
        let mut done = 0;
        for (id, nm, parts) in todo {
            let Some((obj, _)) = idx.objs.get(&id).cloned() else { continue };
            let manifest_gone = nm.mf.is_none();
            if nm.purposeful() || idx.referenced_elsewhere(&id, &none) {
                let mut o = obj.clone();
                let nm = self.pin_with(&mut o, nm).await?;
                idx.objs.insert(id.clone(), (o, nm));
            } else {
                self.delete(&obj).await?;
                idx.objs.remove(&id);
            }
            if manifest_gone {
                // a dead manifest whose body was unreadable no longer holds the orphan sweep back
                idx.unresolved.retain(|u| *u != id);
            }
            self.drop_parts(&mut idx, &parts, &none).await;
            done += 1;
        }
        Ok(done)
    }

    /// Record deletion floors durably here: one new ledger object listing `floors`. Nothing else is touched.
    /// PATCH C2: with a gate (a DELETE's floor), the ledger is pinned tentative first and committed once the gate opens;
    /// maintenance passes none (its floors only restate committed deletions).
    pub async fn write_ledger(&self, floors: Vec<Tomb>, gate: Option<GateRef>) -> Res<()> {
        if floors.is_empty() {
            return Ok(());
        }
        let body = serde_json::to_vec(&Ledger { v: 1, f: floors.clone() }).map_err(e2s)?;
        if body.len() as u64 > MAX_LEDGER {
            return Err("ledger body too large".into());
        }
        let lg = LgRef { n: body.len() as u64, z: sha256_hex(&body), c: floors.len() as u64 };
        let mut obj = self.upload(body.into()).await?;
        let tentative = Meta { p: true, lg: Some(lg.clone()), z: true, ..Default::default() };
        let meta = self.pin_gated(&mut obj, tentative, Meta { p: true, lg: Some(lg), ..Default::default() }, &gate).await?;
        let id = obj.id().to_string();
        let mut idx = self.idx.lock().await;
        idx.objs.insert(id.clone(), (obj, meta));
        idx.ledgers.push(id);
        for f in floors {
            if idx.floors.get(&f.q).is_none_or(|c| f.ver() > c.ver()) {
                idx.floors.insert(f.q.clone(), f);
            }
        }
        Ok(())
    }

    /// Upload the one-byte body of a future membership record (nothing is pinned: an unused one leaves only slabs,
    /// which `prune_slabs` reclaims).
    pub async fn upload_record(&self) -> Res<Object> {
        self.upload(Rc::from(&[0u8][..])).await
    }

    /// Record a membership statement durably here: pin an uploaded record body with the record as its metadata.
    /// PATCH C2: with a gate (seals), tentative first and committed once the gate opens.
    pub async fn pin_record(&self, mut obj: Object, rec: MsRec, gate: Option<GateRef>) -> Res<()> {
        let tentative = Meta { p: true, ms: Some(rec.clone()), z: true, ..Default::default() };
        let meta = self.pin_gated(&mut obj, tentative, Meta { p: true, ms: Some(rec.clone()), ..Default::default() }, &gate).await?;
        let id = obj.id().to_string();
        let mut idx = self.idx.lock().await;
        idx.objs.insert(id.clone(), (obj, meta));
        idx.records.push((id, rec));
        Ok(())
    }

    /// The highest version-range ceiling this replica holds (0: none).
    pub async fn ceiling(&self) -> u64 {
        self.idx.lock().await.ceiling
    }

    /// Record version-range ceiling `c` durably here: a NEW object (a 1-byte body, the ceiling in its signed metadata),
    /// never an in-place update, because a late pin of an older reservation must not be able to lower what this
    /// replica holds. Once it is pinned, this replica's lower ceiling objects are redundant and are deleted (best
    /// effort: a leftover only costs an object). Ok when `c` is pinned here.
    pub async fn write_ceiling(&self, c: u64) -> Res<()> {
        let mut obj = self.upload(Rc::from(&[0u8][..])).await?;
        let meta = self.pin_with(&mut obj, Meta { p: true, ck: Some(c), ..Default::default() }).await?;
        let id = obj.id().to_string();
        let mut idx = self.idx.lock().await;
        idx.objs.insert(id.clone(), (obj, meta));
        idx.ceilings.push((id, c));
        idx.ceiling = idx.ceiling.max(c);
        let top = idx.ceiling;
        let lower: Vec<String> = idx.ceilings.iter().filter(|(_, v)| *v < top).map(|(i, _)| i.clone()).collect();
        for old in lower {
            let Some((o, _)) = idx.objs.get(&old).cloned() else { continue };
            match self.delete(&o).await {
                Ok(()) => {
                    idx.objs.remove(&old);
                    idx.ceilings.retain(|(i, _)| *i != old);
                }
                Err(e) => {
                    eprintln!("[sia-s3] ceiling object {old} left behind: {e}");
                    break;
                }
            }
        }
        Ok(())
    }

    /// With more than a few ledgers (and every one read), write one listing every floor, then delete the others.
    /// Returns how many were merged away. A floor is never dropped: the new ledger is pinned first, and holds all.
    pub async fn merge_ledgers(&self) -> Res<usize> {
        let (old, floors) = {
            let idx = self.idx.lock().await;
            if idx.ledgers.len() < MERGE_LEDGERS_AT || !idx.floors_complete() {
                return Ok(0);
            }
            (idx.ledgers.clone(), idx.floors.values().cloned().collect::<Vec<_>>())
        };
        self.write_ledger(floors, None).await?;
        let mut merged = 0;
        for id in old {
            let obj = self.idx.lock().await.objs.get(&id).map(|(o, _)| o.clone());
            let Some(obj) = obj else { continue };
            self.delete(&obj).await?;
            let mut idx = self.idx.lock().await;
            idx.objs.remove(&id);
            idx.ledgers.retain(|l| *l != id);
            merged += 1;
        }
        Ok(merged)
    }

    /// Reclaim what tombstones hold once a ledger floor covers them here: the tombstone leaves its object, and the
    /// object goes when nothing else needs it. Stops at the first failure.
    pub async fn reclaim_covered(&self) -> Res<usize> {
        let covered: Vec<(String, Tomb)> = {
            let idx = self.idx.lock().await;
            idx.tombs
                .iter()
                .filter_map(|(q, ts)| idx.floors.get(q).map(|f| (q.clone(), f.clone(), ts)))
                .filter(|(_, f, ts)| ts.iter().any(|(_, t)| t.ver() <= f.ver()))
                .map(|(q, f, _)| (q, f))
                .collect()
        };
        let mut n = 0;
        for (q, floor) in covered {
            n += self.drop_tombs(&q, |t| t.ver() > floor.ver()).await?;
        }
        Ok(n)
    }

    /// Know multipart upload `uid` on this replica (a no-op when it is known already).
    pub async fn ensure_upload(&self, uid: &str, b: &str, k: &str, started: i64) {
        self.idx
            .lock()
            .await
            .uploads
            .entry(uid.to_string())
            .or_insert_with(|| Upload { b: b.into(), k: k.into(), started, parts: BTreeMap::new() });
    }

    pub async fn upload_part(&self, uid: &str, n: u32, body: Rc<[u8]>) -> Res<String> {
        let (b, k) = {
            let idx = self.idx.lock().await;
            let u = idx.uploads.get(uid).ok_or("NoSuchUpload")?;
            (u.b.clone(), u.k.clone())
        };
        let etag = md5_hex(&body);
        let size = body.len() as u64;
        let mut obj = self.upload(body).await?;
        let meta = Meta { p: size >= self.compact_max_object, mp: Some(PartTag { u: uid.into(), b, k, n, t: etag.clone() }), ..Default::default() };
        let meta = self.pin_with(&mut obj, meta).await?;
        let id = obj.id().to_string();
        let mut idx = self.idx.lock().await;
        let old = match idx.uploads.get_mut(uid) {
            Some(u) => u.parts.insert(n, (id.clone(), etag.clone(), size)),
            None => {
                drop(idx);
                let _ = self.delete(&obj).await; // aborted meanwhile
                return Err("NoSuchUpload".into());
            }
        };
        idx.objs.insert(id, (obj, meta));
        if let Some((old_id, _, _)) = old {
            if let Some((o, _)) = idx.objs.get(&old_id).cloned() {
                if self.delete(&o).await.is_ok() {
                    idx.objs.remove(&old_id);
                }
            }
        }
        Ok(etag)
    }

    /// Make an uploaded copy of another replica's part `n` (ETag and size as that replica lists them) this
    /// replica's part `n` of upload `uid`, replacing a part `n` it held with another ETag. Ok(false) when it holds that part already.
    #[allow(clippy::too_many_arguments)]
    pub async fn adopt_part(&self, uid: &str, b: &str, k: &str, started: i64, n: u32, (etag, size): (&str, u64), mut obj: Object) -> Res<bool> {
        let mut idx = self.idx.lock().await;
        let u = idx.uploads.entry(uid.to_string()).or_insert_with(|| Upload { b: b.into(), k: k.into(), started, parts: BTreeMap::new() });
        if u.parts.get(&n).is_some_and(|p| p.1 == etag) {
            return Ok(false);
        }
        let meta = Meta { p: size >= self.compact_max_object, mp: Some(PartTag { u: uid.into(), b: b.into(), k: k.into(), n, t: etag.into() }), ..Default::default() };
        let meta = self.pin_with(&mut obj, meta).await?;
        let id = obj.id().to_string();
        let old = idx.uploads.get_mut(uid).and_then(|u| u.parts.insert(n, (id.clone(), etag.into(), size)));
        idx.objs.insert(id, (obj, meta));
        if let Some((old_id, _, _)) = old {
            if let Some((o, _)) = idx.objs.get(&old_id).cloned() {
                if self.delete(&o).await.is_ok() {
                    idx.objs.remove(&old_id);
                }
            }
        }
        Ok(true)
    }

    /// Validate a completion here and stage its placement: inline on part 1 when the entry fits, else a manifest
    /// over every part, uploaded now, outside any lock.
    pub async fn stage_complete(&self, uid: &str, want: &[(u32, String)]) -> Res<Completion> {
        let (b, k, etag, size, ids, unused, host_p) = {
            let idx = self.idx.lock().await;
            let u = idx.uploads.get(uid).ok_or("NoSuchUpload")?;
            if want.is_empty() {
                return Err("InvalidPart: no parts listed".into());
            }
            let mut ids = Vec::new();
            let mut md5s = Vec::new();
            let mut size = 0u64;
            let mut last = 0u32;
            for (n, etag) in want {
                if *n <= last {
                    return Err("InvalidPartOrder".into());
                }
                last = *n;
                let (id, t, s) = u.parts.get(n).ok_or_else(|| format!("InvalidPart: part {n} was not uploaded"))?;
                if t != etag.trim_matches('"') {
                    return Err(format!("InvalidPart: part {n} etag does not match"));
                }
                ids.push(id.clone());
                md5s.extend(hex::decode(t).map_err(e2s)?);
                size += s;
            }
            let etag = format!("{}-{}", md5_hex(&md5s), want.len());
            let unused: Vec<String> = u.parts.values().map(|p| p.0.clone()).filter(|id| !ids.contains(id)).collect();
            let host_p = idx.objs.get(&ids[0]).is_some_and(|(_, m)| m.p);
            (u.b.clone(), u.k.clone(), etag, size, ids, unused, host_p)
        };
        let proto = Entry { b: b.clone(), k: k.clone(), s: size, t: etag.clone(), m: 0, c: None, x: ids[1..].to_vec(), h: 0, i: String::new() };
        let placement = if fits(&Meta { p: host_p, e: vec![stamped(&proto)], ..Default::default() }) {
            Placement::Inline
        } else {
            let (obj, n, z) = self.upload_manifest(&manifest_of(&proto, ids.clone())).await?;
            Placement::Manifest { obj, n, z, x: ids.clone() }
        };
        Ok(Completion { b, k, etag, size, ids, unused, placement })
    }

    /// Commit a staged completion as version (`m`, `h`, `i`) of its key.
    /// PATCH C2: with a gate, inline: part 1 keeps its part tag beside a tentative entry until the gate opens; manifest:
    /// the manifest is tentative first. The older entry and unused parts go only after the commit.
    pub async fn commit_complete(&self, uid: &str, c: Completion, m: i64, h: u64, i: &str, gate: Option<GateRef>) -> Res<(String, String, String)> {
        let mut idx = self.idx.lock().await;
        let still = idx.uploads.get(uid).is_some_and(|u| c.ids.iter().all(|id| u.parts.values().any(|p| p.0 == *id)));
        if !still {
            return Err("NoSuchUpload: the upload changed while it was being completed".into());
        }
        let kk = (c.b.clone(), c.k.clone());
        let mut entry = Entry { b: c.b.clone(), k: c.k.clone(), s: c.size, t: c.etag.clone(), m, c: None, x: vec![], h, i: i.to_string() };
        if idx.superseded(&kk, &entry.ver()) {
            return Err("the replica holds a newer version".into());
        }
        let (host, manifest, pinned) = match c.placement {
            Placement::Inline => {
                let host = c.ids[0].clone();
                let (obj, meta) = idx.objs.get(&host).cloned().ok_or("part object missing from the index")?;
                entry.x = c.ids[1..].to_vec();
                let mut o = obj.clone();
                let tentative = Meta { p: meta.p, mp: meta.mp.clone(), e: vec![entry.tentative()], ..Default::default() };
                let nm = self.pin_gated(&mut o, tentative, Meta { p: meta.p, e: vec![entry.clone()], ..Default::default() }, &gate).await?;
                (host, false, (o, nm))
            }
            Placement::Manifest { obj: mut mobj, n, z, x } => {
                let nm = self.pin_manifest(&mut mobj, &entry, n, z, &gate).await?;
                entry.x = x;
                (mobj.id().to_string(), true, (mobj, nm))
            }
        };
        if idx.keys.contains_key(&kk) {
            if let Err(e) = self.detach(&mut idx, &kk).await {
                eprintln!("[sia-s3] complete {}/{}: old entry left behind: {e}", kk.0, kk.1);
            }
            idx.keys.remove(&kk);
        }
        idx.objs.insert(host.clone(), pinned);
        idx.keys.insert(kk, Key { host, entry, manifest });
        idx.uploads.remove(uid);
        for id in c.unused {
            if let Some((o, _)) = idx.objs.get(&id).cloned() {
                if self.delete(&o).await.is_ok() {
                    idx.objs.remove(&id);
                }
            }
        }
        Ok((c.b, c.k, c.etag))
    }

    pub async fn abort_upload(&self, uid: &str) -> Res<()> {
        let mut idx = self.idx.lock().await;
        let u = idx.uploads.remove(uid).ok_or("NoSuchUpload")?;
        for (id, _, _) in u.parts.values() {
            if let Some((o, _)) = idx.objs.get(id).cloned() {
                self.delete(&o).await?;
                idx.objs.remove(id);
            }
        }
        Ok(())
    }

    /// Stream `[off, off+len)` of one object into `w`.
    pub async fn read_into<W: tokio::io::AsyncWrite + Unpin>(&self, obj: &Object, off: u64, len: u64, w: &mut W) -> Res<u64> {
        if len == 0 {
            return Ok(0);
        }
        let opts = DownloadOptions { max_buffered_chunks: Some(8), offset: off, length: Some(len), ..Default::default() };
        let mut rd = self.sdk.download(obj, opts).map_err(e2s)?;
        tokio::io::copy(&mut rd, w).await.map_err(e2s)
    }

    /// Repack small keys that were uploaded alone into shared slabs.
    pub async fn compact(&self) -> Res<usize> {
        let cutoff = now() - 300;
        let cands: Vec<(String, Object, Meta)> = {
            let idx = self.idx.lock().await;
            let mut total = 0u64;
            let mut v = Vec::new();
            for (id, (obj, m)) in &idx.objs {
                let small = obj.size() <= self.compact_max_object;
                let simple = !m.p && m.mp.is_none() && m.d.is_empty() && m.mf.is_none() && !m.e.is_empty() && m.e.iter().all(|e| e.x.is_empty()) && !m.has_tentative();
                // an object a manifest names as data must stay where it is
                if small && simple && !idx.is_part(id) && obj.created_at.timestamp() < cutoff && total + obj.size() <= 64 << 20 {
                    total += obj.size();
                    v.push((id.clone(), obj.clone(), m.clone()));
                }
            }
            v
        };
        if cands.len() < 2 {
            return Ok(0);
        }
        let deadline = self.opts.upload_timeout;
        let news = tokio::time::timeout(deadline, async {
            let mut datas = Vec::with_capacity(cands.len());
            for (_, obj, _) in &cands {
                let mut rd = self.sdk.download(obj, DownloadOptions { max_buffered_chunks: Some(8), ..Default::default() }).map_err(e2s)?;
                let mut buf = Vec::with_capacity(obj.size() as usize);
                rd.read_to_end(&mut buf).await.map_err(e2s)?;
                datas.push(buf);
            }
            let mut pu = self.sdk.upload_packed(PackedUploadOptions { max_buffered_slabs: Some(1), ..Default::default() }).map_err(e2s)?;
            for d in datas {
                pu.add(Cursor::new(d)).await.map_err(e2s)?;
            }
            pu.finalize().await.map_err(e2s)
        })
        .await
        .map_err(|_| format!("compaction upload: no completion within {deadline:?}"))??;
        if news.len() != cands.len() {
            return Err(format!("packed upload returned {} objects for {}", news.len(), cands.len()));
        }

        let mut done = 0;
        let mut idx = self.idx.lock().await;
        for ((old_id, _, old_meta), mut new_obj) in cands.into_iter().zip(news) {
            // the key set may have changed while we were uploading; then this copy is
            // simply never pinned and prune_slabs reclaims it
            let unchanged = idx.objs.get(&old_id).is_some_and(|(_, m)| *m == old_meta) && !idx.is_part(&old_id);
            if !unchanged {
                continue;
            }
            let mut nm = old_meta.clone();
            nm.p = true;
            let nm = match self.pin_with(&mut new_obj, nm).await {
                Ok(m) => m,
                Err(e) => {
                    eprintln!("[sia-s3] compact: pin failed: {e}");
                    break;
                }
            };
            let new_id = new_obj.id().to_string();
            if let Some((o, _)) = idx.objs.get(&old_id).cloned() {
                if let Err(e) = self.delete(&o).await {
                    // both copies now name the keys; the next load tolerates that
                    eprintln!("[sia-s3] compact: old object not deleted: {e}");
                }
            }
            idx.objs.remove(&old_id);
            for e in &nm.e {
                if let Some(k) = idx.keys.get_mut(&(e.b.clone(), e.k.clone())) {
                    if k.host == old_id {
                        k.host = new_id.clone();
                    }
                }
            }
            idx.objs.insert(new_id, (new_obj, nm));
            done += 1;
        }
        drop(idx);
        if self.is_retired() {
            return Ok(done); // replaced meanwhile: this store sends nothing more (the fresh one's next pass prunes)
        }
        if let Ok(Err(e)) = tokio::time::timeout(self.opts.meta_timeout, self.sdk.prune_slabs(None)).await {
            eprintln!("[sia-s3] compact: prune_slabs: {e}");
        }
        Ok(done)
    }

    /// Load-time cleanup: orphans (serve no key) and uploads abandoned for a week. Nothing is swept while a manifest
    /// or ledger is unread: its parts would look unused, its floors unknown.
    pub async fn sweep(&self) {
        let mut idx = self.idx.lock().await;
        if !idx.unresolved.is_empty() || !idx.unread_ledgers.is_empty() {
            return;
        }
        let orphans = std::mem::take(&mut idx.orphans);
        for id in orphans {
            if let Some((o, _)) = idx.objs.get(&id).cloned() {
                if o.created_at.timestamp() < now() - 86400 && self.delete(&o).await.is_ok() {
                    idx.objs.remove(&id);
                }
            }
        }
        let stale: Vec<String> = idx.uploads.iter().filter(|(_, u)| u.started < now() - 7 * 86400).map(|(k, _)| k.clone()).collect();
        for uid in stale {
            if let Some(u) = idx.uploads.remove(&uid) {
                for (id, _, _) in u.parts.values() {
                    if let Some((o, _)) = idx.objs.get(id).cloned() {
                        if self.delete(&o).await.is_ok() {
                            idx.objs.remove(id);
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_indexer_urls_never_reach_error_text() {
        // reqwest names the URL it failed on, and the SDK signs every indexer request in that URL's query
        let e = "http error: error sending request for url (https://sia.example.org/api/objects/abc?sv=1790000000&sc=AAAA&ss=SIGNATURE): connection refused";
        let r = redact(e);
        assert_eq!(r, "http error: error sending request for url (https://sia.example.org/api/objects/abc?[redacted]): connection refused");
        assert!(!r.contains("ss=") && !r.contains("SIGNATURE") && !r.contains("sv="));
        assert_eq!(redact("no url here"), "no url here");
        assert_eq!(redact("a http://h:9980/p b https://x/y#frag?z c"), "a http://h:9980/p b https://x/y?[redacted] c");
        assert_eq!(redact("https://[::1]:8080/a?ss=1&x"), "https://[::1]:8080/a?[redacted]");
        assert_eq!(redact("'https://a/b?ss=1', \"http://c/d?sv=2\""), "'https://a/b?[redacted]', \"http://c/d?[redacted]\"");
        // the error helper used for every SDK error redacts too
        assert_eq!(e2s("for url (https://i.example/x?ss=s)"), "for url (https://i.example/x?[redacted])");
    }

    fn entry(key: &str, parts: usize) -> Entry {
        Entry {
            b: "ipfs".into(),
            k: key.into(),
            s: 1 << 30,
            t: format!("{}-{parts}", "0".repeat(32)),
            m: 1_760_000_000,
            c: Some("application/octet-stream".into()),
            x: vec!["0".repeat(64); parts.saturating_sub(1)],
            h: 1_760_000_000_000,
            i: new_wid(),
        }
    }

    #[test]
    fn inline_metadata_budget_and_tombstone_size() {
        let one = |e: Entry| fits(&Meta { p: true, e: vec![e], ..Default::default() });
        // a typical pinned file fits inline, version stamp included
        assert!(one(entry("pins/bafybeiew67vbyfabcdefghijklmnopqrstuvwxyz234567abcdefghijklmn", 1)));
        // inline multipart entries hold about a dozen parts; beyond that, and for keys near S3's 1 KiB limit, a
        // manifest is used instead (store tests below and replica.rs)
        let max_parts = (1..64).take_while(|n| one(entry("big/file.bin", *n))).last().unwrap();
        assert!((10..=14).contains(&max_parts), "{max_parts}");
        assert!(!one(entry(&"k".repeat(1000), 1)));
        // a tombstone is no larger than the smallest 0.1.x entry it replaces, whatever the key's length
        let t = Tomb { q: qkey("ipfs", &"k".repeat(1024)), h: 1_760_000_000_000, i: new_wid() };
        let legacy = Entry { b: "a".into(), k: "b".into(), s: 0, t: "0".repeat(32), m: 1_760_000_000, c: None, x: vec![], h: 0, i: String::new() };
        assert!(serde_json::to_vec(&t).unwrap().len() <= serde_json::to_vec(&legacy).unwrap().len() + 8);
    }

    fn ver_entry(h: u64) -> Entry {
        Entry { b: "b".into(), k: "k".into(), s: 1, t: "t".into(), m: 1, c: None, x: vec![], h, i: "a".into() }
    }

    #[test]
    fn floors_hide_older_versions_wherever_they_appear() {
        let floor = Tomb { q: qkey("b", "k"), h: 200, i: "f".into() };
        let ledger = Meta { v: 2, p: true, lg: Some(LgRef { n: 0, z: String::new(), c: 1 }), ..Default::default() };
        let mut objs = HashMap::new();
        objs.insert("old".to_string(), (Object::default(), Meta { v: 1, e: vec![ver_entry(100)], ..Default::default() }));
        objs.insert("lg".to_string(), (Object::default(), ledger));
        let ledgers = HashMap::from([("lg".to_string(), Ledger { v: 1, f: vec![floor.clone()] })]);

        // a version older than the floor, however it got there, is not served, and is named as dead for purging
        let idx = build_index(objs.clone(), HashMap::new(), ledgers.clone());
        assert!(idx.keys.is_empty());
        assert_eq!(idx.tomb(&floor.q), Some(&floor));
        assert_eq!(idx.oldest[&floor.q].h, 100);
        assert!(!idx.orphans.iter().any(|o| o == "lg"), "a ledger is never an orphan");
        // a version newer than the floor is ordinary
        objs.insert("new".to_string(), (Object::default(), Meta { v: 1, e: vec![ver_entry(300)], ..Default::default() }));
        let idx = build_index(objs.clone(), HashMap::new(), ledgers);
        assert_eq!(idx.keys[&("b".to_string(), "k".to_string())].entry.h, 300);
        // a ledger whose body is missing: its floors are unknown, nothing is swept (and fetch_index refuses it)
        let idx = build_index(objs, HashMap::new(), HashMap::new());
        assert_eq!(idx.unread_ledgers, vec!["lg".to_string()]);
        assert!(idx.orphans.is_empty());
    }

    #[test]
    fn membership_records_fit_in_metadata_and_are_never_swept() {
        // the largest set config allows (16 indexers) replacing another of 16 still fits the metadata budget
        let ids = |seed: &str| {
            let mut m: Vec<String> = (0..16).map(|i| member_id(&format!("https://indexer-{seed}-{i}.example.org"))).collect();
            m.sort();
            m
        };
        let rec = MsRec { k: "s".into(), d: MsDef { s: u64::MAX, w: 16, m: ids("new") }, p: Some(MsDef { s: u64::MAX - 1, w: 16, m: ids("old") }), c: u64::MAX };
        let meta = Meta { p: true, ms: Some(rec.clone()), ..Default::default() }.normalized();
        assert!(meta_bytes(&meta).is_ok() && meta.v == 2, "0.1.x leaves v2 objects alone");
        assert_eq!(member_id("https://sia.enclave.host").len(), 16);
        // a record object is listed as such, is never an orphan, and leaves the key space alone
        let mut objs = HashMap::new();
        objs.insert("ms".to_string(), (Object::default(), meta));
        objs.insert("old".to_string(), (Object::default(), Meta { v: 1, e: vec![ver_entry(100)], ..Default::default() }));
        let idx = build_index(objs, HashMap::new(), HashMap::new());
        assert_eq!(idx.records, vec![("ms".to_string(), rec.clone())]);
        assert!(idx.orphans.is_empty() && idx.keys.len() == 1);
        assert_eq!(idx.newest_record(), Some(&rec));
        // an unknown field in a record is refused (it is not this version's record), not misread
        let raw = br#"{"v":2,"p":true,"ms":{"k":"a","d":{"s":1,"w":1,"m":[]},"x":1}}"#;
        assert!(serde_json::from_slice::<Meta>(raw).is_err() && unreadable_record(raw), "fetch_index refuses to load it");
        assert!(!unreadable_record(br#"{"something":"else"}"#));
    }

    #[test]
    fn ledgers_are_checked_against_their_signed_metadata() {
        let l = Ledger { v: 1, f: vec![Tomb { q: qkey("b", "k"), h: 5, i: "i".into() }] };
        let raw = serde_json::to_vec(&l).unwrap();
        let lg = LgRef { n: raw.len() as u64, z: sha256_hex(&raw), c: 1 };
        assert_eq!(parse_ledger(&raw, &lg).unwrap(), l);
        let mut bad = raw.clone();
        bad[5] ^= 1;
        assert!(parse_ledger(&bad, &lg).is_err());
        assert!(parse_ledger(&raw, &LgRef { c: 2, ..lg.clone() }).is_err());
        // about 80 bytes a floor
        assert!(raw.len() < 100);
    }

    #[test]
    fn manifests_are_checked_against_their_signed_metadata() {
        let man = Manifest { v: 1, b: "b".into(), k: "k".repeat(1024), s: 3, t: "t".into(), c: None, x: vec!["a".into(), "b".into()] };
        let raw = serde_json::to_vec(&man).unwrap();
        let mf = MfRef { q: qkey("b", &"k".repeat(1024)), h: 5, i: "i".into(), m: 1, n: raw.len() as u64, z: sha256_hex(&raw) };
        assert_eq!(parse_manifest(&raw, &mf).unwrap(), man);
        let mut bad = raw.clone();
        bad[10] ^= 1;
        assert!(parse_manifest(&bad, &mf).is_err());
        assert!(parse_manifest(&raw, &MfRef { q: qkey("b", "other"), ..mf.clone() }).is_err());
        assert!(parse_manifest(&raw, &MfRef { n: mf.n + 1, ..mf.clone() }).is_err());
        // the key hash separates bucket and key
        assert_ne!(qkey("ab", "c"), qkey("a", "bc"));
    }

    #[test]
    fn metadata_versions_keep_0_1_from_sweeping_what_it_cannot_read() {
        assert_eq!(Meta { e: vec![entry("k", 1)], ..Default::default() }.normalized().v, 1);
        let part = PartTag { u: "u".into(), b: "b".into(), k: "k".into(), n: 1, t: "t".into() };
        assert_eq!(Meta { mp: Some(part), ..Default::default() }.normalized().v, 1);
        assert_eq!(Meta { p: true, ..Default::default() }.normalized().v, 2);
        assert_eq!(Meta { d: vec![Tomb { q: "q".into(), h: 1, i: "i".into() }], ..Default::default() }.normalized().v, 2);
        // 0.1.x metadata (no `p`, no stamps) still parses
        let old: Meta = serde_json::from_str(r#"{"v":1,"p":false,"e":[{"b":"b","k":"k","s":1,"t":"x","m":100}]}"#).unwrap();
        assert_eq!(old.e[0].ver(), Ver { h: 100_000, i: String::new() });
    }

    /// PATCH U1-B, over real HTTP: the SDK's indexer client asks `GET /current/objects` with `blocked=true`, reads
    /// indexd-fence's JSON shapes (an ordinary entry with its sealed object and no `blocked` member; a blocked one with
    /// `blocked: true` and no `object`), follows the cursor past a page ending in a blocked entry to the empty page,
    /// and refuses malformed pages (a blocked entry with an object, an entry with neither, keys out of order or not
    /// after the cursor) instead of reading them as absent, deleted or older objects.
    #[tokio::test]
    async fn blocked_listing_wire_url_json_shapes_and_cursor_over_real_http() {
        use std::sync::{Arc, Mutex as StdMutex};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let key = sia_storage::AppKey::import([7; 32]);
        // a real object: uploaded through the mock network and sealed with the key the HTTP client signs with
        let net = sia_storage::mock::MockNetwork::new();
        net.add_hosts(12);
        let opts = Opts { shards: (3, 9), ..Opts::default() };
        let obj = Store::load_with(net.sdk(key.clone()).await.unwrap(), 8 << 20, opts.clone()).await.unwrap().upload(Rc::from(&b"x"[..])).await.unwrap();
        let sealed = serde_json::to_string(&obj.seal(&key)).unwrap();
        let h = |b: u8| sia_storage::Hash256::new([b; 32]).to_string();
        let (id, top) = (obj.id().to_string(), h(0xff));
        assert!(id < top);
        let (pid, ptop) = (id.clone(), top.clone());
        let page = move |after: Option<String>| -> String {
            let (id, top) = (&pid, &ptop);
            let at = r#""deleted":false,"updatedAt":"2026-10-20T10:00:00Z""#;
            match after.as_deref() {
                None => format!(r#"[{{"key":"{id}",{at},"object":{sealed}}},{{"key":"{top}",{at},"blocked":true}}]"#),
                Some(a) if a == top => "[]".into(),
                Some(a) if a == h(1) => format!(r#"[{{"key":"{top}",{at},"blocked":true,"object":{sealed}}}]"#),
                Some(a) if a == h(2) => format!(r#"[{{"key":"{top}",{at}}}]"#),
                Some(a) if a == h(3) => format!(r#"[{{"key":"{top}",{at},"blocked":true}},{{"key":"{}",{at},"blocked":true}}]"#, h(0xfe)),
                Some(a) if a == h(5) => format!(r#"[{{"key":"{}",{at},"blocked":true}}]"#, h(4)),
                Some(_) => "[]".into(),
            }
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let seen: Arc<StdMutex<Vec<Vec<(String, String)>>>> = Default::default();
        let seen2 = seen.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = sock.read(&mut tmp).await.unwrap();
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                let head = String::from_utf8_lossy(&buf).to_string();
                let target = head.split_whitespace().nth(1).unwrap_or("").to_string();
                let (path, q) = target.split_once('?').unwrap_or((&target, ""));
                let query: Vec<(String, String)> = url::form_urlencoded::parse(q.as_bytes()).into_owned().collect();
                let (status, body) = match path {
                    "/auth/check" => ("204 No Content", String::new()),
                    "/hosts" => ("200 OK", "[]".to_string()),
                    "/current/objects" => {
                        let after = query.iter().find(|(k, _)| k == "after").map(|(_, v)| v.clone());
                        seen2.lock().unwrap().push(query.clone());
                        ("200 OK", page(after))
                    }
                    _ => ("404 Not Found", String::new()),
                };
                let resp = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                sock.write_all(resp.as_bytes()).await.unwrap();
            }
        });
        let sdk = sia_storage::Builder::new(url.as_str(), crate::META).unwrap().connected(&key).await.unwrap().expect("authorized");
        let first = sdk.current_objects(None, Some(500)).await.unwrap();
        assert_eq!(first.len(), 2);
        assert!(!first[0].blocked && first[0].id == obj.id() && first[0].object.as_ref().map(|o| o.id()) == Some(obj.id()), "opened with the key");
        assert!(first[1].blocked && first[1].object.is_none() && !first[1].deleted && first[1].id.to_string() == top);
        for (after, what) in [(1, "a blocked entry carrying an object"), (2, "an entry with neither object nor flag"), (3, "keys out of order"), (5, "a key not after the cursor")] {
            let e = sdk.current_objects(Some(sia_storage::Hash256::new([after; 32])), Some(500)).await.err();
            assert!(e.is_some(), "{what} must be refused");
        }
        // the store's listing: every request asks for blocked entries; the cursor moves past the blocked last entry
        // and only the empty page ends it
        seen.lock().unwrap().clear();
        let mut st = Store::load_listing(sdk.clone(), 8 << 20, opts).await.unwrap();
        assert_eq!(st.idx.get_mut().blocked, vec![top.clone()]);
        let reqs = seen.lock().unwrap().clone();
        assert_eq!(reqs.len(), 2, "{reqs:?}");
        for q in &reqs {
            assert!(q.contains(&("blocked".to_string(), "true".to_string())) && q.contains(&("limit".to_string(), "500".to_string())), "{q:?}");
        }
        assert!(!reqs[0].iter().any(|(k, _)| k == "after"));
        assert!(reqs[1].contains(&("after".to_string(), top.clone())));
        let e = Store::load_with(sdk, 8 << 20, Opts { shards: (3, 9), ..Opts::default() }).await.err().unwrap();
        assert!(e.starts_with("AdminBlocked") && !e.contains(&top), "{e}");
        server.abort();
    }
}
