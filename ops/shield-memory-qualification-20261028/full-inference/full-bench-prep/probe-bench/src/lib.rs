//! ggml-probe-bench: the evidence ggml probe plus deterministic public synthetic prompts.
//!
//! GET /            - load_by_name the preloaded GGUF, prefill, greedy-decode through ONE
//!                    stateful execution context, report token ids + timings as JSON.
//!   ?graph=<name>  - registry name (default: env PROBE_GRAPH, then "model")
//!   ?steps=<n>     - decode steps after prefill (default 8, max 384)
//!   ?mtp=1&k=<n>   - one-token MTP rounds (k 1..3), as in the evidence probe
//!   ?topk=1        - top-k decode output instead of full logits
//!   ?prompt=<n>&seed=<s>              - n synthetic ids from seed s (public, no text)
//!   ?shared=<m>&shared_seed=<t>       - m ids from seed t placed BEFORE the unique part,
//!                                       identical across sessions (a prefix cache may reuse it)
//!                    Without prompt/shared the historical fixed 17-token prompt is used,
//!                    prefilled in chunks of 16 exactly as before; synthetic prompts use 64
//!                    (the measured N_BATCH).
//! GET /ping        - liveness, touches no model.
//!
//! Errors never echo request values. Responses carry ids, counts, timings and an FNV-1a 64 hash
//! of the generated ids so arms can be compared without diffing arrays.
#[allow(warnings)]
mod bindings;

use bindings::exports::wasi::http::incoming_handler::Guest;
use bindings::wasi::http::types::{
    Fields, IncomingRequest, Method, OutgoingBody, OutgoingResponse, ResponseOutparam,
};
use bindings::wasi::nn::graph::load_by_name;
use bindings::wasi::nn::tensor::{Tensor, TensorType};

// the evidence probe's fixed prompt, unchanged
const PROMPT: &[i32] = &[814, 20139, 303, 799, 13901, 3069, 279, 12515, 369, 6105, 11, 1179, 1103, 2250, 5265, 41724, 13];
const MAX_PROMPT: usize = 16384;

fn respond(out: ResponseOutparam, status: u16, ctype: &str, body_bytes: &[u8]) {
    let headers = Fields::new();
    let _ = headers.set(&"content-type".to_string(), &[ctype.as_bytes().to_vec()]);
    let resp = OutgoingResponse::new(headers);
    let _ = resp.set_status_code(status);
    let body = resp.body().unwrap();
    ResponseOutparam::set(out, Ok(resp));
    let stream = body.write().unwrap();
    for chunk in body_bytes.chunks(4000) {
        if stream.blocking_write_and_flush(chunk).is_err() {
            break;
        }
    }
    drop(stream);
    let _ = OutgoingBody::finish(body, None);
}

fn tokens_tensor(ids: &[i32]) -> Tensor {
    let bytes: Vec<u8> = ids.iter().flat_map(|v| v.to_le_bytes()).collect();
    Tensor::new(&[1, ids.len() as u32], TensorType::I32, &bytes)
}

fn argmax_f32_le(data: &[u8]) -> (usize, f32) {
    let mut best = (0usize, f32::NEG_INFINITY);
    for (i, c) in data.chunks_exact(4).enumerate() {
        let v = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
        if v > best.1 {
            best = (i, v);
        }
    }
    best
}

fn now_ms() -> u128 {
    use std::time::{Instant};
    { static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new(); START.get_or_init(Instant::now).elapsed().as_millis() }
}

/// xorshift64* ids in [1000, 100000): inside Qwen3.x's vocabulary, public, deterministic.
fn synth(seed: u64, n: usize, out: &mut Vec<i32>) {
    let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
    for _ in 0..n {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        let r = x.wrapping_mul(0x2545_F491_4F6C_DD1D);
        out.push(1000 + ((r >> 33) % 99_000) as i32);
    }
}

fn fnv1a64(ids: &[i64]) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for t in ids {
        for b in (*t as i32).to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

fn probe(graph_name: &str, prompt: &[i32], chunk: usize, steps: usize, mtp: bool, fast: bool, k: usize) -> Result<String, String> {
    let t0 = now_ms();
    let graph = load_by_name(graph_name)
        .map_err(|e| format!("load_by_name: {:?}: {}", e.code(), e.data()))?;
    let ctx = graph
        .init_execution_context()
        .map_err(|e| format!("init_execution_context: {:?}: {}", e.code(), e.data()))?;
    let load_ms = now_ms() - t0;

    // prefill; logits = last-token distribution, whose argmax is the first generated token
    let t1 = now_ms();
    let mut outs = Vec::new();
    for part in prompt.chunks(chunk) {
        let mut inputs = vec![("tokens".to_string(), tokens_tensor(part))];
        if mtp { inputs.push(("mtp".into(), tokens_tensor(&[1]))); }
        outs = ctx.compute(inputs)
            .map_err(|e| format!("compute(prefill): {:?}: {}", e.code(), e.data()))?;
    }
    let logits = outs
        .iter()
        .find(|(n, _)| n == "logits")
        .ok_or("no \"logits\" output")?;
    let vocab = logits.1.data().len() / 4;
    let (mut tok, top) = argmax_f32_le(&logits.1.data());
    if !top.is_finite() {
        return Err("non-finite top logit after prefill".into());
    }
    let prefill_ms = now_ms() - t1;
    let ttft_ms = now_ms() - t0;

    let t2 = now_ms();
    let mut seq = vec![tok as i64];
    let mut drafted=0usize; let mut accepted=0usize;
    if mtp {
        let mut fed=prompt.len();
        let mut observe: Option<Vec<i32>>=None;
        while seq.len() < steps {
            let mut inputs=vec![("tokens".into(), tokens_tensor(&[tok as i32])),
                ("mtp_round".into(), tokens_tensor(&[tok as i32,k as i32,0])),
                ("topk".into(), tokens_tensor(&[16]))];
            if let Some(obs)=observe.take() { inputs.push(("mtp_obs".into(), tokens_tensor(&obs))); }
            let outs=ctx.compute(inputs).map_err(|e|format!("mtp_round: {}",e.data()))?;
            let ints=|name:&str| -> Result<Vec<i32>,String> {
                let t=outs.iter().find(|(n,_)|n==name).ok_or(format!("missing {name}"))?;
                Ok(t.1.data().chunks_exact(4).map(|b|i32::from_le_bytes(b.try_into().unwrap())).collect())
            };
            let drafts=ints("draft")?; let rows=ints("topk_ids")?;
            if drafts.len()>k || rows.len()!=(drafts.len()+1)*16 { return Err("bad MTP result shape".into()); }
            drafted+=drafts.len();
            let mut obs=vec![fed as i32,tok as i32];
            let mut acc=0usize;
            while acc<drafts.len() && rows[acc*16]==drafts[acc] { acc+=1; }
            accepted+=acc;
            for d in &drafts[..acc] {
                if seq.len()<steps {seq.push(*d as i64);}
                obs.push(*d);
            }
            fed+=acc+1;
            tok=rows[acc*16] as usize;
            if acc<drafts.len() {
                ctx.compute(vec![("rewind".into(),tokens_tensor(&[fed as i32]))])
                    .map_err(|e|format!("rewind: {}",e.data()))?;
            }
            observe=Some(obs);
            if seq.len()<steps {seq.push(tok as i64);}
        }
    } else {
    for _ in 1..steps {
        let mut inputs=vec![("tokens".to_string(), tokens_tensor(&[tok as i32]))];
        if fast { inputs.push(("topk".into(),tokens_tensor(&[16]))); }
        let outs = ctx
            .compute(inputs)
            .map_err(|e| format!("compute(decode): {:?}: {}", e.code(), e.data()))?;
        let next=if fast {
            let ids=outs.iter().find(|(n,_)| n=="topk_ids").ok_or("missing topk_ids")?.1.data();
            i32::from_le_bytes(ids[0..4].try_into().unwrap()) as usize
        } else {
            let logits=outs.iter().find(|(n,_)| n=="logits").ok_or("missing logits")?;
            argmax_f32_le(&logits.1.data()).0
        };
        seq.push(next as i64);
        tok = next;
    }
    }
    let decode_ms = now_ms() - t2;

    Ok(format!(
        "{{\"graph\":\"{graph_name}\",\"n_vocab\":{vocab},\"prompt_tokens\":{},\"tokens\":{:?},\"tokens_fnv1a64\":\"{:016x}\",\
         \"mtp\":{mtp},\"k\":{k},\"drafted\":{drafted},\"accepted\":{accepted},\"load_ms\":{load_ms},\"prefill_ms\":{prefill_ms},\
         \"ttft_ms\":{ttft_ms},\"decode_ms\":{decode_ms},\"tok_per_s\":{:.2}}}",
        prompt.len(),
        seq,
        fnv1a64(&seq),
        if decode_ms > 0 { (seq.len() as f64 - 1.0) * 1000.0 / decode_ms as f64 } else { 0.0 },
    ))
}

struct Component;

impl Guest for Component {
    fn handle(req: IncomingRequest, out: ResponseOutparam) {
        let pq = req.path_with_query().unwrap_or_default();
        let path = pq.split('?').next().unwrap_or("/");
        let query = pq.split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();
        let param = |key: &str| -> Option<String> {
            query
                .split('&')
                .find_map(|kv| kv.strip_prefix(&format!("{key}=")).map(str::to_string))
        };
        let num = |key: &str| -> Option<u64> { param(key).and_then(|s| s.parse().ok()) };
        match (req.method(), path) {
            (Method::Get, "/ping") => respond(out, 200, "application/json", b"{\"ok\":true}"),
            (Method::Get, "/") | (Method::Get, "") => {
                let graph = param("graph")
                    .or_else(|| std::env::var("PROBE_GRAPH").ok())
                    .unwrap_or_else(|| "model".to_string());
                let steps = num("steps").map(|s| s as usize).unwrap_or(8).clamp(1, 384);
                let unique = num("prompt").unwrap_or(0) as usize;
                let shared = num("shared").unwrap_or(0) as usize;
                let (prompt, chunk) = if unique == 0 && shared == 0 {
                    (PROMPT.to_vec(), 16usize)
                } else if unique + shared > MAX_PROMPT {
                    respond(out, 400, "application/json", b"{\"error\":\"prompt over 16384 ids\"}");
                    return;
                } else {
                    let mut p = Vec::with_capacity(unique + shared);
                    synth(num("shared_seed").unwrap_or(0), shared, &mut p);
                    synth(num("seed").unwrap_or(0) ^ 0x5bd1_e995, unique, &mut p);
                    (p, 64usize)
                };
                let k = num("k").map(|s| s as usize).unwrap_or(1).clamp(1, 3);
                match probe(&graph, &prompt, chunk, steps, param("mtp").as_deref()==Some("1"), param("topk").as_deref()==Some("1"), k) {
                    Ok(json) => respond(out, 200, "application/json", json.as_bytes()),
                    Err(e) => respond(
                        out,
                        500,
                        "application/json",
                        format!("{{\"error\":{:?}}}", e).as_bytes(),
                    ),
                }
            }
            _ => respond(out, 404, "application/json", b"{\"error\":\"routes: GET /, GET /ping\"}"),
        }
    }
}

bindings::export!(Component with_types_in bindings);
