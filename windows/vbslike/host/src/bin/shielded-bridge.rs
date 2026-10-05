//! Untrusted transport only: one Hyper-V partition to one loopback GPU worker.
//! The guest must mask and verify through ggml-shielded. This bridge does not
//! attest a GPU, admit a deployment, or accept addresses supplied by a guest.
#[path = "../hvsock.rs"]
mod hvsock;
use std::io;
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpStream};
use std::sync::{Arc, atomic::{AtomicUsize, AtomicBool, Ordering}};
use std::time::{Duration, Instant};

// Streams one partition may hold open at once; the next is closed at accept. A public-web egress partition (a desktop's
// browser: several connections per site, and a DNS lookup is a stream too) needs far more than the 8 a GPU worker did.
const MAX_STREAMS: usize = 64;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 5 {
        return Err("usage: shielded-bridge <partition GUID> <vsock port> <loopback worker port> <lifetime seconds>".into());
    }
    let vm = hvsock::parse_guid(&a[1]).ok_or("invalid partition GUID")?;
    if hvsock::guid_string(&vm) == "00000000-0000-0000-0000-000000000000" {
        return Err("wildcard partition is forbidden".into());
    }
    let port: u32 = a[2].parse()?;
    let worker: u16 = a[3].parse()?;
    let seconds: u64 = a[4].parse()?;
    if port == 0 || worker == 0 || seconds > 86400 {
        return Err("nonzero ports and lifetime 0..86400 required (0: supervised stdin)".into());
    }
    let listener = hvsock::Listener::bind(&vm, port)?;
    let stopped = Arc::new(AtomicBool::new(false));
    if seconds == 0 {
        let stop = stopped.clone();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut b = [0u8; 1];
            let _ = std::io::stdin().read(&mut b);
            stop.store(true, Ordering::SeqCst);
        });
    }
    let end = Instant::now() + Duration::from_secs(seconds);
    let active = Arc::new(AtomicUsize::new(0));
    println!("shielded bridge ready vm={} port={} worker=127.0.0.1:{}", a[1], port, worker);
    while !stopped.load(Ordering::SeqCst) && (seconds == 0 || Instant::now() < end) {
        let Some((guest, peer)) = listener.accept_timeout(500)? else { continue };
        if hvsock::guid_string(&peer) != hvsock::guid_string(&vm) || active.load(Ordering::SeqCst) >= MAX_STREAMS {
            let _ = guest.shutdown(Shutdown::Both);
            continue;
        }
        let active = active.clone();
        active.fetch_add(1, Ordering::SeqCst);
        std::thread::spawn(move || {
            if let Err(e) = relay(guest, worker, seconds == 0) { eprintln!("shielded bridge connection ended: {e}"); }
            active.fetch_sub(1, Ordering::SeqCst);
        });
    }
    // This executable is supervised per partition; process exit also closes
    // active sockets. Nothing persists beyond the explicit lifetime.
    Ok(())
}

fn relay(mut guest: TcpStream, port: u16, persistent: bool) -> io::Result<()> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut worker = TcpStream::connect_timeout(&addr, Duration::from_secs(3))?;
    worker.set_nodelay(true)?;
    for socket in [&guest, &worker] {
        socket.set_read_timeout(if persistent { None } else { Some(Duration::from_secs(60)) })?;
        socket.set_write_timeout(Some(Duration::from_secs(60)))?;
    }
    let mut gr = guest.try_clone()?;
    let mut ww = worker.try_clone()?;
    let upstream = std::thread::spawn(move || {
        let result = io::copy(&mut gr, &mut ww);
        let _ = gr.shutdown(Shutdown::Both);
        let _ = ww.shutdown(Shutdown::Both);
        result
    });
    let result = io::copy(&mut worker, &mut guest);
    let _ = guest.shutdown(Shutdown::Both);
    let _ = worker.shutdown(Shutdown::Both);
    let _ = upstream.join();
    result.map(|_| ())
}
