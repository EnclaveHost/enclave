// wasi:http in the portable runtime (src/httpd.rs), on the host: enclave-apps' ggml-probe -- a first-party HTTP app that
// reaches its model through wasi:nn, bytes unchanged (conformance/bundles/ggml-probe.wasm, sha256 1ad17b45...) -- served on
// one end of a socketpair, the way the payload serves a vsock connection, against a mock model whose greedy answers this
// file predicts.
use pvm_rt::httpd::HttpServer;
use pvm_rt::nn::NnEngine;
use pvm_rt::NnModel;
use std::io::{Read, Write};
use std::os::fd::IntoRawFd;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const VOCAB: usize = 152_000; // ggml-probe's fixed prompt holds Qwen ids up to 151644
const PROMPT: &[i32] = &[151644, 8948, 198, 2610, 525, 264, 10950, 17847, 13];
const FNV0: u64 = 0xcbf29ce484222325;
fn fnv(mut h: u64, id: i32) -> u64 {
    for b in (id as u32).to_le_bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}
fn predict(prompt: &[i32], n: usize) -> Vec<i32> {
    let mut h = prompt.iter().fold(FNV0, |h, &id| fnv(h, id));
    (0..n)
        .map(|_| {
            let t = (h % VOCAB as u64) as i32;
            h = fnv(h, t);
            t
        })
        .collect()
}

struct Mock {
    h: Mutex<u64>,
    delay: Duration,
}
impl NnEngine for Mock {
    fn n_vocab(&self) -> usize {
        VOCAB
    }
    fn n_ctx(&self) -> usize {
        4096
    }
    fn tokenize(&self, t: &[u8]) -> Result<Vec<i32>, String> {
        Ok(t.iter().map(|b| *b as i32).collect())
    }
    fn piece(&self, id: i32) -> Result<Vec<u8>, String> {
        Ok(id.to_string().into_bytes())
    }
    fn reset(&self) -> Result<(), String> {
        *self.h.lock().unwrap() = FNV0;
        Ok(())
    }
    fn decode(&self, ids: &[i32], logits: &mut [f32]) -> Result<(), String> {
        std::thread::sleep(self.delay);
        let mut h = self.h.lock().unwrap();
        for &id in ids {
            *h = fnv(*h, id);
        }
        let t = (*h % VOCAB as u64) as usize;
        logits.iter_mut().for_each(|l| *l = 0.0);
        logits[t] = 1.0;
        Ok(())
    }
}

fn bundle() -> (Vec<u8>, [u8; 32]) {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../conformance/bundles/ggml-probe.wasm");
    let b = std::fs::read(p).unwrap();
    use sha2::Digest;
    let d: [u8; 32] = sha2::Sha256::digest(&b).into();
    (b, d)
}

fn server(delay_ms: u64, deadline: Duration, log: Arc<Mutex<Vec<String>>>) -> Arc<HttpServer> {
    let (b, d) = bundle();
    let m = Arc::new(Mock {
        h: Mutex::new(FNV0),
        delay: Duration::from_millis(delay_ms),
    });
    Arc::new(
        HttpServer::open(
            &b,
            &d,
            256 << 20,
            deadline,
            Some(NnModel {
                name: "mock-1".into(),
                engine: m,
            }),
            Some(Box::new(move |s: &[u8]| {
                log.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(s).into_owned())
            })),
        )
        .unwrap(),
    )
}

/// Serves one connection in a thread; returns the client end.
fn connect(s: &Arc<HttpServer>) -> (UnixStream, std::thread::JoinHandle<bool>) {
    let (client, srv_end) = UnixStream::pair().unwrap();
    let s = s.clone();
    let fd = srv_end.into_raw_fd();
    (
        client,
        std::thread::spawn(move || unsafe { s.serve_fd(fd) }.is_ok()),
    )
}

/// One response: (status, body), chunked or length-delimited.
fn read_response(c: &mut UnixStream) -> Option<(u16, String)> {
    let mut buf = Vec::new();
    let mut b = [0u8; 4096];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        let n = c.read(&mut b).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&b[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_lowercase();
    let status: u16 = head.split_whitespace().nth(1)?.parse().ok()?;
    let mut rest = buf[head_end..].to_vec();
    let mut fill = |rest: &mut Vec<u8>, want: usize| -> Option<()> {
        while rest.len() < want {
            let n = c.read(&mut b).ok()?;
            if n == 0 {
                return None;
            }
            rest.extend_from_slice(&b[..n]);
        }
        Some(())
    };
    let body = if let Some(l) = head.lines().find_map(|l| l.strip_prefix("content-length:")) {
        let n: usize = l.trim().parse().ok()?;
        fill(&mut rest, n)?;
        rest[..n].to_vec()
    } else {
        let mut out = Vec::new();
        loop {
            while !rest.windows(2).any(|w| w == b"\r\n") {
                let more = rest.len() + 1;
                fill(&mut rest, more)?;
            }
            let i = rest.windows(2).position(|w| w == b"\r\n")?;
            let n = usize::from_str_radix(String::from_utf8_lossy(&rest[..i]).trim(), 16).ok()?;
            fill(&mut rest, i + 2 + n + 2)?;
            out.extend_from_slice(&rest[i + 2..i + 2 + n]);
            rest.drain(..i + 2 + n + 2);
            if n == 0 {
                break;
            }
        }
        out
    };
    Some((status, String::from_utf8_lossy(&body).into_owned()))
}

fn get(c: &mut UnixStream, path: &str, close: bool) -> Option<(u16, String)> {
    let conn = if close { "Connection: close\r\n" } else { "" };
    c.write_all(format!("GET {path} HTTP/1.1\r\nHost: app\r\n{conn}\r\n").as_bytes())
        .ok()?;
    read_response(c)
}

#[test]
fn a_first_party_http_app_runs_unchanged_and_decodes_what_the_model_predicts() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let s = server(0, Duration::from_secs(30), log.clone());
    let (mut c, t) = connect(&s);
    // keep-alive: three requests on one connection, each in a fresh instance
    assert_eq!(
        get(&mut c, "/ping", false),
        Some((200, "{\"ok\":true}".into()))
    );
    let (st, body) = get(&mut c, "/?graph=mock-1&steps=4", false).unwrap();
    assert_eq!(st, 200, "{body}\n{:?}", log.lock().unwrap());
    let want = predict(PROMPT, 4);
    assert!(
        body.contains(&format!("\"tokens\":{want:?}")),
        "{body} want {want:?}"
    );
    assert!(body.contains("\"n_vocab\":152000"), "{body}");
    // a second generation starts from a clear sequence (the first request's context was dropped with its Store)
    let (st, body2) = get(&mut c, "/?graph=mock-1&steps=4", true).unwrap();
    assert_eq!(st, 200);
    assert!(body2.contains(&format!("\"tokens\":{want:?}")), "{body2}");
    drop(c);
    assert!(t.join().unwrap(), "the connection closed cleanly");
    assert_eq!(s.requests(), 3);
}

#[test]
fn another_graph_is_not_found_and_an_unknown_route_is_the_apps_404() {
    let s = server(0, Duration::from_secs(30), Arc::new(Mutex::new(Vec::new())));
    let (mut c, t) = connect(&s);
    let (st, body) = get(&mut c, "/?graph=other-model&steps=2", false).unwrap();
    assert_eq!(st, 500);
    assert!(body.contains("load_by_name"), "{body}");
    assert_eq!(get(&mut c, "/nope", true).map(|r| r.0), Some(404));
    drop(c);
    t.join().unwrap();
}

#[test]
fn a_request_past_its_deadline_gets_no_answer_and_the_server_keeps_serving() {
    let log = Arc::new(Mutex::new(Vec::new()));
    // every decode takes 150 ms against a 100 ms request deadline: the instance traps at its next epoch check
    let s = server(150, Duration::from_millis(100), log.clone());
    let (mut c, t) = connect(&s);
    assert_eq!(
        get(&mut c, "/?graph=mock-1&steps=8", true),
        None,
        "no response for a request that ran out of time"
    );
    drop(c);
    t.join().unwrap();
    assert!(
        log.lock()
            .unwrap()
            .iter()
            .any(|l| l.contains("request 1 failed")),
        "{:?}",
        log.lock().unwrap()
    );
    // the next connection is served (a cheap route, within the deadline)
    let (mut c, t) = connect(&s);
    assert_eq!(get(&mut c, "/ping", true).map(|r| r.0), Some(200));
    drop(c);
    t.join().unwrap();
}

#[test]
fn open_refuses_a_wrong_digest_and_an_app_whose_imports_are_not_served() {
    let (b, d) = bundle();
    let mut bad = d;
    bad[0] ^= 1;
    let e = HttpServer::open(&b, &bad, 256 << 20, Duration::from_secs(1), None, None)
        .err()
        .unwrap();
    assert!(format!("{e:#}").contains("refusing to compile"), "{e:#}");
    // ggml-probe imports wasi:nn: without a model it is refused at open, before any request
    let e = HttpServer::open(&b, &d, 256 << 20, Duration::from_secs(1), None, None)
        .err()
        .unwrap();
    assert!(format!("{e:#}").contains("wasi:nn"), "{e:#}");
    // a CLI component is not an HTTP app
    let hello = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../conformance/bundles/hello-v1.wasm"),
    )
    .unwrap();
    use sha2::Digest;
    let hd: [u8; 32] = sha2::Sha256::digest(&hello).into();
    assert!(HttpServer::open(&hello, &hd, 256 << 20, Duration::from_secs(1), None, None).is_err());
}
