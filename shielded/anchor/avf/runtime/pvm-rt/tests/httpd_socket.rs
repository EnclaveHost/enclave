// Socket-server apps (src/httpd.rs `open_socket_app`; PVM-CPU.md "Serving buyers"), on the host: sock-probe -- a wasi:cli/run
// component that binds the port ENCLAVE_PORTS names, the shape of the catalog's port-serving apps -- runs as ONE long-lived
// instance listening on loopback, and every connection `serve_fd` takes is fronted (TLS when configured) and proxied to it:
//   - it answers through the front, and its state persists across requests and connections (one instance);
//   - it is told the platform's contract (ENCLAVE_PORTS logical=actual, ENCLAVE_MEM_MB);
//   - it cannot dial out (no outbound connect, not even to loopback) or listen elsewhere: only its own port;
//   - the evidence paths are answered by the payload's hook, never proxied; a request body streams through;
//   - over TLS with the P-256 key a pinned client is served;
//   - a component that is not a command does not start, and says why.
use pvm_rt::httpd::HttpServer;
use std::io::{Read, Write};
use std::os::fd::IntoRawFd;
use std::os::unix::net::UnixStream;
use std::sync::Arc;
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
fn open(port: u16) -> Arc<HttpServer> {
    let (b, d) = bundle("sock-probe.wasm");
    Arc::new(HttpServer::open_socket_app(&b, &d, 128 << 20, port, None, Some(Box::new(|l: &[u8]| eprintln!("LOG {}", String::from_utf8_lossy(l))))).unwrap())
}
fn serve(s: &Arc<HttpServer>) -> (UnixStream, std::thread::JoinHandle<bool>) {
    let (client, srv_end) = UnixStream::pair().unwrap();
    let s = s.clone();
    let fd = srv_end.into_raw_fd();
    (client, std::thread::spawn(move || unsafe { s.serve_fd(fd) }.is_ok()))
}
/// One request, Connection: close: (status, body).
fn req(s: &Arc<HttpServer>, method: &str, path: &str, body: &[u8]) -> (u16, String) {
    let (mut c, t) = serve(s);
    c.write_all(format!("{method} {path} HTTP/1.1\r\nHost: app\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).unwrap();
    c.write_all(body).unwrap();
    c.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    let mut out = Vec::new();
    c.read_to_end(&mut out).unwrap();
    t.join().unwrap();
    let text = String::from_utf8_lossy(&out).into_owned();
    let status = text.split_whitespace().nth(1).and_then(|x| x.parse().ok()).unwrap_or(0);
    let body = text.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
    (status, body)
}

#[test]
fn a_socket_app_is_served_through_the_front_and_keeps_its_state() {
    let port = free_port();
    let s = open(port);
    assert_eq!(req(&s, "GET", "/ping", b""), (200, "{\"ok\":true}".to_string()));
    let (_, a) = req(&s, "GET", "/count", b"");
    let (_, b) = req(&s, "GET", "/count", b"");
    let n = |x: &str| x.trim_start_matches("{\"count\":").trim_end_matches('}').parse::<u64>().unwrap();
    assert_eq!(n(&b), n(&a) + 1, "one instance: its count goes on across connections ({a} then {b})");
    assert_eq!(req(&s, "GET", "/env", b"").1, format!("{{\"ports\":\"http:{port}={port}\",\"mem\":\"128\"}}"), "the platform's contract");
    assert_eq!(req(&s, "POST", "/echo", b"a body that streams through").1, "a body that streams through");
    assert_eq!(req(&s, "GET", "/nope", b"").0, 404, "the app's own 404");
    assert!(s.requests() >= 6);
    assert_eq!(s.socket_exited(), None);
}

#[test]
fn a_socket_app_cannot_dial_out() {
    let s = open(free_port());
    // an off-box address and another loopback port (a listener on this host): both refused by the address check
    let other = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let local = other.local_addr().unwrap();
    let r = req(&s, "GET", "/dial?to=1.1.1.1:443", b"");
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(r.1, "{\"dial\":\"refused\"}", "exited: {:?}", s.socket_exited());
    assert_eq!(req(&s, "GET", &format!("/dial?to={local}"), b"").1, "{\"dial\":\"refused\"}");
    // and it listens only on its own port: another one is refused
    assert_eq!(req(&s, "GET", &format!("/bind?port={}", free_port()), b"").1, "{\"bind\":\"refused\"}");
}

#[test]
fn the_evidence_paths_are_the_hooks_and_tls_fronts_the_app() {
    let s = {
        let (b, d) = bundle("sock-probe.wasm");
        Arc::new(HttpServer::open_socket_app(&b, &d, 128 << 20, free_port(), None, None).unwrap().with_tls_p256(&[5u8; 32]).unwrap())
    };
    assert!(s.set_attest(Arc::new(|n: [u8; 32]| Ok(format!("{{\"n\":\"{:02x}\"}}", n[0]).into_bytes()))));
    // plaintext to a TLS front gets no HTTP
    let (mut c, t) = serve(&s);
    c.write_all(b"GET /ping HTTP/1.1\r\nHost: app\r\nConnection: close\r\n\r\n").unwrap();
    c.set_read_timeout(Some(Duration::from_secs(25))).unwrap();
    let mut out = Vec::new();
    let _ = c.read_to_end(&mut out);
    assert!(!String::from_utf8_lossy(&out).contains("HTTP/1.1"));
    let _ = t.join();
    // a client pinning the P-256 key: the app's answer, and the hook's evidence (not the app's)
    let spki = s.tls_spki.clone().unwrap();
    let get = |path: &str| {
        let (client, t) = serve(&s);
        let r = tls_get(client, &spki, path);
        let _ = t.join();
        r
    };
    assert!(get("/ping").contains("{\"ok\":true}"));
    assert!(get(&format!("/.well-known/enclave-attestation?nonce=7a{}", "00".repeat(31))).ends_with("{\"n\":\"7a\"}"));
    assert!(get("/.well-known/enclave-ready").ends_with("{\"ok\":true}"));
}

#[test]
fn a_component_that_is_not_a_command_does_not_start() {
    let (b, d) = bundle("cpu-probe.wasm"); // a wasi:http component: no wasi:cli/run
    let e = HttpServer::open_socket_app(&b, &d, 64 << 20, free_port(), None, None).err().expect("refused");
    assert!(format!("{e:#}").contains("the app did not start"), "{e:#}");
}

/// GET over TLS pinning `spki` (the test's own minimal pinning verifier, as in httpd_tls.rs).
fn tls_get(stream: UnixStream, spki: &[u8], path: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio_rustls::rustls;
    use tokio_rustls::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    #[derive(Debug)]
    struct Pin(Vec<u8>, Arc<rustls::crypto::CryptoProvider>);
    impl ServerCertVerifier for Pin {
        fn verify_server_cert(&self, ee: &CertificateDer<'_>, _: &[CertificateDer<'_>], _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
            if ee.as_ref().windows(self.0.len()).any(|w| w == self.0.as_slice()) { Ok(ServerCertVerified::assertion()) } else { Err(rustls::Error::General("key".into())) }
        }
        fn verify_tls12_signature(&self, _: &[u8], _: &CertificateDer<'_>, _: &rustls::DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> { Err(rustls::Error::General("tls12".into())) }
        fn verify_tls13_signature(&self, m: &[u8], c: &CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls13_signature(m, c, d, &self.1.signature_verification_algorithms)
        }
        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> { self.1.signature_verification_algorithms.supported_schemes() }
    }
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        stream.set_nonblocking(true).unwrap();
        let s = tokio::net::UnixStream::from_std(stream).unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut cfg = rustls::ClientConfig::builder_with_provider(provider.clone()).with_protocol_versions(&[&rustls::version::TLS13]).unwrap()
            .dangerous().with_custom_certificate_verifier(Arc::new(Pin(spki.to_vec(), provider))).with_no_client_auth();
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        let mut tls = tokio_rustls::TlsConnector::from(Arc::new(cfg)).connect(ServerName::try_from("app.test").unwrap(), s).await.unwrap();
        tls.write_all(format!("GET {path} HTTP/1.1\r\nHost: app\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut out = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(20), tls.read_to_end(&mut out)).await;
        String::from_utf8_lossy(&out).into_owned()
    })
}
