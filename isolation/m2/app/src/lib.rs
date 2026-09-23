// Test app for M2 and M3: a wasi:http proxy component, served inside its domain by `wasmtime serve`.
//   POST /echo   -> the request body, streamed back (the throughput probe)
//   GET /burn?n= -> n million rounds of xorshift, then the state (the CPU-share probe: M3 gives two
//                   domains different cpu.max and compares how long the same work takes)
//   anything else -> "APP <LABEL> path=<path>\n"
// The label is compiled in (M2_LABEL, 5 bytes) so two builds differ in bytes, and so in identity.
use wasi::http::types::{
    Fields, IncomingRequest, Method, OutgoingBody, OutgoingResponse, ResponseOutparam,
};
use wasi::io::streams::{OutputStream, StreamError};

const LABEL: &str = match option_env!("M2_LABEL") {
    Some(l) => l,
    None => "AAAAA",
};

wasi::http::proxy::export!(App);
struct App;

impl wasi::exports::http::incoming_handler::Guest for App {
    fn handle(req: IncomingRequest, out: ResponseOutparam) {
        let path = req.path_with_query().unwrap_or_default();
        let echo = matches!(req.method(), Method::Post) && path == "/echo";
        let burn = path.strip_prefix("/burn?n=").and_then(|n| n.parse::<u64>().ok());
        let resp = OutgoingResponse::new(Fields::new());
        let body = resp.body().unwrap();
        ResponseOutparam::set(out, Ok(resp));
        let os = body.write().unwrap();
        if echo {
            let ib = req.consume().unwrap();
            let is = ib.stream().unwrap();
            loop {
                match is.blocking_read(1 << 16) {
                    Ok(chunk) => {
                        if !write_all(&os, &chunk) {
                            break;
                        }
                    }
                    Err(StreamError::Closed) | Err(_) => break,
                }
            }
        } else if let Some(millions) = burn {
            let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
            for _ in 0..millions.min(100_000).saturating_mul(1_000_000) {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
            }
            write_all(&os, format!("APP {LABEL} burn={millions}M state={x:016x}\n").as_bytes());
        } else {
            write_all(&os, format!("APP {LABEL} path={path}\n").as_bytes());
        }
        os.blocking_flush().ok();
        drop(os);
        OutgoingBody::finish(body, None).ok();
    }
}

// blocking-write-and-flush takes at most 4096 bytes a call; go through check-write instead
fn write_all(os: &OutputStream, mut data: &[u8]) -> bool {
    while !data.is_empty() {
        let n = match os.check_write() {
            Ok(n) => n as usize,
            Err(_) => return false,
        };
        if n == 0 {
            os.subscribe().block();
            continue;
        }
        let k = n.min(data.len());
        if os.write(&data[..k]).is_err() {
            return false;
        }
        data = &data[k..];
    }
    true
}
