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
//!   - CPU-only: the pVM CPU tier runs CPU-only workloads and carries no model. wasi:nn and every accelerator interface
//!     are never linked, so a component that imports one does not instantiate. The C entry points keep two reserved
//!     pointer slots where a model was once passed (nn_name, nn_ops); both must be null, and anything else is refused.

pub mod egress;
pub mod httpd;
pub mod loopnet;
pub mod proof;
pub mod sealed;
pub mod waf;

use sha2::{Digest, Sha256};
use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Result, Store, StoreLimits, StoreLimitsBuilder};
use wasmtime_wasi::p2::bindings::sync::Command;
use wasmtime_wasi::p2::pipe::MemoryOutputPipe;
use wasmtime_wasi::{I32Exit, WasiCtx, WasiCtxView, WasiView};

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

/// Verify, compile inside this process to Pulley, run a wasi:cli component once, tear it down. CPU-only: no wasi:nn and
/// no accelerator interface is linked, so a component that imports one does not instantiate.
pub fn run_cli(
    bundle: &[u8],
    expected_sha256: &[u8; 32],
    args: &[String],
    mem_limit: usize,
    deadline: Duration,
) -> Result<RunOutput> {
    run_app(bundle, expected_sha256, args, mem_limit, deadline)
}

/// The same run as `run_cli` (the C entry point `pvmrt_run_app` keeps its name and its reserved model slots).
pub fn run_app(
    bundle: &[u8],
    expected_sha256: &[u8; 32],
    args: &[String],
    mem_limit: usize,
    deadline: Duration,
) -> Result<RunOutput> {
    let engine = engine()?;
    let t0 = Instant::now();
    let component = verify_and_compile(&engine, bundle, expected_sha256)?;
    let compile_ms = t0.elapsed().as_millis();
    let mut linker = Linker::<State>::new(&engine);
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker)?;
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

/// The most instances one `bench` runs at once.
pub const MAX_BENCH_INSTANCES: usize = 64;

pub struct BenchOutput {
    /// each instance's stdout, in instance order
    pub stdout: Vec<Vec<u8>>,
    pub exit_codes: Vec<i32>,
    pub compile_ms: u128,
    /// from the moment every instance was released together to the moment the last one finished
    pub wall_ms: u128,
}

/// The tier's compute measurement (PVM-CPU.md, "Capacity"). It verifies and compiles a wasi:cli component ONCE, exactly as
/// `run_app` does, and instantiates it `instances` times, one thread each. All of them are released at once from a barrier
/// (instantiation is outside the timed part) and run to the end. It returns each one's output and the wall time of the
/// concurrent runs, so a caller's work / wall time is what this VM's cores do in parallel under the runtime apps get. One
/// deadline for the whole run stops every instance.
pub fn bench(
    bundle: &[u8],
    expected_sha256: &[u8; 32],
    args: &[String],
    instances: usize,
    mem_limit: usize,
    deadline: Duration,
) -> Result<BenchOutput> {
    if instances == 0 || instances > MAX_BENCH_INSTANCES {
        wasmtime::bail!("instances must be 1..={MAX_BENCH_INSTANCES}");
    }
    let engine = engine()?;
    let t0 = Instant::now();
    let component = verify_and_compile(&engine, bundle, expected_sha256)?;
    let compile_ms = t0.elapsed().as_millis();
    let mut linker = Linker::<State>::new(&engine);
    wasmtime_wasi::p2::add_to_linker_sync(&mut linker)?;
    let mut argv = vec!["app".to_string()];
    argv.extend_from_slice(args);
    let barrier = std::sync::Barrier::new(instances + 1);
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
    let (results, wall_ms) = std::thread::scope(|sc| {
        let handles: Vec<_> = (0..instances)
            .map(|_| {
                let (engine, component, linker, argv, barrier) = (&engine, &component, &linker, &argv, &barrier);
                sc.spawn(move || -> Result<(i32, Vec<u8>)> {
                    let out = MemoryOutputPipe::new(1 << 16);
                    let mut b = WasiCtx::builder();
                    b.args(argv).stdout(out.clone());
                    let limits = StoreLimitsBuilder::new().memory_size(mem_limit).instances(64).tables(64).memories(16)
                        .trap_on_grow_failure(true).build();
                    let mut store = Store::new(engine, State { ctx: b.build(), table: ResourceTable::new(), limits });
                    store.limiter(|s| &mut s.limits);
                    store.set_epoch_deadline(1);
                    let cmd = Command::instantiate(&mut store, component, linker);
                    barrier.wait(); // every thread reaches the barrier, even one whose instantiation failed
                    let result = cmd.and_then(|cmd| cmd.wasi_cli_run().call_run(&mut store));
                    drop(store);
                    let code = match result {
                        Ok(Ok(())) => 0,
                        Ok(Err(())) => 1,
                        Err(e) => match e.downcast_ref::<I32Exit>() {
                            Some(x) => x.0,
                            None => return Err(e),
                        },
                    };
                    Ok((code, out.contents().to_vec()))
                })
            })
            .collect();
        barrier.wait();
        let t1 = Instant::now();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err(wasmtime::format_err!("a bench thread panicked")))).collect();
        (results, t1.elapsed().as_millis())
    });
    done.store(true, Ordering::Release);
    let _ = watchdog.join();
    let mut stdout = Vec::with_capacity(instances);
    let mut exit_codes = Vec::with_capacity(instances);
    for r in results {
        let (code, out) = r?;
        exit_codes.push(code);
        stdout.push(out);
    }
    Ok(BenchOutput { stdout, exit_codes, compile_ms, wall_ms })
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
/// digest, memory limit, deadline, and the two reserved model slots (nn_name, nn_ops), which must both be null: this runtime
/// carries no model. What cannot be checked is the caller's contract: `bundle` holds `len` readable bytes, `sha256` 32.
fn checked_inputs<'a>(
    bundle: *const u8,
    len: usize,
    sha256: *const u8,
    mem_limit: u64,
    deadline_ms: u64,
    nn_name: *const c_char,
    nn_ops: *const c_void,
) -> std::result::Result<(&'a [u8], [u8; 32]), String> {
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
    if !nn_name.is_null() || !nn_ops.is_null() {
        return Err("this runtime carries no model (the pVM CPU tier is CPU-only): the reserved nn_name/nn_ops slots must be null".into());
    }
    // SAFETY: bundle is non-null and len is in 1..=MAX_BUNDLE_BYTES; the caller provides len readable bytes.
    let bytes = unsafe { std::slice::from_raw_parts(bundle, len) };
    let mut want = [0u8; 32];
    // SAFETY: sha256 is non-null and points to 32 bytes by the caller's contract.
    unsafe { std::ptr::copy_nonoverlapping(sha256, want.as_mut_ptr(), 32) };
    Ok((bytes, want))
}

/// Run a wasi:cli component. Returns 0 when it ran (its exit code in `*exit_code`, its output through `emit`), -1 when the
/// call was refused or the run failed (the reason in `err`). Nothing is compiled unless every argument is valid and the
/// bundle's digest matches. CPU-only: no wasi:nn.
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

/// `pvmrt_run_cli` with the two reserved model slots in the signature (`nn_name`, `nn_ops`): this runtime carries no model,
/// so both must be null and anything else is refused before any compile.
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
    nn_ops: *const c_void,
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
    let (bytes, want) =
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

/// The tier's compute measurement (`bench`): `instances` (1..=MAX_BENCH_INSTANCES) concurrent runs of one verified wasi:cli
/// component, released together. `emit(1, ..)` receives each instance's stdout, one call per instance in instance order;
/// `*wall_ms` the concurrent runs' wall time. Returns 0 when every instance exited 0, -1 when the call was refused, the run
/// failed, or an instance exited otherwise (the reason in `err`). The same checks as `pvmrt_run_app`, before anything runs.
#[no_mangle]
pub extern "C" fn pvmrt_bench(
    bundle: *const u8,
    len: usize,
    sha256: *const u8,
    argv: *const *const c_char,
    argc: c_int,
    instances: c_int,
    mem_limit: u64,
    deadline_ms: u64,
    emit: EmitFn,
    wall_ms: *mut u64,
    compile_ms: *mut u64,
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
    if instances < 1 || instances as usize > MAX_BENCH_INSTANCES {
        return refuse(&format!("instances must be 1..={MAX_BENCH_INSTANCES}"));
    }
    let args = match collect_args(argv, argc) {
        Ok(a) => a,
        Err(e) => return refuse(&e),
    };
    let (bytes, want) = match checked_inputs(bundle, len, sha256, mem_limit, deadline_ms, std::ptr::null(), std::ptr::null()) {
        Ok(x) => x,
        Err(e) => return refuse(&e),
    };
    match bench(bytes, &want, &args, instances as usize, mem_limit as usize, Duration::from_millis(deadline_ms)) {
        Ok(o) => {
            for out in &o.stdout {
                emit(1, out.as_ptr(), out.len());
            }
            // SAFETY: each out-pointer is written only when non-null.
            unsafe {
                if !wall_ms.is_null() {
                    *wall_ms = o.wall_ms as u64;
                }
                if !compile_ms.is_null() {
                    *compile_ms = o.compile_ms as u64;
                }
            }
            match o.exit_codes.iter().position(|&c| c != 0) {
                None => 0,
                Some(i) => refuse(&format!("instance {i} exited {}", o.exit_codes[i])),
            }
        }
        Err(e) => refuse(&format!("{e:#}")),
    }
}

// ---- wasi:http (httpd.rs): a component served on connections the payload accepts ----

/// Verify, compile and pre-instantiate a `wasi:http/proxy` component (httpd.rs). Returns the server, or null when refused
/// (the reason in `err`). `emit` receives the server's notes and each request's stderr (stream 2). `nn_name`/`nn_ops` are
/// the reserved model slots, as in `pvmrt_run_app`: both must be null. `deadline_ms` bounds each request.
#[no_mangle]
pub extern "C" fn pvmrt_http_open(
    bundle: *const u8,
    len: usize,
    sha256: *const u8,
    mem_limit: u64,
    deadline_ms: u64,
    nn_name: *const c_char,
    nn_ops: *const c_void,
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
        std::ptr::null(),
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
    nn_ops: *const c_void,
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
        Some((&seed, TlsKind::Ed25519)),
        std::ptr::null(),
        emit,
        compile_ms,
        err,
        errcap,
    );
    seed.iter_mut().for_each(|b| *b = 0);
    r
}

/// The app's options as the payload hands them over (httpd.rs AppOptions), C layout. Every field may be null/0: no
/// variables, no rules, no egress.
///   env        "K=V\0K=V\0...": the deployment's environment (ENCLAVE_CONFIG, ENCLAVE_HOSTS, the owner's secrets), checked
///              here: names [A-Za-z_][A-Za-z0-9_]{0,63}, values UTF-8 without NUL, no duplicate, at most ENV_MAX_VARS and
///              ENV_MAX_BYTES, and none of the runtime's own (ENCLAVE_PORTS, ENCLAVE_MEM_MB)
///   waf        the owner's protection rules, normalised JSON (waf.rs), NUL-terminated
///   egress_open(ctx, host, port, err, errcap)   one outbound stream: its fd (owned by the runtime from then on), or -1
///              with the reason in err
///   egress_resolve(ctx, name, out, cap)         a name's addresses, comma-separated in out: 0, or -1 with the reason in out
#[repr(C)]
pub struct PvmrtAppOpts {
    pub env: *const u8,
    pub env_len: usize,
    pub waf: *const c_char,
    pub egress_open: Option<extern "C" fn(*mut c_void, *const c_char, u16, *mut c_char, usize) -> c_int>,
    pub egress_resolve: Option<extern "C" fn(*mut c_void, *const c_char, *mut c_char, usize) -> c_int>,
    pub egress_ctx: *mut c_void,
}

/// The most variables, and bytes of them, an app is started with (the platform's ENCLAVE_CONFIG rides one of them).
pub const ENV_MAX_VARS: usize = 128;
pub const ENV_MAX_BYTES: usize = 192 << 10;
/// The variables the runtime itself sets.
const ENV_RUNTIME_OWNED: &[&str] = &["ENCLAVE_PORTS", "ENCLAVE_MEM_MB"];

/// The environment block, checked (PvmrtAppOpts.env).
pub fn parse_env(block: &[u8]) -> std::result::Result<Vec<(String, String)>, String> {
    if block.len() > ENV_MAX_BYTES {
        return Err(format!("the app's environment is {} bytes, over {ENV_MAX_BYTES}", block.len()));
    }
    let mut out: Vec<(String, String)> = Vec::new();
    for e in block.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let e = std::str::from_utf8(e).map_err(|_| "an environment entry is not UTF-8".to_string())?;
        let (k, v) = e.split_once('=').ok_or("an environment entry has no '='")?;
        let ok = !k.is_empty()
            && k.len() <= 64
            && k.bytes().next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
            && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
        if !ok {
            return Err(format!("{k:?} is not an environment variable name"));
        }
        if ENV_RUNTIME_OWNED.contains(&k) {
            return Err(format!("{k} is the runtime's own variable"));
        }
        if out.iter().any(|(x, _)| x == k) {
            return Err(format!("{k} is set twice"));
        }
        out.push((k.to_string(), v.to_string()));
        if out.len() > ENV_MAX_VARS {
            return Err(format!("the app's environment has more than {ENV_MAX_VARS} variables"));
        }
    }
    Ok(out)
}

/// The payload's egress callbacks and their context, callable from any thread (the payload's contract).
struct CEgress {
    open: extern "C" fn(*mut c_void, *const c_char, u16, *mut c_char, usize) -> c_int,
    resolve: extern "C" fn(*mut c_void, *const c_char, *mut c_char, usize) -> c_int,
    ctx: *mut c_void,
}
// SAFETY: the payload's egress callbacks are thread-safe and its context lives as long as the app (PvmrtAppOpts).
unsafe impl Send for CEgress {}
unsafe impl Sync for CEgress {}

fn app_options(p: *const PvmrtAppOpts) -> std::result::Result<httpd::AppOptions, String> {
    if p.is_null() {
        return Ok(httpd::AppOptions::default());
    }
    // SAFETY: a non-null opts points to a PvmrtAppOpts by the caller's contract.
    let o = unsafe { &*p };
    let env = if o.env.is_null() || o.env_len == 0 {
        Vec::new()
    } else {
        // SAFETY: env points to env_len bytes by the caller's contract.
        parse_env(unsafe { std::slice::from_raw_parts(o.env, o.env_len) })?
    };
    let waf = if o.waf.is_null() {
        None
    } else {
        // SAFETY: waf is NUL-terminated by the caller's contract.
        let j = unsafe { CStr::from_ptr(o.waf) }.to_str().map_err(|_| "the protection rules are not UTF-8".to_string())?;
        Some(Arc::new(waf::Waf::parse(j)?))
    };
    let egress = match (o.egress_open, o.egress_resolve) {
        (Some(open), Some(resolve)) => {
            let c = Arc::new(CEgress { open, resolve, ctx: o.egress_ctx });
            let c2 = c.clone();
            let open_fn: Arc<egress::OpenFn> = Arc::new(move |host: &str, port: u16| {
                let h = std::ffi::CString::new(host).map_err(|_| "a NUL in the host".to_string())?;
                let mut why = [0 as c_char; 256];
                let fd = (c.open)(c.ctx, h.as_ptr(), port, why.as_mut_ptr(), why.len());
                if fd >= 0 {
                    return Ok(fd);
                }
                why[why.len() - 1] = 0;
                // SAFETY: NUL-terminated just above (and zeroed before the call).
                Err(unsafe { CStr::from_ptr(why.as_ptr()) }.to_string_lossy().into_owned())
            });
            let resolve_fn: Arc<egress::ResolveFn> = Arc::new(move |name: &str| {
                let n = std::ffi::CString::new(name).map_err(|_| "a NUL in the name".to_string())?;
                let mut out = vec![0 as c_char; 2048];
                let r = (c2.resolve)(c2.ctx, n.as_ptr(), out.as_mut_ptr(), out.len());
                *out.last_mut().expect("non-empty") = 0;
                // SAFETY: NUL-terminated just above.
                let text = unsafe { CStr::from_ptr(out.as_ptr()) }.to_string_lossy().into_owned();
                if r != 0 {
                    return Err(text);
                }
                let ips: Vec<std::net::IpAddr> = text.split(',').filter_map(|x| x.trim().parse().ok()).collect();
                if ips.is_empty() {
                    Err("no addresses".into())
                } else {
                    Ok(ips)
                }
            });
            Some(egress::Egress::new(open_fn, resolve_fn))
        }
        (None, None) => None,
        _ => return Err("egress needs both its open and its resolve callback".into()),
    };
    Ok(httpd::AppOptions { env, egress, waf })
}

/// Which key a TLS server is opened with.
#[derive(Clone, Copy)]
enum TlsKind {
    /// the VM's attested Ed25519 transport key, self-signed (pinned by a client from evidence)
    Ed25519,
    /// a P-256 key derived from the seed (httpd.rs `with_tls_p256`), for a CA-issued certificate
    P256,
}

/// `pvmrt_https_open` for the marketplace host (httpd.rs `with_tls_p256`): `tls_seed` is a 32-byte seed the payload takes
/// from the VM instance's secret for this app; the P-256 TLS key is derived from it here. It is copied, not kept; null is
/// refused. The key's SPKI: `pvmrt_https_tls_spki`; a certificate request: `pvmrt_https_csr`; a CA's chain:
/// `pvmrt_https_set_chain`. `opts` (or null): the app's environment, egress and protection rules (PvmrtAppOpts).
#[no_mangle]
pub extern "C" fn pvmrt_https_open_p256(
    bundle: *const u8,
    len: usize,
    sha256: *const u8,
    mem_limit: u64,
    deadline_ms: u64,
    nn_name: *const c_char,
    nn_ops: *const c_void,
    tls_seed: *const u8,
    opts: *const PvmrtAppOpts,
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
        Some((&seed, TlsKind::P256)),
        opts,
        emit,
        compile_ms,
        err,
        errcap,
    );
    seed.iter_mut().for_each(|b| *b = 0);
    r
}

/// A socket-server app for the marketplace host (httpd.rs `open_socket_app` + `with_tls_p256`): a wasi:cli/run component that
/// binds `port` (ENCLAVE_PORTS http:<port>=<port>) on the VM's loopback, started and fronted by TLS 1.3 under the P-256 key
/// derived from `tls_seed`; every request but the evidence paths is proxied to it. `data_dir` (NUL-terminated, or null) is
/// preopened as the app's /data. `opts` (or null): the app's environment, egress and protection rules (PvmrtAppOpts).
/// Returns once the app listens, or null with the reason in `err`. The rest of the https surface (serve_fd, tls_spki, csr,
/// set_chain, set_attest, requests, close) is the same as for a wasi:http app.
#[no_mangle]
pub extern "C" fn pvmrt_https_open_p256_socket(
    bundle: *const u8,
    len: usize,
    sha256: *const u8,
    mem_limit: u64,
    port: u32,
    data_dir: *const c_char,
    tls_seed: *const u8,
    opts: *const PvmrtAppOpts,
    emit: EmitFn,
    compile_ms: *mut u64,
    err: *mut c_char,
    errcap: usize,
) -> *mut httpd::HttpServer {
    let refuse = |why: &str| {
        put(err, errcap, why);
        std::ptr::null_mut()
    };
    let Some(emit) = emit else { return refuse("no emit callback: the server's notes would be lost; refusing") };
    if tls_seed.is_null() {
        return refuse("no TLS key seed: refusing to serve https");
    }
    if port == 0 || port > 65535 {
        return refuse("the app's http port must be 1..65535");
    }
    let (bytes, want) = match checked_inputs(bundle, len, sha256, mem_limit, 1, std::ptr::null(), std::ptr::null()) {
        Ok(x) => x,
        Err(e) => return refuse(&e),
    };
    let dir = if data_dir.is_null() {
        None
    } else {
        // SAFETY: data_dir is a NUL-terminated string by the caller's contract.
        match unsafe { CStr::from_ptr(data_dir) }.to_str() {
            Ok(d) if !d.is_empty() => Some(std::path::PathBuf::from(d)),
            _ => return refuse("data_dir is not a UTF-8 path"),
        }
    };
    let app_opts = match app_options(opts) {
        Ok(o) => o,
        Err(e) => return refuse(&e),
    };
    let mut seed = [0u8; 32];
    // SAFETY: tls_seed is non-null and points to 32 bytes by the caller's contract.
    unsafe { std::ptr::copy_nonoverlapping(tls_seed, seed.as_mut_ptr(), 32) };
    let log: Box<dyn Fn(&[u8]) + Send + Sync> = Box::new(move |b: &[u8]| emit(2, b.as_ptr(), b.len()));
    let opened = httpd::HttpServer::open_socket_app(bytes, &want, mem_limit as usize, port as u16, dir.as_deref(), app_opts, Some(log))
        .and_then(|s| s.with_tls_p256(&seed));
    seed.iter_mut().for_each(|b| *b = 0);
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

/// The DER SPKI of the server's TLS key into `out`: its length, or -1 (no TLS, a null argument, or `cap` too small).
#[no_mangle]
pub extern "C" fn pvmrt_https_tls_spki(srv: *const httpd::HttpServer, out: *mut u8, cap: usize) -> c_int {
    if srv.is_null() || out.is_null() {
        return -1;
    }
    // SAFETY: srv came from an open call and has not been closed (caller's contract).
    match unsafe { &(*srv).tls_spki } {
        Some(spki) if spki.len() <= cap => {
            // SAFETY: out has cap bytes by the caller's contract.
            unsafe { std::ptr::copy_nonoverlapping(spki.as_ptr(), out, spki.len()) };
            spki.len() as c_int
        }
        _ => -1,
    }
}

/// A PKCS#10 request (DER) for the NUL-terminated DNS `name` with the P-256 key, into `out`: its length, or -1 with the
/// reason in `err`.
#[no_mangle]
pub extern "C" fn pvmrt_https_csr(
    srv: *const httpd::HttpServer,
    name: *const c_char,
    out: *mut u8,
    cap: usize,
    err: *mut c_char,
    errcap: usize,
) -> c_int {
    if srv.is_null() || name.is_null() || out.is_null() {
        put(err, errcap, "a null argument");
        return -1;
    }
    // SAFETY: name is a NUL-terminated string by the caller's contract.
    let Ok(name) = unsafe { CStr::from_ptr(name) }.to_str() else {
        put(err, errcap, "the name is not UTF-8");
        return -1;
    };
    // SAFETY: srv came from an open call and has not been closed (caller's contract).
    match unsafe { (*srv).csr(name) } {
        Ok(der) if der.len() <= cap => {
            // SAFETY: out has cap bytes by the caller's contract.
            unsafe { std::ptr::copy_nonoverlapping(der.as_ptr(), out, der.len()) };
            der.len() as c_int
        }
        Ok(der) => {
            put(err, errcap, &format!("the request is {} bytes, the buffer {cap}", der.len()));
            -1
        }
        Err(e) => {
            put(err, errcap, &format!("{e:#}"));
            -1
        }
    }
}

/// The payload's evidence callback (httpd.rs `set_attest`): writes the JSON document for the 32-byte client `nonce` into
/// `out` (at most `cap` bytes) and returns its length, or returns a negative number with a NUL-terminated reason in `out`.
/// It is called from any serving thread, possibly at once: it must be thread-safe (the payload serialises its attestation).
pub type AttestCb = Option<extern "C" fn(ctx: *mut c_void, nonce: *const u8, out: *mut u8, cap: usize) -> isize>;
/// The evidence a document may take: the fields, an escaped runtime identity and an AVF chain fit with room to spare.
pub const ATTEST_DOC_MAX: usize = 64 << 10;
struct AttestCtx(*mut c_void);
// SAFETY: the payload's callback contract (AttestCb) makes the context usable from any thread.
unsafe impl Send for AttestCtx {}
unsafe impl Sync for AttestCtx {}

/// Set the evidence hook (httpd.rs `set_attest`): from now on the server answers /.well-known/enclave-attestation and
/// /.well-known/enclave-ready itself. 0 when set; -1 for a null argument or when a hook was already set.
#[no_mangle]
pub extern "C" fn pvmrt_https_set_attest(srv: *const httpd::HttpServer, cb: AttestCb, ctx: *mut c_void) -> c_int {
    let (Some(cb), false) = (cb, srv.is_null()) else { return -1 };
    let ctx = AttestCtx(ctx);
    let f: httpd::AttestFn = std::sync::Arc::new(move |nonce: [u8; 32]| {
        let c = &ctx;
        let mut out = vec![0u8; ATTEST_DOC_MAX];
        let n = cb(c.0, nonce.as_ptr(), out.as_mut_ptr(), out.len());
        if n > 0 && (n as usize) <= out.len() {
            out.truncate(n as usize);
            Ok(out)
        } else {
            let end = out.iter().position(|&b| b == 0).unwrap_or(0).min(512);
            Err(if end > 0 { String::from_utf8_lossy(&out[..end]).into_owned() } else { "no evidence".into() })
        }
    });
    // SAFETY: srv came from an open call and has not been closed (caller's contract).
    if unsafe { (*srv).set_attest(f) } { 0 } else { -1 }
}

/// Install a PEM certificate chain (leaf first) for the P-256 key (httpd.rs `set_chain`): the number of certificates
/// installed, or -1 with the reason in `err` (the current certificate is kept).
#[no_mangle]
pub extern "C" fn pvmrt_https_set_chain(
    srv: *const httpd::HttpServer,
    pem: *const u8,
    len: usize,
    err: *mut c_char,
    errcap: usize,
) -> c_int {
    if srv.is_null() || pem.is_null() {
        put(err, errcap, "a null argument");
        return -1;
    }
    // SAFETY: pem has len bytes by the caller's contract.
    let pem = unsafe { std::slice::from_raw_parts(pem, len) };
    // SAFETY: srv came from an open call and has not been closed (caller's contract).
    match unsafe { (*srv).set_chain(pem) } {
        Ok(n) => n as c_int,
        Err(e) => {
            put(err, errcap, &format!("{e:#}"));
            -1
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn http_open(
    bundle: *const u8,
    len: usize,
    sha256: *const u8,
    mem_limit: u64,
    deadline_ms: u64,
    nn_name: *const c_char,
    nn_ops: *const c_void,
    tls_seed: Option<(&[u8; 32], TlsKind)>,
    opts: *const PvmrtAppOpts,
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
    let app_opts = match app_options(opts) {
        Ok(o) => o,
        Err(e) => return refuse(&e),
    };
    let (bytes, want) =
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
        Some(log),
    )
    .and_then(|s| match tls_seed {
        Some((seed, TlsKind::Ed25519)) => s.with_tls(seed),
        Some((seed, TlsKind::P256)) => s.with_tls_p256(seed),
        None => Ok(s),
    })
    .and_then(|s| s.with_app_options(app_opts));
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
