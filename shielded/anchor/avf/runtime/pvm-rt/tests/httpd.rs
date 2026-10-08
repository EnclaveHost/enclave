// wasi:http in the portable runtime (src/httpd.rs), on the host: the CPU-only tier's conformance app (conformance/cpu-probe,
// bundles/cpu-probe.wasm) -- a wasi:http component with no wasi:nn -- served on one end of a socketpair, the way the payload
// serves a vsock connection. Its values are an FNV-1a chain computed in the component, which this file predicts exactly.
// The model-backed ggml-probe (it imports wasi:nn) is refused at open: the pVM CPU tier carries no model.
use pvm_rt::httpd::HttpServer;
use std::io::{Read, Write};
use std::os::fd::IntoRawFd;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
/// cpu-probe's `work`: w rounds of FNV-1a over the running value's 8 little-endian bytes
fn work(mut v: u64, rounds: u32) -> u64 {
    for _ in 0..rounds {
        let mut h = FNV_OFFSET;
        for b in v.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(FNV_PRIME);
        }
        v = h;
    }
    v
}
/// the values cpu-probe streams for (steps, rounds)
fn predict(steps: usize, rounds: u32) -> Vec<String> {
    let mut v = FNV_OFFSET;
    (0..steps).map(|_| { v = work(v, rounds); format!("{v:016x}") }).collect()
}
/// the "v" of each step line, in order
fn values(body: &str) -> Vec<String> {
    body.lines().filter(|l| l.trim_start().starts_with("{\"i\":"))
        .filter_map(|l| l.split("\"v\":\"").nth(1).map(|r| r[..16].to_string())).collect()
}

fn bundle(name: &str) -> (Vec<u8>, [u8; 32]) {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance/bundles").join(name);
    let b = std::fs::read(p).unwrap();
    use sha2::Digest;
    let d: [u8; 32] = sha2::Sha256::digest(&b).into();
    (b, d)
}

fn server(deadline: Duration, log: Arc<Mutex<Vec<String>>>) -> Arc<HttpServer> {
    let (b, d) = bundle("cpu-probe.wasm");
    Arc::new(
        HttpServer::open(
            &b,
            &d,
            256 << 20,
            deadline,
            Some(Box::new(move |s: &[u8]| log.lock().unwrap().push(String::from_utf8_lossy(s).into_owned()))),
        )
        .unwrap(),
    )
}

/// Serves one connection in a thread; returns the client end.
fn connect(s: &Arc<HttpServer>) -> (UnixStream, std::thread::JoinHandle<bool>) {
    let (client, srv_end) = UnixStream::pair().unwrap();
    let s = s.clone();
    let fd = srv_end.into_raw_fd();
    (client, std::thread::spawn(move || unsafe { s.serve_fd(fd) }.is_ok()))
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
    c.write_all(format!("GET {path} HTTP/1.1\r\nHost: app\r\n{conn}\r\n").as_bytes()).ok()?;
    read_response(c)
}

#[test]
fn a_first_party_http_app_runs_unchanged_and_streams_exactly_the_predicted_cpu_work() {
    let log = Arc::new(Mutex::new(Vec::new()));
    let s = server(Duration::from_secs(30), log.clone());
    let (mut c, t) = connect(&s);
    // keep-alive: three requests on one connection, each in a fresh instance
    let (st, ping) = get(&mut c, "/ping", false).unwrap();
    assert_eq!((st, ping.trim_end()), (200, "{\"ok\":true}"));
    let (st, body) = get(&mut c, "/?steps=4&work=1000", false).unwrap();
    assert_eq!(st, 200, "{body}\n{:?}", log.lock().unwrap());
    let want = predict(4, 1000);
    assert_eq!(values(&body), want, "{body}");
    assert!(body.lines().next().unwrap().starts_with("{\"probe\":\"cpu\",\"steps\":4,\"work\":1000}"), "{body}");
    assert!(body.lines().all(|l| l.len() == 127), "every line is padded to the same width: {body:?}");
    assert!(body.contains(&format!("\"done\":true,\"steps\":4")) && body.contains(&format!("\"v\":\"{}\"}}", want[3])), "{body}");
    // a second run computes the same values from a fresh instance (nothing kept across requests)
    let (st, body2) = get(&mut c, "/?steps=4&work=1000", true).unwrap();
    assert_eq!(st, 200);
    assert_eq!(values(&body2), want, "{body2}");
    drop(c);
    assert!(t.join().unwrap(), "the connection closed cleanly");
    assert_eq!(s.requests(), 3);
}

#[test]
fn an_unknown_route_is_the_apps_404() {
    let s = server(Duration::from_secs(30), Arc::new(Mutex::new(Vec::new())));
    let (mut c, t) = connect(&s);
    assert_eq!(get(&mut c, "/nope", true).map(|r| r.0), Some(404));
    drop(c);
    t.join().unwrap();
}

#[test]
fn a_request_past_its_deadline_gets_no_answer_and_the_server_keeps_serving() {
    let log = Arc::new(Mutex::new(Vec::new()));
    // 256 steps of a million rounds each cannot finish in 100 ms: the instance traps at its next epoch check
    let s = server(Duration::from_millis(100), log.clone());
    let (mut c, t) = connect(&s);
    // cpu-probe sends its head before the work, so the trap comes after the response began: the body must END WITH AN
    // ERROR (no last chunk), never cleanly -- a clean end would make the truncated answer read as complete
    assert_eq!(get(&mut c, "/?steps=256&work=1000000", true), None, "a request that ran out of time never completes");
    drop(c);
    t.join().unwrap();
    assert!(log.lock().unwrap().iter().any(|l| l.contains("request 1 failed after its response began")), "{:?}", log.lock().unwrap());
    // the next connection is served (a cheap route, within the deadline)
    let (mut c, t) = connect(&s);
    assert_eq!(get(&mut c, "/ping", true).map(|r| r.0), Some(200));
    drop(c);
    t.join().unwrap();
}

#[test]
fn open_refuses_a_wrong_digest_a_model_importing_app_and_a_cli_component() {
    let (b, d) = bundle("cpu-probe.wasm");
    let mut bad = d;
    bad[0] ^= 1;
    let e = HttpServer::open(&b, &bad, 256 << 20, Duration::from_secs(1), None).err().unwrap();
    assert!(format!("{e:#}").contains("refusing to compile"), "{e:#}");
    // ggml-probe imports wasi:nn: this runtime links no model interface at all, so it is refused at open, before any request
    let (g, gd) = bundle("ggml-probe.wasm");
    let e = HttpServer::open(&g, &gd, 256 << 20, Duration::from_secs(1), None).err().unwrap();
    assert!(format!("{e:#}").contains("wasi:nn"), "{e:#}");
    // a CLI component is not an HTTP app
    let (h, hd) = bundle("hello-v1.wasm");
    assert!(HttpServer::open(&h, &hd, 256 << 20, Duration::from_secs(1), None).is_err());
}
