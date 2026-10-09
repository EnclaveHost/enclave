// What a deployment gives its app beyond the component (httpd.rs AppOptions; PVM-CPU.md "Serving buyers", "Egress"), on the
// host, through real components (conformance/sock-probe: a socket app; conformance/egress-probe: a wasi:http app):
//   - the environment: the deployment's config, hostnames and secrets reach both kinds of app; the runtime's own variables
//     and malformed names are refused before an app starts;
//   - egress: an outbound connect, a name lookup and an outgoing request are the HOST's to open (the test plays the host:
//     it records what it was asked and opens a local stream); a loopback address is never asked for; https is verified IN
//     the runtime against the public roots (a host that answers with its own certificate fails); without egress, all refused;
//   - the owner's protection rules (waf.rs), answered exactly as the platform answers them.
use pvm_rt::egress::Egress;
use pvm_rt::httpd::{AppOptions, HttpServer};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::IntoRawFd;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn bundle(name: &str) -> (Vec<u8>, [u8; 32]) {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance/bundles").join(name);
    let b = std::fs::read(p).unwrap();
    use sha2::Digest;
    let d: [u8; 32] = sha2::Sha256::digest(&b).into();
    (b, d)
}
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}
fn socket_app(o: AppOptions) -> Arc<HttpServer> {
    let (b, d) = bundle("sock-probe.wasm");
    Arc::new(HttpServer::open_socket_app(&b, &d, 128 << 20, free_port(), None, o, None).unwrap())
}
fn http_app(o: AppOptions) -> Arc<HttpServer> {
    let (b, d) = bundle("egress-probe.wasm");
    Arc::new(HttpServer::open(&b, &d, 64 << 20, Duration::from_secs(30), None).unwrap().with_app_options(o).unwrap())
}
/// One request (Connection: close): (status, headers, body).
fn req(s: &Arc<HttpServer>, head: &str, body: &[u8]) -> (u16, String, String) {
    let (mut c, srv_end) = UnixStream::pair().unwrap();
    let s2 = s.clone();
    let fd = srv_end.into_raw_fd();
    let t = std::thread::spawn(move || unsafe { s2.serve_fd(fd) }.is_ok());
    c.write_all(head.as_bytes()).unwrap();
    c.write_all(body).unwrap();
    c.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    let mut out = Vec::new();
    let _ = c.read_to_end(&mut out);
    let _ = t.join();
    let text = String::from_utf8_lossy(&out).into_owned();
    let status = text.split_whitespace().nth(1).and_then(|x| x.parse().ok()).unwrap_or(0);
    let (h, b) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let h = h.to_ascii_lowercase();
    let b = if h.contains("transfer-encoding: chunked") { dechunk(b) } else { b.to_string() };
    (status, h, b)
}
fn dechunk(mut b: &str) -> String {
    let mut out = String::new();
    while let Some((n, rest)) = b.split_once("\r\n") {
        let n = usize::from_str_radix(n.trim(), 16).unwrap_or(0);
        if n == 0 || rest.len() < n {
            break;
        }
        out.push_str(&rest[..n]);
        b = rest[n..].trim_start_matches("\r\n");
    }
    out
}
fn get(s: &Arc<HttpServer>, path: &str) -> (u16, String) {
    let (st, _, b) = req(s, &format!("GET {path} HTTP/1.1\r\nHost: app\r\nConnection: close\r\n\r\n"), b"");
    (st, b)
}
fn env(vars: &[(&str, &str)]) -> Vec<(String, String)> {
    vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// The test's host: records every open/resolve, resolves `svc.example` to a TEST-NET address, and opens every stream to
/// `target` (a local server) whatever it was asked for -- the VM cannot tell, which is the point: the host decides.
struct Host {
    asked: Arc<Mutex<Vec<String>>>,
    egress: Egress,
}
fn host(target: std::net::SocketAddr) -> Host {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let (a1, a2) = (asked.clone(), asked.clone());
    let egress = Egress::new(
        Arc::new(move |h: &str, p: u16| {
            a1.lock().unwrap().push(format!("open {h} {p}"));
            if h == "refused.example" {
                return Err("the host's policy refuses it".into());
            }
            Ok(std::net::TcpStream::connect(target).map_err(|e| e.to_string())?.into_raw_fd())
        }),
        Arc::new(move |n: &str| {
            a2.lock().unwrap().push(format!("resolve {n}"));
            if n == "svc.example" { Ok(vec!["203.0.113.7".parse().unwrap()]) } else { Err("NXDOMAIN".into()) }
        }),
    );
    Host { asked, egress }
}
/// A line server: answers each connection's first line with "pong <line>".
fn line_server() -> std::net::SocketAddr {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let a = l.local_addr().unwrap();
    std::thread::spawn(move || {
        for c in l.incoming().flatten() {
            let mut line = String::new();
            let _ = BufReader::new(&c).read_line(&mut line);
            let _ = (&c).write_all(format!("pong {}", line).as_bytes());
        }
    });
    a
}
/// An HTTP/1.1 server answering every request "hello <path>".
fn http_server() -> std::net::SocketAddr {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let a = l.local_addr().unwrap();
    std::thread::spawn(move || {
        for c in l.incoming().flatten() {
            let mut r = BufReader::new(&c);
            let mut first = String::new();
            let _ = r.read_line(&mut first);
            loop {
                let mut h = String::new();
                if r.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                    break;
                }
            }
            let body = format!("hello {}", first.split_whitespace().nth(1).unwrap_or("?"));
            let _ = (&c).write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes());
        }
    });
    a
}

/// A TLS server for svc.example with a self-signed certificate, answering "hello" to whoever completes a handshake.
fn impostor_tls() -> std::net::SocketAddr {
    use tokio_rustls::rustls;
    let ck = rcgen::generate_simple_self_signed(vec!["svc.example".to_string()]).unwrap();
    let cert = rustls::pki_types::CertificateDer::from(ck.cert.der().to_vec());
    let key = rustls::pki_types::PrivateKeyDer::try_from(ck.signing_key.serialize_der()).unwrap();
    let cfg = Arc::new(
        rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![cert], key)
            .unwrap(),
    );
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let a = l.local_addr().unwrap();
    std::thread::spawn(move || {
        for mut c in l.incoming().flatten() {
            let mut conn = rustls::ServerConnection::new(cfg.clone()).unwrap();
            let mut tls = rustls::Stream::new(&mut conn, &mut c);
            let _ = tls.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\nconnection: close\r\n\r\nhello");
        }
    });
    a
}

#[test]
fn the_environment_reaches_both_kinds_of_app() {
    let cfg = r#"{"endpoint":"https://s3.example","bucket":"notes"}"#;
    let vars = env(&[("ENCLAVE_CONFIG", cfg), ("ENCLAVE_HOSTS", "0a1b2c3d.app.enclave.host"), ("API_TOKEN", "t0k3n")]);
    let s = socket_app(AppOptions { env: vars.clone(), ..Default::default() });
    assert_eq!(get(&s, "/env?name=ENCLAVE_CONFIG").1, format!("{{\"name\":\"ENCLAVE_CONFIG\",\"value\":{}}}", serde_str(cfg)));
    assert_eq!(get(&s, "/env?name=API_TOKEN").1, "{\"name\":\"API_TOKEN\",\"value\":\"t0k3n\"}");
    assert!(get(&s, "/env").1.contains("\"mem\":\"128\""), "the runtime's own variables are still there");
    let h = http_app(AppOptions { env: vars, ..Default::default() });
    assert_eq!(get(&h, "/env?name=ENCLAVE_HOSTS").1, "{\"name\":\"ENCLAVE_HOSTS\",\"value\":\"0a1b2c3d.app.enclave.host\"}");
    assert_eq!(get(&h, "/env?name=NOPE").1, "{\"name\":\"NOPE\",\"value\":null}");
}
fn serde_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[test]
fn the_environment_block_is_checked_before_an_app_starts() {
    use pvm_rt::parse_env;
    assert_eq!(parse_env(b"A=1\0B=two words\0\0").unwrap(), env(&[("A", "1"), ("B", "two words")]));
    assert_eq!(parse_env(b"ENCLAVE_CONFIG={\"a\":\"b=c\"}\0").unwrap(), env(&[("ENCLAVE_CONFIG", "{\"a\":\"b=c\"}")]));
    for (bad, why) in [
        (&b"ENCLAVE_PORTS=http:1=1\0"[..], "runtime's own"),
        (b"ENCLAVE_MEM_MB=9999\0", "runtime's own"),
        (b"A=1\0A=2\0", "twice"),
        (b"1A=x\0", "not an environment variable name"),
        (b"A B=x\0", "not an environment variable name"),
        (b"NOEQUALS\0", "no '='"),
        (b"A=\xff\0", "not UTF-8"),
    ] {
        let e = parse_env(bad).unwrap_err();
        assert!(e.contains(why), "{:?}: {e}", String::from_utf8_lossy(bad));
    }
    let many: Vec<u8> = (0..200).flat_map(|i| format!("V{i}=x\0").into_bytes()).collect();
    assert!(parse_env(&many).unwrap_err().contains("more than"));
    assert!(parse_env(&vec![b'A'; 300 << 10]).unwrap_err().contains("bytes"));
}

#[test]
fn a_socket_app_reaches_out_only_through_the_host() {
    let target = line_server();
    let h = host(target);
    let s = socket_app(AppOptions { egress: Some(h.egress.clone()), ..Default::default() });
    // a name: resolved by the host, then the address it gave is what the host is asked to open
    assert_eq!(get(&s, "/resolve?name=svc.example").1, "{\"addrs\":[\"203.0.113.7\"]}");
    assert_eq!(get(&s, "/dial?to=svc.example:7000").1, "{\"dial\":\"connected\",\"reply\":\"pong ping\"}");
    assert_eq!(get(&s, "/resolve?name=nx.example").1, "{\"addrs\":null}", "the host's NXDOMAIN");
    // a loopback address is never asked for: there is nothing in the VM to reach
    let before = h.asked.lock().unwrap().len();
    assert_eq!(get(&s, &format!("/dial?to={target}")).1, "{\"dial\":\"refused\"}");
    assert_eq!(h.asked.lock().unwrap().len(), before, "the host was not asked: {:?}", h.asked.lock().unwrap());
    let asked = h.asked.lock().unwrap().clone();
    assert!(asked.contains(&"resolve svc.example".to_string()) && asked.contains(&"open 203.0.113.7 7000".to_string()), "{asked:?}");
    // and the app's own port is still its only listener
    assert_eq!(get(&s, &format!("/bind?port={}", free_port())).1, "{\"bind\":\"refused\"}");
    // without egress: no lookup, no connect
    let none = socket_app(AppOptions::default());
    assert_eq!(get(&none, "/resolve?name=svc.example").1, "{\"addrs\":null}");
    assert_eq!(get(&none, "/dial?to=203.0.113.7:7000").1, "{\"dial\":\"refused\"}");
}

#[test]
fn a_wasi_http_app_reaches_out_only_through_the_host_and_verifies_tls_itself() {
    let target = http_server();
    let h = host(target);
    let app = http_app(AppOptions { egress: Some(h.egress.clone()), ..Default::default() });
    assert_eq!(get(&app, "/fetch?url=http%3A%2F%2Fsvc.example%3A7001%2Fhi%3Fx%3D1").1, "{\"status\":200,\"body\":\"hello /hi?x=1\"}");
    assert!(h.asked.lock().unwrap().contains(&"open svc.example 7001".to_string()), "the host is asked for the NAME: {:?}", h.asked.lock().unwrap());
    // a host that answers https with a certificate of its own making (valid for the name, but no public CA's) fails the
    // VM's TLS: the certificate is checked here, against the public roots, never by the host
    let imp = host(impostor_tls());
    let app2 = http_app(AppOptions { egress: Some(imp.egress.clone()), ..Default::default() });
    let (_, b) = get(&app2, "/fetch?url=https%3A%2F%2Fsvc.example%2F");
    assert!(b.starts_with("{\"error\":") && b.contains("Tls") && !b.contains("hello"), "{b}");
    // a destination the host refuses is the app's error, not a hang
    let (_, b) = get(&app, "/fetch?url=http%3A%2F%2Frefused.example%2F");
    assert!(b.starts_with("{\"error\":"), "{b}");
    // without egress: the platform's refusal
    let none = http_app(AppOptions::default());
    assert!(get(&none, "/fetch?url=http%3A%2F%2Fsvc.example%2F").1.contains("HttpRequestDenied"));
}

fn waf(json: &str) -> Option<Arc<pvm_rt::waf::Waf>> {
    Some(Arc::new(pvm_rt::waf::Waf::parse(json).unwrap()))
}

#[test]
fn protection_rules_are_answered_as_the_platform_answers_them() {
    let s = socket_app(AppOptions { waf: waf(r#"{"methods":["get","POST"],"blockScanners":true,"pathBlock":["/admin"],"uaBlock":["sqlmap"],"maxBodyMb":0.001}"#), ..Default::default() });
    assert_eq!(get(&s, "/ping"), (200, "{\"ok\":true}".into()));
    let (st, _, b) = req(&s, "DELETE /ping HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n", b"");
    assert_eq!((st, b.as_str()), (405, "{\"error\":\"waf_method\",\"message\":\"This deployment's protection rules allow only: GET, POST.\"}"));
    for p in ["/.env", "/%2e%65nv", "//.git/config", "/ADMIN/x", "/wp-login.php?x=1"] {
        assert_eq!(get(&s, p), (403, "{\"error\":\"waf_path\",\"message\":\"Blocked by this deployment's protection rules.\"}".into()), "{p}");
    }
    assert_eq!(get(&s, "/administrator-not").0, 403, "a prefix, as the platform's");
    let (st, _, b) = req(&s, "GET /ping HTTP/1.1\r\nHost: a\r\nUser-Agent: SQLMap/1.7\r\nConnection: close\r\n\r\n", b"");
    assert_eq!((st, b.as_str()), (403, "{\"error\":\"waf_agent\",\"message\":\"Blocked by this deployment's protection rules.\"}"));
    // the body: a declared length over the limit, and an undeclared (chunked) one -- the second was the platform's hole once
    let big = vec![b'x'; 2000];
    let (st, _, b) = req(&s, &format!("POST /echo HTTP/1.1\r\nHost: a\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", big.len()), &big);
    assert_eq!((st, b.as_str()), (413, "{\"error\":\"waf_body\",\"message\":\"Request body exceeds this deployment's 0.001 MB limit.\"}"));
    let chunked = format!("{:x}\r\n{}\r\n0\r\n\r\n", big.len(), String::from_utf8(big.clone()).unwrap());
    let (st, h, b) = req(&s, "POST /echo HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n", chunked.as_bytes());
    assert_eq!((st, b.as_str()), (413, "{\"error\":\"waf_body\",\"message\":\"Request body exceeds the 0.001 MB limit for this deployment.\"}"));
    assert!(h.contains("content-type: application/json"));
    let small = "5\r\nhello\r\n0\r\n\r\n";
    let (st, _, b) = req(&s, "POST /echo HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n", small.as_bytes());
    assert_eq!((st, b.as_str()), (200, "hello"), "a chunked body under the limit still reaches the app");
}

#[test]
fn the_rate_and_concurrency_limits_count_one_deployment() {
    let h = http_app(AppOptions { waf: waf(r#"{"rps":0.5,"burst":2}"#), ..Default::default() });
    assert_eq!(get(&h, "/ping").0, 200);
    assert_eq!(get(&h, "/ping").0, 200);
    let (st, hd, b) = req(&h, "GET /ping HTTP/1.1\r\nHost: a\r\nX-Forwarded-For: 9.9.9.9\r\nConnection: close\r\n\r\n", b"");
    assert_eq!((st, b.as_str()), (429, "{\"error\":\"waf_rate_limited\",\"message\":\"Rate limit: this deployment allows 0.5 requests/sec per address (burst 2).\"}"),
               "a caller-written forwarded address buys no fresh bucket");
    assert!(hd.contains("retry-after: 2"), "{hd}");
    // default burst: ceil(4 * rps), at least 5
    assert_eq!(pvm_rt::waf::Waf::parse(r#"{"rps":10}"#).unwrap().rules.burst, Some(40.0));
    assert_eq!(pvm_rt::waf::Waf::parse(r#"{"rps":0.2}"#).unwrap().rules.burst, Some(5.0));
    // one slot: a second request while the first is running is refused, and the slot comes back after
    let w = pvm_rt::waf::Waf::parse(r#"{"maxConcurrent":1}"#).unwrap();
    let a = w.check("GET", "/", "", None).unwrap();
    let d = w.check("GET", "/", "", None).err().unwrap();
    assert_eq!((d.status, d.body()), (429, "{\"error\":\"waf_busy\",\"message\":\"Too many concurrent requests from your address (limit 1).\"}".to_string()));
    drop(a);
    assert!(w.check("GET", "/", "", None).is_ok());
}

#[test]
fn the_rules_are_checked_with_the_platforms_bounds() {
    use pvm_rt::waf::Waf;
    for (j, why) in [
        (r#"{}"#, "enables nothing"),
        (r#"{"rps":0}"#, "waf.rps"),
        (r#"{"rps":20000}"#, "waf.rps"),
        (r#"{"burst":5}"#, "burst needs waf.rps"),
        (r#"{"maxConcurrent":1.5}"#, "integer"),
        (r#"{"maxBodyMb":2048}"#, "waf.maxBodyMb"),
        (r#"{"methods":["G"]}"#, "not allowed"),
        (r#"{"methods":[]}"#, "array of 1..10"),
        (r#"{"pathBlock":["admin"]}"#, "not allowed"),
        (r#"{"uaBlock":["ab"]}"#, "not allowed"),
        (r#"{"blockScanners":"yes"}"#, "boolean"),
        (r#"{"geo":["US"]}"#, "unknown waf option"),
        (r#"[1]"#, "JSON object"),
    ] {
        let e = Waf::parse(j).err().unwrap_or_else(|| panic!("{j} accepted"));
        assert!(e.contains(why), "{j}: {e}");
    }
    let w = Waf::parse(r#"{"methods":["get","GET","Post"],"pathBlock":["/A","/a"]}"#).unwrap();
    assert_eq!(w.rules.methods, Some(vec!["GET".into(), "POST".into()]));
    assert_eq!(w.rules.path_block, Some(vec!["/a".into()]));
}
