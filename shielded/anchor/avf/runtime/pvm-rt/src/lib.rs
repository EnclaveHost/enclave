//! pvm-rt: the portable app runtime inside the Pixel pVM (shielded/anchor/avf/PVM-CPU.md, "The app runtime").
//!
//! The app is the same WebAssembly component every Enclave host runs. A stock Microdroid payload may not create an
//! executable page (SELinux denies `execmem`: results/jit-probe-20260923), so inside the pVM the component is compiled
//! by Cranelift to wasmtime's Pulley bytecode -- data, never native code -- and interpreted. What this crate enforces,
//! each refusal fail-closed, before and around running a component:
//!   - W^X: it refuses to compile if the process holds any writable+executable mapping, and it never creates one;
//!   - verify before compile: the bundle's SHA-256 must equal the expected digest before Cranelift sees a byte;
//!   - no host-supplied native code and no compiled cache: modules are never deserialised; every bundle is compiled here;
//!   - limits and cleanup: a per-run memory limit (StoreLimits), an epoch deadline, and the Store dropped at the end;
//!   - identity: `identity()` is the runtime identity the isolation contract binds into attestation (RuntimeIdentity:
//!     wasmtime, this exact version, execution interpreter, targetIsa pulley64, hostIsa aarch64 on the phone);
//!   - models: wasi:nn is linked only when the payload hands over its verified in-VM engine (`nn`), and then serves exactly
//!     that one graph by name; a component can neither load its own weights nor reach another model.

pub mod httpd;
pub mod nn;
pub mod proof;
pub mod sealed;

use sha2::{Digest, Sha256};
use std::ffi::{c_char, c_int, CStr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Result, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::p2::bindings::sync::Command;
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::{I32Exit, WasiCtx, WasiCtxView, WasiView};
use wasmtime_wasi_nn::wit::{WasiNnCtx, WasiNnView};

pub const RUNTIME_NAME: &str = "wasmtime";
pub const RUNTIME_VERSION: &str = "49.0.0"; // Cargo.toml pins wasmtime =49.0.0; a test keeps the two equal
pub const TARGET_ISA: &str = "pulley64";
pub const EXECUTION: &str = "interpreter";

/// The ISA this library itself runs on (the interpreter's host).
pub fn host_isa() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        "unknown"
    }
}

/// The runtime identity in the isolation contract's field set (isolation/contract/runtime.go RuntimeIdentity).
/// cpuFeatures is "baseline": Pulley bytecode does not depend on host CPU features.
pub fn identity() -> [(&'static str, &'static str); 8] {
    [
        ("name", RUNTIME_NAME),
        ("version", RUNTIME_VERSION),
        ("execution", EXECUTION),
        ("targetIsa", TARGET_ISA),
        ("hostIsa", host_isa()),
        ("cpuFeatures", "baseline"),
        ("wx", "enforced"),
        ("cache", "none"),
    ]
}

struct State {
    ctx: WasiCtx,
    table: ResourceTable,
    limits: StoreLimits,
    nn: WasiNnCtx,
}
impl WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.ctx,
            table: &mut self.table,
        }
    }
}

/// The one engine configuration. Every setting is fixed here, so the identity above describes exactly what runs.
pub fn engine() -> Result<Engine> {
    Engine::new(&engine_config()?)
}

/// The configuration behind `engine()`, shared with the HTTP server (httpd.rs), so both compile and run the same way.
pub fn engine_config() -> Result<Config> {
    let mut c = Config::new();
    c.target(TARGET_ISA)?; // Cranelift emits Pulley bytecode: data the interpreter reads, never an executable page
    c.wasm_component_model(true);
    c.signals_based_traps(false); // every bounds check explicit: no reliance on guard-page faults
    c.memory_reservation(0); // the VBS enclave's settings, which also run Pulley without executable memory
    c.memory_guard_size(0);
    c.memory_init_cow(false);
    c.epoch_interruption(true); // the run deadline
    Ok(c)
}

/// W^X, then the digest, then Cranelift: the only way a component is compiled in this crate.
pub fn verify_and_compile(
    engine: &Engine,
    bundle: &[u8],
    expected_sha256: &[u8; 32],
) -> Result<Component> {
    if wx_mappings() != 0 {
        wasmtime::bail!("W^X: the process holds a writable+executable mapping (or /proc/self/maps is unreadable); refusing to compile");
    }
    let got = Sha256::digest(bundle);
    if got.as_slice() != expected_sha256 {
        wasmtime::bail!(
            "bundle sha256 {} is not the expected {}: refusing to compile",
            hex(&got),
            hex(expected_sha256)
        );
    }
    Component::from_binary(engine, bundle) // from the verified bytes; never Component::deserialize
}

/// Writable+executable mappings in this process (/proc/self/maps). Any at all refuses the run.
pub fn wx_mappings() -> usize {
    std::fs::read_to_string("/proc/self/maps")
        .map(|m| {
            m.lines()
                .filter(|l| {
                    let p = l.split_whitespace().nth(1).unwrap_or("");
                    p.contains('w') && p.contains('x')
                })
                .count()
        })
        .unwrap_or(usize::MAX) // unreadable maps: refuse (cannot state W^X)
}

pub struct RunOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub compile_ms: u128,
    pub run_ms: u128,
}

/// The model a run may use through wasi:nn: the name the component loads it by, and the verified engine behind it.
pub struct NnModel {
    pub name: String,
    pub engine: Arc<dyn nn::NnEngine>,
}

/// Verify, compile inside this process to Pulley, run a wasi:cli component once, tear it down. No wasi:nn.
pub fn run_cli(
    bundle: &[u8],
    expected_sha256: &[u8; 32],
    args: &[String],
    mem_limit: usize,
    deadline: Duration,
) -> Result<RunOutput> {
    run_app(bundle, expected_sha256, args, mem_limit, deadline, None)
}

/// `run_cli` with an optional model: when `model` is given, wasi:nn is linked and serves that one graph (nn.rs); without
/// it a component that imports wasi:nn does not instantiate.
pub fn run_app(
    bundle: &[u8],
    expected_sha256: &[u8; 32],
    args: &[String],
    mem_limit: usize,
    deadline: Duration,
    model: Option<NnModel>,
) -> Result<RunOutput> {
    if let Some(m) = &model {
        if !nn::valid_graph_name(&m.name) {
            wasmtime::bail!(
                "graph name {:?} is not 1..64 of [a-z0-9._-]: refusing",
                m.name
            );
        }
    }
    let engine = engine()?;
    let t0 = Instant::now();
    let component = verify_and_compile(&engine, bundle, expected_sha256)?;
    let compile_ms = t0.elapsed().as_millis();
    let mut linker = Linker::<State>::new(&engine);
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker)?;
    let nn_ctx = match model {
        Some(m) => {
            wasmtime_wasi_nn::wit::add_to_linker(&mut linker, |s: &mut State| {
                WasiNnView::new(&mut s.table, &mut s.nn)
            })?;
            nn::context(&m.name, m.engine)
        }
        None => nn::context_none(),
    };
    let out = MemoryOutputPipe::new(1 << 20);
    let err = MemoryOutputPipe::new(1 << 16);
    let mut b = WasiCtx::builder();
    let mut argv = vec!["app".to_string()];
    argv.extend_from_slice(args); /* argv[0] is the program, as `wasmtime run` sets it */
    b.args(&argv).stdout(out.clone()).stderr(err.clone());
    let limits = StoreLimitsBuilder::new()
        .memory_size(mem_limit)
        .instances(64)
        .tables(64)
        .memories(16)
        .trap_on_grow_failure(true)
        .build();
    let mut store = Store::new(
        &engine,
        State {
            ctx: b.build(),
            table: ResourceTable::new(),
            limits,
            nn: nn_ctx,
        },
    );
    store.limiter(|s| &mut s.limits);
    store.set_epoch_deadline(1);
    let done = Arc::new(AtomicBool::new(false));
    let watchdog = {
        let (e, d) = (engine.clone(), done.clone());
        std::thread::spawn(move || {
            let t = Instant::now();
            while !d.load(Ordering::Acquire) {
                if t.elapsed() >= deadline {
                    e.increment_epoch();
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        })
    };
    let t1 = Instant::now();
    let result = Command::instantiate(&mut store, &component, &linker)
        .and_then(|cmd| cmd.wasi_cli_run().call_run(&mut store));
    let run_ms = t1.elapsed().as_millis();
    done.store(true, Ordering::Release);
    let _ = watchdog.join();
    drop(store); // deterministic teardown: instances, memories and tables go here, before returning
    let exit_code = match result {
        Ok(Ok(())) => 0,
        Ok(Err(())) => 1,
        Err(e) => match e.downcast_ref::<I32Exit>() {
            Some(x) => x.0,
            None => return Err(e),
        },
    };
    Ok(RunOutput {
        exit_code,
        stdout: out.contents().to_vec(),
        stderr: err.contents().to_vec(),
        compile_ms,
        run_ms,
    })
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---- the C ABI the pVM payload calls (dlopen'd from the measured APK) ----
//
// Every pointer and length is checked here, before any dereference or pointer arithmetic; an invalid argument refuses the
// call (-1, the reason in `err` when `err` is usable) and nothing is compiled or run. What cannot be checked is stated as
// the caller's contract: a non-null `argv[i]` must point to a NUL-terminated string, and `bundle` must point to `len`
// readable bytes.

/// The largest bundle this runtime accepts (the APP line's bound, payload/anchor_app.h). Checked before the slice is made.
pub const MAX_BUNDLE_BYTES: usize = 1 << 30;
/// The largest argument count.
pub const MAX_ARGS: c_int = 4096;

fn put(out: *mut c_char, cap: usize, s: &str) {
    if out.is_null() || cap == 0 {
        return;
    }
    let n = s.len().min(cap - 1);
    // SAFETY: `out` is non-null and the caller provides `cap` writable bytes; n + 1 <= cap.
    unsafe {
        std::ptr::copy_nonoverlapping(s.as_ptr(), out as *mut u8, n);
        *out.add(n) = 0;
    }
}

/// The runtime identity as canonical JSON (keys sorted, as the contract's canonical encoder writes them). Returns 0 when the
/// whole identity was written, -1 when `out` is null, `cap` is 0, or the identity did not fit (then `out` holds a
/// NUL-terminated prefix).
#[no_mangle]
pub extern "C" fn pvmrt_identity(out: *mut c_char, cap: usize) -> c_int {
    if out.is_null() || cap == 0 {
        return -1;
    }
    let mut kv: Vec<(&str, &str)> = identity().to_vec();
    kv.sort_by(|a, b| a.0.cmp(b.0));
    let json = format!(
        "{{{}}}",
        kv.iter()
            .map(|(k, v)| format!("\"{k}\":\"{v}\""))
            .collect::<Vec<_>>()
            .join(",")
    );
    put(out, cap, &json);
    if json.len() < cap {
        0
    } else {
        -1
    }
}

/// The output callback: stream 1 = stdout, 2 = stderr, bytes and length. Nullable at the boundary (a C caller can pass
/// NULL); a call without one is refused, because its output would be lost.
pub type EmitFn = Option<extern "C" fn(c_int, *const u8, usize)>;

/// Reads `argc` arguments from `argv`, refusing a null `argv` (with argc > 0), a negative or too large `argc`, and a null
/// entry, all before any pointer arithmetic past a checked pointer.
fn collect_args(
    argv: *const *const c_char,
    argc: c_int,
) -> std::result::Result<Vec<String>, String> {
    if argc < 0 || argc > MAX_ARGS {
        return Err(format!("argc {argc} is not in 0..={MAX_ARGS}"));
    }
    if argc > 0 && argv.is_null() {
        return Err(format!("argv is null with argc {argc}"));
    }
    let mut args = Vec::with_capacity(argc as usize);
    for i in 0..argc as usize {
        // SAFETY: argv is non-null and, by the caller's contract, holds argc pointers.
        let p = unsafe { *argv.add(i) };
        if p.is_null() {
            return Err(format!("argv[{i}] is null (argc {argc})"));
        }
        // SAFETY: a non-null argv entry is a NUL-terminated string by the caller's contract.
        args.push(unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned());
    }
    Ok(args)
}

/// The checks every entry point makes, in order, before any pointer is dereferenced: bundle (non-null, 1..=MAX_BUNDLE_BYTES),
/// digest, memory limit, deadline, and the model (both of nn_name/nn_ops or neither; a valid graph name; a complete ops
/// table). What cannot be checked is the caller's contract: `bundle` holds `len` readable bytes, `sha256` 32, `nn_name` is
/// NUL-terminated, `nn_ops` stays valid for as long as the run (or the HTTP server) uses it.
fn checked_inputs<'a>(
    bundle: *const u8,
    len: usize,
    sha256: *const u8,
    mem_limit: u64,
    deadline_ms: u64,
    nn_name: *const c_char,
    nn_ops: *const nn::NnOps,
) -> std::result::Result<(&'a [u8], [u8; 32], Option<NnModel>), String> {
    if bundle.is_null() || len == 0 {
        return Err("no bundle".into());
    }
    if len > MAX_BUNDLE_BYTES {
        return Err(format!("bundle length {len} exceeds {MAX_BUNDLE_BYTES}"));
    }
    if sha256.is_null() {
        return Err("no expected digest".into());
    }
    if mem_limit == 0 || mem_limit > usize::MAX as u64 {
        return Err("mem_limit must be > 0 and fit this platform".into());
    }
    if deadline_ms == 0 {
        return Err("deadline_ms must be > 0".into());
    }
    let model = match (nn_name.is_null(), nn_ops.is_null()) {
        (true, true) => None,
        (false, false) => {
            // SAFETY: nn_name is non-null and NUL-terminated by the caller's contract.
            let name = unsafe { CStr::from_ptr(nn_name) }
                .to_string_lossy()
                .into_owned();
            if !nn::valid_graph_name(&name) {
                return Err(format!("graph name {name:?} is not 1..64 of [a-z0-9._-]"));
            }
            // SAFETY: nn_ops is non-null and valid for the run by the caller's contract.
            let e = unsafe { nn::CEngine::from_ops(nn_ops) }?;
            Some(NnModel {
                name,
                engine: Arc::new(e),
            })
        }
        _ => return Err("nn_name and nn_ops come together: exactly one of them is null".into()),
    };
    // SAFETY: bundle is non-null and len is in 1..=MAX_BUNDLE_BYTES; the caller provides len readable bytes.
    let bytes = unsafe { std::slice::from_raw_parts(bundle, len) };
    let mut want = [0u8; 32];
    // SAFETY: sha256 is non-null and points to 32 bytes by the caller's contract.
    unsafe { std::ptr::copy_nonoverlapping(sha256, want.as_mut_ptr(), 32) };
    Ok((bytes, want, model))
}

/// Run a wasi:cli component. Returns 0 when it ran (its exit code in `*exit_code`, its output through `emit`), -1 when the
/// call was refused or the run failed (the reason in `err`). Nothing is compiled unless every argument is valid and the
/// bundle's digest matches. No wasi:nn: `pvmrt_run_app` with a model for that.
#[no_mangle]
pub extern "C" fn pvmrt_run_cli(
    bundle: *const u8,
    len: usize,
    sha256: *const u8,
    argv: *const *const c_char,
    argc: c_int,
    mem_limit: u64,
    deadline_ms: u64,
    emit: EmitFn,
    exit_code: *mut c_int,
    compile_ms: *mut u64,
    run_ms: *mut u64,
    err: *mut c_char,
    errcap: usize,
) -> c_int {
    pvmrt_run_app(
        bundle,
        len,
        sha256,
        argv,
        argc,
        mem_limit,
        deadline_ms,
        std::ptr::null(),
        std::ptr::null(),
        emit,
        exit_code,
        compile_ms,
        run_ms,
        err,
        errcap,
    )
}

/// `pvmrt_run_cli` plus the model: `nn_name` (NUL-terminated, 1..64 of [a-z0-9._-]) is the name the component loads the
/// graph by, `nn_ops` the payload's verified engine (nn.rs NnOps; it must stay valid until this call returns). Both null =
/// no wasi:nn; exactly one null is refused.
#[no_mangle]
pub extern "C" fn pvmrt_run_app(
    bundle: *const u8,
    len: usize,
    sha256: *const u8,
    argv: *const *const c_char,
    argc: c_int,
    mem_limit: u64,
    deadline_ms: u64,
    nn_name: *const c_char,
    nn_ops: *const nn::NnOps,
    emit: EmitFn,
    exit_code: *mut c_int,
    compile_ms: *mut u64,
    run_ms: *mut u64,
    err: *mut c_char,
    errcap: usize,
) -> c_int {
    let refuse = |why: &str| {
        put(err, errcap, why);
        -1
    };
    let Some(emit) = emit else {
        return refuse("no emit callback: the output would be lost; refusing");
    };
    let args = match collect_args(argv, argc) {
        Ok(a) => a,
        Err(e) => return refuse(&e),
    };
    let (bytes, want, model) =
        match checked_inputs(bundle, len, sha256, mem_limit, deadline_ms, nn_name, nn_ops) {
            Ok(x) => x,
            Err(e) => return refuse(&e),
        };
    match run_app(
        bytes,
        &want,
        &args,
        mem_limit as usize,
        Duration::from_millis(deadline_ms),
        model,
    ) {
        Ok(o) => {
            emit(1, o.stdout.as_ptr(), o.stdout.len());
            emit(2, o.stderr.as_ptr(), o.stderr.len());
            // SAFETY: each out-pointer is written only when non-null.
            unsafe {
                if !exit_code.is_null() {
                    *exit_code = o.exit_code;
                }
                if !compile_ms.is_null() {
                    *compile_ms = o.compile_ms as u64;
                }
                if !run_ms.is_null() {
                    *run_ms = o.run_ms as u64;
                }
            }
            0
        }
        Err(e) => refuse(&format!("{e:#}")),
    }
}

// ---- wasi:http (httpd.rs): a component served on connections the payload accepts ----

/// Verify, compile and pre-instantiate a `wasi:http/proxy` component (httpd.rs). Returns the server, or null when refused
/// (the reason in `err`). `emit` receives the server's notes and each request's stderr (stream 2). `nn_name`/`nn_ops` as in
/// `pvmrt_run_app`; the ops must stay valid until `pvmrt_http_close`. `deadline_ms` bounds each request.
#[no_mangle]
pub extern "C" fn pvmrt_http_open(
    bundle: *const u8,
    len: usize,
    sha256: *const u8,
    mem_limit: u64,
    deadline_ms: u64,
    nn_name: *const c_char,
    nn_ops: *const nn::NnOps,
    emit: EmitFn,
    compile_ms: *mut u64,
    err: *mut c_char,
    errcap: usize,
) -> *mut httpd::HttpServer {
    http_open(
        bundle,
        len,
        sha256,
        mem_limit,
        deadline_ms,
        nn_name,
        nn_ops,
        None,
        emit,
        compile_ms,
        err,
        errcap,
    )
}

/// `pvmrt_http_open` with TLS 1.3 terminating in this process (httpd.rs `with_tls`): `tls_seed` is the 32-byte seed of the
/// VM's attested Ed25519 transport key, the TLS server key. It is copied, not kept; null is refused.
#[no_mangle]
pub extern "C" fn pvmrt_https_open(
    bundle: *const u8,
    len: usize,
    sha256: *const u8,
    mem_limit: u64,
    deadline_ms: u64,
    nn_name: *const c_char,
    nn_ops: *const nn::NnOps,
    tls_seed: *const u8,
    emit: EmitFn,
    compile_ms: *mut u64,
    err: *mut c_char,
    errcap: usize,
) -> *mut httpd::HttpServer {
    if tls_seed.is_null() {
        put(err, errcap, "no TLS key seed: refusing to serve https");
        return std::ptr::null_mut();
    }
    let mut seed = [0u8; 32];
    // SAFETY: tls_seed is non-null and points to 32 bytes by the caller's contract.
    unsafe { std::ptr::copy_nonoverlapping(tls_seed, seed.as_mut_ptr(), 32) };
    let r = http_open(
        bundle,
        len,
        sha256,
        mem_limit,
        deadline_ms,
        nn_name,
        nn_ops,
        Some(&seed),
        emit,
        compile_ms,
        err,
        errcap,
    );
    seed.iter_mut().for_each(|b| *b = 0);
    r
}

#[allow(clippy::too_many_arguments)]
fn http_open(
    bundle: *const u8,
    len: usize,
    sha256: *const u8,
    mem_limit: u64,
    deadline_ms: u64,
    nn_name: *const c_char,
    nn_ops: *const nn::NnOps,
    tls_seed: Option<&[u8; 32]>,
    emit: EmitFn,
    compile_ms: *mut u64,
    err: *mut c_char,
    errcap: usize,
) -> *mut httpd::HttpServer {
    let refuse = |why: &str| {
        put(err, errcap, why);
        std::ptr::null_mut()
    };
    let Some(emit) = emit else {
        return refuse("no emit callback: the server's notes would be lost; refusing");
    };
    let (bytes, want, model) =
        match checked_inputs(bundle, len, sha256, mem_limit, deadline_ms, nn_name, nn_ops) {
            Ok(x) => x,
            Err(e) => return refuse(&e),
        };
    let log: Box<dyn Fn(&[u8]) + Send + Sync> =
        Box::new(move |b: &[u8]| emit(2, b.as_ptr(), b.len()));
    let opened = httpd::HttpServer::open(
        bytes,
        &want,
        mem_limit as usize,
        Duration::from_millis(deadline_ms),
        model,
        Some(log),
    )
    .and_then(|s| match tls_seed {
        Some(seed) => s.with_tls(seed),
        None => Ok(s),
    });
    match opened {
        Ok(s) => {
            if !compile_ms.is_null() {
                // SAFETY: written only when non-null.
                unsafe { *compile_ms = s.compile_ms as u64 };
            }
            Box::into_raw(Box::new(s))
        }
        Err(e) => refuse(&format!("{e:#}")),
    }
}

/// Serve HTTP/1.1 on one connected stream socket until the peer closes it; `fd` is owned and closed by this call (also
/// when it refuses). Returns 0 on a clean close, -1 otherwise (the reason in `err`).
#[no_mangle]
pub extern "C" fn pvmrt_http_serve_fd(
    srv: *mut httpd::HttpServer,
    fd: c_int,
    err: *mut c_char,
    errcap: usize,
) -> c_int {
    if fd < 0 {
        put(err, errcap, "no connection (fd < 0)");
        return -1;
    }
    if srv.is_null() {
        // SAFETY: the fd is ours to close by this function's contract.
        unsafe { libc_close(fd) };
        put(err, errcap, "no server");
        return -1;
    }
    // SAFETY: srv came from pvmrt_http_open and has not been closed (caller's contract); fd is a connected stream it owns.
    match unsafe { (*srv).serve_fd(fd) } {
        Ok(()) => 0,
        Err(e) => {
            put(err, errcap, &format!("{e:#}"));
            -1
        }
    }
}

/// Enable the browser channel (sealed.rs): a fresh X25519 app key for this app and runtime, made and kept in this process.
/// Writes its 32-byte public half to `pk_out`. Returns 0, or -1 on a null argument.
#[no_mangle]
pub extern "C" fn pvmrt_http_sealed_enable(
    srv: *mut httpd::HttpServer,
    app_id: *const u8,
    runtime_id: *const u8,
    pk_out: *mut u8,
) -> c_int {
    if srv.is_null() || app_id.is_null() || runtime_id.is_null() || pk_out.is_null() {
        return -1;
    }
    let (mut a, mut r) = ([0u8; 32], [0u8; 32]);
    // SAFETY: non-null, 32 bytes each by the caller's contract; srv came from pvmrt_http_open and is not being served yet.
    unsafe {
        std::ptr::copy_nonoverlapping(app_id, a.as_mut_ptr(), 32);
        std::ptr::copy_nonoverlapping(runtime_id, r.as_mut_ptr(), 32);
        let pk = (*srv).enable_sealed(&a, &r);
        std::ptr::copy_nonoverlapping(pk.as_ptr(), pk_out, 32);
    }
    0
}

/// The payload answered `nonce` (32 bytes) with v2 evidence: sealed requests under it are admitted for the window. Safe to
/// call from another thread while the server serves. Returns 0, or -1 when the channel is not enabled.
#[no_mangle]
pub extern "C" fn pvmrt_http_sealed_nonce(srv: *const httpd::HttpServer, nonce: *const u8) -> c_int {
    if srv.is_null() || nonce.is_null() {
        return -1;
    }
    let mut n = [0u8; 32];
    // SAFETY: non-null, 32 bytes by the caller's contract; srv is live (HttpServer is Sync, the key's state is locked).
    unsafe { std::ptr::copy_nonoverlapping(nonce, n.as_mut_ptr(), 32) };
    if unsafe { (*srv).sealed_admit_nonce(&n) } { 0 } else { -1 }
}

/// Serve one sealed request on one connected stream (sealed.rs framing); `fd` is owned and closed by this call. Returns 0
/// when a response or a refusal frame was written, -1 otherwise (the reason in `err`).
#[no_mangle]
pub extern "C" fn pvmrt_http_serve_sealed_fd(
    srv: *mut httpd::HttpServer,
    fd: c_int,
    err: *mut c_char,
    errcap: usize,
) -> c_int {
    if fd < 0 {
        put(err, errcap, "no connection (fd < 0)");
        return -1;
    }
    if srv.is_null() {
        // SAFETY: the fd is ours to close by this function's contract.
        unsafe { libc_close(fd) };
        put(err, errcap, "no server");
        return -1;
    }
    // SAFETY: srv came from pvmrt_http_open and has not been closed; fd is a connected stream it owns.
    match unsafe { (*srv).serve_sealed_fd(fd) } {
        Ok(()) => 0,
        Err(e) => {
            put(err, errcap, &format!("{e:#}"));
            -1
        }
    }
}

/// Requests served so far by this server.
#[no_mangle]
pub extern "C" fn pvmrt_http_requests(srv: *const httpd::HttpServer) -> u64 {
    if srv.is_null() {
        return 0;
    }
    // SAFETY: srv came from pvmrt_http_open and has not been closed.
    unsafe { (*srv).requests() }
}

/// Tear the server down: the compiled component, the pre-instance, the epoch ticker. Null is ignored.
#[no_mangle]
pub extern "C" fn pvmrt_http_close(srv: *mut httpd::HttpServer) {
    if !srv.is_null() {
        // SAFETY: srv came from pvmrt_http_open and is closed exactly once (caller's contract).
        drop(unsafe { Box::from_raw(srv) });
    }
}

extern "C" {
    #[link_name = "close"]
    fn libc_close(fd: c_int) -> c_int;
}
