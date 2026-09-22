// A server inside an enclave: bind, accept, answer. Nothing else.
//
// std's TcpListener maps to wasi:sockets on the wasm32-wasip2 target, which is exactly the path the
// real apps take, so if this works in VTL1 the broker works.
use std::io::{Read, Write};
use std::net::TcpListener;

fn main() {
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => { eprintln!("bind {port} failed: {e}"); std::process::exit(2); }
    };
    let who = std::env::var("WHO").unwrap_or_else(|_| String::from("an enclave"));
    eprintln!("listening on {:?}", listener.local_addr());
    // The real apps (the s3-ipfs-adapter among them) put their listener and every accepted stream
    // into non-blocking mode and DROP a connection whose set_nonblocking fails. Report it, because
    // a silent failure here looks exactly like an app that accepts and hangs up.
    eprintln!("listener set_nonblocking -> {:?}", listener.set_nonblocking(true));
    let mut served = 0u64;
    for stream in listener.incoming() {
        let mut s = match stream {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(20));
                continue;
            }
            Err(e) => { eprintln!("accept: {e}"); continue }
        };
        // Exactly what the real apps do: the accepted stream goes non-blocking and the loop reads
        // until WouldBlock. The question this answers is what a read with NO DATA YET reports -
        // WouldBlock (correct) or Ok(0), which every one of those apps treats as "peer gone".
        eprintln!("stream set_nonblocking -> {:?}", s.set_nonblocking(true));
        // One read is enough for a test: a request line and its headers arrive in one segment from
        // a local proxy, and this is not trying to be an HTTP server.
        let mut buf = [0u8; 4096];
        let mut n = 0usize;
        for attempt in 0..200 {
            match s.read(&mut buf[n..]) {
                Ok(0) => { eprintln!("READ RETURNED Ok(0) on attempt {attempt} with {n} bytes so far"); break; }
                Ok(k) => { n += k; eprintln!("read {k} bytes (total {n})"); break; }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if attempt == 0 { eprintln!("read -> WouldBlock (correct: no data yet)"); }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(e) => { eprintln!("read error: {e}"); break; }
            }
        }
        let head = String::from_utf8_lossy(&buf[..n]);
        let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
        served += 1;
        let body = format!("hello from {who}: {path} (request {served})\n");
        let resp = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nx-runs-in: vtl1\r\nconnection: close\r\n\r\n{}",
            body.len(), body);
        let _ = s.write_all(resp.as_bytes());
        let _ = s.flush();
        eprintln!("served {path}");
    }
}
