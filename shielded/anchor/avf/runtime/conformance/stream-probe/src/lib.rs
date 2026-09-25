//! stream-probe (LAB; PVM-CPU.md, "Streaming sealed responses"): ggml-probe's greedy decode, streamed.
//!
//! GET /?graph=<name>&steps=<n>   - prefill a fixed prompt, then decode n tokens (default 8, max 256). The body is
//!                                  NDJSON, one line per event, each padded with spaces to exactly LINE bytes so a carrier
//!                                  sees the same size for every token (it still sees the count and the cadence):
//!                                    {"graph":..,"n_vocab":..,"prompt_tokens":..,"load_ms":..,"prefill_ms":..}
//!                                    {"i":<k>,"token":<id>,"ms":<since decode start>}      (one per token, flushed)
//!                                    {"done":true,"tokens":<n>,"decode_ms":..,"tok_per_s":..}
//!                                  A write that fails (the client went away) stops the decode at once.
//! GET /ping                      - liveness.
#[allow(warnings)]
mod bindings;

use bindings::exports::wasi::http::incoming_handler::Guest;
use bindings::wasi::http::types::{
    Fields, IncomingRequest, Method, OutgoingBody, OutgoingResponse, ResponseOutparam,
};
use bindings::wasi::io::streams::OutputStream;
use bindings::wasi::nn::graph::load_by_name;
use bindings::wasi::nn::tensor::{Tensor, TensorType};

const PROMPT: &[i32] = &[151644, 8948, 198, 2610, 525, 264, 10950, 17847, 13];
/// every line is padded to this many bytes (the newline included)
const LINE: usize = 128;

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
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// One padded line; false when the client is gone (stop working).
fn line(stream: &OutputStream, json: &str) -> bool {
    let mut b = json.as_bytes().to_vec();
    b.truncate(LINE - 1);
    b.resize(LINE - 1, b' ');
    b.push(b'\n');
    stream.blocking_write_and_flush(&b).is_ok()
}

fn start(out: ResponseOutparam, status: u16) -> (OutgoingBody, OutputStream) {
    let headers = Fields::new();
    let _ = headers.set(&"content-type".to_string(), &[b"application/x-ndjson".to_vec()]);
    let resp = OutgoingResponse::new(headers);
    let _ = resp.set_status_code(status);
    let body = resp.body().unwrap();
    ResponseOutparam::set(out, Ok(resp));
    let stream = body.write().unwrap();
    (body, stream)
}

fn stream_probe(stream: &OutputStream, graph_name: &str, steps: usize) -> Result<(), String> {
    let t0 = now_ms();
    let graph = load_by_name(graph_name)
        .map_err(|e| format!("load_by_name(\"{graph_name}\"): {:?}: {}", e.code(), e.data()))?;
    let ctx = graph
        .init_execution_context()
        .map_err(|e| format!("init_execution_context: {:?}: {}", e.code(), e.data()))?;
    let load_ms = now_ms() - t0;
    let t1 = now_ms();
    let outs = ctx
        .compute(vec![("tokens".to_string(), tokens_tensor(PROMPT))])
        .map_err(|e| format!("compute(prefill): {:?}: {}", e.code(), e.data()))?;
    let logits = outs.iter().find(|(n, _)| n == "logits").ok_or("no \"logits\" output")?;
    let vocab = logits.1.data().len() / 4;
    let (mut tok, top) = argmax_f32_le(&logits.1.data());
    if !top.is_finite() {
        return Err("non-finite top logit after prefill".into());
    }
    let prefill_ms = now_ms() - t1;
    if !line(stream, &format!("{{\"graph\":\"{graph_name}\",\"n_vocab\":{vocab},\"prompt_tokens\":{},\"load_ms\":{load_ms},\"prefill_ms\":{prefill_ms}}}", PROMPT.len())) {
        return Ok(());
    }
    let t2 = now_ms();
    if !line(stream, &format!("{{\"i\":0,\"token\":{tok},\"ms\":0}}")) {
        return Ok(());
    }
    let mut n = 1usize;
    while n < steps {
        let outs = ctx
            .compute(vec![("tokens".to_string(), tokens_tensor(&[tok as i32]))])
            .map_err(|e| format!("compute(decode): {:?}: {}", e.code(), e.data()))?;
        let logits = outs.iter().find(|(n, _)| n == "logits").ok_or("no \"logits\" output mid-decode")?;
        tok = argmax_f32_le(&logits.1.data()).0;
        if !line(stream, &format!("{{\"i\":{n},\"token\":{tok},\"ms\":{}}}", now_ms() - t2)) {
            return Ok(()); // the client cancelled: no more decoding
        }
        n += 1;
    }
    let decode_ms = now_ms() - t2;
    let rate = if decode_ms > 0 { (n as f64 - 1.0) * 1000.0 / decode_ms as f64 } else { 0.0 };
    line(stream, &format!("{{\"done\":true,\"tokens\":{n},\"decode_ms\":{decode_ms},\"tok_per_s\":{rate:.2}}}"));
    Ok(())
}

struct Component;

impl Guest for Component {
    fn handle(req: IncomingRequest, out: ResponseOutparam) {
        let pq = req.path_with_query().unwrap_or_default();
        let path = pq.split('?').next().unwrap_or("/");
        let query = pq.split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();
        let param = |key: &str| -> Option<String> {
            query.split('&').find_map(|kv| kv.strip_prefix(&format!("{key}=")).map(str::to_string))
        };
        match (req.method(), path) {
            (Method::Get, "/ping") => {
                let (body, stream) = start(out, 200);
                line(&stream, "{\"ok\":true}");
                drop(stream);
                let _ = OutgoingBody::finish(body, None);
            }
            (Method::Get, "/") | (Method::Get, "") => {
                let graph = param("graph").unwrap_or_else(|| "model".to_string());
                let steps = param("steps").and_then(|s| s.parse().ok()).unwrap_or(8usize).clamp(1, 256);
                let (body, stream) = start(out, 200);
                if let Err(e) = stream_probe(&stream, &graph, steps) {
                    line(&stream, &format!("{{\"error\":{:?}}}", e));
                }
                drop(stream);
                let _ = OutgoingBody::finish(body, None);
            }
            _ => {
                let (body, stream) = start(out, 404);
                line(&stream, "{\"error\":\"routes: GET /, GET /ping\"}");
                drop(stream);
                let _ = OutgoingBody::finish(body, None);
            }
        }
    }
}

bindings::export!(Component with_types_in bindings);
