//! DRIVER CASES (not yet runnable): writer fencing against REAL indexd with the fence API (interface v3 section 2),
//! on the storage-indexd harness (work/storage-real-indexd/harness, control API on loopback). Every test is
//! #[ignore], and needs an indexd build that implements GET/POST /fence, the receipt and the exact `sf` check:
//!   SIAS3_REAL_CTL=$(cat <run>/ctl.url) SIAS3_REAL_INDEXD=fence cargo test --offline \
//!     --target x86_64-unknown-linux-gnu real_fence_ -- --ignored --test-threads=1
//! They use the harness's /register, /manifest, /hold, /release, /stall-publish and /resume-publish, and print
//! EVIDENCE lines. Helpers are duplicated from real_indexd.rs (the indexd owner's file is not edited).
//! The `real_c2_*` cases (PATCH C2) need an indexd with G-C2 v4 (work/indexd-c2-implementation-interface.txt; GET
//! /fence must list "cas-v4"): run with SIAS3_REAL_INDEXD=c2. They use a FIXTURE lease16 authority (synthetic chain
//! facts): it proves nothing about the production front/generation binding, which stays an open acceptance item.
//! The `real_fence_blocked_*` cases (PATCH U1-B) also need /stop, /start and the harness's /block-object and
//! /unblock-object controls (patches/harness-block-object.patch: indexd's real admin blocklist API); without that
//! patch they fail at the first /block-object call, never silently.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::rc::Rc;
use std::time::Duration;

use sia_storage::fence::{FenceRaise, FenceToken};
use sia_storage::{AppKey, Builder, Sdk};

use crate::fencing::{Authority, FenceMode, FencePolicy, Isolation};
use crate::replica::{Cluster, Timing};
use crate::store::{Cond, Listing, Opts, Store};

fn ctl(path_and_query: &str) -> serde_json::Value {
    let base = std::env::var("SIAS3_REAL_CTL").expect("SIAS3_REAL_CTL (the harness's ctl.url) is required");
    let hostport = base.trim_start_matches("http://").trim_end_matches('/').to_string();
    assert!(hostport.starts_with("127.0.0.1:"), "control API must be loopback: {hostport}");
    let mut s = TcpStream::connect(&hostport).expect("connect to the harness");
    s.set_read_timeout(Some(Duration::from_secs(600))).unwrap();
    write!(s, "POST {path_and_query} HTTP/1.1\r\nHost: {hostport}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    assert!(head.starts_with("HTTP/1.1 200"), "control {path_and_query}: {head} {body}");
    serde_json::from_str(body.trim()).unwrap_or(serde_json::Value::Null)
}

fn evidence(what: &str, v: serde_json::Value) {
    println!("EVIDENCE {what} {}", crate::store::redact(&v.to_string()));
}

fn urls() -> Vec<String> {
    let m = ctl("/manifest");
    m["indexers"].as_array().unwrap().iter().map(|i| i["url"].as_str().unwrap().to_string()).collect()
}

fn opts() -> Opts {
    Opts { shards: (3, 9), listing: Listing::Current, meta_timeout: Duration::from_secs(20), upload_timeout: Duration::from_secs(300) }
}

fn timing() -> Timing {
    Timing { upload_grace: Duration::from_secs(10), meta_grace: Duration::from_secs(2), stall: Duration::from_secs(60) }
}

/// One generated, disposable app key for indexers `idx`, registered through the harness (the same key on each, as
/// sia-s3 deployments may do; each indexer is its own account).
fn key(idx: &[usize]) -> [u8; 32] {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).unwrap();
    let pk = AppKey::import(seed).public_key();
    for i in idx {
        ctl(&format!("/register?idx={i}&pk={pk}"));
    }
    seed
}

async fn sdk(url: &str, seed: [u8; 32]) -> Sdk {
    Builder::new(url, crate::META).unwrap().connected(&AppKey::import(seed)).await.unwrap().expect("authorized")
}

fn lease(generation: u64) -> FencePolicy {
    FencePolicy {
        mode: FenceMode::Required,
        authority: Some(Authority::Lease17 { chain_id: 8453, ledger: format!("0x{}", "1".repeat(40)), deployment: format!("0x{}", "2".repeat(64)), generation }),
        isolation: Some(Isolation::Snp),
        accept_unevidenced_isolation: false, // PATCH C2: production-shaped; C2 needs no no-clone override
    }
}

async fn fenced(urls: &[String], seed: [u8; 32], w: usize, policy: FencePolicy) -> Cluster {
    let c = Cluster::new((0..urls.len()).map(|i| (format!("r{i}"), urls[i].clone(), false)).collect(), w, opts(), timing()).fenced(policy);
    let mut sdks = Vec::new();
    for (i, u) in urls.iter().enumerate() {
        sdks.push((i, sdk(u, seed).await));
    }
    let r = c.fence_boot(sdks, 8 << 20, opts()).await;
    evidence("fence-boot", serde_json::json!({ "result": format!("{r:?}"), "status": c.fence_status() }));
    c
}

async fn settle(c: &Cluster) {
    for _ in 0..6 {
        let r = c.repair(1 << 30).await;
        if r.reconciled + r.purged + r.copies + r.deletes + r.floors + r.reclaimed + r.merged + r.parts + r.admitted + r.ceilings + r.pending == 0 {
            break;
        }
    }
}

#[tokio::test]
#[ignore]
async fn real_fence_endpoint_semantics_exact_receipt_and_refusals() {
    let u = urls();
    let seed = key(&[0]);
    let s = sdk(&u[0], seed).await;
    let t1 = FenceToken::new((17 << 48) | 1, 1, [1; 16]).unwrap();
    let FenceRaise::Installed(c1) = s.fence_raise(t1).await.unwrap() else { panic!("first raise installs") };
    let st = s.fence_state().await.unwrap();
    evidence("raise-1", serde_json::json!({ "fence": st.fence.map(|f| f.to_hex()), "receiptSha256Present": st.receipt_sha256.is_some() }));
    assert_eq!(st.fence, Some(t1));
    assert!(matches!(s.fence_raise(t1).await.unwrap(), FenceRaise::Refused(Some(t)) if t == t1), "an EQUAL raise is refused");
    let lower = FenceToken::new((17 << 48) | 1, 0, [9; 16]).unwrap();
    assert!(matches!(s.fence_raise(lower).await.unwrap(), FenceRaise::Refused(Some(_))));
    // a mutation without sf, and one with the token but a wrong receipt: both 409, nothing applied
    let unfenced = Store::load_with(sdk(&u[0], seed).await, 8 << 20, opts()).await.unwrap();
    let e = unfenced.upload(Rc::from(&b"x"[..])).await.unwrap_err();
    evidence("unfenced-mutation", serde_json::json!({ "error": e }));
    let wrong = sdk(&u[0], seed).await;
    wrong.set_fence_credential(Some(sia_storage::fence::FenceCredential { token: t1, receipt: sia_storage::fence::FenceReceipt([0; 16]) }));
    let wrong = Store::load_with(wrong, 8 << 20, opts()).await.unwrap();
    assert!(wrong.upload(Rc::from(&b"x"[..])).await.is_err(), "wrong receipt refused");
    s.set_fence_credential(Some(c1));
    let ok = Store::load_with(s.clone(), 8 << 20, opts()).await.unwrap();
    ok.upload(Rc::from(&b"x"[..])).await.unwrap();
    // a higher raise: new receipt; the old credential is now refused
    let t2 = FenceToken::new((17 << 48) | 2, 1, [2; 16]).unwrap();
    assert!(matches!(sdk(&u[0], seed).await.fence_raise(t2).await.unwrap(), FenceRaise::Installed(_)));
    assert!(ok.upload(Rc::from(&b"y"[..])).await.is_err(), "the superseded credential is refused");
    evidence("conflict-recorded", serde_json::json!({ "conflict": format!("{:?}", s.fence_conflict()) }));
}

#[tokio::test]
#[ignore]
async fn real_fence_delayed_old_writer_pins_are_refused_after_a_new_install() {
    let u = urls();
    let seed = key(&[0, 1, 2]);
    let a = fenced(&u, seed, 2, lease(5)).await;
    a.repair(1 << 30).await;
    settle(&a).await;
    a.put("b", "k", b"v1".to_vec(), None, &Cond::None).await.unwrap();
    // hold A's next metadata pin on r1 and r2 (r0 acknowledges): unacknowledged, in flight
    ctl("/hold?idx=1&method=POST&path=/objects&n=1");
    ctl("/hold?idx=2&method=POST&path=/objects&n=1");
    let _ = tokio::time::timeout(Duration::from_secs(30), a.put("b", "k", b"stale".to_vec(), None, &Cond::None)).await;
    let b = fenced(&u, seed, 2, lease(6)).await;
    settle(&b).await;
    b.delete("b", "k").await.unwrap();
    let r1 = ctl("/release?idx=1");
    let r2 = ctl("/release?idx=2");
    evidence("held-old-pins-released", serde_json::json!({ "r1": r1, "r2": r2 }));
    let b2 = fenced(&u, seed, 2, lease(7)).await;
    settle(&b2).await;
    evidence("after", serde_json::json!({ "kVisible": b2.lookup("b", "k").is_some(), "aFresh": format!("{:?}", a.fresh().await) }));
    assert!(b2.lookup("b", "k").is_none(), "the delayed stale PUT did not undo the DELETE");
}

#[tokio::test]
#[ignore]
async fn real_fence_two_starters_same_counter_one_writer() {
    let u = urls();
    let seed = key(&[0, 1, 2]);
    let (c1, c2) = tokio::join!(fenced(&u, seed, 2, lease(5)), fenced(&u, seed, 2, lease(5)));
    // a new record-less set serves only after its commit (P1); the earlier run (runs/ifx6) skipped this, so neither
    // instance had voters and both confirmations failed. Settle each instance that is not yet stopped.
    for c in [&c1, &c2] {
        if c.superseded().is_none() {
            settle(c).await;
        }
    }
    let (f1, f2) = (c1.fresh().await.is_ok(), c2.fresh().await.is_ok());
    let p1 = c1.put("b", "only", b"one".to_vec(), None, &Cond::IfNoneMatch).await.is_ok();
    let p2 = c2.put("b", "only", b"two".to_vec(), None, &Cond::IfNoneMatch).await.is_ok();
    evidence("two-starters", serde_json::json!({ "fresh": [f1, f2], "create": [p1, p2], "s1": c1.fence_status(), "s2": c2.fence_status() }));
    assert!(!(f1 && f2), "two writers confirmed");
    assert!(!(p1 && p2), "two put-if-absent creates succeeded");
    assert!(f1 || f2, "one of them is the writer");
}

#[tokio::test]
#[ignore]
async fn real_fence_listing_after_install_sees_an_unpublished_acknowledged_pin() {
    let u = urls();
    let seed = key(&[0]);
    let a = fenced(&u[..1], seed, 1, lease(5)).await;
    settle(&a).await;
    ctl("/stall-publish?idx=0&seconds=60");
    a.put("b", "k", b"v2".to_vec(), None, &Cond::None).await.unwrap();
    let b = fenced(&u[..1], seed, 1, lease(6)).await;
    settle(&b).await;
    let seen = b.lookup("b", "k").is_some();
    ctl("/resume-publish?idx=0");
    evidence("listing-after-install", serde_json::json!({ "kSeen": seen }));
    assert!(seen);
}

/// The object hosting `k`'s entry on replica `i` (its data object, for a small key), as the indexer knows it.
async fn host_of(c: &Cluster, i: usize, k: &str) -> String {
    let s = c.store(i).unwrap();
    let idx = s.idx.lock().await;
    let key = idx.keys.get(&("b".to_string(), k.to_string())).expect("the key is on this replica");
    idx.objs[&key.host].0.id().to_string()
}

/// A fenced cluster over every indexer, given SDKs only for those that connect (a stopped one is joined later).
async fn fenced_up(urls: &[String], seed: [u8; 32], w: usize, policy: FencePolicy) -> Cluster {
    let c = Cluster::new((0..urls.len()).map(|i| (format!("r{i}"), urls[i].clone(), false)).collect(), w, opts(), timing()).fenced(policy);
    let mut sdks = Vec::new();
    for (i, u) in urls.iter().enumerate() {
        if let Ok(Ok(Some(s))) = tokio::time::timeout(Duration::from_secs(20), async { Builder::new(u.as_str(), crate::META).unwrap().connected(&AppKey::import(seed)).await }).await {
            sdks.push((i, s));
        }
    }
    let r = c.fence_boot(sdks, 8 << 20, opts()).await;
    evidence("fence-boot", serde_json::json!({ "result": format!("{r:?}"), "status": c.fence_status(), "replicas": c.replica_status().await }));
    c
}

#[tokio::test]
#[ignore]
async fn real_fence_blocked_acknowledged_key_never_becomes_an_empty_successful_listing() {
    // one indexer: its operator blocks the object holding an acknowledged key. The default current listing leaves it
    // out (indexd-fence TestFenceAPISeqAndCurrentListing), which would boot an EMPTY, ready index; the blocked flag
    // keeps the replica out and nothing is served (503) until the block is lifted, and then nothing was lost.
    let u = urls();
    let seed = key(&[0]);
    let a = fenced(&u[..1], seed, 1, lease(5)).await;
    settle(&a).await;
    a.put("b", "k", b"acknowledged".to_vec(), None, &Cond::None).await.unwrap();
    a.fresh().await.unwrap();
    let obj = host_of(&a, 0, "k").await;
    drop(a);
    let blk = ctl(&format!("/block-object?idx=0&key={obj}"));
    let b = fenced(&u[..1], seed, 1, lease(6)).await;
    settle(&b).await;
    let listed = b.lookup("b", "k").is_some();
    evidence(
        "blocked-boot",
        serde_json::json!({ "block": blk, "ready": b.ready(), "loaded": b.store(0).is_some(), "blockedObjects": b.blocked_objects(0), "kListed": listed, "fresh": format!("{:?}", b.fresh().await) }),
    );
    assert!(!b.ready() && b.store(0).is_none() && b.blocked_objects(0) == Some(1), "the only replica is left out: not ready, nothing served");
    assert!(!listed, "and no listing is served from it");
    let e = crate::store::Store::load_with(sdk(&u[0], seed).await, 8 << 20, opts()).await.err().unwrap_or_default();
    evidence("blocked-load", serde_json::json!({ "error": e }));
    assert!(e.starts_with("AdminBlocked"), "a plain load fails closed too");
    // the operator lifts the block: maintenance lists it again, it rejoins under the same ballot, nothing was lost
    ctl(&format!("/unblock-object?idx=0&key={obj}"));
    settle(&b).await;
    let mut body = Vec::new();
    let e = b.lookup("b", "k");
    if let Some(e) = &e {
        b.read(e, 0, e.s, &mut body).await.unwrap();
    }
    evidence("unblocked", serde_json::json!({ "ready": b.ready(), "k": String::from_utf8_lossy(&body), "status": b.fence_status() }));
    assert!(b.ready() && body == b"acknowledged");
    b.fresh().await.unwrap();
}

#[tokio::test]
#[ignore]
async fn real_fence_blocked_acknowledged_version_is_never_read_stale_or_repaired_back() {
    // three indexers, W = 2: k = v1 everywhere, then v2 acknowledged by r0 and r1 while r2 is stopped (r2 keeps v1).
    // r1's operator blocks v2's object. A restart while r0 is stopped must not serve v1 from r2 (stale) or report k
    // absent; with r0 back, v2 is withheld on every replica (451) and never copied to r2.
    let u = urls();
    let seed = key(&[0, 1, 2]);
    let a = fenced(&u, seed, 2, lease(5)).await;
    settle(&a).await;
    a.put("b", "k", b"v1".to_vec(), None, &Cond::None).await.unwrap();
    settle(&a).await;
    ctl("/stop?idx=2");
    a.put("b", "k", b"v2".to_vec(), None, &Cond::None).await.unwrap();
    let v2 = a.lookup("b", "k").unwrap().ver();
    let obj = host_of(&a, 1, "k").await;
    drop(a);
    ctl("/start?idx=2");
    let blk = ctl(&format!("/block-object?idx=1&key={obj}"));
    ctl("/stop?idx=0");
    let b = fenced_up(&u, seed, 2, lease(6)).await;
    let early = (b.ready(), b.lookup("b", "k").map(|e| e.ver()), b.blocked_objects(1), format!("{:?}", b.fresh().await));
    evidence("restart-without-r0", serde_json::json!({ "block": blk, "ready": early.0, "kVersion": format!("{:?}", early.1), "blockedObjects": early.2, "fresh": early.3 }));
    assert!(!early.0, "r2 alone (v1) must not serve");
    assert_eq!(early.2, Some(1));
    ctl("/start?idx=0");
    let joined = b.fence_join(0, sdk(&u[0], seed).await, 8 << 20, opts()).await;
    settle(&b).await;
    let e = b.lookup("b", "k");
    let mut body = Vec::new();
    let read = match &e {
        Some(e) => b.read(e, 0, e.s, &mut body).await.err().unwrap_or_default(),
        None => "absent".into(),
    };
    let r2 = crate::store::Store::load_with(sdk(&u[2], seed).await, 8 << 20, opts()).await.unwrap();
    let r2k = r2.idx.lock().await.keys.get(&("b".to_string(), "k".to_string())).map(|k| k.entry.ver());
    evidence(
        "with-r0",
        serde_json::json!({ "join": format!("{joined:?}"), "ready": b.ready(), "kVersionIsV2": e.as_ref().map(|e| e.ver() == v2), "read": read, "bodyLen": body.len(), "r2HoldsV2": r2k.as_ref().map(|v| *v == v2), "withheld": b.withheld_count() }),
    );
    assert!(b.ready());
    assert_eq!(e.map(|e| e.ver()), Some(v2.clone()), "k exists at v2: not absent, not v1");
    assert!(read.starts_with("UnavailableForLegalReasons") && body.is_empty(), "v2 is not read from r0 either");
    assert!(r2k.is_some_and(|v| v < v2), "repair did not copy v2 to r2");
    b.fresh().await.unwrap();
    ctl(&format!("/unblock-object?idx=1&key={obj}"));
}

/// A FIXTURE lease16 authority (the live ledger16d form: the Claimed event's block and log index). DRIVER ONLY.
fn lease16(claim_block: u64) -> FencePolicy {
    FencePolicy {
        mode: FenceMode::Required,
        authority: Some(Authority::Lease16 { chain_id: 8453, ledger: format!("0x{}", "1".repeat(40)), deployment: format!("0x{}", "2".repeat(64)), claim_block, claim_logenindex: 0 }),
        isolation: Some(Isolation::Snp),
        accept_unevidenced_isolation: false, // production-shaped: C2 needs no no-clone override
    }
}

async fn fresh_sdks(urls: &[String], seed: [u8; 32]) -> Vec<(usize, Sdk)> {
    let mut v = Vec::new();
    for (i, u) in urls.iter().enumerate() {
        v.push((i, sdk(u, seed).await));
    }
    v
}

#[tokio::test]
#[ignore]
async fn real_c2_a_post_raise_copy_can_neither_read_stale_nor_acknowledge_a_conflicting_create() {
    let u = urls();
    let seed = key(&[0, 1, 2]);
    let p = fenced(&u, seed, 2, lease16(100)).await;
    settle(&p).await;
    p.put("b", "seed", b"s".to_vec(), None, &Cond::None).await.unwrap();
    let st = p.store(0).unwrap().sdk.fence_state().await.unwrap();
    evidence("enrolled", serde_json::json!({ "mode_cas": st.cas_mode, "capabilities": st.capabilities, "seq": st.seq }));
    assert!(st.cas_mode);
    let q = p.test_memory_copy(fresh_sdks(&u, seed).await).await;
    p.fresh().await.unwrap();
    q.fresh().await.unwrap(); // negative control: before a write after the fork, both serve the same state
    p.put("b", "k", b"from-P".to_vec(), None, &Cond::IfNoneMatch).await.unwrap();
    let qf = q.fresh().await;
    let qp = q.put("b", "k", b"from-Q".to_vec(), None, &Cond::IfNoneMatch).await;
    evidence("copy", serde_json::json!({ "fresh": format!("{qf:?}"), "put": format!("{qp:?}"), "superseded": q.superseded(), "p_superseded": p.superseded() }));
    assert!(qf.is_err() && qp.is_err() && q.superseded().is_some());
    p.fresh().await.unwrap();
    drop(q);
    drop(p);
    let later = fenced(&u, seed, 2, lease16(101)).await;
    settle(&later).await;
    let e = later.lookup("b", "k").unwrap();
    let mut body = Vec::new();
    later.read(&e, 0, e.s, &mut body).await.unwrap();
    evidence("recovered", serde_json::json!({ "k": String::from_utf8_lossy(&body) }));
    assert_eq!(body, b"from-P");
}

#[tokio::test]
#[ignore]
async fn real_c2_a_held_mutation_delivered_after_its_replay_is_not_applied_twice() {
    let u = urls();
    let seed = key(&[0]);
    let c = fenced(&u[..1], seed, 1, lease16(100)).await;
    settle(&c).await;
    let s = c.store(0).unwrap();
    let h0 = s.sdk.fence_state().await.unwrap().seq.unwrap();
    // the proxy holds the next POST /objects (k's phase-1 pin): the write gives up, its outcome unknown
    ctl("/hold?idx=0&method=POST&path=/objects&n=1");
    let r = tokio::time::timeout(Duration::from_secs(30), c.put("b", "k", b"v".to_vec(), None, &Cond::None)).await;
    // the next freshness round replays the identical operation: applied once
    c.fresh().await.unwrap();
    let h1 = s.sdk.fence_state().await.unwrap().seq.unwrap();
    // the held original is delivered now: the same operation, answered as a replay, not applied again
    let rel = ctl("/release?idx=0");
    tokio::time::sleep(Duration::from_secs(2)).await;
    let st = s.sdk.fence_state().await.unwrap();
    evidence("held-then-replayed", serde_json::json!({ "put": format!("{r:?}"), "h0": h0, "after_replay": h1, "after_release": st.seq, "release": rel, "lastOp": st.last_op.map(hex::encode) }));
    assert_eq!(h1, h0 + 1);
    assert_eq!(st.seq, Some(h1), "the delayed original was not applied a second time");
    c.fresh().await.unwrap();
    assert!(c.forked_out(0).is_none());
}

#[tokio::test]
#[ignore]
async fn real_c2_an_old_v3_client_cannot_mutate_or_take_over_an_enrolled_account() {
    let u = urls();
    let seed = key(&[0]);
    let c = fenced(&u[..1], seed, 1, lease16(100)).await;
    settle(&c).await;
    let s = c.store(0).unwrap();
    let before = s.sdk.fence_state().await.unwrap();
    let v3 = sdk(&u[0], seed).await;
    v3.set_fence_credential(s.sdk.fence_credential());
    let old = Store::load_with(v3.clone(), 8 << 20, opts()).await.unwrap();
    let up = old.upload(std::rc::Rc::from(&b"x"[..])).await;
    let ballot = c.ballot().unwrap();
    let higher = FenceToken::new(ballot.generation(), ballot.counter() + 1, [3; 16]).unwrap();
    let raise = v3.fence_raise(higher).await;
    let after = s.sdk.fence_state().await.unwrap();
    evidence("v3-refused", serde_json::json!({ "upload": format!("{up:?}"), "raise": format!("{raise:?}"), "seq_before": before.seq, "seq_after": after.seq, "fence_after": after.fence.map(|f| f.to_hex()) }));
    assert!(up.is_err() && raise.is_err());
    assert_eq!((after.fence, after.seq), (before.fence, before.seq));
    c.fresh().await.unwrap();
}

/// A copy of `from` (same credential, same C2 state), as a memory copy of the process would hold it.
async fn copied(url: &str, seed: [u8; 32], from: &Sdk) -> Sdk {
    let c = sdk(url, seed).await;
    c.set_fence_credential(from.fence_credential());
    c.c2_copy_state_from(from);
    c
}

#[tokio::test]
#[ignore]
async fn real_c2_two_new_identical_writes_with_both_first_replies_lost_exactly_one_succeeds() {
    // G-C2 R2 + root 14:38Z: two copies with a copied RNG send byte-identical sealed objects for two NEW requests; the
    // proxy holds both first sends (the senders give up: answers lost), then delivers both; both settle
    let u = urls();
    let seed = key(&[0]);
    let c = fenced(&u[..1], seed, 1, lease16(100)).await;
    settle(&c).await;
    let s = c.store(0).unwrap();
    let obj = s.upload(std::rc::Rc::from(&b"identical"[..])).await.unwrap();
    let sealed = obj.seal(&AppKey::import(seed));
    let p = copied(&u[0], seed, &s.sdk).await;
    let q = copied(&u[0], seed, &s.sdk).await;
    p.c2_test_copied_rng([5; 16]);
    q.c2_test_copied_rng([5; 16]);
    let h0 = s.sdk.fence_state().await.unwrap().seq.unwrap();
    ctl("/hold?idx=0&method=POST&path=/objects&n=2");
    let both = tokio::time::timeout(Duration::from_secs(10), async { tokio::join!(p.c2_test_pin_sealed(&sealed), q.c2_test_pin_sealed(&sealed)) }).await;
    let rel = ctl("/release?idx=0");
    tokio::time::sleep(Duration::from_secs(2)).await;
    let (rp, rq) = (p.c2_check().await.unwrap(), q.c2_check().await.unwrap());
    let st = s.sdk.fence_state().await.unwrap();
    evidence("identical-new-writes", serde_json::json!({ "first_sends": format!("{both:?}"), "release": rel, "p": format!("{rp:?}"), "q": format!("{rq:?}"), "h0": h0, "seq": st.seq }));
    let ok = [&rp, &rq].iter().filter(|r| matches!(r, sia_storage::fence::C2Check::Confirmed(_))).count();
    assert_eq!(ok, 1, "exactly one copy settles as applied");
    assert_eq!(st.seq, Some(h0 + 1), "applied once");
}

#[tokio::test]
#[ignore]
async fn real_c2_one_invocation_copied_after_its_nonce_is_applied_once() {
    // the boundary: the copy is taken while the invocation's first send (nonce already fetched) is held in flight
    let u = urls();
    let seed = key(&[0]);
    let c = fenced(&u[..1], seed, 1, lease16(100)).await;
    settle(&c).await;
    let s = c.store(0).unwrap();
    let obj = s.upload(std::rc::Rc::from(&b"in flight"[..])).await.unwrap();
    let sealed = obj.seal(&AppKey::import(seed));
    let h0 = s.sdk.fence_state().await.unwrap().seq.unwrap();
    ctl("/hold?idx=0&method=POST&path=/objects&n=1");
    let first = tokio::time::timeout(Duration::from_secs(10), s.sdk.c2_test_pin_sealed(&sealed)).await;
    let snap = copied(&u[0], seed, &s.sdk).await;
    let rel = ctl("/release?idx=0");
    tokio::time::sleep(Duration::from_secs(2)).await;
    let (ra, rb) = (s.sdk.c2_check().await.unwrap(), snap.c2_check().await.unwrap());
    let st = s.sdk.fence_state().await.unwrap();
    evidence("snapshot-boundary", serde_json::json!({ "first": format!("{first:?}"), "release": rel, "original": format!("{ra:?}"), "copy": format!("{rb:?}"), "h0": h0, "seq": st.seq }));
    assert!(matches!(ra, sia_storage::fence::C2Check::Confirmed(_)) && matches!(rb, sia_storage::fence::C2Check::Confirmed(_)));
    assert_eq!(st.seq, Some(h0 + 1), "one invocation, applied once");
}

#[tokio::test]
#[ignore]
async fn real_c2_an_indexer_without_cas_and_op_nonce_is_refused() {
    // RUN AGAINST AN OLD INDEXD (the pre-C2 harness-fence build, or a C2 build before R2): the fenced C2 boot refuses
    // it before raising anything
    let u = urls();
    let seed = key(&[0]);
    let st0 = sdk(&u[0], seed).await.fence_state().await.unwrap();
    let c = fenced(&u[..1], seed, 1, lease16(100)).await;
    let st1 = sdk(&u[0], seed).await.fence_state().await.unwrap();
    evidence("old-indexer", serde_json::json!({ "capabilities": st0.capabilities, "ready": c.ready(), "fence_after": st1.fence.map(|f| f.to_hex()), "status": c.fence_status() }));
    assert!(!sia_storage::fence::c2_capable(&st0), "this case needs an indexer without cas-v4 + op-nonce");
    assert!(!c.ready() && st1.fence.is_none(), "refused, nothing raised");
}

