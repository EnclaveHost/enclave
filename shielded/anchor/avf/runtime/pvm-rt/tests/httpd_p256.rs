// The marketplace host's TLS (src/httpd.rs `with_tls_p256`, PVM-CPU.md "Serving buyers"), on the host:
//   - the P-256 key is derived from the payload's seed: the same seed gives the same key, another seed another key;
//   - its certificate request names exactly the app's name (CN = the one SAN) and carries exactly that key;
//   - a client that trusts a CA and checks the name -- a browser's check, nothing pinned -- is refused while the
//     certificate is self-signed, and served once the CA's chain for the request is installed;
//   - a chain for any other key, garbage, or too many certificates is refused, and the current certificate stays;
//   - the two evidence paths are answered by the payload's hook, never by the app;
//   - connections are served at the same time, and an idle connection is closed.
// This file plays the public CA (rcgen) and the browser (rustls with a root store).
use pvm_rt::httpd::{p256_key, HttpServer, P256_SPKI_PREFIX};
use std::io::{Read, Write};
use std::os::fd::IntoRawFd;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::rustls;
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName};

const SEED: [u8; 32] = [9u8; 32];
const NAME: &str = "0a1b2c3d.app.enclave.host";

fn bundle() -> (Vec<u8>, [u8; 32]) {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance/bundles/cpu-probe.wasm");
    let b = std::fs::read(p).unwrap();
    use sha2::Digest;
    let d: [u8; 32] = sha2::Sha256::digest(&b).into();
    (b, d)
}

fn open() -> HttpServer {
    let (b, d) = bundle();
    HttpServer::open(&b, &d, 256 << 20, Duration::from_secs(30), None).unwrap()
}

fn serve(s: &Arc<HttpServer>) -> (UnixStream, std::thread::JoinHandle<bool>) {
    let (client, srv_end) = UnixStream::pair().unwrap();
    let s = s.clone();
    let fd = srv_end.into_raw_fd();
    (client, std::thread::spawn(move || unsafe { s.serve_fd(fd) }.is_ok()))
}

/// The CA: a self-signed root that signs whatever request it is given (here, the VM's).
struct Ca {
    cert: rcgen::Certificate,
    key: rcgen::KeyPair,
}
impl Ca {
    fn new() -> Ca {
        let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let mut p = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        p.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        p.distinguished_name.push(rcgen::DnType::CommonName, "test root");
        let cert = p.self_signed(&key).unwrap();
        Ca { cert, key }
    }
    /// Sign the request: (the leaf PEM, the request's CN, its SANs, its SPKI DER).
    fn sign(&self, csr_der: &[u8]) -> (String, String, Vec<String>, Vec<u8>) {
        let req = rcgen::CertificateSigningRequestParams::from_der(&csr_der.to_vec().into()).unwrap();
        let cn = match req.params.distinguished_name.get(&rcgen::DnType::CommonName) {
            Some(rcgen::DnValue::Utf8String(s)) => s.clone(),
            Some(rcgen::DnValue::PrintableString(s)) => s.as_str().to_string(),
            other => panic!("unexpected CN {other:?}"),
        };
        let sans = req.params.subject_alt_names.iter().map(|s| match s {
            rcgen::SanType::DnsName(n) => n.as_str().to_string(),
            other => panic!("unexpected SAN {other:?}"),
        }).collect();
        let spki = rcgen::PublicKeyData::subject_public_key_info(&req.public_key);
        let params = self.cert_params();
        let issuer = rcgen::Issuer::from_params(&params, &self.key);
        let leaf = req.signed_by(&issuer).unwrap();
        (leaf.pem(), cn, sans, spki)
    }
    fn cert_params(&self) -> rcgen::CertificateParams {
        let mut p = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        p.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        p.distinguished_name.push(rcgen::DnType::CommonName, "test root");
        p
    }
}

/// GET `path` as a browser would: the CA's root trusted, `name` checked against the certificate. Err on any failure.
fn get_trusting(stream: UnixStream, root: &CertificateDer<'static>, name: &str, path: &str) -> Result<String, String> {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        stream.set_nonblocking(true).unwrap();
        let s = tokio::net::UnixStream::from_std(stream).unwrap();
        let mut roots = rustls::RootCertStore::empty();
        roots.add(root.clone()).unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut cfg = rustls::ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        let mut tls = tokio_rustls::TlsConnector::from(Arc::new(cfg))
            .connect(ServerName::try_from(name.to_string()).unwrap(), s)
            .await
            .map_err(|e| format!("handshake: {e}"))?;
        tls.write_all(format!("GET {path} HTTP/1.1\r\nHost: {name}\r\nConnection: close\r\n\r\n").as_bytes())
            .await
            .map_err(|e| format!("write: {e}"))?;
        let mut out = Vec::new();
        tokio::time::timeout(Duration::from_secs(20), tls.read_to_end(&mut out))
            .await
            .map_err(|_| "read timed out".to_string())?
            .map_err(|e| format!("read: {e}"))?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    })
}

#[test]
fn the_p256_key_is_derived_from_the_seed() {
    let a = p256_key(&SEED).unwrap();
    let b = p256_key(&SEED).unwrap();
    let c = p256_key(&[10u8; 32]).unwrap();
    assert_eq!(a.spki, b.spki, "the same seed gives the same key");
    assert_ne!(a.spki, c.spki, "another seed gives another key");
    assert_eq!(a.spki.len(), 91);
    assert_eq!(&a.spki[..26], &P256_SPKI_PREFIX);
    assert_eq!(a.spki[26], 0x04, "an uncompressed point");
    // the server built over the seed presents that key
    let s = open().with_tls_p256(&SEED).unwrap();
    assert_eq!(s.tls_spki.as_deref(), Some(a.spki.as_slice()));
}

#[test]
fn a_browser_trusting_the_ca_is_served_once_the_chain_for_the_vms_request_is_installed() {
    let s = Arc::new(open().with_tls_p256(&SEED).unwrap());
    let spki = s.tls_spki.clone().unwrap();
    let ca = Ca::new();
    let root = ca.cert.der().clone();
    // self-signed: a browser refuses before a byte of HTTP
    let (c, t) = serve(&s);
    let e = get_trusting(c, &root, NAME, "/ping").unwrap_err();
    assert!(e.starts_with("handshake"), "{e}");
    let _ = t.join();
    assert_eq!(s.requests(), 0);
    // the request names exactly NAME (CN = the one SAN) and carries exactly the server's key
    let csr = s.csr(NAME).unwrap();
    let (leaf, cn, sans, req_spki) = ca.sign(&csr);
    assert_eq!(cn, NAME);
    assert_eq!(sans, vec![NAME.to_string()]);
    assert_eq!(req_spki, spki, "the request is for the server's own key");
    let chain = format!("{leaf}{}", ca.cert.pem());
    assert_eq!(s.set_chain(chain.as_bytes()).unwrap(), 2);
    // installed while serving: the next handshake presents it, and the browser is served
    let (c, t) = serve(&s);
    let r = get_trusting(c, &root, NAME, "/ping").unwrap();
    assert!(r.starts_with("HTTP/1.1 200") && r.contains("{\"ok\":true}"), "{r}");
    assert!(t.join().unwrap());
    // the name is checked: the same chain does not serve another name
    let (c, t) = serve(&s);
    let e = get_trusting(c, &root, "other.app.enclave.host", "/ping").unwrap_err();
    assert!(e.starts_with("handshake"), "{e}");
    let _ = t.join();
    assert_eq!(s.requests(), 1);
}

#[test]
fn a_chain_for_another_key_garbage_or_too_many_certificates_is_refused_and_the_current_one_stays() {
    let s = Arc::new(open().with_tls_p256(&SEED).unwrap());
    let ca = Ca::new();
    let root = ca.cert.der().clone();
    let (leaf, ..) = ca.sign(&s.csr(NAME).unwrap());
    s.set_chain(format!("{leaf}{}", ca.cert.pem()).as_bytes()).unwrap();
    // another key's request, signed by the same CA: a valid chain, for a key this server does not hold
    let other = Arc::new(open().with_tls_p256(&[11u8; 32]).unwrap());
    let (foreign, ..) = ca.sign(&other.csr(NAME).unwrap());
    let e = s.set_chain(format!("{foreign}{}", ca.cert.pem()).as_bytes()).unwrap_err();
    assert!(format!("{e:#}").contains("not for this server's key"), "{e:#}");
    assert!(s.set_chain(b"not pem at all").is_err());
    assert!(s.set_chain(b"").is_err(), "no certificate");
    let six = format!("{leaf}").repeat(6);
    assert!(format!("{:#}", s.set_chain(six.as_bytes()).unwrap_err()).contains("more than 5"));
    assert!(s.set_chain(&vec![b'a'; (32 << 10) + 1]).is_err(), "over the size bound");
    // the installed chain still serves
    let (c, t) = serve(&s);
    let r = get_trusting(c, &root, NAME, "/ping").unwrap();
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    assert!(t.join().unwrap());
    // a request for a name that is not a lowercase DNS name is refused; an Ed25519 server makes none
    assert!(s.csr("UPPER.app.enclave.host").is_err());
    assert!(s.csr("nodots").is_err());
    assert!(s.csr("-bad.app.enclave.host").is_err());
    assert!(open().with_tls(&SEED).unwrap().csr(NAME).is_err());
}

/// Plain HTTP on a socketpair: (status, body) of one GET, Connection: close.
fn get_plain(c: &mut UnixStream, path: &str) -> (u16, String) {
    c.write_all(format!("GET {path} HTTP/1.1\r\nHost: app\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
    let mut out = Vec::new();
    c.read_to_end(&mut out).unwrap();
    let t = String::from_utf8_lossy(&out).into_owned();
    let status = t.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    (status, t.split("\r\n\r\n").nth(1).unwrap_or("").to_string())
}

#[test]
fn the_evidence_paths_are_answered_by_the_payloads_hook_never_by_the_app() {
    let asked = Arc::new(Mutex::new(Vec::<[u8; 32]>::new()));
    let s = Arc::new(open());
    // no hook: the paths are the app's (cpu-probe has no such route: its 404)
    let (mut c, t) = serve(&s);
    assert_eq!(get_plain(&mut c, "/.well-known/enclave-ready").0, 404);
    t.join().unwrap();
    assert_eq!(s.requests(), 1);
    let a = asked.clone();
    assert!(s.set_attest(Arc::new(move |n: [u8; 32]| {
        a.lock().unwrap().push(n);
        if n[0] == 0xee { Err("attestation busy".into()) } else { Ok(format!("{{\"nonce\":\"{:02x}\"}}", n[0]).into_bytes()) }
    })));
    assert!(!s.set_attest(Arc::new(|_| Ok(vec![]))), "set once");
    let nonce = format!("ab{}", "00".repeat(31));
    let (mut c, t) = serve(&s);
    let (st, body) = get_plain(&mut c, &format!("/.well-known/enclave-attestation?nonce={nonce}"));
    assert_eq!((st, body.as_str()), (200, "{\"nonce\":\"ab\"}"));
    t.join().unwrap();
    let (mut c, t) = serve(&s);
    let (st, body) = get_plain(&mut c, &format!("/.well-known/enclave-attestation?nonce=ee{}", "00".repeat(31)));
    assert_eq!((st, body.as_str()), (503, "{\"error\":\"attestation busy\"}"));
    t.join().unwrap();
    for bad in ["", "?nonce=AB", "?nonce=abc", &format!("?nonce={}", "0".repeat(65))] {
        let (mut c, t) = serve(&s);
        assert_eq!(get_plain(&mut c, &format!("/.well-known/enclave-attestation{bad}")).0, 400, "{bad}");
        t.join().unwrap();
    }
    let (mut c, t) = serve(&s);
    assert_eq!(get_plain(&mut c, "/.well-known/enclave-ready"), (200, "{\"ok\":true}".to_string()));
    t.join().unwrap();
    assert_eq!(asked.lock().unwrap().len(), 2, "the hook ran once per well-formed nonce");
    assert_eq!(s.requests(), 1, "the app saw none of the evidence requests");
    // every other path is still the app's
    let (mut c, t) = serve(&s);
    assert_eq!(get_plain(&mut c, "/ping").0, 200);
    t.join().unwrap();
    assert_eq!(s.requests(), 2);
}

#[test]
fn connections_are_served_at_the_same_time() {
    let s = Arc::new(open());
    // A: a few seconds of CPU work, streamed
    let (mut a, ta) = serve(&s);
    a.write_all(b"GET /?steps=64&work=3000000 HTTP/1.1\r\nHost: app\r\nConnection: close\r\n\r\n").unwrap();
    std::thread::sleep(Duration::from_millis(300));
    // B, meanwhile, on another connection: answered while A still computes
    let t0 = Instant::now();
    let (mut b, tb) = serve(&s);
    assert_eq!(get_plain(&mut b, "/ping").0, 200);
    let b_ms = t0.elapsed();
    assert!(tb.join().unwrap());
    assert!(!ta.is_finished(), "A is still running: B did not wait for it ({b_ms:?})");
    assert!(b_ms < Duration::from_secs(2), "B was answered at once, not after A ({b_ms:?})");
    let mut rest = Vec::new();
    a.read_to_end(&mut rest).unwrap();
    assert!(String::from_utf8_lossy(&rest).contains("\"done\":true"));
    assert!(ta.join().unwrap());
}

#[test]
fn an_idle_connection_is_closed_and_a_computing_one_is_not() {
    let s = Arc::new(open().with_idle_close(Duration::from_secs(2)));
    // keep-alive, then silence: the server closes it after ~2 s
    let (mut c, t) = serve(&s);
    c.write_all(b"GET /ping HTTP/1.1\r\nHost: app\r\n\r\n").unwrap();
    let t0 = Instant::now();
    c.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut out = Vec::new();
    c.read_to_end(&mut out).unwrap(); // the response, then EOF when the server closes
    let waited = t0.elapsed();
    assert!(String::from_utf8_lossy(&out).contains("{\"ok\":true}"));
    assert!(waited >= Duration::from_secs(2) && waited < Duration::from_secs(5), "closed after {waited:?}");
    assert!(t.join().unwrap());
    // a request computing longer than the idle bound with nothing written meanwhile (one step: cpu-probe writes its head,
    // then nothing until the step's work is done, ~100 ms here) is not cut
    let s = Arc::new(open().with_idle_close(Duration::from_millis(30)));
    let (mut c, t) = serve(&s);
    let t0 = Instant::now();
    let (st, body) = get_plain(&mut c, "/?steps=1&work=1000000");
    let took = t0.elapsed();
    assert_eq!(st, 200, "{body}");
    assert!(body.contains("\"done\":true"), "{body}");
    assert!(took > Duration::from_millis(60), "the step must outlast the idle bound for this to test anything ({took:?})");
    assert!(t.join().unwrap());
}
