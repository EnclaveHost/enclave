//! wasi:nn inside the pVM (PVM-CPU.md, "The app runtime", milestone 3): the component's model calls go to the verified
//! in-VM engine, never to anything the component or the host supplies.
//!
//! The contract is the server's ggml backend (wasm/wasmtime-nn-ggml.patch), cut to the verbs a portable app needs, so the
//! same component runs on both:
//!   load-by-name(<name>)                  the ONE graph the payload registered: its model was staged and hashed
//!                                         against its pin (whole file, then every tensor) before this runtime ran
//!   load(<bytes>, ...)                    refused: a component cannot bring its own weights into the attested VM
//!   init-execution-context                a fresh sequence (KV cleared); one at a time, as the server's default
//!                                         ENCLAVE_GGML_MAX_SESSIONS=1 ("[sessions_busy]" otherwise)
//!   compute {"tokenize": U8 [n]}          -> "ids" I32 [m]   the GGUF's own tokenizer, parse_special on, no BOS added
//!   compute {"vocab_pieces": any}         -> "bytes" U8 [total] + "offsets" I32 [n_vocab + 1]
//!   compute {"tokens": I32 [1, n]}        -> "logits" Fp32 [1, n_vocab]: the tokens appended to this sequence, the
//!                                         last position's logits ("more" I32 beside it is accepted and ignored, as
//!                                         on the server)
//! Anything else is refused, never ignored: an unknown input beside "tokens" ("all", "topk", "mtp", ...) changes what the
//! server returns, so a guest that sends one would read a wrong-shaped answer here. Every token id is range-checked and
//! every tensor's type, shape and byte length are checked before the engine sees them.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use wasmtime_wasi_nn::backend::{
    BackendError, BackendExecutionContext, BackendFromDir, BackendGraph, BackendInner, Id,
    NamedTensor,
};
use wasmtime_wasi_nn::wit::{ExecutionTarget, GraphEncoding, TensorType};
use wasmtime_wasi_nn::{ExecutionContext, Graph, GraphRegistry, Tensor};

/// The in-VM model, as this runtime sees it. The payload's engine implements it over C (`NnOps`); tests use a mock.
pub trait NnEngine: Send + Sync {
    fn n_vocab(&self) -> usize;
    fn n_ctx(&self) -> usize;
    /// The tokenizer, parse_special on, add_special off (llama_tokenize as the server's ell_tokenize calls it).
    fn tokenize(&self, text: &[u8]) -> Result<Vec<i32>, String>;
    /// One token's raw bytes (special tokens render their text form).
    fn piece(&self, id: i32) -> Result<Vec<u8>, String>;
    /// Clears the sequence (KV) so the next decode starts at position 0.
    fn reset(&self) -> Result<(), String>;
    /// Appends `ids` to the sequence and writes the last position's logits (n_vocab floats) into `logits`.
    fn decode(&self, ids: &[i32], logits: &mut [f32]) -> Result<(), String>;
}

/// The largest tokenize input and "tokens" batch one compute accepts (the server's per-message bound is 256 KiB).
pub const MAX_TEXT_BYTES: usize = 256 << 10;
pub const MAX_TOKENS_PER_COMPUTE: usize = 8192;

fn err(msg: impl Into<String>) -> BackendError {
    BackendError::BackendAccess(wasmtime::format_err!("{}", msg.into()))
}

/// The one graph encoding this backend serves; `load` from bytes is refused.
struct PvmBackend;
impl BackendInner for PvmBackend {
    fn encoding(&self) -> GraphEncoding {
        GraphEncoding::Ggml
    }
    fn load(&mut self, _: &[&[u8]], _: ExecutionTarget) -> Result<Graph, BackendError> {
        Err(err("this VM serves only its attested model: load-by-name; a component cannot bring its own weights"))
    }
    fn as_dir_loadable(&mut self) -> Option<&mut dyn BackendFromDir> {
        None
    }
}

struct PvmGraph {
    engine: Arc<dyn NnEngine>,
    busy: Arc<AtomicBool>,
}
impl BackendGraph for PvmGraph {
    fn init_execution_context(&self) -> Result<ExecutionContext, BackendError> {
        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(err("[sessions_busy] this VM serves one sequence at a time: drop the other execution context first"));
        }
        if let Err(e) = self.engine.reset() {
            self.busy.store(false, Ordering::Release);
            return Err(err(format!("the engine could not clear its sequence: {e}")));
        }
        Ok(ExecutionContext::from(Box::new(PvmContext {
            engine: self.engine.clone(),
            busy: self.busy.clone(),
            broken: false,
            n_past: 0,
            pending: None,
            logits: None,
        })
            as Box<dyn BackendExecutionContext>))
    }
}

struct PvmContext {
    engine: Arc<dyn NnEngine>,
    busy: Arc<AtomicBool>,
    /// a decode failed part-way: the engine's sequence no longer matches n_past, so this context serves nothing more
    broken: bool,
    n_past: usize,
    pending: Option<Vec<i32>>,
    logits: Option<Tensor>,
}
impl Drop for PvmContext {
    /// Deterministic cleanup: the sequence is cleared when its context goes (a dropped resource, or the Store at run end),
    /// so the next context -- or the next app -- never sees this one's KV.
    fn drop(&mut self) {
        let _ = self.engine.reset();
        self.busy.store(false, Ordering::Release);
    }
}

fn i32_tensor(dims: Vec<u32>, v: &[i32]) -> Tensor {
    Tensor {
        dimensions: dims,
        ty: TensorType::I32,
        data: v.iter().flat_map(|x| x.to_le_bytes()).collect(),
    }
}

/// "tokens": I32, dims [n] or [1, n], exactly 4n bytes, 1 <= n <= MAX_TOKENS_PER_COMPUTE, every id in 0..n_vocab.
fn tokens_from(t: &Tensor, n_vocab: usize) -> Result<Vec<i32>, BackendError> {
    if t.ty != TensorType::I32 {
        return Err(err(format!("\"tokens\" must be I32, not {:?}", t.ty)));
    }
    let n = match t.dimensions.as_slice() {
        [n] => *n as usize,
        [1, n] => *n as usize,
        d => {
            return Err(err(format!(
                "\"tokens\" dims {d:?}: expected [n] or [1, n]"
            )))
        }
    };
    if n == 0 || n > MAX_TOKENS_PER_COMPUTE {
        return Err(err(format!(
            "\"tokens\" count {n} is not in 1..={MAX_TOKENS_PER_COMPUTE}"
        )));
    }
    if t.data.len() != 4 * n {
        return Err(err(format!(
            "\"tokens\" holds {} bytes for {n} ids",
            t.data.len()
        )));
    }
    let ids: Vec<i32> = t
        .data
        .chunks_exact(4)
        .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    if let Some(bad) = ids.iter().find(|&&v| v < 0 || v as usize >= n_vocab) {
        return Err(err(format!(
            "token id {bad} is outside the vocabulary (0..{n_vocab})"
        )));
    }
    Ok(ids)
}

impl PvmContext {
    fn feed(&mut self, ids: &[i32]) -> Result<Tensor, BackendError> {
        if self.broken {
            return Err(err("an earlier decode failed in this execution context: its sequence is in an unknown state; start a new one"));
        }
        let (n_vocab, n_ctx) = (self.engine.n_vocab(), self.engine.n_ctx());
        if self.n_past + ids.len() > n_ctx {
            return Err(err(format!(
                "context full ({} used + {} new > {n_ctx}): start a new execution context",
                self.n_past,
                ids.len()
            )));
        }
        let mut logits = vec![0f32; n_vocab];
        if let Err(e) = self.engine.decode(ids, &mut logits) {
            self.broken = true;
            return Err(err(format!("decode failed: {e}")));
        }
        self.n_past += ids.len();
        let t = Tensor {
            dimensions: vec![1, n_vocab as u32],
            ty: TensorType::Fp32,
            data: logits.iter().flat_map(|x| x.to_le_bytes()).collect(),
        };
        self.logits = Some(t.clone());
        Ok(t)
    }
}

const VERBS: &str =
    "this VM's wasi:nn serves \"tokenize\", \"vocab_pieces\" and \"tokens\" (with \"more\")";

impl BackendExecutionContext for PvmContext {
    fn set_input(&mut self, id: Id, tensor: &Tensor) -> Result<(), BackendError> {
        match id {
            Id::Index(0) => {}
            Id::Name(ref n) if n == "tokens" => {}
            other => {
                return Err(err(format!(
                    "unknown input {other:?} (expected \"tokens\")"
                )))
            }
        }
        self.pending = Some(tokens_from(tensor, self.engine.n_vocab())?);
        Ok(())
    }

    fn get_output(&mut self, id: Id) -> Result<Tensor, BackendError> {
        match id {
            Id::Index(0) => {}
            Id::Name(ref n) if n == "logits" => {}
            other => {
                return Err(err(format!(
                    "unknown output {other:?} (expected \"logits\")"
                )))
            }
        }
        self.logits
            .clone()
            .ok_or_else(|| err("no logits available (has `compute` been called?)"))
    }

    fn compute(
        &mut self,
        inputs: Option<Vec<NamedTensor>>,
    ) -> Result<Option<Vec<NamedTensor>>, BackendError> {
        let Some(inputs) = inputs else {
            // the WITX path: tokens staged by set_input, logits read by get_output
            let ids = self
                .pending
                .take()
                .ok_or_else(|| err("no input staged (call set_input first)"))?;
            self.feed(&ids)?;
            return Ok(None);
        };
        let names: Vec<&str> = inputs.iter().map(|t| t.name.as_str()).collect();
        let only = |allowed: &[&str]| -> Result<(), BackendError> {
            match names.iter().find(|n| !allowed.contains(n)) {
                Some(n) => Err(err(format!(
                    "[unsupported] input \"{n}\" in this call: {VERBS}"
                ))),
                None => Ok(()),
            }
        };
        let find = |n: &str| inputs.iter().find(|t| t.name == n);
        if let Some(t) = find("tokenize") {
            only(&["tokenize"])?;
            if t.tensor.ty != TensorType::U8 || t.tensor.data.len() > MAX_TEXT_BYTES {
                return Err(err(format!(
                    "\"tokenize\" must be U8 text of at most {MAX_TEXT_BYTES} bytes"
                )));
            }
            let ids = self
                .engine
                .tokenize(&t.tensor.data)
                .map_err(|e| err(format!("tokenizer failed: {e}")))?;
            return Ok(Some(vec![NamedTensor {
                name: "ids".into(),
                tensor: i32_tensor(vec![ids.len() as u32], &ids),
            }]));
        }
        if find("vocab_pieces").is_some() {
            only(&["vocab_pieces"])?;
            let n_vocab = self.engine.n_vocab();
            let (mut bytes, mut offsets) = (Vec::new(), Vec::with_capacity(n_vocab + 1));
            offsets.push(0i32);
            for id in 0..n_vocab as i32 {
                bytes.extend_from_slice(
                    &self
                        .engine
                        .piece(id)
                        .map_err(|e| err(format!("piece {id}: {e}")))?,
                );
                offsets.push(
                    i32::try_from(bytes.len())
                        .map_err(|_| err("vocabulary pieces exceed 2 GiB"))?,
                );
            }
            return Ok(Some(vec![
                NamedTensor {
                    name: "bytes".into(),
                    tensor: Tensor {
                        dimensions: vec![bytes.len() as u32],
                        ty: TensorType::U8,
                        data: bytes,
                    },
                },
                NamedTensor {
                    name: "offsets".into(),
                    tensor: i32_tensor(vec![offsets.len() as u32], &offsets),
                },
            ]));
        }
        if let Some(t) = find("tokens") {
            only(&["tokens", "more"])?;
            let ids = tokens_from(&t.tensor, self.engine.n_vocab())?;
            let logits = self.feed(&ids)?;
            return Ok(Some(vec![NamedTensor {
                name: "logits".into(),
                tensor: logits,
            }]));
        }
        Err(err(match names.first() {
            Some(n) => format!("[unsupported] verb \"{n}\": {VERBS}"),
            None => format!("no inputs: {VERBS}"),
        }))
    }
}

/// The registry: exactly one name, exactly one graph.
struct OneGraph {
    name: String,
    graph: Graph,
}
impl GraphRegistry for OneGraph {
    fn get(&self, name: &str) -> Option<&Graph> {
        (name == self.name).then_some(&self.graph)
    }
    fn get_mut(&mut self, name: &str) -> Option<&mut Graph> {
        (name == self.name).then_some(&mut self.graph)
    }
}

/// A graph name: 1..=64 of [a-z0-9._-], starting with a letter or digit (the server's volume names fit this).
pub fn valid_graph_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

/// The graph over one engine (what load-by-name returns); exposed so tests can drive its contexts directly.
pub fn graph(engine: Arc<dyn NnEngine>) -> Graph {
    Graph::from(Box::new(PvmGraph {
        engine,
        busy: Arc::new(AtomicBool::new(false)),
    }) as Box<dyn BackendGraph>)
}

/// The wasi:nn state for one run: the refusing byte-loader and the one registered graph.
pub fn context(name: &str, engine: Arc<dyn NnEngine>) -> wasmtime_wasi_nn::wit::WasiNnCtx {
    context_with(name, graph(engine))
}

/// The same over an existing graph. An HTTP server builds one Graph per engine and gives every request's Store a clone of
/// it, so the one-sequence-at-a-time rule holds across requests too (the graph owns that flag).
pub fn context_with(name: &str, graph: Graph) -> wasmtime_wasi_nn::wit::WasiNnCtx {
    wasmtime_wasi_nn::wit::WasiNnCtx::new(
        [wasmtime_wasi_nn::Backend::from(PvmBackend)],
        wasmtime_wasi_nn::Registry::from(OneGraph {
            name: name.to_string(),
            graph,
        }),
    )
}

/// The wasi:nn state of a run without a model. wasi:nn is not linked then, so this is never reached by a component; it
/// exists so the Store's shape does not depend on the run.
pub fn context_none() -> wasmtime_wasi_nn::wit::WasiNnCtx {
    wasmtime_wasi_nn::wit::WasiNnCtx::new(
        [],
        wasmtime_wasi_nn::Registry::from(wasmtime_wasi_nn::InMemoryRegistry::new()),
    )
}

// ---- the C side: the payload's engine as an ops table ----

/// The engine's C interface (payload/engine_local.cpp fills it). Every function is required; `engine` is passed back to
/// each. Return values: tokenize = the id count, or -needed when `cap` is too small, or INT32_MIN on failure; piece = the
/// byte count, or -needed when `cap` is too small; reset / decode = 0 on success, non-zero on failure. decode appends
/// `n` ids to the sequence and writes n_vocab floats (the last position's logits) to `logits`.
#[repr(C)]
pub struct NnOps {
    pub engine: *mut c_void,
    pub n_vocab: i32,
    pub n_ctx: i32,
    pub tokenize: Option<unsafe extern "C" fn(*mut c_void, *const u8, i32, *mut i32, i32) -> i32>,
    pub piece: Option<unsafe extern "C" fn(*mut c_void, i32, *mut u8, i32) -> i32>,
    pub reset: Option<unsafe extern "C" fn(*mut c_void) -> i32>,
    pub decode: Option<unsafe extern "C" fn(*mut c_void, *const i32, i32, *mut f32) -> i32>,
}

type TokenizeFn = unsafe extern "C" fn(*mut c_void, *const u8, i32, *mut i32, i32) -> i32;
type PieceFn = unsafe extern "C" fn(*mut c_void, i32, *mut u8, i32) -> i32;
type ResetFn = unsafe extern "C" fn(*mut c_void) -> i32;
type DecodeFn = unsafe extern "C" fn(*mut c_void, *const i32, i32, *mut f32) -> i32;

/// An `NnOps` checked once: every function present, sizes positive. Calls are serialised (the engine is one llama
/// context); the pointer is the payload's and outlives the run by the payload's contract.
pub struct CEngine {
    engine: *mut c_void,
    n_vocab: usize,
    n_ctx: usize,
    tokenize: TokenizeFn,
    piece: PieceFn,
    reset: ResetFn,
    decode: DecodeFn,
    lock: Mutex<()>,
}
// SAFETY: every call through `engine` is made under `lock`, so the payload's engine is never entered concurrently; the
// payload keeps it alive for the whole run.
unsafe impl Send for CEngine {}
unsafe impl Sync for CEngine {}

impl CEngine {
    /// # Safety
    /// `ops` must be null or point to a valid `NnOps` whose functions and `engine` stay valid for the returned value's life.
    pub unsafe fn from_ops(ops: *const NnOps) -> Result<CEngine, String> {
        if ops.is_null() {
            return Err("no nn ops".into());
        }
        let o = &*ops;
        let (Some(tokenize), Some(piece), Some(reset), Some(decode)) =
            (o.tokenize, o.piece, o.reset, o.decode)
        else {
            return Err("nn ops: a function is missing (tokenize, piece, reset and decode are all required)".into());
        };
        if o.n_vocab <= 0 || o.n_ctx <= 0 {
            return Err(format!(
                "nn ops: n_vocab {} / n_ctx {} must be > 0",
                o.n_vocab, o.n_ctx
            ));
        }
        Ok(CEngine {
            engine: o.engine,
            n_vocab: o.n_vocab as usize,
            n_ctx: o.n_ctx as usize,
            tokenize,
            piece,
            reset,
            decode,
            lock: Mutex::new(()),
        })
    }
}

impl NnEngine for CEngine {
    fn n_vocab(&self) -> usize {
        self.n_vocab
    }
    fn n_ctx(&self) -> usize {
        self.n_ctx
    }
    fn tokenize(&self, text: &[u8]) -> Result<Vec<i32>, String> {
        let _g = self.lock.lock().map_err(|_| "engine lock poisoned")?;
        let len = i32::try_from(text.len()).map_err(|_| "text too long")?;
        let mut cap = text.len() + 16;
        for _ in 0..2 {
            let mut out = vec![0i32; cap];
            // SAFETY: text is len readable bytes; out is cap writable i32s (cap fits i32: text <= MAX_TEXT_BYTES).
            let n = unsafe {
                (self.tokenize)(
                    self.engine,
                    text.as_ptr(),
                    len,
                    out.as_mut_ptr(),
                    cap as i32,
                )
            };
            if n == i32::MIN {
                return Err("the tokenizer refused this text".into());
            }
            if n >= 0 {
                if n as usize > cap {
                    return Err(format!(
                        "the tokenizer reported {n} ids for a buffer of {cap}"
                    ));
                }
                out.truncate(n as usize);
                return Ok(out);
            }
            cap = n.unsigned_abs() as usize; // -needed: once more with exactly that
        }
        Err("the tokenizer asked for more room twice".into())
    }
    fn piece(&self, id: i32) -> Result<Vec<u8>, String> {
        let _g = self.lock.lock().map_err(|_| "engine lock poisoned")?;
        let mut cap = 64usize;
        for _ in 0..2 {
            let mut buf = vec![0u8; cap];
            // SAFETY: buf is cap writable bytes.
            let n = unsafe { (self.piece)(self.engine, id, buf.as_mut_ptr(), cap as i32) };
            if n >= 0 {
                if n as usize > cap {
                    return Err(format!(
                        "piece {id}: {n} bytes reported for a buffer of {cap}"
                    ));
                }
                buf.truncate(n as usize);
                return Ok(buf);
            }
            let need = n.unsigned_abs() as usize;
            if need > 1 << 16 {
                return Err(format!("piece {id} claims {need} bytes"));
            }
            cap = need;
        }
        Err(format!("piece {id}: asked for more room twice"))
    }
    fn reset(&self) -> Result<(), String> {
        let _g = self.lock.lock().map_err(|_| "engine lock poisoned")?;
        // SAFETY: engine is the payload's live engine.
        match unsafe { (self.reset)(self.engine) } {
            0 => Ok(()),
            rc => Err(format!("reset returned {rc}")),
        }
    }
    fn decode(&self, ids: &[i32], logits: &mut [f32]) -> Result<(), String> {
        if logits.len() != self.n_vocab || ids.is_empty() {
            return Err("decode: wrong logits size or no ids".into());
        }
        let _g = self.lock.lock().map_err(|_| "engine lock poisoned")?;
        // SAFETY: ids is ids.len() readable i32s (<= MAX_TOKENS_PER_COMPUTE); logits is n_vocab writable floats.
        match unsafe {
            (self.decode)(
                self.engine,
                ids.as_ptr(),
                ids.len() as i32,
                logits.as_mut_ptr(),
            )
        } {
            0 => Ok(()),
            rc => Err(format!("the engine's decode returned {rc}")),
        }
    }
}
