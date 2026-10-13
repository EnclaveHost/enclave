//! A box-run check of shielded-bridge's end of stream, over Hyper-V socket LOOPBACK (no partition needed):
//!   bridge-drain-check <shielded-bridge.exe> [vsock port]
//! A local "worker" sends 4 MiB at once and closes - as shield-egress does with an internet reply - while the client
//! reads it slowly through the bridge, as a guest app does. Every byte must arrive (2026-10-13: the bridge's
//! shutdown(Both) at the worker's close discarded what the hv_sock still held, ~1.3 MB of every 4 MiB).
#[path = "../hvsock.rs"]
#[allow(dead_code)]
mod hvsock;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const LOOPBACK: &str = "e0e16197-dd56-4a10-9195-5ee7a155a838";
const SIZE: usize = 4 * 1024 * 1024;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let a: Vec<String> = std::env::args().collect();
    let exe = a.get(1).ok_or("usage: bridge-drain-check <shielded-bridge.exe> [vsock port]")?;
    let port: u32 = a.get(2).map(|p| p.parse()).transpose()?.unwrap_or(9977);
    let worker = TcpListener::bind("127.0.0.1:0")?;
    let wport = worker.local_addr()?.port();
    std::thread::spawn(move || {
        if let Ok((mut c, _)) = worker.accept() {
            let body: Vec<u8> = (0..SIZE).map(|i| (i % 251) as u8).collect();
            let _ = c.write_all(&body);
        } // dropped: the worker closes right after its last byte
    });
    let mut bridge = Command::new(exe).args([LOOPBACK, &port.to_string(), &wport.to_string(), "0"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()?;
    let mut ready = String::new();
    BufReader::new(bridge.stdout.take().ok_or("no stdout")?).read_line(&mut ready)?;
    print!("bridge: {ready}");
    let vm = hvsock::parse_guid(LOOPBACK).ok_or("guid")?;
    let mut s = hvsock::dial(&vm, port, Duration::from_secs(5))?;
    let (start, mut got, mut buf, mut bad) = (Instant::now(), 0usize, vec![0u8; 64 * 1024], false);
    loop {
        std::thread::sleep(Duration::from_millis(40)); // a slow reader: ~1.6 MB/s at most
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                bad |= buf[..n].iter().enumerate().any(|(k, b)| *b != ((got + k) % 251) as u8);
                got += n;
            }
            Err(e) => { println!("read error after {got} bytes: {e}"); break; }
        }
    }
    let _ = bridge.kill();
    println!("received {got} of {SIZE} bytes in {:.1}s{}: {}", start.elapsed().as_secs_f64(),
             if bad { ", CORRUPT" } else { "" }, if got == SIZE && !bad { "PASS" } else { "FAIL" });
    std::process::exit(if got == SIZE && !bad { 0 } else { 1 });
}
