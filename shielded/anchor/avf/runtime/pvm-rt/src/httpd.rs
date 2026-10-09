//! wasi:http inside the pVM (PVM-CPU.md, "The app runtime", milestone 4): a `wasi:http/proxy` component -- the shape
//! of every Enclave HTTP app -- served inside the VM, unchanged.
//!
//! The component is verified and compiled ONCE (the same rules as `run_app`: W^X, digest before compile, no deserialise),
//! then pre-instantiated. The payload accepts each connection on its vsock port and hands the connected stream to
//! `serve_fd`, which speaks HTTP/1.1 on it (hyper) until the peer closes; every request gets a fresh instance in a fresh
//! Store -- its own memory limit, its own epoch deadline -- dropped when the request ends. CPU-only: wasi:nn and every
//! accelerator interface are never linked, so a component that imports one is refused at open.
//!
//! What a component cannot do here: open an outgoing connection (the VM has no network, and `send_request` refuses:
//! there is no TLS client in this build), reach a model or an accelerator (none is linked), or keep state across requests
//! (a request's instance is dropped with its Store).
//!
//! With `with_tls`, every connection is TLS 1.3 terminating HERE, in the VM: the server key is the VM's Ed25519 transport
//! key -- the key its AVF attestation binds (the v2 attach transcript, and Bind2 in the app's ABI/2 evidence) -- in a
//! self-signed certificate made in this process. A client pins that key from verified evidence and ignores names and
//! dates; whatever carries the bytes (the phone's Android app, the relay) sees only ciphertext.
//!
//! With `with_tls_p256` (the marketplace host, PVM-CPU.md "Serving buyers"), the server key is a P-256 key DERIVED here
//! from a seed the payload takes from the VM instance's secret for this app, so a browser can trust it: `csr` makes a
//! certificate request for the app's name with it, and `set_chain` installs the certificate chain a public CA issued for
//! it (the relay's certificate service, after verifying evidence that binds this key). Until a chain is installed the
//! certificate is self-signed. A chain for any other key is refused, so whoever installs one can only choose a name, never
//! a key. The key never leaves this process; the payload signs its SPKI into the app's evidence with the attested
//! transport key.
//!
//! Connections are served concurrently: each `serve_fd` call runs on its own small runtime, so the payload may call it
//! from one thread per connection. A connection with no request running and no bytes moving for `IDLE_CLOSE` is closed.

use crate::{engine_config, sealed, verify_and_compile};
use hyper::server::conn::http1;
use http_body_util::BodyExt;
use hyper::body::{Body, Bytes, Frame, SizeHint};
use std::future::Future;
use std::os::fd::{FromRawFd, RawFd};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio_rustls::rustls;
use wasmtime::component::{Linker, ResourceTable};
use wasmtime::{Engine, Result, Store, StoreLimits, StoreLimitsBuilder, UpdateDeadline};
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};
use wasmtime_wasi_http::io::TokioIo;
use wasmtime_wasi_http::p2::bindings::http::types::{ErrorCode, Scheme};
use wasmtime_wasi_http::p2::bindings::ProxyPre;
use wasmtime_wasi_http::p2::body::HyperOutgoingBody;
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpCtxView, WasiHttpHooks, WasiHttpView};

/// The epoch tick: a request's deadline is counted in these.
const TICK: Duration = Duration::from_millis(10);

/// No outgoing HTTP from inside the VM.
struct NoOutgoing;
impl WasiHttpHooks for NoOutgoing {
    fn send_request(
        &mut self,
        _request: http::Request<wasmtime_wasi_http::WasiBody>,
        _options: Option<wasmtime_wasi_http::RequestOptions>,
        _fut: Box<
            dyn std::future::Future<Output = std::result::Result<(), wasmtime_wasi_http::Error>>
                + Send,
        >,
    ) -> Box<
        dyn std::future::Future<
                Output = std::result::Result<
                    (
                        http::Response<wasmtime_wasi_http::WasiBody>,
                        Box<
                            dyn std::future::Future<
                                    Output = std::result::Result<(), wasmtime_wasi_http::Error>,
                                > + Send,
                        >,
                    ),
                    wasmtime_wasi_http::Error,
                >,
            > + Send,
    > {
        Box::new(async { Err(ErrorCode::HttpRequestDenied.into()) })
    }
}

struct HttpState {
    wasi: WasiCtx,
    http: WasiHttpCtx,
    hooks: NoOutgoing,
    table: ResourceTable,
    limits: StoreLimits,
}
impl WasiView for HttpState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}
impl WasiHttpView for HttpState {
    fn http(&mut self) -> WasiHttpCtxView<'_> {
        WasiHttpCtxView {
            ctx: &mut self.http,
            table: &mut self.table,
            hooks: &mut self.hooks,
        }
    }
}

/// One verified, compiled, pre-instantiated HTTP component, and what every request of it gets.
pub struct HttpServer {
    /// a wasi:http app (`open`): instantiated per request; None for a socket app
    pre: Option<ProxyPre<HttpState>>,
    /// a socket-server app (`open_socket_app`): one long-lived instance listening on loopback in the VM, fronted here
    socket: Option<SocketApp>,
    rt: tokio::runtime::Runtime,
    mem_limit: usize,
    deadline: Duration,
    stop: Arc<AtomicBool>,
    ticker: Option<std::thread::JoinHandle<()>>,
    requests: AtomicU64,
    /// the guest's stderr after each request, and the server's own notes (stream 2)
    log: Option<Log>,
    pub compile_ms: u128,
    tls: Option<Arc<rustls::ServerConfig>>,
    /// the DER SubjectPublicKeyInfo the TLS certificate carries (the transport key's, or the P-256 key's), when TLS is on
    pub tls_spki: Option<Vec<u8>>,
    /// the P-256 key and its swappable certificate (`with_tls_p256`), for `csr` and `set_chain`
    tls_p256: Option<(P256Key, Arc<SwapCert>)>,
    /// the app evidence for a client's nonce (`set_attest`): answers GET /.well-known/enclave-attestation?nonce=<64 hex>
    attest: std::sync::OnceLock<AttestFn>,
    /// a connection with no request running and no byte moving for this long is closed
    idle_close: Duration,
    /// the browser channel's app key (sealed.rs), when enabled
    sealed: Option<sealed::SealedKey>,
}

/// Ed25519 PKCS#8 v1 prefix: a 32-byte seed follows (RFC 8410).
const ED25519_PKCS8_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/// The TLS server configuration over an Ed25519 seed: TLS 1.3 only, ALPN http/1.1, no client certificates, a
/// self-signed certificate made here. Returns the config and the certificate's SPKI.
pub fn tls_config(seed: &[u8; 32]) -> Result<(Arc<rustls::ServerConfig>, Vec<u8>)> {
    let mut pkcs8 = ED25519_PKCS8_PREFIX.to_vec();
    pkcs8.extend_from_slice(seed);
    let built = (|| -> Result<(rustls::ServerConfig, Vec<u8>)> {
        let kp = rcgen::KeyPair::try_from(pkcs8.as_slice())
            .map_err(|e| wasmtime::format_err!("the transport key is not an Ed25519 key: {e}"))?;
        let raw = kp.public_key_raw();
        if raw.len() != 32 {
            wasmtime::bail!("an Ed25519 public key is 32 bytes, not {}", raw.len());
        }
        let mut spki = ED25519_SPKI_PREFIX.to_vec(); // the same 44 bytes the VM announces as its transport SPKI
        spki.extend_from_slice(raw);
        let cert = rcgen::CertificateParams::new(vec!["pvm-app.invalid".to_string()])
            .and_then(|p| p.self_signed(&kp))
            .map_err(|e| wasmtime::format_err!("self-signed certificate: {e}"))?;
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(pkcs8.clone().into());
        let mut cfg = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| wasmtime::format_err!("TLS 1.3: {e}"))?
        .with_no_client_auth()
        .with_single_cert(vec![cert.der().clone()], key)
        .map_err(|e| wasmtime::format_err!("TLS certificate: {e}"))?;
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok((cfg, spki))
    })();
    pkcs8.iter_mut().for_each(|b| *b = 0); // this copy of the seed goes now; rustls holds its own
    let (cfg, spki) = built?;
    Ok((Arc::new(cfg), spki))
}

/// Ed25519 SubjectPublicKeyInfo prefix: the 32-byte public key follows (RFC 8410).
pub const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// P-256 SubjectPublicKeyInfo prefix (RFC 5480, id-ecPublicKey with prime256v1): the 65-byte uncompressed point follows.
pub const P256_SPKI_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce,
    0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];
/// A P-256 PKCS#8 v1 document (RFC 5208 around RFC 5915), the shape ring generates: this head, the 32-byte scalar, then
/// `P256_PKCS8_MID` and the 65-byte uncompressed public point (138 bytes in all).
const P256_PKCS8_HEAD: [u8; 36] = [
    0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
    0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x6d, 0x30, 0x6b, 0x02, 0x01, 0x01, 0x04, 0x20,
];
const P256_PKCS8_MID: [u8; 5] = [0xa1, 0x44, 0x03, 0x42, 0x00];
/// The domain of the scalar's derivation from the payload's seed.
const P256_DERIVE_DOMAIN: &[u8] = b"enclave-pvm-tls-p256-v1\n";
/// A certificate chain to install: at most this many certificates in at most this many PEM bytes.
pub const MAX_CHAIN_CERTS: usize = 5;
pub const MAX_CHAIN_PEM: usize = 32 << 10;

/// How long a client has to complete the TLS handshake.
const TLS_HANDSHAKE: Duration = Duration::from_secs(20);
/// A connection with no request running and no bytes moving for this long is closed (keep-alive clients reconnect).
pub const IDLE_CLOSE: Duration = Duration::from_secs(45);

/// The P-256 TLS key: its PKCS#8 document (zeroed on drop) and its SPKI.
pub struct P256Key {
    pkcs8: Vec<u8>,
    pub spki: Vec<u8>,
}
impl Drop for P256Key {
    fn drop(&mut self) {
        self.pkcs8.iter_mut().for_each(|b| *b = 0);
    }
}

/// The P-256 key for `seed`: the scalar is the first SHA-256(domain || seed || counter) in [1, n), counter from 0 (one
/// value in 2^32 is out of range). The same seed always gives the same key.
pub fn p256_key(seed: &[u8; 32]) -> Result<P256Key> {
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use sha2::{Digest, Sha256};
    for ctr in 0u32..8 {
        let mut d: [u8; 32] = Sha256::new()
            .chain_update(P256_DERIVE_DOMAIN)
            .chain_update(seed)
            .chain_update(ctr.to_be_bytes())
            .finalize()
            .into();
        let sk = p256::SecretKey::from_bytes(&d.into());
        d.iter_mut().for_each(|b| *b = 0);
        let Ok(sk) = sk else { continue };
        let point = sk.public_key().to_encoded_point(false);
        let point = point.as_bytes();
        if point.len() != 65 {
            wasmtime::bail!("a P-256 uncompressed point is 65 bytes, not {}", point.len());
        }
        let mut pkcs8 = Vec::with_capacity(138);
        pkcs8.extend_from_slice(&P256_PKCS8_HEAD);
        pkcs8.extend_from_slice(&sk.to_bytes());
        pkcs8.extend_from_slice(&P256_PKCS8_MID);
        pkcs8.extend_from_slice(point);
        let mut spki = P256_SPKI_PREFIX.to_vec();
        spki.extend_from_slice(point);
        return Ok(P256Key { pkcs8, spki });
    }
    wasmtime::bail!("no P-256 scalar from this seed")
}

/// The server's certificate, replaceable while it serves (`set_chain`): every new handshake takes the current one.
#[derive(Debug)]
pub struct SwapCert(std::sync::RwLock<Arc<rustls::sign::CertifiedKey>>);
impl rustls::server::ResolvesServerCert for SwapCert {
    fn resolve(&self, _hello: rustls::server::ClientHello<'_>) -> Option<Arc<rustls::sign::CertifiedKey>> {
        Some(self.0.read().unwrap_or_else(|p| p.into_inner()).clone())
    }
}

/// A DNS name a certificate may be requested for: lowercase LDH labels of 1..=63, at least two, 253 bytes at most.
fn dns_name_ok(name: &str) -> bool {
    name.len() <= 253
        && name.split('.').count() >= 2
        && name.split('.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && !l.starts_with('-')
                && !l.ends_with('-')
                && l.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

impl HttpServer {
    /// Verify (W^X, digest), compile once, pre-instantiate. A component whose imports this server does not provide --
    /// wasi:nn or any accelerator interface (CPU-only), anything beyond wasi:cli/io/clocks/random/http -- is refused here,
    /// before any request.
    pub fn open(
        bundle: &[u8],
        expected_sha256: &[u8; 32],
        mem_limit: usize,
        request_deadline: Duration,
        log: Option<Box<dyn Fn(&[u8]) + Send + Sync>>,
    ) -> Result<HttpServer> {
        let engine = Engine::new(&engine_config()?)?; // async host calls need no setting of their own in wasmtime 49
        let t0 = Instant::now();
        let component = verify_and_compile(&engine, bundle, expected_sha256)?;
        let compile_ms = t0.elapsed().as_millis();
        let mut linker = Linker::<HttpState>::new(&engine);
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
        wasmtime_wasi_http::p2::add_only_http_to_linker_async(&mut linker)?;
        let pre = Some(ProxyPre::new(linker.instantiate_pre(&component)?)?);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .enable_time()
            .build()?;
        let stop = Arc::new(AtomicBool::new(false));
        let ticker = {
            let (e, s) = (engine.clone(), stop.clone());
            std::thread::spawn(move || {
                while !s.load(Ordering::Acquire) {
                    std::thread::sleep(TICK);
                    e.increment_epoch();
                }
            })
        };
        Ok(HttpServer {
            pre,
            socket: None,
            rt,
            mem_limit,
            deadline: request_deadline.max(TICK),
            stop,
            ticker: Some(ticker),
            requests: AtomicU64::new(0),
            log: log.map(Log::from),
            compile_ms,
            tls: None,
            tls_spki: None,
            tls_p256: None,
            attest: std::sync::OnceLock::new(),
            idle_close: IDLE_CLOSE,
            sealed: None,
        })
    }

    /// Close idle connections after `d` instead of IDLE_CLOSE.
    pub fn with_idle_close(mut self, d: Duration) -> HttpServer {
        self.idle_close = d;
        self
    }

    /// The app's evidence hook (set once, before serving): `f(nonce)` returns the JSON evidence document the payload makes
    /// for that client nonce (a fresh AVF certificate binding this app, this VM and the TLS key; PVM-CPU.md "Serving
    /// buyers"), or the reason it cannot. With it, this server answers two paths itself, on every connection, before the
    /// app ever sees them -- the app never receives /.well-known/enclave-attestation or /.well-known/enclave-ready:
    ///   GET /.well-known/enclave-attestation?nonce=<64 lowercase hex>  -> 200 the document, or 503 {"error":...}
    ///   GET /.well-known/enclave-ready                                  -> 200 {"ok":true} (the app is served)
    /// so a client verifies the VM on the same TLS connection whose key the document binds. False when already set.
    pub fn set_attest(&self, f: AttestFn) -> bool {
        self.attest.set(f).is_ok()
    }

    /// One of the two evidence paths (`set_attest`), answered without the app; None for every other request.
    async fn well_known(&self, req: &hyper::Request<hyper::body::Incoming>) -> Option<hyper::Response<HyperOutgoingBody>> {
        let attest = self.attest.get()?.clone();
        let path = req.uri().path();
        if path != "/.well-known/enclave-attestation" && path != "/.well-known/enclave-ready" {
            return None;
        }
        let reply = |status: u16, body: String| {
            let body: HyperOutgoingBody = http_body_util::Full::new(Bytes::from(body))
                .map_err(|never: std::convert::Infallible| -> wasmtime_wasi_http::Error { match never {} })
                .boxed_unsync();
            let mut r = hyper::Response::new(body);
            *r.status_mut() = hyper::StatusCode::from_u16(status).unwrap_or(hyper::StatusCode::INTERNAL_SERVER_ERROR);
            r.headers_mut().insert(hyper::header::CONTENT_TYPE, hyper::header::HeaderValue::from_static("application/json"));
            r.headers_mut().insert(hyper::header::CACHE_CONTROL, hyper::header::HeaderValue::from_static("no-store"));
            r
        };
        if req.method() != hyper::Method::GET {
            return Some(reply(405, "{\"error\":\"GET only\"}".into()));
        }
        if path == "/.well-known/enclave-ready" {
            return Some(reply(200, "{\"ok\":true}".into()));
        }
        let nonce = req.uri().query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("nonce=")));
        let Some(nonce) = nonce.filter(|n| n.len() == 64 && n.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) else {
            return Some(reply(400, "{\"error\":\"nonce must be 64 lowercase hex\"}".into()));
        };
        let mut n = [0u8; 32];
        for (i, b) in n.iter_mut().enumerate() {
            *b = u8::from_str_radix(&nonce[2 * i..2 * i + 2], 16).unwrap_or(0);
        }
        // the payload's attestation blocks (an AVF request, paced): off this connection's runtime thread
        let got = tokio::task::spawn_blocking(move || attest(n)).await;
        Some(match got {
            Ok(Ok(doc)) => match String::from_utf8(doc) {
                Ok(d) => reply(200, d),
                Err(_) => reply(503, "{\"error\":\"the evidence is not UTF-8\"}".into()),
            },
            Ok(Err(why)) => reply(503, format!("{{\"error\":{}}}", json_str(&why))),
            Err(_) => reply(503, "{\"error\":\"the evidence hook failed\"}".into()),
        })
    }

    /// Serve every connection over TLS 1.3 with this Ed25519 key (the VM's transport key; see the module doc).
    pub fn with_tls(mut self, seed: &[u8; 32]) -> Result<HttpServer> {
        let (cfg, spki) = tls_config(seed)?;
        self.tls = Some(cfg);
        self.tls_spki = Some(spki);
        Ok(self)
    }

    /// Serve every connection over TLS 1.3 with the P-256 key derived from `seed` (`p256_key`), self-signed until
    /// `set_chain` installs a CA-issued chain for it (see the module doc).
    pub fn with_tls_p256(mut self, seed: &[u8; 32]) -> Result<HttpServer> {
        let key = p256_key(seed)?;
        let kp = rcgen::KeyPair::try_from(key.pkcs8.as_slice())
            .map_err(|e| wasmtime::format_err!("the P-256 key: {e}"))?;
        let cert = rcgen::CertificateParams::new(vec!["pvm-app.invalid".to_string()])
            .and_then(|p| p.self_signed(&kp))
            .map_err(|e| wasmtime::format_err!("self-signed certificate: {e}"))?;
        let signer = rustls::crypto::ring::sign::any_ecdsa_type(&rustls::pki_types::PrivateKeyDer::Pkcs8(
            key.pkcs8.clone().into(),
        ))
        .map_err(|e| wasmtime::format_err!("the P-256 signing key: {e}"))?;
        let swap = Arc::new(SwapCert(std::sync::RwLock::new(Arc::new(rustls::sign::CertifiedKey::new(
            vec![cert.der().clone()],
            signer,
        )))));
        let mut cfg = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|e| wasmtime::format_err!("TLS 1.3: {e}"))?
            .with_no_client_auth()
            .with_cert_resolver(swap.clone());
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        self.tls = Some(Arc::new(cfg));
        self.tls_spki = Some(key.spki.clone());
        self.tls_p256 = Some((key, swap));
        Ok(self)
    }

    /// A PKCS#10 certificate request (DER) for `name` with the P-256 key: CN = the one SAN = `name`, which is what the
    /// platform's certificate service requires. Refused without `with_tls_p256` or for a name that is not a DNS name.
    pub fn csr(&self, name: &str) -> Result<Vec<u8>> {
        let Some((key, _)) = &self.tls_p256 else { wasmtime::bail!("no P-256 TLS key: this server makes no certificate request") };
        if !dns_name_ok(name) {
            wasmtime::bail!("{name:?} is not a lowercase DNS name");
        }
        let kp = rcgen::KeyPair::try_from(key.pkcs8.as_slice()).map_err(|e| wasmtime::format_err!("the P-256 key: {e}"))?;
        let mut params =
            rcgen::CertificateParams::new(vec![name.to_string()]).map_err(|e| wasmtime::format_err!("the request: {e}"))?;
        params.distinguished_name = rcgen::DistinguishedName::new();
        params.distinguished_name.push(rcgen::DnType::CommonName, name);
        let req = params.serialize_request(&kp).map_err(|e| wasmtime::format_err!("the request: {e}"))?;
        Ok(req.der().to_vec())
    }

    /// Install a certificate chain (PEM, leaf first) for the P-256 key: every later handshake presents it. Refused -- and
    /// the current certificate kept -- unless it is 1..=MAX_CHAIN_CERTS certificates in at most MAX_CHAIN_PEM bytes whose
    /// leaf carries exactly this server's SPKI. Returns the number of certificates installed.
    pub fn set_chain(&self, pem: &[u8]) -> Result<usize> {
        use rustls::pki_types::pem::PemObject;
        let Some((key, swap)) = &self.tls_p256 else { wasmtime::bail!("no P-256 TLS key: no chain can be installed") };
        if pem.len() > MAX_CHAIN_PEM {
            wasmtime::bail!("the chain exceeds {MAX_CHAIN_PEM} bytes");
        }
        let mut chain = Vec::new();
        for c in rustls::pki_types::CertificateDer::pem_slice_iter(pem) {
            let c = c.map_err(|e| wasmtime::format_err!("the chain is not PEM certificates: {e:?}"))?;
            if chain.len() == MAX_CHAIN_CERTS {
                wasmtime::bail!("the chain holds more than {MAX_CHAIN_CERTS} certificates");
            }
            chain.push(c.into_owned());
        }
        let Some(leaf) = chain.first() else { wasmtime::bail!("the chain holds no certificate") };
        // the leaf's SubjectPublicKeyInfo is this exact DER (DER is canonical): a chain for another key is refused, so the
        // installer can choose a name and nothing else
        if !leaf.as_ref().windows(key.spki.len()).any(|w| w == key.spki.as_slice()) {
            wasmtime::bail!("the leaf certificate is not for this server's key");
        }
        let signer = rustls::crypto::ring::sign::any_ecdsa_type(&rustls::pki_types::PrivateKeyDer::Pkcs8(
            key.pkcs8.clone().into(),
        ))
        .map_err(|e| wasmtime::format_err!("the P-256 signing key: {e}"))?;
        let n = chain.len();
        *swap.0.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(rustls::sign::CertifiedKey::new(chain, signer));
        self.note(&format!("TLS certificate chain installed ({n} certificates)"));
        Ok(n)
    }

    /// Enable the browser channel: a fresh X25519 app key for this app and runtime (sealed.rs). Returns its public half,
    /// which the payload signs with the attested transport key into each v2 evidence answer.
    pub fn enable_sealed(&mut self, app_id: &[u8; 32], runtime_id: &[u8; 32]) -> [u8; 32] {
        let k = sealed::SealedKey::generate(app_id, runtime_id);
        let public = k.public;
        self.sealed = Some(k);
        public
    }
    /// The payload answered this nonce with v2 evidence: sealed requests under it are admitted for the window.
    pub fn sealed_admit_nonce(&self, nonce: &[u8; 32]) -> bool {
        match &self.sealed {
            Some(k) => {
                k.admit_nonce(nonce);
                true
            }
            None => false,
        }
    }

    /// One sealed request on one connected stream: read the frame (bounded, 20 s), open it (sealed.rs: the nonce's
    /// window, replay, the app key), serve the HTTP/1.1 request through the same service as every other connection, and
    /// write the sealed response -- or a refusal frame. Takes ownership of `fd`.
    ///
    /// # Safety
    /// `fd` must be an open, connected stream socket that nothing else owns.
    pub unsafe fn serve_sealed_fd(&self, fd: RawFd) -> Result<()> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let std_stream = std::os::unix::net::UnixStream::from_raw_fd(fd);
        std_stream.set_nonblocking(true)?;
        let Some(key) = &self.sealed else {
            wasmtime::bail!("the sealed channel is not enabled");
        };
        self.rt.block_on(async {
            let mut stream = tokio::net::UnixStream::from_std(std_stream)?;
            let body = tokio::time::timeout(TLS_HANDSHAKE, async {
                let n = stream.read_u32().await? as usize;
                if n > sealed::MAX_REQUEST {
                    return Err(std::io::Error::other("sealed request too large"));
                }
                let mut b = vec![0u8; n];
                stream.read_exact(&mut b).await?;
                Ok(b)
            })
            .await
            .map_err(|_| wasmtime::format_err!("sealed request: timed out reading the frame"))?
            .map_err(|e| wasmtime::format_err!("sealed request: {e}"))?;
            let opened = match key.open(&body) {
                Ok(o) => o,
                Err(why) => {
                    self.note(&format!("SEALED refused: {why}"));
                    let _ = stream.write_all(&sealed::refusal(&why)).await;
                    let _ = stream.shutdown().await;
                    return Ok(());
                }
            };
            if opened.chunked {
                return self.serve_stream(stream, opened, body.len()).await;
            }
            let response = self.serve_bytes(&opened.request).await?;
            let out = sealed::SealedKey::seal_response(&opened, &response, None).map_err(|e| wasmtime::format_err!("sealing the response: {e}"))?;
            self.note(&format!("SEALED served nonce={} ({} bytes in, {} out)", hex8(&opened.nonce), body.len(), out.len()));
            stream.write_all(&out).await?;
            stream.shutdown().await?;
            Ok(())
        })
    }

    /// A streamed sealed response (SEALED-STREAMING.md): the request's bytes into the server's own service over a bounded
    /// in-memory pipe; the response's bytes sealed chunk by chunk as they come, each chunk written before the next is read
    /// (so a slow page slows the pipe, hyper, and the guest's blocking writes). FIN only when the app's response completed;
    /// ABORT (authenticated) when it did not, or a cap was reached; a failed write (the page cancelled) ends it at once --
    /// the pipe closes, hyper's write fails, the guest's next write fails and the handler returns.
    async fn serve_stream(&self, stream: tokio::net::UnixStream, opened: sealed::Opened, in_len: usize) -> Result<()> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (head, mut sealer) = sealed::ChunkSealer::start(&opened, None).map_err(|e| wasmtime::format_err!("sealing the stream: {e}"))?;
        let (server_end, mut client_end) = tokio::io::duplex(64 << 10);
        let request = opened.request.clone();
        let nonce = hex8(&opened.nonce);
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<bool>();
        let t0 = Instant::now();
        let pump = tokio::task::spawn(async move {
            client_end.write_all(&request).await?;
            client_end.shutdown().await?;
            // the page sends nothing after its request: its EOF (a close) is the cancel, seen while the app computes and
            // no chunk is due -- a failed write alone would see it only at the app's next output
            let (page_rd, mut stream) = stream.into_split();
            let mut gone = std::pin::pin!(page_gone(page_rd));
            if stream.write_all(&head).await.is_err() {
                return Ok::<_, std::io::Error>(("cancelled", 0u64, 0u64));
            }
            let mut buf = vec![0u8; sealed::CHUNK_PLAINTEXT];
            loop {
                let next = {
                    let mut read = std::pin::pin!(client_end.read(&mut buf));
                    std::future::poll_fn(|cx| {
                        if gone.as_mut().poll(cx).is_ready() {
                            return Poll::Ready(None);
                        }
                        read.as_mut().poll(cx).map(Some)
                    })
                    .await
                };
                let Some(n) = next else {
                    return Ok(("cancelled", sealer.chunks(), sealer.bytes)); // client_end drops here
                };
                let n = n?;
                if n == 0 {
                    let (chunks, bytes) = (sealer.chunks() + 1, sealer.bytes);
                    let completed = done_rx.await.unwrap_or(false);
                    let last = if completed { sealer.finish(&[]) } else { sealer.abort("the app's response ended with an error") };
                    let last = last.map_err(std::io::Error::other)?;
                    if stream.write_all(&last).await.is_err() {
                        return Ok(("cancelled", chunks, bytes));
                    }
                    let _ = stream.shutdown().await;
                    return Ok((if completed { "fin" } else { "abort" }, chunks, bytes));
                }
                match sealer.chunk(&buf[..n]) {
                    Ok(c) => {
                        if stream.write_all(&c).await.is_err() {
                            return Ok(("cancelled", sealer.chunks(), sealer.bytes)); // client_end drops here
                        }
                    }
                    Err(_) => {
                        let (chunks, bytes) = (sealer.chunks() + 1, sealer.bytes);
                        let a = sealer.abort("the response exceeds the stream's caps").map_err(std::io::Error::other)?;
                        let _ = stream.write_all(&a).await;
                        let _ = stream.shutdown().await;
                        return Ok(("abort", chunks, bytes));
                    }
                }
            }
        });
        let inflight = Arc::new(Inflight::default());
        let serve = http1::Builder::new()
            .keep_alive(false)
            .half_close(true)
            .serve_connection(TokioIo::new(server_end), hyper::service::service_fn(|req| self.handle(req, inflight.clone())));
        let mut pump = pump;
        let first = {
            let mut serve = std::pin::pin!(serve);
            // the pump ends first only when the page went away or a cap was reached: the connection is dropped here,
            // unfinished, which cancels its request (Checked / CancelOnDrop) -- the app stops within a tick
            std::future::poll_fn(|cx| {
                if let Poll::Ready(p) = Pin::new(&mut pump).poll(cx) {
                    return Poll::Ready(Err(p));
                }
                serve.as_mut().poll(cx).map(Ok)
            })
            .await
        };
        let pumped = match first {
            Ok(served) => {
                let _ = done_tx.send(served.is_ok());
                pump.await
            }
            Err(pumped) => pumped,
        };
        inflight.drained().await;
        let (how, chunks, bytes) = pumped
            .map_err(|e| wasmtime::format_err!("sealed stream: {e}"))?
            .map_err(|e| wasmtime::format_err!("sealed stream: {e}"))?;
        self.note(&format!(
            "SEALED stream nonce={nonce} {how} after {chunks} chunks ({in_len} bytes in, {bytes} plaintext bytes out, {} ms)",
            t0.elapsed().as_millis()
        ));
        Ok(())
    }

    /// One HTTP/1.1 request's bytes through the server's own service (hyper over an in-memory pipe): the response's bytes.
    async fn serve_bytes(&self, request: &[u8]) -> Result<Vec<u8>> {
        let inflight = Arc::new(Inflight::default());
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (server_end, mut client_end) = tokio::io::duplex(1 << 16);
        let serve = http1::Builder::new()
            .keep_alive(false)
            .half_close(true)
            .serve_connection(TokioIo::new(server_end), hyper::service::service_fn(|req| self.handle(req, inflight.clone())));
        let request = request.to_vec();
        // the pipe's far end runs beside the server (a task on this runtime; it progresses while `serve` awaits)
        let io = tokio::task::spawn(async move {
            client_end.write_all(&request).await?;
            client_end.shutdown().await?;
            let mut out = Vec::new();
            (&mut client_end).take(sealed::MAX_RESPONSE as u64 + 1).read_to_end(&mut out).await?;
            Ok::<_, std::io::Error>(out) // client_end drops here: a response past the cap ends the connection
        });
        let served = serve.await;
        inflight.drained().await;
        let out = io
            .await
            .map_err(|e| wasmtime::format_err!("sealed request: {e}"))?
            .map_err(|e| wasmtime::format_err!("sealed request: {e}"))?;
        if out.len() > sealed::MAX_RESPONSE {
            wasmtime::bail!("the response exceeds {} bytes", sealed::MAX_RESPONSE);
        }
        served.map_err(|e| wasmtime::format_err!("the sealed request's connection ended with an error: {e}"))?;
        Ok(out)
    }

    pub fn requests(&self) -> u64 {
        self.requests.load(Ordering::Relaxed)
    }

    fn note(&self, s: &str) {
        if let Some(l) = &self.log {
            l(s.as_bytes());
        }
    }

    /// Serves HTTP/1.1 on one connected stream socket until the peer closes it. Takes ownership of `fd` (it is closed
    /// when this returns, whatever happened).
    ///
    /// # Safety
    /// `fd` must be an open, connected stream socket that nothing else owns.
    pub unsafe fn serve_fd(&self, fd: RawFd) -> Result<()> {
        // a stream socket of any family (vsock in the VM): read/write only, no address parsing
        let std_stream = std::os::unix::net::UnixStream::from_raw_fd(fd);
        std_stream.set_nonblocking(true)?;
        // its own runtime: connections on other threads are served at the same time (the module doc)
        let rt = tokio::runtime::Builder::new_current_thread().enable_io().enable_time().build()?;
        rt.block_on(async {
            let stream = tokio::net::UnixStream::from_std(std_stream)?;
            let inflight = Arc::new(Inflight::default());
            let act = Arc::new(Activity::new());
            let served = match &self.tls {
                None => {
                    let conn = http1::Builder::new().keep_alive(true).serve_connection(
                        TokioIo::new(Watched { inner: stream, act: act.clone() }),
                        hyper::service::service_fn(|req| self.handle(req, inflight.clone())),
                    );
                    until_idle(conn, &inflight, &act, self.idle_close).await
                }
                Some(cfg) => {
                    // the handshake is bounded; a peer that sends anything but a TLS 1.3 ClientHello gets no HTTP at all
                    let tls = tokio::time::timeout(
                        TLS_HANDSHAKE,
                        tokio_rustls::TlsAcceptor::from(cfg.clone()).accept(stream),
                    )
                    .await
                    .map_err(|_| wasmtime::format_err!("TLS handshake timed out"))?
                    .map_err(|e| wasmtime::format_err!("TLS handshake failed: {e}"))?;
                    let conn = http1::Builder::new().keep_alive(true).serve_connection(
                        TokioIo::new(Watched { inner: tls, act: act.clone() }),
                        hyper::service::service_fn(|req| self.handle(req, inflight.clone())),
                    );
                    until_idle(conn, &inflight, &act, self.idle_close).await
                }
            };
            // a request the connection ended under (the client went away mid-response) is cancelled: wait for it to stop
            inflight.drained().await;
            served.map_err(|e| wasmtime::format_err!("the connection ended with an error: {e}"))
        })
    }

    async fn handle(
        &self,
        req: hyper::Request<hyper::body::Incoming>,
        inflight: Arc<Inflight>,
    ) -> Result<hyper::Response<HyperOutgoingBody>> {
        if let Some(r) = self.well_known(&req).await {
            return Ok(r);
        }
        if let Some(app) = &self.socket {
            return self.proxy(app.net.clone(), req, inflight).await;
        }
        let n = self.requests.fetch_add(1, Ordering::Relaxed) + 1;
        let err = MemoryOutputPipe::new(1 << 16);
        let mut wasi = WasiCtx::builder();
        wasi.stderr(err.clone());
        let mut store = Store::new(
            self.pre.as_ref().expect("a wasi:http server has its pre-instance").engine(),
            HttpState {
                wasi: wasi.build(),
                http: WasiHttpCtx::new(),
                hooks: NoOutgoing,
                table: ResourceTable::new(),
                limits: StoreLimitsBuilder::new()
                    .memory_size(self.mem_limit)
                    .instances(64)
                    .tables(64)
                    .memories(16)
                    .trap_on_grow_failure(true)
                    .build(),
            },
        );
        store.limiter(|s| &mut s.limits);
        // Every tick the instance yields to the executor (so a CPU-bound app's streamed lines go out while it computes, and
        // a cancel is seen), then stops if the request is past its deadline or its client went away (`cancel`, set when the
        // response is dropped unfinished or the request is abandoned before one): a cancel stops CPU work within a tick,
        // not at the app's next write.
        let cancel = Arc::new(AtomicBool::new(false));
        let (stop, deadline, started) = (cancel.clone(), self.deadline, Instant::now());
        store.set_epoch_deadline(1);
        store.epoch_deadline_callback(move |_| {
            if stop.load(Ordering::Acquire) {
                wasmtime::bail!("cancelled: the client went away");
            }
            if started.elapsed() >= deadline {
                return Ok(UpdateDeadline::Interrupt);
            }
            // tokio's yield defers the wake: the connection's own future runs before this instance does again (wasmtime's
            // plain Yield re-queues at once, and a current-thread runtime then polls the connection only every ~61 polls)
            Ok(UpdateDeadline::YieldCustom(1, Box::pin(tokio::task::yield_now())))
        });
        let mut abandoned = CancelOnDrop(Some(cancel));
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let wreq = store
            .data_mut()
            .http()
            .new_incoming_request(Scheme::Http, req)?;
        let out = store.data_mut().http().new_response_outparam(sender)?;
        let pre = self.pre.clone().expect("a wasi:http server has its pre-instance");
        // the handler runs beside the response, so a streamed body can continue after the headers; the Store (the
        // instance, its memory) is dropped when the handler returns
        let failure = Arc::new(Mutex::new(None::<String>));
        let failed = failure.clone();
        let deadline = self.deadline;
        inflight.live.fetch_add(1, Ordering::AcqRel);
        let task = tokio::task::spawn(async move {
            let _live = Live(inflight);
            let call = async {
                let proxy = pre.instantiate_async(&mut store).await?;
                proxy
                    .wasi_http_incoming_handler()
                    .call_handle(&mut store, wreq, out)
                    .await
            };
            // the wall-clock backstop: an app waiting in a host call (a timer, a stalled stream) reaches no epoch check
            let r: Result<()> = match tokio::time::timeout(deadline + 2 * TICK, call).await {
                Ok(r) => r,
                Err(_) => Err(wasmtime::format_err!("the request's deadline passed while the app waited")),
            };
            // recorded BEFORE the Store drops: dropping it ends a response body already under way, and that body's end
            // must already know the app failed (Checked)
            if let Err(e) = &r {
                *failed.lock().unwrap() = Some(format!("{e:#}"));
            }
            drop(store);
            r
        });
        let res = match receiver.await {
            Ok(Ok(resp)) => {
                let cancel = abandoned.0.take().expect("armed until here");
                Ok(resp.map(|inner| {
                    Checked { inner, failure, log: self.log.clone(), n, cancel, ended: false }.boxed_unsync()
                }))
            }
            Ok(Err(e)) => Err(e.into()),
            Err(_) => {
                let e = match task.await {
                    Ok(Ok(())) => wasmtime::format_err!("the component never set a response"),
                    Ok(Err(e)) => e,
                    Err(e) => e.into(),
                };
                Err(e.context("the component never set a response"))
            }
        };
        let stderr = err.contents();
        if !stderr.is_empty() {
            self.note(&format!(
                "request {n} stderr: {}",
                String::from_utf8_lossy(&stderr)
            ));
        }
        if let Err(e) = &res {
            self.note(&format!("request {n} failed: {e:#}"));
        }
        res
    }
}

type Log = Arc<dyn Fn(&[u8]) + Send + Sync>;
/// The payload's evidence for a client nonce (`set_attest`): the JSON document, or why not.
pub type AttestFn = Arc<dyn Fn([u8; 32]) -> std::result::Result<Vec<u8>, String> + Send + Sync>;

/// `s` as a JSON string literal.
fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// A response body that cannot end cleanly when its app failed. wasmtime ends an outgoing body as if it were finished when
/// the Store is dropped mid-response (a trap: the deadline, the memory limit, a panic), so a truncated answer would read as
/// complete -- and a sealed stream would FIN it. The handler records its failure before its Store drops; at the body's end
/// that record turns the end into an error, so hyper aborts the response (no last chunk) and a sealed stream ABORTs. A body
/// the app finished before failing is complete, and ends cleanly.
struct Checked {
    inner: HyperOutgoingBody,
    failure: Arc<Mutex<Option<String>>>,
    log: Option<Log>,
    n: u64,
    /// set when this body is dropped before its end: the client went away, so the instance stops at its next tick
    cancel: Arc<AtomicBool>,
    ended: bool,
}

impl Drop for Checked {
    fn drop(&mut self) {
        if !self.ended {
            self.cancel.store(true, Ordering::Release);
        }
    }
}

/// Resolves when the page's side of a sealed stream is gone: EOF or an error. After its request the page sends nothing
/// (SEALED-STREAMING.md: there is no in-band cancel, a cancel is a close); anything it sends anyway is read and dropped.
async fn page_gone(mut rd: tokio::net::unix::OwnedReadHalf) {
    use tokio::io::AsyncReadExt;
    let mut scratch = [0u8; 256];
    while let Ok(n) = rd.read(&mut scratch).await {
        if n == 0 {
            return;
        }
    }
}

/// A connection's requests still running: a connection is not done until they are (Live), so a cancelled request's
/// instance is driven to its next tick, sees the cancel and stops, instead of waiting suspended in the runtime.
#[derive(Default)]
struct Inflight {
    live: AtomicUsize,
    idle: tokio::sync::Notify,
}

impl Inflight {
    async fn drained(&self) {
        while self.live.load(Ordering::Acquire) > 0 {
            self.idle.notified().await;
        }
    }
}

/// A socket-server app (PVM-CPU.md "Serving buyers"): the shape of the catalog's port-serving apps -- a wasi:cli/run
/// component that binds the port ENCLAVE_PORTS names ("http:<port>=<port>": in the VM the logical and actual port are the
/// same) and serves HTTP itself. One instance runs for the app's whole life (its memory is its state), on its own thread.
/// Its network is loopnet.rs's, in process (Microdroid gives the payload no inet sockets): it may bind and listen on THAT
/// port only and accept the front's connections; no outbound connect, no UDP, no name lookup; a /data scratch directory
/// when the payload gives one; its stdout and stderr are discarded once it listens (the app's output is not the host's).
pub struct SocketApp {
    pub port: u16,
    net: Arc<crate::loopnet::LoopNet>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    exited: Arc<Mutex<Option<String>>>,
}

struct SockState {
    ctx: WasiCtx,
    table: ResourceTable,
    limits: StoreLimits,
    net: Arc<crate::loopnet::LoopNet>,
}
impl WasiView for SockState {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView { ctx: &mut self.ctx, table: &mut self.table }
    }
}

/// How long a socket app has to start listening.
pub const SOCKET_READY: Duration = Duration::from_secs(60);

impl HttpServer {
    /// Verify (W^X, digest), compile, and start a socket-server app listening on 127.0.0.1:`port` inside this process's
    /// network (the VM's loopback); returns once it accepts connections, or the reason it did not (it exited, or
    /// SOCKET_READY passed). Every connection `serve_fd` takes is then TLS (with `with_tls_p256`) whose requests -- but
    /// the evidence paths -- are proxied to it.
    pub fn open_socket_app(
        bundle: &[u8],
        expected_sha256: &[u8; 32],
        mem_limit: usize,
        port: u16,
        data_dir: Option<&std::path::Path>,
        log: Option<Box<dyn Fn(&[u8]) + Send + Sync>>,
    ) -> Result<HttpServer> {
        if port == 0 {
            wasmtime::bail!("a socket app needs its declared http port");
        }
        let engine = Engine::new(&engine_config()?)?;
        let t0 = Instant::now();
        let component = verify_and_compile(&engine, bundle, expected_sha256)?;
        let compile_ms = t0.elapsed().as_millis();
        let stop = Arc::new(AtomicBool::new(false));
        let exited = Arc::new(Mutex::new(None::<String>));
        // its stderr is kept (8 KiB) only to say why an app did not start; once it listens, nothing of its output is read
        let early_err = MemoryOutputPipe::new(8 << 10);
        let mut b = WasiCtx::builder();
        b.args(&["app"])
            .env("ENCLAVE_PORTS", format!("http:{port}={port}"))
            .env("ENCLAVE_MEM_MB", (mem_limit >> 20).max(1).to_string())
            .stdout(wasmtime_wasi::p2::pipe::SinkOutputStream)
            .stderr(early_err.clone())
            // TCP is loopnet.rs's (in process: the app's own port, connections from the front only); UDP and name
            // lookup are wasmtime's and stay off; nothing reaches the host's network
            .allow_tcp(false)
            .allow_udp(false)
            .allow_ip_name_lookup(false);
        if let Some(dir) = data_dir {
            b.preopened_dir(dir, "/data", wasmtime_wasi::FsPerms::ReadWrite)?;
        }
        let ctx = b.build();
        let net = crate::loopnet::LoopNet::new(port);
        let (e, st, ex, n) = (engine.clone(), stop.clone(), exited.clone(), net.clone());
        let thread = std::thread::spawn(move || {
            let r = (|| -> Result<()> {
                let rt = tokio::runtime::Builder::new_current_thread().enable_io().enable_time().build()?;
                rt.block_on(async move {
                    let mut linker = Linker::<SockState>::new(&e);
                    wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
                    linker.allow_shadowing(true);
                    use wasmtime_wasi::p2::bindings::sockets::{tcp, tcp_create_socket};
                    use crate::loopnet::{LoopNetData, LoopNetView};
                    tcp::add_to_linker::<SockState, LoopNetData>(&mut linker, |s| LoopNetView { table: &mut s.table, net: &s.net })?;
                    tcp_create_socket::add_to_linker::<SockState, LoopNetData>(&mut linker, |s| LoopNetView { table: &mut s.table, net: &s.net })?;
                    let limits = StoreLimitsBuilder::new()
                        .memory_size(mem_limit)
                        .instances(64)
                        .tables(64)
                        .memories(16)
                        .trap_on_grow_failure(true)
                        .build();
                    let mut store = Store::new(&e, SockState { ctx, table: ResourceTable::new(), limits, net: n });
                    store.limiter(|s| &mut s.limits);
                    store.set_epoch_deadline(1);
                    let stopping = st.clone();
                    store.epoch_deadline_callback(move |_| {
                        if stopping.load(Ordering::Acquire) {
                            wasmtime::bail!("stopped by the host");
                        }
                        Ok(UpdateDeadline::YieldCustom(1, Box::pin(tokio::task::yield_now())))
                    });
                    let cmd = wasmtime_wasi::p2::bindings::Command::instantiate_async(&mut store, &component, &linker).await?;
                    match cmd.wasi_cli_run().call_run(&mut store).await? {
                        Ok(()) => wasmtime::bail!("the app returned from run"),
                        Err(()) => wasmtime::bail!("the app exited with an error"),
                    }
                })
            })();
            *ex.lock().unwrap_or_else(|p| p.into_inner()) = Some(match r {
                Ok(()) => "the app ended".into(),
                Err(e) => format!("{e:#}"),
            });
        });
        let ticker = {
            let (e, s) = (engine.clone(), stop.clone());
            std::thread::spawn(move || {
                while !s.load(Ordering::Acquire) {
                    std::thread::sleep(TICK);
                    e.increment_epoch();
                }
            })
        };
        let rt = tokio::runtime::Builder::new_current_thread().enable_io().enable_time().build()?;
        let mut srv = HttpServer {
            pre: None,
            socket: Some(SocketApp { port, net: net.clone(), stop: stop.clone(), thread: Some(thread), exited: exited.clone() }),
            rt,
            mem_limit,
            deadline: Duration::from_secs(600),
            stop,
            ticker: Some(ticker),
            requests: AtomicU64::new(0),
            log: log.map(Log::from),
            compile_ms,
            tls: None,
            tls_spki: None,
            tls_p256: None,
            attest: std::sync::OnceLock::new(),
            idle_close: IDLE_CLOSE,
            sealed: None,
        };
        // ready when it accepts a connection on its port; an app that exits first says why
        let until = Instant::now() + SOCKET_READY;
        loop {
            if let Some(why) = exited.lock().unwrap_or_else(|p| p.into_inner()).clone() {
                srv.socket.as_mut().map(|a| a.thread.take().map(|t| t.join()));
                let said = String::from_utf8_lossy(&early_err.contents()).trim().chars().take(600).collect::<String>();
                wasmtime::bail!("the app did not start: {}{}", why.lines().last().unwrap_or(""), if said.is_empty() { String::new() } else { format!(" (its stderr: {said})") });
            }
            if net.listening() {
                break;
            }
            if Instant::now() >= until {
                wasmtime::bail!("the app did not listen on port {port} within {} s", SOCKET_READY.as_secs());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        srv.note(&format!("socket app listening on its port {port} (in process; compile_ms={compile_ms})"));
        Ok(srv)
    }

    /// Why the socket app stopped, if it did.
    pub fn socket_exited(&self) -> Option<String> {
        self.socket.as_ref().and_then(|a| a.exited.lock().unwrap_or_else(|p| p.into_inner()).clone())
    }

    /// One request to the socket app: a fresh loopback connection, the request as received (its body streamed), the
    /// response as the app wrote it. Counted like any request; a failure is the app's 502.
    async fn proxy(
        &self,
        net: Arc<crate::loopnet::LoopNet>,
        req: hyper::Request<hyper::body::Incoming>,
        inflight: Arc<Inflight>,
    ) -> Result<hyper::Response<HyperOutgoingBody>> {
        let n = self.requests.fetch_add(1, Ordering::Relaxed) + 1;
        inflight.live.fetch_add(1, Ordering::AcqRel);
        let live = Live(inflight);
        let sent = async {
            let stream = net.connect()?;
            let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
            tokio::task::spawn(async move {
                let _live = live;
                let _ = conn.await;
            });
            Ok::<_, wasmtime::Error>(sender.send_request(req).await?)
        };
        match sent.await {
            Ok(resp) => Ok(resp.map(|b| b.map_err(wasmtime_wasi_http::Error::from).boxed_unsync())),
            Err(e) => {
                self.note(&format!("request {n} to the socket app failed: {e:#}"));
                let body: HyperOutgoingBody = http_body_util::Full::new(Bytes::from_static(b"{\"error\":\"the app did not answer\"}"))
                    .map_err(|never: std::convert::Infallible| -> wasmtime_wasi_http::Error { match never {} })
                    .boxed_unsync();
                let mut r = hyper::Response::new(body);
                *r.status_mut() = hyper::StatusCode::BAD_GATEWAY;
                Ok(r)
            }
        }
    }
}

/// When a connection last moved a byte, in ms since it opened.
struct Activity {
    base: Instant,
    last_ms: AtomicU64,
}
impl Activity {
    fn new() -> Activity {
        Activity { base: Instant::now(), last_ms: AtomicU64::new(0) }
    }
    fn touch(&self) {
        self.last_ms.store(self.base.elapsed().as_millis() as u64, Ordering::Relaxed);
    }
    fn idle(&self) -> Duration {
        Duration::from_millis((self.base.elapsed().as_millis() as u64).saturating_sub(self.last_ms.load(Ordering::Relaxed)))
    }
}

/// A connection's stream, noting every byte it moves (Activity).
struct Watched<S> {
    inner: S,
    act: Arc<Activity>,
}
impl<S: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for Watched<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut tokio::io::ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let r = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(r, Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.act.touch();
        }
        r
    }
}
impl<S: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for Watched<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        let r = Pin::new(&mut self.inner).poll_write(cx, buf);
        if matches!(r, Poll::Ready(Ok(n)) if n > 0) {
            self.act.touch();
        }
        r
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

/// The connection's own end, or -- once no request is running and no byte has moved for `idle_close` -- Ok, dropping the
/// connection (which closes it). A request still running keeps it open, however long it computes.
async fn until_idle<F: Future<Output = std::result::Result<(), hyper::Error>>>(
    conn: F,
    inflight: &Inflight,
    act: &Activity,
    idle_close: Duration,
) -> std::result::Result<(), hyper::Error> {
    let mut conn = std::pin::pin!(conn);
    let every = (idle_close / 4).clamp(Duration::from_millis(10), Duration::from_secs(1));
    let mut check = Box::pin(tokio::time::sleep(every));
    std::future::poll_fn(|cx| {
        if let Poll::Ready(r) = conn.as_mut().poll(cx) {
            return Poll::Ready(r);
        }
        while check.as_mut().poll(cx).is_ready() {
            if inflight.live.load(Ordering::Acquire) == 0 && act.idle() >= idle_close {
                return Poll::Ready(Ok(()));
            }
            check.as_mut().reset(tokio::time::Instant::now() + every);
        }
        Poll::Pending
    })
    .await
}

/// One running request of a connection; dropped when its task ends, however it ends.
struct Live(Arc<Inflight>);

impl Drop for Live {
    fn drop(&mut self) {
        if self.0.live.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.idle.notify_one();
        }
    }
}

/// A request abandoned before its response (the connection went away while the app computed): its instance stops too.
struct CancelOnDrop(Option<Arc<AtomicBool>>);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if let Some(c) = &self.0 {
            c.store(true, Ordering::Release);
        }
    }
}

impl Body for Checked {
    type Data = Bytes;
    type Error = <HyperOutgoingBody as Body>::Error;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<std::result::Result<Frame<Bytes>, Self::Error>>> {
        let this = &mut *self;
        match Pin::new(&mut this.inner).poll_frame(cx) {
            Poll::Ready(None) => {
                this.ended = true;
                match this.failure.lock().unwrap().take() {
                    None => Poll::Ready(None),
                    Some(e) => {
                        if let Some(l) = &this.log {
                            l(format!("request {} failed after its response began: {e}", this.n).as_bytes());
                        }
                        Poll::Ready(Some(Err(wasmtime_wasi_http::Error::InternalError(Some(
                            "the app failed before its response completed".into(),
                        )))))
                    }
                }
            }
            other => other,
        }
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

fn hex8(b: &[u8; 32]) -> String {
    b[..8].iter().map(|x| format!("{x:02x}")).collect()
}

// the payload's evidence thread admits nonces while the main thread serves: the server must be shareable
const _: fn() = || {
    fn sync<T: Sync + Send>() {}
    sync::<HttpServer>();
};

impl Drop for HttpServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(app) = &mut self.socket {
            // an app waiting in accept (a host call) sees no epoch check until something arrives: one loopback connection
            // wakes it, its next wasm instruction meets the stop, and its thread ends; it is not joined (a wedged app must
            // not hang the payload's teardown)
            app.stop.store(true, Ordering::Release);
            drop(app.net.connect());   // an app waiting in accept wakes, meets the stop at its next instruction, and ends
            drop(app.thread.take());
        }
        if let Some(t) = self.ticker.take() {
            let _ = t.join();
        }
    }
}
