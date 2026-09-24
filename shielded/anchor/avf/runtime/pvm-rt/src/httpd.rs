//! wasi:http inside the pVM (PVM-CPU.md, "The app runtime", milestone 4): a `wasi:http/proxy` component -- the shape
//! of every Enclave HTTP app -- served inside the VM, unchanged.
//!
//! The component is verified and compiled ONCE (the same rules as `run_app`: W^X, digest before compile, no deserialise),
//! then pre-instantiated. The payload accepts each connection on its vsock port and hands the connected stream to
//! `serve_fd`, which speaks HTTP/1.1 on it (hyper) until the peer closes; every request gets a fresh instance in a fresh
//! Store -- its own memory limit, its own epoch deadline -- dropped when the request ends. With a model, every request's
//! wasi:nn sees the same one graph (nn.rs), so the engine's single sequence is never shared between requests.
//!
//! What a component cannot do here: open an outgoing connection (the VM has no network, and `send_request` refuses:
//! there is no TLS client in this build), reach a model other than the one registered, or keep state across requests
//! (a request's instance is dropped with its Store).

use crate::{engine_config, nn, verify_and_compile, NnModel};
use hyper::server::conn::http1;
use std::os::fd::{FromRawFd, RawFd};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use wasmtime::component::{Linker, ResourceTable};
use wasmtime::{Engine, Result, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};
use wasmtime_wasi_http::io::TokioIo;
use wasmtime_wasi_http::p2::bindings::http::types::{ErrorCode, Scheme};
use wasmtime_wasi_http::p2::bindings::ProxyPre;
use wasmtime_wasi_http::p2::body::HyperOutgoingBody;
use wasmtime_wasi_http::{WasiHttpCtx, WasiHttpCtxView, WasiHttpHooks, WasiHttpView};
use wasmtime_wasi_nn::wit::{WasiNnCtx, WasiNnView};

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
    nn: WasiNnCtx,
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
    pre: ProxyPre<HttpState>,
    rt: tokio::runtime::Runtime,
    graph: Option<(String, wasmtime_wasi_nn::Graph)>,
    mem_limit: usize,
    deadline_ticks: u64,
    stop: Arc<AtomicBool>,
    ticker: Option<std::thread::JoinHandle<()>>,
    requests: AtomicU64,
    /// the guest's stderr after each request, and the server's own notes (stream 2)
    log: Option<Box<dyn Fn(&[u8]) + Send + Sync>>,
    pub compile_ms: u128,
}

impl HttpServer {
    /// Verify (W^X, digest), compile once, pre-instantiate. A component whose imports this server does not provide --
    /// wasi:nn without a model, anything beyond wasi:cli/io/clocks/random/http -- is refused here, before any request.
    pub fn open(
        bundle: &[u8],
        expected_sha256: &[u8; 32],
        mem_limit: usize,
        request_deadline: Duration,
        model: Option<NnModel>,
        log: Option<Box<dyn Fn(&[u8]) + Send + Sync>>,
    ) -> Result<HttpServer> {
        if let Some(m) = &model {
            if !nn::valid_graph_name(&m.name) {
                wasmtime::bail!(
                    "graph name {:?} is not 1..64 of [a-z0-9._-]: refusing",
                    m.name
                );
            }
        }
        let engine = Engine::new(&engine_config()?)?; // async host calls need no setting of their own in wasmtime 49
        let t0 = Instant::now();
        let component = verify_and_compile(&engine, bundle, expected_sha256)?;
        let compile_ms = t0.elapsed().as_millis();
        let mut linker = Linker::<HttpState>::new(&engine);
        wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
        wasmtime_wasi_http::p2::add_only_http_to_linker_async(&mut linker)?;
        let graph = match model {
            Some(m) => {
                wasmtime_wasi_nn::wit::add_to_linker(&mut linker, |s: &mut HttpState| {
                    WasiNnView::new(&mut s.table, &mut s.nn)
                })?;
                Some((m.name, nn::graph(m.engine)))
            }
            None => None,
        };
        let pre = ProxyPre::new(linker.instantiate_pre(&component)?)?;
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
        let deadline_ticks = (request_deadline.as_millis() / TICK.as_millis()).max(1) as u64;
        Ok(HttpServer {
            pre,
            rt,
            graph,
            mem_limit,
            deadline_ticks,
            stop,
            ticker: Some(ticker),
            requests: AtomicU64::new(0),
            log,
            compile_ms,
        })
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
        self.rt.block_on(async {
            let stream = tokio::net::UnixStream::from_std(std_stream)?;
            http1::Builder::new()
                .keep_alive(true)
                .serve_connection(
                    TokioIo::new(stream),
                    hyper::service::service_fn(|req| self.handle(req)),
                )
                .await
                .map_err(|e| wasmtime::format_err!("the connection ended with an error: {e}"))
        })
    }

    async fn handle(
        &self,
        req: hyper::Request<hyper::body::Incoming>,
    ) -> Result<hyper::Response<HyperOutgoingBody>> {
        let n = self.requests.fetch_add(1, Ordering::Relaxed) + 1;
        let err = MemoryOutputPipe::new(1 << 16);
        let mut wasi = WasiCtx::builder();
        wasi.stderr(err.clone());
        let nn = match &self.graph {
            Some((name, g)) => nn::context_with(name, g.clone()),
            None => nn::context_none(),
        };
        let mut store = Store::new(
            self.pre.engine(),
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
                nn,
            },
        );
        store.limiter(|s| &mut s.limits);
        store.set_epoch_deadline(self.deadline_ticks);
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let wreq = store
            .data_mut()
            .http()
            .new_incoming_request(Scheme::Http, req)?;
        let out = store.data_mut().http().new_response_outparam(sender)?;
        let pre = self.pre.clone();
        // the handler runs beside the response, so a streamed body can continue after the headers; the Store (the
        // instance, its memory, its wasi:nn context) is dropped when the handler returns
        let task = tokio::task::spawn(async move {
            let proxy = pre.instantiate_async(&mut store).await?;
            let r = proxy
                .wasi_http_incoming_handler()
                .call_handle(&mut store, wreq, out)
                .await;
            drop(store);
            r
        });
        let res = match receiver.await {
            Ok(Ok(resp)) => Ok(resp),
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

impl Drop for HttpServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(t) = self.ticker.take() {
            let _ = t.join();
        }
    }
}
