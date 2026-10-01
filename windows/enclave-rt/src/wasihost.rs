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
    world: "app-host",
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
        "wasi:sockets/network.network": Network,
        "wasi:sockets/tcp.tcp-socket": TcpSocket,
        "wasi:sockets/udp.udp-socket": UdpSocket,
        "wasi:sockets/udp.incoming-datagram-stream": IncomingDatagramStream,
        "wasi:sockets/udp.outgoing-datagram-stream": OutgoingDatagramStream,
        "wasi:sockets/ip-name-lookup.resolve-address-stream": ResolveAddressStream,
        "wasi:filesystem/types.descriptor": Descriptor,
        "wasi:filesystem/types.directory-entry-stream": DirectoryEntryStream,
    },
});

use self::wasi::http::types as ht;
use self::wasi::io::streams::StreamError;

// ---- the resources, as plain data ------------------------------------------------------------
/// Either there is nothing to wait for, or there is a socket the HOST holds and the guest must
/// actually block on. The second case is what makes a server possible in here: without it a guest
/// spins on would-block and burns an enclave thread serving nothing.
pub enum Pollable {
    /// Nothing to wait for: a buffer that already holds bytes, a resolver that already answered.
    Ready,
    /// A socket the HOST holds. This is what makes a server possible in here: without it a guest
    /// spins on would-block and burns an enclave thread serving nothing.
    Socket { handle: i32, events: u32 },
    /// A DEADLINE, in the monotonic nanoseconds this host reports. Also not optional: the real
    /// apps are single-threaded event loops that "accept, dispatch, then sleep a little", and a
    /// timer that is always ready turns that sleep into a spin at 100% of an enclave thread.
    Timer { deadline_ns: u64 },
}
pub struct IoError { pub msg: String }
pub struct TerminalNone;                              // an enclave has no terminal
pub struct Fields { pub list: Vec<(String, Vec<u8>)>, pub immutable: bool }
/// Either bytes already in enclave memory (a request body) or a socket the host holds.
pub struct InputStream { pub data: Vec<u8>, pub pos: usize, pub socket: Option<i32> }
/// Where a guest's writes land. A body index rather than a pointer, because the response the guest
/// hands back later has to find the same bytes.
pub enum Sink { Body(usize), Log(bool), Socket(i32) }   // Log(true) = stderr
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
    /// Every host socket this app currently holds, so all of them are closed when the store is torn
    /// down -- including after a trap, when the guest never gets to drop them. See netset.rs.
    sockets: crate::netset::SocketSet,
}

impl Drop for WasiState {
    fn drop(&mut self) {
        // Close any socket the guest did not close itself. A guest-closed socket was removed from
        // the set in tcp-socket.drop and is not touched again, so each handle closes exactly once.
        for h in self.sockets.drain() {
            unsafe { ee_net_close(h) }
        }
    }
}

impl WasiState {
    pub fn new(env: Vec<(String, String)>) -> Self {
        Self { table: ResourceTable::new(), bodies: Vec::new(), answered: None, failed: None, env, now_ms: 0,
               sockets: crate::netset::SocketSet::new() }
    }
    fn body(&mut self) -> usize { self.bodies.push(Vec::new()); self.bodies.len() - 1 }
}

// The enclave's own services, from ee-app.cpp next door.
extern "C" {
    fn ee_app_now_ms() -> u64;
    fn ee_app_now_us() -> u64;
    fn ee_app_random(out: *mut u8, len: u32) -> i32;
    fn ee_app_log(p: *const u8, len: usize);
    // The brokered sockets. The host owns them, the guest runs its own TLS over them.
    fn ee_net_listen(port: u16, bound: *mut u16) -> i32;
    fn ee_net_accept(h: i32) -> i32;
    fn ee_net_connect(addr: *const u8, port: u16) -> i32;
    fn ee_net_send(h: i32, p: *const u8, n: usize) -> i64;
    fn ee_net_recv(h: i32, p: *mut u8, n: usize) -> i64;
    fn ee_net_close(h: i32);
    fn ee_net_poll(handles: *mut u32, events: *mut u32, n: usize, timeout_ms: u32) -> i32;
    fn ee_net_resolve(name: *const u8, out: *mut u8, cap: usize) -> i32;
    /// The enclave's own sleep (ee-rt.c). Used in slices, so that a guest asleep for a second is
    /// still stopped promptly when its lease ends.
    fn ee_sleep_ms(ms: u32);
    /// Socket tracing, from the enclave's environment (ENCLAVE_RT_TRACE=1).
    fn ee_app_trace() -> i32;
}
fn traced() -> bool { (unsafe { ee_app_trace() }) >= 1 }
/// Level 2: a line per read and per write. That is one line per DATAGRAM, so a tenant streaming a
/// framebuffer buries every lifecycle event under megabytes of it - keep it out of level 1.
fn traced_io() -> bool { (unsafe { ee_app_trace() }) >= 2 }
fn trace(msg: &str) {
    if !traced() { return; }
    let s = format!("[rt] {msg}");
    let b = s.as_bytes();
    unsafe { ee_app_log(b.as_ptr(), b.len().min(512)) }
}
/// The per-datagram form. It takes a closure so that with tracing off - which is every deployment
/// that is not being debugged - the hot socket path does not format or allocate anything at all.
fn trace_io(msg: impl FnOnce() -> String) {
    if !traced_io() { return; }
    trace(&msg());
}
fn now_ns() -> u64 { unsafe { ee_app_now_us() }.saturating_mul(1_000) }
/// Sleep towards a deadline, in slices. A whole sleep in one call would hold the thread past a
/// stop request, and epoch interruption only traps code that is RUNNING.
const SLEEP_SLICE_MS: u32 = 25;
fn sleep_until(deadline_ns: u64) {
    loop {
        let now = now_ns();
        if now >= deadline_ns { return; }
        let ms = ((deadline_ns - now) / 1_000_000).min(SLEEP_SLICE_MS as u64) as u32;
        unsafe { ee_sleep_ms(if ms == 0 { 1 } else { ms }) }
        if ms == 0 { return; }
    }
}
const POLL_READ: u32 = 1;
const POLL_WRITE: u32 = 2;
const EAGAIN: i64 = -11;
/// How long one wait at the host lasts before this side loops. A guest blocking on a quiet socket
/// should not hold a call-out slot forever, and the loop is what lets an interrupted app (epoch)
/// notice it has been asked to stop.
const POLL_SLICE_MS: u32 = 2_000;

/// Wait until one of these host sockets is ready, or until `timeout_ms` if one is given (None =
/// wait as long as it takes). Returns the indices that are ready, which may be empty on a timeout.
fn wait_ready_until(items: &[(i32, u32)], timeout_ms: Option<u32>) -> Vec<usize> {
    if items.is_empty() { return Vec::new(); }
    let mut handles: Vec<u32> = items.iter().map(|(h, _)| *h as u32).collect();
    let mut events: Vec<u32> = items.iter().map(|(_, e)| *e).collect();
    let mut left = timeout_ms;
    loop {
        let slice = match left { Some(t) => t.min(POLL_SLICE_MS), None => POLL_SLICE_MS };
        let n = unsafe { ee_net_poll(handles.as_mut_ptr(), events.as_mut_ptr(), items.len(), slice) };
        if n < 0 { return (0..items.len()).collect(); }     // the host refused: let the guest find out
        let ready: Vec<usize> = events.iter().enumerate().filter(|(_, e)| **e != 0).map(|(i, _)| i).collect();
        if !ready.is_empty() { return ready; }
        // Restore what we asked for, since the host overwrote it with what was ready.
        for (i, (_, e)) in items.iter().enumerate() { events[i] = *e; }
        match left {
            Some(t) if t <= slice => return Vec::new(),
            Some(t) => left = Some(t - slice),
            None => {}                                     // a timeout is not an answer: keep waiting
        }
    }
}
/// Wait with no deadline. WASI's poll must not answer an empty list, so this one loops.
fn wait_ready(items: &[(i32, u32)]) -> Vec<usize> { wait_ready_until(items, None) }
fn log_line(prefix: &str, bytes: &[u8]) {
    // Guest output is a line at a time into the deployment's log, which the operator and the
    // tenant both read. It is the app's own writing, so nothing of the enclave's leaks with it.
    let s = format!("{prefix}{}", core::str::from_utf8(bytes).unwrap_or("<non-utf8>"));
    let b = s.as_bytes();
    unsafe { ee_app_log(b.as_ptr(), b.len().min(4096)) }
}

// ---- wasi:io ---------------------------------------------------------------------------------
impl self::wasi::io::poll::HostPollable for WasiState {
    fn ready(&mut self, p: Resource<Pollable>) -> wasmtime::Result<bool> {
        match self.table.get(&p)? {
            Pollable::Ready => Ok(true),
            &Pollable::Timer { deadline_ns } => Ok(now_ns() >= deadline_ns),
            &Pollable::Socket { handle, events } => {
                // A peek, not a wait: ask the host with no timeout at all.
                let mut h = [handle as u32]; let mut e = [events];
                let n = unsafe { ee_net_poll(h.as_mut_ptr(), e.as_mut_ptr(), 1, 0) };
                Ok(n > 0)
            }
        }
    }
    fn block(&mut self, p: Resource<Pollable>) -> wasmtime::Result<()> {
        match self.table.get(&p)? {
            Pollable::Ready => Ok(()),
            &Pollable::Timer { deadline_ns } => { sleep_until(deadline_ns); Ok(()) }
            &Pollable::Socket { handle, events } => {
                trace(&format!("block on socket {handle} (events {events})"));
                wait_ready(&[(handle, events)]);
                Ok(())
            }
        }
    }
    fn drop(&mut self, p: Resource<Pollable>) -> wasmtime::Result<()> { self.table.delete(p)?; Ok(()) }
}
impl self::wasi::io::poll::Host for WasiState {
    fn poll(&mut self, list: Vec<Resource<Pollable>>) -> wasmtime::Result<Vec<u32>> {
        // Anything that is ready by construction (a buffer, a clock this side cannot wait on)
        // makes the whole call return at once. Otherwise this is a real wait on the host's
        // sockets, which is what lets a server sit idle in here without burning a thread.
        let mut sockets: Vec<(usize, i32, u32)> = Vec::new();
        let mut timers: Vec<(usize, u64)> = Vec::new();
        let mut immediate: Vec<u32> = Vec::new();
        for (i, p) in list.iter().enumerate() {
            match self.table.get(p)? {
                Pollable::Ready => immediate.push(i as u32),
                &Pollable::Timer { deadline_ns } => {
                    if now_ns() >= deadline_ns { immediate.push(i as u32) } else { timers.push((i, deadline_ns)) }
                }
                &Pollable::Socket { handle, events } => sockets.push((i, handle, events)),
            }
        }
        if !immediate.is_empty() {
            trace(&format!("poll: {} ready immediately of {}", immediate.len(), list.len()));
            return Ok(immediate);
        }
        let soonest = timers.iter().map(|(_, d)| *d).min();
        trace(&format!("poll: {} socket(s) {:?}, {} timer(s), soonest in {} ms",
            sockets.len(), sockets.iter().map(|(_, h, e)| (*h, *e)).collect::<Vec<_>>(), timers.len(),
            soonest.map(|d| (d.saturating_sub(now_ns())) / 1_000_000).unwrap_or(0)));
        // This is the shape of every real app's loop: some sockets, and a timer that says how long
        // to wait if none of them speaks. Waiting on the sockets with the timer as the timeout is
        // what turns that loop from a spin into an idle thread.
        if !sockets.is_empty() {
            let items: Vec<(i32, u32)> = sockets.iter().map(|(_, h, e)| (*h, *e)).collect();
            let timeout_ms = soonest.map(|d| {
                let now = now_ns();
                if d <= now { 0 } else { ((d - now) / 1_000_000).min(u32::MAX as u64) as u32 }
            });
            let ready = wait_ready_until(&items, timeout_ms);
            trace(&format!("poll: waited {:?} ms -> {} ready", timeout_ms, ready.len()));
            if !ready.is_empty() { return Ok(ready.into_iter().map(|k| sockets[k].0 as u32).collect()); }
            // Nothing spoke before the timer came due, so the timer is the answer.
            let now = now_ns();
            let fired: Vec<u32> = timers.iter().filter(|(_, d)| *d <= now).map(|(i, _)| *i as u32).collect();
            if !fired.is_empty() { return Ok(fired); }
            return Ok(Vec::new());                     // a slice expired: the guest polls again
        }
        if let Some(d) = soonest {
            sleep_until(d);
            let now = now_ns();
            return Ok(timers.iter().filter(|(_, dl)| *dl <= now).map(|(i, _)| *i as u32).collect());
        }
        Ok(Vec::new())
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
        if let Some(h) = self.table.get(&s)?.socket {
            // A socket read: empty means "nothing yet" (the guest polls and comes back), and a
            // zero-length recv from the host means the peer is gone, which is Closed.
            let want = len.min(64 * 1024) as usize;
            let mut buf = vec![0u8; want.max(1)];
            let n = unsafe { ee_net_recv(h, buf.as_mut_ptr(), want) };
            trace_io(|| format!("read {h} want {want} -> {n}"));
            return Ok(match n {
                0 => Err(StreamError::Closed),
                EAGAIN => Ok(Vec::new()),
                n if n < 0 => Err(StreamError::LastOperationFailed(
                    self.table.push(IoError { msg: format!("socket read failed ({n})") })?)),
                n => { buf.truncate(n as usize); Ok(buf) }
            });
        }
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
    fn subscribe(&mut self, s: Resource<InputStream>) -> wasmtime::Result<Resource<Pollable>> {
        let p = match self.table.get(&s)?.socket {
            Some(handle) => Pollable::Socket { handle, events: POLL_READ },
            None => Pollable::Ready,
        };
        Ok(self.table.push(p)?)
    }
    fn drop(&mut self, s: Resource<InputStream>) -> wasmtime::Result<()> { self.table.delete(s)?; Ok(()) }
}

const WRITE_BUDGET: u64 = 1 << 20;                    // what check-write reports it will take now
const BODY_CAP: usize = 16 << 20;                     // a response an enclave will hold, and say so

impl self::wasi::io::streams::HostOutputStream for WasiState {
    fn check_write(&mut self, s: Resource<OutputStream>) -> wasmtime::Result<Result<u64, StreamError>> {
        // A socket takes what the host's send buffer takes; 64 KiB is the chunk this side copies
        // through the call-out anyway, and std writes in chunks regardless.
        Ok(Ok(match &self.table.get(&s)?.sink { Sink::Socket(_) => 64 * 1024, _ => WRITE_BUDGET }))
    }
    fn write(&mut self, s: Resource<OutputStream>, contents: Vec<u8>) -> wasmtime::Result<Result<(), StreamError>> {
        let sink = match &self.table.get(&s)?.sink {
            Sink::Body(i) => Sink::Body(*i), Sink::Log(e) => Sink::Log(*e), Sink::Socket(h) => Sink::Socket(*h) };
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
            Sink::Socket(h) => {
                let n = unsafe { ee_net_send(h, contents.as_ptr(), contents.len()) };
                trace_io(|| format!("write {h} of {} -> {n}", contents.len()));
                if n < 0 {
                    return Ok(Err(StreamError::LastOperationFailed(
                        self.table.push(IoError { msg: format!("socket write failed ({n})") })?)));
                }
                if (n as usize) < contents.len() {
                    // The host waits for writability rather than reporting a short write, so this
                    // is a genuine failure now (the peer went away mid-body). It is still reported
                    // rather than looped, because WASI has no partial-write answer and retrying
                    // from here would send the same bytes twice.
                    return Ok(Err(StreamError::LastOperationFailed(
                        self.table.push(IoError { msg: format!("the connection took {n} of {} bytes", contents.len()) })?)));
                }
            }
        }
        Ok(Ok(()))
    }
    fn blocking_write_and_flush(&mut self, s: Resource<OutputStream>, contents: Vec<u8>) -> wasmtime::Result<Result<(), StreamError>> {
        self.write(s, contents)
    }
    fn flush(&mut self, _s: Resource<OutputStream>) -> wasmtime::Result<Result<(), StreamError>> { Ok(Ok(())) }
    fn blocking_flush(&mut self, _s: Resource<OutputStream>) -> wasmtime::Result<Result<(), StreamError>> { Ok(Ok(())) }
    fn subscribe(&mut self, s: Resource<OutputStream>) -> wasmtime::Result<Resource<Pollable>> {
        let p = match &self.table.get(&s)?.sink {
            Sink::Socket(h) => Pollable::Socket { handle: *h, events: POLL_WRITE },
            _ => Pollable::Ready,
        };
        Ok(self.table.push(p)?)
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
    fn now(&mut self) -> wasmtime::Result<u64> { Ok(now_ns()) }
    fn resolution(&mut self) -> wasmtime::Result<u64> { Ok(1_000) }
    fn subscribe_instant(&mut self, when: u64) -> wasmtime::Result<Resource<Pollable>> {
        Ok(self.table.push(Pollable::Timer { deadline_ns: when })?)
    }
    fn subscribe_duration(&mut self, d: u64) -> wasmtime::Result<Resource<Pollable>> {
        Ok(self.table.push(Pollable::Timer { deadline_ns: now_ns().saturating_add(d) })?)
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
        Ok(self.table.push(InputStream { data: Vec::new(), pos: 0, socket: None })?)    // always at end of file
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
            Some(data) => Ok(Ok(self.table.push(InputStream { data, pos: 0, socket: None })?)),
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
        Ok(self.table.push(Pollable::Ready)?)
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
        Ok(self.table.push(Pollable::Ready)?)
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

/// One instantiated app of either export shape, plus the function to drive it.
///
/// The export is found BY PREFIX, because an artifact names it with the WASI version it was built
/// against ("wasi:http/incoming-handler@0.2.4", "wasi:cli/run@0.2.0") while this host provides
/// 0.2.12. The linker matches imports across 0.2.x on its own; exports are looked up here, and a
/// component that has neither is refused with both names said out loud.
pub enum Shape {
    /// `wasmtime serve`: handle(incoming-request, response-outparam)
    Http(wasmtime::component::TypedFunc<(Resource<IncomingRequest>, Resource<ResponseOutparam>), ()>),
    /// `wasmtime run`: run() -> result, which for a server never returns until it is interrupted
    Cli(wasmtime::component::TypedFunc<(), (Result<(), ()>,)>),
}

pub fn link(engine: &wasmtime::Engine) -> wasmtime::Result<wasmtime::component::Linker<WasiState>> {
    let mut linker: wasmtime::component::Linker<WasiState> = wasmtime::component::Linker::new(engine);
    AppHost::add_to_linker::<_, wasmtime::component::HasSelf<_>>(&mut linker, &LinkOptions::default(), |s| s)?;
    Ok(linker)
}

/// Instantiate and find the entry point. `prefer_cli` picks the shape when a component somehow has
/// both, which no published app does.
pub fn instantiate(store: &mut wasmtime::Store<WasiState>, component: &wasmtime::component::Component,
                   linker: &wasmtime::component::Linker<WasiState>)
    -> wasmtime::Result<(wasmtime::component::Instance, Shape)> {
    let instance = linker.instantiate(&mut *store, component)?;
    let engine = store.engine().clone();
    let mut http_iface = None;
    let mut cli_iface = None;
    for (name, _) in component.component_type().exports(&engine) {
        if name.starts_with("wasi:http/incoming-handler") { http_iface = Some(String::from(name)); }
        if name.starts_with("wasi:cli/run") { cli_iface = Some(String::from(name)); }
    }
    if let Some(name) = http_iface {
        let (_, iface) = instance.get_export(&mut *store, None, &name)
            .ok_or_else(|| wasmtime::Error::msg("the incoming-handler instance vanished between type and instance"))?;
        let (_, f) = instance.get_export(&mut *store, Some(&iface), "handle")
            .ok_or_else(|| wasmtime::Error::msg("wasi:http/incoming-handler exports no handle"))?;
        let func = instance.get_typed_func::<(Resource<IncomingRequest>, Resource<ResponseOutparam>), ()>(&mut *store, &f)?;
        return Ok((instance, Shape::Http(func)));
    }
    if let Some(name) = cli_iface {
        let (_, iface) = instance.get_export(&mut *store, None, &name)
            .ok_or_else(|| wasmtime::Error::msg("the run instance vanished between type and instance"))?;
        let (_, f) = instance.get_export(&mut *store, Some(&iface), "run")
            .ok_or_else(|| wasmtime::Error::msg("wasi:cli/run exports no run"))?;
        let func = instance.get_typed_func::<(), (Result<(), ()>,)>(&mut *store, &f)?;
        return Ok((instance, Shape::Cli(func)));
    }
    Err(wasmtime::Error::msg("this artifact exports neither wasi:http/incoming-handler (a served app) nor wasi:cli/run (a command that binds its own port)"))
}

/// Run ONE request through an ordinary wasi:http app, from the host's frame and back to it.
///
/// The shape of this function is the whole of the buffered contract: build the request in enclave
/// memory, hand the guest a response-outparam, call its handler, and read out whatever it set. A
/// guest that returns without setting one has not answered, and that is reported rather than
/// turned into an empty 200.
pub fn serve(store: &mut wasmtime::Store<WasiState>,
             func: &wasmtime::component::TypedFunc<(Resource<IncomingRequest>, Resource<ResponseOutparam>), ()>,
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

    func.call(&mut *store, (incoming, outparam)).map_err(|e| format!("the app trapped: {e:?}"))?;
    func.post_return(&mut *store).map_err(|e| format!("post-return: {e:?}"))?;

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

// ---- wasi:sockets ----------------------------------------------------------------------------
// A server inside an enclave has no socket of its own, so every one of these is the HOST's socket
// under a handle. What the host can see is the connection and its metadata (who connected, which
// name was resolved, how many bytes went by); what it cannot see is the session, because a guest
// like the s3-ipfs-adapter runs rustls in here and the bytes crossing the call-out are ciphertext.
//
// The local listener is bound to LOOPBACK by the host whatever the guest asks for: an app in the
// enclave is reached through this node's own proxy, never from the network, so binding 0.0.0.0
// would open a port on the machine for no reason. `local-address` answers with what was actually
// bound, so an app that logs its address logs the truth.
use self::wasi::sockets::network as net;

pub struct Network;
pub struct TcpSocket {
    pub family: net::IpAddressFamily,
    pub handle: i32,                 // the host's; 0 until bound/connected
    pub want_port: u16,
    pub local: Option<net::IpSocketAddress>,
    pub remote: Option<net::IpSocketAddress>,
    pub listening: bool,
    pub connect_to: Option<net::IpSocketAddress>,
}
pub struct UdpSocket;                // imported by std, never usable in here
pub struct IncomingDatagramStream;
pub struct OutgoingDatagramStream;
pub struct ResolveAddressStream { pub addrs: Vec<net::IpAddress>, pub pos: usize }

fn loopback(port: u16) -> net::IpSocketAddress {
    net::IpSocketAddress::Ipv4(net::Ipv4SocketAddress { port, address: (127, 0, 0, 1) })
}
fn port_of(a: &net::IpSocketAddress) -> u16 {
    match a { net::IpSocketAddress::Ipv4(v) => v.port, net::IpSocketAddress::Ipv6(v) => v.port }
}
/// The textual address the host's connect takes. IPv6 included, because a resolver will hand a
/// guest one and refusing it would look like a network fault rather than a missing feature.
fn addr_text(a: &net::IpSocketAddress) -> String {
    match a {
        net::IpSocketAddress::Ipv4(v) => {
            let (a1, b, c, d) = v.address;
            format!("{a1}.{b}.{c}.{d}")
        }
        net::IpSocketAddress::Ipv6(v) => {
            let (a1, a2, a3, a4, a5, a6, a7, a8) = v.address;
            format!("{a1:x}:{a2:x}:{a3:x}:{a4:x}:{a5:x}:{a6:x}:{a7:x}:{a8:x}")
        }
    }
}
fn err_of(rc: i32) -> net::ErrorCode {
    match rc {
        -11 => net::ErrorCode::WouldBlock,
        -111 => net::ErrorCode::ConnectionRefused,
        -104 => net::ErrorCode::ConnectionReset,
        -110 => net::ErrorCode::Timeout,
        -113 => net::ErrorCode::RemoteUnreachable,
        -98 => net::ErrorCode::AddressInUse,
        -13 => net::ErrorCode::AccessDenied,
        -24 => net::ErrorCode::NewSocketLimit,
        -22 => net::ErrorCode::InvalidArgument,
        _ => net::ErrorCode::Unknown,
    }
}

impl net::HostNetwork for WasiState {
    fn drop(&mut self, n: Resource<Network>) -> wasmtime::Result<()> { self.table.delete(n)?; Ok(()) }
}
impl net::Host for WasiState {
    fn network_error_code(&mut self, _e: Resource<IoError>) -> wasmtime::Result<Option<net::ErrorCode>> { Ok(None) }
}
impl self::wasi::sockets::instance_network::Host for WasiState {
    fn instance_network(&mut self) -> wasmtime::Result<Resource<Network>> { Ok(self.table.push(Network)?) }
}

impl self::wasi::sockets::tcp_create_socket::Host for WasiState {
    fn create_tcp_socket(&mut self, family: net::IpAddressFamily)
        -> wasmtime::Result<Result<Resource<TcpSocket>, net::ErrorCode>> {
        Ok(Ok(self.table.push(TcpSocket { family, handle: 0, want_port: 0, local: None, remote: None,
                                          listening: false, connect_to: None })?))
    }
}

impl self::wasi::sockets::tcp::HostTcpSocket for WasiState {
    fn start_bind(&mut self, s: Resource<TcpSocket>, _net: Resource<Network>, local: net::IpSocketAddress)
        -> wasmtime::Result<Result<(), net::ErrorCode>> {
        // Recorded, not acted on: the host binds when the guest listens, because that is the one
        // call where it learns whether this is a server at all.
        let sock = self.table.get_mut(&s)?;
        sock.want_port = port_of(&local);
        Ok(Ok(()))
    }
    fn finish_bind(&mut self, _s: Resource<TcpSocket>) -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Ok(())) }
    fn start_connect(&mut self, s: Resource<TcpSocket>, _net: Resource<Network>, remote: net::IpSocketAddress)
        -> wasmtime::Result<Result<(), net::ErrorCode>> {
        self.table.get_mut(&s)?.connect_to = Some(remote);
        Ok(Ok(()))
    }
    fn finish_connect(&mut self, s: Resource<TcpSocket>)
        -> wasmtime::Result<Result<(Resource<InputStream>, Resource<OutputStream>), net::ErrorCode>> {
        let (addr, port) = match &self.table.get(&s)?.connect_to {
            Some(a) => (addr_text(a), port_of(a)),
            None => return Ok(Err(net::ErrorCode::InvalidState)),
        };
        // The host dials. It sees where to; it does not see what is said, because the guest's TLS
        // starts on the stream this returns.
        let mut c = addr.into_bytes(); c.push(0);
        let h = unsafe { ee_net_connect(c.as_ptr(), port) };
        if h < 0 { return Ok(Err(err_of(h))); }
        self.sockets.add(h);   // owned now; closed on drop or on store teardown
        let sock = self.table.get_mut(&s)?;
        sock.handle = h;
        sock.remote = sock.connect_to.clone();
        let input = self.table.push(InputStream { data: Vec::new(), pos: 0, socket: Some(h) })?;
        let output = self.table.push(OutputStream { sink: Sink::Socket(h) })?;
        Ok(Ok((input, output)))
    }
    fn start_listen(&mut self, s: Resource<TcpSocket>) -> wasmtime::Result<Result<(), net::ErrorCode>> {
        let want = self.table.get(&s)?.want_port;
        let mut bound: u16 = 0;
        let h = unsafe { ee_net_listen(want, &mut bound) };
        if h < 0 { return Ok(Err(err_of(h))); }
        self.sockets.add(h);   // the listener: closed on drop or on store teardown (the leak fix)
        let sock = self.table.get_mut(&s)?;
        sock.handle = h; sock.listening = true; sock.local = Some(loopback(bound));
        Ok(Ok(()))
    }
    fn finish_listen(&mut self, _s: Resource<TcpSocket>) -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Ok(())) }
    fn accept(&mut self, s: Resource<TcpSocket>)
        -> wasmtime::Result<Result<(Resource<TcpSocket>, Resource<InputStream>, Resource<OutputStream>), net::ErrorCode>> {
        let (lh, family) = { let sock = self.table.get(&s)?; (sock.handle, sock.family) };
        if lh <= 0 { return Ok(Err(net::ErrorCode::InvalidState)); }
        let h = unsafe { ee_net_accept(lh) };
        if h < 0 {
            if h != -11 { trace(&format!("accept on {lh} failed: {h}")); }
            return Ok(Err(err_of(h)));
        }
        trace(&format!("accepted connection {h} on listener {lh}"));
        self.sockets.add(h);   // the accepted connection; closed on drop or on store teardown
        let peer = self.table.push(TcpSocket { family, handle: h, want_port: 0,
            local: self.table.get(&s)?.local.clone(), remote: None, listening: false, connect_to: None })?;
        let input = self.table.push(InputStream { data: Vec::new(), pos: 0, socket: Some(h) })?;
        let output = self.table.push(OutputStream { sink: Sink::Socket(h) })?;
        Ok(Ok((peer, input, output)))
    }
    fn local_address(&mut self, s: Resource<TcpSocket>) -> wasmtime::Result<Result<net::IpSocketAddress, net::ErrorCode>> {
        Ok(match &self.table.get(&s)?.local { Some(a) => Ok(a.clone()), None => Err(net::ErrorCode::InvalidState) })
    }
    fn remote_address(&mut self, s: Resource<TcpSocket>) -> wasmtime::Result<Result<net::IpSocketAddress, net::ErrorCode>> {
        // The host knows the peer; this side is not told, and an app that only logs it loses
        // nothing it can act on. Loopback is the truth for a connection the proxy carried in.
        Ok(match &self.table.get(&s)?.remote { Some(a) => Ok(a.clone()), None => Ok(loopback(0)) })
    }
    fn is_listening(&mut self, s: Resource<TcpSocket>) -> wasmtime::Result<bool> { Ok(self.table.get(&s)?.listening) }
    fn address_family(&mut self, s: Resource<TcpSocket>) -> wasmtime::Result<net::IpAddressFamily> {
        Ok(self.table.get(&s)?.family)
    }
    fn set_listen_backlog_size(&mut self, _s: Resource<TcpSocket>, _v: u64) -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Ok(())) }
    fn keep_alive_enabled(&mut self, _s: Resource<TcpSocket>) -> wasmtime::Result<Result<bool, net::ErrorCode>> { Ok(Ok(false)) }
    fn set_keep_alive_enabled(&mut self, _s: Resource<TcpSocket>, _v: bool) -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Ok(())) }
    fn keep_alive_idle_time(&mut self, _s: Resource<TcpSocket>) -> wasmtime::Result<Result<u64, net::ErrorCode>> { Ok(Ok(0)) }
    fn set_keep_alive_idle_time(&mut self, _s: Resource<TcpSocket>, _v: u64) -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Ok(())) }
    fn keep_alive_interval(&mut self, _s: Resource<TcpSocket>) -> wasmtime::Result<Result<u64, net::ErrorCode>> { Ok(Ok(0)) }
    fn set_keep_alive_interval(&mut self, _s: Resource<TcpSocket>, _v: u64) -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Ok(())) }
    fn keep_alive_count(&mut self, _s: Resource<TcpSocket>) -> wasmtime::Result<Result<u32, net::ErrorCode>> { Ok(Ok(0)) }
    fn set_keep_alive_count(&mut self, _s: Resource<TcpSocket>, _v: u32) -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Ok(())) }
    fn hop_limit(&mut self, _s: Resource<TcpSocket>) -> wasmtime::Result<Result<u8, net::ErrorCode>> { Ok(Ok(64)) }
    fn set_hop_limit(&mut self, _s: Resource<TcpSocket>, _v: u8) -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Ok(())) }
    fn receive_buffer_size(&mut self, _s: Resource<TcpSocket>) -> wasmtime::Result<Result<u64, net::ErrorCode>> { Ok(Ok(64 * 1024)) }
    fn set_receive_buffer_size(&mut self, _s: Resource<TcpSocket>, _v: u64) -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Ok(())) }
    fn send_buffer_size(&mut self, _s: Resource<TcpSocket>) -> wasmtime::Result<Result<u64, net::ErrorCode>> { Ok(Ok(64 * 1024)) }
    fn set_send_buffer_size(&mut self, _s: Resource<TcpSocket>, _v: u64) -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Ok(())) }
    fn subscribe(&mut self, s: Resource<TcpSocket>) -> wasmtime::Result<Resource<Pollable>> {
        // A listener is "readable" when a connection is pending, which is how a guest waits for
        // one; a connected socket is readable when there are bytes.
        let sock = self.table.get(&s)?;
        let p = if sock.handle > 0 { Pollable::Socket { handle: sock.handle, events: POLL_READ } } else { Pollable::Ready };
        Ok(self.table.push(p)?)
    }
    fn shutdown(&mut self, _s: Resource<TcpSocket>, _how: self::wasi::sockets::tcp::ShutdownType)
        -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Ok(())) }
    fn drop(&mut self, s: Resource<TcpSocket>) -> wasmtime::Result<()> {
        let sock = self.table.delete(s)?;
        // Close only if we still hold it: remove() is false when the store is already tearing down
        // and closed it, so a socket is never closed twice. Streams for this handle carry no
        // ownership (they alias it), so only the TcpSocket drop and teardown close.
        if sock.handle > 0 && self.sockets.remove(sock.handle) {
            trace(&format!("socket {} dropped by the app{}", sock.handle, if sock.listening { " (a listener)" } else { "" }));
            unsafe { ee_net_close(sock.handle) }
        }
        Ok(())
    }
}
impl self::wasi::sockets::tcp::Host for WasiState {}

impl self::wasi::sockets::ip_name_lookup::HostResolveAddressStream for WasiState {
    fn resolve_next_address(&mut self, s: Resource<ResolveAddressStream>)
        -> wasmtime::Result<Result<Option<net::IpAddress>, net::ErrorCode>> {
        let st = self.table.get_mut(&s)?;
        let a = st.addrs.get(st.pos).cloned();
        if a.is_some() { st.pos += 1; }
        Ok(Ok(a))
    }
    fn subscribe(&mut self, _s: Resource<ResolveAddressStream>) -> wasmtime::Result<Resource<Pollable>> {
        Ok(self.table.push(Pollable::Ready)?)      // the host resolved before this returned
    }
    fn drop(&mut self, s: Resource<ResolveAddressStream>) -> wasmtime::Result<()> { self.table.delete(s)?; Ok(()) }
}
impl self::wasi::sockets::ip_name_lookup::Host for WasiState {
    fn resolve_addresses(&mut self, _net: Resource<Network>, name: String)
        -> wasmtime::Result<Result<Resource<ResolveAddressStream>, net::ErrorCode>> {
        // DNS is the host's: it has the resolver. It therefore learns the NAME the app is looking
        // up, which is metadata it could read off the connection anyway. The session that follows
        // is the guest's.
        let mut n = name.clone().into_bytes(); n.push(0);
        let mut out = vec![0u8; 4096];
        let k = unsafe { ee_net_resolve(n.as_ptr(), out.as_mut_ptr(), out.len()) };
        if k < 0 { return Ok(Err(net::ErrorCode::NameUnresolvable)); }
        out.truncate(k as usize);
        let text = String::from_utf8_lossy(&out);
        let mut addrs = Vec::new();
        for line in text.split('\n').filter(|l| !l.is_empty()) {
            if let Some(a) = parse_ip(line) { addrs.push(a); }
        }
        if addrs.is_empty() { return Ok(Err(net::ErrorCode::NameUnresolvable)); }
        Ok(Ok(self.table.push(ResolveAddressStream { addrs, pos: 0 })?))
    }
}
/// Parse what the host's resolver printed. Hand-rolled because there is no std here, and the two
/// forms it can print are all this has to accept.
fn parse_ip(s: &str) -> Option<net::IpAddress> {
    if s.contains('.') {
        let mut it = s.split('.');
        let a = it.next()?.parse::<u8>().ok()?;
        let b = it.next()?.parse::<u8>().ok()?;
        let c = it.next()?.parse::<u8>().ok()?;
        let d = it.next()?.parse::<u8>().ok()?;
        if it.next().is_some() { return None; }
        return Some(net::IpAddress::Ipv4((a, b, c, d)));
    }
    if s.contains(':') {
        // The host prints every group, so no "::" contraction has to be expanded here.
        let parts: Vec<&str> = s.split(':').collect();
        if parts.len() != 8 { return None; }
        let mut g = [0u16; 8];
        for (i, p) in parts.iter().enumerate() { g[i] = u16::from_str_radix(p, 16).ok()?; }
        return Some(net::IpAddress::Ipv6((g[0], g[1], g[2], g[3], g[4], g[5], g[6], g[7])));
    }
    None
}

// ---- wasi:sockets/udp: imported by std, never served ----------------------------------------
// A datagram socket cannot be brokered the way a stream can (no connection to carry, no ordering
// to preserve across a call-out) and nothing in the catalog uses one. Refused by name.
const NO_UDP: net::ErrorCode = net::ErrorCode::NotSupported;
impl self::wasi::sockets::udp_create_socket::Host for WasiState {
    fn create_udp_socket(&mut self, _f: net::IpAddressFamily)
        -> wasmtime::Result<Result<Resource<UdpSocket>, net::ErrorCode>> { Ok(Err(NO_UDP)) }
}
impl self::wasi::sockets::udp::HostUdpSocket for WasiState {
    fn start_bind(&mut self, _s: Resource<UdpSocket>, _n: Resource<Network>, _a: net::IpSocketAddress)
        -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Err(NO_UDP)) }
    fn finish_bind(&mut self, _s: Resource<UdpSocket>) -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Err(NO_UDP)) }
    fn stream(&mut self, _s: Resource<UdpSocket>, _a: Option<net::IpSocketAddress>)
        -> wasmtime::Result<Result<(Resource<IncomingDatagramStream>, Resource<OutgoingDatagramStream>), net::ErrorCode>> { Ok(Err(NO_UDP)) }
    fn local_address(&mut self, _s: Resource<UdpSocket>) -> wasmtime::Result<Result<net::IpSocketAddress, net::ErrorCode>> { Ok(Err(NO_UDP)) }
    fn remote_address(&mut self, _s: Resource<UdpSocket>) -> wasmtime::Result<Result<net::IpSocketAddress, net::ErrorCode>> { Ok(Err(NO_UDP)) }
    fn address_family(&mut self, _s: Resource<UdpSocket>) -> wasmtime::Result<net::IpAddressFamily> { Ok(net::IpAddressFamily::Ipv4) }
    fn unicast_hop_limit(&mut self, _s: Resource<UdpSocket>) -> wasmtime::Result<Result<u8, net::ErrorCode>> { Ok(Err(NO_UDP)) }
    fn set_unicast_hop_limit(&mut self, _s: Resource<UdpSocket>, _v: u8) -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Err(NO_UDP)) }
    fn receive_buffer_size(&mut self, _s: Resource<UdpSocket>) -> wasmtime::Result<Result<u64, net::ErrorCode>> { Ok(Err(NO_UDP)) }
    fn set_receive_buffer_size(&mut self, _s: Resource<UdpSocket>, _v: u64) -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Err(NO_UDP)) }
    fn send_buffer_size(&mut self, _s: Resource<UdpSocket>) -> wasmtime::Result<Result<u64, net::ErrorCode>> { Ok(Err(NO_UDP)) }
    fn set_send_buffer_size(&mut self, _s: Resource<UdpSocket>, _v: u64) -> wasmtime::Result<Result<(), net::ErrorCode>> { Ok(Err(NO_UDP)) }
    fn subscribe(&mut self, _s: Resource<UdpSocket>) -> wasmtime::Result<Resource<Pollable>> { Ok(self.table.push(Pollable::Ready)?) }
    fn drop(&mut self, s: Resource<UdpSocket>) -> wasmtime::Result<()> { self.table.delete(s)?; Ok(()) }
}
impl self::wasi::sockets::udp::HostIncomingDatagramStream for WasiState {
    fn receive(&mut self, _s: Resource<IncomingDatagramStream>, _n: u64)
        -> wasmtime::Result<Result<Vec<self::wasi::sockets::udp::IncomingDatagram>, net::ErrorCode>> { Ok(Err(NO_UDP)) }
    fn subscribe(&mut self, _s: Resource<IncomingDatagramStream>) -> wasmtime::Result<Resource<Pollable>> { Ok(self.table.push(Pollable::Ready)?) }
    fn drop(&mut self, s: Resource<IncomingDatagramStream>) -> wasmtime::Result<()> { self.table.delete(s)?; Ok(()) }
}
impl self::wasi::sockets::udp::HostOutgoingDatagramStream for WasiState {
    fn check_send(&mut self, _s: Resource<OutgoingDatagramStream>) -> wasmtime::Result<Result<u64, net::ErrorCode>> { Ok(Err(NO_UDP)) }
    fn send(&mut self, _s: Resource<OutgoingDatagramStream>, _d: Vec<self::wasi::sockets::udp::OutgoingDatagram>)
        -> wasmtime::Result<Result<u64, net::ErrorCode>> { Ok(Err(NO_UDP)) }
    fn subscribe(&mut self, _s: Resource<OutgoingDatagramStream>) -> wasmtime::Result<Resource<Pollable>> { Ok(self.table.push(Pollable::Ready)?) }
    fn drop(&mut self, s: Resource<OutgoingDatagramStream>) -> wasmtime::Result<()> { self.table.delete(s)?; Ok(()) }
}
impl self::wasi::sockets::udp::Host for WasiState {}

// ---- wasi:filesystem: linked by std, empty by construction -----------------------------------
// An enclave has no filesystem. `get-directories` returns an empty list, which is exactly what a
// guest launched with no preopens sees on a real host, so std's startup is happy and every path
// operation fails the way it would outside a sandbox: access denied. A tenant that needs storage
// uses the platform's encrypted volumes over the network, not a file in here.
use self::wasi::filesystem::types as fs;
pub struct Descriptor;
pub struct DirectoryEntryStream;
const NO_FS: fs::ErrorCode = fs::ErrorCode::Access;

impl self::wasi::filesystem::preopens::Host for WasiState {
    fn get_directories(&mut self) -> wasmtime::Result<Vec<(Resource<Descriptor>, String)>> { Ok(Vec::new()) }
}
impl fs::Host for WasiState {
    fn filesystem_error_code(&mut self, _e: Resource<IoError>) -> wasmtime::Result<Option<fs::ErrorCode>> { Ok(None) }
}
impl fs::HostDirectoryEntryStream for WasiState {
    fn read_directory_entry(&mut self, _s: Resource<DirectoryEntryStream>)
        -> wasmtime::Result<Result<Option<fs::DirectoryEntry>, fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn drop(&mut self, s: Resource<DirectoryEntryStream>) -> wasmtime::Result<()> { self.table.delete(s)?; Ok(()) }
}
impl fs::HostDescriptor for WasiState {
    fn read_via_stream(&mut self, _d: Resource<Descriptor>, _o: u64) -> wasmtime::Result<Result<Resource<InputStream>, fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn write_via_stream(&mut self, _d: Resource<Descriptor>, _o: u64) -> wasmtime::Result<Result<Resource<OutputStream>, fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn append_via_stream(&mut self, _d: Resource<Descriptor>) -> wasmtime::Result<Result<Resource<OutputStream>, fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn advise(&mut self, _d: Resource<Descriptor>, _o: u64, _l: u64, _a: fs::Advice) -> wasmtime::Result<Result<(), fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn sync_data(&mut self, _d: Resource<Descriptor>) -> wasmtime::Result<Result<(), fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn get_flags(&mut self, _d: Resource<Descriptor>) -> wasmtime::Result<Result<fs::DescriptorFlags, fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn get_type(&mut self, _d: Resource<Descriptor>) -> wasmtime::Result<Result<fs::DescriptorType, fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn set_size(&mut self, _d: Resource<Descriptor>, _s: u64) -> wasmtime::Result<Result<(), fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn set_times(&mut self, _d: Resource<Descriptor>, _a: fs::NewTimestamp, _m: fs::NewTimestamp) -> wasmtime::Result<Result<(), fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn read(&mut self, _d: Resource<Descriptor>, _l: u64, _o: u64) -> wasmtime::Result<Result<(Vec<u8>, bool), fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn write(&mut self, _d: Resource<Descriptor>, _b: Vec<u8>, _o: u64) -> wasmtime::Result<Result<u64, fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn read_directory(&mut self, _d: Resource<Descriptor>) -> wasmtime::Result<Result<Resource<DirectoryEntryStream>, fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn sync(&mut self, _d: Resource<Descriptor>) -> wasmtime::Result<Result<(), fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn create_directory_at(&mut self, _d: Resource<Descriptor>, _p: String) -> wasmtime::Result<Result<(), fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn stat(&mut self, _d: Resource<Descriptor>) -> wasmtime::Result<Result<fs::DescriptorStat, fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn stat_at(&mut self, _d: Resource<Descriptor>, _f: fs::PathFlags, _p: String) -> wasmtime::Result<Result<fs::DescriptorStat, fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn set_times_at(&mut self, _d: Resource<Descriptor>, _f: fs::PathFlags, _p: String, _a: fs::NewTimestamp, _m: fs::NewTimestamp) -> wasmtime::Result<Result<(), fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn link_at(&mut self, _d: Resource<Descriptor>, _of: fs::PathFlags, _op: String, _nd: Resource<Descriptor>, _np: String) -> wasmtime::Result<Result<(), fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn open_at(&mut self, _d: Resource<Descriptor>, _pf: fs::PathFlags, _p: String, _of: fs::OpenFlags, _fl: fs::DescriptorFlags) -> wasmtime::Result<Result<Resource<Descriptor>, fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn readlink_at(&mut self, _d: Resource<Descriptor>, _p: String) -> wasmtime::Result<Result<String, fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn remove_directory_at(&mut self, _d: Resource<Descriptor>, _p: String) -> wasmtime::Result<Result<(), fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn rename_at(&mut self, _d: Resource<Descriptor>, _op: String, _nd: Resource<Descriptor>, _np: String) -> wasmtime::Result<Result<(), fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn symlink_at(&mut self, _d: Resource<Descriptor>, _o: String, _n: String) -> wasmtime::Result<Result<(), fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn unlink_file_at(&mut self, _d: Resource<Descriptor>, _p: String) -> wasmtime::Result<Result<(), fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn is_same_object(&mut self, _d: Resource<Descriptor>, _o: Resource<Descriptor>) -> wasmtime::Result<bool> { Ok(false) }
    fn metadata_hash(&mut self, _d: Resource<Descriptor>) -> wasmtime::Result<Result<fs::MetadataHashValue, fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn metadata_hash_at(&mut self, _d: Resource<Descriptor>, _f: fs::PathFlags, _p: String) -> wasmtime::Result<Result<fs::MetadataHashValue, fs::ErrorCode>> { Ok(Err(NO_FS)) }
    fn drop(&mut self, d: Resource<Descriptor>) -> wasmtime::Result<()> { self.table.delete(d)?; Ok(()) }
}
