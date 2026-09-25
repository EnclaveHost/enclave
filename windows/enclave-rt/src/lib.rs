// windows/enclave-rt -- the wasm runtime that runs a tenant's app INSIDE the VBS enclave.
//
// WHY THIS EXISTS. Every other box in the fleet runs a tenant's app inside the TEE its row
// badges. On a Windows box the enclave is VTL1, and `wasmtime serve` cannot live there: it needs
// a JIT (VTL1 has no executable pages, which is the property VBS exists to enforce), mmap, and
// Rust std over an OS that is not present. So the app ran in VTL0 beside the enclave, and the
// honest description of that ("the owner of the PC can read the app's memory") is not what this
// platform sells. This crate is the fix, not a caveat.
//
// HOW. Wasmtime, minus code generation:
//   * the component is compiled to PULLEY bytecode outside the enclave (see the `precompile`
//     binary). Pulley is wasmtime's portable interpreter, so the artifact is DATA, never code,
//     and nothing in here needs a page it can execute.
//   * inside, wasmtime is built `no_std` with `runtime + component-model + pulley`. Measured on
//     the produced .lib: zero Windows API imports. The only external symbols are malloc/free,
//     the mem* intrinsics, fmod/fmodf and the compiler's f128 helpers - all of which the
//     enclave-flavoured CRT already provides to the engine next door.
//   * the app's world is enclave:app (wit/app.wit): a function call, not a server. VTL0 owns the
//     socket and carries bytes through the enclave gate; the app's code, memory and its model
//     calls stay in VTL1.
//
// WHAT THE TENANT GETS, precisely: their app's code and memory are inside the enclave and are not
// readable by the Windows session, its administrator or its kernel. The request and response
// bytes cross the gate, so the VTL0 agent sees the traffic it is carrying, exactly as the
// platform's relay does for every box in the fleet. Sealing that leg is the next piece of work
// (the enclave already mints a transport key for sealed inference); it is not claimed here.
#![no_std]
extern crate alloc;

use alloc::{format, string::String, vec, vec::Vec};
use core::alloc::{GlobalAlloc, Layout};
use wasmtime::component::{Component, Linker};
use wasmtime::{Config, Engine, Store};

// ---- the platform this crate stands on: the enclave CRT and the engine beside it -------------
// Every one of these is already in the enclave image (windows/enclave-engine): the C runtime the
// engine links, and the engine's own entry points. Nothing here reaches for an OS.
extern "C" {
    fn malloc(n: usize) -> *mut u8;
    fn free(p: *mut u8);
    fn _aligned_malloc(n: usize, a: usize) -> *mut u8;
    fn _aligned_free(p: *mut u8);
    /// Wall clock, read by the HOST at gate-crossing time and passed in: VTL1 has no clock of its
    /// own, and an app that needs one is better told a host-supplied number than a made-up one.
    fn ee_app_now_ms() -> u64;
    /// The enclave's randomness (BCryptGenRandom inside VTL1, the same source the session keys
    /// come from).
    fn ee_app_random(out: *mut u8, len: u32) -> i32;
    /// A line for this deployment's log, which the operator and the tenant both read.
    fn ee_app_log(p: *const u8, len: usize);
    /// THE MODEL, without leaving the enclave. This calls the engine in VTL1 (llama.cpp compiled
    /// into this same image), so an app's inference never crosses into VTL0 and the card only
    /// ever sees masked activations.
    fn ee_app_generate(prompt: *const u8, plen: usize, max_tokens: u32,
                       out: *mut u8, out_cap: usize, out_len: *mut usize) -> i32;
    /// Give up, loudly. A panic inside an enclave has nowhere to unwind to.
    fn ee_app_abort(msg: *const u8, len: usize) -> !;
}

/// The runtime's `log::` macros, routed to the enclave's own log.
///
/// Without a registered logger every `log::warn!` inside wasmtime is discarded, and a diagnostic
/// that cannot be seen is indistinguishable from a thing that did not happen. This is how the
/// shared-memory sizing below became evidence rather than a guess.
struct EeLogger;

impl log::Log for EeLogger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Info
    }
    fn log(&self, r: &log::Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        // One formatted line, bounded: the log crossing is a call-out and the enclave has no
        // business spending a page on a message.
        let mut buf = alloc::string::String::new();
        let _ = core::fmt::write(&mut buf, format_args!("[rt] {} {}\n", r.level(), r.args()));
        unsafe { ee_app_log(buf.as_ptr(), buf.len()) };
    }
    fn flush(&self) {}
}

static EE_LOGGER: EeLogger = EeLogger;

/// What a shared memory may grow to, in bytes. Set from the app's `ENCLAVE_MEM_MB` when it opens;
/// the modest default is for anything that opens without one.
static SHARED_RESERVE: core::sync::atomic::AtomicU64 = core::sync::atomic::AtomicU64::new(256 << 20);

#[no_mangle]
pub extern "C" fn wasmtime_shared_memory_reserve_bytes() -> u64 {
    SHARED_RESERVE.load(core::sync::atomic::Ordering::Relaxed)
}

struct EnclaveHeap;
unsafe impl GlobalAlloc for EnclaveHeap {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        // The enclave heap is VTL1 memory: allocated from the enclave's own committed range and
        // not mapped into VTL0. malloc is the whole story, and the aligned pair covers the
        // over-aligned allocations wasmtime makes for a guest's linear memory.
        if l.align() > 16 { _aligned_malloc(l.size(), l.align()) } else { malloc(l.size()) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        if l.align() > 16 { _aligned_free(p) } else { free(p) }
    }
}
#[global_allocator]
static HEAP: EnclaveHeap = EnclaveHeap;

/// A fixed buffer that core::fmt can write into. There is no allocator guarantee left at panic
/// time and no std to lean on, so the panic path formats into stack bytes and nothing else.
struct FmtBuf { b: [u8; 512], n: usize }
impl core::fmt::Write for FmtBuf {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        let room = self.b.len() - self.n;
        let take = s.len().min(room);
        self.b[self.n..self.n + take].copy_from_slice(&s.as_bytes()[..take]);
        self.n += take;
        Ok(())
    }
}

#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    // No unwinding: an enclave has nowhere to unwind to. Say WHAT and WHERE, because this text is
    // the whole of what the operator will get - the host turns it into the deployment's reason.
    use core::fmt::Write;
    let mut f = FmtBuf { b: [0u8; 512], n: 0 };
    let _ = write!(f, "enclave-rt panic: {}", info.message());
    if let Some(l) = info.location() { let _ = write!(f, " at {}:{}", l.file(), l.line()); }
    unsafe { ee_app_abort(f.b.as_ptr(), f.n) }
}

pub mod wasihost;
mod netset;
mod slots;
use slots::{Removed, SlotTable};

wasmtime::component::bindgen!({
    path: "wit",
    world: "app",
});

/// What the enclave knows about the app it is running. One field today, and it is the one that
/// decides whether the model answers: the thousandths of this box's card the deployment bought,
/// handed in with the app's environment (ENCLAVE_GPU_MILLI) by the half that read the ledger.
///
/// The host could lie about it, and the enclave cannot check a chain it cannot reach. But the
/// only lie available to it is GIVING AWAY its own card - the tenant never supplies this value -
/// so the property that matters holds: an app cannot help itself to the model.
struct HostState { gpu_milli: u32 }

impl enclave::app::types::Host for HostState {}

impl enclave::app::host::Host for HostState {
    fn now_ms(&mut self) -> u64 { unsafe { ee_app_now_ms() } }
    fn random(&mut self, len: u32) -> Vec<u8> {
        let n = len.min(4096) as usize;              // a guest cannot ask the enclave for a pile
        let mut v = vec![0u8; n];
        if unsafe { ee_app_random(v.as_mut_ptr(), n as u32) } != 0 { v.fill(0); }
        v
    }
    fn log(&mut self, line: String) {
        let b = line.as_bytes();
        unsafe { ee_app_log(b.as_ptr(), b.len().min(4096)) }
    }
    fn generate(&mut self, prompt: String, max_tokens: u32) -> Result<String, String> {
        // The model runs on the box's card by masked offload, and that card is sold in shares.
        // A deployment that bought none is told so in as many words rather than handed an empty
        // completion, which every app would read as "the model had nothing to say".
        if self.gpu_milli == 0 {
            return Err(String::from(
                "this deployment bought no share of this box's card, and the model here runs on it: \
                 redeploy with a gpu share to use generate"));
        }
        let p = prompt.as_bytes();
        let mut out = vec![0u8; 64 * 1024];
        let mut n: usize = 0;
        let rc = unsafe {
            ee_app_generate(p.as_ptr(), p.len(), max_tokens.min(2048),
                            out.as_mut_ptr(), out.len(), &mut n)
        };
        if rc != 0 { return Err(String::from("the enclave's engine refused the prompt")); }
        out.truncate(n.min(out.len()));
        String::from_utf8(out).map_err(|_| String::from("the completion was not utf-8"))
    }
}

/// One loaded app, of either kind this enclave can run. Both live entirely in enclave memory.
///
///  * `Enclave` is the enclave:app world (wit/app.wit): a function call, four host imports, and
///    the model next door. Written for this box.
///  * `Http` is an ORDINARY platform app: a wasi:http component, exactly as published to the
///    catalog for the fleet's confidential VMs, served by the WASI host in wasihost.rs. Nothing
///    about the artifact changes; what changes is where it runs.
enum Loaded {
    Enclave { store: Store<HostState>, instance: App },
    /// An ordinary platform app: a wasi:http component (served per request) or a wasi:cli command
    /// that binds its own port through the brokered sockets and runs until it is interrupted.
    Wasi { store: Store<wasihost::WasiState>, shape: wasihost::Shape, running: bool },
}

// ---- the wire between VTL0 and the app -------------------------------------------------------
// Length-prefixed, little-endian, and hand-rolled on purpose: the bytes that cross an enclave
// boundary are the one place a parser bug is a security bug, so this is 40 lines that do nothing
// but read counts and slices, with every length checked against what is actually there.
//
//   request : u32 method | u32 path | u32 nheaders | (u32 name, u32 value) * n | u32 body
//   response: u16 status | u32 nheaders | (u32 name, u32 value) * n | u32 body
struct Rd<'a> { b: &'a [u8], i: usize }
impl<'a> Rd<'a> {
    fn u32(&mut self) -> Option<u32> {
        let e = self.i.checked_add(4)?;
        if e > self.b.len() { return None; }
        let v = u32::from_le_bytes([self.b[self.i], self.b[self.i + 1], self.b[self.i + 2], self.b[self.i + 3]]);
        self.i = e;
        Some(v)
    }
    fn bytes(&mut self) -> Option<&'a [u8]> {
        let n = self.u32()? as usize;
        let e = self.i.checked_add(n)?;
        if e > self.b.len() { return None; }
        let s = &self.b[self.i..e];
        self.i = e;
        Some(s)
    }
    fn string(&mut self) -> Option<String> {
        core::str::from_utf8(self.bytes()?).ok().map(String::from)
    }
}
fn put_u32(v: &mut Vec<u8>, n: u32) { v.extend_from_slice(&n.to_le_bytes()); }
fn put_bytes(v: &mut Vec<u8>, b: &[u8]) { put_u32(v, b.len() as u32); v.extend_from_slice(b); }

fn decode_request(buf: &[u8]) -> Option<enclave::app::types::Request> {
    let mut r = Rd { b: buf, i: 0 };
    let method = r.string()?;
    let path = r.string()?;
    let n = r.u32()?;
    if n > 256 { return None; }                      // a hostile header count, refused not looped
    let mut headers = Vec::with_capacity(n as usize);
    for _ in 0..n {
        headers.push(enclave::app::types::Header { name: r.string()?, value: r.string()? });
    }
    let body = r.bytes()?.to_vec();
    Some(enclave::app::types::Request { method, path, headers, body })
}

fn encode_response(resp: &enclave::app::types::Response) -> Vec<u8> {
    let mut v = Vec::with_capacity(resp.body.len() + 64);
    v.extend_from_slice(&resp.status.to_le_bytes());
    put_u32(&mut v, resp.headers.len() as u32);
    for h in &resp.headers { put_bytes(&mut v, h.name.as_bytes()); put_bytes(&mut v, h.value.as_bytes()); }
    put_bytes(&mut v, &resp.body);
    v
}

// ---- the C API the enclave image exposes -----------------------------------------------------
// Handles rather than pointers across the boundary: a use-after-free of an app pointer handed out
// to VTL0 would be a VTL1 memory bug reachable from the untrusted side.
/// Which world an artifact was built for. The HOST decides and says so, because it is the half
/// that read the bytes (windows/node/appframe.mjs worldOf): the enclave then serves that world or
/// refuses, rather than guessing from a failed instantiation.
pub const WORLD_ENCLAVE: u32 = 1;
pub const WORLD_HTTP: u32 = 2;
/// A `wasmtime run` command that binds its own TCP port through the brokered sockets: the shape
/// most of the platform's catalog actually is (the s3-ipfs-adapter among them).
pub const WORLD_CLI: u32 = 4;

/// Every app this enclave is running at once, in a generational slot table (slots.rs). The handle
/// returned to the host carries the slot AND the generation of this occupancy, so a handle for an
/// app that has stopped can never reach whatever app took the slot next -- the tenant-safety fix
/// for the "two tenants share slot 3" bug found 2026-09-25. The table keeps a running or
/// mid-request app IN its slot (the old code took it out, which is what let a second app reuse the
/// handle), and it holds each app's engine so `ee_rt_stop` can interrupt exactly the app named.
static APPS: SlotTable<Loaded, wasmtime::Engine> = SlotTable::new();
static mut LAST_ERROR: Option<String> = None;

fn set_err(s: &str) { unsafe { LAST_ERROR = Some(String::from(s)) } }
fn set_err_owned(s: String) { unsafe { LAST_ERROR = Some(s) } }

/// Load a Pulley-compiled component into the enclave. Returns a handle, or 0 with the reason
/// readable through `ee_rt_last_error`.
///
/// The bytes are an artifact the host compiled from the CID the ledger names; the enclave does
/// not fetch and cannot verify a CID by itself (no network in VTL1), so what it guarantees is
/// narrower and worth stating: whatever was loaded RUNS in here, and nothing in VTL0 can read or
/// alter it afterwards.
#[no_mangle]
pub extern "C" fn ee_rt_open(cwasm: *const u8, len: usize, world: u32,
                             env: *const u8, env_len: usize) -> u32 {
    if cwasm.is_null() || len == 0 { set_err("no bytecode"); return 0; }
    let bytes = unsafe { core::slice::from_raw_parts(cwasm, len) };
    // "K=V\0K=V\0\0", the same shape the engine's own init takes. This is where a version's
    // config and a deployment's override reach an ordinary app (ENCLAVE_CONFIG), so an app reads
    // its configuration in here exactly as it would on a confidential VM.
    let envv: Vec<(String, String)> = if env.is_null() || env_len == 0 { Vec::new() } else {
        let raw = unsafe { core::slice::from_raw_parts(env, env_len) };
        raw.split(|&b| b == 0)
            .filter(|p| !p.is_empty())
            .filter_map(|p| core::str::from_utf8(p).ok())
            .filter_map(|kv| kv.split_once('=').map(|(k, v)| (String::from(k), String::from(v))))
            .collect()
    };
    // WHAT A SHARED MEMORY MAY GROW TO. The runtime asks for this before it allocates one,
    // because a shared memory's base cannot move and so every byte it can ever need has to be
    // reserved up front. The DECLARED maximum is no use as an answer: risc-box's is 128 GiB,
    // which means "as much as you have", and this box knows what it actually promised.
    if let Some((_, v)) = envv.iter().find(|(k, _)| k == "ENCLAVE_MEM_MB") {
        if let Ok(mb) = v.trim().parse::<u64>() {
            SHARED_RESERVE.store(mb.saturating_mul(1 << 20), core::sync::atomic::Ordering::Relaxed);
        }
    }
    let mut config = Config::new();
    // The interpreter target, and the artifact must match it: a cwasm carrying machine code for a
    // real ISA is refused here rather than mapped executable, which is the point.
    if config.target("pulley64").is_err() { set_err("pulley64 target unavailable"); return 0; }
    // Registered once; a second call is an error and is ignored on purpose.
    let _ = log::set_logger(&EE_LOGGER);
    log::set_max_level(log::LevelFilter::Info);
    config.wasm_component_model(true);
    // What this side can actually do, stated rather than defaulted. There is no virtual memory in
    // VTL1: nothing to map a guest's data image from, nothing to reserve and grow into, no guard
    // pages and no signal handler to turn a fault into a trap. The interpreter bounds-checks every
    // access instead, which is why it can live here at all. These MUST match ee-precompile's
    // settings exactly; a cwasm records them and the runtime refuses a mismatch.
    config.memory_init_cow(false);
    config.memory_reservation(0);
    config.memory_guard_size(0);
    config.memory_reservation_for_growth(0);
    config.signals_based_traps(false);
    // A wasi:cli server's run() never returns on its own. Epoch interruption is the only way to
    // get it back: another thread bumps the engine's epoch, the guest traps at its next check and
    // run() unwinds. It changes code generation, so ee-precompile sets it too.
    config.epoch_interruption(true);
    // Must match ee-precompile EXACTLY, and for the same reason as the tunables above: a cwasm
    // records the features it was compiled with. 64-bit memories are what an app with more than
    // 4 GiB of guest state needs (the catalog calls it `mem64`).
    config.wasm_memory64(true);
    // The COMPONENT-model half of 64-bit memories. A wasm64 app plugged under a wasm32 proxy -
    // which is what risc-box is - carries one at the component level too, and the loader refuses
    // it by name without this.
    config.wasm_component_model_memory64(true);
    // SHARED-EVERYTHING THREADS. Two flags: `wasm_threads` is what makes a `shared` memory
    // loadable at all, and the second allows `shared` on anything else plus the spawn intrinsics.
    // A cwasm records the features it was compiled with and the runtime refuses a mismatch, so
    // these must agree with ee-precompile exactly - "compiled with support for ... but it is not
    // enabled for the host" is that refusal, and it is right.
    config.wasm_threads(true);
    config.wasm_shared_everything_threads(true);
    // ...and the engine has to be WILLING to make one. The two above say the bytecode may contain
    // a shared memory; this says the runtime will allocate it. Without it the artifact loads and
    // then fails at instantiate, which reads like a different problem.
    config.shared_memory(true);
    let engine = match Engine::new(&config) { Ok(e) => e, Err(_) => { set_err("engine"); return 0; } };
    // SAFETY: deserialize trusts its input the way a loader trusts an image. The bytes came from
    // this box's own host half, through the enclave gate, and the enclave's threat model does not
    // extend to a host that lies about the app it was asked to run: that host chose the app.
    let component = match unsafe { Component::deserialize(&engine, bytes) } {
        Ok(c) => c,
        Err(e) => {
            // The engine refuses bytecode it did not produce, down to the tunables (guard pages,
            // signal-based traps, memory growth) that the interpreter has to agree about. Carry
            // wasmtime's own words out: "compiled with X, running with Y" is the difference
            // between a two-minute fix and an afternoon.
            set_err_owned(format!("cannot load the bytecode: {e:?}"));
            return 0;
        }
    };
    let loaded = if world == WORLD_HTTP || world == WORLD_CLI {
        // An ordinary platform app. The WASI host it sees is wasihost.rs.
        let linker = match wasihost::link(&engine) {
            Ok(l) => l, Err(e) => { set_err_owned(format!("linker: {e}")); return 0; }
        };
        let mut store = Store::new(&engine, wasihost::WasiState::new(envv));
        // BEFORE instantiate, not after: with epoch interruption on, a store's deadline starts
        // already expired and the guest traps on its first instruction ("wasm trap: interrupt")
        // inside the component's own initialiser. One tick is the deadline and ee_rt_stop bumps
        // the engine past it, which is the only way to get a server's run() back.
        store.set_epoch_deadline(1);
        match wasihost::instantiate(&mut store, &component, &linker) {
            Ok((_instance, shape)) => {
                // The artifact's own export decides the shape; the world the HOST asked for only
                // has to agree with it, because the host is the half that read the bytes.
                let is_cli = matches!(shape, wasihost::Shape::Cli(_));
                if is_cli && world != WORLD_CLI {
                    set_err("this artifact is a wasi:cli command that binds its own port, not a served wasi:http app");
                    return 0;
                }
                if !is_cli && world != WORLD_HTTP {
                    set_err("this artifact is a served wasi:http app, not a wasi:cli command");
                    return 0;
                }
                Loaded::Wasi { store, shape, running: false }
            }
            Err(e) => {
                // The usual cause is an import this enclave does not provide - wasi:filesystem,
                // or wasi:http on a build without it. Carry wasmtime's own words out.
                set_err_owned(format!("instantiate: {e:?}"));
                return 0;
            }
        }
    } else {
        let mut linker: Linker<HostState> = Linker::new(&engine);
        if App::add_to_linker::<_, wasmtime::component::HasSelf<_>>(&mut linker, |s| s).is_err() {
            set_err("linker"); return 0;
        }
        // The card share this deployment bought, from the environment the host built out of the
        // ledger record. Absent or unparseable means none, which is the safe direction.
        let gpu_milli = envv.iter().find(|(k, _)| k == "ENCLAVE_GPU_MILLI")
            .and_then(|(_, v)| v.parse::<u32>().ok()).unwrap_or(0);
        let mut store = Store::new(&engine, HostState { gpu_milli });
        // BEFORE instantiate, for the same reason the WASI branch does it: epoch interruption is
        // on for the whole engine, so a fresh store's deadline is ALREADY expired and the guest
        // traps on its first instruction - "wasm trap: interrupt", inside the component's own
        // initialiser. This world is a function call rather than a server and never looked like it
        // needed a deadline, which is exactly how it went missing when the interruption landed for
        // wasi:cli: every enclave:app app has failed to load since.
        store.set_epoch_deadline(1);
        match App::instantiate(&mut store, &component, &linker) {
            Ok(instance) => Loaded::Enclave { store, instance },
            Err(e) => { set_err_owned(format!("instantiate: {e:?}")); return 0; }
        }
    };
    // The engine goes into the slot with the app (the table keeps it for ee_rt_stop); the handle
    // carries this occupancy's generation, so it can never later resolve to a different app.
    match APPS.insert(loaded, engine) {
        Some(handle) => handle,
        None => { set_err("no free app slot in this enclave"); 0 }
    }
}

/// Run one request through the app. The response is written into the caller's buffer, which lives
/// in VTL0: the app's own memory is never handed out, only the bytes it chose to answer with.
#[no_mangle]
pub extern "C" fn ee_rt_handle(id: u32, req: *const u8, req_len: usize,
                               out: *mut u8, out_cap: usize, out_len: *mut usize) -> i32 {
    if id == 0 || req.is_null() || out.is_null() || out_len.is_null() { return -1; }
    let buf = unsafe { core::slice::from_raw_parts(req, req_len) };
    let request = match decode_request(buf) { Some(r) => r, None => { set_err("malformed request frame"); return -3 } };
    // Check the app OUT of its slot for the request so the table lock is not held across the
    // guest call; the slot stays occupied (Busy) so nothing reuses it, and checkin puts it back
    // (or frees it if a close arrived meanwhile). A handle that names no idle loaded app -- gone,
    // running, or stale after a slot reuse -- gets -2 here rather than reaching another tenant.
    let mut app = match APPS.checkout(id) { Some(a) => a, None => return -2 };
    // The two kinds answer the same frame; only the world in between differs.
    let result: Result<Vec<u8>, (i32, Option<String>)> = match &mut app {
        Loaded::Enclave { store, instance } => match instance.call_handle(store, &request) {
            Ok(resp) => Ok(encode_response(&resp)),
            Err(e) => Err((-4, Some(format!("the app trapped: {e:?}")))),
        },
        Loaded::Wasi { store, shape, .. } => match shape {
            wasihost::Shape::Http(func) => {
                store.data_mut().now_ms = unsafe { ee_app_now_ms() };
                match wasihost::serve(store, func, &request) {
                    Ok(v) => Ok(v),
                    Err(msg) => Err((-4, Some(msg))),
                }
            }
            // A wasi:cli app is not called per request: it holds its own socket and the host
            // carries connections to it. Nothing should be sending frames here.
            wasihost::Shape::Cli(_) => Err((-6, Some(String::from("this app serves its own socket; requests go to its port, not through the gate")))),
        },
    };
    // Return the app to its slot before answering. If a host close arrived mid-request the app is
    // freed here instead; either way the store is no longer aliased.
    APPS.checkin(id, app);
    let enc = match result {
        Ok(v) => v,
        Err((code, Some(msg))) => { set_err_owned(msg); return code; }
        Err((code, None)) => return code,
    };
    if enc.len() > out_cap {
        // Say how much was needed rather than truncating a tenant's response into something that
        // looks like their app's answer.
        unsafe { *out_len = enc.len() };
        return -5;
    }
    unsafe {
        core::ptr::copy_nonoverlapping(enc.as_ptr(), out, enc.len());
        *out_len = enc.len();
    }
    0
}

/// Run a wasi:cli app's `run()`, here, on this thread, until it returns or is interrupted.
///
/// The host calls this on a thread of its own (ee-host.c spawns it and enters EeAppRun), because a
/// server's run() does not return: it binds its port through the brokered sockets and accepts
/// until the lease ends. The app's slot is TAKEN for the duration, so nothing on the gate thread
/// can touch a store that is being run on this one - there is no lock here, only ownership.
#[no_mangle]
pub extern "C" fn ee_rt_run(id: u32) -> i32 {
    if id == 0 { return -1; }
    // begin_run moves the Store to this thread but LEAVES the slot occupied (Running), so no
    // ee_rt_open can reuse it and hand a second app the same handle -- the core of the fix.
    let mut taken = match APPS.begin_run(id) { Some(a) => a, None => return -2 };
    let rc = match &mut taken {
        Loaded::Wasi { store, shape, running } => match shape {
            wasihost::Shape::Cli(func) => {
                *running = true;
                let f = func.clone();
                match f.call(&mut *store, ()) {
                    Ok((Ok(()),)) => 0,
                    Ok((Err(()),)) => { set_err("the app's run() returned an error"); -3 }
                    Err(e) => { set_err_owned(format!("the app stopped: {e:?}")); -4 }
                }
            }
            wasihost::Shape::Http(_) => { set_err("this app is served per request, not run"); -5 }
        },
        Loaded::Enclave { .. } => { set_err("an enclave:app app is served per request, not run"); -5 }
    };
    // Whatever happened, the slot goes back to empty -- but ONLY if it still holds this exact
    // occupancy. If the app was stopped and its slot already freed and reused by another tenant
    // (a different generation), finish_run is a no-op, so this late teardown cannot free the
    // newcomer. The app's memory is freed by dropping `taken` regardless.
    APPS.finish_run(id);
    drop(taken);
    rc
}

/// Ask a running wasi:cli app to stop. Safe to call from any thread: it only bumps the engine's
/// epoch, which makes the guest trap wherever it is, and its own thread does the freeing.
#[no_mangle]
pub extern "C" fn ee_rt_stop(id: u32) -> i32 {
    if id == 0 { return -1; }
    // Only the app running under THIS exact handle yields an engine; a stopped, absent or
    // stale-after-reuse handle yields None and returns -2. That is what makes a wrong-tenant stop
    // impossible by construction: ee_rt_stop can no longer reach an app the caller did not name.
    let e = match APPS.running_engine(id) { Some(e) => e, None => return -2 };
    e.increment_epoch();
    e.increment_epoch();
    0
}

/// Unload a wasi:http app and free its memory inside the enclave. A wasi:cli app is stopped with
/// `ee_rt_stop` instead (its own run thread frees it); closing one here is refused.
#[no_mangle]
pub extern "C" fn ee_rt_close(id: u32) -> i32 {
    if id == 0 { return -1; }
    match APPS.remove(id) {
        // Idle app taken out: drop it here, outside the table lock.
        Removed::Took(app) => { drop(app); 0 }
        // It was mid-request; it will free itself when the request finishes.
        Removed::Deferred => 0,
        // A running wasi:cli app, or a stale/absent handle: not closable this way.
        Removed::NotClosable => -2,
    }
}

/// The last failure, as text, for the record the tenant reads. Never a pointer into app memory.
#[no_mangle]
pub extern "C" fn ee_rt_last_error(out: *mut u8, cap: usize) -> usize {
    let e = unsafe { (*core::ptr::addr_of!(LAST_ERROR)).as_ref() };
    let s = match e { Some(s) => s.as_bytes(), None => b"" as &[u8] };
    let n = s.len().min(cap);
    if !out.is_null() && n > 0 { unsafe { core::ptr::copy_nonoverlapping(s.as_ptr(), out, n) } }
    n
}

/// Is the runtime present in this enclave image, and what does it run? The host publishes this so
/// a row cannot claim in-enclave app hosting from an image that does not carry the runtime.
/// The runtime's ABI, and ALSO the tag the host names cached bytecode after: a cwasm records the
/// tunables it was compiled with and the runtime refuses a mismatch ("Module was compiled without
/// epoch interruption but it is enabled for the host"), so bytecode compiled by an older
/// ee-precompile must not be reused. BUMP THIS whenever the precompiler's settings change, and
/// also whenever the enclave:app world changes shape: 4 made `generate` return a result, because
/// the model is now something a deployment BUYS (a share of this box's card) and "you may not
/// ask" has to be distinguishable from "here is your completion". 5 turned 64-bit memories on,
/// which is a compile-time feature and therefore recorded in every cwasm.
#[no_mangle]
pub extern "C" fn ee_rt_abi() -> u32 { 5 }

/// Which worlds this build serves, as a bitmask: 1 = enclave:app, 2 = wasi:http. The host
/// publishes it, so a row cannot claim to host ordinary platform apps from an image whose runtime
/// only knows the enclave world.
#[no_mangle]
pub extern "C" fn ee_rt_worlds() -> u32 { WORLD_ENCLAVE | WORLD_HTTP | WORLD_CLI }

/// Which WASM FEATURES this build actually enables, as a bitmask. The node publishes the platform
/// capability flags (`mem64`, `set`, `p3`, `threads`) off this and nothing else: a version whose
/// catalog config declares one is refused by name unless the bit is set here.
///
/// DETECTED rather than configured, for the same reason `appsInTee` is. These are compile-time
/// engine features - a cwasm records them and the runtime refuses a mismatch - so the only honest
/// source is the build itself. A flag in a config file could say `mem64: true` over an image that
/// would then refuse every 64-bit artifact it was handed, after taking the lease.
pub const FEAT_MEM64: u32 = 1;         // 64-bit linear memories (catalog `mem64`)
pub const FEAT_SET: u32 = 2;           // shared-everything threads (catalog `set`)
pub const FEAT_P3: u32 = 4;            // wasip3 (catalog `wasi: "0.3"`)
pub const FEAT_COOP_THREADS: u32 = 8;  // cooperative threads (catalog `threads`)
#[no_mangle]
pub extern "C" fn ee_rt_features() -> u32 {
    // SET is here now: Pulley has the atomics, ordinary accesses are byte-wise, the wasm atomic
    // instructions take striped locks, bulk operations and the wait precondition go the same way,
    // and the threading the proposal needs is built on four enclave hooks rather than on `std`.
    //
    // WHAT IS NOT HERE: `thread.spawn`. wasmtime's set_threads module is still std-only (mpsc,
    // io, process::abort), so a guest that spawns traps instead of running. A guest that only
    // needs a SHARED MEMORY and atomics - which is what the artifacts in the catalog actually
    // carry - runs. This is a deliberate, temporary limitation and windows/PARITY.md records it.
    FEAT_MEM64 | FEAT_SET
}
