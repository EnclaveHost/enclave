//! HARNESS-ONLY (work/storage-real-indexd; never part of the main tree): sia-s3's real code (Store, Cluster,
//! the SDK) against REAL indexd v0.6.0 indexers served by work/storage-real-indexd/harness on loopback.
//!
//! Every test is #[ignore]: run them with
//!   SIAS3_REAL_CTL=$(cat <run>/ctl.url) cargo test --offline --target x86_64-unknown-linux-gnu real_ -- \
//!     --ignored --test-threads=1
//! Each scenario registers its own generated app keys, so the scenarios share one harness run without sharing
//! state. What is real and what is fixture is stated in harness/cmd/harness/main.go; every observation is printed
//! as an `EVIDENCE` line for the report.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::rc::Rc;
use std::time::{Duration, Instant};

use sia_storage::{AppKey, Builder};

use crate::replica::{Cluster, Phase, Timing};
use crate::store::{Cond, Listing, Opts, Store, qkey};

// ---- control API (blocking HTTP/1.1, loopback only) ----

fn ctl_base() -> String {
    std::env::var("SIAS3_REAL_CTL").expect("SIAS3_REAL_CTL (the harness's ctl.url) is required for real_* tests")
}

fn ctl(path_and_query: &str) -> serde_json::Value {
    let base = ctl_base();
    let hostport = base.trim_start_matches("http://").trim_end_matches('/');
    assert!(hostport.starts_with("127.0.0.1:"), "control API must be loopback: {hostport}");
    let mut s = TcpStream::connect(hostport).expect("connect to the harness");
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
    // error text can carry the SDK's signed request URLs (L1): cut their queries, as main's status text does
    println!("EVIDENCE {what} {}", crate::store::redact(&v.to_string()));
}

fn manifest() -> Vec<String> {
    let m = ctl("/manifest");
    m["indexers"].as_array().unwrap().iter().map(|i| i["url"].as_str().unwrap().to_string()).collect()
}

// ---- sia-s3 over the real indexers ----

/// Which indexd the harness runs: "v060" (stock indexd v0.6.0: only the event feed, which is what the main tree
/// uses) or "u1" (the isolated U1 patch: the current-objects listing, which the U1 fix uses).
fn indexd() -> String {
    std::env::var("SIAS3_REAL_INDEXD").unwrap_or_else(|_| "v060".into())
}

fn listing() -> Listing {
    if indexd() == "u1" { Listing::Current } else { Listing::Feed }
}

fn opts() -> Opts {
    // 3 + 9 shards on the harness's 12 fixture hosts (the smallest layout real indexd accepts); deadlines generous
    // for loopback with real crypto
    Opts { shards: (3, 9), listing: listing(), meta_timeout: Duration::from_secs(20), upload_timeout: Duration::from_secs(300) }
}

fn timing() -> Timing {
    Timing { upload_grace: Duration::from_secs(10), meta_grace: Duration::from_secs(2), stall: Duration::from_secs(60) }
}

/// One generated, disposable app key per replica, registered on its indexer through the harness.
struct Keys(Vec<[u8; 32]>);

impl Keys {
    fn new(indexers: &[usize]) -> Keys {
        let mut v = Vec::new();
        for i in indexers {
            let mut seed = [0u8; 32];
            getrandom::fill(&mut seed).unwrap();
            let pk = AppKey::import(seed).public_key();
            let r = ctl(&format!("/register?idx={i}&pk={pk}"));
            evidence("registered", serde_json::json!({ "indexer": i, "account": pk.to_string(), "attachedHosts": r["attachedHosts"] }));
            v.push(seed);
        }
        Keys(v)
    }
}

async fn load(url: &str, seed: [u8; 32]) -> Result<Store, String> {
    load_listing(url, seed, listing()).await
}

async fn load_listing(url: &str, seed: [u8; 32], listing: Listing) -> Result<Store, String> {
    let sdk = Builder::new(url, crate::META)
        .map_err(|e| e.to_string())?
        .connected(&AppKey::import(seed))
        .await
        .map_err(|e| e.to_string())?
        .ok_or("the app key is not authorized")?;
    Store::load_with(sdk, 8 << 20, Opts { listing, ..opts() }).await
}

/// A cluster over indexers `which` (replica name = r<idx>, URL = the harness's advertised proxy URL), each with its
/// key; replicas whose indexer is down stay unloaded, as at a boot.
async fn boot(urls: &[String], which: &[(usize, bool)], keys: &Keys, w: usize) -> Cluster {
    let c = Cluster::new(which.iter().map(|(i, r)| (format!("r{i}"), urls[*i].clone(), *r)).collect(), w, opts(), timing());
    for (j, (i, _)) in which.iter().enumerate() {
        match load(&urls[*i], keys.0[j]).await {
            Ok(s) => c.attach(j, Rc::new(s)).await,
            Err(e) => evidence("load-failed", serde_json::json!({ "indexer": i, "error": e })),
        }
    }
    c
}

async fn get(c: &Cluster, k: &str) -> Option<Vec<u8>> {
    let e = c.lookup("b", k)?;
    let mut out = Vec::new();
    c.read(&e, 0, e.s, &mut out).await.unwrap();
    Some(out)
}

fn phase(c: &Cluster) -> (Phase, bool, u64) {
    let st = c.ms.borrow();
    (st.phase, st.ready, st.acting.as_ref().map_or(0, |a| a.s))
}

async fn maintain(c: &Cluster) {
    for _ in 0..6 {
        let r = c.repair(1 << 30).await;
        evidence("maintenance", serde_json::json!(format!("{r:?}")));
        if r.reconciled + r.purged + r.copies + r.deletes + r.floors + r.reclaimed + r.merged + r.parts + r.admitted + r.ceilings + r.pending == 0 {
            break;
        }
    }
}

/// The publisher stamps object events at most once per second (indexd slabs/manager.go:23); wait past it.
async fn after_publication() {
    tokio::time::sleep(Duration::from_millis(2500)).await;
}

// ---- scenarios ----

#[tokio::test]
#[ignore]
async fn real_acknowledged_writes_survive_a_writer_and_an_indexer_restart() {
    let urls = manifest();
    let keys = Keys::new(&[0]);
    let c = boot(&urls, &[(0, false)], &keys, 1).await;
    maintain(&c).await; // the single indexer's membership record
    c.put("b", "a", b"acknowledged a".to_vec(), None, &Cond::None).await.unwrap();
    let long = "m".repeat(700);
    c.put("b", &long, b"behind a manifest".to_vec(), Some(format!("x/{}", "y".repeat(200))), &Cond::None).await.unwrap();
    c.put("b", "gone", b"to delete".to_vec(), None, &Cond::None).await.unwrap();
    c.delete("b", "gone").await.unwrap();
    let uid = c.create_upload("b", "mp").await.unwrap();
    let e1 = c.upload_part(&uid, 1, vec![1u8; 5 << 20]).await.unwrap();
    let e2 = c.upload_part(&uid, 2, b"tail".to_vec()).await.unwrap();
    c.complete_upload(&uid, &[(1, e1), (2, e2)]).await.unwrap();
    let open = c.create_upload("b", "open").await.unwrap();
    let p1 = c.upload_part(&open, 1, b"open part".to_vec()).await.unwrap();
    let ceiling = c.version_ceiling();
    evidence("written", serde_json::json!({ "versionCeiling": ceiling, "phase": format!("{:?}", phase(&c)) }));
    drop(c); // the writer stops

    after_publication().await;
    ctl("/stop?idx=0");
    ctl("/start?idx=0"); // the indexer restarts on its database
    let c = boot(&urls, &[(0, false)], &keys, 1).await;
    let ph = phase(&c);
    evidence("after-restart", serde_json::json!({ "phase": format!("{ph:?}"), "observedCeiling": c.observed_ceiling() }));
    assert_eq!((ph.0, ph.1), (Phase::Stable, true));
    assert!(c.observed_ceiling() >= ceiling, "the acknowledged ceiling is listed after the restart");
    assert_eq!(get(&c, "a").await.unwrap(), b"acknowledged a");
    assert_eq!(get(&c, &long).await.unwrap(), b"behind a manifest");
    assert!(c.lookup("b", "gone").is_none() && c.view.borrow().tombs.contains_key(&qkey("b", "gone")));
    let mut want = vec![1u8; 5 << 20];
    want.extend_from_slice(b"tail");
    assert_eq!(get(&c, "mp").await.unwrap(), want);
    let ups = c.uploads().await;
    assert!(ups.iter().any(|u| u.0 == open), "the open upload is listed again from its part");
    c.complete_upload(&open, &[(1, p1)]).await.unwrap();
    assert_eq!(get(&c, "open").await.unwrap(), b"open part");
}

#[tokio::test]
#[ignore]
async fn real_listing_right_after_an_acknowledged_pin() {
    // finding X1: is an acknowledged pin (new object, and re-pin of an existing one) in the very next listing?
    let urls = manifest();
    let keys = Keys::new(&[0]);
    let c = boot(&urls, &[(0, false)], &keys, 1).await;
    maintain(&c).await;
    c.put("b", "base", b"base".to_vec(), None, &Cond::None).await.unwrap();
    after_publication().await;
    let mut samples = Vec::new();
    for round in 0..5 {
        // a new object, then an immediate listing
        let k = format!("new-{round}");
        c.put("b", &k, b"v".to_vec(), None, &Cond::None).await.unwrap();
        let t = Instant::now();
        let fresh = load(&urls[0], keys.0[0]).await.unwrap();
        let listed_new = fresh.idx.lock().await.keys.contains_key(&("b".to_string(), k.clone()));
        let listed_ms = t.elapsed().as_millis();
        drop(fresh);
        // a re-pin of an existing object (the tombstone a DELETE writes into the key's host object), then a listing
        c.delete("b", &k).await.unwrap();
        let fresh = load(&urls[0], keys.0[0]).await.unwrap();
        let idx = fresh.idx.lock().await;
        let deletion_listed = idx.tomb(&qkey("b", &k)).is_some();
        let base_listed = idx.keys.contains_key(&("b".to_string(), "base".to_string()));
        drop(idx);
        samples.push(serde_json::json!({ "round": round, "newObjectListedImmediately": listed_new, "listedAfterMs": listed_ms, "deletionListedImmediately": deletion_listed, "untouchedKeyListed": base_listed }));
        after_publication().await;
        let later = load(&urls[0], keys.0[0]).await.unwrap();
        let ix = later.idx.lock().await;
        assert!(ix.tomb(&qkey("b", &k)).is_some(), "after publication the deletion is listed");
    }
    evidence("listing-after-ack", serde_json::json!(samples));
    if listing() == Listing::Current {
        // the U1 listing's guarantee: every acknowledged pin and delete is listed at once
        for x in &samples {
            assert_eq!((x["newObjectListedImmediately"].as_bool(), x["deletionListedImmediately"].as_bool()), (Some(true), Some(true)), "{x}");
        }
    }
}

#[tokio::test]
#[ignore]
async fn real_one_indexer_outage_and_a_restart_without_it() {
    let urls = manifest();
    let all = [(0, false), (1, false), (2, false)];
    let keys = Keys::new(&[0, 1, 2]);
    let c = boot(&urls, &all, &keys, 2).await;
    maintain(&c).await; // a set without records commits as epoch 2
    assert_eq!(phase(&c), (Phase::Stable, true, 2));
    c.put("b", "x", b"before".to_vec(), None, &Cond::None).await.unwrap();
    ctl("/stop?idx=2"); // one indexer down
    c.put("b", "y", b"during the outage".to_vec(), None, &Cond::None).await.unwrap();
    c.delete("b", "x").await.unwrap();
    drop(c);
    after_publication().await;
    let c = boot(&urls, &all, &keys, 2).await;
    evidence("boot-with-r2-down", serde_json::json!({ "phase": format!("{:?}", phase(&c)), "loaded": c.loaded().len() }));
    assert_eq!(phase(&c), (Phase::Stable, true, 2));
    assert_eq!(get(&c, "y").await.unwrap(), b"during the outage");
    assert!(c.lookup("b", "x").is_none());
    drop(c);
    ctl("/start?idx=2");
    let c = boot(&urls, &all, &keys, 2).await;
    maintain(&c).await; // r2 is backfilled and gets the floor
    drop(c);
    after_publication().await;
    ctl("/stop?idx=0");
    let c = boot(&urls, &all, &keys, 2).await;
    assert_eq!(phase(&c), (Phase::Stable, true, 2));
    assert_eq!(get(&c, "y").await.unwrap(), b"during the outage", "served by r1 and the backfilled r2");
    assert!(c.lookup("b", "x").is_none());
    ctl("/start?idx=0");
}

#[tokio::test]
#[ignore]
async fn real_migration_from_one_indexer_to_three() {
    let urls = manifest();
    let keys = Keys::new(&[0, 1, 2]);
    let one = Keys(vec![keys.0[0]]);
    let c = boot(&urls, &[(0, false)], &one, 1).await;
    c.put("b", "live", b"acknowledged".to_vec(), None, &Cond::None).await.unwrap();
    c.put("b", "gone", b"x".to_vec(), None, &Cond::None).await.unwrap();
    c.delete("b", "gone").await.unwrap();
    maintain(&c).await;
    assert_eq!(phase(&c), (Phase::Stable, true, 1));
    drop(c);
    after_publication().await;
    let all = [(0, false), (1, false), (2, false)];
    let c = boot(&urls, &all, &keys, 2).await;
    assert_eq!(phase(&c), (Phase::Migrating, true, 1));
    maintain(&c).await;
    assert_eq!(phase(&c), (Phase::Stable, true, 3));
    drop(c);
    after_publication().await;
    ctl("/stop?idx=0");
    let c = boot(&urls, &all, &keys, 2).await;
    assert_eq!(phase(&c), (Phase::Stable, true, 3));
    assert_eq!(get(&c, "live").await.unwrap(), b"acknowledged");
    assert!(c.lookup("b", "gone").is_none());
    ctl("/start?idx=0");
}

#[tokio::test]
#[ignore]
async fn real_late_pins_within_and_after_the_signature_window() {
    let urls = manifest();
    let all = [(0, false), (1, false), (2, false)];
    let keys = Keys::new(&[0, 1, 2]);
    let c = boot(&urls, &all, &keys, 2).await;
    maintain(&c).await;
    // the PUT's metadata pin to r1 is held: r0 and r2 acknowledge it, r1 is abandoned after the grace
    ctl("/hold?idx=1&method=POST&path=/objects&n=1");
    c.put("b", "late", b"v".to_vec(), None, &Cond::None).await.unwrap();
    assert!(c.store(1).unwrap().dirty());
    tokio::time::sleep(Duration::from_secs(5)).await;
    let within = ctl("/release?idx=1"); // delivered 5 s late, inside the SDK's 60 s signature
    evidence("late-pin-within-window", within.clone());
    after_publication().await;
    maintain(&c).await; // the dirty replica is re-read
    let listed = c.store(1).unwrap().idx.lock().await.keys.contains_key(&("b".to_string(), "late".to_string()));
    evidence("late-pin-applied", serde_json::json!({ "listedOnR1": listed }));

    ctl("/hold?idx=1&method=POST&path=/objects&n=1");
    c.put("b", "expired", b"w".to_vec(), None, &Cond::None).await.unwrap();
    tokio::time::sleep(Duration::from_secs(65)).await;
    let after = ctl("/release?idx=1"); // delivered after the signature expired
    evidence("late-pin-after-window", after.clone());
    after_publication().await;
    let fresh = load(&urls[1], keys.0[1]).await.unwrap();
    let listed = fresh.idx.lock().await.keys.contains_key(&("b".to_string(), "expired".to_string()));
    evidence("expired-pin-applied", serde_json::json!({ "listedOnR1": listed }));
}

#[tokio::test]
#[ignore]
async fn real_metadata_limit() {
    // L2 of the final review: indexd's metadata limit, against the client's MAX_META
    let urls = manifest();
    let keys = Keys::new(&[0]);
    let s = load(&urls[0], keys.0[0]).await.unwrap();
    let mut results = Vec::new();
    for n in [crate::store::MAX_META - 1, crate::store::MAX_META, crate::store::MAX_META + 1, crate::store::MAX_META + 40] {
        let mut obj = s.upload(Rc::from(&[7u8][..])).await.unwrap();
        obj.metadata = vec![b'x'; n];
        let r = s.sdk.pin_object(&obj).await;
        results.push(serde_json::json!({ "plainMetadataBytes": n, "accepted": r.is_ok(), "error": r.err().map(|e| e.to_string()) }));
    }
    evidence("metadata-limit", serde_json::json!(results));
}

#[tokio::test]
#[ignore]
async fn real_bootstrap_after_an_acknowledged_but_unpublished_pin() {
    // U1 on a running indexd. Publication is held with indexd's own stall condition (its last published second set
    // ahead of the database clock), so the window in which a listing can miss acknowledged pins is deterministic.
    let urls = manifest();
    let keys = Keys::new(&[0]);
    let c = boot(&urls, &[(0, false)], &keys, 1).await;
    maintain(&c).await;
    c.put("b", "k", b"v1".to_vec(), None, &Cond::None).await.unwrap();
    drop(c);
    after_publication().await;

    ctl("/stall-publish?idx=0&seconds=60");
    let w = boot(&urls, &[(0, false)], &keys, 1).await;
    w.put("b", "k", b"v2".to_vec(), None, &Cond::None).await.unwrap(); // acknowledged by the indexer
    drop(w);
    let r = boot(&urls, &[(0, false)], &keys, 1).await; // the next writer's boot, publication still stalled
    let seen = r.lookup("b", "k").map(|e| e.s);
    evidence("boot-while-unpublished", serde_json::json!({ "indexd": indexd(), "listing": format!("{:?}", listing()), "kSeen": seen }));
    match listing() {
        Listing::Feed => {
            assert!(seen.is_none(), "the feed listing misses the acknowledged PUT");
            r.delete("b", "k").await.unwrap(); // answers success
            let recorded = r.view.borrow().tombs.contains_key(&qkey("b", "k"));
            drop(r);
            ctl("/resume-publish?idx=0");
            after_publication().await;
            let a = boot(&urls, &[(0, false)], &keys, 1).await;
            let back = get(&a, "k").await;
            evidence("acknowledged-delete-undone", serde_json::json!({ "deleteRecorded": recorded, "kAfterPublication": back.as_ref().map(|b| String::from_utf8_lossy(b).to_string()) }));
            assert!(!recorded && back.as_deref() == Some(&b"v2"[..]), "DEFECT: an acknowledged DELETE was undone");
            // the fix's listing fails closed against this indexd instead of listing incompletely
            let e = load_listing(&urls[0], keys.0[0], Listing::Current).await.err().expect("no current listing on stock indexd");
            evidence("current-listing-on-stock-indexd", serde_json::json!({ "error": e }));
            assert!(e.contains("no consistent object listing"), "{e}");
        }
        Listing::Current => {
            assert_eq!(get(&r, "k").await.unwrap(), b"v2", "the current listing includes the acknowledged PUT");
            r.delete("b", "k").await.unwrap();
            let recorded = r.view.borrow().tombs.contains_key(&qkey("b", "k"));
            drop(r);
            ctl("/resume-publish?idx=0");
            after_publication().await;
            let a = boot(&urls, &[(0, false)], &keys, 1).await;
            let gone = a.lookup("b", "k").is_none();
            let feed = load_listing(&urls[0], keys.0[0], Listing::Feed).await.unwrap();
            let feed_has = feed.idx.lock().await.keys.contains_key(&("b".to_string(), "k".to_string()));
            evidence("acknowledged-delete-holds", serde_json::json!({ "deleteRecorded": recorded, "kGone": gone, "feedAfterPublicationHasK": feed_has }));
            assert!(recorded && gone && !feed_has, "the acknowledged DELETE holds");
        }
    }
}
