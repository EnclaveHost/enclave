// The portable runtime's MODEL conformance component (PVM-CPU.md, "The app runtime", milestone 3): a wasi:cli command that
// reaches the domain's model only through wasi:nn (the server's ggml contract: load-by-name, "tokenize" -> "ids",
// "tokens" -> "logits", "vocab_pieces"), so the same bytes run on the server's patched wasmtime and in the Pixel pVM.
//   nn-cli selftest <graph>          the pVM CPU capability self-test (engine_local.cpp SELFTEST_*), greedy, through
//                                    wasi:nn: its digest must equal the one the engine computes on its own path in the
//                                    same VM (the CAPS report's output_sha256) -- parity of the app path with the engine
//   nn-cli gen <graph> <n> <text>    greedy-decode n tokens after <text> (tokenized by the model; no BOS added)
//   nn-cli refusals <graph>          what the runtime must refuse, one line each; exit 0 only when every one was refused
// Every digest is SHA-256( id "\n" || count u32 LE || each id u32 LE ), the engine's self-test format.
wit_bindgen::generate!({ path: "wit", world: "nn-cli", generate_all });

use sha2::{Digest, Sha256};
use std::time::Instant;
use wasi::nn::graph::{load, load_by_name, ExecutionTarget, GraphEncoding};
use wasi::nn::inference::GraphExecutionContext;
use wasi::nn::tensor::{Tensor, TensorType};

const SELFTEST_ID: &str = "pvm-cpu-selftest-v1";
const SELFTEST_PROMPT: &str = "Write a Python function called factorial that returns n factorial for a non-negative integer n. Give only the code.";
const SELFTEST_TOKENS: usize = 64;
/// Gemma 4's end-of-generation pieces (the self-test stops on llama_vocab_is_eog; these are the model's EOG tokens' text)
const EOG_PIECES: &[&[u8]] = &[b"<eos>", b"<turn|>"];

fn e(what: &str, x: wasi::nn::errors::Error) -> String {
    format!("{what}: {:?}: {}", x.code(), x.data())
}

fn i32_tensor(ids: &[i32]) -> Tensor {
    let bytes: Vec<u8> = ids.iter().flat_map(|v| v.to_le_bytes()).collect();
    Tensor::new(&vec![1, ids.len() as u32], TensorType::I32, &bytes)
}

fn out<'a>(outs: &'a [(String, Tensor)], name: &str) -> Result<&'a Tensor, String> {
    outs.iter()
        .find(|(n, _)| n == name)
        .map(|(_, t)| t)
        .ok_or_else(|| format!("no \"{name}\" output"))
}

fn tokenize(ctx: &GraphExecutionContext, text: &str) -> Result<Vec<i32>, String> {
    let t = Tensor::new(&vec![text.len() as u32], TensorType::U8, text.as_bytes());
    let outs = ctx
        .compute(vec![("tokenize".to_string(), t)])
        .map_err(|x| e("tokenize", x))?;
    let ids = out(&outs, "ids")?.data();
    Ok(ids
        .chunks_exact(4)
        .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

/// Feeds ids, returns the argmax of the last position's logits (the first maximum, as llama's greedy sampler picks).
fn step(ctx: &GraphExecutionContext, ids: &[i32]) -> Result<(i32, usize), String> {
    let outs = ctx
        .compute(vec![("tokens".to_string(), i32_tensor(ids))])
        .map_err(|x| e("compute(tokens)", x))?;
    let data = out(&outs, "logits")?.data();
    let (mut best, mut bv) = (0usize, f32::NEG_INFINITY);
    for (i, c) in data.chunks_exact(4).enumerate() {
        let v = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        if v > bv {
            (best, bv) = (i, v);
        }
    }
    if !bv.is_finite() {
        return Err("no finite logit".into());
    }
    Ok((best as i32, data.len() / 4))
}

fn pieces(ctx: &GraphExecutionContext) -> Result<(Vec<u8>, Vec<i32>), String> {
    let outs = ctx
        .compute(vec![("vocab_pieces".to_string(), i32_tensor(&[1]))])
        .map_err(|x| e("vocab_pieces", x))?;
    let bytes = out(&outs, "bytes")?.data();
    let offsets = out(&outs, "offsets")?
        .data()
        .chunks_exact(4)
        .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    Ok((bytes, offsets))
}

fn digest(id: &str, ids: &[i32]) -> String {
    let mut h = Sha256::new();
    h.update(id.as_bytes());
    h.update(b"\n");
    h.update((ids.len() as u32).to_le_bytes());
    for v in ids {
        h.update((*v as u32).to_le_bytes());
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Greedy generation: prompt ids in, up to `n` ids out, stopping after an EOG piece when `eog` is given.
fn greedy(
    ctx: &GraphExecutionContext,
    prompt: &[i32],
    n: usize,
    eog: Option<(&[u8], &[i32])>,
) -> Result<(Vec<i32>, u128, u128, usize), String> {
    let t0 = Instant::now();
    let (mut tok, n_vocab) = step(ctx, prompt)?;
    let prefill_ms = t0.elapsed().as_millis();
    let t1 = Instant::now();
    let mut ids = Vec::with_capacity(n);
    for k in 0..n {
        ids.push(tok);
        let end = eog.is_some_and(|(b, o)| {
            let (s, t) = (o[tok as usize] as usize, o[tok as usize + 1] as usize);
            EOG_PIECES.contains(&&b[s..t])
        });
        if end || k + 1 == n {
            break;
        }
        tok = step(ctx, &[tok])?.0;
    }
    Ok((ids, prefill_ms, t1.elapsed().as_millis(), n_vocab))
}

fn selftest(graph: &str) -> Result<(), String> {
    let g = load_by_name(graph).map_err(|x| e("load_by_name", x))?;
    let ctx = g
        .init_execution_context()
        .map_err(|x| e("init_execution_context", x))?;
    let (bytes, offsets) = pieces(&ctx)?;
    // the engine tokenizes with add_special on (it prepends BOS); the server's tokenize verb adds none, so the text names it
    let text = format!("<bos><|turn>user\n{SELFTEST_PROMPT}<turn|>\n<|turn>model\n");
    let prompt = tokenize(&ctx, &text)?;
    let (ids, pf, dc, n_vocab) = greedy(&ctx, &prompt, SELFTEST_TOKENS, Some((&bytes, &offsets)))?;
    println!(
        "nn selftest {SELFTEST_ID} graph={graph} n_vocab={n_vocab} prompt_tokens={}",
        prompt.len()
    );
    println!(
        "nn ids {}",
        ids.iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    let mut txt = Vec::new();
    for &t in &ids {
        txt.extend_from_slice(
            &bytes[offsets[t as usize] as usize..offsets[t as usize + 1] as usize],
        );
    }
    println!(
        "nn text {}",
        txt.iter().map(|b| format!("{b:02x}")).collect::<String>()
    );
    println!("nn digest {}", digest(SELFTEST_ID, &ids));
    let rate = if dc > 0 {
        (ids.len().saturating_sub(1)) as f64 * 1000.0 / dc as f64
    } else {
        0.0
    };
    eprintln!("nn timing prefill_ms={pf} decode_ms={dc} decode_tok_s={rate:.2}");
    Ok(())
}

fn gen(graph: &str, n: usize, text: &str) -> Result<(), String> {
    let g = load_by_name(graph).map_err(|x| e("load_by_name", x))?;
    let ctx = g
        .init_execution_context()
        .map_err(|x| e("init_execution_context", x))?;
    let prompt = tokenize(&ctx, text)?;
    let (ids, _, _, n_vocab) = greedy(&ctx, &prompt, n, None)?;
    println!(
        "nn gen graph={graph} n_vocab={n_vocab} prompt {}",
        prompt
            .iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    println!(
        "nn ids {}",
        ids.iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    println!("nn digest {}", digest("nn-gen", &ids));
    Ok(())
}

fn refusals(graph: &str) -> Result<(), String> {
    let mut fails = 0;
    let mut check = |name: &str, refused: bool| {
        println!("refusal {name} {}", if refused { "ok" } else { "FAIL" });
        if !refused {
            fails += 1;
        }
    };
    check("unknown-graph", load_by_name("no-such-model").is_err());
    check(
        "own-weights",
        load(
            &[b"GGUF not a model".to_vec()],
            GraphEncoding::Ggml,
            ExecutionTarget::Cpu,
        )
        .is_err(),
    );
    let g = load_by_name(graph).map_err(|x| e("load_by_name", x))?;
    let a = g
        .init_execution_context()
        .map_err(|x| e("init_execution_context", x))?;
    check("second-context", g.init_execution_context().is_err());
    let (_, n_vocab) = step(&a, &[1])?;
    let tokens = |t: Tensor| a.compute(vec![("tokens".to_string(), t)]).is_err();
    check("token-out-of-range", tokens(i32_tensor(&[n_vocab as i32])));
    check("token-negative", tokens(i32_tensor(&[-1])));
    check(
        "tokens-not-i32",
        tokens(Tensor::new(&vec![1, 4], TensorType::U8, &[1, 0, 0, 0])),
    );
    check(
        "tokens-short-data",
        tokens(Tensor::new(&vec![1, 2], TensorType::I32, &[1, 0, 0, 0])),
    );
    check(
        "tokens-empty",
        tokens(Tensor::new(&vec![1, 0], TensorType::I32, &[])),
    );
    check(
        "unsupported-beside-tokens",
        a.compute(vec![
            ("tokens".to_string(), i32_tensor(&[1])),
            ("all".to_string(), i32_tensor(&[1])),
        ])
        .is_err(),
    );
    check(
        "unknown-verb",
        a.compute(vec![("caps".to_string(), i32_tensor(&[1]))])
            .is_err(),
    );
    check("no-inputs", a.compute(vec![]).is_err());
    drop(a);
    check("context-after-drop", g.init_execution_context().is_ok());
    if fails == 0 {
        println!("refusals all ok");
        Ok(())
    } else {
        Err(format!("{fails} refusal(s) not refused"))
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let a = |i: usize| args.get(i).map(|s| s.as_str()).unwrap_or("");
    let r = match a(0) {
        "selftest" => selftest(a(1)),
        "gen" => match a(2).parse() {
            Ok(n) if n >= 1 => gen(a(1), n, a(3)),
            _ => Err("gen <graph> <n >= 1> <text>".into()),
        },
        "refusals" => refusals(a(1)),
        _ => {
            Err("usage: nn-cli selftest <graph> | gen <graph> <n> <text> | refusals <graph>".into())
        }
    };
    if let Err(m) = r {
        eprintln!("nn-cli: {m}");
        std::process::exit(1);
    }
}
