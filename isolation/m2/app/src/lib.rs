// M2 test app: a wasi:http proxy component, served inside its domain by `wasmtime serve`.
//   POST /echo -> the request body, streamed back (the throughput probe)
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
