//! ggml-probe: smoke the ggml (llama.cpp) wasi-nn backend end to end.
//!
//! GET /            - load_by_name the preloaded GGUF, greedy-decode a few
//!                    tokens through ONE stateful execution context, report
//!                    token ids + timings as JSON.
//!   ?graph=<name>  - registry name (default: env PROBE_GRAPH, then "model";
//!                    the host registers a preload under its DIRECTORY name)
//!   ?steps=<n>     - decode steps after prefill (default 8, max 384)
//! GET /ping        - liveness, touches no model.
//!
//! The probe asserts the two properties the backend exists for: the guest
//! never holds the weights (load-by-name), and the KV cache lives in the
//! execution context (each step feeds ONE token and the distribution moves).
#[allow(warnings)]
mod bindings;

use bindings::exports::wasi::http::incoming_handler::Guest;
use bindings::wasi::http::types::{
    Fields, IncomingRequest, Method, OutgoingBody, OutgoingResponse, ResponseOutparam,
};
use bindings::wasi::nn::graph::load_by_name;
use bindings::wasi::nn::tensor::{Tensor, TensorType};

// a fixed Qwen2.5-flavoured prompt prefix; any ids < n_vocab exercise decode
const PROMPT: &[i32] = &[814, 20139, 303, 799, 13901, 3069, 279, 12515, 369, 6105, 11, 1179, 1103, 2250, 5265, 41724, 13];

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

fn probe(graph_name: &str, steps: usize, mtp: bool, fast: bool, k: usize) -> Result<String, String> {
    let t0 = now_ms();
    let graph = load_by_name(graph_name)
        .map_err(|e| format!("load_by_name(\"{graph_name}\"): {:?}: {}", e.code(), e.data()))?;
    let ctx = graph
        .init_execution_context()
        .map_err(|e| format!("init_execution_context: {:?}: {}", e.code(), e.data()))?;
    let load_ms = now_ms() - t0;

    // prefill: the whole prompt in one compute; logits = last-token distribution
    let t1 = now_ms();
    let mut outs = Vec::new();
    for chunk in PROMPT.chunks(16) {
        let mut inputs = vec![("tokens".to_string(), tokens_tensor(chunk))];
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

    // greedy decode: ONE token per compute - only works if the KV cache
    // persists inside the execution context between calls
    let t2 = now_ms();
    let mut seq = vec![tok as i64];
    let mut drafted=0usize; let mut accepted=0usize;
    if mtp {
        let mut fed=PROMPT.len();
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
        "{{\"graph\":\"{graph_name}\",\"n_vocab\":{vocab},\"prompt_tokens\":{},\"tokens\":{:?},\
         \"mtp\":{mtp},\"k\":{k},\"drafted\":{drafted},\"accepted\":{accepted},\"load_ms\":{load_ms},\"prefill_ms\":{prefill_ms},\"decode_ms\":{decode_ms},\
         \"tok_per_s\":{:.2}}}",
        PROMPT.len(),
        seq,
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
        match (req.method(), path) {
            (Method::Get, "/ping") => respond(out, 200, "application/json", b"{\"ok\":true}"),
            (Method::Get, "/") | (Method::Get, "") => {
                let graph = param("graph")
                    .or_else(|| std::env::var("PROBE_GRAPH").ok())
                    .unwrap_or_else(|| "model".to_string());
                let steps = param("steps")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(8usize)
                    .clamp(1, 384);
                match probe(&graph, steps, param("mtp").as_deref()==Some("1"), param("topk").as_deref()==Some("1"), param("k").and_then(|s|s.parse::<usize>().ok()).unwrap_or(1).clamp(1,3)) {
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
