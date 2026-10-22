//! DRIVER CASES (not yet runnable): writer fencing against REAL indexd with the fence API (interface v3 section 2),
//! on the storage-indexd harness (work/storage-real-indexd/harness, control API on loopback). Every test is
//! #[ignore], and needs an indexd build that implements GET/POST /fence, the receipt and the exact `sf` check:
//!   SIAS3_REAL_CTL=$(cat <run>/ctl.url) SIAS3_REAL_INDEXD=fence cargo test --offline \
//!     --target x86_64-unknown-linux-gnu real_fence_ -- --ignored --test-threads=1
//! They use the harness's /register, /manifest, /hold, /release, /stall-publish and /resume-publish, and print
//! EVIDENCE lines. Helpers are duplicated from real_indexd.rs (the indexd owner's file is not edited).

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
        accept_unevidenced_isolation: true, // DRIVER ONLY: the isolation fact is not what these cases test
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
    let (f1, f2) = (c1.fresh().await.is_ok(), c2.fresh().await.is_ok());
    evidence("two-starters", serde_json::json!({ "fresh": [f1, f2], "s1": c1.fence_status(), "s2": c2.fence_status() }));
    assert!(!(f1 && f2));
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
