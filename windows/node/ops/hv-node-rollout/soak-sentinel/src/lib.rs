// The SOAK SENTINEL (SOAK-SENTINEL.md; enclave-87): a wasi:http proxy component, served in its partition by `wasmtime
// serve` like any catalog app on the hv tier, for the NucBox soak (windows/node/ops/hv-soak/soak.mjs). The soak asks
// `GET /hv-soak/<token>` with the same token in `x-hv-soak`; the token is random per sample and not a secret, and seeing
// it in the partition's console or in the node's or manager's log is a LEAK.
//   every request   PRINTS "<tag>-STDOUT-REQ <method> <path> <x-hv-soak>" to stdout and "<tag>-STDERR-REQ …" to stderr:
//                   a guest that gives the app the console (v40's domexec) puts the token on it; a fixed guest sends
//                   both to /dev/null.
//   GET (any path)  200 text/plain, "<marker> token=<x-hv-soak> path=<path> printed stdout=<n>B stderr=<n>B\n": the soak
//                   can tell THIS app answered THIS sample (its token echoed back: enclave-bf's amended G1), and that it
//                   WROTE both token lines (the byte counts the write calls accepted; FAILED if one refused).
//   HEAD (any path) 200, and it TRIES to send a body "<tag>-HEADBODY <path> <x-hv-soak>". wasmtime serve's HTTP server
//                   drops a HEAD body (SOAK-SENTINEL.md records what reached the wire), so a production app cannot
//                   reach the front's unsolicited-response guard this way; the canary's bundle/2 sentinel covers that.
// The tag and the marker are SOAK_TAG and SOAK_MARKER at build time: the bytes, and so the CID, are this build's own.
use wasi::http::types::{Fields, IncomingRequest, Method, OutgoingBody, OutgoingResponse, ResponseOutparam};
use std::io::Write;
use wasi::io::streams::OutputStream;

const TAG: &str = env!("SOAK_TAG");
const MARKER: &str = env!("SOAK_MARKER");

wasi::http::proxy::export!(App);
struct App;

impl wasi::exports::http::incoming_handler::Guest for App {
    fn handle(req: IncomingRequest, out: ResponseOutparam) {
        let path = req.path_with_query().unwrap_or_default();
        let method = match req.method() {
            Method::Get => "GET".to_string(),
            Method::Head => "HEAD".to_string(),
            Method::Post => "POST".to_string(),
            Method::Other(m) => m,
            _ => "OTHER".to_string(),
        };
        // the soak's token header, if any; bounded and printable, so a line stays one line
        let soak: String = req.headers().get(&"x-hv-soak".to_string()).first()
            .map(|v| String::from_utf8_lossy(v).chars().filter(|c| c.is_ascii_graphic()).take(128).collect())
            .unwrap_or_else(|| "-".to_string());
        let path: String = path.chars().filter(|c| c.is_ascii_graphic()).take(512).collect();
        // what it PRINTED, as the write calls themselves report it: the body says the lines were written, so a console that
        // shows none of them proves the discard rather than an app that stayed quiet (enclave-87)
        let out_line = format!("{TAG}-STDOUT-REQ {method} {path} {soak}\n");
        let err_line = format!("{TAG}-STDERR-REQ {method} {path} {soak}\n");
        let wrote = |r: std::io::Result<()>, n: usize| if r.is_ok() { format!("{n}B") } else { "FAILED".to_string() };
        let so = { let mut o = std::io::stdout(); wrote(o.write_all(out_line.as_bytes()).and_then(|_| o.flush()), out_line.len()) };
        let se = { let mut e = std::io::stderr(); wrote(e.write_all(err_line.as_bytes()).and_then(|_| e.flush()), err_line.len()) };

        let body_text = if method == "HEAD" {
            format!("{TAG}-HEADBODY {path} {soak}")
        } else {
            format!("{MARKER} token={soak} path={path} printed stdout={so} stderr={se}\n")
        };
        let headers = Fields::new();
        let _ = headers.set(&"content-type".to_string(), &[b"text/plain".to_vec()]);
        let resp = OutgoingResponse::new(headers);
        let body = resp.body().unwrap();
        ResponseOutparam::set(out, Ok(resp));
        let os = body.write().unwrap();
        write_all(&os, body_text.as_bytes());
        os.blocking_flush().ok();
        drop(os);
        OutgoingBody::finish(body, None).ok();
    }
}

// blocking-write-and-flush takes at most 4096 bytes a call; go through check-write instead (as isolation/m2/app does)
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
