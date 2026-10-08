//! cpu-probe (PVM-CPU.md, the CPU-only tier's conformance app): a CPU-only workload, streamed. No wasi:nn, no model.
//!
//! GET /?steps=<n>&work=<w>  - n steps (default 8, max 256), each w rounds (default 20000, max 1000000) of an FNV-1a chain
//!                             over the previous value. The body is NDJSON, one line per event, each padded with spaces to
//!                             exactly LINE bytes so a carrier sees the same size for every step (it still sees the count
//!                             and the cadence):
//!                               {"probe":"cpu","steps":<n>,"work":<w>}
//!                               {"i":<k>,"v":"<16 hex>","ms":<since the first step>}      (one per step, flushed)
//!                               {"done":true,"steps":<n>,"ms":..,"v":"<16 hex>"}
//!                             The values are deterministic for (n, w): a client checks them exactly. A write that fails
//!                             (the client went away) stops the work at once.
//! GET /ping                 - liveness.
#[allow(warnings)]
mod bindings;

use bindings::exports::wasi::http::incoming_handler::Guest;
use bindings::wasi::http::types::{Fields, IncomingRequest, Method, OutgoingBody, OutgoingResponse, ResponseOutparam};
use bindings::wasi::io::streams::OutputStream;

/// every line is padded to this many bytes (the newline included)
const LINE: usize = 128;
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// w rounds of FNV-1a over the 8 little-endian bytes of the running value, starting from `v`
fn work(mut v: u64, rounds: u32) -> u64 {
    for _ in 0..rounds {
        let mut h = FNV_OFFSET;
        for b in v.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(FNV_PRIME);
        }
        v = h;
    }
    v
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

fn cpu_probe(stream: &OutputStream, steps: usize, rounds: u32) {
    if !line(stream, &format!("{{\"probe\":\"cpu\",\"steps\":{steps},\"work\":{rounds}}}")) {
        return;
    }
    let t0 = now_ms();
    let mut v = FNV_OFFSET;
    for i in 0..steps {
        v = work(v, rounds);
        if !line(stream, &format!("{{\"i\":{i},\"v\":\"{v:016x}\",\"ms\":{}}}", now_ms() - t0)) {
            return; // the client cancelled: no more work
        }
    }
    line(stream, &format!("{{\"done\":true,\"steps\":{steps},\"ms\":{},\"v\":\"{v:016x}\"}}", now_ms() - t0));
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
                let steps = param("steps").and_then(|s| s.parse().ok()).unwrap_or(8usize).clamp(1, 256);
                let rounds = param("work").and_then(|s| s.parse().ok()).unwrap_or(20_000u32).clamp(1, 1_000_000);
                let (body, stream) = start(out, 200);
                cpu_probe(&stream, steps, rounds);
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
