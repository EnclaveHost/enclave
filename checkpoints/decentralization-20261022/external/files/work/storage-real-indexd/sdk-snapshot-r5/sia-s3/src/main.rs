//! sia-s3: an S3 endpoint backed by Sia, for enclave.host.
//!
//! Data is encrypted and erasure-coded client-side (inside this enclave) by the
//! Sia SDK and stored on Sia hosts through an indexer (default
//! https://sia.enclave.host), or replicated across several independent indexers
//! (replica.rs). The S3 key index lives in the objects' own sealed metadata (see
//! store.rs), so the app keeps no local state: a restart reloads the index from
//! the indexers' object feeds.
//!
//! The one platform rule: read `ENCLAVE_PORTS` and bind the actual port.

mod config;
mod fencing;
mod recovery;
mod diag;
mod http;
mod import;
mod replica;
mod s3;
mod sigv4;
mod store;
#[cfg(test)]
mod real_indexd; // HARNESS-ONLY: real-indexd driver (work/storage-real-indexd), not in main
#[cfg(test)]
mod real_fencing; // DRIVER CASES for fence-capable real indexd (all #[ignore])

use std::rc::Rc;
use std::time::Duration;

use sia_storage::{AppKey, AppMetadata, Builder, Sdk, app_id};
use tokio::net::TcpListener;

use crate::config::{Config, ReplicaCfg};
use crate::http::{ReadError, read_request, write_head};
use crate::replica::Cluster;
use crate::s3::App;
use crate::store::Store;

// Must match the metadata registered for this app key on the indexer.
const META: AppMetadata = AppMetadata {
    id: app_id!("5e1a0c3e7f2d4b19a8c6e0d4f3b2a1908e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b"),
    name: "sia-s3",
    description: "S3 over Sia for enclave.host platform storage",
    service_url: "https://enclave.host",
    logo_url: None,
    callback_url: None,
};


/// stderr logger for the SDK's `log` output: warnings and errors always,
/// everything from sia_* crates at debug when SIAS3_LOG=debug.
struct Logger { debug: bool }
impl log::Log for Logger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Warn || (self.debug && m.target().starts_with("sia"))
    }
    fn log(&self, r: &log::Record) {
        if self.enabled(r.metadata()) {
            eprintln!("[{}] {} {}", r.level(), r.target(), r.args());
        }
    }
    fn flush(&self) {}
}

/// `ENCLAVE_PORTS=http:8000=18321,...` → the actual port for `http:8000`.
fn port() -> u16 {
    let default = 8000;
    let Ok(ports) = std::env::var("ENCLAVE_PORTS") else { return default };
    for spec in ports.split(',') {
        let mut it = spec.split(['=', ':']);
        if let (Some("http"), Some("8000"), Some(actual)) = (it.next(), it.next(), it.next()) {
            if let Ok(p) = actual.trim().parse() {
                return p;
            }
        }
    }
    default
}

async fn connect(r: &ReplicaCfg) -> Result<Sdk, String> {
    Builder::new(r.indexer.as_str(), META)
        .map_err(|e| e.to_string())?
        .connected(&AppKey::import(r.app_key))
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("the app key is not authorized on {}", r.indexer))
}

/// Connect to one indexer and load its index, retrying 5 s → 300 s, then join the cluster. Replicas load
/// independently: one that is down never holds up the others.
async fn load_replica(app: Rc<App>, cfg: Rc<Config>, i: usize) {
    let r = &cfg.replicas[i];
    let mut wait = 5u64;
    let store = loop {
        match async { Store::load_with(connect(r).await?, cfg.compact_max_object, cfg.opts.clone()).await }.await {
            Ok(s) => break Rc::new(s),
            Err(e) => {
                // shown on the status page and /healthz: never a signed indexer URL (connect() errors carry them)
                let e = crate::store::redact(&e);
                eprintln!("[sia-s3] replica {}: boot: {e}; retrying in {wait}s", r.name);
                *app.cluster.replicas[i].error.borrow_mut() = Some(format!("boot: {e}"));
                *app.boot_error.borrow_mut() = Some(format!(
                    "{} of {} replicas are loaded ({}: {e}){}",
                    app.cluster.loaded().len(),
                    app.cluster.n(),
                    r.name,
                    app.cluster.ms_reason().map(|m| format!("; {m}")).unwrap_or_default()
                ));
                tokio::time::sleep(Duration::from_secs(wait)).await;
                wait = (wait * 2).min(300);
            }
        }
    };
    app.cluster.attach(i, store.clone()).await;
    eprintln!("[sia-s3] replica {} loaded ({}/{} loaded)", r.name, app.cluster.loaded().len(), app.cluster.n());
    *app.boot_error.borrow_mut() = if app.cluster.ready() { None } else { app.cluster.ms_reason() };
    store.sweep().await;
}

/// Writer fencing (fencing.rs): connect every replica; once all have connected, or 30 s after the first did, read
/// their fences, raise one ballot on all of them and list those that installed it (Cluster::fence_boot). Replicas
/// that connect or answer later get the same ballot (Cluster::fence_join). Nothing is served before the fence is
/// installed on the acting set's N - W + 1 voters and they are listed. A refused policy or a stale/duplicate ballot
/// stops for good, with the reason on the status page.
async fn load_fenced(app: Rc<App>, cfg: Rc<Config>) {
    if let Err(why) = cfg.fence.check() {
        eprintln!("[sia-s3] writer fencing refused: {why}");
        *app.boot_error.borrow_mut() = Some(format!("writer fencing refused: {why}"));
        return;
    }
    let n = cfg.replicas.len();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(usize, Sdk)>();
    for i in 0..n {
        let (tx, cfg, app) = (tx.clone(), cfg.clone(), app.clone());
        tokio::task::spawn_local(async move {
            let mut wait = 5u64;
            loop {
                match connect(&cfg.replicas[i]).await {
                    Ok(sdk) => {
                        let _ = tx.send((i, sdk));
                        return;
                    }
                    Err(e) => {
                        let e = crate::store::redact(&e);
                        eprintln!("[sia-s3] replica {}: connect: {e}; retrying in {wait}s", cfg.replicas[i].name);
                        *app.cluster.replicas[i].error.borrow_mut() = Some(format!("connect: {e}"));
                        tokio::time::sleep(Duration::from_secs(wait)).await;
                        wait = (wait * 2).min(300);
                    }
                }
            }
        });
    }
    let mut first = Vec::new();
    if let Some(x) = rx.recv().await {
        first.push(x);
    }
    let until = tokio::time::Instant::now() + Duration::from_secs(30);
    while first.len() < n {
        match tokio::time::timeout_at(until, rx.recv()).await {
            Ok(Some(x)) => first.push(x),
            _ => break,
        }
    }
    let mut wait = 5u64;
    loop {
        match app.cluster.fence_boot(first.clone(), cfg.compact_max_object, cfg.opts.clone()).await {
            Ok(()) => break,
            Err(e) => {
                *app.boot_error.borrow_mut() = Some(format!("writer fencing: {e}"));
                if app.cluster.superseded().is_some() {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(wait)).await;
                wait = (wait * 2).min(300);
                while let Ok(x) = rx.try_recv() {
                    first.push(x);
                }
            }
        }
    }
    // load-time cleanup, as an unfenced load does (its deletes carry the fence)
    for (_, s) in app.cluster.loaded() {
        tokio::task::spawn_local(async move { s.sweep().await });
    }
    // replicas of the first set that did not install the ballot, and every later one, join with backoff
    let loaded: Vec<usize> = app.cluster.loaded().into_iter().map(|(i, _)| i).collect();
    let pending: Vec<(usize, Sdk)> = first.into_iter().filter(|(i, _)| !loaded.contains(i)).collect();
    for (i, sdk) in pending {
        tokio::task::spawn_local(join_fenced(app.clone(), cfg.clone(), i, sdk));
    }
    while let Some((i, sdk)) = rx.recv().await {
        tokio::task::spawn_local(join_fenced(app.clone(), cfg.clone(), i, sdk));
    }
}

async fn join_fenced(app: Rc<App>, cfg: Rc<Config>, i: usize, sdk: Sdk) {
    let mut wait = 5u64;
    loop {
        match app.cluster.fence_join(i, sdk.clone(), cfg.compact_max_object, cfg.opts.clone()).await {
            Ok(()) => {
                eprintln!("[sia-s3] replica {} fenced and loaded", cfg.replicas[i].name);
                if let Some(s) = app.cluster.store(i) {
                    s.sweep().await;
                }
                return;
            }
            Err(e) => {
                let e = crate::store::redact(&e);
                *app.cluster.replicas[i].error.borrow_mut() = Some(format!("fence join: {e}"));
                if app.cluster.superseded().is_some() {
                    return;
                }
                tokio::time::sleep(Duration::from_secs(wait)).await;
                wait = (wait * 2).min(300);
            }
        }
    }
}

async fn boot(app: Rc<App>, cfg: Rc<Config>) {
    if app.cluster.is_fenced() {
        tokio::task::spawn_local(load_fenced(app.clone(), cfg.clone()));
    } else {
        for (i, r) in cfg.replicas.iter().enumerate() {
            if i == 0 {
                eprintln!("[sia-s3] UNFENCED (writerFence off): exactly one writer at a time is the operator's responsibility ({})", r.name);
            }
            tokio::task::spawn_local(load_replica(app.clone(), cfg.clone(), i));
        }
    }
    // a membership change that was sealed but not finished, or a set of replicas without membership records, is
    // finished (committed) before anything is served: maintenance backfills, seals and admits the configured members
    // while every request answers 503
    let mut last: Option<std::time::Instant> = None;
    while !app.cluster.ready() {
        if app.cluster.finishing() && last.is_none_or(|t| t.elapsed() >= Duration::from_secs(cfg.repair_every_secs.min(60))) {
            let r = app.cluster.repair(cfg.repair_max_bytes).await;
            eprintln!("[sia-s3] finishing the membership change: {} copies, {} parts, {} records, {} pending", r.copies, r.parts, r.admitted, r.pending);
            *app.boot_error.borrow_mut() = app.cluster.ms_reason();
            last = Some(std::time::Instant::now());
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    *app.boot_error.borrow_mut() = None;
    eprintln!("[sia-s3] ready");
    // with one indexer too: unknown outcomes are re-read, dead versions purged and tombstones collected
    tokio::task::spawn_local(repair_loop(app.cluster.clone(), cfg.repair_every_secs, cfg.repair_max_bytes));

    loop {
        tokio::time::sleep(Duration::from_secs(cfg.compact_every_secs)).await;
        if app.cluster.superseded().is_some() {
            continue; // writer fencing stopped this instance: nothing more is written
        }
        for (i, store) in app.cluster.loaded() {
            match store.compact().await {
                Ok(n) => {
                    let mut st = store.stats.borrow_mut();
                    st.compactions += 1;
                    st.compacted_objects += n as u64;
                    st.last_compaction = Some(chrono::Utc::now().to_rfc3339());
                    if n > 0 {
                        eprintln!("[sia-s3] compactor ({}): repacked {n} objects", cfg.replicas[i].name);
                    }
                }
                Err(e) => {
                    eprintln!("[sia-s3] compactor ({}): {e}", cfg.replicas[i].name);
                    store.stats.borrow_mut().last_error = Some(e);
                }
            }
        }
    }
}

/// Re-read ambiguous replicas, bring lagging ones up to the merged view, record deletions as floors everywhere and
/// reclaim the payload they cover.
async fn repair_loop(cluster: Rc<Cluster>, every: u64, max_bytes: u64) {
    loop {
        tokio::time::sleep(Duration::from_secs(every)).await;
        let r = cluster.repair(max_bytes).await;
        if r.reconciled + r.purged + r.copies + r.deletes + r.floors + r.reclaimed + r.merged + r.parts + r.admitted + r.ceilings + r.pending > 0 {
            eprintln!(
                "[sia-s3] repair: {} re-read, {} dead versions purged, {} copies, {} deletes, {} floors written, {} tombstones reclaimed, {} ledgers merged, {} multipart parts copied, {} membership records, {} version ceilings copied, {} pending",
                r.reconciled, r.purged, r.copies, r.deletes, r.floors, r.reclaimed, r.merged, r.parts, r.admitted, r.ceilings, r.pending
            );
        }
    }
}

async fn conn(app: Rc<App>, mut s: tokio::net::TcpStream, max_body: usize) {
    let mut carry = Vec::new();
    loop {
        let req = match read_request(&mut s, &mut carry, max_body).await {
            Ok(r) => r,
            Err(ReadError::Closed) => return,
            Err(ReadError::TooLarge) => {
                let _ = write_head(&mut s, 413, &[], 0, false).await;
                return;
            }
            Err(ReadError::Bad(e)) => {
                let body = format!("<?xml version=\"1.0\"?><Error><Code>BadRequest</Code><Message>{e}</Message></Error>");
                let _ = write_head(&mut s, 400, &[("Content-Type".into(), "application/xml".into())], body.len() as u64, false).await;
                let _ = tokio::io::AsyncWriteExt::write_all(&mut s, body.as_bytes()).await;
                return;
            }
        };
        if s3::handle(&app, &req, &mut s).await.is_err() || !req.keep_alive {
            return;
        }
    }
}

fn main() {
    let debug = std::env::var("SIAS3_LOG").is_ok_and(|v| v == "debug");
    if log::set_boxed_logger(Box::new(Logger { debug })).is_ok() {
        log::set_max_level(if debug { log::LevelFilter::Debug } else { log::LevelFilter::Warn });
    }
    let recovery_args: Vec<String> = std::env::args().collect();
    if recovery_args.get(1).map(String::as_str) == Some("recovery") {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
        let local = tokio::task::LocalSet::new();
        if let Err(e) = local.block_on(&rt, recovery::command(&recovery_args[2..])) {
            eprintln!("[recovery] {e}");
            std::process::exit(1);
        }
        return;
    }
    let cfg = match config::load() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[sia-s3] config: {e}");
            std::process::exit(2);
        }
    };
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    let local = tokio::task::LocalSet::new();

    // `sia-s3 import <bucket> <manifest.json> [replica]`: bulk-load objects into one indexer, then exit
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("import") {
        let (Some(bucket), Some(manifest)) = (args.get(2).cloned(), args.get(3).cloned()) else {
            eprintln!("usage: sia-s3 import <bucket> <manifest.json> [replica name]");
            std::process::exit(2);
        };
        let Some(r) = cfg.replicas.iter().find(|r| args.get(4).is_none_or(|n| r.name == *n)).cloned() else {
            eprintln!("[import] no replica named {:?}", args[4]);
            std::process::exit(2);
        };
        if cfg.replicas.len() > 1 && args.get(4).is_none() {
            eprintln!("[import] {} replicas are configured: name the one to import into (run once per replica)", cfg.replicas.len());
            std::process::exit(2);
        }
        let res = local.block_on(&rt, async move { import::run(connect(&r).await?, bucket, manifest).await });
        if let Err(e) = res {
            eprintln!("[import] FAILED: {e}");
            std::process::exit(1);
        }
        return;
    }

    local.block_on(&rt, async move {
        let cluster = Cluster::new(
            cfg.replicas.iter().map(|r| (r.name.clone(), r.indexer.clone(), r.retiring)).collect(),
            cfg.write_quorum,
            cfg.opts.clone(),
            cfg.timing.clone(),
        )
        .fenced(cfg.fence.clone());
        let app = Rc::new(App {
            cluster: Rc::new(cluster),
            buckets: cfg.buckets.clone(),
            credentials: cfg.credentials.clone(),
            region: cfg.region.clone(),
            boot_error: Default::default(),
        });
        let p = port();
        let listener = match TcpListener::bind(("127.0.0.1", p)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[sia-s3] bind 127.0.0.1:{p}: {e}");
                std::process::exit(1);
            }
        };
        let indexers: Vec<&str> = cfg.replicas.iter().map(|r| r.indexer.as_str()).collect();
        eprintln!(
            "[sia-s3] listening on 127.0.0.1:{p}; indexers {indexers:?} (write quorum {}); buckets {:?}",
            cfg.write_quorum, cfg.buckets
        );
        let max_body = cfg.max_body;
        let cfg = Rc::new(cfg);
        tokio::task::spawn_local(boot(app.clone(), cfg.clone()));
        loop {
            match listener.accept().await {
                Ok((s, _)) => {
                    tokio::task::spawn_local(conn(app.clone(), s, max_body));
                }
                Err(e) => {
                    eprintln!("[sia-s3] accept: {e}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        }
    });
}
