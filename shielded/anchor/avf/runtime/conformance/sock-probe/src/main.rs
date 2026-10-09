//! sock-probe (PVM-CPU.md "Serving buyers"): the shape of the catalog's port-serving apps -- a wasi:cli/run component that
//! reads ENCLAVE_PORTS ("http:8000=<actual>", the platform's contract: bind the ACTUAL port) and serves HTTP/1.1 on it with
//! std::net (wasi:sockets). One connection at a time, keep-alive honoured, state kept in memory across requests (the
//! instance lives as long as the app):
//!   GET /ping            {"ok":true}
//!   GET /count           {"count":N}   (N counts the requests this instance has served: proof that state persists)
//!   GET /env             {"ports":"<ENCLAVE_PORTS>","mem":"<ENCLAVE_MEM_MB>"}
//!   GET /dial?to=<a:p>   {"dial":"refused"|"connected"}   (outbound connects are the host's to allow; the pVM refuses)
//!   GET /bind?port=<p>   {"bind":"ok"|"refused"}          (a port other than its own is the host's to allow; the pVM refuses)
//!   POST /echo           the request body back
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};

fn port() -> u16 {
    let v = std::env::var("ENCLAVE_PORTS").unwrap_or_default();
    v.split(',').find_map(|e| e.strip_prefix("http:").and_then(|r| r.split('=').nth(1)).and_then(|p| p.parse().ok())).unwrap_or(8000)
}

fn respond(mut s: &TcpStream, status: &str, body: &[u8], close: bool) -> std::io::Result<()> {
    write!(s, "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n{}\r\n", body.len(),
           if close { "connection: close\r\n" } else { "" })?;
    s.write_all(body)?;
    s.flush()
}

fn serve(stream: TcpStream, count: &mut u64) -> std::io::Result<()> {
    // one stream read and written through shared references (wasip2 has no socket dup: try_clone is unsupported)
    let mut r = BufReader::new(&stream);
    let w = &stream;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line)? == 0 { return Ok(()); }
        let mut parts = line.split_whitespace();
        let (method, target) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("/").to_string());
        let (mut len, mut close) = (0usize, false);
        loop {
            let mut h = String::new();
            if r.read_line(&mut h)? == 0 { return Ok(()); }
            let h = h.trim_end();
            if h.is_empty() { break; }
            let lower = h.to_ascii_lowercase();
            if let Some(v) = lower.strip_prefix("content-length:") { len = v.trim().parse().unwrap_or(0).min(1 << 20); }
            if lower.starts_with("connection:") && lower.contains("close") { close = true; }
        }
        let mut body = vec![0u8; len];
        r.read_exact(&mut body)?;
        *count += 1;
        let path = target.split('?').next().unwrap_or("/");
        let out = match (method.as_str(), path) {
            ("GET", "/ping") => b"{\"ok\":true}".to_vec(),
            ("GET", "/count") => format!("{{\"count\":{count}}}").into_bytes(),
            ("GET", "/env") => format!("{{\"ports\":\"{}\",\"mem\":\"{}\"}}", std::env::var("ENCLAVE_PORTS").unwrap_or_default(),
                                       std::env::var("ENCLAVE_MEM_MB").unwrap_or_default()).into_bytes(),
            ("GET", "/dial") => {
                let to = target.split("to=").nth(1).unwrap_or("1.1.1.1:443");
                let ok = to.parse::<std::net::SocketAddr>().ok().map(|a| TcpStream::connect(a).is_ok()).unwrap_or(false);
                format!("{{\"dial\":\"{}\"}}", if ok { "connected" } else { "refused" }).into_bytes()
            }
            ("GET", "/bind") => {
                let p: u16 = target.split("port=").nth(1).and_then(|x| x.parse().ok()).unwrap_or(0);
                format!("{{\"bind\":\"{}\"}}", if TcpListener::bind(("0.0.0.0", p)).is_ok() { "ok" } else { "refused" }).into_bytes()
            }
            ("POST", "/echo") => body,
            _ => { respond(w, "404 Not Found", b"{\"error\":\"not_found\"}", close)?; if close { return Ok(()); } continue; }
        };
        respond(w, "200 OK", &out, close)?;
        if close { return Ok(()); }
    }
}

fn main() {
    let listener = TcpListener::bind(("0.0.0.0", port())).expect("bind");
    eprintln!("sock-probe listening on {}", port());
    let mut count = 0u64;
    for s in listener.incoming() {
        if let Ok(s) = s { let _ = serve(s, &mut count); }
    }
}
