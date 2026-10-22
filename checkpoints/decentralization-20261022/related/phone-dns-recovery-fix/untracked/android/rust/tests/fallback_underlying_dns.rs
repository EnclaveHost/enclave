//! The 2026-10-20 phone incident: EnclaveDNS (the default upstream) became
//! unreachable, and every lookup on the phone failed although the fallback
//! (the network's own DNS) was on. The app had reported the VPN's OWN DNS
//! servers ("10.53.0.1,fd53::1") as the network's, because Android answered
//! its default-network callback with the VPN. The engine's sockets bypass
//! the VPN, so the fallback asked 10.53.0.1 on the real network and nothing
//! ever answered.
//!
//! Here, through the same user-space stack the app uses: the VPN's own
//! servers are refused as fallback servers; with the underlying network's
//! server known, a lookup is answered while EnclaveDNS is down; strict
//! (fallback off) still never asks the network's DNS.

use enclavedns_android::{android_config, serve_device, system_dns_from, DNS_V4};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// An EnclaveDNS that cannot be reached: nothing listens on port 9.
const DEAD_UPSTREAM: &str = "upstream = \"https://127.0.0.1:9\"\n";
const ANSWER: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 7);

fn checksum(b: &[u8]) -> u16 {
    let mut s: u32 = 0;
    for c in b.chunks(2) {
        s += u16::from_be_bytes([c[0], *c.get(1).unwrap_or(&0)]) as u32;
    }
    while s > 0xffff {
        s = (s & 0xffff) + (s >> 16);
    }
    !(s as u16)
}

fn udp_packet(src: Ipv4Addr, sport: u16, dst: Ipv4Addr, dport: u16, payload: &[u8]) -> Vec<u8> {
    let total = 20 + 8 + payload.len();
    let mut ip = vec![0x45, 0, (total >> 8) as u8, total as u8, 0, 1, 0x40, 0, 64, 17, 0, 0];
    ip.extend_from_slice(&src.octets());
    ip.extend_from_slice(&dst.octets());
    let c = checksum(&ip);
    ip[10..12].copy_from_slice(&c.to_be_bytes());
    let ulen = (8 + payload.len()) as u16;
    let mut udp = Vec::new();
    udp.extend_from_slice(&sport.to_be_bytes());
    udp.extend_from_slice(&dport.to_be_bytes());
    udp.extend_from_slice(&ulen.to_be_bytes());
    udp.extend_from_slice(&[0, 0]);
    udp.extend_from_slice(payload);
    let mut ph = Vec::new();
    ph.extend_from_slice(&src.octets());
    ph.extend_from_slice(&dst.octets());
    ph.extend_from_slice(&[0, 17]);
    ph.extend_from_slice(&ulen.to_be_bytes());
    ph.extend_from_slice(&udp);
    let c = checksum(&ph);
    udp[6..8].copy_from_slice(&c.to_be_bytes());
    ip.extend_from_slice(&udp);
    ip
}

fn dns_query(id: u16, name: &str) -> Vec<u8> {
    let mut q = id.to_be_bytes().to_vec();
    q.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
    for l in name.split('.') {
        q.push(l.len() as u8);
        q.extend_from_slice(l.as_bytes());
    }
    q.extend_from_slice(&[0, 0, 1, 0, 1]);
    q
}

/// The underlying network's DNS server: answers every A question with ANSWER
/// and counts the questions it was asked.
async fn network_dns() -> (SocketAddr, Arc<AtomicUsize>) {
    let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let addr = sock.local_addr().unwrap();
    let asked = Arc::new(AtomicUsize::new(0));
    let n = asked.clone();
    tokio::spawn(async move {
        let mut buf = vec![0u8; 2048];
        loop {
            let Ok((len, from)) = sock.recv_from(&mut buf).await else { return };
            n.fetch_add(1, Ordering::SeqCst);
            let q = &buf[..len];
            let mut r = q.to_vec();
            r[2] = 0x81; // QR, RD
            r[3] = 0x80; // RA, NOERROR
            r[6..8].copy_from_slice(&1u16.to_be_bytes()); // one answer
            r[8..12].copy_from_slice(&[0, 0, 0, 0]);
            r.truncate(12 + (len - 12)); // the question as asked (no EDNS in these queries)
            r.extend_from_slice(&[0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4]);
            r.extend_from_slice(&ANSWER.octets());
            let _ = sock.send_to(&r, from).await;
        }
    });
    (addr, asked)
}

/// One lookup through the VPN device: the DNS answer the phone's app gets.
async fn lookup_via_vpn(engine: Arc<enclavedns_core::Engine>, name: &str) -> Vec<u8> {
    let (mut phone, device) = tokio::io::duplex(65536);
    let (_stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(serve_device(engine, device, stop_rx));
    let client = Ipv4Addr::new(10, 53, 0, 2);
    phone
        .write_all(&udp_packet(client, 40001, DNS_V4, 53, &dns_query(0x4242, name)))
        .await
        .unwrap();
    let mut buf = vec![0u8; 2048];
    let n = tokio::time::timeout(std::time::Duration::from_secs(20), phone.read(&mut buf))
        .await
        .expect("an answer packet")
        .unwrap();
    let r = &buf[..n];
    assert_eq!(&r[12..16], &DNS_V4.octets(), "from the VPN's DNS address");
    r[28..].to_vec()
}

fn state_dir(tag: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("enclavedns-fallback-{tag}-{}", std::process::id()))
}

#[test]
fn the_vpns_own_servers_are_never_the_networks() {
    // what the phone reported (dumpsys: tun0 DnsAddresses [10.53.0.1, fd53::1])
    assert!(system_dns_from("10.53.0.1,fd53::1").is_empty());
    // the same with scopes, the gateway, the VPN's own client addresses, loopback, unspecified, link-local
    assert!(system_dns_from("10.53.0.3, 10.53.0.2,fd53::2,fd53::1%tun0,127.0.0.1,::1,0.0.0.0,fe80::1%wlan0,junk,").is_empty());
    // the underlying Wi-Fi's server (dumpsys: wlan0 DnsAddresses [192.168.88.1]) is kept, once, in order
    let v = system_dns_from("192.168.88.1, 10.53.0.1, 2001:db8::53%wlan0, 192.168.88.1");
    assert_eq!(v, vec!["192.168.88.1:53".parse().unwrap(), "[2001:db8::53]:53".parse().unwrap()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn with_enclavedns_down_the_networks_dns_answers() {
    let (server, asked) = network_dns().await;
    let dir = state_dir("open");
    let engine = enclavedns_core::Engine::new(android_config(DEAD_UPSTREAM).unwrap(), &dir).unwrap();
    // the incident: only the VPN's own servers reported -> nothing usable is set
    engine.up.set_system_dns(system_dns_from("10.53.0.1,fd53::1"));
    assert!(engine.up.system_dns().is_empty(), "the VPN's own servers must not become the fallback");
    // the fixed app reports the underlying network's server (a local stand-in here)
    engine.up.set_system_dns(vec![server]);
    let dns = lookup_via_vpn(engine, "api.enclave.host").await;
    assert_eq!(u16::from_be_bytes([dns[0], dns[1]]), 0x4242, "same DNS id");
    assert_eq!(dns[3] & 0x0f, 0, "NOERROR from the network's DNS");
    assert_eq!(&dns[dns.len() - 4..], &ANSWER.octets(), "the network's answer");
    assert!(asked.load(Ordering::SeqCst) >= 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn strict_never_asks_the_networks_dns() {
    let (server, asked) = network_dns().await;
    let dir = state_dir("strict");
    let cfg = format!("{DEAD_UPSTREAM}strict = true\n");
    let engine = enclavedns_core::Engine::new(android_config(&cfg).unwrap(), &dir).unwrap();
    engine.up.set_system_dns(vec![server]);
    let dns = lookup_via_vpn(engine, "api.enclave.host").await;
    assert_eq!(dns[3] & 0x0f, 2, "SERVFAIL: EnclaveDNS only, as configured");
    assert_eq!(asked.load(Ordering::SeqCst), 0, "strict sent nothing to the network's DNS");
    let _ = std::fs::remove_dir_all(&dir);
}
