// The SOAK SENTINEL (SOAK-SENTINEL.md; enclave-87): a wasi:http proxy component, served in its partition by `wasmtime
// serve` like any catalog app on the hv tier, for the NucBox soak (windows/node/ops/hv-soak/soak.mjs). The soak asks
// `GET /hv-soak/<token>` with the same token in `x-hv-soak`; the token is random per sample and not a secret, and seeing
// it in the partition's console or in the node's or manager's log is a LEAK.
//   every request   PRINTS "<tag>-STDOUT-REQ <method> <path> <x-hv-soak>" to stdout and "<tag>-STDERR-REQ …" to stderr:
//                   a guest that gives the app the console (v40's domexec) puts the token on it; a fixed guest sends
//                   both to /dev/null.
//   GET (any path)  200 text/plain, the constant body "<marker>\n": the soak can tell THIS app answered.
//   HEAD (any path) 200, and it TRIES to send a body "<tag>-HEADBODY <path> <x-hv-soak>". wasmtime serve's HTTP server
//                   drops a HEAD body (SOAK-SENTINEL.md records what reached the wire), so a production app cannot
//                   reach the front's unsolicited-response guard this way; the canary's bundle/2 sentinel covers that.
// The tag and the marker are SOAK_TAG and SOAK_MARKER at build time: the bytes, and so the CID, are this build's own.
use wasi::http::types::{Fields, IncomingRequest, Method, OutgoingBody, OutgoingResponse, ResponseOutparam};
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
        println!("{TAG}-STDOUT-REQ {method} {path} {soak}");
        eprintln!("{TAG}-STDERR-REQ {method} {path} {soak}");

        let body_text = if method == "HEAD" { format!("{TAG}-HEADBODY {path} {soak}") } else { format!("{MARKER}\n") };
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
