// Cache-state correctness fixture. Use full-precision model weights for the
// strict logit comparison: quantized activations can cross rounding boundaries
// when cache fragmentation changes reduction order, even on a cache miss.
// The original model is dequantized with llama_model_quantize (ALL_F32,
// allow_requantize=true), so this uses the same learned weights.
// Profile: MAX_SESSIONS=8, PARK_SLOTS=6, PREFIX_SLOTS=8, N_BATCH=N_UBATCH=64.
// Run both attention and recurrent architectures at N_CTX=512 and 8192.
use std::path::Path;
use wasmtime_wasi_nn::{
    backend::{ggml::GgmlBackend, BackendFromDir, NamedTensor},
    wit::types::{ExecutionTarget, Tensor, TensorType},
    ExecutionContext,
};
fn ints(n: &str, v: &[i32]) -> NamedTensor {
    NamedTensor {
        name: n.into(),
        tensor: Tensor::new(
            vec![v.len() as u32],
            TensorType::I32,
            v.iter().flat_map(|n| n.to_le_bytes()).collect(),
        ),
    }
}
fn call(c: &mut ExecutionContext, v: Vec<NamedTensor>) -> Vec<NamedTensor> {
    c.compute_with_io(v).unwrap()
}
fn row(out: Vec<NamedTensor>) -> Vec<f32> {
    out.iter()
        .find(|x| x.name == "logits")
        .unwrap()
        .tensor
        .data
        .chunks_exact(4)
        .map(|x| f32::from_le_bytes(x.try_into().unwrap()))
        .collect()
}
fn feed(c: &mut ExecutionContext, ids: &[i32], cache: bool) -> Vec<f32> {
    let mut out = vec![];
    for (i, chunk) in ids.chunks(64).enumerate() {
        let mut v = vec![ints("tokens", chunk)];
        if i == 0 {
            if cache {
                v.push(ints("prompt", ids));
                v.push(ints("marks", &[64]));
            } else {
                v.push(ints("prefix_cache", &[0]));
            }
        }
        out = call(c, v);
    }
    row(out)
}
fn argmax(a: &[f32]) -> usize {
    a.iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .unwrap()
        .0
}
fn same(a: &[f32], b: &[f32]) {
    assert_eq!(a.len(), b.len());
    assert_eq!(argmax(a), argmax(b));
    let d = a
        .iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0f32, f32::max);
    assert!(d < 0.02, "logit mismatch {d}");
}
fn main() {
    let path = std::env::args().nth(1).unwrap();
    let mut backend = GgmlBackend::default();
    let g = backend
        .load_from_dir(Path::new(&path), ExecutionTarget::Cpu)
        .unwrap();
    let oracle = backend
        .load_from_dir(Path::new(&path), ExecutionTarget::Cpu)
        .unwrap();
    let held: Vec<_> = (0..8)
        .map(|_| g.init_execution_context().unwrap())
        .collect();
    assert!(
        g.init_execution_context().is_err(),
        "ninth active context must be refused"
    );
    drop(held);
    println!("EIGHT_ACTIVE_SLOTS_PASS");
    // 8 distinct 224-token prompts exceed the 512-token shared pool many times.
    // Every completed cache-backed run must equal the uncached oracle.
    for n in 0..8 {
        let p: Vec<i32> = (0..224).map(|i| 100 + n * 31 + i % 23).collect();
        let mut r = oracle.init_execution_context().unwrap();
        let expected = feed(&mut r, &p, false);
        let next = argmax(&expected) as i32;
        let expected_next = row(call(&mut r, vec![ints("tokens", &[next])]));
        drop(r);
        let mut c = g.init_execution_context().unwrap();
        same(&feed(&mut c, &p, true), &expected);
        same(
            &row(call(&mut c, vec![ints("tokens", &[next])])),
            &expected_next,
        );
        drop(c);
        println!("PRESSURE_CASE_PASS {n}");
    }
    // A borrowed prefix remains pinned while unrelated requests reclaim parks.
    let p: Vec<i32> = (0..160).map(|i| 700 + i % 19).collect();
    let mut c = g.init_execution_context().unwrap();
    let seed = feed(&mut c, &p, true);
    let mut seed_oracle = oracle.init_execution_context().unwrap();
    let seed_expected = feed(&mut seed_oracle, &p, false);
    println!("CHECK_COLD_SEED");
    same(&seed, &seed_expected);
    drop(seed_oracle);
    call(&mut c, vec![ints("tokens", &[argmax(&seed) as i32])]);
    drop(c);
    let mut borrower = g.init_execution_context().unwrap();
    same(&feed(&mut borrower, &p, true), &seed);
    println!("BORROWER_PREFIX_PASS");
    for n in 0..5 {
        let q: Vec<i32> = (0..160).map(|i| 900 + n * 29 + i % 17).collect();
        let mut c = g.init_execution_context().unwrap();
        let r = feed(&mut c, &q, true);
        call(&mut c, vec![ints("tokens", &[argmax(&r) as i32])]);
        drop(c);
    }
    let mut r = oracle.init_execution_context().unwrap();
    let expected = feed(&mut r, &p, false);
    let next = argmax(&expected) as i32;
    println!("BORROWER_RESUMING");
    same(
        &row(call(&mut borrower, vec![ints("tokens", &[next])])),
        &row(call(&mut r, vec![ints("tokens", &[next])])),
    );
    println!("PINNED_BORROWER_PASS; CACHE_PRESSURE_PASS");
}
