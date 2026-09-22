//! The WASI host an ORDINARY platform app sees, implemented inside the enclave.
//!
//! Why this exists: every app in the platform's catalog is a `wasi:http` component. The enclave's
//! first app world (`enclave:app`) runs inside VTL1 but nothing in the catalog is built for it, so
//! the box could host nothing that already exists. This module is the other half: the host side of
//! wasi:io, wasi:http/types, wasi:cli, wasi:clocks and wasi:random, written for an enclave rather
//! than for an operating system, so a component published for the fleet runs in here unchanged.
//!
//! IT IS BUFFERED AND SINGLE-REQUEST, and that is a design decision rather than a shortcut. There
//! is no reactor in an enclave, no sockets and no other work to wait for: the host carries one
//! request through the gate, the guest handles it, and the response comes back. So:
//!   * `pollable` is always ready and `block()` returns immediately - there is nothing to wait for
//!     that is not already here.
//!   * the request body is in memory before the guest is called; the response body accumulates in
//!     memory and is read out after the handler returns.
//!   * an app that streams (server-sent events, chunked output) still works, but its output is
//!     delivered when the handler returns rather than as it is produced. A streaming path needs
//!     the frame protocol to grow, not this file.
//!
//! NO EGRESS. wasi:sockets is not imported and neither is wasi:http/outgoing-handler, so an app
//! that calls out fails to instantiate with a message that says why. An enclave has no network of
//! its own; brokering bytes through the host, with the app's own TLS inside the enclave so the host
//! carries ciphertext, is the next piece of work and is not pretended to exist here.
use alloc::{format, string::{String, ToString}, vec, vec::Vec};
use wasmtime::component::{Resource, ResourceTable};

wasmtime::component::bindgen!({
    path: "wit-wasi",
    world: "app-http",
    imports: { default: trappable },
    with: {
        "wasi:io/poll.pollable": Pollable,
        "wasi:io/error.error": IoError,
        "wasi:io/streams.input-stream": InputStream,
        "wasi:io/streams.output-stream": OutputStream,
        "wasi:http/types.fields": Fields,
        "wasi:http/types.incoming-request": IncomingRequest,
        "wasi:http/types.outgoing-request": OutgoingRequest,
        "wasi:http/types.request-options": RequestOptions,
        "wasi:http/types.response-outparam": ResponseOutparam,
        "wasi:http/types.incoming-response": IncomingResponse,
        "wasi:http/types.incoming-body": IncomingBody,
        "wasi:http/types.future-trailers": FutureTrailers,
        "wasi:http/types.outgoing-response": OutgoingResponse,
        "wasi:http/types.outgoing-body": OutgoingBody,
        "wasi:http/types.future-incoming-response": FutureIncomingResponse,
        "wasi:cli/terminal-input.terminal-input": TerminalNone,
        "wasi:cli/terminal-output.terminal-output": TerminalNone,
    },
});

use self::wasi::http::types as ht;
use self::wasi::io::streams::StreamError;

// ---- the resources, as plain data ------------------------------------------------------------
pub struct Pollable;                                  // always ready: see the header
pub struct IoError { pub msg: String }
pub struct TerminalNone;                              // an enclave has no terminal
pub struct Fields { pub list: Vec<(String, Vec<u8>)>, pub immutable: bool }
pub struct InputStream { pub data: Vec<u8>, pub pos: usize }
/// Where a guest's writes land. A body index rather than a pointer, because the response the guest
/// hands back later has to find the same bytes.
pub enum Sink { Body(usize), Log(bool) }              // Log(true) = stderr
pub struct OutputStream { pub sink: Sink }
pub struct IncomingRequest {
    pub method: ht::Method, pub path: Option<String>, pub scheme: Option<ht::Scheme>,
    pub authority: Option<String>, pub headers: Vec<(String, Vec<u8>)>, pub body: Option<Vec<u8>>,
}
pub struct IncomingBody { pub data: Option<Vec<u8>> }
pub struct FutureTrailers;
pub struct OutgoingResponse { pub status: u16, pub headers: Vec<(String, Vec<u8>)>, pub body: Option<usize> }
pub struct OutgoingBody { pub idx: usize, pub finished: bool }
/// Present so a guest that builds one gets a truthful refusal when it tries to send it, rather
/// than a missing import it cannot interpret.
pub struct OutgoingRequest { pub headers: Vec<(String, Vec<u8>)>, pub body: Option<usize> }
pub struct RequestOptions;
pub struct IncomingResponse;
pub struct FutureIncomingResponse;
pub struct ResponseOutparam;

/// What the host reads back out after the guest's handler returns.
///
/// The body is an INDEX, not bytes, and that is the whole subtlety of serving wasi:http: a handler
/// hands the response over first (`response-outparam.set`) and writes the body afterwards, because
/// on a real server the status line goes out before the body exists. Reading the bytes at set()
/// time returns an empty body for every app that streams its output, which is all of them.
pub struct Answered { pub status: u16, pub headers: Vec<(String, Vec<u8>)>, pub body: Option<usize> }

pub struct WasiState {
    pub table: ResourceTable,
    /// Response bodies, by index. The guest writes into one through an output-stream and hands
    /// back the response that names it.
    pub bodies: Vec<Vec<u8>>,
    pub answered: Option<Answered>,
    /// Set when the guest failed the request outright (response-outparam.set(err)).
    pub failed: Option<String>,
    /// The environment the app is launched with: the platform passes a version's config and the
    /// deployment's overrides this way (ENCLAVE_CONFIG), so an app reads its configuration here
    /// exactly as it does on a CVM.
    pub env: Vec<(String, String)>,
    pub now_ms: u64,
}

impl WasiState {
    pub fn new(env: Vec<(String, String)>) -> Self {
        Self { table: ResourceTable::new(), bodies: Vec::new(), answered: None, failed: None, env, now_ms: 0 }
    }
    fn body(&mut self) -> usize { self.bodies.push(Vec::new()); self.bodies.len() - 1 }
}

// The enclave's own services, from ee-app.cpp next door.
extern "C" {
    fn ee_app_now_ms() -> u64;
    fn ee_app_now_us() -> u64;
    fn ee_app_random(out: *mut u8, len: u32) -> i32;
    fn ee_app_log(p: *const u8, len: usize);
}
fn log_line(prefix: &str, bytes: &[u8]) {
    // Guest output is a line at a time into the deployment's log, which the operator and the
    // tenant both read. It is the app's own writing, so nothing of the enclave's leaks with it.
    let s = format!("{prefix}{}", core::str::from_utf8(bytes).unwrap_or("<non-utf8>"));
    let b = s.as_bytes();
    unsafe { ee_app_log(b.as_ptr(), b.len().min(4096)) }
}

// ---- wasi:io ---------------------------------------------------------------------------------
impl self::wasi::io::poll::HostPollable for WasiState {
    fn ready(&mut self, _p: Resource<Pollable>) -> wasmtime::Result<bool> { Ok(true) }
    fn block(&mut self, _p: Resource<Pollable>) -> wasmtime::Result<()> { Ok(()) }
    fn drop(&mut self, p: Resource<Pollable>) -> wasmtime::Result<()> { self.table.delete(p)?; Ok(()) }
}
impl self::wasi::io::poll::Host for WasiState {
    fn poll(&mut self, list: Vec<Resource<Pollable>>) -> wasmtime::Result<Vec<u32>> {
        // Everything here is ready by construction, so every index is returned. Returning an empty
        // list instead would spin a guest that loops until something is ready.
        Ok((0..list.len() as u32).collect())
    }
}
impl self::wasi::io::error::HostError for WasiState {
    fn to_debug_string(&mut self, e: Resource<IoError>) -> wasmtime::Result<String> {
        Ok(self.table.get(&e)?.msg.clone())
    }
    fn drop(&mut self, e: Resource<IoError>) -> wasmtime::Result<()> { self.table.delete(e)?; Ok(()) }
}
impl self::wasi::io::error::Host for WasiState {}

impl self::wasi::io::streams::HostInputStream for WasiState {
    fn read(&mut self, s: Resource<InputStream>, len: u64) -> wasmtime::Result<Result<Vec<u8>, StreamError>> {
        let st = self.table.get_mut(&s)?;
        if st.pos >= st.data.len() { return Ok(Err(StreamError::Closed)); }
        let end = (st.pos + len.min(1 << 24) as usize).min(st.data.len());
        let out = st.data[st.pos..end].to_vec();
        st.pos = end;
        Ok(Ok(out))
    }
    fn blocking_read(&mut self, s: Resource<InputStream>, len: u64) -> wasmtime::Result<Result<Vec<u8>, StreamError>> {
        // The whole body is already here: blocking and non-blocking are the same read.
        self.read(s, len)
    }
    fn skip(&mut self, s: Resource<InputStream>, len: u64) -> wasmtime::Result<Result<u64, StreamError>> {
        let st = self.table.get_mut(&s)?;
        if st.pos >= st.data.len() { return Ok(Err(StreamError::Closed)); }
        let end = (st.pos + len.min(1 << 24) as usize).min(st.data.len());
        let n = (end - st.pos) as u64;
        st.pos = end;
        Ok(Ok(n))
    }
    fn blocking_skip(&mut self, s: Resource<InputStream>, len: u64) -> wasmtime::Result<Result<u64, StreamError>> {
        self.skip(s, len)
    }
    fn subscribe(&mut self, _s: Resource<InputStream>) -> wasmtime::Result<Resource<Pollable>> {
        Ok(self.table.push(Pollable)?)
    }
    fn drop(&mut self, s: Resource<InputStream>) -> wasmtime::Result<()> { self.table.delete(s)?; Ok(()) }
}

const WRITE_BUDGET: u64 = 1 << 20;                    // what check-write reports it will take now
const BODY_CAP: usize = 16 << 20;                     // a response an enclave will hold, and say so

impl self::wasi::io::streams::HostOutputStream for WasiState {
    fn check_write(&mut self, _s: Resource<OutputStream>) -> wasmtime::Result<Result<u64, StreamError>> {
        Ok(Ok(WRITE_BUDGET))
    }
    fn write(&mut self, s: Resource<OutputStream>, contents: Vec<u8>) -> wasmtime::Result<Result<(), StreamError>> {
        let sink = match &self.table.get(&s)?.sink { Sink::Body(i) => Sink::Body(*i), Sink::Log(e) => Sink::Log(*e) };
        match sink {
            Sink::Body(i) => {
                let b = &mut self.bodies[i];
                if b.len() + contents.len() > BODY_CAP {
                    // Refuse rather than grow without bound: the response lives in enclave memory,
                    // which the model and the pads are also in.
                    return Ok(Err(StreamError::LastOperationFailed(
                        self.table.push(IoError { msg: format!("the response passed this enclave's {BODY_CAP}-byte limit") })?)));
                }
                b.extend_from_slice(&contents);
            }
            Sink::Log(err) => log_line(if err { "stderr: " } else { "stdout: " }, &contents),
        }
        Ok(Ok(()))
    }
    fn blocking_write_and_flush(&mut self, s: Resource<OutputStream>, contents: Vec<u8>) -> wasmtime::Result<Result<(), StreamError>> {
        self.write(s, contents)
    }
    fn flush(&mut self, _s: Resource<OutputStream>) -> wasmtime::Result<Result<(), StreamError>> { Ok(Ok(())) }
    fn blocking_flush(&mut self, _s: Resource<OutputStream>) -> wasmtime::Result<Result<(), StreamError>> { Ok(Ok(())) }
    fn subscribe(&mut self, _s: Resource<OutputStream>) -> wasmtime::Result<Resource<Pollable>> {
        Ok(self.table.push(Pollable)?)
    }
    fn write_zeroes(&mut self, s: Resource<OutputStream>, len: u64) -> wasmtime::Result<Result<(), StreamError>> {
        self.write(s, vec![0u8; len.min(WRITE_BUDGET) as usize])
    }
    fn blocking_write_zeroes_and_flush(&mut self, s: Resource<OutputStream>, len: u64) -> wasmtime::Result<Result<(), StreamError>> {
        self.write_zeroes(s, len)
    }
    fn splice(&mut self, dst: Resource<OutputStream>, src: Resource<InputStream>, len: u64) -> wasmtime::Result<Result<u64, StreamError>> {
        let chunk = match self::wasi::io::streams::HostInputStream::read(self, Resource::new_borrow(src.rep()), len)? {
            Ok(c) => c, Err(e) => return Ok(Err(e)) };
        let n = chunk.len() as u64;
        match self.write(dst, chunk)? { Ok(()) => Ok(Ok(n)), Err(e) => Ok(Err(e)) }
    }
    fn blocking_splice(&mut self, dst: Resource<OutputStream>, src: Resource<InputStream>, len: u64) -> wasmtime::Result<Result<u64, StreamError>> {
        self.splice(dst, src, len)
    }
    fn drop(&mut self, s: Resource<OutputStream>) -> wasmtime::Result<()> { self.table.delete(s)?; Ok(()) }
}
impl self::wasi::io::streams::Host for WasiState {}

// ---- wasi:clocks, wasi:random ----------------------------------------------------------------
impl self::wasi::clocks::monotonic_clock::Host for WasiState {
    fn now(&mut self) -> wasmtime::Result<u64> { Ok(unsafe { ee_app_now_us() } * 1_000) }
    fn resolution(&mut self) -> wasmtime::Result<u64> { Ok(1_000) }
    fn subscribe_instant(&mut self, _when: u64) -> wasmtime::Result<Resource<Pollable>> {
        // Ready at once. An enclave cannot sleep on the host's behalf, and a guest waiting for a
        // deadline that never arrives is worse than one that wakes early and finds nothing to do.
        Ok(self.table.push(Pollable)?)
    }
    fn subscribe_duration(&mut self, _d: u64) -> wasmtime::Result<Resource<Pollable>> {
        Ok(self.table.push(Pollable)?)
    }
}
impl self::wasi::clocks::wall_clock::Host for WasiState {
    fn now(&mut self) -> wasmtime::Result<self::wasi::clocks::wall_clock::Datetime> {
        // The host's clock, read when it called in: VTL1 has none of its own.
        let ms = if self.now_ms > 0 { self.now_ms } else { unsafe { ee_app_now_ms() } };
        Ok(self::wasi::clocks::wall_clock::Datetime { seconds: ms / 1000, nanoseconds: ((ms % 1000) * 1_000_000) as u32 })
    }
    fn resolution(&mut self) -> wasmtime::Result<self::wasi::clocks::wall_clock::Datetime> {
        Ok(self::wasi::clocks::wall_clock::Datetime { seconds: 0, nanoseconds: 1_000_000 })
    }
}
fn fill_random(n: u64) -> Vec<u8> {
    let mut v = vec![0u8; n.min(1 << 20) as usize];
    if !v.is_empty() && unsafe { ee_app_random(v.as_mut_ptr(), v.len() as u32) } != 0 { v.fill(0); }
    v
}
impl self::wasi::random::random::Host for WasiState {
    fn get_random_bytes(&mut self, len: u64) -> wasmtime::Result<Vec<u8>> { Ok(fill_random(len)) }
    fn get_random_u64(&mut self) -> wasmtime::Result<u64> {
        let b = fill_random(8);
        Ok(u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
    }
}
impl self::wasi::random::insecure::Host for WasiState {
    fn get_insecure_random_bytes(&mut self, len: u64) -> wasmtime::Result<Vec<u8>> { Ok(fill_random(len)) }
    fn get_insecure_random_u64(&mut self) -> wasmtime::Result<u64> {
        self::wasi::random::random::Host::get_random_u64(self)
    }
}
impl self::wasi::random::insecure_seed::Host for WasiState {
    fn insecure_seed(&mut self) -> wasmtime::Result<(u64, u64)> {
        use self::wasi::random::random::Host as R;
        Ok((R::get_random_u64(self)?, R::get_random_u64(self)?))
    }
}

// ---- wasi:cli --------------------------------------------------------------------------------
impl self::wasi::cli::environment::Host for WasiState {
    fn get_environment(&mut self) -> wasmtime::Result<Vec<(String, String)>> { Ok(self.env.clone()) }
    fn get_arguments(&mut self) -> wasmtime::Result<Vec<String>> { Ok(vec![]) }
    fn initial_cwd(&mut self) -> wasmtime::Result<Option<String>> { Ok(None) }
}
impl self::wasi::cli::exit::Host for WasiState {
    fn exit_with_code(&mut self, code: u8) -> wasmtime::Result<()> {
        Err(wasmtime::Error::msg(if code == 0 { "the app exited instead of answering" }
                                 else { "the app exited with a non-zero code" }))
    }
    fn exit(&mut self, status: Result<(), ()>) -> wasmtime::Result<()> {
        // A trap, not a process exit: there is no process here, and the enclave must not be taken
        // down by a guest. The host turns the trap into this deployment's failure reason.
        Err(wasmtime::Error::msg(if status.is_ok() { "the app called exit(0) instead of answering" }
                                 else { "the app called exit(1)" }))
    }
}
impl self::wasi::cli::stdin::Host for WasiState {
    fn get_stdin(&mut self) -> wasmtime::Result<Resource<InputStream>> {
        Ok(self.table.push(InputStream { data: Vec::new(), pos: 0 })?)    // always at end of file
    }
}
impl self::wasi::cli::stdout::Host for WasiState {
    fn get_stdout(&mut self) -> wasmtime::Result<Resource<OutputStream>> {
        Ok(self.table.push(OutputStream { sink: Sink::Log(false) })?)
    }
}
impl self::wasi::cli::stderr::Host for WasiState {
    fn get_stderr(&mut self) -> wasmtime::Result<Resource<OutputStream>> {
        Ok(self.table.push(OutputStream { sink: Sink::Log(true) })?)
    }
}
impl self::wasi::cli::terminal_input::HostTerminalInput for WasiState {
    fn drop(&mut self, t: Resource<TerminalNone>) -> wasmtime::Result<()> { self.table.delete(t)?; Ok(()) }
}
impl self::wasi::cli::terminal_input::Host for WasiState {}
impl self::wasi::cli::terminal_output::HostTerminalOutput for WasiState {
    fn drop(&mut self, t: Resource<TerminalNone>) -> wasmtime::Result<()> { self.table.delete(t)?; Ok(()) }
}
impl self::wasi::cli::terminal_output::Host for WasiState {}
impl self::wasi::cli::terminal_stdin::Host for WasiState {
    fn get_terminal_stdin(&mut self) -> wasmtime::Result<Option<Resource<TerminalNone>>> { Ok(None) }
}
impl self::wasi::cli::terminal_stdout::Host for WasiState {
    fn get_terminal_stdout(&mut self) -> wasmtime::Result<Option<Resource<TerminalNone>>> { Ok(None) }
}
impl self::wasi::cli::terminal_stderr::Host for WasiState {
    fn get_terminal_stderr(&mut self) -> wasmtime::Result<Option<Resource<TerminalNone>>> { Ok(None) }
}

// ---- wasi:http/types -------------------------------------------------------------------------
fn header_name_ok(name: &str) -> bool {
    !name.is_empty() && name.bytes().all(|c| matches!(c, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9'
        | b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~'))
}
fn header_value_ok(v: &[u8]) -> bool { v.iter().all(|&c| c >= 0x20 && c != 0x7f || c == b'\t') }

impl ht::HostFields for WasiState {
    fn new(&mut self) -> wasmtime::Result<Resource<Fields>> {
        Ok(self.table.push(Fields { list: Vec::new(), immutable: false })?)
    }
    fn from_list(&mut self, entries: Vec<(String, Vec<u8>)>) -> wasmtime::Result<Result<Resource<Fields>, ht::HeaderError>> {
        for (n, v) in &entries {
            if !header_name_ok(n) { return Ok(Err(ht::HeaderError::InvalidSyntax)); }
            if !header_value_ok(v) { return Ok(Err(ht::HeaderError::InvalidSyntax)); }
        }
        Ok(Ok(self.table.push(Fields { list: entries, immutable: false })?))
    }
    fn get(&mut self, f: Resource<Fields>, name: String) -> wasmtime::Result<Vec<Vec<u8>>> {
        let lower = name.to_lowercase();
        Ok(self.table.get(&f)?.list.iter().filter(|(n, _)| n.to_lowercase() == lower).map(|(_, v)| v.clone()).collect())
    }
    fn has(&mut self, f: Resource<Fields>, name: String) -> wasmtime::Result<bool> {
        let lower = name.to_lowercase();
        Ok(self.table.get(&f)?.list.iter().any(|(n, _)| n.to_lowercase() == lower))
    }
    fn set(&mut self, f: Resource<Fields>, name: String, values: Vec<Vec<u8>>) -> wasmtime::Result<Result<(), ht::HeaderError>> {
        if !header_name_ok(&name) || values.iter().any(|v| !header_value_ok(v)) { return Ok(Err(ht::HeaderError::InvalidSyntax)); }
        let fields = self.table.get_mut(&f)?;
        if fields.immutable { return Ok(Err(ht::HeaderError::Immutable)); }
        let lower = name.to_lowercase();
        fields.list.retain(|(n, _)| n.to_lowercase() != lower);
        for v in values { fields.list.push((name.clone(), v)); }
        Ok(Ok(()))
    }
    fn delete(&mut self, f: Resource<Fields>, name: String) -> wasmtime::Result<Result<(), ht::HeaderError>> {
        let fields = self.table.get_mut(&f)?;
        if fields.immutable { return Ok(Err(ht::HeaderError::Immutable)); }
        let lower = name.to_lowercase();
        fields.list.retain(|(n, _)| n.to_lowercase() != lower);
        Ok(Ok(()))
    }
    fn append(&mut self, f: Resource<Fields>, name: String, value: Vec<u8>) -> wasmtime::Result<Result<(), ht::HeaderError>> {
        if !header_name_ok(&name) || !header_value_ok(&value) { return Ok(Err(ht::HeaderError::InvalidSyntax)); }
        let fields = self.table.get_mut(&f)?;
        if fields.immutable { return Ok(Err(ht::HeaderError::Immutable)); }
        fields.list.push((name, value));
        Ok(Ok(()))
    }
    fn entries(&mut self, f: Resource<Fields>) -> wasmtime::Result<Vec<(String, Vec<u8>)>> {
        Ok(self.table.get(&f)?.list.clone())
    }
    fn clone(&mut self, f: Resource<Fields>) -> wasmtime::Result<Resource<Fields>> {
        let list = self.table.get(&f)?.list.clone();
        Ok(self.table.push(Fields { list, immutable: false })?)
    }
    fn drop(&mut self, f: Resource<Fields>) -> wasmtime::Result<()> { self.table.delete(f)?; Ok(()) }
}

impl ht::HostIncomingRequest for WasiState {
    fn method(&mut self, r: Resource<IncomingRequest>) -> wasmtime::Result<ht::Method> {
        Ok(self.table.get(&r)?.method.clone())
    }
    fn path_with_query(&mut self, r: Resource<IncomingRequest>) -> wasmtime::Result<Option<String>> {
        Ok(self.table.get(&r)?.path.clone())
    }
    fn scheme(&mut self, r: Resource<IncomingRequest>) -> wasmtime::Result<Option<ht::Scheme>> {
        Ok(self.table.get(&r)?.scheme.clone())
    }
    fn authority(&mut self, r: Resource<IncomingRequest>) -> wasmtime::Result<Option<String>> {
        Ok(self.table.get(&r)?.authority.clone())
    }
    fn headers(&mut self, r: Resource<IncomingRequest>) -> wasmtime::Result<Resource<Fields>> {
        // Immutable, as the interface requires: these are the bytes that arrived.
        let list = self.table.get(&r)?.headers.clone();
        Ok(self.table.push(Fields { list, immutable: true })?)
    }
    fn consume(&mut self, r: Resource<IncomingRequest>) -> wasmtime::Result<Result<Resource<IncomingBody>, ()>> {
        let req = self.table.get_mut(&r)?;
        match req.body.take() {
            Some(data) => Ok(Ok(self.table.push(IncomingBody { data: Some(data) })?)),
            None => Ok(Err(())),                       // consume() is once, per the interface
        }
    }
    fn drop(&mut self, r: Resource<IncomingRequest>) -> wasmtime::Result<()> { self.table.delete(r)?; Ok(()) }
}

impl ht::HostIncomingBody for WasiState {
    fn stream(&mut self, b: Resource<IncomingBody>) -> wasmtime::Result<Result<Resource<InputStream>, ()>> {
        let body = self.table.get_mut(&b)?;
        match body.data.take() {
            Some(data) => Ok(Ok(self.table.push(InputStream { data, pos: 0 })?)),
            None => Ok(Err(())),
        }
    }
    fn finish(&mut self, b: Resource<IncomingBody>) -> wasmtime::Result<Resource<FutureTrailers>> {
        self.table.delete(b)?;
        Ok(self.table.push(FutureTrailers)?)
    }
    fn drop(&mut self, b: Resource<IncomingBody>) -> wasmtime::Result<()> { self.table.delete(b)?; Ok(()) }
}
impl ht::HostFutureTrailers for WasiState {
    fn subscribe(&mut self, _f: Resource<FutureTrailers>) -> wasmtime::Result<Resource<Pollable>> {
        Ok(self.table.push(Pollable)?)
    }
    #[allow(clippy::type_complexity)]
    fn get(&mut self, _f: Resource<FutureTrailers>)
        -> wasmtime::Result<Option<Result<Result<Option<Resource<Fields>>, ht::ErrorCode>, ()>>> {
        Ok(Some(Ok(Ok(None))))                         // ready, and there are no trailers
    }
    fn drop(&mut self, f: Resource<FutureTrailers>) -> wasmtime::Result<()> { self.table.delete(f)?; Ok(()) }
}

impl ht::HostOutgoingResponse for WasiState {
    fn new(&mut self, headers: Resource<Fields>) -> wasmtime::Result<Resource<OutgoingResponse>> {
        let list = self.table.get(&headers)?.list.clone();
        self.table.delete(headers)?;                   // the constructor consumes them
        Ok(self.table.push(OutgoingResponse { status: 200, headers: list, body: None })?)
    }
    fn status_code(&mut self, r: Resource<OutgoingResponse>) -> wasmtime::Result<u16> {
        Ok(self.table.get(&r)?.status)
    }
    fn set_status_code(&mut self, r: Resource<OutgoingResponse>, status: u16) -> wasmtime::Result<Result<(), ()>> {
        if !(100..=999).contains(&status) { return Ok(Err(())); }
        self.table.get_mut(&r)?.status = status;
        Ok(Ok(()))
    }
    fn headers(&mut self, r: Resource<OutgoingResponse>) -> wasmtime::Result<Resource<Fields>> {
        let list = self.table.get(&r)?.headers.clone();
        Ok(self.table.push(Fields { list, immutable: true })?)
    }
    fn body(&mut self, r: Resource<OutgoingResponse>) -> wasmtime::Result<Result<Resource<OutgoingBody>, ()>> {
        if self.table.get(&r)?.body.is_some() { return Ok(Err(())); }   // body() is once
        let idx = self.body();
        self.table.get_mut(&r)?.body = Some(idx);
        Ok(Ok(self.table.push(OutgoingBody { idx, finished: false })?))
    }
    fn drop(&mut self, r: Resource<OutgoingResponse>) -> wasmtime::Result<()> { self.table.delete(r)?; Ok(()) }
}

impl ht::HostOutgoingBody for WasiState {
    fn write(&mut self, b: Resource<OutgoingBody>) -> wasmtime::Result<Result<Resource<OutputStream>, ()>> {
        let idx = self.table.get(&b)?.idx;
        Ok(Ok(self.table.push(OutputStream { sink: Sink::Body(idx) })?))
    }
    fn finish(&mut self, b: Resource<OutgoingBody>, _trailers: Option<Resource<Fields>>)
        -> wasmtime::Result<Result<(), ht::ErrorCode>> {
        self.table.get_mut(&b)?.finished = true;
        self.table.delete(b)?;
        Ok(Ok(()))
    }
    fn drop(&mut self, b: Resource<OutgoingBody>) -> wasmtime::Result<()> { self.table.delete(b)?; Ok(()) }
}

impl ht::HostResponseOutparam for WasiState {
    fn set(&mut self, param: Resource<ResponseOutparam>,
           response: Result<Resource<OutgoingResponse>, ht::ErrorCode>) -> wasmtime::Result<()> {
        self.table.delete(param)?;
        match response {
            Ok(r) => {
                // The response record is taken now (the guest gave it up), but its BODY is read
                // after the handler returns: see Answered.
                let resp = self.table.delete(r)?;
                self.answered = Some(Answered { status: resp.status, headers: resp.headers, body: resp.body });
            }
            Err(e) => self.failed = Some(format!("{e:?}")),
        }
        Ok(())
    }
    fn send_informational(&mut self, _p: Resource<ResponseOutparam>, _status: u16, headers: Resource<Fields>)
        -> wasmtime::Result<Result<(), ht::ErrorCode>> {
        self.table.delete(headers)?;
        // 1xx interim responses need a live connection to write onto, and the host holds that, not
        // the enclave. Accepted and dropped rather than refused: nothing downstream depends on it.
        Ok(Ok(()))
    }
    fn drop(&mut self, p: Resource<ResponseOutparam>) -> wasmtime::Result<()> { self.table.delete(p)?; Ok(()) }
}

// ---- the outbound half: present, and honest about not being connected ------------------------
const NO_EGRESS: &str = "this enclave provides no outbound network: an app inside a VBS enclave \
                         has no socket of its own, and the host is not asked to make requests on \
                         its behalf";
impl ht::HostOutgoingRequest for WasiState {
    fn new(&mut self, headers: Resource<Fields>) -> wasmtime::Result<Resource<OutgoingRequest>> {
        let list = self.table.get(&headers)?.list.clone();
        self.table.delete(headers)?;
        Ok(self.table.push(OutgoingRequest { headers: list, body: None })?)
    }
    fn body(&mut self, r: Resource<OutgoingRequest>) -> wasmtime::Result<Result<Resource<OutgoingBody>, ()>> {
        if self.table.get(&r)?.body.is_some() { return Ok(Err(())); }
        let idx = self.body();
        self.table.get_mut(&r)?.body = Some(idx);
        Ok(Ok(self.table.push(OutgoingBody { idx, finished: false })?))
    }
    fn method(&mut self, _r: Resource<OutgoingRequest>) -> wasmtime::Result<ht::Method> { Ok(ht::Method::Get) }
    fn set_method(&mut self, _r: Resource<OutgoingRequest>, _m: ht::Method) -> wasmtime::Result<Result<(), ()>> { Ok(Ok(())) }
    fn path_with_query(&mut self, _r: Resource<OutgoingRequest>) -> wasmtime::Result<Option<String>> { Ok(None) }
    fn set_path_with_query(&mut self, _r: Resource<OutgoingRequest>, _p: Option<String>) -> wasmtime::Result<Result<(), ()>> { Ok(Ok(())) }
    fn scheme(&mut self, _r: Resource<OutgoingRequest>) -> wasmtime::Result<Option<ht::Scheme>> { Ok(None) }
    fn set_scheme(&mut self, _r: Resource<OutgoingRequest>, _s: Option<ht::Scheme>) -> wasmtime::Result<Result<(), ()>> { Ok(Ok(())) }
    fn authority(&mut self, _r: Resource<OutgoingRequest>) -> wasmtime::Result<Option<String>> { Ok(None) }
    fn set_authority(&mut self, _r: Resource<OutgoingRequest>, _a: Option<String>) -> wasmtime::Result<Result<(), ()>> { Ok(Ok(())) }
    fn headers(&mut self, r: Resource<OutgoingRequest>) -> wasmtime::Result<Resource<Fields>> {
        let list = self.table.get(&r)?.headers.clone();
        Ok(self.table.push(Fields { list, immutable: true })?)
    }
    fn drop(&mut self, r: Resource<OutgoingRequest>) -> wasmtime::Result<()> { self.table.delete(r)?; Ok(()) }
}
impl ht::HostRequestOptions for WasiState {
    fn new(&mut self) -> wasmtime::Result<Resource<RequestOptions>> { Ok(self.table.push(RequestOptions)?) }
    fn connect_timeout(&mut self, _o: Resource<RequestOptions>) -> wasmtime::Result<Option<u64>> { Ok(None) }
    fn set_connect_timeout(&mut self, _o: Resource<RequestOptions>, _d: Option<u64>) -> wasmtime::Result<Result<(), ()>> { Ok(Ok(())) }
    fn first_byte_timeout(&mut self, _o: Resource<RequestOptions>) -> wasmtime::Result<Option<u64>> { Ok(None) }
    fn set_first_byte_timeout(&mut self, _o: Resource<RequestOptions>, _d: Option<u64>) -> wasmtime::Result<Result<(), ()>> { Ok(Ok(())) }
    fn between_bytes_timeout(&mut self, _o: Resource<RequestOptions>) -> wasmtime::Result<Option<u64>> { Ok(None) }
    fn set_between_bytes_timeout(&mut self, _o: Resource<RequestOptions>, _d: Option<u64>) -> wasmtime::Result<Result<(), ()>> { Ok(Ok(())) }
    fn drop(&mut self, o: Resource<RequestOptions>) -> wasmtime::Result<()> { self.table.delete(o)?; Ok(()) }
}
impl ht::HostIncomingResponse for WasiState {
    fn status(&mut self, _r: Resource<IncomingResponse>) -> wasmtime::Result<u16> { Err(wasmtime::Error::msg(NO_EGRESS)) }
    fn headers(&mut self, _r: Resource<IncomingResponse>) -> wasmtime::Result<Resource<Fields>> { Err(wasmtime::Error::msg(NO_EGRESS)) }
    fn consume(&mut self, _r: Resource<IncomingResponse>) -> wasmtime::Result<Result<Resource<IncomingBody>, ()>> { Err(wasmtime::Error::msg(NO_EGRESS)) }
    fn drop(&mut self, r: Resource<IncomingResponse>) -> wasmtime::Result<()> { self.table.delete(r)?; Ok(()) }
}
impl ht::HostFutureIncomingResponse for WasiState {
    fn subscribe(&mut self, _f: Resource<FutureIncomingResponse>) -> wasmtime::Result<Resource<Pollable>> {
        Ok(self.table.push(Pollable)?)
    }
    #[allow(clippy::type_complexity)]
    fn get(&mut self, _f: Resource<FutureIncomingResponse>)
        -> wasmtime::Result<Option<Result<Result<Resource<IncomingResponse>, ht::ErrorCode>, ()>>> {
        Ok(Some(Ok(Err(ht::ErrorCode::InternalError(Some(NO_EGRESS.to_string()))))))
    }
    fn drop(&mut self, f: Resource<FutureIncomingResponse>) -> wasmtime::Result<()> { self.table.delete(f)?; Ok(()) }
}
impl ht::Host for WasiState {
    fn http_error_code(&mut self, _e: Resource<IoError>) -> wasmtime::Result<Option<ht::ErrorCode>> { Ok(None) }
}

impl self::wasi::http::outgoing_handler::Host for WasiState {
    fn handle(&mut self, request: Resource<OutgoingRequest>, options: Option<Resource<RequestOptions>>)
        -> wasmtime::Result<Result<Resource<FutureIncomingResponse>, ht::ErrorCode>> {
        // The app built a request; there is nowhere to send it. Refused HERE, by name, so the
        // failure reaches the app as an error code it can report rather than a hang or a trap.
        self.table.delete(request)?;
        if let Some(o) = options { self.table.delete(o)?; }
        Ok(Err(ht::ErrorCode::InternalError(Some(NO_EGRESS.to_string()))))
    }
}

/// Run ONE request through an ordinary wasi:http app, from the host's frame and back to it.
///
/// The shape of this function is the whole of the buffered contract: build the request in enclave
/// memory, hand the guest a response-outparam, call its handler, and read out whatever it set. A
/// guest that returns without setting one has not answered, and that is reported rather than
/// turned into an empty 200.
pub fn serve(store: &mut wasmtime::Store<WasiState>, app: &AppHttp,
             req: &crate::enclave::app::types::Request) -> Result<alloc::vec::Vec<u8>, String> {
    let method = match req.method.to_ascii_uppercase().as_str() {
        "GET" => ht::Method::Get, "HEAD" => ht::Method::Head, "POST" => ht::Method::Post,
        "PUT" => ht::Method::Put, "DELETE" => ht::Method::Delete, "CONNECT" => ht::Method::Connect,
        "OPTIONS" => ht::Method::Options, "TRACE" => ht::Method::Trace, "PATCH" => ht::Method::Patch,
        other => ht::Method::Other(other.to_string()),
    };
    let authority = req.headers.iter()
        .find(|h| h.name.eq_ignore_ascii_case("host"))
        .map(|h| h.value.clone());
    let headers: Vec<(String, Vec<u8>)> = req.headers.iter()
        .map(|h| (h.name.clone(), h.value.as_bytes().to_vec()))
        .collect();

    let st = store.data_mut();
    st.bodies.clear();
    st.answered = None;
    st.failed = None;
    let incoming = st.table.push(IncomingRequest {
        method, path: Some(req.path.clone()),
        // The request reached the relay over TLS and the relay is the platform's: https is what
        // the client actually used, and an app that builds absolute URLs from this would otherwise
        // hand its users http:// links.
        scheme: Some(ht::Scheme::Https), authority,
        headers, body: Some(req.body.clone()),
    }).map_err(|e| format!("request: {e}"))?;
    let outparam = st.table.push(ResponseOutparam).map_err(|e| format!("outparam: {e}"))?;

    app.wasi_http_incoming_handler()
        .call_handle(&mut *store, incoming, outparam)
        .map_err(|e| format!("the app trapped: {e:?}"))?;

    let st = store.data_mut();
    if let Some(why) = st.failed.take() { return Err(format!("the app refused the request: {why}")); }
    let a = st.answered.take().ok_or_else(||
        String::from("the app's handler returned without setting a response"))?;
    let body = a.body.map(|i| core::mem::take(&mut st.bodies[i])).unwrap_or_default();
    // Back into the host's frame, the same encoder the enclave world uses.
    let mut v = Vec::with_capacity(body.len() + 64);
    v.extend_from_slice(&a.status.to_le_bytes());
    v.extend_from_slice(&(a.headers.len() as u32).to_le_bytes());
    for (n, val) in &a.headers {
        v.extend_from_slice(&(n.len() as u32).to_le_bytes()); v.extend_from_slice(n.as_bytes());
        v.extend_from_slice(&(val.len() as u32).to_le_bytes()); v.extend_from_slice(val);
    }
    v.extend_from_slice(&(body.len() as u32).to_le_bytes());
    v.extend_from_slice(&body);
    Ok(v)
}
