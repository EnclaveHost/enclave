//! sock-probe (PVM-CPU.md "Serving buyers"): the shape of the catalog's port-serving apps -- a wasi:cli/run component that
//! reads ENCLAVE_PORTS ("http:8000=<actual>", the platform's contract: bind the ACTUAL port) and serves HTTP/1.1 on it with
//! std::net (wasi:sockets). One connection at a time, keep-alive honoured, state kept in memory across requests (the
//! instance lives as long as the app):
//!   GET /ping            {"ok":true}
//!   GET /count           {"count":N}   (N counts the requests this instance has served: proof that state persists)
//!   GET /env             {"ports":"<ENCLAVE_PORTS>","mem":"<ENCLAVE_MEM_MB>"}
//!   GET /env?name=<N>    {"name":"<N>","value":"<its value>"|null}   (the deployment's config, hostnames, secrets)
//!   GET /dial?to=<h:p>   {"dial":"refused"|"connected"[,"reply":"<first line>"]}   (h a name or an address; on connect it
//!                        sends "ping\n" and reads one line back: outbound connects are the host's to allow)
//!   GET /resolve?name=<n> {"addrs":["<ip>",...]} or {"addrs":null}   (name lookup, the host's to answer)
//!   GET /bind?port=<p>   {"bind":"ok"|"refused"}          (a port other than its own is the host's to allow; the pVM refuses)
//!   POST /echo           the request body back
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};

fn port() -> u16 {
    let v = std::env::var("ENCLAVE_PORTS").unwrap_or_default();
    v.split(',').find_map(|e| e.strip_prefix("http:").and_then(|r| r.split('=').nth(1)).and_then(|p| p.parse().ok())).unwrap_or(8000)
}

fn json(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
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
            ("GET", "/env") if target.contains("name=") => {
                let name = target.split("name=").nth(1).unwrap_or("");
                let v = std::env::var(name).ok().map(|v| json(&v)).unwrap_or_else(|| "null".into());
                format!("{{\"name\":{},\"value\":{v}}}", json(name)).into_bytes()
            }
            ("GET", "/env") => format!("{{\"ports\":\"{}\",\"mem\":\"{}\"}}", std::env::var("ENCLAVE_PORTS").unwrap_or_default(),
                                       std::env::var("ENCLAVE_MEM_MB").unwrap_or_default()).into_bytes(),
            ("GET", "/dial") => {
                use std::net::ToSocketAddrs;
                let to = target.split("to=").nth(1).unwrap_or("1.1.1.1:443");
                let conn = to.to_socket_addrs().ok().and_then(|mut a| a.next()).and_then(|a| TcpStream::connect(a).ok());
                match conn {
                    Some(c) => {
                        let _ = (&c).write_all(b"ping\n");
                        let mut reply = String::new();
                        let _ = BufReader::new(&c).read_line(&mut reply);
                        format!("{{\"dial\":\"connected\",\"reply\":{}}}", json(reply.trim_end())).into_bytes()
                    }
                    None => b"{\"dial\":\"refused\"}".to_vec(),
                }
            }
            ("GET", "/resolve") => {
                use std::net::ToSocketAddrs;
                let name = target.split("name=").nth(1).unwrap_or("");
                match (name, 0u16).to_socket_addrs() {
                    Ok(a) => format!("{{\"addrs\":[{}]}}", a.map(|x| json(&x.ip().to_string())).collect::<Vec<_>>().join(",")).into_bytes(),
                    Err(_) => b"{\"addrs\":null}".to_vec(),
                }
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
