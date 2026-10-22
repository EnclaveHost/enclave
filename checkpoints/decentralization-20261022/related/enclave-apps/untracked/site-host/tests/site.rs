//! Native tests of the SAME verification and routing code the component runs (src/car.rs, src/site.rs).
//!
//! Two inputs:
//!   - the real embedded release (release/site.car, pinned by release/release.json), served and tampered with;
//!   - small synthetic archives built here with kubo's encoding, for shapes a real release never has (HAMT,
//!     symlinks, unsupported types, reserved paths, bad ledgers).
use sha2::{Digest, Sha256};
use site_host::car::{varint, Car, Cid, CODEC_DAG_PB, CODEC_RAW};
use site_host::site::{clean_path, Request, Site};

const REAL: &[u8] = include_bytes!("../release/site.car");

fn real_pin() -> String {
    let j: serde_json::Value = serde_json::from_str(include_str!("../release/release.json")).unwrap();
    j["cid"].as_str().unwrap().to_string()
}

fn get<'a>(s: &Site, path: &'a str) -> site_host::site::Response {
    s.handle(&Request { method: "GET", path_with_query: path, if_none_match: None, range: None, if_range: None })
}

// ---- a tiny kubo-shaped encoder (tests only) ------------------------------------------------------------------------

fn pb_bytes(out: &mut Vec<u8>, field: u64, data: &[u8]) {
    varint(out, field << 3 | 2);
    varint(out, data.len() as u64);
    out.extend_from_slice(data);
}

fn cid_of(codec: u64, b: &[u8]) -> Cid {
    Cid { codec, digest: Sha256::digest(b).into() }
}

struct Builder {
    blocks: Vec<(Cid, Vec<u8>)>,
}

impl Builder {
    fn new() -> Builder {
        Builder { blocks: Vec::new() }
    }
    fn put(&mut self, codec: u64, b: Vec<u8>) -> Cid {
        let c = cid_of(codec, &b);
        if !self.blocks.iter().any(|(x, _)| *x == c) {
            self.blocks.push((c, b));
        }
        c
    }
    fn file(&mut self, bytes: &[u8]) -> Cid {
        self.put(CODEC_RAW, bytes.to_vec())
    }
    fn dir_typed(&mut self, ty: u8, mut entries: Vec<(&str, Cid)>) -> Cid {
        entries.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        let mut node = Vec::new();
        for (name, cid) in entries {
            let mut link = Vec::new();
            pb_bytes(&mut link, 1, &cid.bytes());
            pb_bytes(&mut link, 2, name.as_bytes());
            varint(&mut link, 3 << 3);
            varint(&mut link, 1);
            pb_bytes(&mut node, 2, &link);
        }
        pb_bytes(&mut node, 1, &[0x08, ty]);
        self.put(CODEC_DAG_PB, node)
    }
    fn dir(&mut self, entries: Vec<(&str, Cid)>) -> Cid {
        self.dir_typed(1, entries)
    }
    fn car(&self, root: Cid) -> Vec<u8> {
        let rb = root.bytes();
        let mut h = vec![0xa2, 0x65];
        h.extend_from_slice(b"roots");
        h.extend_from_slice(&[0x81, 0xd8, 0x2a, 0x58, (rb.len() + 1) as u8, 0x00]);
        h.extend_from_slice(&rb);
        h.push(0x67);
        h.extend_from_slice(b"version");
        h.push(0x01);
        let mut out = Vec::new();
        varint(&mut out, h.len() as u64);
        out.extend_from_slice(&h);
        for (c, b) in &self.blocks {
            let cb = c.bytes();
            varint(&mut out, (cb.len() + b.len()) as u64);
            out.extend_from_slice(&cb);
            out.extend_from_slice(b);
        }
        out
    }
}

const LEDGER: &str = r#"{"schema":"enclave-site-release-ledger/1","builtAt":"2026-10-21T00:00:00.000Z","source":{"commit":null,"dirty":null},"previous":null,"retainHours":48,"retained":[],"csp":{"scriptSrcBase":"'self'","hashes":[{"hash":"'sha256-GXyZ2lypzpsF7B3nzXTrDPNLm9gU5HX+HeLZ3yQyT/A='","lastBuiltAt":"2026-10-21T00:00:00.000Z"}]},"headers":{"Content-Security-Policy":"default-src 'self'; script-src SCRIPT_SRC","Cross-Origin-Opener-Policy":"same-origin-allow-popups","X-Content-Type-Options":"nosniff"},"installers":["get/install.sh","get/install.ps1","get/host.ps1"]}"#;

/// A minimal valid release; `tweak` may replace or add top-level entries.
fn mini(tweak: impl FnOnce(&mut Builder, &mut Vec<(&'static str, Cid)>)) -> (Vec<u8>, String) {
    let mut b = Builder::new();
    let ledger = b.file(LEDGER.as_bytes());
    let wk = b.dir(vec![("enclave-site-release.json", ledger)]);
    let sh = b.file(b"#!/bin/sh\necho install\n");
    let ps = b.file(b"Write-Host install\n");
    let hp = b.file(b"Write-Host host\n");
    let get = b.dir(vec![("install.sh", sh), ("install.ps1", ps), ("host.ps1", hp)]);
    let index = b.file(b"<!doctype html><title>home</title>");
    let nf = b.file(b"<!doctype html><title>404</title>");
    let apps = b.file(b"<!doctype html><title>apps</title>");
    let redirects = b.file(b"/apps /apps.html 200\n/old /apps 301\n/* /404.html 404\n");
    let mut top: Vec<(&'static str, Cid)> = vec![(".well-known", wk), ("get", get), ("index.html", index), ("404.html", nf), ("apps.html", apps), ("_redirects", redirects)];
    tweak(&mut b, &mut top);
    let root = b.dir(top);
    (b.car(root), root.to_base32())
}

fn open_err(car: &[u8], pin: &str) -> String {
    match Site::open(car, Some(pin)) {
        Ok(_) => panic!("expected a refusal"),
        Err(e) => e,
    }
}

// ---- the real release -----------------------------------------------------------------------------------------------

#[test]
fn real_release_opens_only_under_its_own_pin() {
    let pin = real_pin();
    let s = Site::open(REAL, Some(&pin)).expect("the embedded release opens under its pin");
    assert_eq!(s.root(), pin);
    let r = get(&s, "/");
    assert_eq!(r.status, 200);
    assert!(r.header("Content-Security-Policy").unwrap().contains("script-src 'self'"));
    // any other CID, an absent pin, an empty pin: total refusal
    let other = "bafybeig3rai3tyoimbhb32vo6hkkw3o336wluht7owbs7mefhtiridwp6y";
    assert!(open_err(REAL, other).contains("is not the embedded release"));
    assert!(Site::open(REAL, None).is_err());
    assert!(Site::open(REAL, Some("  ")).is_err());
    assert!(open_err(REAL, "Qmnotbase32").contains("not a base32 CIDv1"));
}

/// Flip one byte of `REAL` at `off`, open it under the real pin, and require: the site opens; exactly the files in
/// `hit` answer 502 (naming the failed verification, serving no content); every other file answers exactly as from
/// the untampered archive.
fn tamper_leaf(off: usize, hit: &[&str]) {
    let pin = real_pin();
    let mut bad = REAL.to_vec();
    bad[off] ^= 0x01;
    let s = Site::open(&bad, Some(&pin)).expect("a leaf no audit reads does not refuse the site");
    let good = Site::open(REAL, Some(&pin)).unwrap();
    for path in all_files(&Car::open(REAL).unwrap()) {
        let r = get(&s, &format!("/{path}"));
        if hit.contains(&path.as_str()) {
            assert_eq!(r.status, 502, "{path} must refuse");
            assert!(String::from_utf8_lossy(&r.body).contains("does not hash to its CID"), "{path}");
            for range in ["bytes=0-0", "bytes=-1"] {
                let rr = s.handle(&Request { method: "GET", path_with_query: &format!("/{path}"), if_none_match: None, range: Some(range), if_range: None });
                assert_eq!(rr.status, 502, "{path} {range}");
            }
        } else {
            let r0 = get(&good, &format!("/{path}"));
            assert_eq!((r.status, &r.body), (r0.status, &r0.body), "{path} answered differently");
        }
    }
}

/// The byte offset of `needle` inside REAL (it must occur exactly once).
fn offset_of(needle: &[u8]) -> usize {
    let mut at = REAL.windows(needle.len()).enumerate().filter(|(_, w)| *w == needle).map(|(i, _)| i);
    let first = at.next().expect("present");
    assert!(at.next().is_none(), "the probe must be unique in the archive");
    first
}

#[test]
fn real_release_tampering_is_never_served() {
    let pin = real_pin();
    let car = Car::open(REAL).unwrap();
    let good = Site::open(REAL, Some(&pin)).unwrap();
    // 1. a single-block file (index.html is one raw leaf): flip a byte in its middle
    let index = get(&good, "/index.html").body;
    assert!(index.len() < 262144);
    let mid = index.len() / 2;
    tamper_leaf(offset_of(&index[mid - 32..mid + 32]) + 32, &["index.html"]);
    // 2. a multi-block file: the largest file of the release, a byte deep in one of its leaves
    let largest = all_files(&car).into_iter().map(|p| { let n = get(&good, &format!("/{p}")).body.len(); (n, p) }).max().unwrap();
    assert!(largest.0 > 262144, "the release has a multi-block file");
    let big = get(&good, &format!("/{}", largest.1)).body;
    // inside one 256 KiB leaf (a window across a leaf boundary would not be contiguous in the archive)
    let at = (big.len() * 3 / 4) / 262144 * 262144 + 1000;
    assert!(at + 64 < big.len());
    tamper_leaf(offset_of(&big[at..at + 64]) + 10, &[largest.1.as_str()]);
    // 3. a flipped byte inside the root directory block refuses the whole site
    let car = Car::open(REAL).unwrap();
    let root_block = car.block(&car.root).unwrap();
    let off = REAL.windows(root_block.len()).position(|w| w == root_block).unwrap();
    let mut bad = REAL.to_vec();
    bad[off + root_block.len() / 2] ^= 0x01;
    assert!(Site::open(&bad, Some(&pin)).is_err());
}

fn all_files(car: &Car) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![(String::new(), car.root)];
    while let Some((dir, cid)) = stack.pop() {
        if let Ok(site_host::car::Node::Dir(links)) = car.node(&cid) {
            for l in links {
                let rel = if dir.is_empty() { l.name.clone() } else { format!("{dir}/{}", l.name) };
                match car.node(&l.cid) {
                    Ok(site_host::car::Node::Dir(_)) => stack.push((rel, l.cid)),
                    _ => out.push(rel),
                }
            }
        }
    }
    out
}

// ---- release shapes a real release never has ------------------------------------------------------------------------

#[test]
fn mini_release_serves() {
    let (car, pin) = mini(|_, _| {});
    let s = Site::open(&car, Some(&pin)).unwrap();
    assert_eq!(get(&s, "/").status, 200);
    assert_eq!(get(&s, "/apps").body, b"<!doctype html><title>apps</title>");
    let r = get(&s, "/old?x=1");
    assert_eq!((r.status, r.header("Location")), (301, Some("/apps?x=1")));
    let r = get(&s, "/nope");
    assert_eq!((r.status, r.header("Cache-Control")), (404, Some("no-store")));
    assert_eq!(r.body, b"<!doctype html><title>404</title>");
    let r = get(&s, "/install.sh");
    assert_eq!((r.status, r.header("Content-Type")), (200, Some("text/plain; charset=utf-8")));
    assert_eq!(
        r.header("Content-Security-Policy"),
        Some("default-src 'self'; script-src 'self' 'sha256-GXyZ2lypzpsF7B3nzXTrDPNLm9gU5HX+HeLZ3yQyT/A='")
    );
}

#[test]
fn hamt_and_symlink_are_refused() {
    let (car, pin) = mini(|b, top| {
        let f = b.file(b"x");
        let hamt = b.dir_typed(5, vec![("x.txt", f)]);
        top.push(("sharded", hamt));
    });
    assert!(open_err(&car, &pin).contains("HAMT"));
    let (car, pin) = mini(|b, top| {
        let mut node = Vec::new();
        pb_bytes(&mut node, 1, &[0x08, 0x04]);
        let link = b.put(CODEC_DAG_PB, node);
        top.push(("link.html", link));
    });
    assert!(open_err(&car, &pin).contains("symlink"));
}

#[test]
fn unsupported_types_and_reserved_paths_are_refused() {
    for name in ["tool.exe", "README", "archive.tar.gz", ".htaccess"] {
        let (car, pin) = mini(|b, top| {
            let f = b.file(b"x");
            let leaked: &'static str = Box::leak(name.to_string().into_boxed_str());
            top.push((leaked, f));
        });
        assert!(open_err(&car, &pin).contains("whose type this app does not serve"), "{name}");
    }
    let (car, pin) = mini(|b, top| {
        let f = b.file(b"x");
        top.push(("__enclave", b.dir(vec![("session.html", f)])));
    });
    assert!(open_err(&car, &pin).contains("a path the platform or this app answers"));
}

#[test]
fn ledger_and_header_drift_are_refused() {
    let cases: [(&str, &str); 6] = [
        ("\"retainHours\":48", "\"retainHours\":12"),
        ("script-src SCRIPT_SRC", "script-src 'self'"),
        ("\"X-Content-Type-Options\":\"nosniff\"", "\"X-Content-Type-Options\":\"nosniff\\\"\""),
        ("\"X-Content-Type-Options\":\"nosniff\"", "\"Set-Cookie\":\"a=b\""),
        ("'sha256-GXyZ2lypzpsF7B3nzXTrDPNLm9gU5HX+HeLZ3yQyT/A='", "'unsafe-inline'"),
        ("enclave-site-release-ledger/1", "enclave-site-release-ledger/2"),
    ];
    for (from, to) in cases {
        let ledger = LEDGER.replace(from, to);
        assert_ne!(ledger, LEDGER, "{from}");
        let mut b = Builder::new();
        let l = b.file(ledger.as_bytes());
        let wk = b.dir(vec![("enclave-site-release.json", l)]);
        let (car, pin) = mini(|bb, top| {
            for (c, blk) in b.blocks.drain(..) {
                bb.put(c.codec, blk);
            }
            top.retain(|(n, _)| *n != ".well-known");
            top.push((".well-known", wk));
        });
        assert!(Site::open(&car, Some(&pin)).is_err(), "accepted a ledger with {to}");
    }
    // no ledger at all
    let (car, pin) = mini(|_, top| top.retain(|(n, _)| *n != ".well-known"));
    assert!(open_err(&car, &pin).contains("no ledger"));
    // an unsupported _redirects rule
    let (car, pin) = mini(|b, top| {
        let r = b.file(b"/a/:name /b 200\n");
        top.retain(|(n, _)| *n != "_redirects");
        top.push(("_redirects", r));
    });
    assert!(open_err(&car, &pin).contains("unsupported site redirect"));
}

// ---- request paths, ranges, validators ------------------------------------------------------------------------------

#[test]
fn hostile_paths_are_refused_not_cleaned() {
    for p in ["/..", "/../etc/passwd", "/a/../b", "/%2e%2e/x", "/%2E%2E", "/a%2fb", "/a%5cb", "/a\\b", "//", "/a//b", "/./a",
        "/a/.", "/%00", "/%zz", "/%", "relative", "/a%25", "/\u{7f}", "/%c3%28"] {
        assert_eq!(clean_path(p), None, "{p:?}");
    }
    for p in ["/", "/apps", "/apps/", "/js/boot.js", "/a%20b", "/.well-known/security.txt"] {
        assert!(clean_path(p).is_some(), "{p:?}");
    }
    let (car, pin) = mini(|_, _| {});
    let s = Site::open(&car, Some(&pin)).unwrap();
    let r = get(&s, "/../index.html");
    assert_eq!((r.status, r.header("Cache-Control")), (400, Some("no-store")));
    let r = s.handle(&Request { method: "POST", path_with_query: "/", if_none_match: None, range: None, if_range: None });
    assert_eq!((r.status, r.header("Allow")), (405, Some("GET, HEAD")));
}

#[test]
fn ranges_and_validators() {
    let (car, pin) = mini(|_, _| {});
    let s = Site::open(&car, Some(&pin)).unwrap();
    let full = get(&s, "/index.html");
    let etag = full.header("ETag").unwrap().to_string();
    let req = |range: Option<&'static str>, inm: Option<&str>, ir: Option<&str>| {
        s.handle(&Request { method: "GET", path_with_query: "/index.html", if_none_match: inm, range, if_range: ir })
    };
    let r = req(None, Some(&etag), None);
    assert_eq!((r.status, r.body.len()), (304, 0));
    let r = req(Some("bytes=0-8"), None, None);
    assert_eq!((r.status, r.body.as_slice()), (206, &b"<!doctype"[..]));
    let r = req(Some("bytes=-6"), None, None);
    assert_eq!(r.body, b"title>");
    let r = req(Some("bytes=999-"), None, None);
    assert_eq!(r.status, 416);
    let r = req(Some("bytes=0-1,4-5"), None, None);
    assert_eq!(r.status, 200);
    // a stale If-Range: the full, current body
    let r = req(Some("bytes=0-1"), None, Some("\"bafkreiother\""));
    assert_eq!(r.status, 200);
    let head = s.handle(&Request { method: "HEAD", path_with_query: "/index.html", if_none_match: None, range: None, if_range: None });
    assert_eq!((head.status, head.body.len()), (200, 0));
    assert_eq!(head.header("ETag"), Some(etag.as_str()));
}

#[test]
fn deployment_config_pins_exactly() {
    use site_host::pin_from_config as pin;
    assert_eq!(pin(Some(r#"{"release":"bafyx","wasi":"0.2"}"#.into())).unwrap(), "bafyx");
    assert!(pin(None).is_err());
    assert!(pin(Some("[]".into())).is_err());
    assert!(pin(Some("{}".into())).is_err());
    assert!(pin(Some(r#"{"release":"bafyx","relase":"typo"}"#.into())).unwrap_err().contains("unknown key"));
    assert!(pin(Some(r#"{"release":7}"#.into())).is_err());
}
