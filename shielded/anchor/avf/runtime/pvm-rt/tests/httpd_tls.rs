// TLS terminating inside the VM (src/httpd.rs `with_tls`), on the host: the server key is an Ed25519 "transport key"; a
// client that pins that key (and checks the TLS 1.3 CertificateVerify signature with it) gets the app's answer; a client
// pinning another key refuses before sending a byte; plaintext HTTP gets no HTTP; one flipped byte in transit gets no
// answer. The carrier (here a socketpair or a relay thread, in the VM the phone's Android app) only ever sees ciphertext.
use pvm_rt::httpd::{HttpServer, ED25519_SPKI_PREFIX};
use pvm_rt::nn::NnEngine;
use pvm_rt::NnModel;
use std::io::{Read, Write};
use std::os::fd::IntoRawFd;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::rustls;
use tokio_rustls::rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::{DigitallySignedStruct, SignatureScheme};

struct Mock;
impl NnEngine for Mock {
    fn n_vocab(&self) -> usize {
        152_000
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
        Ok(())
    }
    fn decode(&self, _ids: &[i32], logits: &mut [f32]) -> Result<(), String> {
        logits.iter_mut().for_each(|l| *l = 0.0);
        logits[7] = 1.0;
        Ok(())
    }
}

const SEED: [u8; 32] = [7u8; 32];

fn server() -> (Arc<HttpServer>, Vec<u8>) {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../conformance/bundles/ggml-probe.wasm");
    let b = std::fs::read(p).unwrap();
    use sha2::Digest;
    let d: [u8; 32] = sha2::Sha256::digest(&b).into();
    let s = HttpServer::open(
        &b,
        &d,
        256 << 20,
        Duration::from_secs(30),
        Some(NnModel {
            name: "mock-1".into(),
            engine: Arc::new(Mock),
        }),
        None,
    )
    .unwrap()
    .with_tls(&SEED)
    .unwrap();
    let spki = s.tls_spki.clone().unwrap();
    (Arc::new(s), spki)
}

/// Serves one connection on `srv_end` in a thread.
fn serve(s: &Arc<HttpServer>, srv_end: UnixStream) -> std::thread::JoinHandle<bool> {
    let s = s.clone();
    let fd = srv_end.into_raw_fd();
    std::thread::spawn(move || unsafe { s.serve_fd(fd) }.is_ok())
}

/// The client's whole trust decision: the end-entity certificate carries exactly the pinned key, and the handshake is
/// signed by it (TLS 1.3 CertificateVerify). Names and dates are not the point: the key is.
#[derive(Debug)]
struct Pin {
    spki: Vec<u8>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}
impl ServerCertVerifier for Pin {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if end_entity
            .as_ref()
            .windows(self.spki.len())
            .any(|w| w == self.spki.as_slice())
        {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "the server's key is not the attested transport key".into(),
            ))
        }
    }
    fn verify_tls12_signature(
        &self,
        _m: &[u8],
        _c: &CertificateDer<'_>,
        _d: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.2 is not offered".into()))
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// GET `path` over TLS through `stream`, pinning `spki`. Err when the handshake or the exchange fails.
fn get_tls(stream: UnixStream, spki: &[u8], path: &str) -> Result<String, String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(async {
        stream.set_nonblocking(true).unwrap();
        let s = tokio::net::UnixStream::from_std(stream).unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut cfg = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Pin {
                spki: spki.to_vec(),
                provider,
            }))
            .with_no_client_auth();
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        let mut tls = tokio_rustls::TlsConnector::from(Arc::new(cfg))
            .connect(ServerName::try_from("pvm-app.invalid").unwrap(), s)
            .await
            .map_err(|e| format!("handshake: {e}"))?;
        tls.write_all(
            format!("GET {path} HTTP/1.1\r\nHost: app\r\nConnection: close\r\n\r\n").as_bytes(),
        )
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
fn the_certificate_carries_exactly_the_transport_key() {
    let (_s, spki) = server();
    assert_eq!(spki.len(), 44);
    assert_eq!(&spki[..12], &ED25519_SPKI_PREFIX);
    // the public half of SEED, as libsodium's crypto_sign_seed_keypair (the payload's) would derive it
    let kp = rcgen::KeyPair::try_from(
        [
            &[
                0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22,
                0x04, 0x20,
            ][..],
            &SEED[..],
        ]
        .concat()
        .as_slice(),
    )
    .unwrap();
    assert_eq!(&spki[12..], kp.public_key_raw());
}

#[test]
fn a_client_pinning_the_transport_key_gets_the_app_over_tls() {
    let (s, spki) = server();
    let (client, srv_end) = UnixStream::pair().unwrap();
    let t = serve(&s, srv_end);
    let r = get_tls(client, &spki, "/ping").unwrap();
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    assert!(
        r.ends_with("{\"ok\":true}") || r.contains("{\"ok\":true}"),
        "{r}"
    );
    assert!(t.join().unwrap());
    assert_eq!(s.requests(), 1);
}

#[test]
fn a_client_pinning_another_key_refuses_before_sending_the_request() {
    let (s, spki) = server();
    let mut other = spki.clone();
    other[43] ^= 1;
    let (client, srv_end) = UnixStream::pair().unwrap();
    let t = serve(&s, srv_end);
    let e = get_tls(client, &other, "/ping").unwrap_err();
    assert!(e.starts_with("handshake"), "{e}");
    let _ = t.join();
    assert_eq!(s.requests(), 0, "nothing reached the app");
}

#[test]
fn plaintext_http_to_the_tls_port_gets_no_http() {
    let (s, _) = server();
    let (mut client, srv_end) = UnixStream::pair().unwrap();
    let t = serve(&s, srv_end);
    client
        .write_all(b"GET /ping HTTP/1.1\r\nHost: app\r\nConnection: close\r\n\r\n")
        .unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    let mut out = Vec::new();
    let _ = client.read_to_end(&mut out);
    assert!(
        !String::from_utf8_lossy(&out).contains("HTTP/1.1"),
        "{out:?}"
    );
    assert!(!t.join().unwrap(), "the connection ended in a TLS failure");
    assert_eq!(s.requests(), 0);
}

#[test]
fn one_flipped_byte_in_transit_gets_no_answer() {
    let (s, spki) = server();
    let (client, relay_a) = UnixStream::pair().unwrap();
    let (relay_b, srv_end) = UnixStream::pair().unwrap();
    let t = serve(&s, srv_end);
    // the carrier: forwards both ways, flipping the last byte of the client's first encrypted record (type 0x17)
    let flipped = Arc::new(Mutex::new(false));
    let (mut a_rd, mut a_wr, mut b_rd, mut b_wr) = (
        relay_a.try_clone().unwrap(),
        relay_a,
        relay_b.try_clone().unwrap(),
        relay_b,
    );
    let f = flipped.clone();
    let up = std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        while let Ok(n) = a_rd.read(&mut buf) {
            if n == 0 {
                break;
            }
            let mut chunk = buf[..n].to_vec();
            let mut done = f.lock().unwrap();
            if !*done && chunk[0] == 0x17 {
                let last = chunk.len() - 1;
                chunk[last] ^= 0x01;
                *done = true;
            }
            drop(done);
            if b_wr.write_all(&chunk).is_err() {
                break;
            }
        }
        let _ = b_wr.shutdown(std::net::Shutdown::Write);
    });
    let down = std::thread::spawn(move || {
        let mut buf = [0u8; 65536];
        while let Ok(n) = b_rd.read(&mut buf) {
            if n == 0 || a_wr.write_all(&buf[..n]).is_err() {
                break;
            }
        }
        let _ = a_wr.shutdown(std::net::Shutdown::Write);
    });
    let r = get_tls(client, &spki, "/ping");
    assert!(*flipped.lock().unwrap(), "the carrier flipped a byte");
    assert!(
        r.as_ref().map(|b| !b.contains("200")).unwrap_or(true),
        "{r:?}"
    );
    let _ = t.join();
    let _ = (up.join(), down.join());
    assert_eq!(
        s.requests(),
        0,
        "the tampered request never reached the app"
    );
}
