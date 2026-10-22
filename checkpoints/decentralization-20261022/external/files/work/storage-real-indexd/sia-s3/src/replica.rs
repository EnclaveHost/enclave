//! The S3 key space replicated across independent indexers.
//!
//! An indexer (indexd) is the one party that holds a Sia app's host contracts,
//! funds its host accounts, pins its slabs, and keeps its object list. With one
//! indexer every write depends on that one operator. Here each configured
//! indexer is a full replica (`Store`): the app key may differ per indexer, the
//! data is uploaded to each separately (its own hosts, contracts and funding),
//! and nothing is shared between them but the S3 keys.
//!
//! Consistency, for ONE writer (see "Writers" below):
//!   - Every write is stamped with a version (`Entry::ver`: a millisecond clock
//!     that only moves forward, plus a random write id). Replicas are merged by
//!     taking the newest version of each key; a newer tombstone hides it.
//!   - A write succeeds when `writeQuorum` (W) admitted replicas commit it.
//!     Serving starts once N - W + 1 admitted replicas have loaded, so every
//!     write that was acknowledged is in the merged view (any W set meets any
//!     N - W + 1 set). "Admitted" is below, under "Membership".
//!   - Latency: every replica call has a deadline. Once W replicas have
//!     answered, the rest get a short grace period and are then abandoned, so
//!     one slow or hung indexer delays a write by at most that grace (or fails
//!     it at the deadline when W cannot be reached). An abandoned or failed
//!     metadata call has an unknown outcome: the indexer may apply it later.
//!   - Unknown outcomes make a replica *dirty*: its in-memory index may lack
//!     objects that exist, or that will exist at any later time. A dirty
//!     replica still serves what it knows and is re-read from its indexer's
//!     object feed. Nothing assumes such a write has stopped being possible.
//!   - DELETE writes a tombstone into the key's host object on every replica
//!     that holds the key (and, on a replica that does not, a deletion floor
//!     in a ledger object), and answers 204 only once the deletion is durably
//!     recorded (acknowledged by the indexer) on W replicas; otherwise 503,
//!     and a retry re-applies the same deletion. Any W set meets any boot set
//!     of N - W + 1, so a boot always sees the deletion.
//!   - Deletion evidence is never discarded. Maintenance copies every
//!     deletion into a ledger floor on every replica; once a replica has
//!     pinned the floor, the tombstone leaves its object and the payload it
//!     held is reclaimed. A version older than a floor is dead wherever it
//!     shows up: a write abandoned long ago that lands now, or old data an
//!     indexer replays, stays hidden and is purged. Floors cost about 80 bytes
//!     per deleted key, for good.
//!   - A request that fails quorum answers 503; like an S3 500, its write may
//!     still have reached some replicas and may become visible.
//!   - Repair copies the newest version to replicas that lack it (reading it
//!     from any replica that has it) and applies missed deletes.
//!   - Reads go to any replica holding exactly the version being served and
//!     fail over to the next one, resuming at the byte where the last stopped.
//!
//! Fault model: indexers are assumed fail-stop with durable acknowledgements
//! (an acknowledged pin survives). That is what W-of-N and N - W + 1 rely on.
//! Floors held on every replica also cover an indexer that rolls back or
//! loses its state, as long as at most N - W replicas do so at once. An
//! indexer cannot forge objects (they are signed with the app key and checked
//! against Sia sector proofs), but it can withhold or replay them: this is not
//! Byzantine-fault-tolerant storage, and a lying majority defeats it.
//!
//! Membership: quorum intersection only covers writes acknowledged by W
//! members of the *current* replica set. Data written under another set (a
//! single indexer before replication, or a set a replica was added to or
//! removed from) is not covered, so every replica keeps durable membership
//! records (store.rs `MsRec`) and only *admitted* replicas count:
//!   - A membership is an epoch, a write quorum and its members (by indexer
//!     URL). A replica is admitted to it by an `admit` record, written only
//!     once it holds the complete history: every key at the newest version,
//!     every deletion, every open multipart part.
//!   - Serving needs N - W + 1 admitted members loaded, and only admitted
//!     members count toward W (and toward a DELETE's durability). A new
//!     member is written to and backfilled, but votes only once admitted.
//!   - Changing the configured set (a *migration*) keeps the old set's rules
//!     (its members vote, its quorums) while maintenance backfills the new
//!     members. Once every new member is caught up, the change is committed
//!     under the write lock: `seal` records go to the old members (W of them
//!     at least), then `admit` records to the new ones. An old quorum always
//!     meets a seal, so the old set never serves again; a set that never
//!     reached N - W + 1 admissions never acknowledged anything, so a change
//!     interrupted half way is finished from where it stopped.
//!   - A deployment without records (0.1.x, or one indexer) is ready on its one
//!     indexer as before, and records it (epoch 1) at the first maintenance
//!     pass. Several indexers without records never serve: with every one
//!     loaded (their union then includes the old one's data), maintenance
//!     seals all of them and admits them as epoch 2 first.
//!   - Two sets at the newest epoch (a partial seal, then another change at
//!     the same epoch): when both name a previous set and exactly one has
//!     admissions, it acts; otherwise nothing is served.
//!   - Replicas leaving the set stay configured with `retiring: true` until the
//!     change commits: sources and seal holders, written to only while the
//!     old set they belong to still acts. A replica is known by its canonical
//!     indexer URL, so changing that URL is a membership change too.
//!
//! Versions: a version's clock part comes from the writer's wall clock, which
//! may be skewed, so consecutive writers are ordered by durable version-range
//! ceilings (store.rs `Meta.ck`), not by clocks:
//!   - I1: a writer stamps a version only at or below a ceiling it has had
//!     acknowledged by W voters of the acting membership (`ensure_range`
//!     reserves one, outside the write lock; `stamp` refuses past it).
//!   - I2: a booting writer's clock starts above the highest ceiling any loaded
//!     replica holds, in a ceiling object or carried by a membership record.
//!     Any W set of voters meets any N - W + 1 boot set, so every version an
//!     earlier writer stamped (acknowledged or abandoned) is below the new
//!     writer's first version and below any deletion floor it writes.
//!   - Joint points with "Membership": M1, only voters' acknowledgements count
//!     for a reservation (joiners and retiring replicas get it, uncounted). M2,
//!     a member is admitted only when it holds the highest known ceiling (this
//!     writer's acknowledged one, or a higher one observed), its admission and
//!     seal records carry that ceiling, and admission holds `reserving` so no
//!     reservation is acknowledged while the voters change. M3, the observed
//!     ceiling is a maximum over every loaded replica, never a narrower set.
//!   - Writers that ran before ceilings existed are not fenced: their requests
//!     still in flight are ordered by wall clock only (`version_fence` reads
//!     "legacy" until the first reservation).
//!
//! Writers: there must be one sia-s3 process writing to a set of app keys at a
//! time. indexd offers no fencing (no conditional pin), so a second writer is
//! invisible to this one until a reload, and two writers can make conditional
//! PUTs and version ordering wrong. Requests a stopped writer (running this
//! code) left in flight stay below everything a later writer stamps
//! ("Versions"), so they cannot bring a deleted key back; they may still make
//! an older version of an undeleted key reappear briefly until the newer
//! version wins the merge.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll};
use std::time::Duration;

use md5::{Digest, Md5};
use serde::Serialize;
use sia_storage::Object;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

use crate::store::{
    Completion, Cond, Entry, KK, MsDef, MsRec, Opts, Placement, Res, Store, Tomb, Ver, md5_hex, member_id, new_id, new_wid, now_ms, qkey,
};

/// The epoch a set of several replicas without membership records commits as. A single indexer's own first record
/// is epoch 1; this is above it, so a single-indexer admission abandoned before a restart and applied later can
/// never collide with it.
const RECORDLESS_SET_EPOCH: u64 = 2;

/// How far one version-range reservation reaches past the clock: 6 h. Maintenance renews at half of it, so a
/// stamping write reserves inline only after an outage or a restart.
pub const VERSION_RANGE_MS: u64 = 6 * 3600 * 1000;
/// A stamping write reserves first unless at least this much of its range is left (covers the time to the stamp).
const STAMP_LOW_MS: u64 = 10_000;

pub struct Replica {
    pub name: String,
    pub indexer: String,
    /// its name in membership records (`member_id` of the indexer URL)
    pub id: String,
    /// listed only as a source for a membership change, not a member
    pub retiring: bool,
    store: RefCell<Option<Rc<Store>>>,
    pub error: RefCell<Option<String>>,
}

impl Replica {
    pub fn store(&self) -> Option<Rc<Store>> {
        self.store.borrow().clone()
    }
}

/// The merged view: the newest live version of each key (part lists cleared:
/// they differ per replica) and the newest tombstone of each deleted key hash.
#[derive(Default)]
pub struct View {
    pub keys: BTreeMap<KK, Entry>,
    pub tombs: BTreeMap<String, Tomb>,
}

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClusterStats {
    pub repair_passes: u64,
    pub repaired_copies: u64,
    pub repaired_deletes: u64,
    pub reconciled: u64,
    pub purged_versions: u64,
    pub floors_written: u64,
    pub reclaimed_tombstones: u64,
    pub refused_writes: u64,
    pub abandoned_calls: u64,
    pub last_repair: Option<String>,
    pub last_repair_error: Option<String>,
    /// the version-range ceiling this process has acknowledged on a write quorum (0: none reserved yet)
    pub version_ceiling: u64,
    /// the highest ceiling any loaded replica holds: every version this process stamps is above it
    pub observed_ceiling: u64,
    /// "legacy" until the first acknowledged reservation, then "ceiling" (see "Versions" below)
    pub version_fence: String,
}

/// Where the cluster stands with its membership (module docs, "Membership").
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// no replica loaded yet
    #[default]
    Loading,
    /// no membership records anywhere: one indexer, or every configured one loaded
    Legacy,
    /// the configured set is the admitted one
    Stable,
    /// serving under the previous set's rules while the configured set is backfilled
    Migrating,
    /// the configured set was sealed but has not reached N - W + 1 admissions: finishing that, not serving
    Pending,
    /// the admitted set may be serving from replicas that are not loaded
    Waiting,
    /// the records cannot be acted on as configured
    Refused,
}

/// The membership state computed from the loaded replicas' records.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MsState {
    pub phase: Phase,
    pub ready: bool,
    /// replicas whose acknowledgements count (empty unless ready)
    pub voters: Vec<usize>,
    /// acknowledgements a write needs
    pub need: usize,
    /// the set whose rules apply (None: records do not exist yet)
    pub acting: Option<MsDef>,
    /// the configured set, as it is (to be) admitted, and the set its records name as replaced
    pub target: MsDef,
    pub prev: Option<MsDef>,
    /// loaded replicas holding the complete history between them, and how many of them must be complete
    pub sources: Vec<usize>,
    pub sources_needed: usize,
    /// loaded replicas to seal before any admission to `target`, and how many seals that needs
    pub seal_to: Vec<usize>,
    pub seal_needed: usize,
    /// admit every configured member at once (a change), rather than one at a time (joining)
    pub commit: bool,
    /// not serving, and maintenance must run to get there (a sealed change to finish, or a set without records to
    /// commit): main.rs runs it in the boot loop
    pub finish: bool,
    pub reason: Option<String>,
}

#[derive(Default, Debug, PartialEq)]
pub struct RepairReport {
    pub reconciled: usize,
    pub purged: usize,
    pub copies: usize,
    pub deletes: usize,
    /// deletion floors written into ledgers
    pub floors: usize,
    /// tombstones (and the payload they held) reclaimed under a floor
    pub reclaimed: usize,
    /// ledgers merged away
    pub merged: usize,
    /// open multipart parts copied to members that lacked them
    pub parts: usize,
    /// membership records written (seals and admissions)
    pub admitted: usize,
    /// replicas given the highest known version-range ceiling
    pub ceilings: usize,
    /// work left for the next pass (byte budget spent, or a replica failed)
    pub pending: usize,
}

/// Timing of replica calls beyond the per-call deadlines in `Opts`.
#[derive(Clone, Debug)]
pub struct Timing {
    /// once a write quorum of uploads has finished, how long the others may still finish
    pub upload_grace: Duration,
    /// once a write quorum of metadata commits has answered, how long the others may still answer
    pub meta_grace: Duration,
    /// how long one replica may stop taking a streamed body before it is dropped from the tee
    pub stall: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing { upload_grace: Duration::from_secs(30), meta_grace: Duration::from_secs(5), stall: Duration::from_secs(120) }
    }
}

/// One version of an open multipart part as the sources hold it.
struct PartVariant {
    b: String,
    k: String,
    started: i64,
    etag: String,
    size: u64,
    /// the replicas holding it, with their part objects
    held: Vec<(usize, Object)>,
}

/// Uploaded bodies awaiting commit, one object per replica that stored it. Nothing in it is pinned as an object, so
/// dropping it leaves only slabs, which `prune_slabs` reclaims.
#[derive(Default)]
pub struct Staged {
    objs: Vec<(usize, Object)>,
}

pub struct Cluster {
    pub replicas: Vec<Replica>,
    pub write_quorum: usize,
    pub opts: Opts,
    pub timing: Timing,
    /// serializes the commit phase of every mutation (uploads run outside it)
    write: Mutex<()>,
    clock: Cell<u64>,
    /// versions this process may stamp: up to this ceiling, acknowledged on a write quorum of voters (0: none yet)
    ceiling: Cell<u64>,
    /// the highest ceiling found on any loaded replica, in ceiling objects or membership records (never lowered):
    /// the clock never starts at or below it
    observed: Cell<u64>,
    /// one reservation at a time; a membership commit or admission also holds it (M2 in "Versions")
    reserving: Mutex<()>,
    /// how far one reservation reaches past the clock (ms)
    pub range_ms: Cell<u64>,
    pub view: RefCell<View>,
    pub ms: RefCell<MsState>,
    pub stats: RefCell<ClusterStats>,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Poll every future to completion on this task (the runtime is single-threaded; calls to different indexers
/// overlap on the network).
pub async fn join_all<F: Future>(futs: Vec<F>) -> Vec<F::Output> {
    let mut futs: Vec<Pin<Box<F>>> = futs.into_iter().map(Box::pin).collect();
    let mut out: Vec<Option<F::Output>> = futs.iter().map(|_| None).collect();
    std::future::poll_fn(|cx: &mut Context<'_>| {
        let mut pending = false;
        for (f, o) in futs.iter_mut().zip(out.iter_mut()) {
            if o.is_none() {
                match f.as_mut().poll(cx) {
                    Poll::Ready(v) => *o = Some(v),
                    Poll::Pending => pending = true,
                }
            }
        }
        if pending { Poll::Pending } else { Poll::Ready(()) }
    })
    .await;
    out.into_iter().map(|o| o.expect("polled to completion")).collect()
}

/// Run one call per replica concurrently. Returns when all have finished; or `grace` after `need` of them succeeded
/// (`success` sees the replica and its result); or at `deadline`. Calls still running then are dropped (cancelled) and come back as None.
pub async fn fan_out<T, F: Future<Output = Res<T>>>(
    jobs: Vec<(usize, F)>,
    need: usize,
    grace: Duration,
    deadline: Duration,
    success: impl Fn(usize, &Res<T>) -> bool,
) -> Vec<(usize, Option<Res<T>>)> {
    let ids: Vec<usize> = jobs.iter().map(|(i, _)| *i).collect();
    let mut futs: Vec<Option<Pin<Box<F>>>> = jobs.into_iter().map(|(_, f)| Some(Box::pin(f))).collect();
    let mut out: Vec<Option<Res<T>>> = futs.iter().map(|_| None).collect();
    let mut stop = Box::pin(tokio::time::sleep(deadline));
    let mut grace_timer: Option<Pin<Box<tokio::time::Sleep>>> = None;
    std::future::poll_fn(|cx: &mut Context<'_>| {
        let (mut running, mut good) = (0, 0);
        for ((f, o), i) in futs.iter_mut().zip(out.iter_mut()).zip(&ids) {
            if let Some(fut) = f {
                if let Poll::Ready(r) = fut.as_mut().poll(cx) {
                    *o = Some(r);
                    *f = None;
                }
            }
            match o {
                Some(r) if success(*i, r) => good += 1,
                Some(_) => {}
                None => running += 1,
            }
        }
        if running == 0 || stop.as_mut().poll(cx).is_ready() {
            return Poll::Ready(());
        }
        if good >= need {
            let g = grace_timer.get_or_insert_with(|| Box::pin(tokio::time::sleep(grace)));
            if g.as_mut().poll(cx).is_ready() {
                return Poll::Ready(());
            }
        }
        Poll::Pending
    })
    .await;
    drop(futs);
    ids.into_iter().zip(out).collect()
}

/// A writer that counts (and optionally MD5s) what the inner writer accepted, so a failed read can resume at the
/// exact byte and a repair copy can be checked against its ETag.
struct Tap<'a, W> {
    w: &'a mut W,
    n: u64,
    md5: Option<Md5>,
}

impl<'a, W> Tap<'a, W> {
    fn new(w: &'a mut W, md5: bool) -> Self {
        Tap { w, n: 0, md5: md5.then(Md5::new) }
    }
}

impl<W: AsyncWrite + Unpin> AsyncWrite for Tap<'_, W> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        let this = &mut *self;
        let r = Pin::new(&mut *this.w).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = r {
            this.n += n as u64;
            if let Some(m) = &mut this.md5 {
                m.update(&buf[..n]);
            }
        }
        r
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.w).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.w).poll_shutdown(cx)
    }
}

fn cond_ok(v: &View, kk: &KK, cond: &Cond) -> Res<()> {
    let ok = match cond {
        Cond::None => true,
        Cond::IfNoneMatch => !v.keys.contains_key(kk),
        Cond::IfMatch(t) => v.keys.get(kk).is_some_and(|e| t == "*" || e.t == *t),
    };
    if ok { Ok(()) } else { Err("PreconditionFailed".into()) }
}

/// Does `s` hold a record for membership `d` (an admission, when `admit`)?
async fn holds(s: &Store, admit: bool, d: &MsDef) -> bool {
    s.idx.lock().await.records.iter().any(|(_, r)| r.d == *d && (!admit || r.admit()))
}

fn committed(r: &Res<bool>) -> bool {
    matches!(r, Ok(true))
}

impl Cluster {
    /// `replicas`: (name, canonical indexer URL, retiring) in configured order. 1 <= `write_quorum` <= members (the
    /// replicas not retiring).
    pub fn new(replicas: Vec<(String, String, bool)>, write_quorum: usize, opts: Opts, timing: Timing) -> Cluster {
        let members = replicas.iter().filter(|r| !r.2).count();
        assert!((1..=members).contains(&write_quorum));
        Cluster {
            replicas: replicas
                .into_iter()
                .map(|(name, indexer, retiring)| Replica {
                    name,
                    id: member_id(&indexer),
                    indexer,
                    retiring,
                    store: RefCell::new(None),
                    error: RefCell::new(None),
                })
                .collect(),
            write_quorum,
            opts,
            timing,
            write: Mutex::new(()),
            clock: Cell::new(0),
            ceiling: Cell::new(0),
            observed: Cell::new(0),
            reserving: Mutex::new(()),
            range_ms: Cell::new(VERSION_RANGE_MS),
            view: Default::default(),
            ms: Default::default(),
            stats: Default::default(),
        }
    }

    pub fn n(&self) -> usize {
        self.replicas.len()
    }

    /// The configured members (replicas not retiring).
    pub fn members(&self) -> Vec<usize> {
        (0..self.n()).filter(|i| !self.replicas[*i].retiring).collect()
    }

    /// Admitted members of the configured set that must be loaded before the merged view is complete.
    pub fn read_quorum(&self) -> usize {
        self.members().len() - self.write_quorum + 1
    }

    pub fn store(&self, i: usize) -> Option<Rc<Store>> {
        self.replicas[i].store()
    }

    pub fn loaded(&self) -> Vec<(usize, Rc<Store>)> {
        self.replicas.iter().enumerate().filter_map(|(i, r)| r.store().map(|s| (i, s))).collect()
    }

    /// Is the merged view complete, so the cluster may serve? See "Membership" in the module docs.
    pub fn ready(&self) -> bool {
        self.ms.borrow().ready
    }

    /// Why the cluster is not ready, when its membership is the reason.
    pub fn ms_reason(&self) -> Option<String> {
        self.ms.borrow().reason.clone()
    }

    /// Must maintenance run before anything is served: a sealed change to finish, or a set without records (every
    /// replica loaded) to commit?
    pub fn finishing(&self) -> bool {
        self.ms.borrow().finish
    }

    fn voters(&self) -> Vec<usize> {
        self.ms.borrow().voters.clone()
    }

    fn need(&self) -> usize {
        self.ms.borrow().need.max(1)
    }

    /// How many of `ids` count toward a write quorum.
    fn votes(&self, ids: impl IntoIterator<Item = usize>) -> usize {
        let v = self.voters();
        ids.into_iter().filter(|i| v.contains(i)).count()
    }

    /// Loaded replicas a write goes to: the voters and the configured members (new members are written to before
    /// they vote; retiring replicas only while they vote).
    pub fn targets(&self) -> Vec<(usize, Rc<Store>)> {
        let v = self.voters();
        self.loaded().into_iter().filter(|(i, _)| !self.replicas[*i].retiring || v.contains(i)).collect()
    }

    /// Loaded configured members: what maintenance brings up to the merged view.
    fn backfill_targets(&self) -> Vec<(usize, Rc<Store>)> {
        self.loaded().into_iter().filter(|(i, _)| !self.replicas[*i].retiring).collect()
    }

    /// The membership state the loaded replicas' records give (module docs, "Membership"). `recs`: each loaded
    /// replica and the records it holds.
    pub fn membership(&self, recs: &[(usize, Vec<MsRec>)]) -> MsState {
        let n = self.n();
        let members = self.members();
        let mut cfg_m: Vec<String> = members.iter().map(|i| self.replicas[*i].id.clone()).collect();
        cfg_m.sort();
        let cfg = MsDef { s: 1, w: self.write_quorum as u32, m: cfg_m };
        let loaded: Vec<usize> = recs.iter().map(|(i, _)| *i).collect();
        let in_set = |i: usize, d: &MsDef| d.m.contains(&self.replicas[i].id);
        let rq = |d: &MsDef| d.m.len() + 1 - d.w as usize;
        let mut st = MsState { target: cfg.clone(), need: self.write_quorum, ..Default::default() };
        if loaded.is_empty() {
            st.reason = Some("no replica is loaded".into());
            return st;
        }
        let Some(top) = recs.iter().flat_map(|(_, rs)| rs.iter().map(|r| r.d.s)).max() else {
            // no records: a deployment from before them
            st.phase = Phase::Legacy;
            st.commit = true;
            st.sources = loaded.clone();
            if n == 1 {
                // one indexer: it is the whole history, as before records; its first pass records it (epoch 1)
                st.sources_needed = 1;
                st.ready = true;
                st.voters = loaded;
            } else {
                // Several listed replicas and no records: nothing durable says which of them hold the history or
                // that this set ever acted, so it never serves (a write acknowledged here by new replicas alone would
                // be lost if the configuration went back to the old indexer). It is committed first, with every
                // listed replica loaded: a seal on each of them (the old holder is among them, unknown), then the
                // admissions. Epoch 2, above a single indexer's own epoch 1, so a single-indexer record applied late
                // can never collide with it.
                st.target = MsDef { s: RECORDLESS_SET_EPOCH, ..cfg };
                st.sources_needed = n;
                st.seal_to = loaded.clone();
                st.seal_needed = n;
                st.finish = loaded.len() == n;
                st.reason = Some(if st.finish {
                    format!("no membership records yet: committing the {n} configured indexers as one set before serving")
                } else {
                    format!(
                        "no membership records yet: all {n} configured indexers must be loaded to commit them as one set, so that the one holding the existing data is among them ({} are)",
                        loaded.len()
                    )
                });
            }
            return st;
        };
        let mut at_top: Vec<(usize, &MsRec)> = recs.iter().flat_map(|(i, rs)| rs.iter().filter(|r| r.d.s == top).map(move |r| (*i, r))).collect();
        let bad = |d: &MsDef| d.w == 0 || d.w as usize > d.m.len();
        if at_top.iter().any(|(_, r)| bad(&r.d) || r.p.as_ref().is_some_and(bad)) {
            st.phase = Phase::Refused;
            st.reason = Some(format!("a membership record for epoch {top} is malformed; refusing to serve"));
            return st;
        }
        let mut sets: Vec<(&MsDef, &Option<MsDef>)> = Vec::new();
        for (_, r) in &at_top {
            if !sets.iter().any(|(d, p)| **d == r.d && **p == r.p) {
                sets.push((&r.d, &r.p));
            }
        }
        if sets.len() > 1 {
            // Two sets at one epoch: a change was sealed in part and another was then committed at the same epoch
            // from a boot that did not load the partial seal. When every record there names a previous set, at most
            // one of them can have admissions (admissions follow w(prev) seals, which every later quorum of prev
            // meets), so if exactly one has any, it is the membership; the others' seals are inert. Otherwise
            // (records without a previous set, or no admissions visible) nothing tells which is current.
            let with_admits: Vec<(&MsDef, &Option<MsDef>)> = sets
                .iter()
                .copied()
                .filter(|(d, p)| at_top.iter().any(|(_, r)| r.admit() && r.d == **d && r.p == **p))
                .collect();
            if sets.iter().all(|(_, p)| p.is_some()) && with_admits.len() == 1 {
                let (d, p) = (with_admits[0].0.clone(), with_admits[0].1.clone());
                at_top.retain(|(_, r)| r.d == d && r.p == p);
            } else {
                st.phase = Phase::Refused;
                st.reason = Some(format!(
                    "the membership records for epoch {top} name {} different sets, and none can be shown to be the current one; refusing to serve (load the replicas holding that epoch's admissions, or see REPLICATION.md, \"Membership changes\")",
                    sets.len()
                ));
                return st;
            }
        }
        let (cur, prev) = (at_top[0].1.d.clone(), at_top[0].1.p.clone());
        let mut admitted: Vec<usize> = at_top.iter().filter(|(i, r)| r.admit() && in_set(*i, &cur)).map(|(i, _)| *i).collect();
        admitted.dedup();
        let unseen = cur.m.iter().filter(|id| !loaded.iter().any(|i| self.replicas[*i].id == **id)).count();
        let configured = cur.m == cfg.m && cur.w == cfg.w;
        let short = format!("{} of the {} needed admitted members of epoch {top} are loaded", admitted.len(), rq(&cur));
        st.acting = Some(cur.clone());
        if admitted.len() >= rq(&cur) {
            st.ready = true;
            st.voters = admitted.clone();
            st.need = cur.w as usize;
            st.sources = admitted;
            st.sources_needed = rq(&cur);
            if configured {
                st.phase = Phase::Stable;
                st.target = cur;
                st.prev = prev;
            } else {
                st.phase = Phase::Migrating;
                st.commit = true;
                // epoch 2 belongs to commits of sets without records (whose admissions follow seals on every
                // listed replica): a recorded change never targets it, so a late record-less seal at epoch 2 can
                // never sit beside a recorded change's records (final review F1)
                let s = if top + 1 == RECORDLESS_SET_EPOCH { top + 2 } else { top + 1 };
                st.target = MsDef { s, ..cfg };
                st.seal_to = loaded.iter().copied().filter(|i| in_set(*i, &cur)).collect();
                st.seal_needed = cur.w as usize;
                st.prev = Some(cur);
            }
        } else if admitted.len() + unseen >= rq(&cur) {
            // members not loaded may hold admissions: that set may have acknowledged writes only they hold
            st.phase = Phase::Waiting;
            let unlisted = cur.m.iter().filter(|id| !self.replicas.iter().any(|r| r.id == **id)).count();
            st.reason = Some(if unlisted > 0 {
                format!(
                    "{short}; waiting for the others ({unlisted} member(s) of epoch {top} are not configured: list a replaced replica with \"retiring\": true until the change commits)"
                )
            } else {
                format!("{short}; waiting for the others")
            });
        } else if !configured {
            st.phase = Phase::Refused;
            st.reason = Some(format!(
                "a change to the membership of epoch {top} ({} indexers, writeQuorum {}) was begun and not finished; configure that set again (the replicas it replaced listed as retiring) to finish it",
                cur.m.len(),
                cur.w
            ));
        } else {
            // this set never had N - W + 1 admissions, so it never acknowledged a write: its admitted members and the
            // set it replaced still hold everything
            st.phase = Phase::Pending;
            st.finish = true;
            st.reason = Some(format!("finishing the membership change to epoch {top}: {short}"));
            st.target = cur.clone();
            st.prev = prev.clone();
            if !admitted.is_empty() {
                st.sources = admitted;
                st.sources_needed = 1;
            } else {
                match &prev {
                    None => {
                        // a change from a set without records: every listed replica is a source and takes a seal
                        st.sources = loaded.clone();
                        st.sources_needed = n;
                        st.seal_to = loaded.clone();
                        st.seal_needed = n;
                    }
                    Some(p) => {
                        let newest = |i: usize| recs.iter().find(|(j, _)| *j == i).and_then(|(_, rs)| rs.iter().max_by_key(|r| (r.d.s, r.admit())));
                        st.sources = loaded
                            .iter()
                            .copied()
                            .filter(|i| in_set(*i, p))
                            .filter(|i| newest(*i).is_some_and(|r| r.d.s == top || (r.admit() && r.d == *p)))
                            .collect();
                        st.sources_needed = rq(p);
                        st.seal_to = loaded.iter().copied().filter(|i| in_set(*i, p)).collect();
                        st.seal_needed = p.w as usize;
                    }
                }
            }
        }
        st
    }

    /// Deadline for one replica's commit-phase call (a few metadata calls in sequence).
    fn meta_deadline(&self) -> Duration {
        self.opts.meta_timeout * 4
    }

    /// Record a replica's last error. It is shown on the unauthenticated status page and /healthz, so callers never
    /// put key names in it (they log those separately).
    fn note(&self, i: usize, e: &str) {
        // never a signed indexer URL (store::redact): this text is public
        let e = crate::store::redact(e);
        eprintln!("[sia-s3] replica {}: {e}", self.replicas[i].name);
        *self.replicas[i].error.borrow_mut() = Some(e);
    }

    /// The next version, which must lie within the range this process has reserved (I1 in "Versions"). Without one,
    /// nothing is stamped and the write answers 503.
    fn stamp(&self) -> Res<u64> {
        let t = now_ms().max(self.clock.get() + 1);
        if t > self.ceiling.get() {
            self.stats.borrow_mut().refused_writes += 1;
            return Err(format!(
                "ServiceUnavailable: no version range is reserved for this write (ceiling {}, next version {t}); retry",
                self.ceiling.get()
            ));
        }
        self.clock.set(t);
        Ok(t)
    }

    /// The highest version-range ceiling found on any loaded replica.
    pub fn observed_ceiling(&self) -> u64 {
        self.observed.get()
    }

    /// The ceiling this process has acknowledged on a write quorum (0: none).
    pub fn version_ceiling(&self) -> u64 {
        self.ceiling.get()
    }

    /// The highest ceiling a replica admitted now must carry: every reservation this process acknowledged, and every
    /// one it observed (M2 in "Versions").
    fn known_ceiling(&self) -> u64 {
        self.version_ceiling().max(self.observed_ceiling())
    }

    /// `known_ceiling`, plus every ceiling a loaded replica holds right now (one pinned since the last rebuild, an
    /// unacknowledged reservation included): what admission requires, computed under the locks. None when a replica's
    /// index is held elsewhere (it never waits there).
    fn required_ceiling_now(&self) -> Option<u64> {
        let mut c = self.known_ceiling();
        for (_, s) in self.loaded() {
            c = c.max(s.idx.try_lock().ok()?.ceiling);
        }
        Some(c)
    }

    /// Make sure versions up to `low` ms past the next one may be stamped: otherwise reserve a new range, as a new
    /// ceiling object on every loaded replica, acknowledged by a write quorum of the acting membership's voters
    /// (joiners and retiring replicas get it too, but do not count: M1) before any version in it is used. Called
    /// outside the write lock (it uploads), before every stamping write, and by maintenance to renew early.
    pub async fn ensure_range(&self, low: u64) -> Res<()> {
        let enough = || self.ceiling.get() >= now_ms().max(self.clock.get() + 1).saturating_add(low);
        if enough() {
            return Ok(());
        }
        let _r = self.reserving.lock().await;
        if enough() {
            return Ok(());
        }
        let stores = self.loaded();
        let votes = self.votes(stores.iter().map(|(i, _)| *i));
        if votes < self.need() {
            return Err(self.refuse("version range", votes, &[]));
        }
        // strictly above every ceiling a previous writer may have stamped under (the clock is already above it)
        let c = now_ms().max(self.clock.get()).max(self.observed.get()).saturating_add(self.range_ms.get().max(low + 1));
        let acting = self.ms.borrow().acting.clone();
        let jobs = stores.into_iter().map(|(i, s)| (i, async move { s.write_ceiling(c).await })).collect();
        let (results, errs) = self.fan("version range", jobs, false, Result::is_ok).await;
        if self.ms.borrow().acting != acting {
            return Err("ServiceUnavailable: the membership changed during the version range reservation; retry".into());
        }
        // counted against the voters now: a membership commit meanwhile (it holds `reserving`, so it cannot be
        // under way) has either not happened, or happened before this reservation began
        let ok = self.votes(results.iter().filter(|(_, r)| r.is_ok()).map(|(i, _)| *i));
        if ok < self.need() {
            return Err(self.refuse("version range", ok, &errs));
        }
        self.ceiling.set(self.ceiling.get().max(c));
        let mut st = self.stats.borrow_mut();
        st.version_ceiling = self.ceiling.get();
        st.version_fence = "ceiling".into();
        Ok(())
    }

    fn refuse(&self, what: &str, ok: usize, errs: &[String]) -> String {
        self.stats.borrow_mut().refused_writes += 1;
        format!(
            "ServiceUnavailable: {what} reached {ok} of {} admitted replicas, {} required ({})",
            self.voters().len(),
            self.need(),
            if errs.is_empty() { "replicas not loaded or not admitted".to_string() } else { errs.join("; ") }
        )
    }

    /// Fan a call out to replicas with this cluster's quorum, grace and deadline; abandoned metadata calls mark their
    /// replica ambiguous. Returns the outcomes and the errors (abandoned calls included) for messages.
    async fn fan<T, F: Future<Output = Res<T>>>(
        &self,
        what: &str,
        jobs: Vec<(usize, F)>,
        metadata: bool,
        success: impl Fn(&Res<T>) -> bool,
    ) -> (Vec<(usize, Res<T>)>, Vec<String>) {
        let (grace, deadline) = if metadata {
            (self.timing.meta_grace, self.meta_deadline())
        } else {
            (self.timing.upload_grace, self.opts.upload_timeout + self.opts.meta_timeout * 4)
        };
        let voters = self.voters();
        let out = fan_out(jobs, self.need(), grace, deadline, |i, r| voters.contains(&i) && success(r)).await;
        let mut done = Vec::new();
        let mut errs = Vec::new();
        for (i, r) in out {
            match r {
                Some(Ok(v)) => done.push((i, Ok(v))),
                Some(Err(e)) => {
                    self.note(i, &format!("{what}: {e}"));
                    errs.push(format!("{}: {e}", self.replicas[i].name));
                    done.push((i, Err(e)));
                }
                None => {
                    self.stats.borrow_mut().abandoned_calls += 1;
                    if metadata {
                        if let Some(s) = self.store(i) {
                            s.mark_ambiguous();
                        }
                    }
                    self.note(i, &format!("{what}: abandoned after the quorum's grace period or the deadline"));
                    errs.push(format!("{}: no answer in time", self.replicas[i].name));
                }
            }
        }
        (done, errs)
    }

    /// Join a replica whose index has loaded, and merge it into the view.
    pub async fn attach(&self, i: usize, store: Rc<Store>) {
        let _w = self.write.lock().await;
        *self.replicas[i].store.borrow_mut() = Some(store);
        *self.replicas[i].error.borrow_mut() = None;
        self.rebuild().await;
    }

    /// Re-read a replica's index from its indexer and swap it in, unless the replica changed meanwhile. The
    /// replica's ambiguity time carries over: a listing that began before the last unknown outcome leaves it dirty.
    ///
    /// Not every change to a replica runs under the write lock: the compactor, UploadPart, AbortMultipartUpload, the
    /// orphan sweep, a DELETE's floor write and repair's part copies go through the store directly, and may hold the
    /// old `Rc` across the swap. So the swap happens only when the old store is provably quiet, and the old store is
    /// retired in the same step (no await in between):
    ///   - its index is not held by anyone (`try_lock`; never a wait while holding the write lock, so a long
    ///     compaction neither stalls writes nor can deadlock against the write -> index lock order);
    ///   - no remote change succeeded since the re-read began (`changes`), and none is in flight (`in_flight`);
    ///   - then `retire`: any later pin or delete through the old `Rc` is refused before it is sent.
    /// Otherwise the re-read is discarded and maintenance tries again next pass (the replica stays dirty).
    /// The fresh index carries its own listing of membership records and ceilings; `rebuild` recomputes the
    /// membership state and the observed ceiling from it (a re-read can reveal a seal or admission applied late).
    pub async fn reconcile(&self, i: usize) -> Res<()> {
        let old = self.store(i).ok_or("not loaded")?;
        let before = old.changes.get();
        let mut fresh = Store::load_with(old.sdk.clone(), old.compact_max_object, old.opts.clone()).await?;
        let _w = self.write.lock().await;
        let same = self.store(i).is_some_and(|s| Rc::ptr_eq(&s, &old));
        if !same {
            return Err("the replica changed while it was being re-read".into());
        }
        let Ok(old_idx) = old.idx.try_lock() else {
            return Err("the replica is busy (compaction, an upload or a sweep holds its index); re-read next pass".into());
        };
        if old.changes.get() != before || old.in_flight() > 0 {
            return Err("the replica changed, or has a change in flight, while it was being re-read".into());
        }
        // from here to the swap nothing awaits: the old store is quiet, and stays so
        old.retire();
        fresh.ambiguous_ms.set(old.ambiguous_ms.get());
        *fresh.stats.borrow_mut() = old.stats.borrow().clone();
        {
            // uploads begun here but with no part yet exist only in memory (fresh is not shared yet: no lock to wait on)
            let fi = fresh.idx.get_mut();
            for (id, u) in old_idx.uploads.iter() {
                fi.uploads.entry(id.clone()).or_insert_with(|| crate::store::Upload {
                    b: u.b.clone(),
                    k: u.k.clone(),
                    started: u.started,
                    parts: BTreeMap::new(),
                });
            }
        }
        drop(old_idx);
        *self.replicas[i].store.borrow_mut() = Some(Rc::new(fresh));
        self.rebuild().await;
        self.stats.borrow_mut().reconciled += 1;
        Ok(())
    }

    /// Recompute the whole merged view from the loaded replicas.
    pub async fn rebuild(&self) {
        let mut v = View::default();
        let mut clock = self.clock.get();
        let mut observed = self.observed.get();
        for (_, s) in self.loaded() {
            let idx = s.idx.lock().await;
            // I2: never stamp at or below a ceiling a previous writer may have stamped under (M3: every loaded
            // replica, joiners and retiring ones included, and the ceilings membership records carry)
            observed = observed.max(idx.version_floor());
            for (kk, k) in &idx.keys {
                clock = clock.max(k.entry.ver().h);
                if v.keys.get(kk).is_none_or(|e| k.entry.ver() > e.ver()) {
                    let mut e = k.entry.clone();
                    e.x.clear();
                    v.keys.insert(kk.clone(), e);
                }
            }
            let held = idx.tombs.iter().flat_map(|(q, ts)| ts.iter().map(move |(_, t)| (q, t)));
            for (q, t) in held.chain(idx.floors.iter()) {
                clock = clock.max(t.h);
                if v.tombs.get(q).is_none_or(|c| t.ver() > c.ver()) {
                    v.tombs.insert(q.clone(), t.clone());
                }
            }
            for o in idx.oldest.values() {
                clock = clock.max(o.h);
            }
        }
        let tombs = &v.tombs;
        v.keys.retain(|kk, e| tombs.get(&qkey(&kk.0, &kk.1)).is_none_or(|t| t.ver() < e.ver()));
        self.observed.set(observed);
        // I2. A ceiling at or below this writer's own acknowledged one is its own reservation, or an earlier
        // writer's that it already started above (its clock only moves forward): jumping to it would only burn the
        // range. Any higher ceiling (always at boot, when it has none) moves the clock past it.
        if observed > self.ceiling.get() {
            clock = clock.max(observed);
        }
        self.clock.set(clock);
        {
            let mut st = self.stats.borrow_mut();
            st.observed_ceiling = observed;
            if st.version_fence.is_empty() {
                st.version_fence = "legacy".into();
            }
        }
        *self.view.borrow_mut() = v;
        let mut recs = Vec::new();
        for (i, s) in self.loaded() {
            recs.push((i, s.idx.lock().await.records.iter().map(|(_, r)| r.clone()).collect()));
        }
        let st = self.membership(&recs);
        let was = self.ms.replace(st.clone());
        if (was.phase, was.ready, &was.acting, &was.target, &was.voters) != (st.phase, st.ready, &st.acting, &st.target, &st.voters) {
            eprintln!(
                "[sia-s3] membership: {:?}{}, epoch {} -> {}, {} voting of {} needed{}",
                st.phase,
                if st.ready { " (ready)" } else { "" },
                st.acting.as_ref().map_or(0, |a| a.s),
                st.target.s,
                st.voters.len(),
                st.need,
                st.reason.as_ref().map(|r| format!(": {r}")).unwrap_or_default()
            );
        }
    }

    /// Recompute one key of the merged view.
    async fn refresh_key(&self, kk: &KK) {
        let q = qkey(&kk.0, &kk.1);
        let (mut live, mut tomb): (Option<Entry>, Option<Tomb>) = (None, None);
        for (_, s) in self.loaded() {
            let idx = s.idx.lock().await;
            if let Some(k) = idx.keys.get(kk) {
                if live.as_ref().is_none_or(|e| k.entry.ver() > e.ver()) {
                    live = Some(k.entry.clone());
                }
            }
            if let Some(t) = idx.tomb(&q) {
                if tomb.as_ref().is_none_or(|c| t.ver() > c.ver()) {
                    tomb = Some(t.clone());
                }
            }
        }
        let mut v = self.view.borrow_mut();
        match live.filter(|e| tomb.as_ref().is_none_or(|t| t.ver() < e.ver())) {
            Some(mut e) => {
                e.x.clear();
                v.keys.insert(kk.clone(), e);
            }
            None => {
                v.keys.remove(kk);
            }
        }
        match tomb {
            Some(t) => v.tombs.insert(q, t),
            None => v.tombs.remove(&q),
        };
    }

    pub fn lookup(&self, b: &str, k: &str) -> Option<Entry> {
        self.view.borrow().keys.get(&(b.to_string(), k.to_string())).cloned()
    }

    /// Can some loaded replica serve `[start, start+len)` of version `e` from its index? Checked before a GET sends
    /// its head, so a version no replica can serve answers 500 rather than a short body.
    pub async fn servable(&self, e: &Entry, start: u64, len: u64) -> Res<()> {
        let kk = (e.b.clone(), e.k.clone());
        let mut last = "no loaded replica holds this version".to_string();
        for (_, s) in self.loaded() {
            let idx = s.idx.lock().await;
            if let Some(k) = idx.keys.get(&kk).filter(|k| k.entry.ver() == e.ver()) {
                match idx.segments(k, start, len) {
                    Ok(_) => return Ok(()),
                    Err(err) => last = err,
                }
            }
        }
        Err(last)
    }

    /// Stream `[start, start+len)` of version `e` into `w` from any replica holding exactly that version, failing
    /// over to the next one and resuming at the first byte not yet written. Each segment read has a deadline of the
    /// stall time plus one second per MiB, so a hung replica costs at most that.
    pub async fn read<W: AsyncWrite + Unpin>(&self, e: &Entry, start: u64, len: u64, w: &mut W) -> Res<u64> {
        if len == 0 {
            return Ok(0);
        }
        let kk = (e.b.clone(), e.k.clone());
        let ver = e.ver();
        let mut sent = 0u64;
        let mut errs = Vec::new();
        for (i, s) in self.loaded() {
            let segs = {
                let idx = s.idx.lock().await;
                match idx.keys.get(&kk) {
                    Some(k) if k.entry.ver() == ver => idx.segments(k, start + sent, len - sent),
                    _ => continue,
                }
            };
            let segs = match segs {
                Ok(s) => s,
                Err(e) => {
                    errs.push(format!("{}: {e}", self.replicas[i].name));
                    continue;
                }
            };
            let mut tap = Tap::new(w, false);
            let mut failed = None;
            for (obj, off, n) in segs {
                let deadline = self.timing.stall + Duration::from_secs(n >> 20);
                match tokio::time::timeout(deadline, s.read_into(&obj, off, n, &mut tap)).await {
                    Ok(Ok(_)) => {}
                    Ok(Err(e)) => {
                        failed = Some(e);
                        break;
                    }
                    Err(_) => {
                        failed = Some(format!("no progress within {deadline:?}"));
                        break;
                    }
                }
            }
            sent += tap.n;
            match failed {
                None if sent == len => return Ok(sent),
                None => return Err(format!("short read {sent}/{len}")),
                Some(e) => {
                    eprintln!("[sia-s3] GET {}/{}: replica {} failed after {sent} bytes", kk.0, kk.1, self.replicas[i].name);
                    self.note(i, &format!("read: {e}"));
                    errs.push(format!("{}: {e}", self.replicas[i].name));
                }
            }
        }
        Err(if errs.is_empty() { "no loaded replica holds this version".into() } else { errs.join("; ") })
    }

    pub fn check(&self, b: &str, k: &str, cond: &Cond) -> Res<()> {
        cond_ok(&self.view.borrow(), &(b.to_string(), k.to_string()), cond)
    }

    fn staged(&self, what: &str, results: Vec<(usize, Res<Object>)>, errs: Vec<String>) -> Res<Staged> {
        let objs: Vec<(usize, Object)> = results.into_iter().filter_map(|(i, r)| r.ok().map(|o| (i, o))).collect();
        let votes = self.votes(objs.iter().map(|(i, _)| *i));
        if votes < self.need() {
            return Err(self.refuse(what, votes, &errs));
        }
        Ok(Staged { objs })
    }

    /// Upload a buffered body to every loaded replica.
    pub async fn upload(&self, body: Vec<u8>) -> Res<Staged> {
        let stores = self.targets();
        if self.votes(stores.iter().map(|(i, _)| *i)) < self.need() {
            return Err(self.refuse("upload", 0, &[]));
        }
        let body: Rc<[u8]> = body.into();
        let jobs = stores
            .into_iter()
            .map(|(i, s)| {
                let body = body.clone();
                (i, async move { s.upload(body).await })
            })
            .collect();
        let (results, errs) = self.fan("upload", jobs, false, Result::is_ok).await;
        self.staged("upload", results, errs)
    }

    /// Upload a body streamed from `reader` to every loaded replica at once. A replica whose upload fails, or that
    /// stops taking data for the stall time, is dropped from the tee; the others continue. A reader that ends early
    /// ends every upload short; the caller's size and hash checks refuse those.
    pub async fn upload_reader<R: AsyncRead + Unpin>(&self, mut reader: R) -> Res<Staged> {
        let stores = self.targets();
        if self.votes(stores.iter().map(|(i, _)| *i)) < self.need() {
            return Err(self.refuse("upload", 0, &[]));
        }
        let mut txs = Vec::new();
        let mut jobs = Vec::new();
        for (i, s) in stores {
            let (tx, rx) = tokio::io::duplex(1 << 20);
            txs.push(Some(tx));
            jobs.push((i, async move { s.upload_reader(rx).await }));
        }
        let stall = self.timing.stall;
        let pump = async {
            let mut buf = vec![0u8; 256 << 10];
            loop {
                let n = match reader.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let mut live = false;
                for slot in txs.iter_mut() {
                    if let Some(tx) = slot {
                        if matches!(tokio::time::timeout(stall, tx.write_all(&buf[..n])).await, Ok(Ok(()))) {
                            live = true;
                        } else {
                            *slot = None;
                        }
                    }
                }
                if !live {
                    break;
                }
            }
            for tx in txs.iter_mut().flatten() {
                let _ = tokio::time::timeout(stall, tx.shutdown()).await;
            }
            txs.clear();
        };
        let ((), (results, errs)) = tokio::join!(pump, self.fan("upload", jobs, false, Result::is_ok));
        self.staged("upload", results, errs)
    }

    /// Drop staged uploads that will not be committed. Nothing was pinned as an object, so there is nothing to
    /// delete: `prune_slabs` reclaims the slabs.
    pub async fn discard(&self, staged: Staged) {
        drop(staged);
    }

    pub async fn put(&self, b: &str, k: &str, body: Vec<u8>, ct: Option<String>, cond: &Cond) -> Res<String> {
        self.check(b, k, cond)?;
        let etag = md5_hex(&body);
        let size = body.len() as u64;
        let staged = self.upload(body).await?;
        self.commit(b, k, staged, etag.clone(), size, ct, cond).await?;
        Ok(etag)
    }

    /// Make staged uploads the key's content as one new version: placements (manifests, if the entry does not fit
    /// inline) are uploaded first, outside the write lock; then, under it, the condition is checked again and the
    /// version committed.
    #[allow(clippy::too_many_arguments)]
    pub async fn commit(&self, b: &str, k: &str, staged: Staged, etag: String, size: u64, ct: Option<String>, cond: &Cond) -> Res<()> {
        let proto = Entry { b: b.into(), k: k.into(), s: size, t: etag, m: 0, c: ct, x: vec![], h: 0, i: String::new() };
        let jobs = staged
            .objs
            .into_iter()
            .filter_map(|(i, o)| {
                let (s, proto) = (self.store(i)?, proto.clone());
                Some((i, async move { s.stage_put(&o, &proto).await.map(|p| (o, p)) }))
            })
            .collect();
        let (placed, errs) = self.fan("place", jobs, false, Result::is_ok).await;
        let placed: Vec<(usize, (Object, Placement))> = placed.into_iter().filter_map(|(i, r)| r.ok().map(|p| (i, p))).collect();
        let votes = self.votes(placed.iter().map(|(i, _)| *i));
        if votes < self.need() {
            return Err(self.refuse("PUT", votes, &errs));
        }

        self.ensure_range(STAMP_LOW_MS).await?;
        let _w = self.write.lock().await;
        let kk = (b.to_string(), k.to_string());
        self.check(b, k, cond)?;
        let entry = Entry { m: now(), h: self.stamp()?, i: new_wid(), ..proto };
        let jobs = placed
            .into_iter()
            .filter_map(|(i, (o, p))| {
                let (s, e) = (self.store(i)?, entry.clone());
                Some((i, async move { s.commit_put(o, p, e, false).await }))
            })
            .collect();
        let (results, errs) = self.fan("PUT", jobs, true, committed).await;
        let ok = self.votes(results.iter().filter(|(_, r)| committed(r)).map(|(i, _)| *i));
        self.refresh_key(&kk).await;
        if ok >= self.need() { Ok(()) } else { Err(self.refuse("PUT", ok, &errs)) }
    }

    pub async fn copy(&self, src: (&str, &str), dst: (&str, &str)) -> Res<(String, i64)> {
        let skk = (src.0.to_string(), src.1.to_string());
        let dkk = (dst.0.to_string(), dst.1.to_string());
        let se = self.view.borrow().keys.get(&skk).cloned();
        let Some(se) = se else { return Err("NoSuchKey".into()) };
        if skk == dkk {
            return Ok((se.t, se.m));
        }
        let sv = se.ver();
        let proto = Entry { b: dkk.0.clone(), k: dkk.1.clone(), m: 0, h: 0, i: String::new(), x: vec![], ..se };
        let jobs = self
            .targets()
            .into_iter()
            .map(|(i, s)| {
                let (skk, sv, proto) = (skk.clone(), sv.clone(), proto.clone());
                (i, async move { s.stage_copy(&skk, &sv, &proto).await })
            })
            .collect();
        let (placed, errs) = self.fan("copy", jobs, false, |r| matches!(r, Ok(Some(_)))).await;
        let placed: Vec<(usize, Placement)> = placed.into_iter().filter_map(|(i, r)| r.ok().flatten().map(|p| (i, p))).collect();
        let votes = self.votes(placed.iter().map(|(i, _)| *i));
        if votes < self.need() {
            return Err(self.refuse("copy", votes, &errs));
        }

        self.ensure_range(STAMP_LOW_MS).await?;
        let _w = self.write.lock().await;
        if self.view.borrow().keys.get(&skk).map(|e| e.ver()) != Some(sv.clone()) {
            return Err("ServiceUnavailable: the copy source changed while the copy was prepared; retry".into());
        }
        let d = Entry { m: now(), h: self.stamp()?, i: new_wid(), ..proto };
        let jobs = placed
            .into_iter()
            .filter_map(|(i, p)| {
                let (s, skk, sv, d) = (self.store(i)?, skk.clone(), sv.clone(), d.clone());
                Some((i, async move { s.commit_copy(&skk, &sv, d, p).await }))
            })
            .collect();
        let (results, errs) = self.fan("copy", jobs, true, committed).await;
        let ok = self.votes(results.iter().filter(|(_, r)| committed(r)).map(|(i, _)| *i));
        self.refresh_key(&dkk).await;
        if ok >= self.need() { Ok((d.t, d.m)) } else { Err(self.refuse("copy", ok, &errs)) }
    }

    pub async fn delete(&self, b: &str, k: &str) -> Res<()> {
        let kk = (b.to_string(), k.to_string());
        let q = qkey(b, k);
        // a live key gets a new deletion version: reserve its range first (outside the lock: it may upload)
        if self.view.borrow().keys.contains_key(&kk) {
            self.ensure_range(STAMP_LOW_MS).await?;
        }
        let (t, errs) = {
            let _w = self.write.lock().await;
            let votes = self.votes(self.targets().into_iter().map(|(i, _)| i));
            if votes < self.need() {
                return Err(self.refuse("DELETE", votes, &[]));
            }
            let (live, tomb) = {
                let v = self.view.borrow();
                (v.keys.contains_key(&kk), v.tombs.get(&q).cloned())
            };
            let t = match (live, tomb) {
                (true, _) => Tomb { q: q.clone(), h: self.stamp()?, i: new_wid() },
                // deleted already, perhaps not yet durably (a retried 503): record it wherever it is still missing
                (false, Some(t)) => t,
                (false, None) => return Ok(()),
            };
            let jobs = self
                .targets()
                .into_iter()
                .map(|(i, s)| {
                    let (kk, t) = (kk.clone(), t.clone());
                    (i, async move { s.tombstone(&kk, &t).await })
                })
                .collect();
            let (_, errs) = self.fan("DELETE", jobs, true, committed).await;
            self.refresh_key(&kk).await;
            (t, errs)
        };
        let (mut recorded, mut missing) = self.recorded(&t).await;
        let mut errs = errs;
        if recorded < self.need() && !missing.is_empty() {
            // the others record the deletion as a floor in a new ledger (an upload, so outside the write lock:
            // floors only ever add, and a floor hides the key wherever it is)
            let jobs = missing
                .drain(..)
                .map(|(i, s)| {
                    let t = t.clone();
                    (i, async move { s.write_ledger(vec![t]).await })
                })
                .collect();
            let (_, more) = self.fan("DELETE floor", jobs, false, Result::is_ok).await;
            errs.extend(more);
            recorded = self.recorded(&t).await.0;
        }
        if recorded >= self.need() {
            Ok(())
        } else {
            self.stats.borrow_mut().refused_writes += 1;
            Err(format!(
                "ServiceUnavailable: DELETE recorded durably on {recorded} of {} admitted replicas, {} required{}",
                self.voters().len(),
                self.need(),
                if errs.is_empty() { String::new() } else { format!(" ({})", errs.join("; ")) }
            ))
        }
    }

    /// Voters that durably hold deletion `t` (a tombstone or floor at least as new), and the write targets that do
    /// not (a floor in a new ledger records it there, whether or not they hold the key).
    async fn recorded(&self, t: &Tomb) -> (usize, Vec<(usize, Rc<Store>)>) {
        let voters = self.voters();
        let mut recorded = 0;
        let mut missing = Vec::new();
        for (i, s) in self.targets() {
            if s.idx.lock().await.tomb(&t.q).is_some_and(|x| x.ver() >= t.ver()) {
                recorded += voters.contains(&i) as usize;
            } else {
                missing.push((i, s.clone()));
            }
        }
        (recorded, missing)
    }

    async fn find_upload(&self, uid: &str) -> Option<(String, String, i64)> {
        for (_, s) in self.loaded() {
            if let Some(u) = s.idx.lock().await.uploads.get(uid) {
                return Some((u.b.clone(), u.k.clone(), u.started));
            }
        }
        None
    }

    pub async fn create_upload(&self, b: &str, k: &str) -> Res<String> {
        let stores = self.targets();
        let votes = self.votes(stores.iter().map(|(i, _)| *i));
        if votes < self.need() {
            return Err(self.refuse("CreateMultipartUpload", votes, &[]));
        }
        let uid = new_id();
        let started = now();
        for (_, s) in stores {
            s.ensure_upload(&uid, b, k, started).await;
        }
        Ok(uid)
    }

    /// (upload id, bucket, key, started) of every open upload any loaded replica knows.
    pub async fn uploads(&self) -> Vec<(String, String, String, i64)> {
        let mut out: BTreeMap<String, (String, String, i64)> = BTreeMap::new();
        for (_, s) in self.loaded() {
            for (id, u) in &s.idx.lock().await.uploads {
                out.entry(id.clone()).or_insert((u.b.clone(), u.k.clone(), u.started));
            }
        }
        out.into_iter().map(|(id, (b, k, t))| (id, b, k, t)).collect()
    }

    pub async fn upload_part(&self, uid: &str, n: u32, body: Vec<u8>) -> Res<String> {
        let (b, k, started) = self.find_upload(uid).await.ok_or("NoSuchUpload")?;
        let stores = self.targets();
        let acting = self.ms.borrow().acting.clone();
        if self.votes(stores.iter().map(|(i, _)| *i)) < self.need() {
            return Err(self.refuse("UploadPart", 0, &[]));
        }
        let body: Rc<[u8]> = body.into();
        let etag = md5_hex(&body);
        let jobs = stores
            .into_iter()
            .map(|(i, s)| {
                let (body, b, k) = (body.clone(), b.clone(), k.clone());
                (i, async move {
                    s.ensure_upload(uid, &b, &k, started).await;
                    s.upload_part(uid, n, body).await
                })
            })
            .collect();
        let (results, errs) = self.fan("UploadPart", jobs, false, Result::is_ok).await;
        if !results.is_empty() && results.iter().all(|(_, r)| matches!(r, Err(e) if e == "NoSuchUpload")) {
            return Err("NoSuchUpload".into()); // aborted meanwhile
        }
        // parts are uploaded outside the write lock, but counted under it: a membership commit (which holds it) sees
        // every part acknowledged before it, and a part that straddled a commit is refused and retried. (A member
        // admitted meanwhile to the same set changes nothing: a W set of the members admitted when the part was
        // acknowledged meets every later N - W + 1 set of admitted members.)
        let _w = self.write.lock().await;
        if self.ms.borrow().acting != acting {
            return Err("ServiceUnavailable: the membership changed during the upload; retry".into());
        }
        let ok = self.votes(results.iter().filter(|(_, r)| r.is_ok()).map(|(i, _)| *i));
        if ok >= self.need() { Ok(etag) } else { Err(self.refuse("UploadPart", ok, &errs)) }
    }

    pub async fn complete_upload(&self, uid: &str, want: &[(u32, String)]) -> Res<(String, String, String)> {
        let (b, k, _) = self.find_upload(uid).await.ok_or("NoSuchUpload")?;
        let mut holders = Vec::new();
        for (i, s) in self.targets() {
            if s.idx.lock().await.uploads.contains_key(uid) {
                holders.push((i, s));
            }
        }
        let jobs = holders.iter().map(|(i, s)| (*i, async move { s.stage_complete(uid, want).await })).collect();
        let (staged, errs) = self.fan("CompleteMultipartUpload", jobs, false, Result::is_ok).await;
        let client = staged
            .iter()
            .find_map(|(_, r)| r.as_ref().err().filter(|e| e.starts_with("InvalidPart") || e.starts_with("NoSuchUpload")).cloned());
        let staged: Vec<(usize, Completion)> = staged.into_iter().filter_map(|(i, r)| r.ok().map(|c| (i, c))).collect();
        let votes = self.votes(staged.iter().map(|(i, _)| *i));
        if votes < self.need() {
            return Err(match (staged.len(), client) {
                (0, Some(e)) => e, // the request itself is wrong
                _ => self.refuse("CompleteMultipartUpload", votes, &errs),
            });
        }

        self.ensure_range(STAMP_LOW_MS).await?;
        let _w = self.write.lock().await;
        let (m, h, wid) = (now(), self.stamp()?, new_wid());
        let jobs = staged
            .into_iter()
            .filter_map(|(i, c)| {
                let (s, wid) = (self.store(i)?, wid.clone());
                Some((i, async move { s.commit_complete(uid, c, m, h, &wid).await }))
            })
            .collect();
        let (results, errs) = self.fan("CompleteMultipartUpload", jobs, true, Result::is_ok).await;
        let ok = self.votes(results.iter().filter(|(_, r)| r.is_ok()).map(|(i, _)| *i));
        if ok >= self.need() {
            // a replica that did not complete keeps no half upload: repair copies the completed key to it
            for (i, s) in &holders {
                if !results.iter().any(|(j, r)| j == i && r.is_ok()) {
                    let _ = tokio::time::timeout(self.meta_deadline(), s.abort_upload(uid)).await;
                }
            }
        }
        self.refresh_key(&(b.clone(), k.clone())).await;
        let etag = results.into_iter().find_map(|(_, r)| r.ok()).map(|r| r.2);
        match etag {
            Some(etag) if ok >= self.need() => Ok((b, k, etag)),
            _ => Err(self.refuse("CompleteMultipartUpload", ok, &errs)),
        }
    }

    pub async fn abort_upload(&self, uid: &str) -> Res<()> {
        let jobs = self.loaded().into_iter().map(|(i, s)| (i, async move { s.abort_upload(uid).await })).collect();
        let out = fan_out(jobs, usize::MAX, Duration::ZERO, self.meta_deadline(), |_, r| r.is_ok()).await;
        let mut found = false;
        let mut errs = Vec::new();
        for (i, r) in out {
            match r {
                Some(Ok(())) => found = true,
                Some(Err(e)) if e == "NoSuchUpload" => {}
                Some(Err(e)) => {
                    found = true;
                    self.note(i, &format!("AbortMultipartUpload: {e}"));
                    errs.push(format!("{}: {e}", self.replicas[i].name));
                }
                None => {
                    found = true;
                    errs.push(format!("{}: no answer in time", self.replicas[i].name));
                }
            }
        }
        match (found, errs.is_empty()) {
            (false, _) => Err("NoSuchUpload".into()),
            (true, true) => Ok(()),
            (true, false) => Err(format!("ServiceUnavailable: AbortMultipartUpload: {}", errs.join("; "))),
        }
    }

    /// Copy version `e` (from whichever replica serves it) into a new upload on `target`, checked against its size
    /// and, for single-part ETags, its MD5.
    async fn copy_version(&self, e: &Entry, target: &Store) -> Res<Object> {
        if e.s == 0 {
            return target.upload(Rc::from(&[][..])).await;
        }
        let (mut tx, rx) = tokio::io::duplex(4 << 20);
        let pump = async {
            let mut tap = Tap::new(&mut tx, true);
            let r = self.read(e, 0, e.s, &mut tap).await;
            let md5 = tap.md5.take().map(|m| hex::encode(m.finalize()));
            drop(tap);
            let _ = tx.shutdown().await;
            drop(tx);
            (r, md5)
        };
        let ((read, md5), up) = tokio::join!(pump, target.upload_reader(rx));
        let obj = up?;
        let bad = match read {
            Ok(n) if n == e.s => (!e.t.contains('-') && md5.as_deref() != Some(e.t.as_str())).then(|| "MD5 differs from the ETag".to_string()),
            Ok(n) => Some(format!("read {n} of {} bytes", e.s)),
            Err(err) => Some(err),
        };
        match bad {
            Some(err) => Err(err),
            None => Ok(obj),
        }
    }

    /// One maintenance pass: re-read ambiguous replicas, purge dead versions, apply missed deletes, copy up to
    /// `max_bytes` of newest versions and open multipart parts to members that lack them, collect tombstones behind
    /// the barrier, then admit members that hold everything (or commit a membership change).
    pub async fn repair(&self, max_bytes: u64) -> RepairReport {
        let mut rep = RepairReport::default();
        for (i, s) in self.loaded() {
            // dirty: the index may lack objects an unknown outcome created
            if s.dirty() {
                match self.reconcile(i).await {
                    Ok(()) => rep.reconciled += 1,
                    Err(e) => {
                        self.note(i, &format!("reconcile: {e}"));
                        rep.pending += 1;
                    }
                }
            }
        }
        for (i, s) in self.loaded() {
            match s.purge_dead(64).await {
                Ok(n) => rep.purged += n,
                Err(e) => {
                    self.note(i, &format!("purge: {e}"));
                    rep.pending += 1;
                }
            }
        }
        if rep.purged > 0 {
            self.rebuild().await;
        }

        if self.n() > 1 {
            let spent = self.repair_replicas(max_bytes, &mut rep).await;
            self.repair_parts(max_bytes, spent, &mut rep).await;
        }
        self.floors(&mut rep).await;
        self.ceilings(&mut rep).await;
        self.admission(&mut rep).await;
        let mut st = self.stats.borrow_mut();
        st.repair_passes += 1;
        st.repaired_copies += rep.copies as u64;
        st.repaired_deletes += rep.deletes as u64;
        st.purged_versions += rep.purged as u64;
        st.floors_written += rep.floors as u64;
        st.reclaimed_tombstones += rep.reclaimed as u64;
        st.last_repair = Some(chrono::Utc::now().to_rfc3339());
        st.last_repair_error = (rep.pending > 0).then(|| format!("{} items left for the next pass", rep.pending));
        rep
    }

    /// Returns the bytes copied.
    async fn repair_replicas(&self, max_bytes: u64, rep: &mut RepairReport) -> u64 {
        let (keys, tombs) = {
            let v = self.view.borrow();
            (v.keys.clone(), v.tombs.clone())
        };
        let mut copies: Vec<(usize, Entry)> = Vec::new();
        let mut deletes: Vec<(usize, KK, Tomb)> = Vec::new();
        for (i, s) in self.backfill_targets() {
            let idx = s.idx.lock().await;
            for (kk, e) in &keys {
                if idx.keys.get(kk).is_none_or(|k| k.entry.ver() < e.ver()) {
                    copies.push((i, e.clone()));
                }
            }
            for (kk, k) in &idx.keys {
                if let Some(t) = tombs.get(&qkey(&kk.0, &kk.1)).filter(|t| k.entry.ver() < t.ver()) {
                    deletes.push((i, kk.clone(), t.clone()));
                }
            }
        }

        for (i, kk, t) in deletes {
            let _w = self.write.lock().await;
            let Some(s) = self.store(i) else { continue };
            match tokio::time::timeout(self.meta_deadline(), s.tombstone(&kk, &t)).await {
                Ok(Ok(_)) => rep.deletes += 1,
                Ok(Err(e)) => {
                    self.note(i, &format!("repair delete: {e}"));
                    rep.pending += 1;
                }
                Err(_) => {
                    s.mark_ambiguous();
                    self.note(i, "repair delete: no answer in time");
                    rep.pending += 1;
                }
            }
            self.refresh_key(&kk).await;
        }

        let mut spent = 0u64;
        for (i, e) in copies {
            if spent > 0 && spent + e.s > max_bytes {
                rep.pending += 1;
                continue;
            }
            spent += e.s;
            let Some(target) = self.store(i) else { continue };
            let staged = async {
                let obj = self.copy_version(&e, &target).await?;
                let p = target.stage_put(&obj, &e).await?;
                Ok::<_, String>((obj, p))
            };
            let (obj, placement) = match tokio::time::timeout(self.opts.upload_timeout * 2, staged).await {
                Ok(Ok(v)) => v,
                Ok(Err(err)) => {
                    eprintln!("[sia-s3] repair: copy of {}/{} to {} failed", e.b, e.k, self.replicas[i].name);
                    self.note(i, &format!("repair copy: {err}"));
                    rep.pending += 1;
                    continue;
                }
                Err(_) => {
                    self.note(i, "repair copy: no completion in time");
                    rep.pending += 1;
                    continue;
                }
            };
            let _w = self.write.lock().await;
            let kk = (e.b.clone(), e.k.clone());
            // the key may have been written or deleted while the copy ran
            let current = self.view.borrow().keys.get(&kk).is_some_and(|v| v.ver() == e.ver());
            if !current {
                continue;
            }
            match tokio::time::timeout(self.meta_deadline(), target.commit_put(obj, placement, e.clone(), false)).await {
                Ok(Ok(_)) => rep.copies += 1,
                Ok(Err(err)) => {
                    self.note(i, &format!("repair commit: {err}"));
                    rep.pending += 1;
                }
                Err(_) => {
                    target.mark_ambiguous();
                    self.note(i, "repair commit: no answer in time");
                    rep.pending += 1;
                }
            }
            self.refresh_key(&kk).await;
        }
        spent
    }

    /// Every part of an open multipart upload the sources hold: (upload, part number) -> the variants held
    /// (ETag, size), each with the source replicas and their part objects, the most widely held first. With `wait`
    /// false (under the write lock) a source whose index is held elsewhere gives None instead of a wait.
    async fn source_parts(&self, sources: &[usize], wait: bool) -> Option<BTreeMap<(String, u32), Vec<PartVariant>>> {
        let mut out: BTreeMap<(String, u32), Vec<PartVariant>> = BTreeMap::new();
        for i in sources {
            let Some(s) = self.store(*i) else { continue };
            let idx = if wait { s.idx.lock().await } else { s.idx.try_lock().ok()? };
            for (uid, u) in &idx.uploads {
                for (n, (id, etag, size)) in &u.parts {
                    let Some((obj, _)) = idx.objs.get(id) else { continue };
                    let vs = out.entry((uid.clone(), *n)).or_default();
                    match vs.iter_mut().find(|v| v.etag == *etag && v.size == *size) {
                        Some(v) => v.held.push((*i, obj.clone())),
                        None => vs.push(PartVariant {
                            b: u.b.clone(),
                            k: u.k.clone(),
                            started: u.started,
                            etag: etag.clone(),
                            size: *size,
                            held: vec![(*i, obj.clone())],
                        }),
                    }
                }
            }
        }
        for vs in out.values_mut() {
            vs.sort_by_key(|v| std::cmp::Reverse(v.held.len()));
        }
        Some(out)
    }

    /// Copy open multipart parts the sources hold to members that lack them, within what is left of `max_bytes`.
    /// A member that votes keeps any part it holds (its acknowledgement may be the one that counted); a member
    /// that does not vote yet has a part no source holds replaced.
    async fn repair_parts(&self, max_bytes: u64, mut spent: u64, rep: &mut RepairReport) {
        let sources = self.ms.borrow().sources.clone();
        let wanted = self.source_parts(&sources, true).await.unwrap_or_default();
        if wanted.is_empty() {
            return;
        }
        let voters = self.voters();
        for (i, target) in self.backfill_targets() {
            for ((uid, n), vs) in &wanted {
                if vs.len() > 1 {
                    // the sources disagree about this part (it was uploaded again while some missed it): parts carry no
                    // version, so which one the client last had acknowledged is unknown. Nothing is copied; a change
                    // waits until the upload is completed or aborted (`caught_up`).
                    rep.pending += 1;
                    continue;
                }
                let held = target.idx.lock().await.uploads.get(uid).and_then(|u| u.parts.get(n)).map(|p| (p.1.clone(), p.2));
                let fine = match &held {
                    None => false,
                    Some(_) if voters.contains(&i) => true,
                    Some((etag, size)) => vs[0].etag == *etag && vs[0].size == *size,
                };
                if fine {
                    continue;
                }
                let v = &vs[0];
                if spent > 0 && spent + v.size > max_bytes {
                    rep.pending += 1;
                    continue;
                }
                spent += v.size;
                let copy = async {
                    let obj = self.copy_part(v, &target).await?;
                    target.adopt_part(uid, &v.b, &v.k, v.started, *n, (&v.etag, v.size), obj).await
                };
                match tokio::time::timeout(self.opts.upload_timeout * 2, copy).await {
                    Ok(Ok(_)) => rep.parts += 1,
                    Ok(Err(e)) => {
                        eprintln!("[sia-s3] repair: copy of part {n} of upload {uid} to {} failed", self.replicas[i].name);
                        self.note(i, &format!("repair part: {e}"));
                        rep.pending += 1;
                    }
                    Err(_) => {
                        target.mark_ambiguous();
                        self.note(i, "repair part: no completion in time");
                        rep.pending += 1;
                    }
                }
            }
        }
    }

    /// Copy one part variant (from whichever source holds it) into a new upload on `target`, checked against its
    /// size and MD5 (a part's ETag).
    async fn copy_part(&self, v: &PartVariant, target: &Store) -> Res<Object> {
        if v.size == 0 {
            return target.upload(Rc::from(&[][..])).await;
        }
        let mut last = "no source holds the part".to_string();
        for (i, obj) in &v.held {
            let Some(src) = self.store(*i) else { continue };
            let (mut tx, rx) = tokio::io::duplex(4 << 20);
            let pump = async {
                let mut tap = Tap::new(&mut tx, true);
                let r = tokio::time::timeout(self.opts.upload_timeout, src.read_into(obj, 0, v.size, &mut tap)).await;
                let md5 = tap.md5.take().map(|m| hex::encode(m.finalize()));
                let n = tap.n;
                drop(tap);
                let _ = tx.shutdown().await;
                drop(tx);
                (r, n, md5)
            };
            let ((read, n, md5), up) = tokio::join!(pump, target.upload_reader(rx));
            let bad = match read {
                Ok(Ok(_)) if n == v.size && md5.as_deref() == Some(v.etag.as_str()) => None,
                Ok(Ok(_)) => Some(format!("read {n} of {} bytes, or the MD5 differs from the ETag", v.size)),
                Ok(Err(e)) => Some(e),
                Err(_) => Some("read timed out".into()),
            };
            match (bad, up) {
                (None, Ok(o)) => return Ok(o),
                (Some(e), _) | (None, Err(e)) => last = format!("{}: {e}", self.replicas[*i].name),
            }
        }
        Err(last)
    }

    /// Does replica `i` hold the complete history the merged view stands for: no unknown outcome since its listing,
    /// every manifest and ledger read, the highest known version ceiling, every key at the view's version, every
    /// deletion, every open multipart part the sources hold? Err says what is missing (counts only: this reaches the
    /// status page).
    ///
    /// With `wait` false (the final check, under the write lock) it never waits: a replica whose index is held
    /// elsewhere (compaction, an upload, a sweep), or that has a remote call in flight (an outcome not known yet), is
    /// not caught up now, and the next pass tries again. Waiting there would stall every write (as B3 found for
    /// re-reads).
    async fn caught_up(&self, i: usize, parts: &BTreeMap<(String, u32), Vec<PartVariant>>, ceiling: u64, wait: bool) -> Res<()> {
        let s = self.store(i).ok_or("not loaded")?;
        if s.dirty() {
            return Err("its index is being re-read".into());
        }
        if !wait && s.in_flight() > 0 {
            return Err("a change to it is in flight".into());
        }
        let idx = if wait { s.idx.lock().await } else { s.idx.try_lock().map_err(|_| "its index is busy".to_string())? };
        if !idx.complete() {
            return Err("some of its manifests or ledgers are unread".into());
        }
        // M2: it must already hold every version ceiling this writer acknowledged or observed (maintenance copies
        // it), so a later boot set of admitted members starts above every earlier reservation
        if idx.ceiling < ceiling {
            return Err(format!("its version ceiling {} is below {ceiling}", idx.ceiling));
        }
        let (keys, deletions) = {
            let v = self.view.borrow();
            let keys = v.keys.iter().filter(|(kk, e)| idx.keys.get(*kk).is_none_or(|k| k.entry.ver() != e.ver())).count();
            let deletions = v.tombs.iter().filter(|(q, t)| idx.tomb(q).is_none_or(|x| x.ver() < t.ver())).count();
            (keys, deletions)
        };
        // a part counts as held only when the sources agree on it (one variant) and this replica holds that variant:
        // with several, the acknowledged one is unknown (parts carry no version), and a stale one held here would
        // pass while the acknowledged re-upload could no longer be completed after the change
        let ambiguous = parts.values().filter(|vs| vs.len() > 1).count();
        if ambiguous > 0 {
            return Err(format!("{ambiguous} open multipart parts differ between the sources (complete or abort those uploads)"));
        }
        let parts = parts
            .iter()
            .filter(|((uid, n), vs)| idx.uploads.get(uid).and_then(|u| u.parts.get(n)).is_none_or(|p| vs[0].etag != p.1 || vs[0].size != p.2))
            .count();
        if keys + deletions + parts > 0 {
            return Err(format!("{keys} keys, {deletions} deletions and {parts} multipart parts behind"));
        }
        Ok(())
    }

    /// Are the sources of the current membership state loaded, with every manifest and ledger read, in the number
    /// that makes their union the complete history?
    async fn view_complete(&self, st: &MsState) -> bool {
        let mut n = 0;
        for i in &st.sources {
            if let Some(s) = self.store(*i) {
                n += s.idx.lock().await.complete() as usize;
            }
        }
        st.sources_needed > 0 && n >= st.sources_needed
    }

    /// Admit members that hold the complete history to the configured membership (module docs, "Membership"). A
    /// change (no records yet, or another set admitted) is committed only with every configured member loaded and
    /// caught up: seals to the replaced set first, then admissions. Otherwise members join one at a time. Record
    /// bodies are uploaded first, outside the write lock; under it, the state and every member are checked again and
    /// only the records' metadata is pinned.
    async fn admission(&self, rep: &mut RepairReport) {
        let st = self.ms.borrow().clone();
        if !matches!(st.phase, Phase::Legacy | Phase::Stable | Phase::Migrating | Phase::Pending) || !self.view_complete(&st).await {
            if st.phase != Phase::Stable {
                rep.pending += 1;
            }
            return;
        }
        let mut todo = Vec::new();
        for i in self.members() {
            match self.store(i) {
                Some(s) if holds(&s, true, &st.target).await => {}
                Some(_) => todo.push(i),
                None if st.commit => {
                    rep.pending += 1;
                    return;
                }
                None => {}
            }
        }
        if todo.is_empty() {
            return;
        }
        let Some(admit) = self.admissible(&st, todo, rep, true, self.known_ceiling()).await else { return };
        let mut seals = Vec::new();
        if st.seal_needed > 0 {
            for i in &st.seal_to {
                if let Some(s) = self.store(*i) {
                    if !holds(&s, false, &st.target).await {
                        seals.push(*i);
                    }
                }
            }
        }
        let uploads = seals.iter().map(|i| (*i, "s")).chain(admit.iter().map(|i| (*i, "a"))).collect::<Vec<_>>();
        let bodies = join_all(
            uploads
                .iter()
                .map(|(i, _)| {
                    let s = self.store(*i);
                    async move {
                        let s = s.ok_or("not loaded")?;
                        tokio::time::timeout(self.opts.upload_timeout, s.upload_record()).await.map_err(|_| "upload timed out".to_string())?
                    }
                })
                .collect(),
        )
        .await;
        let mut bodies: Vec<((usize, &str), Object)> = uploads
            .into_iter()
            .zip(bodies)
            .filter_map(|((i, k), r)| match r {
                Ok(o) => Some(((i, k), o)),
                Err(e) => {
                    self.note(i, &format!("membership record upload: {e}"));
                    None
                }
            })
            .collect();

        // M2: no reservation may be acknowledged while the voters change, and every record carries the highest ceiling
        // known now (reservations wait for `reserving`; stamps for the write lock). Lock order: reserving, then write.
        let _r = self.reserving.lock().await;
        let _w = self.write.lock().await;
        if *self.ms.borrow() != st {
            rep.pending += 1;
            return;
        }
        let Some(ceiling) = self.required_ceiling_now() else {
            rep.pending += 1;
            return;
        };
        let Some(admit) = self.admissible(&st, admit, rep, false, ceiling).await else { return };
        let record = |k: &str| MsRec { k: k.into(), d: st.target.clone(), p: st.prev.clone(), c: ceiling };
        let pin = |kind: &'static str, which: Vec<usize>, bodies: &mut Vec<((usize, &str), Object)>| {
            let jobs: Vec<_> = which
                .into_iter()
                .filter_map(|i| {
                    let at = bodies.iter().position(|((j, k), _)| *j == i && *k == kind)?;
                    let (_, obj) = bodies.swap_remove(at);
                    let (s, rec) = (self.store(i)?, record(kind));
                    Some((i, async move { s.pin_record(obj, rec).await }))
                })
                .collect();
            fan_out(jobs, usize::MAX, Duration::ZERO, self.meta_deadline(), |_, r| r.is_ok())
        };
        if st.seal_needed > 0 {
            let mut sealed = 0;
            for i in &st.seal_to {
                if let Some(s) = self.store(*i) {
                    // a busy index counts as not sealed: at worst one more seal record (records only add)
                    sealed += s.idx.try_lock().is_ok_and(|idx| idx.records.iter().any(|(_, r)| r.d == st.target)) as usize;
                }
            }
            for (i, r) in pin("s", seals, &mut bodies).await {
                match r {
                    Some(Ok(())) => {
                        sealed += 1;
                        rep.admitted += 1;
                    }
                    Some(Err(e)) => self.note(i, &format!("membership seal: {e}")),
                    None => {
                        if let Some(s) = self.store(i) {
                            s.mark_ambiguous();
                        }
                        self.note(i, "membership seal: no answer in time");
                    }
                }
            }
            if sealed < st.seal_needed {
                // too few seals are durable: this process stops acting under the old set (Pending) and retries. (A
                // seal that is abandoned, or held by a replica a later boot does not load, is no barrier there; that
                // boot may act under the old set again, which is safe: its quorum still holds everything.)
                eprintln!("[sia-s3] membership: {sealed} of {} seals for epoch {} are durable; retrying", st.seal_needed, st.target.s);
                rep.pending += 1;
                self.rebuild().await;
                return;
            }
        }
        for (i, r) in pin("a", admit, &mut bodies).await {
            match r {
                Some(Ok(())) => {
                    rep.admitted += 1;
                    eprintln!("[sia-s3] membership: {} admitted to epoch {}", self.replicas[i].name, st.target.s);
                }
                Some(Err(e)) => {
                    self.note(i, &format!("membership admit: {e}"));
                    rep.pending += 1;
                }
                None => {
                    if let Some(s) = self.store(i) {
                        s.mark_ambiguous();
                    }
                    self.note(i, "membership admit: no answer in time");
                    rep.pending += 1;
                }
            }
        }
        self.rebuild().await;
    }

    /// The members of `todo` that hold the complete history; None when there are none, or when a change (which
    /// admits every member at once) has one that does not.
    async fn admissible(&self, st: &MsState, todo: Vec<usize>, rep: &mut RepairReport, wait: bool, ceiling: u64) -> Option<Vec<usize>> {
        let Some(parts) = self.source_parts(&st.sources, wait).await else {
            eprintln!("[sia-s3] membership: a source's index is busy; admission waits for the next pass");
            rep.pending += 1;
            return None;
        };
        let mut admit = Vec::new();
        for i in todo {
            match self.caught_up(i, &parts, ceiling, wait).await {
                Ok(()) => admit.push(i),
                Err(e) => {
                    eprintln!("[sia-s3] membership: {} is not admitted yet: {e}", self.replicas[i].name);
                    rep.pending += 1;
                    if st.commit {
                        return None;
                    }
                }
            }
        }
        (!admit.is_empty()).then_some(admit)
    }

    /// Copy every deletion the view knows into a ledger floor on every loaded replica that lacks it, then reclaim
    /// the tombstones (and payload) floors cover, and merge ledgers that have piled up. Never drops a floor.
    async fn floors(&self, rep: &mut RepairReport) {
        let deletions: Vec<Tomb> = self.view.borrow().tombs.values().cloned().collect();
        for (i, s) in self.backfill_targets() {
            let missing: Vec<Tomb> = {
                let idx = s.idx.lock().await;
                deletions.iter().filter(|t| idx.floors.get(&t.q).is_none_or(|f| f.ver() < t.ver())).cloned().collect()
            };
            if !missing.is_empty() {
                let n = missing.len();
                match tokio::time::timeout(self.opts.upload_timeout + self.meta_deadline(), s.write_ledger(missing)).await {
                    Ok(Ok(())) => rep.floors += n,
                    Ok(Err(e)) => {
                        self.note(i, &format!("ledger: {e}"));
                        rep.pending += 1;
                        continue;
                    }
                    Err(_) => {
                        s.mark_ambiguous();
                        self.note(i, "ledger: no completion in time");
                        rep.pending += 1;
                        continue;
                    }
                }
            }
            match tokio::time::timeout(self.meta_deadline() * 8, s.reclaim_covered()).await {
                Ok(Ok(n)) => rep.reclaimed += n,
                Ok(Err(e)) => {
                    self.note(i, &format!("reclaim: {e}"));
                    rep.pending += 1;
                }
                Err(_) => {
                    s.mark_ambiguous();
                    rep.pending += 1;
                }
            }
            match tokio::time::timeout(self.opts.upload_timeout + self.meta_deadline() * 8, s.merge_ledgers()).await {
                Ok(Ok(n)) => rep.merged += n,
                Ok(Err(e)) => {
                    self.note(i, &format!("ledger merge: {e}"));
                    rep.pending += 1;
                }
                Err(_) => {
                    s.mark_ambiguous();
                    rep.pending += 1;
                }
            }
        }
        self.rebuild().await;
    }

    /// Once this process writes, renew its version range before half of it is used. Then give the highest known
    /// ceiling (its own acknowledged one, or a higher one observed from an earlier writer) to every loaded replica
    /// holding a lower one (a replica that was down, or a new member), so any later boot set that includes it finds the
    /// ceiling there too, and so a new member can be admitted (`caught_up` requires it, M2).
    async fn ceilings(&self, rep: &mut RepairReport) {
        if self.ceiling.get() > 0 && self.ready() {
            if let Err(e) = self.ensure_range(self.range_ms.get() / 2).await {
                eprintln!("[sia-s3] version range renewal: {e}");
                rep.pending += 1;
            }
        }
        let c = self.known_ceiling();
        if c == 0 {
            return; // a legacy deployment that has stamped nothing under a ceiling yet: the first write reserves
        }
        for (i, s) in self.loaded() {
            if s.ceiling().await >= c {
                continue;
            }
            match tokio::time::timeout(self.opts.upload_timeout + self.meta_deadline(), s.write_ceiling(c)).await {
                Ok(Ok(())) => rep.ceilings += 1,
                Ok(Err(e)) => {
                    self.note(i, &format!("version ceiling: {e}"));
                    rep.pending += 1;
                }
                Err(_) => {
                    s.mark_ambiguous();
                    self.note(i, "version ceiling: no completion in time");
                    rep.pending += 1;
                }
            }
        }
    }

    /// Per-replica state for /healthz and the status page (no keys or object names).
    pub async fn replica_status(&self) -> Vec<serde_json::Value> {
        let view_keys: Vec<(KK, Ver)> = self.view.borrow().keys.iter().map(|(kk, e)| (kk.clone(), e.ver())).collect();
        let st = self.ms.borrow().clone();
        let mut out = Vec::new();
        for (i, r) in self.replicas.iter().enumerate() {
            let mut v = serde_json::json!({
                "name": r.name,
                "indexer": r.indexer,
                "retiring": r.retiring,
                "loaded": false,
                "error": *r.error.borrow(),
                // the cluster's membership state, repeated on each replica
                "membership": { "phase": st.phase, "ready": st.ready, "epoch": st.acting.as_ref().map(|a| a.s), "target": st.target.s, "reason": st.reason },
            });
            if let Some(s) = r.store() {
                let idx = s.idx.lock().await;
                v["voting"] = st.voters.contains(&i).into();
                v["record"] = idx.newest_record().map(|r| serde_json::json!({ "epoch": r.d.s, "admitted": r.admit() })).into();
                let behind = view_keys.iter().filter(|(kk, ver)| idx.keys.get(kk).is_none_or(|k| k.entry.ver() != *ver)).count();
                v["loaded"] = true.into();
                v["keys"] = idx.keys.len().into();
                v["objects"] = idx.objs.len().into();
                v["behind"] = behind.into();
                v["tombstonedKeys"] = idx.tombs.len().into();
                v["manifests"] = idx.manifests.len().into();
                v["unreadManifests"] = idx.unresolved.len().into();
                v["floors"] = idx.floors.len().into();
                v["ledgers"] = idx.ledgers.len().into();
                v["unreadLedgers"] = idx.unread_ledgers.len().into();
                v["versionCeiling"] = idx.ceiling.into();
                v["openUploads"] = idx.uploads.len().into();
                v["dirty"] = s.dirty().into();
                v["compactor"] = serde_json::json!(*s.stats.borrow());
            }
            out.push(v);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sia_storage::AppKey;
    use sia_storage::mock::{Fault, MockNetwork};

    /// One independent indexer: its own mock indexer, hosts and app key.
    struct Net {
        net: MockNetwork,
        key: AppKey,
    }

    fn opts() -> Opts {
        Opts { shards: (3, 9), listing: crate::store::Listing::Current, meta_timeout: Duration::from_millis(1500), upload_timeout: Duration::from_secs(60) }
    }

    /// Grace periods long enough that a healthy replica is never abandoned under test load (the fault tests
    /// shorten them).
    fn timing() -> Timing {
        Timing { upload_grace: Duration::from_secs(30), meta_grace: Duration::from_secs(5), stall: Duration::from_secs(5) }
    }

    fn short() -> Timing {
        Timing { upload_grace: Duration::from_millis(300), meta_grace: Duration::from_millis(300), ..timing() }
    }

    /// Where disk-backed mock networks make their sector directories: under this crate's own `target/`, which is
    /// on disk (not a tmpfs `/tmp`). Each network makes a fresh, uniquely named directory here and removes it, and
    /// only the files it wrote, when it is dropped.
    fn sector_base() -> std::path::PathBuf {
        let base = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("mock-sectors");
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    impl Net {
        /// Disk-backed (see `on_disk`). Every write now also pins version-range ceilings and every membership
        /// change pins records, each a full slab of 4 MiB sectors: in RAM, a two-replica test with a few writes
        /// exceeded the 1 GiB test cgroup (OOM kill in `a_hung_replica_delays_a_quorum_write_by_the_grace_period_only`,
        /// work/storage-integration-logs/full1.log). Same SDK path, same assertions.
        fn new(seed: u8) -> Net {
            Net::on_disk(seed)
        }
        /// The original in-memory sector store, for the test that checks both stores answer alike.
        fn in_memory(seed: u8) -> Net {
            let net = MockNetwork::new();
            net.add_hosts(12); // 3 + 9 shards: the smallest layout the SDK accepts
            Net { net, key: AppKey::import([seed; 32]) }
        }
        /// As `new`, but the mock hosts keep their (real, encrypted, erasure-coded) sectors on disk instead of in
        /// RAM: for the tests that write enough 4 MiB sectors to exhaust memory. Same SDK, same coverage.
        fn on_disk(seed: u8) -> Net {
            Net::on_disk_with(seed, 64 << 30)
        }
        fn on_disk_with(seed: u8, limit: u64) -> Net {
            let net = MockNetwork::with_disk_sectors(&sector_base(), limit).unwrap();
            net.add_hosts(12);
            Net { net, key: AppKey::import([seed; 32]) }
        }
        async fn load(&self) -> Res<Rc<Store>> {
            let sdk = self.net.sdk(self.key.clone()).await.map_err(|e| e.to_string())?;
            Ok(Rc::new(Store::load_with(sdk, 8 << 20, opts()).await?))
        }
        fn offline(&self, off: bool) {
            self.net.set_indexer_offline(off);
        }
    }

    async fn cluster(nets: &[Net], w: usize) -> Cluster {
        cluster_with(nets, w, timing()).await
    }

    /// Boot a cluster over every net. A new deployment (every replica loaded, none with records yet) is admitted
    /// right away, as its first maintenance pass would; a restart finds its records.
    async fn cluster_with(nets: &[Net], w: usize, timing: Timing) -> Cluster {
        let c = Cluster::new(
            (0..nets.len()).map(|i| (format!("r{i}"), format!("https://indexer-{i}.example"), false)).collect(),
            w,
            opts(),
            timing,
        );
        for (i, n) in nets.iter().enumerate() {
            if let Ok(s) = n.load().await {
                c.attach(i, s).await;
            }
        }
        settle(&c).await;
        c
    }

    /// Only the admission step of a maintenance pass.
    async fn settle(c: &Cluster) -> RepairReport {
        let mut r = RepairReport::default();
        c.admission(&mut r).await;
        r
    }

    async fn get(c: &Cluster, k: &str) -> Option<Vec<u8>> {
        let e = c.lookup("b", k)?;
        let mut out = Vec::new();
        c.read(&e, 0, e.s, &mut out).await.unwrap();
        Some(out)
    }

    /// On one indexer, listed fresh from its object feed (not any in-memory index): the key's live version, whether
    /// deletion evidence (tombstone or floor) names it, and whether any object still names any version of it.
    async fn on_disk(n: &Net, k: &str) -> (Option<Ver>, bool, bool) {
        let s = n.load().await.unwrap();
        let idx = s.idx.lock().await;
        let q = qkey("b", k);
        (idx.keys.get(&("b".to_string(), k.to_string())).map(|k| k.entry.ver()), idx.tomb(&q).is_some(), idx.oldest.contains_key(&q))
    }

    /// Run maintenance passes until one finds nothing to do.
    async fn maintain(c: &Cluster) -> RepairReport {
        let mut total = RepairReport::default();
        for _ in 0..6 {
            let r = c.repair(1 << 30).await;
            let idle =
                r.reconciled + r.purged + r.copies + r.deletes + r.floors + r.reclaimed + r.merged + r.parts + r.admitted + r.ceilings + r.pending == 0;
            total.reconciled += r.reconciled;
            total.purged += r.purged;
            total.copies += r.copies;
            total.deletes += r.deletes;
            total.floors += r.floors;
            total.reclaimed += r.reclaimed;
            total.merged += r.merged;
            total.parts += r.parts;
            total.admitted += r.admitted;
            total.ceilings += r.ceilings;
            total.pending = r.pending;
            if idle {
                break;
            }
        }
        total
    }

    #[tokio::test]
    async fn a_lost_commit_response_cannot_resurrect_a_deleted_key() {
        // r1 pins v2 but the answer is lost, so r1's index still says v1 while the indexer holds v2. The 0.2
        // draft's time-based GC dropped every tombstone and a reload brought v2 back (reproduced before the fix).
        let nets = [Net::new(1), Net::new(2)];
        let c = cluster(&nets, 1).await;
        c.put("b", "k", b"v1".to_vec(), None, &Cond::None).await.unwrap();
        nets[1].net.push_fault("pin_object", Fault::ApplyThenFail);
        c.put("b", "k", b"v2".to_vec(), None, &Cond::None).await.unwrap();
        assert!(c.store(1).unwrap().dirty());
        c.delete("b", "k").await.unwrap();
        let r = maintain(&c).await;
        assert!(r.reconciled >= 1 && r.floors >= 2 && r.purged >= 1 && r.reclaimed >= 2, "{r:?}");
        for n in &nets {
            assert_eq!(on_disk(n, "k").await, (None, true, false), "payload reclaimed, the floor kept");
        }
        assert!(cluster(&nets, 1).await.lookup("b", "k").is_none());
    }

    #[tokio::test]
    async fn a_write_that_lands_after_maintenance_and_a_restart_stays_deleted() {
        // The regression the time-based GC failed: an abandoned pin of an older version is applied by the indexer
        // only after the DELETE, after every replica was re-read and its payload reclaimed, and after a restart.
        let nets = [Net::new(1), Net::new(2)];
        let c = cluster_with(&nets, 1, short()).await;
        c.put("b", "k", b"v1".to_vec(), None, &Cond::None).await.unwrap();
        // keep r1's v1 object, to replay it later as a stale or rolled-back indexer would
        let stale = {
            let s = c.store(1).unwrap();
            let idx = s.idx.lock().await;
            let host = idx.keys[&("b".to_string(), "k".to_string())].host.clone();
            idx.objs[&host].0.clone()
        };
        nets[1].net.push_fault("pin_object", Fault::Defer);
        c.put("b", "k", b"v2".to_vec(), None, &Cond::None).await.unwrap(); // r1 abandoned after the grace
        assert!(c.store(1).unwrap().dirty());
        c.delete("b", "k").await.unwrap();
        maintain(&c).await;
        for n in &nets {
            assert_eq!(on_disk(n, "k").await, (None, true, false));
        }

        // now the indexer applies the v2 pin it was given long ago, and replays v1
        assert_eq!(nets[1].net.apply_deferred(), 1);
        c.store(1).unwrap().sdk.pin_object(&stale).await.unwrap();
        assert_eq!(on_disk(&nets[1], "k").await, (None, true, true), "both old versions are back on r1, under the floor");

        // a restart from durable state alone still sees the key deleted; its maintenance purges the old versions
        drop(c);
        let restarted = cluster(&nets, 1).await;
        assert!(restarted.lookup("b", "k").is_none());
        let r = maintain(&restarted).await;
        assert!(r.purged >= 1, "{r:?}");
        for n in &nets {
            assert_eq!(on_disk(n, "k").await, (None, true, false));
        }
        assert!(cluster(&nets, 1).await.lookup("b", "k").is_none());
    }

    #[tokio::test]
    async fn a_replica_rolled_back_to_before_a_delete_cannot_bring_the_key_back() {
        // fail-stop is the model, but floors on every replica also outlast up to N - W rolled-back indexers
        let mut nets = vec![Net::new(1), Net::new(2), Net::new(3)];
        let c = cluster(&nets, 2).await;
        c.put("b", "k", b"old".to_vec(), None, &Cond::None).await.unwrap();
        let stale = {
            let s = c.store(2).unwrap();
            let idx = s.idx.lock().await;
            let host = idx.keys[&("b".to_string(), "k".to_string())].host.clone();
            idx.objs[&host].0.clone()
        };
        c.delete("b", "k").await.unwrap();
        maintain(&c).await;
        drop(c);
        // r2's indexer comes back from a backup taken before the DELETE: no tombstone, no floor, the old version
        nets[2] = Net::new(3);
        let sdk = nets[2].net.sdk(nets[2].key.clone()).await.unwrap();
        sdk.pin_object(&stale).await.unwrap();
        assert_eq!(on_disk(&nets[2], "k").await.0, Some(stale_ver(&stale)));
        // every boot set (2 of 3) includes a replica with the floor
        for down in 0..2 {
            nets[down].offline(true);
            assert!(cluster(&nets, 2).await.lookup("b", "k").is_none(), "with r{down} down");
            nets[down].offline(false);
        }
        // and maintenance puts the floor back on r2 and purges what it replayed
        let all = cluster(&nets, 2).await;
        maintain(&all).await;
        assert_eq!(on_disk(&nets[2], "k").await, (None, true, false));
    }

    fn stale_ver(o: &Object) -> Ver {
        serde_json::from_slice::<crate::store::Meta>(&o.metadata).unwrap().e[0].ver()
    }

    #[tokio::test]
    async fn a_hung_replica_delays_a_quorum_write_by_the_grace_period_only() {
        let nets = [Net::new(1), Net::new(2)];
        let c = cluster_with(&nets, 1, short()).await;
        // the same write with both replicas healthy, for scale (mock uploads are CPU-bound, so load varies)
        let t0 = std::time::Instant::now();
        c.put("b", "base", b"w".to_vec(), None, &Cond::None).await.unwrap();
        let base = t0.elapsed();
        // an upload that never completes on r1
        nets[1].net.push_fault("pin_slabs", Fault::Hang);
        let t0 = std::time::Instant::now();
        c.put("b", "a", b"x".to_vec(), None, &Cond::None).await.unwrap();
        let upload_wait = t0.elapsed();
        // a metadata commit that never answers on r1
        nets[1].net.push_fault("pin_object", Fault::Hang);
        let t0 = std::time::Instant::now();
        c.put("b", "b", b"y".to_vec(), None, &Cond::None).await.unwrap();
        let commit_wait = t0.elapsed();
        // bounded by the healthy replica's own time plus the grace period, not by the hung replica (forever)
        let bound = base * 3 + Duration::from_secs(5);
        assert!(upload_wait < bound && commit_wait < bound, "{base:?}: {upload_wait:?} {commit_wait:?}");
        assert!(c.store(1).unwrap().dirty(), "the abandoned pin's outcome is unknown");
        assert!(c.stats.borrow().abandoned_calls >= 2);
        // the write lock is free: the next write proceeds, and repair brings r1 up
        c.put("b", "c", b"z".to_vec(), None, &Cond::None).await.unwrap();
        maintain(&c).await;
        for k in ["base", "a", "b", "c"] {
            assert_eq!(on_disk(&nets[1], k).await.0, c.lookup("b", k).map(|e| e.ver()), "{k}");
        }

        // with W = 2 the same hang fails the write at the deadline instead of holding it forever
        let c2 = cluster_with(&nets, 2, short()).await;
        // a writer's first write reserves its version range (a pin on every replica): done first, so the hang below
        // hits the commit's pin as this test intends (a hang during the reservation also fails the write with 503,
        // earlier and with nothing committed)
        c2.put("b", "warm", b"w".to_vec(), None, &Cond::None).await.unwrap();
        nets[1].net.push_fault("pin_object", Fault::Hang);
        let t0 = std::time::Instant::now();
        let e = c2.put("b", "d", b"w".to_vec(), None, &Cond::None).await.unwrap_err();
        assert!(e.starts_with("ServiceUnavailable"), "{e}");
        assert!(t0.elapsed() < base * 3 + c2.meta_deadline() + Duration::from_secs(5), "{base:?}: {:?}", t0.elapsed());
        assert!(c2.lookup("b", "d").is_some(), "r0 committed: visible, as after an S3 500");
    }

    #[tokio::test]
    async fn writes_continue_through_an_indexer_outage_and_repair_backfills() {
        let nets = [Net::new(1), Net::new(2)];
        let c = cluster(&nets, 1).await;
        assert_eq!((c.n(), c.read_quorum()), (2, 2));
        c.put("b", "k1", b"first".to_vec(), None, &Cond::None).await.unwrap();

        nets[1].offline(true);
        c.put("b", "k2", b"written during the outage".to_vec(), None, &Cond::None).await.unwrap();
        assert_eq!(get(&c, "k2").await.unwrap(), b"written during the outage");
        assert!(c.replicas[1].error.borrow().is_some());

        nets[1].offline(false);
        let rep = maintain(&c).await;
        assert_eq!(rep.copies, 1);
        // the backfilled replica alone now serves the outage write, with the same version
        let want = c.lookup("b", "k2").unwrap().ver();
        assert_eq!(on_disk(&nets[1], "k2").await.0, Some(want));
        nets[0].offline(true);
        nets[0].net.clear_sectors();
        let only_b = cluster(&nets, 1).await;
        assert_eq!(only_b.loaded().len(), 1);
        let e = only_b.lookup("b", "k2").unwrap();
        let mut out = Vec::new();
        only_b.read(&e, 0, e.s, &mut out).await.unwrap();
        assert_eq!(out, b"written during the outage");
        assert!(!only_b.ready(), "one of two replicas is below the boot quorum when W = 1");
    }

    #[tokio::test]
    async fn quorum_refuses_and_leaves_nothing_visible() {
        let nets = [Net::new(1), Net::new(2)];
        let c = cluster(&nets, 2).await;
        nets[1].offline(true);
        let e = c.put("b", "k", b"x".to_vec(), None, &Cond::None).await.unwrap_err();
        assert!(e.starts_with("ServiceUnavailable"), "{e}");
        assert!(c.lookup("b", "k").is_none());
        nets[1].offline(false);
        assert_eq!(on_disk(&nets[0], "k").await.0, None, "the staged upload on the healthy replica was never pinned");
        assert_eq!(c.stats.borrow().refused_writes, 1);
    }

    #[tokio::test]
    async fn a_missed_delete_never_resurrects_and_its_payload_is_reclaimed() {
        let nets = [Net::new(1), Net::new(2), Net::new(3)];
        let c = cluster(&nets, 2).await;
        c.put("b", "k", b"doomed".to_vec(), None, &Cond::None).await.unwrap();
        nets[2].offline(true);
        c.delete("b", "k").await.unwrap();
        assert!(c.lookup("b", "k").is_none());

        // a fresh boot that loads the replica which missed the DELETE still sees it (any 2 of 3 include a record)
        nets[1].offline(true);
        nets[2].offline(false);
        let boot = cluster(&nets, 2).await;
        assert!(boot.ready());
        assert!(boot.lookup("b", "k").is_none(), "r0's deletion hides r2's stale copy");
        assert!(on_disk(&nets[2], "k").await.0.is_some());

        // with all three back, maintenance applies the delete, writes floors everywhere and reclaims the payload
        nets[1].offline(false);
        let all = cluster(&nets, 2).await;
        let rep = maintain(&all).await;
        assert!(rep.deletes == 1 && rep.floors >= 3 && rep.reclaimed >= 3, "{rep:?}");
        for n in &nets {
            assert_eq!(on_disk(n, "k").await, (None, true, false));
        }
        // and a key put again afterwards is ordinary: newer than its floor
        all.put("b", "k", b"again".to_vec(), None, &Cond::IfNoneMatch).await.unwrap();
        assert_eq!(get(&all, "k").await.unwrap(), b"again");
        assert_eq!(get(&cluster(&nets, 2).await, "k").await.unwrap(), b"again");
    }

    #[tokio::test]
    async fn delete_succeeds_only_when_recorded_durably_on_a_write_quorum() {
        let nets = [Net::new(1), Net::new(2), Net::new(3)];
        let c = cluster(&nets, 2).await;
        c.put("b", "k", b"everywhere".to_vec(), None, &Cond::None).await.unwrap();
        nets[1].offline(true);
        nets[2].offline(true);
        // only r0 can record it
        let e = c.delete("b", "k").await.unwrap_err();
        assert!(e.starts_with("ServiceUnavailable"), "{e}");
        assert!(c.lookup("b", "k").is_none(), "the indeterminate delete is visible, as with an S3 500");
        nets[2].offline(false);
        c.delete("b", "k").await.unwrap(); // the retry records the same deletion on r2
        assert!(on_disk(&nets[2], "k").await.1);

        // a replica that never held the key records the deletion as a ledger floor
        nets[1].offline(false);
        nets[2].offline(true);
        c.put("b", "lag", b"r0 and r1".to_vec(), None, &Cond::None).await.unwrap();
        nets[2].offline(false);
        nets[1].offline(true);
        c.delete("b", "lag").await.unwrap();
        assert_eq!(on_disk(&nets[2], "lag").await, (None, true, false));
    }

    #[tokio::test]
    async fn boot_merges_the_newest_version_and_conditions_use_it() {
        let nets = [Net::new(1), Net::new(2)];
        let c = cluster(&nets, 1).await;
        let old = c.put("b", "k", b"v1".to_vec(), None, &Cond::None).await.unwrap();
        nets[0].offline(true);
        let new = c.put("b", "k", b"v2".to_vec(), None, &Cond::IfMatch(old.clone())).await.unwrap();
        nets[0].offline(false);

        let boot = cluster(&nets, 1).await;
        assert_eq!(boot.lookup("b", "k").unwrap().t, new);
        assert_eq!(get(&boot, "k").await.unwrap(), b"v2");
        let e = boot.put("b", "k", b"v3".to_vec(), None, &Cond::IfMatch(old)).await.unwrap_err();
        assert_eq!(e, "PreconditionFailed");
        assert_eq!(maintain(&boot).await.copies, 1);
        assert_eq!(on_disk(&nets[0], "k").await.0, Some(boot.lookup("b", "k").unwrap().ver()));
        // the boot clock starts after every version it loaded, so a later write always orders last
        assert!(boot.clock.get() >= boot.lookup("b", "k").unwrap().ver().h);
        let v2 = boot.lookup("b", "k").unwrap().ver();
        boot.put("b", "k", b"v4".to_vec(), None, &Cond::IfMatch(new)).await.unwrap();
        assert!(boot.lookup("b", "k").unwrap().ver() > v2);
    }

    #[tokio::test]
    async fn reads_fail_over_to_a_replica_that_still_has_the_bytes() {
        let nets = [Net::new(1), Net::new(2)];
        let c = cluster(&nets, 2).await;
        let body: Vec<u8> = (0..300_000u32).map(|i| (i * 7) as u8).collect();
        c.put("b", "k", body.clone(), None, &Cond::None).await.unwrap();
        nets[0].net.clear_sectors(); // r0's hosts lost the data; its indexer still lists it
        let e = c.lookup("b", "k").unwrap();
        let mut out = Vec::new();
        assert_eq!(c.read(&e, 1000, 5000, &mut out).await.unwrap(), 5000);
        assert_eq!(out, &body[1000..6000]);
        nets[1].net.clear_sectors();
        assert!(c.read(&e, 0, 10, &mut Vec::new()).await.is_err());
    }

    #[tokio::test]
    async fn streamed_puts_tee_to_every_replica_and_drop_a_failing_one() {
        let nets = [Net::new(1), Net::new(2)];
        let c = cluster(&nets, 1).await;
        nets[1].offline(true);
        let body = vec![9u8; 100_000];
        let staged = c.upload_reader(std::io::Cursor::new(body.clone())).await.unwrap();
        assert_eq!(staged.objs.len(), 1);
        c.commit("b", "big", staged, md5_hex(&body), body.len() as u64, None, &Cond::IfNoneMatch).await.unwrap();
        assert_eq!(get(&c, "big").await.unwrap(), body);
        nets[1].offline(false);
        // with W = 2 both replicas must take the stream
        let c2 = cluster(&nets, 2).await;
        let staged = c2.upload_reader(std::io::Cursor::new(body.clone())).await.unwrap();
        assert_eq!(staged.objs.len(), 2);
        let e = c2.commit("b", "big", staged, md5_hex(&body), body.len() as u64, None, &Cond::IfNoneMatch).await.unwrap_err();
        assert_eq!(e, "PreconditionFailed");
    }

    /// The disk-backed mock answers exactly as the in-memory one: the same complete bytes and ranges through the
    /// real SDK (encryption, erasure coding, sector roots), the same failure once hosts lose their sectors, files
    /// only under its own directory and named only by hashes, an enforced byte budget, and full cleanup on drop.
    #[tokio::test]
    async fn disk_and_memory_mock_sectors_answer_alike() {
        let body: Vec<u8> = (0..300_000u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        let mem = [Net::in_memory(7)];
        let dsk = [Net::on_disk(7)];
        let dir = dsk[0].net.sector_dir().expect("a disk-backed network has a sector directory");
        assert!(dir.starts_with(sector_base()));
        assert!(mem[0].net.sector_dir().is_none() && mem[0].net.sector_bytes().is_none());
        {
            let cm = cluster(&mem, 1).await;
            let cd = cluster(&dsk, 1).await;
            for c in [&cm, &cd] {
                c.put("b", "k", body.clone(), None, &Cond::None).await.unwrap();
            }
            for c in [&cm, &cd] {
                assert_eq!(get(c, "k").await.unwrap(), body);
                let e = c.lookup("b", "k").unwrap();
                for (off, len) in [(0u64, 1u64), (1, 4095), (4096, 60_000), (299_999, 1), (123_457, 100_000)] {
                    let mut out = Vec::new();
                    c.read(&e, off, len, &mut out).await.unwrap();
                    assert_eq!(out, &body[off as usize..(off + len) as usize], "range {off}+{len}");
                }
            }
            // what is on disk: one directory per host, one file per sector, all named by hex hashes, all inside `dir`
            let held = dsk[0].net.sector_bytes().unwrap();
            assert!(held > 0 && held % (4 << 20) == 0, "{held}");
            let mut files = 0u64;
            for h in std::fs::read_dir(&dir).unwrap() {
                let h = h.unwrap();
                let name = h.file_name().into_string().unwrap();
                assert!(name.len() == 64 && name.bytes().all(|b| b.is_ascii_hexdigit()), "{name}");
                for f in std::fs::read_dir(h.path()).unwrap() {
                    let f = f.unwrap();
                    let n = f.file_name().into_string().unwrap();
                    let stem = n.strip_suffix(".sector").expect("only finished sectors remain");
                    assert!(stem.len() == 64 && stem.bytes().all(|b| b.is_ascii_hexdigit()), "{n}");
                    assert_eq!(f.metadata().unwrap().len(), 4 << 20);
                    files += 1;
                }
            }
            assert_eq!(files * (4 << 20), held);
            // hosts losing every sector: both backends fail the read, with the same error
            mem[0].net.clear_sectors();
            dsk[0].net.clear_sectors();
            assert_eq!(dsk[0].net.sector_bytes(), Some(0));
            let em = cm.lookup("b", "k").unwrap();
            let ed = cd.lookup("b", "k").unwrap();
            let (mut a, mut b) = (Vec::new(), Vec::new());
            let ra = cm.read(&em, 0, em.s, &mut a).await.unwrap_err();
            let rb = cd.read(&ed, 0, ed.s, &mut b).await.unwrap_err();
            assert_eq!(ra, rb);
        }
        // the budget is enforced: a write over it fails rather than vanishing
        let tight = [Net::on_disk_with(8, 4 << 20)];
        let ct = cluster(&tight, 1).await;
        assert!(ct.put("b", "k", body.clone(), None, &Cond::None).await.is_err());
        drop(ct);
        drop(tight);
        // and dropping the network (and every SDK built from it) removes its directory
        drop(dsk);
        assert!(!dir.exists(), "{} was left behind", dir.display());
    }

    #[tokio::test]
    async fn many_part_uploads_and_long_keys_use_manifests_everywhere() {
        // disk-backed: this test pins dozens of objects on two indexers, every one a full 12-shard slab of 4 MiB
        // sectors, which in RAM exceeds 2 GiB; on disk the identical upload, manifest and recovery paths run
        let nets = [Net::on_disk(1), Net::on_disk(2)];
        let c = cluster(&nets, 2).await;
        // 16 small parts: more than an inline entry can list (about 12) without large bodies
        let uid = c.create_upload("b", "mp").await.unwrap();
        let mut want = Vec::new();
        let mut body: Vec<u8> = Vec::new();
        for n in 1..=16u32 {
            let part = vec![n as u8; 1000 + n as usize];
            body.extend(&part);
            want.push((n, c.upload_part(&uid, n, part).await.unwrap()));
        }
        let (_, _, etag) = c.complete_upload(&uid, &want).await.unwrap();
        assert!(etag.ends_with("-16"));
        assert!(c.uploads().await.is_empty());
        assert_eq!(get(&c, "mp").await.unwrap(), body);
        // a range across part boundaries
        let e = c.lookup("b", "mp").unwrap();
        let mut out = Vec::new();
        c.read(&e, 1500, 3000, &mut out).await.unwrap();
        assert_eq!(out, &body[1500..4500]);

        // a key near S3's 1 KiB limit, and copies of both onto manifests
        let long = format!("dir/{}", "k".repeat(1000));
        c.put("b", &long, b"long".to_vec(), Some("text/plain".into()), &Cond::IfNoneMatch).await.unwrap();
        c.copy(("b", "mp"), ("b", "mp-copy")).await.unwrap();
        c.copy(("b", &long), ("b", "long-copy")).await.unwrap();

        // a fresh load of each indexer reads the manifests back
        for n in &nets {
            let s = n.load().await.unwrap();
            let idx = s.idx.lock().await;
            for k in ["mp", long.as_str(), "mp-copy", "long-copy"] {
                assert!(idx.keys[&("b".to_string(), k.to_string())].manifest, "{k}");
            }
            assert!(idx.unresolved.is_empty());
        }
        let boot = cluster(&nets, 2).await;
        assert_eq!(get(&boot, "mp-copy").await.unwrap(), body);
        assert_eq!(get(&boot, &long).await.unwrap(), b"long");
        assert_eq!(get(&boot, "long-copy").await.unwrap(), b"long");
        assert_eq!(boot.lookup("b", "mp").unwrap().t, etag);
        assert_eq!(boot.lookup("b", &long).unwrap().c.as_deref(), Some("text/plain"));

        // deleting the source leaves the copy whole; deleting everything reclaims every payload object
        boot.delete("b", "mp").await.unwrap();
        assert_eq!(get(&boot, "mp-copy").await.unwrap(), body);
        for k in ["mp-copy", long.as_str(), "long-copy"] {
            boot.delete("b", k).await.unwrap();
        }
        maintain(&boot).await;
        for n in &nets {
            let s = n.load().await.unwrap();
            let idx = s.idx.lock().await;
            assert!(idx.keys.is_empty() && idx.tombs.is_empty() && idx.manifests.is_empty() && idx.oldest.is_empty());
            assert_eq!(idx.floors.len(), 4);
            assert_eq!(idx.ceilings.len(), 1, "one version-range ceiling object per replica");
            assert_eq!(
                idx.objs.len(),
                idx.ledgers.len() + idx.records.len() + 1,
                "only ledgers, the membership record and the version ceiling remain"
            );
        }
    }

    #[tokio::test]
    async fn one_indexer_keeps_a_floor_and_reclaims_the_payload() {
        let one = [Net::new(4)];
        let c = cluster(&one, 1).await;
        c.put("b", "k", b"x".to_vec(), None, &Cond::None).await.unwrap();
        c.delete("b", "k").await.unwrap();
        {
            // the deletion is a tombstone in the payload's own object, which stays until a floor covers it
            let s = one[0].load().await.unwrap();
            let idx = s.idx.lock().await;
            let q = qkey("b", "k");
            assert!(idx.keys.is_empty() && idx.tombs.contains_key(&q) && idx.floors.is_empty());
            assert_eq!(idx.ceilings.len(), 1, "the writer's version-range ceiling");
            assert_eq!(
                (idx.objs.len(), idx.records.len()),
                (3, 1),
                "the payload's object (holding the tombstone), the membership record and the ceiling"
            );
        }
        maintain(&c).await;
        {
            let s = one[0].load().await.unwrap();
            let idx = s.idx.lock().await;
            assert!(idx.keys.is_empty() && idx.tombs.is_empty() && idx.floors.contains_key(&qkey("b", "k")));
            assert_eq!(idx.ceilings.len(), 1);
            assert_eq!(
                idx.objs.len(),
                idx.ledgers.len() + idx.records.len() + 1,
                "the payload is gone; the floor (and the membership record and version ceiling) stays"
            );
        }
        c.put("b", "k", b"y".to_vec(), None, &Cond::None).await.unwrap();
        assert_eq!(get(&cluster(&one, 1).await, "k").await.unwrap(), b"y");
    }

    #[test]
    fn legacy_entries_order_by_mtime_and_new_ones_by_clock() {
        let legacy: Entry = serde_json::from_str(r#"{"b":"b","k":"k","s":1,"t":"x","m":100}"#).unwrap();
        assert_eq!(legacy.ver(), Ver { h: 100_000, i: String::new() });
        let mut newer = legacy.clone();
        newer.h = 100_000;
        newer.i = "00".into();
        assert!(newer.ver() > legacy.ver(), "a write id breaks a clock tie");
        let json = serde_json::to_string(&legacy).unwrap();
        assert!(!json.contains("\"h\"") && !json.contains("\"i\""), "unversioned entries serialize as before");
    }

    #[tokio::test]
    async fn fan_out_returns_after_quorum_and_grace_or_the_deadline() {
        let t0 = std::time::Instant::now();
        let jobs: Vec<(usize, Pin<Box<dyn Future<Output = Res<u32>>>>)> = vec![(0, Box::pin(async { Ok(1) })), (1, Box::pin(std::future::pending()))];
        let out = fan_out(jobs, 1, Duration::from_millis(50), Duration::from_secs(60), |_, r| r.is_ok()).await;
        assert!(t0.elapsed() < Duration::from_secs(1));
        assert!(matches!(out[0], (0, Some(Ok(1)))) && matches!(out[1], (1, None)));
        let t0 = std::time::Instant::now();
        let jobs: Vec<(usize, Pin<Box<dyn Future<Output = Res<u32>>>>)> = vec![(0, Box::pin(std::future::pending()))];
        let out = fan_out(jobs, 1, Duration::ZERO, Duration::from_millis(100), |_, r| r.is_ok()).await;
        assert!(t0.elapsed() < Duration::from_secs(1) && out[0].1.is_none());
    }

    /// Boot a cluster over the indexers `which` (each keeps its own name and URL, whatever the set), as a restart
    /// with a changed membership would.
    async fn members(nets: &[Net], which: &[usize], w: usize) -> Cluster {
        let c = Cluster::new(which.iter().map(|i| (format!("r{i}"), format!("https://indexer-{i}.example"), false)).collect(), w, opts(), timing());
        for (j, i) in which.iter().enumerate() {
            if let Ok(s) = nets[*i].load().await {
                c.attach(j, s).await;
            }
        }
        c
    }

    #[tokio::test]
    async fn membership_repro_two_empty_indexers_and_the_old_one_offline() {
        let nets = [Net::on_disk(1), Net::on_disk(2), Net::on_disk(3)];
        // the existing single-indexer deployment (N = 1, W = 1) acknowledges a write and a delete
        let old = members(&nets, &[0], 1).await;
        old.put("b", "live", b"acknowledged".to_vec(), None, &Cond::None).await.unwrap();
        old.put("b", "gone", b"x".to_vec(), None, &Cond::None).await.unwrap();
        old.delete("b", "gone").await.unwrap();
        maintain(&old).await;
        drop(old);
        // two empty indexers are added (N = 3, W = 2) and the old one is unavailable at the restart
        nets[0].offline(true);
        let c = members(&nets, &[0, 1, 2], 2).await;
        eprintln!("REPRO-1 ready={} loaded={} live={:?}", c.ready(), c.loaded().len(), c.lookup("b", "live").map(|e| e.s));
        assert!(!c.ready(), "two empty replicas pass as the whole history: GET live -> {:?}", c.lookup("b", "live"));
    }

    #[tokio::test]
    async fn membership_repro_replacing_a_member_after_an_acknowledged_delete() {
        let nets = [Net::on_disk(1), Net::on_disk(2), Net::on_disk(3), Net::on_disk(4)];
        // {r0, r1, r2}, W = 2: the DELETE is acknowledged on r0 and r1 while r2 is down. (Since review finding P1 a set
        // without records takes no writes before it is committed, so the setup commits it first; 54818ba had no
        // commit and acknowledged the same writes directly. The assertion is unchanged.)
        let abc = members(&nets, &[0, 1, 2], 2).await;
        settle(&abc).await;
        abc.put("b", "k", b"old".to_vec(), None, &Cond::None).await.unwrap();
        nets[2].offline(true);
        abc.delete("b", "k").await.unwrap();
        drop(abc);
        nets[2].offline(false);
        // r0 is replaced by an empty r3: {r1, r2, r3}, W = 2; r1 is unavailable at the restart
        nets[1].offline(true);
        let c = members(&nets, &[1, 2, 3], 2).await;
        eprintln!("REPRO-2 ready={} loaded={} k={:?}", c.ready(), c.loaded().len(), c.lookup("b", "k").map(|e| e.s));
        assert!(!c.ready() || c.lookup("b", "k").is_none(), "an acknowledged DELETE was undone: k -> {:?}", c.lookup("b", "k"));
    }

    #[tokio::test]
    async fn membership_repro_open_multipart_upload_after_backfill() {
        let nets = [Net::on_disk(1), Net::on_disk(2), Net::on_disk(3)];
        let old = members(&nets, &[0], 1).await;
        old.put("b", "live", b"acknowledged".to_vec(), None, &Cond::None).await.unwrap();
        let uid = old.create_upload("b", "big").await.unwrap();
        let etag = old.upload_part(&uid, 1, b"part one".to_vec()).await.unwrap();
        drop(old);
        // all three up: maintenance backfills the two new indexers
        let c = members(&nets, &[0, 1, 2], 2).await;
        let r = maintain(&c).await;
        drop(c);
        // the old indexer is retired; the two backfilled ones carry on
        nets[0].offline(true);
        let c = members(&nets, &[0, 1, 2], 2).await;
        let done = c.complete_upload(&uid, &[(1, etag)]).await;
        eprintln!("REPRO-3 maintain={r:?} ready={} live={:?} complete={done:?}", c.ready(), c.lookup("b", "live").map(|e| e.s));
        assert!(done.is_ok(), "an acknowledged UploadPart was lost in the migration: {done:?}");
    }

    /// Boot a cluster over `which` = (net, retiring), each replica keeping its own name and URL.
    async fn members_with(nets: &[Net], which: &[(usize, bool)], w: usize) -> Cluster {
        let c = Cluster::new(which.iter().map(|(i, r)| (format!("r{i}"), format!("https://indexer-{i}.example"), *r)).collect(), w, opts(), timing());
        for (j, (i, _)) in which.iter().enumerate() {
            if let Ok(s) = nets[*i].load().await {
                c.attach(j, s).await;
            }
        }
        c
    }

    /// Maintenance passes without the admission step: backfill only (keys, parts, floors and version ceilings).
    async fn backfill(c: &Cluster) {
        for _ in 0..4 {
            let mut r = RepairReport::default();
            let spent = c.repair_replicas(1 << 30, &mut r).await;
            c.repair_parts(1 << 30, spent, &mut r).await;
            c.floors(&mut r).await;
            c.ceilings(&mut r).await;
        }
    }

    fn phase(c: &Cluster) -> (Phase, bool, u64) {
        let st = c.ms.borrow();
        (st.phase, st.ready, st.acting.as_ref().map_or(0, |a| a.s))
    }

    #[tokio::test]
    async fn a_deployment_without_records_migrates_only_with_every_indexer_up() {
        // 0.1.x / one indexer that never ran a maintenance pass of this version: no membership records anywhere
        let nets = [Net::on_disk(1), Net::on_disk(2), Net::on_disk(3)];
        let old = members(&nets, &[0], 1).await;
        assert_eq!(phase(&old), (Phase::Legacy, true, 0), "one indexer without records serves as before");
        old.put("b", "live", b"acknowledged".to_vec(), None, &Cond::None).await.unwrap();
        old.put("b", "gone", b"x".to_vec(), None, &Cond::None).await.unwrap();
        old.delete("b", "gone").await.unwrap();
        drop(old);

        // N = 3, W = 2 with two empty indexers: never ready, and never writable, while any indexer is missing
        for down in 0..3 {
            nets[down].offline(true);
            let c = members(&nets, &[0, 1, 2], 2).await;
            assert_eq!(phase(&c), (Phase::Legacy, false, 0), "r{down} down");
            assert!(c.put("b", "x", b"y".to_vec(), None, &Cond::None).await.unwrap_err().starts_with("ServiceUnavailable"));
            assert!(c.delete("b", "live").await.unwrap_err().starts_with("ServiceUnavailable"));
            nets[down].offline(false);
        }
        assert_eq!(on_disk(&nets[0], "live").await.0.is_some(), true, "the refused DELETE recorded nothing that counts");

        // all three up: still not served (nothing durable says this set ever acted, review P1), but maintenance runs
        // (main.rs's boot loop): it backfills, seals every listed replica, then admits them, as epoch 2
        let c = members(&nets, &[0, 1, 2], 2).await;
        assert_eq!(phase(&c), (Phase::Legacy, false, 0));
        assert!(c.finishing());
        assert!(c.put("b", "during", b"x".to_vec(), None, &Cond::None).await.unwrap_err().starts_with("ServiceUnavailable"));
        let r = maintain(&c).await;
        assert!(r.copies >= 2 && r.admitted == 6, "three seals, then three admissions: {r:?}");
        assert_eq!(phase(&c), (Phase::Stable, true, 2));
        c.put("b", "during", b"written after the commit".to_vec(), None, &Cond::None).await.unwrap();
        drop(c);

        // calling the change off (back to the one old indexer) cannot serve a view without that write: r0's seal
        // says epoch 2 replaced it (review P2)
        let back = members(&nets, &[0], 1).await;
        assert_eq!(phase(&back), (Phase::Waiting, false, 2));

        // the old indexer is gone for good: the two admitted ones serve everything, and the delete
        nets[0].offline(true);
        let c = members(&nets, &[0, 1, 2], 2).await;
        assert_eq!(phase(&c), (Phase::Stable, true, 2));
        assert_eq!(get(&c, "live").await.unwrap(), b"acknowledged");
        assert_eq!(get(&c, "during").await.unwrap(), b"written after the commit");
        assert!(c.lookup("b", "gone").is_none());
        for n in &nets[1..] {
            assert_eq!(on_disk(n, "gone").await.1, true, "the floor reached the new indexer");
        }
    }

    #[tokio::test]
    async fn a_recorded_single_indexer_keeps_serving_while_new_members_are_backfilled() {
        let nets = [Net::on_disk(1), Net::on_disk(2), Net::on_disk(3)];
        let old = members(&nets, &[0], 1).await;
        old.put("b", "live", b"acknowledged".to_vec(), None, &Cond::None).await.unwrap();
        old.put("b", "gone", b"x".to_vec(), None, &Cond::None).await.unwrap();
        old.delete("b", "gone").await.unwrap();
        let r = maintain(&old).await;
        assert_eq!((r.admitted, phase(&old)), (1, (Phase::Stable, true, 1)), "the first pass records the one indexer");
        drop(old);

        // the reported failure: N = 3, W = 2, the old indexer unavailable -> two empty replicas are not the history
        nets[0].offline(true);
        let c = members(&nets, &[0, 1, 2], 2).await;
        assert_eq!(phase(&c), (Phase::Legacy, false, 0), "the new replicas have no records; the old one is not loaded");
        assert!(c.check("b", "live", &Cond::IfNoneMatch).is_ok() && !c.ready(), "the empty view is never served");
        drop(c);

        // the old indexer alone, the new ones down: served under the old membership's rules (it votes, W = 1)
        nets[0].offline(false);
        nets[1].offline(true);
        nets[2].offline(true);
        let c = members(&nets, &[0, 1, 2], 2).await;
        assert_eq!(phase(&c), (Phase::Migrating, true, 1));
        assert_eq!(get(&c, "live").await.unwrap(), b"acknowledged");
        c.put("b", "during", b"acknowledged by the old member".to_vec(), None, &Cond::None).await.unwrap();
        maintain(&c).await;
        assert_eq!(phase(&c), (Phase::Migrating, true, 1), "nothing commits without every new member");
        drop(c);

        // everyone up: the new members get written to but do not vote until admitted
        nets[1].offline(false);
        nets[2].offline(false);
        let c = members(&nets, &[0, 1, 2], 2).await;
        assert_eq!(phase(&c), (Phase::Migrating, true, 1));
        assert_eq!(c.voters(), vec![0]);
        let r = maintain(&c).await;
        assert!(r.copies >= 4 && r.admitted == 4, "a seal on the old member, then three admissions: {r:?}");
        assert_eq!(phase(&c), (Phase::Stable, true, 3));
        drop(c);

        nets[0].offline(true);
        let c = members(&nets, &[0, 1, 2], 2).await;
        assert_eq!(phase(&c), (Phase::Stable, true, 3));
        assert_eq!(get(&c, "live").await.unwrap(), b"acknowledged");
        assert_eq!(get(&c, "during").await.unwrap(), b"acknowledged by the old member");
        assert!(c.lookup("b", "gone").is_none());
        // stable membership availability is unchanged: one indexer down still serves and writes
        c.put("b", "after", b"z".to_vec(), None, &Cond::None).await.unwrap();
    }

    #[tokio::test]
    async fn replacing_a_member_keeps_an_acknowledged_delete_and_the_old_set_never_serves_again() {
        let nets = [Net::on_disk(1), Net::on_disk(2), Net::on_disk(3), Net::on_disk(4)];
        // {r0, r1, r2}, W = 2, admitted at epoch 2 (a set without records commits as epoch 2); the DELETE is acknowledged on r0 and r1 while r2 is down
        let abc = members(&nets, &[0, 1, 2], 2).await;
        settle(&abc).await;
        assert_eq!(phase(&abc), (Phase::Stable, true, 2));
        abc.put("b", "k", b"old".to_vec(), None, &Cond::None).await.unwrap();
        nets[2].offline(true);
        abc.delete("b", "k").await.unwrap();
        drop(abc);
        nets[2].offline(false);

        // r0 is replaced by an empty r3: {r1, r2, r3}. With r1 down only r2 (which missed the DELETE) is admitted:
        // epoch 2 may still be serving from r0 and r1, so this waits
        nets[1].offline(true);
        let c = members(&nets, &[1, 2, 3], 2).await;
        assert_eq!(phase(&c), (Phase::Waiting, false, 2));
        drop(c);

        // r1 back: epoch 2's rules serve (r1, r2 vote), the new set is backfilled, then committed as epoch 3
        nets[1].offline(false);
        let c = members(&nets, &[1, 2, 3], 2).await;
        assert_eq!(phase(&c), (Phase::Migrating, true, 2));
        assert!(c.lookup("b", "k").is_none());
        let r = maintain(&c).await;
        assert!(r.admitted == 5, "seals on r1 and r2, admissions of r1, r2, r3: {r:?}");
        assert_eq!(phase(&c), (Phase::Stable, true, 3));
        drop(c);

        // epoch 3 with r1 down: r2 and r3 are admitted and both hold the deletion
        nets[1].offline(true);
        let c = members(&nets, &[1, 2, 3], 2).await;
        assert_eq!(phase(&c), (Phase::Stable, true, 3));
        assert!(c.lookup("b", "k").is_none());
        for n in &nets[2..] {
            assert_eq!(on_disk(n, "k").await.1, true, "the floor is on r{}", if std::ptr::eq(n, &nets[2]) { 2 } else { 3 });
        }
        drop(c);

        // reverting the configuration to the old set cannot bring epoch 2 back: its quorum meets a seal
        let old = members(&nets, &[0, 1, 2], 2).await;
        assert_eq!(phase(&old), (Phase::Waiting, false, 3), "epoch 3 may be serving from r1 and r3");
        nets[1].offline(false);
    }

    #[tokio::test]
    async fn a_retiring_replica_hands_over_open_multipart_uploads() {
        let nets = [Net::on_disk(1), Net::on_disk(2), Net::on_disk(3)];
        let old = members(&nets, &[0], 1).await;
        maintain(&old).await;
        let uid = old.create_upload("b", "big").await.unwrap();
        let p1 = old.upload_part(&uid, 1, vec![7u8; 5 << 20]).await.unwrap();
        let p2 = old.upload_part(&uid, 2, b"tail".to_vec()).await.unwrap();
        drop(old);

        // r0 leaves: listed as retiring, it is the source and seal holder; r1 and r2 are the new set
        let c = members_with(&nets, &[(0, true), (1, false), (2, false)], 2).await;
        assert_eq!(phase(&c), (Phase::Migrating, true, 1));
        let r = maintain(&c).await;
        assert!(r.parts == 4 && r.admitted == 3, "two parts to each new member; a seal on r0, two admissions: {r:?}");
        assert_eq!(phase(&c), (Phase::Stable, true, 3));
        assert_eq!(c.voters(), vec![1, 2], "the retiring replica no longer votes");
        drop(c);

        // r0 is dropped from the configuration; the upload completes on the new set alone
        nets[0].offline(true);
        let c = members_with(&nets, &[(1, false), (2, false)], 2).await;
        assert_eq!(phase(&c), (Phase::Stable, true, 3));
        let (_, _, etag) = c.complete_upload(&uid, &[(1, p1), (2, p2)]).await.unwrap();
        assert!(etag.ends_with("-2"));
        let mut want = vec![7u8; 5 << 20];
        want.extend_from_slice(b"tail");
        assert_eq!(get(&c, "big").await.unwrap(), want);
        drop(c);

        // reverting to the retired indexer alone (N = 1 again, the new set down) cannot serve its stale view, which
        // lacks "big": its seal says epoch 3 replaced it, and epoch 3's members may be serving
        nets[0].offline(false);
        nets[1].offline(true);
        nets[2].offline(true);
        let back = members(&nets, &[0], 1).await;
        assert_eq!(phase(&back), (Phase::Waiting, false, 3));
        assert!(back.lookup("b", "big").is_none() && !back.ready());
    }

    #[tokio::test]
    async fn an_interrupted_commit_is_finished_before_anything_is_served() {
        let nets = [Net::on_disk(1), Net::on_disk(2), Net::on_disk(3)];
        let old = members(&nets, &[0], 1).await;
        maintain(&old).await;
        old.put("b", "live", b"acknowledged".to_vec(), None, &Cond::None).await.unwrap();
        drop(old);

        let c = members(&nets, &[0, 1, 2], 2).await;
        backfill(&c).await;
        // the seal and r0's admission land; r1's and r2's admissions never answer
        nets[1].net.push_fault("pin_object", Fault::Hang);
        nets[2].net.push_fault("pin_object", Fault::Hang);
        let r = settle(&c).await;
        assert_eq!(r.admitted, 2, "{r:?}");
        assert_eq!(phase(&c), (Phase::Pending, false, 3), "sealed: the old set no longer acts, the new one is not ready");
        assert!(c.put("b", "x", b"y".to_vec(), None, &Cond::None).await.unwrap_err().starts_with("ServiceUnavailable"));
        drop(c);

        // a restart sees the same: finishing comes first (main.rs runs maintenance while pending)
        let c = members(&nets, &[0, 1, 2], 2).await;
        assert!(c.finishing() && c.ms.borrow().phase == Phase::Pending && !c.ready());
        let r = maintain(&c).await;
        assert_eq!(r.admitted, 2, "{r:?}");
        assert_eq!(phase(&c), (Phase::Stable, true, 3));
        drop(c);
        nets[0].offline(true);
        let c = members(&nets, &[0, 1, 2], 2).await;
        assert_eq!(get(&c, "live").await.unwrap(), b"acknowledged");
    }

    #[test]
    fn membership_states_follow_the_records() {
        let c = Cluster::new((0..3).map(|i| (format!("r{i}"), format!("https://indexer-{i}.example"), false)).collect(), 2, opts(), timing());
        let id = |i: usize| c.replicas[i].id.clone();
        let def = |s: u64, w: u32, of: &[usize]| {
            let mut m: Vec<String> = of.iter().map(|i| id(*i)).collect();
            m.sort();
            MsDef { s, w, m }
        };
        let rec = |k: &str, d: &MsDef, p: Option<&MsDef>| MsRec { k: k.into(), d: d.clone(), p: p.cloned(), c: 0 };
        let cfg = def(1, 2, &[0, 1, 2]);
        let one = def(1, 1, &[0]);
        let next = MsDef { s: 3, ..cfg.clone() }; // a recorded change from epoch 1 skips epoch 2 (record-less only)

        // no records: every configured replica must be loaded
        assert_eq!(c.membership(&[(0, vec![]), (1, vec![])]).ready, false);
        let st = c.membership(&[(0, vec![]), (1, vec![]), (2, vec![])]);
        assert_eq!((st.phase, st.ready, st.voters.len(), st.commit, st.finish), (Phase::Legacy, false, 0, true, true), "committed before serving (P1)");
        assert_eq!((st.target.s, st.seal_to.clone(), st.seal_needed), (2, vec![0, 1, 2], 3), "epoch 2, a seal on every listed replica (P2)");
        // admitted at the configured set: N - W + 1 admitted members serve, and only they vote
        let a = rec("a", &cfg, None);
        let st = c.membership(&[(0, vec![a.clone()]), (1, vec![a.clone()]), (2, vec![])]);
        assert_eq!((st.phase, st.ready, st.voters.clone()), (Phase::Stable, true, vec![0, 1]));
        let st = c.membership(&[(0, vec![a.clone()]), (2, vec![])]);
        assert_eq!((st.phase, st.ready), (Phase::Waiting, false), "r1 may hold the other admission");
        // another set admitted (one old indexer): it serves, and the configured set is the target
        let st = c.membership(&[(0, vec![rec("a", &one, None)]), (1, vec![])]);
        assert_eq!((st.phase, st.ready, st.voters.clone(), st.need), (Phase::Migrating, true, vec![0], 1));
        assert_eq!((st.target.clone(), st.prev.clone(), st.seal_to.clone(), st.seal_needed), (next.clone(), Some(one.clone()), vec![0], 1));
        // sealed, never admitted by a quorum: finished from the sealed old member, not served
        let sealed = rec("s", &next, Some(&one));
        let st = c.membership(&[(0, vec![rec("a", &one, None), sealed.clone()]), (1, vec![]), (2, vec![])]);
        assert_eq!((st.phase, st.ready, st.sources.clone(), st.sources_needed), (Phase::Pending, false, vec![0], 1));
        // ... but not while an unloaded member might hold enough admissions
        let st = c.membership(&[(0, vec![rec("a", &one, None), sealed.clone(), rec("a", &next, Some(&one))]), (1, vec![])]);
        assert_eq!((st.phase, st.ready), (Phase::Waiting, false));
        // records that disagree at the top epoch are refused
        let st = c.membership(&[(0, vec![rec("a", &next, Some(&one))]), (1, vec![rec("a", &next, None)])]);
        assert_eq!((st.phase, st.ready), (Phase::Refused, false));
        // a sealed change to another set than the configured one is refused, not silently abandoned
        let other = def(3, 1, &[0, 1]);
        let st = c.membership(&[(0, vec![rec("s", &other, Some(&one))]), (1, vec![]), (2, vec![])]);
        assert_eq!((st.phase, st.ready), (Phase::Refused, false));

        // P2: a set without records was committed (epoch 2) but r0's own admission failed: r0 holds only its seal.
        // Listing r0 alone again (calling the change off) waits for epoch 2's members instead of serving r0's view.
        let solo = Cluster::new(vec![("r0".into(), "https://indexer-0.example".into(), false)], 1, opts(), timing());
        let set = def(2, 2, &[0, 1, 2]);
        let st = solo.membership(&[(0, vec![rec("s", &set, None)])]);
        assert_eq!((st.phase, st.ready), (Phase::Waiting, false));
        let st = solo.membership(&[(0, vec![])]);
        assert_eq!((st.phase, st.ready), (Phase::Legacy, true), "without the seal it would have served (the bug)");

        // P4: two sets at one epoch. Records naming a previous set, and admissions for exactly one of them: that one
        // acts, the other's seal is inert. Without a previous set, or with no admissions visible: refused.
        let t1 = def(3, 2, &[0, 1]);
        let t2 = MsDef { s: 3, ..cfg.clone() };
        let st = c.membership(&[
            (0, vec![rec("a", &one, None), rec("s", &t2, Some(&one)), rec("a", &t2, Some(&one))]),
            (1, vec![rec("s", &t1, Some(&one))]),
            (2, vec![rec("a", &t2, Some(&one))]),
        ]);
        assert_eq!((st.phase, st.ready, st.voters.clone()), (Phase::Stable, true, vec![0, 2]), "resolved to the admitted set");
        let st = c.membership(&[(0, vec![rec("s", &t2, Some(&one))]), (1, vec![rec("s", &t1, Some(&one))]), (2, vec![])]);
        assert_eq!(st.phase, Phase::Refused, "no admissions visible: which set is current is unknown");
        let st = c.membership(&[(0, vec![rec("a", &t2, None)]), (1, vec![rec("a", &t1, None)]), (2, vec![rec("a", &t2, None)])]);
        assert_eq!(st.phase, Phase::Refused, "records without a previous set are never resolved");
    }

    // ---- ported verbatim from the storage-safety worktree (B2, B3, B4) ----

    // ---- B2: a manifest body that cannot be read (its hosts are gone, slow, or it is corrupt) ----

    /// Re-pin key `k`'s manifest object with a body hash that no longer matches its body: what a load sees when the
    /// manifest's sectors cannot be read back intact (`read_body` refuses the body either way).
    async fn corrupt_manifest(s: &Store, k: &str) {
        let (obj, meta) = {
            let idx = s.idx.lock().await;
            let key = &idx.keys[&("b".to_string(), k.to_string())];
            assert!(key.manifest, "{k} is stored behind a manifest");
            idx.objs[&key.host].clone()
        };
        let mut meta: crate::store::Meta = meta;
        meta.mf.as_mut().unwrap().z = "0".repeat(64);
        let mut obj = obj;
        obj.metadata = serde_json::to_vec(&meta).unwrap();
        s.sdk.pin_object(&obj).await.unwrap();
    }

    /// A content type long enough that an entry for a 700-character key no longer fits inline (manifest), while the
    /// same key without it does.
    fn wide_type() -> Option<String> {
        Some(format!("x/{}", "y".repeat(200)))
    }

    #[tokio::test]
    async fn an_unreadable_manifest_of_a_live_version_keeps_the_replica_unloaded() {
        // disk-backed: every version pins one or two full slabs
        let n = Net::on_disk(61);
        let c = cluster(std::slice::from_ref(&n), 1).await;
        let key = "k".repeat(700);
        c.put("b", &key, b"old bytes".to_vec(), None, &Cond::None).await.unwrap();
        assert!(!c.store(0).unwrap().idx.lock().await.keys[&("b".to_string(), key.clone())].manifest, "v1 is inline");
        // v2 needs a manifest; the old entry's removal hangs, so v1 stays on the indexer (as after any failed cleanup)
        n.net.push_fault("delete_object", Fault::Hang);
        c.put("b", &key, b"new bytes".to_vec(), wide_type(), &Cond::None).await.unwrap();
        assert_eq!(get(&c, &key).await.unwrap(), b"new bytes");
        {
            // the stale v1 entry really is still listed beside v2
            let s = n.load().await.unwrap();
            let idx = s.idx.lock().await;
            let named = idx.objs.values().filter(|(_, m)| m.e.iter().any(|e| e.k == key)).count();
            assert_eq!(named, 1, "the old inline entry is left behind");
            assert!(idx.keys[&("b".to_string(), key.clone())].manifest);
        }
        corrupt_manifest(&c.store(0).unwrap(), &key).await;

        // Before the fix the replica loaded without v2 and served the stale "old bytes" for an acknowledged overwrite
        // (and counted toward the boot quorum). Now it stays unloaded, and a cluster of it is not ready.
        let err = n.load().await.err().expect("a replica must not load without the manifest of a live version");
        assert!(err.contains("manifest"), "{err}");
        let boot = cluster(std::slice::from_ref(&n), 1).await;
        assert!(!boot.ready());
        assert!(boot.lookup("b", &key).is_none());
    }

    #[tokio::test]
    async fn an_unreadable_manifest_of_a_dead_version_does_not_block_and_is_purged() {
        let n = Net::on_disk(62);
        let c = cluster(std::slice::from_ref(&n), 1).await;
        let key = "d".repeat(700);
        c.put("b", &key, b"first".to_vec(), wide_type(), &Cond::None).await.unwrap();
        corrupt_manifest(&c.store(0).unwrap(), &key).await;
        // v2 supersedes v1; v1's manifest object stays behind (its deletion hangs), unreadable
        n.net.push_fault("delete_object", Fault::Hang);
        c.put("b", &key, b"second".to_vec(), wide_type(), &Cond::None).await.unwrap();

        let s = n.load().await.expect("a superseded unreadable manifest does not keep the replica unloaded");
        {
            let idx = s.idx.lock().await;
            assert_eq!(idx.unresolved.len(), 1);
            assert!(idx.blocking_unresolved().is_empty());
        }
        let boot = cluster(std::slice::from_ref(&n), 1).await;
        assert!(boot.ready());
        assert_eq!(get(&boot, &key).await.unwrap(), b"second");
        maintain(&boot).await;
        assert!(boot.store(0).unwrap().idx.lock().await.unresolved.is_empty(), "purge removed the dead manifest");
        assert!(n.load().await.unwrap().idx.lock().await.unresolved.is_empty());
        assert_eq!(get(&boot, &key).await.unwrap(), b"second");
    }

    // ---- B3: re-reading a replica while other tasks change it through the old store ----

    #[tokio::test]
    async fn a_re_read_never_swaps_out_a_pin_still_in_flight() {
        let n = Net::on_disk(63);
        let c = cluster(std::slice::from_ref(&n), 1).await;
        let uid = c.create_upload("b", "mp").await.unwrap();
        let s = c.store(0).unwrap();
        // the part's pin is held open by the indexer, which applies it while the re-read is deciding
        n.net.push_fault("pin_object", Fault::Defer);
        let part = c.upload_part(&uid, 1, b"part one".to_vec());
        let racer = async {
            for _ in 0..4000 {
                if s.in_flight() > 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(s.in_flight(), 1, "the part's pin is in flight");
            let r = c.reconcile(0).await;
            assert_eq!(n.net.apply_deferred(), 1);
            r
        };
        let (part, swap) = tokio::join!(part, racer);
        // Before the fix the swap went ahead: the fresh index (listed before the pin landed) lacked the part, was not
        // dirty, and CompleteMultipartUpload failed with InvalidPart for a part the indexer holds.
        assert!(swap.is_err(), "no swap while a pin is in flight");
        assert!(Rc::ptr_eq(&c.store(0).unwrap(), &s) && !s.is_retired());
        assert!(part.is_err() && s.dirty(), "the pin's outcome is unknown to the caller: the replica will be re-read");
        maintain(&c).await;
        assert!(s.is_retired(), "the quiet replica was re-read and swapped");
        c.complete_upload(&uid, &[(1, md5_hex(b"part one"))]).await.expect("the applied part is known after the re-read");
        assert_eq!(get(&c, "mp").await.unwrap(), b"part one");
    }

    #[tokio::test]
    async fn a_re_read_never_waits_on_a_busy_index_while_holding_the_write_lock() {
        let n = Net::on_disk(64);
        let c = cluster(std::slice::from_ref(&n), 1).await;
        c.put("b", "k", b"v".to_vec(), None, &Cond::None).await.unwrap();
        let s = c.store(0).unwrap();
        // what the compactor holds while it pins repacked objects and deletes the originals
        let held = s.idx.lock().await;
        // Before the fix reconcile waited for this lock while holding the write lock (every write stalled), and then
        // swapped in a listing that predated whatever the holder changed.
        let r = tokio::time::timeout(Duration::from_secs(20), c.reconcile(0)).await.expect("reconcile returns instead of waiting");
        let e = r.unwrap_err();
        assert!(e.contains("busy"), "{e}");
        assert!(!s.is_retired() && Rc::ptr_eq(&c.store(0).unwrap(), &s));
        drop(held);
        c.put("b", "k2", b"w".to_vec(), None, &Cond::None).await.unwrap();
        c.reconcile(0).await.unwrap();
        assert!(s.is_retired());
        assert_eq!(get(&c, "k").await.unwrap(), b"v");
        assert_eq!(get(&c, "k2").await.unwrap(), b"w");
    }

    #[tokio::test]
    async fn a_replaced_store_sends_nothing_more() {
        let n = Net::on_disk(65);
        let c = cluster(std::slice::from_ref(&n), 1).await;
        let uid = c.create_upload("b", "mp").await.unwrap();
        let old = c.store(0).unwrap();
        c.reconcile(0).await.unwrap();
        assert!(old.is_retired() && !Rc::ptr_eq(&old, &c.store(0).unwrap()));

        // callers still holding the old Rc (a DELETE's floor write, an UploadPart, the compactor) get a refusal that
        // changed nothing; before the fix these reached the indexer behind the fresh index's back
        let floor = Tomb { q: qkey("b", "gone"), h: 1, i: "w".into() };
        let e = old.write_ledger(vec![floor]).await.unwrap_err();
        assert!(e.contains("replaced"), "{e}");
        let e = old.upload_part(&uid, 1, Rc::from(&b"late part"[..])).await.unwrap_err();
        assert!(e.contains("replaced"), "{e}");
        assert_eq!(old.in_flight(), 0);
        assert!(!old.dirty(), "nothing was sent, so nothing is ambiguous");
        {
            let after = n.load().await.unwrap();
            let idx = after.idx.lock().await;
            assert!(idx.ledgers.is_empty() && idx.floors.is_empty(), "no ledger reached the indexer");
            assert!(idx.uploads.get(&uid).is_none_or(|u| u.parts.is_empty()), "no part reached the indexer");
        }
        // the current store serves and takes writes as before
        c.upload_part(&uid, 1, b"part".to_vec()).await.unwrap();
        c.complete_upload(&uid, &[(1, md5_hex(b"part"))]).await.unwrap();
        assert_eq!(get(&c, "mp").await.unwrap(), b"part");
    }
    // ---- B4: cross-writer ordering by durable version-range ceilings ----

    #[tokio::test]
    async fn an_old_writers_abandoned_write_stays_below_a_new_writers_delete_whatever_the_clocks_say() {
        let n = Net::on_disk(81);
        // writer P1: its clock runs an hour ahead of the next writer's
        let p1 = cluster(std::slice::from_ref(&n), 1).await;
        p1.clock.set(now_ms() + 3_600_000);
        p1.put("b", "k", b"v1".to_vec(), None, &Cond::None).await.unwrap();
        // P1's next PUT of k is stamped (a second later on P1's clock) and sent; its answer never comes, and the indexer
        // applies it only later (Fault::Defer)
        p1.clock.set(p1.clock.get() + 1000);
        n.net.push_fault("pin_object", Fault::Defer);
        assert!(p1.put("b", "k", b"stale".to_vec(), None, &Cond::None).await.is_err());
        let p1_ceiling = p1.version_ceiling();
        assert!(p1_ceiling > now_ms() + 3_600_000);
        drop(p1); // P1 stops (one writer at a time)

        // writer P2 boots with an honest clock, an hour behind P1's, and deletes k
        let p2 = cluster(std::slice::from_ref(&n), 1).await;
        assert_eq!(p2.observed_ceiling(), p1_ceiling, "P2's boot set holds P1's acknowledged ceiling");
        assert_eq!(get(&p2, "k").await.unwrap(), b"v1");
        p2.delete("b", "k").await.unwrap();
        let t = p2.view.borrow().tombs[&qkey("b", "k")].clone();
        assert!(t.h > p1_ceiling, "the deletion is stamped above everything P1 could have stamped");

        // now the indexer applies P1's abandoned PUT
        assert_eq!(n.net.apply_deferred(), 1);
        // Before B4 the deletion was stamped just past the versions P2 loaded (v1 + 1 ms), below the stale PUT's
        // version (v1 + 1000 ms on P1's clock), so a reload served "stale": a deleted key came back.
        let p3 = cluster(std::slice::from_ref(&n), 1).await;
        assert!(p3.lookup("b", "k").is_none(), "an abandoned write of an earlier writer does not resurrect a delete");
        maintain(&p3).await;
        let p4 = cluster(std::slice::from_ref(&n), 1).await;
        assert!(p4.lookup("b", "k").is_none());
        assert_eq!(on_disk(&n, "k").await, (None, true, false), "the stale version was purged; only the floor remains");
    }

    #[tokio::test]
    async fn versions_are_stamped_only_inside_a_reserved_range() {
        let n = Net::on_disk(82);
        let c = cluster(std::slice::from_ref(&n), 1).await;
        assert_eq!(c.stats.borrow().version_fence, "legacy", "no ceiling yet: a legacy deployment");
        assert!(c.stamp().is_err(), "nothing is stamped before a range is reserved");
        c.range_ms.set(60_000);
        c.put("b", "a", b"1".to_vec(), None, &Cond::None).await.unwrap();
        let first = c.version_ceiling();
        assert!(first > 0 && c.lookup("b", "a").unwrap().h <= first);
        assert_eq!(c.stats.borrow().version_fence, "ceiling");
        // this writer's own ceiling, found again by a rebuild (every attach, re-read and maintenance pass), does not
        // move its clock: the range is not burnt, and the next write needs no new reservation
        c.rebuild().await;
        assert_eq!(c.observed_ceiling(), first);
        c.put("b", "b", b"x".to_vec(), None, &Cond::None).await.unwrap();
        assert_eq!(c.version_ceiling(), first, "no reservation for a write inside the range");
        // the range is used up: the clock has reached the ceiling
        c.clock.set(first);
        assert!(c.stamp().is_err(), "never a version above the acknowledged ceiling");
        c.put("b", "a", b"2".to_vec(), None, &Cond::None).await.unwrap();
        let second = c.version_ceiling();
        let h = c.lookup("b", "a").unwrap().h;
        assert!(second > first && h > first && h <= second, "a new range is reserved strictly above the old one");
        // one ceiling object per replica at steady state, and a fresh load sees the newest
        let s = n.load().await.unwrap();
        let idx = s.idx.lock().await;
        assert_eq!((idx.ceiling, idx.ceilings.len()), (second, 1));
        assert!(idx.orphans.is_empty(), "a ceiling object is never an orphan");
    }

    #[tokio::test]
    async fn a_lagging_replica_gets_the_ceiling_and_a_late_reservation_only_raises_it() {
        let nets = [Net::on_disk(83), Net::on_disk(84)];
        let c = cluster(&nets, 1).await;
        nets[1].offline(true);
        c.put("b", "k", b"v".to_vec(), None, &Cond::None).await.unwrap(); // the range is acknowledged by r0 alone
        let ceiling = c.version_ceiling();
        nets[1].offline(false);
        assert_eq!(c.store(1).unwrap().ceiling().await, 0);
        let rep = maintain(&c).await;
        assert!(rep.ceilings >= 1, "{rep:?}");
        assert_eq!(nets[1].load().await.unwrap().idx.lock().await.ceiling, ceiling, "r1 now holds it too");

        // a reservation whose pin is answered nowhere in time fails (no versions are stamped in it) ...
        let solo = Net::on_disk(85);
        let w = cluster(std::slice::from_ref(&solo), 1).await;
        solo.net.push_fault("pin_object", Fault::Defer);
        assert!(w.put("b", "x", b"x".to_vec(), None, &Cond::None).await.is_err());
        assert_eq!(w.version_ceiling(), 0);
        // ... and when the indexer applies it later it only raises what the next writer starts above
        assert_eq!(solo.net.apply_deferred(), 1);
        let next = cluster(std::slice::from_ref(&solo), 1).await;
        let late = next.observed_ceiling();
        assert!(late > 0, "the late reservation is found at boot");
        next.put("b", "x", b"y".to_vec(), None, &Cond::None).await.unwrap();
        assert!(next.lookup("b", "x").unwrap().h > late, "the next writer stamps strictly above it");
        assert!(next.version_ceiling() > late, "and reserves strictly above it");
    }

    // ---- integration: version-range reservations (B4) across membership changes, with B2/B3 ----

    /// As `members_with`, with a longer metadata deadline: a deferred pin then stays in flight long enough to race.
    async fn members_slow(nets: &[Net], which: &[(usize, bool)], w: usize) -> Cluster {
        let o = Opts { meta_timeout: Duration::from_secs(6), ..opts() };
        let c = Cluster::new(which.iter().map(|(i, r)| (format!("r{i}"), format!("https://indexer-{i}.example"), *r)).collect(), w, o.clone(), timing());
        for (j, (i, _)) in which.iter().enumerate() {
            let sdk = nets[*i].net.sdk(nets[*i].key.clone()).await.unwrap();
            if let Ok(s) = Store::load_with(sdk, 8 << 20, o.clone()).await {
                c.attach(j, Rc::new(s)).await;
            }
        }
        c
    }

    #[tokio::test]
    async fn a_reservation_counts_only_voting_replicas() {
        // M1: a version range is usable only once W *voters* of the acting membership hold it
        let mut nets = vec![Net::new(1), Net::new(2), Net::new(3)];
        let c = members(&nets, &[0, 1, 2], 2).await;
        settle(&c).await;
        assert_eq!(phase(&c), (Phase::Stable, true, 2));
        drop(c);
        // r2's indexer comes back having lost its state (no record, no data): a member that does not vote yet
        nets[2] = Net::new(3);
        let c = members(&nets, &[0, 1, 2], 2).await;
        assert_eq!((phase(&c), c.voters()), ((Phase::Stable, true, 2), vec![0, 1]));
        // r1 is down: the reservation reaches r0 (a voter) and r2 (not admitted): one vote of the two needed
        nets[1].offline(true);
        let e = c.ensure_range(STAMP_LOW_MS).await.unwrap_err();
        assert!(e.starts_with("ServiceUnavailable") && e.contains("version range") && e.contains("reached 1 of"), "{e}");
        assert_eq!(c.version_ceiling(), 0, "nothing may be stamped in a range W voters do not hold");
        assert!(c.stamp().is_err());
        // the unacknowledged ceiling r0 and r2 hold only raises what later writers start above
        c.rebuild().await;
        let stray = c.observed_ceiling();
        assert!(stray > 0);
        nets[1].offline(false);

        // maintenance gives r1 the ceiling and backfills and admits r2; then r2 votes
        let r = maintain(&c).await;
        assert!(r.ceilings >= 1 && r.admitted == 1, "{r:?}");
        assert_eq!(c.voters(), vec![0, 1, 2]);
        nets[1].offline(true);
        c.put("b", "k", b"v".to_vec(), None, &Cond::None).await.unwrap(); // reservation acknowledged by r0 and r2
        assert!(c.version_ceiling() > stray && c.lookup("b", "k").unwrap().h > stray);
        nets[1].offline(false);
    }

    #[tokio::test]
    async fn a_commit_waits_for_the_ceiling_and_carries_it_past_a_skewed_old_writer() {
        // M2: a migration commits only once every new member holds the highest known ceiling, and its records carry
        // it, so a writer booting from the new set alone starts above every version the old writer could stamp
        let nets = [Net::new(1), Net::new(2), Net::new(3)];
        let old = members(&nets, &[0], 1).await;
        maintain(&old).await;
        drop(old);
        // migrating {r0} -> {r1, r2} (r0 retiring). Writer P1's clock runs an hour ahead; r1 and r2 are down for its
        // reservation (W = 1 under the old set: r0 alone acknowledges it)
        nets[1].offline(true);
        nets[2].offline(true);
        let p1 = members_with(&nets, &[(0, true), (1, false), (2, false)], 2).await;
        assert_eq!(phase(&p1), (Phase::Migrating, true, 1));
        p1.clock.set(now_ms() + 3_600_000);
        p1.put("b", "k", b"v1".to_vec(), None, &Cond::None).await.unwrap();
        let p1_ceiling = p1.version_ceiling();
        assert!(p1_ceiling > now_ms() + 3_600_000);
        nets[1].offline(false);
        nets[2].offline(false);
        // they come back and load (main.rs retries every replica's load); they hold no ceiling
        for i in [1, 2] {
            let s = nets[i].load().await.unwrap();
            assert_eq!(s.ceiling().await, 0);
            p1.attach(i, s).await;
        }
        assert_eq!(phase(&p1), (Phase::Migrating, true, 1));
        // P1's next PUT of k is stamped a second later on its clock; no indexer answers it (each applies it later)
        p1.clock.set(p1.clock.get() + 1000);
        for n in &nets {
            n.net.push_fault("pin_object", Fault::Defer);
        }
        assert!(p1.put("b", "k", b"stale".to_vec(), None, &Cond::None).await.is_err());
        // backfill v1 (re-reading the replicas the abandoned pins made dirty), but the ceiling copies fail (their
        // uploads are refused: nothing ambiguous, the replicas stay clean). A listing that starts in the same
        // millisecond as the last unknown outcome counts as dirty (`dirty` is >=), so let the clock move first.
        tokio::time::sleep(Duration::from_millis(5)).await;
        for i in 0..3 {
            p1.reconcile(i).await.unwrap();
        }
        let mut r = RepairReport::default();
        p1.repair_replicas(1 << 30, &mut r).await;
        assert_eq!(r.copies, 2);
        nets[1].net.set_pin_slabs_failures(3);
        nets[2].net.set_pin_slabs_failures(3);
        let mut r = RepairReport::default();
        p1.ceilings(&mut r).await;
        assert_eq!((r.ceilings, r.pending), (0, 2), "{r:?}");
        assert!(!p1.store(1).unwrap().dirty() && !p1.store(2).unwrap().dirty());
        // every new member holds every key, deletion and part, but not the ceiling: no commit
        let r = settle(&p1).await;
        assert_eq!(r.admitted, 0, "{r:?}");
        assert_eq!(phase(&p1), (Phase::Migrating, true, 1));
        // next pass: the ceiling reaches them, the change commits, and the records carry the ceiling
        let r = maintain(&p1).await;
        assert!(r.ceilings == 2 && r.admitted == 3, "{r:?}");
        assert_eq!(phase(&p1), (Phase::Stable, true, 3));
        for n in &nets[1..] {
            let s = n.load().await.unwrap();
            let idx = s.idx.lock().await;
            assert!(idx.ceiling >= p1_ceiling);
            assert!(idx.records.iter().any(|(_, r)| r.admit() && r.d.s == 3 && r.c >= p1_ceiling), "the admission carries the ceiling");
        }
        drop(p1);

        // writer P2 boots from the new set alone (r0 is gone), with an honest clock an hour behind P1's
        nets[0].offline(true);
        let p2 = members_with(&nets, &[(1, false), (2, false)], 2).await;
        assert_eq!(phase(&p2), (Phase::Stable, true, 3));
        assert!(p2.observed_ceiling() >= p1_ceiling);
        assert_eq!(get(&p2, "k").await.unwrap(), b"v1");
        p2.delete("b", "k").await.unwrap();
        assert!(p2.view.borrow().tombs[&qkey("b", "k")].h > p1_ceiling);
        // the new members' indexers now apply P1's abandoned PUT: it stays below the deletion
        for n in &nets[1..] {
            assert_eq!(n.net.apply_deferred(), 1);
        }
        let p3 = members_with(&nets, &[(1, false), (2, false)], 2).await;
        assert!(p3.lookup("b", "k").is_none(), "an abandoned write of the old writer does not resurrect the delete");
        maintain(&p3).await;
        for n in &nets[1..] {
            assert_eq!(on_disk(n, "k").await, (None, true, false));
        }
    }

    #[tokio::test]
    async fn a_partially_sealed_change_refuses_writes_and_reservations_until_finished() {
        let nets = [Net::new(1), Net::new(2), Net::new(3), Net::new(4)];
        let abc = members(&nets, &[0, 1, 2], 2).await;
        settle(&abc).await;
        abc.put("b", "k", b"v".to_vec(), None, &Cond::None).await.unwrap();
        let c1 = abc.version_ceiling();
        drop(abc);
        // r0 is replaced by r3 (r0 retiring); the seals on r0 and r1 never answer: 1 of the 2 needed
        let c = members_with(&nets, &[(0, true), (1, false), (2, false), (3, false)], 2).await;
        assert_eq!(phase(&c), (Phase::Migrating, true, 2));
        backfill(&c).await;
        nets[0].net.push_fault("pin_object", Fault::Hang);
        nets[1].net.push_fault("pin_object", Fault::Hang);
        let r = settle(&c).await;
        assert_eq!(r.admitted, 1, "only r2's seal: {r:?}");
        assert_eq!(phase(&c), (Phase::Pending, false, 3), "the old set no longer acts; the new one is not admitted");
        assert!(c.put("b", "x", b"y".to_vec(), None, &Cond::None).await.unwrap_err().starts_with("ServiceUnavailable"));
        assert!(c.ensure_range(c.range_ms.get()).await.is_err(), "no reservation without voters");
        drop(c);

        // a restart finds the one seal: still pending, finished from the old set's quorum before anything is served
        let c = members_with(&nets, &[(0, true), (1, false), (2, false), (3, false)], 2).await;
        assert_eq!(phase(&c), (Phase::Pending, false, 3));
        assert!(c.observed_ceiling() >= c1, "the old writer's reservation is still the floor");
        let r = maintain(&c).await;
        assert_eq!(r.admitted, 5, "two more seals, three admissions: {r:?}");
        assert_eq!(phase(&c), (Phase::Stable, true, 3));
        drop(c);

        // the new set with r1 down and r0 gone: serves, and stamps above the old writer's range
        nets[0].offline(true);
        nets[1].offline(true);
        let c = members_with(&nets, &[(1, false), (2, false), (3, false)], 2).await;
        assert_eq!(phase(&c), (Phase::Stable, true, 3));
        assert_eq!(get(&c, "k").await.unwrap(), b"v");
        c.put("b", "k2", b"w".to_vec(), None, &Cond::None).await.unwrap();
        assert!(c.lookup("b", "k2").unwrap().h > c1);
    }

    #[tokio::test]
    async fn in_flight_parts_and_unreadable_manifests_hold_a_migration_back() {
        let nets = [Net::new(1), Net::new(2), Net::new(3)];
        let old = members(&nets, &[0], 1).await;
        maintain(&old).await;
        let uid = old.create_upload("b", "mp").await.unwrap();
        let e1 = old.upload_part(&uid, 1, b"part one".to_vec()).await.unwrap();
        let long = "m".repeat(700);
        old.put("b", &long, b"behind a manifest".to_vec(), wide_type(), &Cond::None).await.unwrap();
        drop(old);

        let c = members_slow(&nets, &[(0, false), (1, false), (2, false)], 2).await;
        assert_eq!(phase(&c), (Phase::Migrating, true, 1));
        backfill(&c).await;
        // part 2's pin on r2 stays in flight while maintenance tries to commit: r2's outcome is unknown, so the change
        // (which admits every member at once) waits
        let r2 = c.store(2).unwrap();
        nets[2].net.push_fault("pin_object", Fault::Defer);
        let part = c.upload_part(&uid, 2, b"part two".to_vec());
        let attempt = async {
            for _ in 0..4000 {
                if r2.in_flight() > 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert_eq!(r2.in_flight(), 1);
            let r = settle(&c).await;
            (r, phase(&c))
        };
        let (e2, (r, during)) = tokio::join!(part, attempt);
        assert_eq!((r.admitted, during), (0, (Phase::Migrating, true, 1)), "{r:?}");
        let e2 = e2.expect("acknowledged by the old set's voter, r0");
        assert!(r2.dirty(), "the abandoned pin's outcome is unknown");
        // the indexer applies it; a re-read sees it, and the change commits
        assert_eq!(nets[2].net.apply_deferred(), 1);
        let r = maintain(&c).await;
        assert!(r.reconciled >= 1 && r.admitted == 4, "{r:?}");
        assert_eq!(phase(&c), (Phase::Stable, true, 3));
        drop(c);

        // the old member gone: the open upload completes and the manifest key reads on the new members alone
        nets[0].offline(true);
        let c = members(&nets, &[0, 1, 2], 2).await;
        assert_eq!(phase(&c), (Phase::Stable, true, 3));
        assert_eq!(get(&c, &long).await.unwrap(), b"behind a manifest");
        c.complete_upload(&uid, &[(1, e1), (2, e2)]).await.unwrap();
        assert_eq!(get(&c, "mp").await.unwrap(), b"part onepart two");
        drop(c);

        // B2 inside a migration: a new member that cannot read the manifest of a live version does not load, so it is
        // never counted; the set it would join keeps serving
        nets[0].offline(false);
        let s1 = nets[1].load().await.unwrap();
        corrupt_manifest(&s1, &long).await;
        let c = members_with(&nets, &[(1, false), (2, false), (0, false)], 1).await; // another change: W 2 -> 1
        assert!(c.store(0).is_none(), "r1 stays unloaded");
        assert_eq!(phase(&c), (Phase::Migrating, true, 3), "epoch 3 (r2, r0) serves under its rules");
        assert_eq!(get(&c, &long).await.unwrap(), b"behind a manifest");
        let r = maintain(&c).await;
        assert!(r.admitted == 0 && phase(&c).0 == Phase::Migrating, "no commit without every member: {r:?}");
    }

    #[tokio::test]
    async fn a_returning_member_that_missed_a_delete_and_a_reservation_cannot_undo_either() {
        let nets = [Net::new(1), Net::new(2), Net::new(3)];
        let c = members(&nets, &[0, 1, 2], 2).await;
        settle(&c).await;
        c.put("b", "k", b"v".to_vec(), None, &Cond::None).await.unwrap();
        drop(c);
        // writer P1 runs while r2 is down: a new reservation and a DELETE reach r0 and r1 only
        nets[2].offline(true);
        let p1 = members(&nets, &[0, 1, 2], 2).await;
        p1.delete("b", "k").await.unwrap();
        let p1_ceiling = p1.version_ceiling();
        drop(p1);
        // P2 boots with r0 down and the stale r2 back (it holds k live, and only the first writer's ceiling)
        nets[2].offline(false);
        nets[0].offline(true);
        let p2 = members(&nets, &[0, 1, 2], 2).await;
        assert_eq!(phase(&p2), (Phase::Stable, true, 2));
        assert!(p2.store(2).unwrap().ceiling().await < p1_ceiling);
        assert_eq!(p2.observed_ceiling(), p1_ceiling, "r1 carries P1's reservation into every boot set with it");
        assert!(p2.lookup("b", "k").is_none(), "r1's tombstone hides r2's stale version");
        p2.put("b", "k2", b"w".to_vec(), None, &Cond::None).await.unwrap();
        assert!(p2.lookup("b", "k2").unwrap().h > p1_ceiling);
        // P2's own reservation reached the returning r2 (it is loaded); maintenance applies the missed delete there
        let r = maintain(&p2).await;
        assert!(r.deletes >= 1, "{r:?}");
        assert!(nets[2].load().await.unwrap().idx.lock().await.ceiling >= p2.version_ceiling());
        assert_eq!(on_disk(&nets[2], "k").await, (None, true, false));
        nets[0].offline(false);
    }

    // ---- the protocol review's findings (work/claude-storage-protocol-review-result.md) ----

    #[tokio::test]
    async fn a_change_waits_while_the_sources_disagree_about_an_open_part() {
        // P3: parts carry no version; a stale variant must not pass the commit while the acknowledged re-upload is held
        // only by replicas that leave
        let nets = [Net::new(1), Net::new(2), Net::new(3), Net::new(4), Net::new(5)];
        let abc = members(&nets, &[0, 1, 2], 2).await;
        settle(&abc).await;
        drop(abc);
        // {r0, r1, r2} -> {r3, r4}, the old members retiring
        let c = members_with(&nets, &[(0, true), (1, true), (2, true), (3, false), (4, false)], 2).await;
        assert_eq!(phase(&c), (Phase::Migrating, true, 2));
        let uid = c.create_upload("b", "mp").await.unwrap();
        c.upload_part(&uid, 1, b"X stale".to_vec()).await.unwrap();
        // the part is uploaded again: r0 and r1 (two old voters) acknowledge it; r2, r3 and r4 miss it
        for n in &nets[2..] {
            n.offline(true);
        }
        let y = c.upload_part(&uid, 1, b"Y acknowledged".to_vec()).await.unwrap();
        for n in &nets[2..] {
            n.offline(false);
        }
        let r = maintain(&c).await;
        assert_eq!(r.admitted, 0, "the sources hold two variants of part 1: no commit, {r:?}");
        assert_eq!(phase(&c), (Phase::Migrating, true, 2));
        // completed under the old set (r0, r1 hold Y), the upload closes; then the change commits
        c.complete_upload(&uid, &[(1, y)]).await.unwrap();
        let r = maintain(&c).await;
        assert!(r.admitted > 0, "{r:?}");
        assert_eq!(phase(&c), (Phase::Stable, true, 3));
        drop(c);
        for n in &nets[..3] {
            n.offline(true);
        }
        let c = members_with(&nets, &[(3, false), (4, false)], 2).await;
        assert_eq!(get(&c, "mp").await.unwrap(), b"Y acknowledged");
    }

    #[tokio::test]
    async fn a_pending_change_copies_a_ceiling_only_the_old_set_holds() {
        // M2-live: after a restart in Pending, this process has reserved nothing (it cannot: nobody votes), and the
        // highest ceiling is on an old member only. Maintenance copies it anyway, so the change can finish.
        let nets = [Net::new(1), Net::new(2), Net::new(3), Net::new(4)];
        let abc = members(&nets, &[0, 1, 2], 2).await;
        settle(&abc).await;
        abc.put("b", "k", b"v".to_vec(), None, &Cond::None).await.unwrap();
        drop(abc);
        let c = members_with(&nets, &[(0, true), (1, false), (2, false), (3, false)], 2).await;
        backfill(&c).await;
        nets[0].net.push_fault("pin_object", Fault::Hang);
        nets[1].net.push_fault("pin_object", Fault::Hang);
        settle(&c).await;
        assert_eq!(phase(&c).0, Phase::Pending);
        drop(c);
        // an abandoned reservation of the earlier writer lands on r0 alone, an hour above everything else
        let r0 = nets[0].load().await.unwrap();
        let high = r0.ceiling().await + 3_600_000;
        r0.write_ceiling(high).await.unwrap();
        drop(r0);
        let c = members_with(&nets, &[(0, true), (1, false), (2, false), (3, false)], 2).await;
        assert_eq!((phase(&c), c.version_ceiling(), c.observed_ceiling()), ((Phase::Pending, false, 3), 0, high));
        let r = maintain(&c).await;
        assert!(r.ceilings == 3 && r.admitted == 5, "{r:?}");
        assert_eq!(phase(&c), (Phase::Stable, true, 3));
        for i in 1..4 {
            assert!(c.store(i).unwrap().ceiling().await >= high, "r{i}");
        }
    }

    #[tokio::test]
    async fn admission_waits_for_a_reservation_in_progress() {
        // RC: a reservation counted against the old voters must not complete while a commit changes them, so
        // admission takes `reserving` (before the write lock) and holds it to the end
        let nets = [Net::new(1), Net::new(2), Net::new(3)];
        let old = members(&nets, &[0], 1).await;
        maintain(&old).await;
        drop(old);
        let c = members(&nets, &[0, 1, 2], 2).await;
        backfill(&c).await;
        let held = c.reserving.lock().await; // a reservation in progress
        let blocked = tokio::time::timeout(Duration::from_secs(3), settle(&c)).await;
        assert!(blocked.is_err(), "the commit waited for the reservation");
        assert_eq!(phase(&c), (Phase::Migrating, true, 1), "and changed nothing");
        drop(held);
        let r = settle(&c).await;
        assert_eq!(r.admitted, 4, "{r:?}");
        assert_eq!(phase(&c), (Phase::Stable, true, 3));
    }

    #[tokio::test]
    async fn a_migration_reserves_only_with_the_old_sets_voters() {
        // T-M1 of the integration handoff: {r0} -> {r1, r2}, r0 retiring and the only voter. r0's ceiling cannot be
        // stored; r1 and r2 (configured members, not yet voters) store it. The range is refused and nothing stamped.
        let nets = [Net::new(1), Net::new(2), Net::new(3)];
        let old = members(&nets, &[0], 1).await;
        maintain(&old).await;
        drop(old);
        let c = members_with(&nets, &[(0, true), (1, false), (2, false)], 2).await;
        assert_eq!((phase(&c), c.voters(), c.need()), ((Phase::Migrating, true, 1), vec![0], 1));
        nets[0].net.set_pin_slabs_failures(3);
        let e = c.ensure_range(STAMP_LOW_MS).await.unwrap_err();
        assert!(e.starts_with("ServiceUnavailable") && e.contains("reached 0 of 1"), "{e}");
        assert_eq!(c.version_ceiling(), 0);
        for i in [1, 2] {
            assert!(c.store(i).unwrap().ceiling().await > 0, "r{i} holds the ceiling, uncounted");
        }
        assert!(c.stamp().is_err());
        // with r0's pin working again the next write reserves (r0 votes) and succeeds
        c.put("b", "k", b"v".to_vec(), None, &Cond::None).await.unwrap();
        assert!(c.version_ceiling() > 0);
    }

    // ---- the final review's findings (work/storage-final-review-interface.txt) ----

    #[tokio::test]
    async fn a_late_recordless_seal_never_collides_with_a_recorded_change() {
        // F1: epoch 2 is only for sets without records; a recorded change from epoch 1 commits as epoch 3
        let nets = [Net::new(1), Net::new(2), Net::new(3)];
        // 1. one indexer's first admission ({r0}@1) is abandoned; the indexer applies it only later
        let old = members(&nets, &[0], 1).await;
        nets[0].net.push_fault("pin_object", Fault::Defer);
        assert_eq!(settle(&old).await.admitted, 0);
        drop(old);
        // 2. {r1, r2} with r0 retiring and no record visible: a commit as a set without records (epoch 2), whose
        //    seals to r1 and r2 are abandoned (applied later) and whose seal to r0 fails
        let config = [(0, true), (1, false), (2, false)];
        let c = members_with(&nets, &config, 2).await;
        assert_eq!(phase(&c), (Phase::Legacy, false, 0));
        nets[0].net.push_fault("pin_object", Fault::Hang);
        nets[1].net.push_fault("pin_object", Fault::Defer);
        nets[2].net.push_fault("pin_object", Fault::Defer);
        let r = settle(&c).await;
        assert_eq!(r.admitted, 0, "{r:?}");
        drop(c);
        // 3. {r0}@1 lands; 4. a restart migrates from it and commits, as epoch 3
        assert_eq!(nets[0].net.apply_deferred(), 1);
        let c = members_with(&nets, &config, 2).await;
        assert_eq!(phase(&c), (Phase::Migrating, true, 1));
        maintain(&c).await;
        let committed = phase(&c);
        assert_eq!((committed.0, committed.1), (Phase::Stable, true));
        drop(c);
        // 5. the record-less seals land at epoch 2. With the fix the change was epoch 3 and they are below it, ignored;
        //    before it both sets were at epoch 2 and the cluster was refused for good
        for n in &nets[1..] {
            assert_eq!(n.net.apply_deferred(), 1);
        }
        let c = members_with(&nets, &config, 2).await;
        assert_eq!(phase(&c), committed, "still the same stable set after the late seals landed");
        assert_eq!(committed.2, 3);
    }

    #[tokio::test]
    async fn a_ceiling_carried_only_by_a_membership_record_still_floors_the_clock() {
        // G1: the record's carried ceiling (MsRec.c) is evidence on its own
        let nets = [Net::new(1)];
        let old = members(&nets, &[0], 1).await;
        old.put("b", "k", b"v".to_vec(), None, &Cond::None).await.unwrap();
        let reserved = old.version_ceiling();
        assert!(reserved > 0);
        assert_eq!(maintain(&old).await.admitted, 1, "the single indexer's record, carrying the ceiling");
        drop(old);
        // the replica loses its ceiling objects (a rollback, or lost objects): only the admission record carries it
        {
            let s = nets[0].load().await.unwrap();
            let idx = s.idx.lock().await;
            assert!(idx.records.iter().any(|(_, r)| r.admit() && r.c >= reserved));
            for (id, _) in &idx.ceilings {
                let (o, _) = idx.objs[id].clone();
                s.sdk.delete_object(&o.id()).await.unwrap();
            }
        }
        let c = members(&nets, &[0], 1).await;
        assert_eq!(c.store(0).unwrap().ceiling().await, 0, "no ceiling object is left");
        assert!(c.observed_ceiling() >= reserved, "the record's ceiling is observed");
        c.put("b", "k2", b"w".to_vec(), None, &Cond::None).await.unwrap();
        assert!(c.lookup("b", "k2").unwrap().h > reserved, "the first stamp is above it");
    }

    // ---- U1 (PATCH, isolated copy): a listing must include every acknowledged pin ----

    /// A one-replica cluster over `net`, listed with `listing`.
    async fn boot_listing(net: &Net, listing: crate::store::Listing) -> Cluster {
        let c = Cluster::new(vec![("r0".into(), "https://indexer-0.example".into(), false)], 1, opts(), timing());
        let sdk = net.net.sdk(net.key.clone()).await.unwrap();
        let s = Store::load_with(sdk, 8 << 20, Opts { listing, ..opts() }).await.unwrap();
        c.attach(0, Rc::new(s)).await;
        c
    }

    #[tokio::test]
    async fn an_unpublished_pin_is_missed_by_the_feed_and_listed_by_the_current_listing() {
        use crate::store::Listing;
        let n = Net::new(1);
        let c = boot_listing(&n, Listing::Current).await;
        settle(&c).await;
        c.put("b", "k", b"v1".to_vec(), None, &Cond::None).await.unwrap();
        drop(c);

        // indexd publishes object events later (1 s ticks, or a stall); here nothing is published meanwhile
        n.net.hold_publication(true);
        let w = boot_listing(&n, Listing::Current).await;
        w.put("b", "k", b"v2".to_vec(), None, &Cond::None).await.unwrap(); // acknowledged
        drop(w);

        // DEFECT (indexd 0.6.0's feed): the next writer's listing misses the acknowledged v2 (and v1's removal), so
        // k is absent; its DELETE answers success and records nothing; after publication k is back.
        let feed = boot_listing(&n, Listing::Feed).await;
        assert!(feed.lookup("b", "k").is_none(), "the feed listing misses the acknowledged PUT");
        feed.delete("b", "k").await.unwrap();
        assert!(feed.view.borrow().tombs.get(&qkey("b", "k")).is_none(), "nothing was recorded");
        drop(feed);
        n.net.hold_publication(false);
        let after = boot_listing(&n, Listing::Feed).await;
        assert_eq!(get(&after, "k").await.unwrap(), b"v2", "an acknowledged DELETE was undone");
        drop(after);

        // FIX: the current listing reads committed objects, published or not
        n.net.hold_publication(true);
        let w = boot_listing(&n, Listing::Current).await;
        w.put("b", "k", b"v3".to_vec(), None, &Cond::None).await.unwrap();
        drop(w);
        let cur = boot_listing(&n, Listing::Current).await;
        assert_eq!(get(&cur, "k").await.unwrap(), b"v3", "listed before publication");
        cur.delete("b", "k").await.unwrap();
        drop(cur);
        n.net.hold_publication(false);
        let after = boot_listing(&n, Listing::Current).await;
        assert!(after.lookup("b", "k").is_none(), "the acknowledged DELETE holds");
        let after_feed = boot_listing(&n, Listing::Feed).await;
        assert!(after_feed.lookup("b", "k").is_none(), "and the feed agrees once published");
    }
}
