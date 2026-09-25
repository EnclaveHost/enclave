// wasi:nn in the portable runtime (src/nn.rs), on the host, against a mock engine whose answers are a pure function of
// everything fed to the sequence so far: the model conformance component (conformance/nn-cli, bundles/nn-v1.wasm) must
// decode exactly the ids this file predicts, which holds only if the KV state persists across computes inside one
// execution context and is cleared when a new one starts. The same component runs on the phone against the real model
// (cpu/app-run.sh, milestone 3), where its digest must equal the engine's own self-test digest.
use pvm_rt::nn::{NnEngine, NnOps};
use pvm_rt::{run_app, run_cli, NnModel};
use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const VOCAB: usize = 300;

/// The mock model: the sequence state is an FNV-1a hash of every id fed since the last reset; the next token is that hash
/// modulo the vocabulary (a unique maximum in the logits).
fn fnv(h: u64, id: i32) -> u64 {
    let mut h = h;
    for b in (id as u32).to_le_bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}
const FNV0: u64 = 0xcbf29ce484222325;

struct Mock {
    state: Mutex<(u64, usize)>, // (hash, positions)
    resets: AtomicUsize,
}
impl Mock {
    fn new() -> Mock {
        Mock {
            state: Mutex::new((FNV0, 0)),
            resets: AtomicUsize::new(0),
        }
    }
}
impl NnEngine for Mock {
    fn n_vocab(&self) -> usize {
        VOCAB
    }
    fn n_ctx(&self) -> usize {
        64
    }
    fn tokenize(&self, text: &[u8]) -> Result<Vec<i32>, String> {
        Ok(text.iter().map(|b| *b as i32).collect())
    }
    fn piece(&self, id: i32) -> Result<Vec<u8>, String> {
        Ok(if id < 256 {
            vec![id as u8]
        } else {
            format!("<t{id}>").into_bytes()
        })
    }
    fn reset(&self) -> Result<(), String> {
        *self.state.lock().unwrap() = (FNV0, 0);
        self.resets.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn decode(&self, ids: &[i32], logits: &mut [f32]) -> Result<(), String> {
        let mut s = self.state.lock().unwrap();
        for &id in ids {
            s.0 = fnv(s.0, id);
            s.1 += 1;
        }
        let target = (s.0 % VOCAB as u64) as i64;
        for (j, l) in logits.iter_mut().enumerate() {
            *l = -((j as i64 - target).abs() as f32);
        }
        Ok(())
    }
}

/// What greedy decoding against the mock yields: n ids after `prompt`.
fn predict(prompt: &[i32], n: usize) -> Vec<i32> {
    let mut h = prompt.iter().fold(FNV0, |h, &id| fnv(h, id));
    let mut out = Vec::new();
    for _ in 0..n {
        let t = (h % VOCAB as u64) as i32;
        out.push(t);
        h = fnv(h, t);
    }
    out
}

fn bundle() -> (Vec<u8>, [u8; 32]) {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance/bundles");
    let b = std::fs::read(dir.join("nn-v1.wasm")).unwrap();
    use sha2::Digest;
    let d: [u8; 32] = sha2::Sha256::digest(&b).into();
    (b, d)
}

fn args(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn run(engine: Arc<dyn NnEngine>, name: &str, a: &[&str]) -> pvm_rt::RunOutput {
    let (b, d) = bundle();
    run_app(
        &b,
        &d,
        &args(a),
        256 << 20,
        Duration::from_secs(60),
        Some(NnModel {
            name: name.into(),
            engine,
        }),
    )
    .unwrap()
}

#[test]
fn the_component_decodes_what_the_model_predicts() {
    let m = Arc::new(Mock::new());
    let o = run(m.clone(), "mock-1", &["gen", "mock-1", "8", "hello"]);
    let out = String::from_utf8_lossy(&o.stdout);
    assert_eq!(
        o.exit_code,
        0,
        "{out}\n{}",
        String::from_utf8_lossy(&o.stderr)
    );
    let prompt: Vec<i32> = b"hello".iter().map(|b| *b as i32).collect();
    let want = predict(&prompt, 8);
    let ids = want
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join(",");
    assert!(
        out.contains(&format!("nn ids {ids}\n")),
        "{out}\nwant ids {ids}"
    );
    assert!(out.contains("n_vocab=300"), "{out}");
    // deterministic cleanup: the context was dropped (the sequence cleared) by the time the run returned
    assert_eq!(*m.state.lock().unwrap(), (FNV0, 0));
    assert!(
        m.resets.load(Ordering::SeqCst) >= 2,
        "reset at init and at drop"
    );
}

#[test]
fn the_runtime_refuses_what_a_component_must_not_do() {
    let o = run(Arc::new(Mock::new()), "mock-1", &["refusals", "mock-1"]);
    let out = String::from_utf8_lossy(&o.stdout);
    assert_eq!(
        o.exit_code,
        0,
        "{out}\n{}",
        String::from_utf8_lossy(&o.stderr)
    );
    for r in [
        "unknown-graph",
        "own-weights",
        "second-context",
        "token-out-of-range",
        "token-negative",
        "tokens-not-i32",
        "tokens-short-data",
        "tokens-empty",
        "unsupported-beside-tokens",
        "unknown-verb",
        "no-inputs",
        "context-after-drop",
    ] {
        assert!(out.contains(&format!("refusal {r} ok\n")), "{r}: {out}");
    }
    assert!(out.contains("refusals all ok"), "{out}");
}

#[test]
fn the_context_ends_at_the_model_context_length() {
    // n_ctx 64: a 60-byte prompt plus 8 generated ids cannot fit; the run fails, it does not wrap or truncate
    let text = "x".repeat(60);
    let o = run(
        Arc::new(Mock::new()),
        "mock-1",
        &["gen", "mock-1", "8", &text],
    );
    assert_eq!(o.exit_code, 1);
    assert!(String::from_utf8_lossy(&o.stderr).contains("compute(tokens)"));
}

#[test]
fn without_a_model_a_wasi_nn_component_does_not_instantiate() {
    let (b, d) = bundle();
    let e = run_cli(
        &b,
        &d,
        &args(&["gen", "m", "1", "a"]),
        256 << 20,
        Duration::from_secs(60),
    )
    .err()
    .expect("instantiated without wasi:nn");
    assert!(format!("{e:#}").contains("wasi:nn"), "{e:#}");
}

#[test]
fn a_bad_graph_name_is_refused_before_compiling() {
    let (b, d) = bundle();
    for name in ["", "Model", "a b", "../m", &"m".repeat(65), "-m"] {
        let e = run_app(
            &b,
            &d,
            &args(&["gen", "m", "1", "a"]),
            256 << 20,
            Duration::from_secs(60),
            Some(NnModel {
                name: name.into(),
                engine: Arc::new(Mock::new()),
            }),
        )
        .err()
        .expect("accepted a bad graph name");
        assert!(format!("{e:#}").contains("refusing"), "{name:?}: {e:#}");
    }
}

// ---- the graph's contexts, driven directly (exact reasons; the guest sees only that a call failed) ----

/// Fails every decode from the `fail_at`-th on.
struct Failing {
    inner: Mock,
    calls: AtomicUsize,
    fail_at: usize,
}
impl NnEngine for Failing {
    fn n_vocab(&self) -> usize {
        self.inner.n_vocab()
    }
    fn n_ctx(&self) -> usize {
        self.inner.n_ctx()
    }
    fn tokenize(&self, t: &[u8]) -> Result<Vec<i32>, String> {
        self.inner.tokenize(t)
    }
    fn piece(&self, id: i32) -> Result<Vec<u8>, String> {
        self.inner.piece(id)
    }
    fn reset(&self) -> Result<(), String> {
        self.inner.reset()
    }
    fn decode(&self, ids: &[i32], l: &mut [f32]) -> Result<(), String> {
        if self.calls.fetch_add(1, Ordering::SeqCst) + 1 >= self.fail_at {
            return Err("injected".into());
        }
        self.inner.decode(ids, l)
    }
}

fn tokens(ids: &[i32]) -> Vec<wasmtime_wasi_nn::backend::NamedTensor> {
    vec![wasmtime_wasi_nn::backend::NamedTensor {
        name: "tokens".into(),
        tensor: wasmtime_wasi_nn::Tensor::new(
            vec![1, ids.len() as u32],
            wasmtime_wasi_nn::wit::TensorType::I32,
            ids.iter().flat_map(|v| v.to_le_bytes()).collect(),
        ),
    }]
}
/// The whole source chain (BackendError's own Display is only "Failed while accessing backend").
fn reason<T>(r: Result<T, wasmtime_wasi_nn::backend::BackendError>) -> String {
    let Err(e) = r else {
        return "accepted".into();
    };
    let mut s = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(x) = src {
        s += &format!(": {x}");
        src = x.source();
    }
    s
}

#[test]
fn a_failed_decode_ends_the_context_and_a_second_context_waits() {
    let e = Arc::new(Failing {
        inner: Mock::new(),
        calls: AtomicUsize::new(0),
        fail_at: 2,
    });
    let g = pvm_rt::nn::graph(e.clone());
    let mut a = g.init_execution_context().unwrap();
    let r = reason(g.init_execution_context());
    assert!(r.contains("[sessions_busy]"), "{r}");
    a.compute_with_io(tokens(&[1, 2])).unwrap();
    assert!(reason(a.compute_with_io(tokens(&[3]))).contains("injected"));
    // the sequence is now in an unknown state: nothing more is served from this context, even if the engine recovers
    assert!(reason(a.compute_with_io(tokens(&[3]))).contains("unknown state"));
    drop(a);
    let mut b = g.init_execution_context().unwrap();
    assert!(
        reason(b.compute_with_io(tokens(&[3]))).contains("injected"),
        "a fresh context reaches the engine again"
    );
    let names = |v: Vec<wasmtime_wasi_nn::backend::NamedTensor>| {
        v.into_iter().map(|t| t.name).collect::<Vec<_>>()
    };
    let tk = vec![wasmtime_wasi_nn::backend::NamedTensor {
        name: "tokenize".into(),
        tensor: wasmtime_wasi_nn::Tensor::new(
            vec![2],
            wasmtime_wasi_nn::wit::TensorType::U8,
            b"hi".to_vec(),
        ),
    }];
    assert_eq!(names(b.compute_with_io(tk).unwrap()), ["ids"]);
    let mut extra = tokens(&[1]);
    extra.push(tokens(&[1]).remove(0));
    extra[1].name = "topk".into();
    assert!(reason(b.compute_with_io(extra)).contains("[unsupported] input \"topk\""));
}

// ---- the same through the C ABI, with the engine as an ops table ----

#[test]
fn nn_ops_has_the_layout_pvmrt_nn_h_asserts() {
    // payload/pvmrt_nn.h static_asserts the same three numbers on the C side
    assert_eq!(std::mem::size_of::<NnOps>(), 48);
    assert_eq!(std::mem::offset_of!(NnOps, tokenize), 16);
    assert_eq!(std::mem::offset_of!(NnOps, decode), 40);
}

static C_MOCK: Mutex<Option<Arc<Mock>>> = Mutex::new(None);
fn cm() -> Arc<Mock> {
    C_MOCK.lock().unwrap().clone().unwrap()
}
unsafe extern "C" fn c_tokenize(
    _: *mut c_void,
    t: *const u8,
    n: i32,
    out: *mut i32,
    cap: i32,
) -> i32 {
    let ids = cm()
        .tokenize(std::slice::from_raw_parts(t, n as usize))
        .unwrap();
    if ids.len() > cap as usize {
        return -(ids.len() as i32);
    }
    std::ptr::copy_nonoverlapping(ids.as_ptr(), out, ids.len());
    ids.len() as i32
}
unsafe extern "C" fn c_piece(_: *mut c_void, id: i32, buf: *mut u8, cap: i32) -> i32 {
    let p = cm().piece(id).unwrap();
    if p.len() > cap as usize {
        return -(p.len() as i32);
    }
    std::ptr::copy_nonoverlapping(p.as_ptr(), buf, p.len());
    p.len() as i32
}
unsafe extern "C" fn c_reset(_: *mut c_void) -> i32 {
    cm().reset().map(|_| 0).unwrap_or(-1)
}
unsafe extern "C" fn c_decode(_: *mut c_void, ids: *const i32, n: i32, logits: *mut f32) -> i32 {
    let l = std::slice::from_raw_parts_mut(logits, VOCAB);
    cm().decode(std::slice::from_raw_parts(ids, n as usize), l)
        .map(|_| 0)
        .unwrap_or(-1)
}

static OUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());
extern "C" fn collect(stream: c_int, p: *const u8, n: usize) {
    if stream == 1 && n > 0 {
        OUT.lock()
            .unwrap()
            .extend_from_slice(unsafe { std::slice::from_raw_parts(p, n) });
    }
}

fn call_app(name: *const c_char, ops: *const NnOps, a: &[&CStr]) -> (c_int, c_int, String) {
    let (b, d) = bundle();
    let argv: Vec<*const c_char> = a.iter().map(|s| s.as_ptr()).collect();
    let mut err = [0 as c_char; 512];
    let mut code: c_int = -99;
    let rc = pvm_rt::pvmrt_run_app(
        b.as_ptr(),
        b.len(),
        d.as_ptr(),
        argv.as_ptr(),
        argv.len() as c_int,
        256 << 20,
        60_000,
        name,
        ops,
        Some(collect),
        &mut code,
        std::ptr::null_mut(),
        std::ptr::null_mut(),
        err.as_mut_ptr(),
        err.len(),
    );
    let e = unsafe { CStr::from_ptr(err.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    (rc, code, e)
}

#[test]
fn the_c_abi_runs_the_component_on_an_ops_table_and_refuses_a_bad_one() {
    *C_MOCK.lock().unwrap() = Some(Arc::new(Mock::new()));
    let ops = NnOps {
        engine: std::ptr::null_mut(),
        n_vocab: VOCAB as i32,
        n_ctx: 64,
        tokenize: Some(c_tokenize),
        piece: Some(c_piece),
        reset: Some(c_reset),
        decode: Some(c_decode),
    };
    let name = c"mock-1";
    let a = [c"gen", c"mock-1", c"5", c"abc"];
    OUT.lock().unwrap().clear();
    let (rc, code, e) = call_app(name.as_ptr(), &ops, &a);
    assert_eq!((rc, code), (0, 0), "{e}");
    let want = predict(&[97, 98, 99], 5)
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let out = String::from_utf8(OUT.lock().unwrap().clone()).unwrap();
    assert!(out.contains(&format!("nn ids {want}\n")), "{out}");
    // exactly one of name / ops: refused
    let (rc, _, e) = call_app(std::ptr::null(), &ops, &a);
    assert_eq!(rc, -1);
    assert!(e.contains("come together"), "{e}");
    let (rc, _, e) = call_app(name.as_ptr(), std::ptr::null(), &a);
    assert_eq!(rc, -1);
    assert!(e.contains("come together"), "{e}");
    // a missing function, or a non-positive size
    let no_decode = NnOps {
        decode: None,
        ..ops
    };
    let (rc, _, e) = call_app(name.as_ptr(), &no_decode, &a);
    assert_eq!(rc, -1);
    assert!(e.contains("missing"), "{e}");
    let zero_vocab = NnOps { n_vocab: 0, ..ops };
    let (rc, _, e) = call_app(name.as_ptr(), &zero_vocab, &a);
    assert_eq!(rc, -1);
    assert!(e.contains("n_vocab"), "{e}");
    let (rc, _, e) = call_app(c"Bad Name".as_ptr(), &ops, &a);
    assert_eq!(rc, -1);
    assert!(e.contains("graph name"), "{e}");
}
