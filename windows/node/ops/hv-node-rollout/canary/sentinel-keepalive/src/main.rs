// A LAB app for the v41 canary's item 2 (CANARY-v41.md): a wasi:cli command that serves HTTP on the port ENCLAVE_PORTS
// names (http:N=N), PRINTS SENTINELS like isolation/m2/lab-release/sentinel-app, and on two paths answers the way that
// makes Go's net/http log the app's OWN bytes (the front's upstream client), which the front's console guard must turn
// into one class line ("DOM front: unsolicited upstream response (N bytes withheld)"), never the bytes:
//   GET  /extra…   200, Content-Length 2, body "ok" FOLLOWED by "<tag>-EXTRA <path>" (bytes after Content-Length)
//   HEAD /head…    200 with a body "<tag>-HEADBODY <path>" (a HEAD answered with a body)
// Neither answer says Connection: close, so the front's client keeps the connection and finds the extra bytes on it
// while it is idle. Every other request is answered 200 "ok" and closed, as the sentinel does.
// Every sentinel starts with the run's tag (SENTINEL_TAG, set at build time), so a leak is a grep, never a guess.
use std::io::{Read, Write};
use std::net::TcpListener;

const TAG: &str = env!("SENTINEL_TAG");

fn main() {
    println!("{TAG}-STDOUT-START");
    eprintln!("{TAG}-STDERR-START");
    let _ = std::io::stdout().flush();
    let port: u16 = std::env::var("ENCLAVE_PORTS").ok()
        .and_then(|v| v.split('=').last().and_then(|p| p.parse().ok()))
        .unwrap_or(8000);
    let l = TcpListener::bind(("127.0.0.1", port)).expect("bind");
    for s in l.incoming() {
        let Ok(mut s) = s else { continue };
        let mut buf = [0u8; 2048];
        let n = s.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        let mut words = req.split_whitespace();
        let method = words.next().unwrap_or("GET").to_string();
        let path = words.next().unwrap_or("/").to_string();
        println!("{TAG}-STDOUT-REQ {method} {path}");
        eprintln!("{TAG}-STDERR-REQ {method} {path}");
        let _ = std::io::stdout().flush();
        if method == "HEAD" && path.starts_with("/head") {
            let body = format!("{TAG}-HEADBODY {path}");
            let _ = s.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{body}", body.len()).as_bytes());
        } else if path.starts_with("/extra") {
            let _ = s.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok{TAG}-EXTRA {path}").as_bytes());
        } else {
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
        }
        let _ = s.flush();
    }
}
