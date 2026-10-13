//! Untrusted transport only: one Hyper-V partition to one loopback GPU worker.
//! The guest must mask and verify through ggml-shielded. This bridge does not
//! attest a GPU, admit a deployment, or accept addresses supplied by a guest.
#[path = "../hvsock.rs"]
mod hvsock;
use std::io;
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpStream};
use std::sync::{Arc, atomic::{AtomicUsize, AtomicBool, Ordering}};
use std::time::{Duration, Instant};

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
        if hvsock::guid_string(&peer) != hvsock::guid_string(&vm) || active.load(Ordering::SeqCst) >= 8 {
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
    // A supervised (persistent) bridge carries an app's long-lived streams: a guest that stops reading for a while (a
    // single-threaded app hashing what it already received) must not have its stream cut under it. A write timeout here
    // ended each 4 MiB download after ~2.9 MB with EOF (s3-ipfs-adapter, 2026-10-13); the stream ends when either side
    // closes, or when the supervisor stops the bridge. Timed (non-persistent) bridges keep both limits.
    for socket in [&guest, &worker] {
        socket.set_read_timeout(if persistent { None } else { Some(Duration::from_secs(60)) })?;
        socket.set_write_timeout(if persistent { None } else { Some(Duration::from_secs(60)) })?;
    }
    let mut gr = guest.try_clone()?;
    let mut ww = worker.try_clone()?;
    // Each direction ends with a HALF-close of the other side's write, never a shutdown(Both) or a close: the worker
    // (shield-egress) receives a whole 4 MiB reply from the internet in a second or two and closes, while the guest is
    // still reading it slowly (wasm TLS, hashing). Shutting the hv_sock down at that moment discarded everything it
    // still held for the guest - each 4 MiB GET of s3-ipfs-adapter ended after ~2.8 MB, the same count every time
    // (2026-10-13, after the write timeout above was already gone). A half-close delivers the queued bytes, then EOF.
    let (finished, upstream_done) = std::sync::mpsc::channel::<()>();
    let upstream = std::thread::spawn(move || {
        let result = io::copy(&mut gr, &mut ww);
        let _ = ww.shutdown(Shutdown::Write);
        let _ = finished.send(());
        result
    });
    let result = io::copy(&mut worker, &mut guest);
    let _ = guest.shutdown(Shutdown::Write);
    // The guest closes once it has read the rest (the upstream copy then ends); one that never does is cut after a
    // bounded wait (a read timeout set now would not reach the read already blocked), so it cannot hold one of the
    // bridge's 8 connection slots for good.
    let _ = upstream_done.recv_timeout(Duration::from_secs(120));
    let _ = guest.shutdown(Shutdown::Both);
    let up = upstream.join().unwrap_or_else(|_| Err(io::Error::other("relay thread panicked")));
    let _ = worker.shutdown(Shutdown::Both);
    // A big stream says how much it carried even when it ended cleanly (2026-10-13: a 4 MiB reply cut at ~3 MB left no
    // error anywhere on the host): what was written into the guest's hv_sock, against what shield-egress logs it got.
    if persistent {
        if let (Ok(g2w), Ok(w2g)) = (&up, &result) {
            if *w2g >= 1 << 20 { eprintln!("shielded bridge stream ended: guest->worker {g2w} B, worker->guest {w2g} B"); }
        }
    }
    // A stream that ended in an error says which way and how (the manager logs it): a cut download was invisible.
    if up.is_err() || result.is_err() {
        let said = |r: &io::Result<u64>| match r {
            Ok(n) => format!("ended after {n} B"),
            Err(e) => format!("{e} ({:?})", e.kind()),
        };
        return Err(io::Error::other(format!("guest->worker {}; worker->guest {}", said(&up), said(&result))));
    }
    Ok(())
}
