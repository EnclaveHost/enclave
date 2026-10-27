// Byte relay shared with the Hyper-V bridge. No GPU trust or admission logic.
use std::io;
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpStream};
use std::sync::{Arc, atomic::Ordering};
use std::time::{Duration, Instant};

pub(crate) fn relay(mut guest: TcpStream, port: u16, persistent: bool, auth: Option<&[u8]>) -> io::Result<()> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut worker = TcpStream::connect_timeout(&addr, Duration::from_secs(3))?;
    worker.set_nodelay(true)?;
    // the worker admits this connection only on the credential, which therefore precedes every guest byte
    if let Some(line) = auth {
        use std::io::Write;
        worker.write_all(line)?;
    }
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
    // Once the guest has closed its side, a peer that never closes (a Sia host keeps an idle mux connection open
    // indefinitely) would hold this stream, and one of the bridge's slots, for good: persistent streams have no read
    // timeout. So after the guest's half-close, a stream that carries nothing toward the guest for HALF_CLOSED_IDLE is
    // shut. Bytes still flowing (a slow download the guest already asked for) keep resetting the clock.
    const HALF_CLOSED_IDLE: Duration = Duration::from_secs(120);
    let started = Instant::now();
    let last_down = Arc::new(std::sync::atomic::AtomicU64::new(0)); // ms since `started` of the last byte to the guest
    let (down_finished, down_done) = std::sync::mpsc::channel::<()>();
    let last_down_w = last_down.clone();
    let upstream = std::thread::spawn(move || {
        let result = io::copy(&mut gr, &mut ww);
        let _ = ww.shutdown(Shutdown::Write);
        let _ = finished.send(());
        if persistent {
            loop {
                // Wake as soon as the downstream copy finishes. Sleeping
                // here held an already-closed stream's admission slot for
                // five seconds, exhausting a 64-slot bridge after 63 short
                // compute requests alongside its persistent control stream.
                match down_done.recv_timeout(Duration::from_secs(5)) {
                    Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                }
                let idle = started.elapsed().saturating_sub(Duration::from_millis(last_down_w.load(Ordering::SeqCst)));
                if idle >= HALF_CLOSED_IDLE {
                    // unblocks the read below; the guest side was already finished writing
                    let _ = ww.shutdown(Shutdown::Both);
                    break;
                }
            }
        }
        result
    });
    let result = (|| -> io::Result<u64> {
        use std::io::{Read, Write};
        let mut buf = vec![0u8; 64 << 10];
        let mut total = 0u64;
        loop {
            let n = match worker.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            };
            last_down.store(started.elapsed().as_millis() as u64, Ordering::SeqCst);
            guest.write_all(&buf[..n])?;
            total += n as u64;
        }
        Ok(total)
    })();
    let _ = down_finished.send(());
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    fn run_fixture(size: usize, slow: bool, auth: Option<&'static [u8]>) {
        let worker = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = worker.local_addr().unwrap().port();
        let worker_thread = std::thread::spawn(move || {
            let (mut c, _) = worker.accept().unwrap();
            c.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
            if let Some(line) = auth {
                let mut got = vec![0; line.len()];
                c.read_exact(&mut got).unwrap();
                assert_eq!(got, line);
            }
            let mut input = Vec::new();
            c.read_to_end(&mut input).unwrap();
            assert_eq!(input, b"request");
            let body: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            c.write_all(&body).unwrap();
        });
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let (guest, _) = listener.accept().unwrap();
        let (done, completed) = mpsc::channel();
        let bridge = std::thread::spawn(move || { done.send(relay(guest,port,true,auth)).unwrap(); });
        client.write_all(b"request").unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let mut body = Vec::new();
        let mut chunk = [0u8; 64*1024];
        loop {
            let n = client.read(&mut chunk).unwrap();
            if n == 0 { break; }
            body.extend_from_slice(&chunk[..n]);
            if slow { std::thread::sleep(Duration::from_millis(5)); }
        }
        assert_eq!(body.len(),size);
        assert!(body.iter().enumerate().all(|(i,b)| *b==(i%251) as u8));
        // Completed streams must not occupy slots for the old five-second
        // polling interval. A retained control stream + 63 such closes filled
        // the bridge's 64-slot cap during rapid graph RPCs.
        completed.recv_timeout(Duration::from_secs(1))
            .expect("completed relay retained its connection slot").unwrap();
        bridge.join().unwrap();
        worker_thread.join().unwrap();
    }

    #[test]
    fn completed_stream_releases_slot_promptly() { run_fixture(16,false,None); }

    #[test]
    fn half_closed_guest_still_receives_entire_slow_reply() { run_fixture(4*1024*1024,true,None); }

    #[test]
    fn credential_precedes_request_and_short_connections_can_repeat() {
        for _ in 0..80 { run_fixture(32,false,Some(b"public-test-credential\n")); }
    }
}
