// A LAB app: a wasi:cli command that serves HTTP on the port ENCLAVE_PORTS names (http:N=N) and PRINTS SENTINELS, so a
// lab can check whether anything an app writes reaches the host (isolation/m2/lab-release/run-output-check.sh).
// Every sentinel starts with the run's tag (SENTINEL_TAG, set at build time), so a leak is a grep, never a guess:
//   at start:     <tag>-STDOUT-START / <tag>-STDERR-START
//   per request:  <tag>-STDOUT-REQ <path> / <tag>-STDERR-REQ <path> (the request path is the tenant's data)
//   GET /panic…:  panics with <tag>-PANIC <path> (the runtime prints the panic and the trap on stderr)
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
        let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
        println!("{TAG}-STDOUT-REQ {path}");
        eprintln!("{TAG}-STDERR-REQ {path}");
        let _ = std::io::stdout().flush();
        if path.starts_with("/panic") {
            panic!("{TAG}-PANIC {path}");
        }
        let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok");
    }
}
