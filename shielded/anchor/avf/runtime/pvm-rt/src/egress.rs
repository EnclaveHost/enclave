//! The app's outbound connections (PVM-CPU.md "Egress"). The VM has no network of its own: every outbound TCP connection
//! is opened by the host side on the app's behalf -- the host agent, through THIS app's TUNA circuits, after its destination
//! policy (public addresses only, no port 25, per-app caps; the same rules as the platform's guest egress) -- and handed in
//! as one byte stream. The VM never holds a resolver or a route: it asks for host:port (or for a name's addresses) and gets
//! a stream (or addresses) or the host's reason.
//!
//! TLS for an `https` request is made HERE, inside the VM, against the public web roots: what the host carries is
//! ciphertext, and a host that answered with somebody else's server would fail the certificate check in the VM.
//!
//!   - wasi:http apps: `EgressHooks` is their outgoing handler (`wasi:http/outgoing-handler`), the platform runner's
//!     default request path with the connect replaced by `Egress::connect`;
//!   - socket apps: loopnet.rs's `start-connect` and `ip-name-lookup` use `Egress::connect` / `Egress::resolve`.
//! Without an `Egress` (the payload gave none) both refuse, as before: `HttpRequestDenied`, `access-denied`.
use http_body_util::BodyExt;
use hyper::body::{Body, Bytes, Frame, SizeHint};
use std::future::Future;
use std::net::IpAddr;
use std::os::fd::{FromRawFd, RawFd};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio_rustls::rustls;
use wasmtime_wasi_http::io::TokioIo;
use wasmtime_wasi_http::{Error, RequestOptions, WasiBody};

/// Opens one outbound stream to host:port (blocking; called off the executor): the connected stream's fd, or the reason.
pub type OpenFn = dyn Fn(&str, u16) -> std::result::Result<RawFd, String> + Send + Sync;
/// A name's addresses (blocking): at least one, or the reason.
pub type ResolveFn = dyn Fn(&str) -> std::result::Result<Vec<IpAddr>, String> + Send + Sync;

/// How the app reaches the outside: the host's two operations, nothing else.
#[derive(Clone)]
pub struct Egress {
    open: Arc<OpenFn>,
    resolve: Arc<ResolveFn>,
}

/// A host-opened stream (a vsock in the VM, any stream socket in tests): read and written as bytes, nothing else.
pub type Stream = tokio::net::UnixStream;

/// The longest host name asked for (RFC 1035's 253, with room for a trailing dot).
const MAX_NAME: usize = 255;

impl Egress {
    pub fn new(open: Arc<OpenFn>, resolve: Arc<ResolveFn>) -> Egress {
        Egress { open, resolve }
    }

    /// One stream to `host:port` (a name or an IP literal; the host resolves a name through the app's own route).
    pub async fn connect(&self, host: &str, port: u16) -> std::io::Result<Stream> {
        let host = checked_host(host)?;
        if port == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "port 0"));
        }
        let open = self.open.clone();
        let fd = tokio::task::spawn_blocking(move || open(&host, port))
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?
            .map_err(|why| std::io::Error::new(std::io::ErrorKind::ConnectionRefused, why))?;
        if fd < 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "the host gave no stream"));
        }
        // SAFETY: the opener hands over a connected stream socket it no longer uses; it is owned (and closed) here.
        let s = unsafe { std::os::unix::net::UnixStream::from_raw_fd(fd) };
        s.set_nonblocking(true)?;
        tokio::net::UnixStream::from_std(s)
    }

    /// A name's addresses, through the app's own route (an IP literal is itself).
    pub async fn resolve(&self, name: &str) -> std::io::Result<Vec<IpAddr>> {
        let name = checked_host(name)?;
        if let Ok(ip) = name.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
            return Ok(vec![ip]);
        }
        let resolve = self.resolve.clone();
        let ips = tokio::task::spawn_blocking(move || resolve(&name))
            .await
            .map_err(|e| std::io::Error::other(e.to_string()))?
            .map_err(|why| std::io::Error::new(std::io::ErrorKind::NotFound, why))?;
        if ips.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "no addresses"));
        }
        Ok(ips)
    }
}

/// A host name or IP literal as the host may be asked for it: printable, no spaces or control bytes, bounded.
fn checked_host(h: &str) -> std::io::Result<String> {
    let h = h.trim_end_matches('.');
    if h.is_empty() || h.len() > MAX_NAME || !h.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._:[]".contains(&b)) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a host name"));
    }
    Ok(h.to_ascii_lowercase())
}

/// The TLS client for the app's https requests: TLS 1.2 and 1.3, ring, the public web roots (webpki-roots) -- what the
/// platform runner's default request path uses.
fn tls_client() -> Arc<rustls::ClientConfig> {
    static CFG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CFG.get_or_init(|| {
        let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.into() };
        let mut c = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("ring supports the default versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        c.alpn_protocols = vec![b"http/1.1".to_vec()];
        Arc::new(c)
    })
    .clone()
}

/// rustls' server name for an authority (host:port, an IPv6 literal bracketed), as wasmtime-wasi-http derives it.
fn server_name(authority: &str) -> std::result::Result<rustls::pki_types::ServerName<'static>, Error> {
    use rustls::pki_types::ServerName;
    if let Ok(addr) = authority.parse::<std::net::SocketAddr>() {
        return Ok(ServerName::from(addr.ip()));
    }
    let host = authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority);
    ServerName::try_from(host.to_string()).map_err(|_| Error::HttpRequestUriInvalid)
}

/// The app's outgoing handler: `Egress` when the payload gave one, refusal otherwise.
pub struct EgressHooks(pub Option<Egress>);

type IoFuture = Box<dyn Future<Output = std::result::Result<(), Error>> + Send>;

impl wasmtime_wasi_http::WasiHttpHooks for EgressHooks {
    fn send_request(
        &mut self,
        request: http::Request<WasiBody>,
        options: Option<RequestOptions>,
        _fut: IoFuture,
    ) -> Box<dyn Future<Output = std::result::Result<(http::Response<WasiBody>, IoFuture), Error>> + Send> {
        let Some(eg) = self.0.clone() else { return Box::new(async { Err(Error::HttpRequestDenied) }) };
        Box::new(async move {
            let (res, io) = send(eg, request, options).await?;
            Ok((res.map(BodyExt::boxed_unsync), Box::new(io) as IoFuture))
        })
    }
}

/// One request over a host-opened stream: the platform runner's request path (wasmtime-wasi-http default_send_request,
/// 49.0.0) with its `TcpStream::connect` replaced by `Egress::connect`, and TLS made here.
async fn send(
    eg: Egress,
    mut req: http::Request<WasiBody>,
    options: Option<RequestOptions>,
) -> std::result::Result<(http::Response<Timed>, impl Future<Output = std::result::Result<(), Error>> + Send), Error> {
    let uri = req.uri();
    let authority = uri.authority().ok_or(Error::HttpRequestUriInvalid)?;
    let use_tls = uri.scheme() == Some(&http::uri::Scheme::HTTPS);
    let host = authority.host().to_string();
    let port = authority.port_u16().unwrap_or(if use_tls { 443 } else { 80 });
    let authority = format!("{}:{port}", authority.host());
    let o = options.unwrap_or_default();
    let connect_timeout = o.connect_timeout.unwrap_or(Duration::from_secs(600));
    let first_byte_timeout = o.first_byte_timeout.unwrap_or(Duration::from_secs(600));
    let between_bytes_timeout = o.between_bytes_timeout.unwrap_or(Duration::from_secs(600));

    let stream = match tokio::time::timeout(connect_timeout, eg.connect(host.trim_start_matches('[').trim_end_matches(']'), port)).await {
        Ok(s) => s.map_err(Error::Connect)?,
        Err(_) => return Err(Error::ConnectionTimeout),
    };
    trait Io: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static {}
    impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static> Io for T {}
    let stream: Box<dyn Io> = if use_tls {
        let name = server_name(&authority)?;
        let tls = tokio::time::timeout(connect_timeout, tokio_rustls::TlsConnector::from(tls_client()).connect(name, stream))
            .await
            .map_err(|_| Error::ConnectionTimeout)?
            .map_err(Error::Tls)?;
        Box::new(tls)
    } else {
        Box::new(stream)
    };
    let (mut sender, conn) = tokio::time::timeout(connect_timeout, hyper::client::conn::http1::Builder::new().handshake(TokioIo::new(stream)))
        .await
        .map_err(|_| Error::ConnectionTimeout)??;
    // the request line carries the path only (the scheme and authority are for a proxy, and this is not one)
    *req.uri_mut() = http::Uri::builder()
        .path_and_query(req.uri().path_and_query().map(|p| p.as_str()).unwrap_or("/"))
        .build()
        .map_err(|_| Error::HttpRequestUriInvalid)?;

    let send = async move {
        let res = tokio::time::timeout(first_byte_timeout, sender.send_request(req))
            .await
            .map_err(|_| Error::ConnectionReadTimeout)?
            .map_err(Error::from)?;
        let mut timeout = tokio::time::interval(between_bytes_timeout);
        timeout.reset();
        Ok::<_, Error>(res.map(|incoming| Timed { incoming, timeout }))
    };
    let mut send = std::pin::pin!(send);
    let mut conn = Some(conn);
    // wait for the response while driving the connection
    let res = std::future::poll_fn(|cx| match send.as_mut().poll(cx) {
        Poll::Ready(r) => Poll::Ready(r),
        Poll::Pending => {
            let Some(fut) = conn.as_mut() else { return Poll::Pending };
            let r = std::task::ready!(Pin::new(fut).poll(cx));
            conn = None;
            match r {
                Ok(()) => send.as_mut().poll(cx),
                Err(e) => Poll::Ready(Err(Error::from(e))),
            }
        }
    })
    .await?;
    Ok((res, async move {
        let Some(conn) = conn.take() else { return Ok(()) };
        conn.await.map_err(|e| if e.is_timeout() { Error::HttpResponseTimeout } else { e.into() })
    }))
}

/// The response body, with the request's between-bytes timeout.
pub struct Timed {
    incoming: hyper::body::Incoming,
    timeout: tokio::time::Interval,
}
impl Body for Timed {
    type Data = Bytes;
    type Error = Error;
    fn poll_frame(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<std::result::Result<Frame<Bytes>, Error>>> {
        match Pin::new(&mut self.incoming).poll_frame(cx) {
            Poll::Ready(None) => Poll::Ready(None),
            Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(if e.is_timeout() { Error::HttpResponseTimeout } else { Error::from(e) }))),
            Poll::Ready(Some(Ok(f))) => {
                self.timeout.reset();
                Poll::Ready(Some(Ok(f)))
            }
            Poll::Pending => {
                std::task::ready!(self.timeout.poll_tick(cx));
                Poll::Ready(Some(Err(Error::ConnectionReadTimeout)))
            }
        }
    }
    fn is_end_stream(&self) -> bool {
        self.incoming.is_end_stream()
    }
    fn size_hint(&self) -> SizeHint {
        self.incoming.size_hint()
    }
}
