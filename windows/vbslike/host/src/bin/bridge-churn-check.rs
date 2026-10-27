//! Isolated Hyper-V loopback regression: one resident control stream plus
//! 128 short request/reply streams must not exhaust completed-stream slots.
//! Usage: bridge-churn-check <shielded-bridge.exe> [unused vsock port]
#[path = "../hvsock.rs"]
#[allow(dead_code)]
mod hvsock;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};

const LOOPBACK: &str = "e0e16197-dd56-4a10-9195-5ee7a155a838";
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    let exe = args.get(1).ok_or("bridge executable required")?;
    let port: u32 = args.get(2).map(|s| s.parse()).transpose()?.unwrap_or(19979);
    let worker = TcpListener::bind("127.0.0.1:0")?;
    let wport = worker.local_addr()?.port();
    worker.set_nonblocking(true)?;
    let stop = Arc::new(AtomicBool::new(false));
    let worker_stop = stop.clone();
    let server = std::thread::spawn(move || {
        let mut handlers = Vec::new();
        while !worker_stop.load(Ordering::SeqCst) {
            match worker.accept() {
                Ok((mut c,_)) => handlers.push(std::thread::spawn(move || {
                    // Winsock inherits the listener's nonblocking mode.
                    let _ = c.set_nonblocking(false);
                    let _ = c.set_read_timeout(Some(Duration::from_secs(3)));
                    let mut byte=[0];
                    if c.read_exact(&mut byte).is_ok() { let _=c.write_all(&byte); }
                })),
                Err(e) if e.kind()==std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(1)),
                Err(_) => break,
            }
        }
        for handler in handlers { let _=handler.join(); }
    });
    let mut bridge = Command::new(exe).args([LOOPBACK,&port.to_string(),&wport.to_string(),"0"])
        .env("SHIELDED_BRIDGE_MAX_CONNS","64")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
    let start=Instant::now();
    let mut completed=0;
    let result=(|| -> Result<(),Box<dyn std::error::Error>> {
        let mut ready=String::new();
        BufReader::new(bridge.stdout.take().ok_or("stdout")?).read_line(&mut ready)?;
        if !ready.contains("shielded bridge ready") { return Err("bridge failed startup".into()); }
        let vm=hvsock::parse_guid(LOOPBACK).ok_or("guid")?;
        let _control=hvsock::dial(&vm,port,Duration::from_secs(3))?;
        for i in 0..128 {
            let mut client=hvsock::dial(&vm,port,Duration::from_secs(3))?;
            client.set_read_timeout(Some(Duration::from_secs(3)))?;
            client.write_all(&[i as u8])?;
            let mut byte=[0];client.read_exact(&mut byte)?;
            if byte[0]!=i as u8 { return Err("reply mismatch".into()); }
            completed+=1;
        }
        Ok(())
    })();
    let elapsed=start.elapsed().as_secs_f64();
    let _=bridge.kill();let _=bridge.wait();
    stop.store(true,Ordering::SeqCst);let _=server.join();
    println!("bridge churn: {completed}/128 replies; {elapsed:.3}s; {}",if result.is_ok(){"PASS"}else{"FAIL"});
    result
}
