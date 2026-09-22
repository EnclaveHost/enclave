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

wasmtime::component::bindgen!({
    path: "wit",
    world: "app",
});

struct HostState;

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
    fn generate(&mut self, prompt: String, max_tokens: u32) -> String {
        let p = prompt.as_bytes();
        let mut out = vec![0u8; 64 * 1024];
        let mut n: usize = 0;
        let rc = unsafe {
            ee_app_generate(p.as_ptr(), p.len(), max_tokens.min(2048),
                            out.as_mut_ptr(), out.len(), &mut n)
        };
        if rc != 0 { return String::new(); }
        out.truncate(n.min(out.len()));
        String::from_utf8(out).unwrap_or_default()
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

const MAX_APPS: usize = 8;
static mut APPS: [Option<Loaded>; MAX_APPS] = [None, None, None, None, None, None, None, None];
/// A clone of each app's engine, kept OUTSIDE the slot so a stop can reach a running app without
/// touching the store its own thread is using. An Engine is a handle, not the app.
static mut RUN_ENGINES: [Option<wasmtime::Engine>; MAX_APPS] = [None, None, None, None, None, None, None, None];
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
    let mut config = Config::new();
    // The interpreter target, and the artifact must match it: a cwasm carrying machine code for a
    // real ISA is refused here rather than mapped executable, which is the point.
    if config.target("pulley64").is_err() { set_err("pulley64 target unavailable"); return 0; }
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
        let mut store = Store::new(&engine, HostState);
        match App::instantiate(&mut store, &component, &linker) {
            Ok(instance) => Loaded::Enclave { store, instance },
            Err(e) => { set_err_owned(format!("instantiate: {e:?}")); return 0; }
        }
    };
    unsafe {
        let apps = &mut *core::ptr::addr_of_mut!(APPS);
        let engines = &mut *core::ptr::addr_of_mut!(RUN_ENGINES);
        for (i, slot) in apps.iter_mut().enumerate() {
            if slot.is_none() {
                *slot = Some(loaded);
                engines[i] = Some(engine.clone());     // for ee_rt_stop, see RUN_ENGINES
                return (i + 1) as u32;
            }
        }
    }
    set_err("no free app slot in this enclave");
    0
}

/// Run one request through the app. The response is written into the caller's buffer, which lives
/// in VTL0: the app's own memory is never handed out, only the bytes it chose to answer with.
#[no_mangle]
pub extern "C" fn ee_rt_handle(id: u32, req: *const u8, req_len: usize,
                               out: *mut u8, out_cap: usize, out_len: *mut usize) -> i32 {
    if id == 0 || id as usize > MAX_APPS || req.is_null() || out.is_null() || out_len.is_null() { return -1; }
    let app = unsafe {
        let apps = &mut *core::ptr::addr_of_mut!(APPS);
        match apps[id as usize - 1].as_mut() { Some(a) => a, None => return -2 }
    };
    let buf = unsafe { core::slice::from_raw_parts(req, req_len) };
    let request = match decode_request(buf) { Some(r) => r, None => { set_err("malformed request frame"); return -3 } };
    // The two kinds answer the same frame; only the world in between differs.
    let enc = match app {
        Loaded::Enclave { store, instance } => {
            let resp = match instance.call_handle(store, &request) {
                Ok(r) => r,
                Err(e) => { set_err_owned(format!("the app trapped: {e:?}")); return -4 }
            };
            encode_response(&resp)
        }
        Loaded::Wasi { store, shape, .. } => match shape {
            wasihost::Shape::Http(func) => {
                store.data_mut().now_ms = unsafe { ee_app_now_ms() };
                match wasihost::serve(store, func, &request) {
                    Ok(v) => v,
                    Err(msg) => { set_err_owned(msg); return -4 }
                }
            }
            // A wasi:cli app is not called per request: it holds its own socket and the host
            // carries connections to it. Nothing should be sending frames here.
            wasihost::Shape::Cli(_) => { set_err("this app serves its own socket; requests go to its port, not through the gate"); return -6 }
        },
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
    if id == 0 || id as usize > MAX_APPS { return -1; }
    let mut taken = unsafe {
        let apps = &mut *core::ptr::addr_of_mut!(APPS);
        match apps[id as usize - 1].take() { Some(a) => a, None => return -2 }
    };
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
    // Whatever happened, the slot goes back to empty: the app is gone and its memory with it.
    unsafe {
        let engines = &mut *core::ptr::addr_of_mut!(RUN_ENGINES);
        engines[id as usize - 1] = None;
    }
    drop(taken);
    rc
}

/// Ask a running wasi:cli app to stop. Safe to call from any thread: it only bumps the engine's
/// epoch, which makes the guest trap wherever it is, and its own thread does the freeing.
#[no_mangle]
pub extern "C" fn ee_rt_stop(id: u32) -> i32 {
    if id == 0 || id as usize > MAX_APPS { return -1; }
    let e = unsafe {
        let engines = &*core::ptr::addr_of!(RUN_ENGINES);
        match engines[id as usize - 1].as_ref() { Some(e) => e.clone(), None => return -2 }
    };
    e.increment_epoch();
    e.increment_epoch();
    0
}

/// Unload an app and free its memory inside the enclave.
#[no_mangle]
pub extern "C" fn ee_rt_close(id: u32) -> i32 {
    if id == 0 || id as usize > MAX_APPS { return -1; }
    unsafe {
        let apps = &mut *core::ptr::addr_of_mut!(APPS);
        let engines = &mut *core::ptr::addr_of_mut!(RUN_ENGINES);
        apps[id as usize - 1] = None;
        engines[id as usize - 1] = None;
    }
    0
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
#[no_mangle]
pub extern "C" fn ee_rt_abi() -> u32 { 2 }

/// Which worlds this build serves, as a bitmask: 1 = enclave:app, 2 = wasi:http. The host
/// publishes it, so a row cannot claim to host ordinary platform apps from an image whose runtime
/// only knows the enclave world.
#[no_mangle]
pub extern "C" fn ee_rt_worlds() -> u32 { WORLD_ENCLAVE | WORLD_HTTP | WORLD_CLI }
