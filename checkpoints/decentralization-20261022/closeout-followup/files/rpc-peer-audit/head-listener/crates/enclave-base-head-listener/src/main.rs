//! `enclave-base-head-listener`: a bounded Base unsafe-block gossip listener.
//!
//! `listen` joins the Base mainnet consensus gossip network through the
//! maintained `base-consensus-gossip` driver, keeps only envelopes accepted by
//! its `block_valid`, writes each as an immutable content-addressed object and
//! prints one JSON line per head (schema `enclave-base-unsafe-head/v1`).
//! `verify-object` re-checks a stored object against a pinned signer.
//!
//! Safety properties: the gossip listener binds loopback only; the libp2p key is
//! ephemeral and never written; no bootstore file is used; peers, duration and
//! output bytes are hard-capped; nothing is ever published.

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::Write,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    process::ExitCode,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use alloy_primitives::Address;
use base_common_chains::ChainConfig;
use base_consensus_disc::{Discv5Builder, LocalNode};
use base_consensus_gossip::{
    ConnectionGate, ConnectionGater, ConnectionLimitsConfig, Event as GossipEvent,
    GATER_PRUNE_INTERVAL, GossipDriver, GossipDriverBuilder, PENDING_DIAL_PRUNE_INTERVAL,
};
use base_consensus_peers::{BootNode, BootNodes, EnrValidation, PeerUtils};
use clap::{Args, Parser, Subcommand, ValueEnum};
use enclave_base_head_listener::{
    BASE_SOURCE_COMMIT, DialQueue, HeadRecord, OBJECT_ENCODING, ObjectStore, SCHEMA, StoreOutcome,
    classify_dial_error, encode_object, object_sha256, verify_object,
};
use libp2p::{
    Multiaddr, PeerId, gossipsub, gossipsub::TopicHash, identify, identity::Keypair,
    swarm::SwarmEvent,
};
use serde_json::json;
use tokio::time::Instant;

const MAX_DURATION_SECS: u64 = 3600;
const MAX_PEERS: u32 = 50;
/// Total outbound dial cap per run (root-authorized bound).
const MAX_TOTAL_DIALS: u32 = 200;
/// Simultaneous in-flight dials (the driver's own pending-outbound limit is 16).
const MAX_IN_FLIGHT: usize = 8;
/// A dial with no connection/error event after this is treated as dropped.
const DIAL_IN_FLIGHT_TTL: Duration = Duration::from_secs(35);
/// Distinct candidate peers kept for dialing.
const MAX_QUEUE: usize = 1024;
/// Distinct agent product names reported before folding into "(other)".
const MAX_AGENT_BUCKETS: usize = 20;
/// Progress record interval.
const PROGRESS_EVERY_SECS: u64 = 20;
const MAX_OBJECT_FILE_BYTES: u64 = 16 << 20;

#[derive(Debug, Parser)]
#[command(version, about = "Bounded Base unsafe-head gossip listener")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Debug, Subcommand)]
enum Cmd {
    /// Listen to Base mainnet unsafe-block gossip for a bounded time.
    Listen(ListenArgs),
    /// Re-check a stored envelope object against a pinned signer.
    VerifyObject(VerifyArgs),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
enum Discovery {
    /// Dial only the published consensus bootnodes.
    Off,
    /// Also run discv5 (in-memory table only) if no peer connected after the grace period.
    Bounded,
}

#[derive(Debug, Args)]
struct ListenArgs {
    /// Administrator-pinned unsafe block signer. There is no implicit default;
    /// a rotation requires restarting with the new pin.
    #[arg(long)]
    signer: Address,
    /// Run time in seconds (1..=3600).
    #[arg(long, default_value_t = 60)]
    duration_secs: u64,
    /// Maximum established gossip connections (1..=50).
    #[arg(long, default_value_t = 20)]
    max_peers: u32,
    /// Hard budget for objects plus stdout records, in bytes.
    #[arg(long, default_value_t = 64 << 20)]
    max_output_bytes: u64,
    /// Output directory; objects are written to `<out-dir>/objects`, which must be empty.
    #[arg(long)]
    out_dir: PathBuf,
    /// Gossip TCP listen address. Must be a loopback address.
    #[arg(long, default_value = "127.0.0.1:0")]
    listen: SocketAddr,
    /// Peer discovery mode.
    #[arg(long, value_enum, default_value_t = Discovery::Off)]
    discovery: Discovery,
    /// Seconds without any connected peer before bounded discovery starts.
    #[arg(long, default_value_t = 15)]
    discovery_after_secs: u64,
}

#[derive(Debug, Args)]
struct VerifyArgs {
    /// Administrator-pinned unsafe block signer.
    #[arg(long)]
    signer: Address,
    /// Object file (`<sha256>.v4.snappy`).
    #[arg(long)]
    file: PathBuf,
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or_default()
}

fn emit(store: &mut ObjectStore, value: &serde_json::Value) -> bool {
    let line = value.to_string();
    if !store.charge(line.len() as u64 + 1) {
        return false;
    }
    let mut out = std::io::stdout().lock();
    writeln!(out, "{line}").and_then(|()| out.flush()).is_ok()
}

fn validate(args: &ListenArgs) -> Result<(), String> {
    if !(1..=MAX_DURATION_SECS).contains(&args.duration_secs) {
        return Err(format!("--duration-secs must be 1..={MAX_DURATION_SECS}"));
    }
    if !(1..=MAX_PEERS).contains(&args.max_peers) {
        return Err(format!("--max-peers must be 1..={MAX_PEERS}"));
    }
    if !args.listen.ip().is_loopback() {
        return Err("--listen must be a loopback address".to_owned());
    }
    if !matches!(args.listen.ip(), IpAddr::V4(_)) {
        return Err("--listen must be IPv4 loopback".to_owned());
    }
    Ok(())
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();
    match cli.cmd {
        Cmd::Listen(args) => {
            if let Err(e) = validate(&args) {
                eprintln!("error: {e}");
                return ExitCode::from(2);
            }
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("error: runtime: {e}");
                    return ExitCode::from(2);
                }
            };
            match runtime.block_on(listen(args)) {
                Ok(0) => ExitCode::from(3),
                Ok(_) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("error: {e}");
                    ExitCode::from(1)
                }
            }
        }
        Cmd::VerifyObject(args) => verify(&args),
    }
}

fn verify(args: &VerifyArgs) -> ExitCode {
    let bytes = match std::fs::metadata(&args.file) {
        Ok(m) if m.len() <= MAX_OBJECT_FILE_BYTES => std::fs::read(&args.file),
        Ok(_) => Err(std::io::Error::other("object file too large")),
        Err(e) => Err(e),
    };
    let bytes = match bytes {
        Ok(b) => b,
        Err(e) => {
            println!("{}", json!({"schema": SCHEMA, "type": "verify", "ok": false, "error": e.to_string()}));
            return ExitCode::from(1);
        }
    };
    let rollup = ChainConfig::mainnet().rollup_config();
    match verify_object(&bytes, &rollup, args.signer) {
        Ok(env) => {
            let v1 = env.payload.as_v1();
            println!(
                "{}",
                json!({
                    "schema": SCHEMA, "type": "verify", "ok": true, "tier": "unsafe",
                    "finality": "none", "signer": args.signer, "number": v1.block_number,
                    "hash": v1.block_hash, "stateRoot": v1.state_root,
                    "objectSha256": object_sha256(&bytes),
                })
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            println!("{}", json!({"schema": SCHEMA, "type": "verify", "ok": false, "error": e.to_string()}));
            ExitCode::from(1)
        }
    }
}

async fn listen(args: ListenArgs) -> Result<u64, String> {
    let chain = ChainConfig::mainnet();
    let rollup = chain.rollup_config();
    let chain_id = rollup.l2_chain_id.id();
    let mut store = ObjectStore::create(&args.out_dir.join("objects"), args.max_output_bytes)
        .map_err(|e| e.to_string())?;

    let start = json!({
        "schema": SCHEMA, "type": "start", "chainId": chain_id,
        "signer": args.signer, "signerSource": "admin-pin",
        "chainConfigDefaultSigner": chain.unsafe_block_signer,
        "signerMatchesChainDefault": chain.unsafe_block_signer == Some(args.signer),
        "baseSourceCommit": BASE_SOURCE_COMMIT, "objectEncoding": OBJECT_ENCODING,
        "forkSchedule": {
            "isthmus": chain.isthmus_timestamp, "jovian": chain.jovian_timestamp,
            "azul": chain.azul_timestamp, "beryl": chain.beryl_timestamp,
            "cobalt": chain.cobalt_timestamp, "denim": chain.denim_timestamp,
        },
        "limits": {
            "durationSecs": args.duration_secs, "maxPeers": args.max_peers,
            "maxOutputBytes": args.max_output_bytes, "discovery": format!("{:?}", args.discovery),
            "discoveryAfterSecs": args.discovery_after_secs,
        },
        "startedUnixMs": now_ms(),
    });
    if !emit(&mut store, &start) {
        return Err("output budget too small for start record".to_owned());
    }

    let keypair = Keypair::generate_secp256k1();
    let listen_addr: Multiaddr = format!("/ip4/{}/tcp/{}", args.listen.ip(), args.listen.port())
        .parse()
        .map_err(|e| format!("listen multiaddr: {e}"))?;
    let (mut driver, _signer_tx) =
        GossipDriverBuilder::new(rollup.clone(), args.signer, listen_addr, keypair.clone())
            .with_connection_limits_config(ConnectionLimitsConfig::new(args.max_peers))
            .build()
            .map_err(|e| format!("gossip driver: {e}"))?;
    let bound = driver.start().await.map_err(|e| format!("listen: {e}"))?;

    let bootnodes = BootNodes::mainnet();
    let v4_topic = driver.handler.blocks_v4_topic.hash();
    let mut queue: DialQueue<PeerId, Dial> =
        DialQueue::new(MAX_QUEUE, MAX_TOTAL_DIALS, MAX_IN_FLIGHT, DIAL_IN_FLIGHT_TTL);
    let mut boot_status: HashMap<PeerId, (usize, &'static str)> = HashMap::new();
    // Published bootnodes are offered first, so they are dialed first.
    for (index, node) in bootnodes.iter().enumerate() {
        let dial = match node {
            BootNode::Enr(enr) => PeerUtils::enr_to_multiaddr(enr).map(|a| (a, Dial::Enr(enr.clone()))),
            BootNode::Enode(addr) => Some((addr.clone(), Dial::Addr(addr.clone()))),
        };
        if let Some((addr, dial)) = dial
            && let Some(peer) = ConnectionGater::peer_id_from_addr(&addr)
        {
            boot_status.insert(peer, (index, "queued"));
            queue.offer(peer, dial);
        }
    }

    let begin = Instant::now();
    let deadline = begin + Duration::from_secs(args.duration_secs);
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut dial_tick = tokio::time::interval(Duration::from_millis(250));
    let mut pending_pruner = tokio::time::interval(PENDING_DIAL_PRUNE_INTERVAL);
    let mut gater_pruner = tokio::time::interval(GATER_PRUNE_INTERVAL);
    let mut progress_tick = tokio::time::interval(Duration::from_secs(PROGRESS_EVERY_SECS));
    progress_tick.reset();
    let mut discovery_rx: Option<tokio::sync::mpsc::Receiver<discv5::Enr>> = None;
    let mut _discovery_handle = None;
    let (mut accepted, mut duplicates, mut unsupported) = (0u64, 0u64, 0u64);
    let (mut enrs_received, mut enrs_unusable) = (0u64, 0u64);
    let mut diag = Diag::default();
    let mut highest: Option<u64> = None;
    let reason;

    loop {
        tokio::select! {
            () = tokio::time::sleep_until(deadline) => { reason = "duration"; break; }
            _ = dial_tick.tick() => {
                let now = std::time::Instant::now();
                while let Some((peer, dial)) =
                    queue.next_dial(driver.connected_peers(), args.max_peers as usize, now)
                {
                    if let Some(status) = boot_status.get_mut(&peer) { status.1 = "dialing"; }
                    match dial {
                        Dial::Enr(enr) => driver.dial(enr),
                        Dial::Addr(addr) => driver.dial_multiaddr(addr),
                    }
                }
            }
            _ = pending_pruner.tick() => { driver.clear_expired_pending_connections(); }
            _ = gater_pruner.tick() => { driver.connection_gate.prune(); }
            _ = progress_tick.tick() => {
                let snapshot = diag.snapshot(&driver, &v4_topic);
                let _ = emit(&mut store, &json!({"schema": SCHEMA, "type": "progress",
                    "elapsedMs": begin.elapsed().as_millis(), "accepted": accepted,
                    "dials": queue.dials(), "inFlight": queue.in_flight(), "stages": snapshot}));
            }
            _ = tick.tick() => {
                let peers = driver.connected_peers();
                diag.peers_max = diag.peers_max.max(peers);
                diag.observe_mesh(&driver, &v4_topic);
                if args.discovery == Discovery::Bounded
                    && discovery_rx.is_none()
                    && peers == 0
                    && begin.elapsed() >= Duration::from_secs(args.discovery_after_secs)
                {
                    let secret = keypair
                        .clone()
                        .try_into_secp256k1()
                        .map_err(|e| format!("key conversion: {e}"))?
                        .secret()
                        .to_bytes();
                    let key = discv5::enr::k256::ecdsa::SigningKey::from_bytes(&secret.into())
                        .map_err(|e| format!("discovery key: {e}"))?;
                    let local = LocalNode::new(key, IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0, 0);
                    let config = discv5::ConfigBuilder::new((&local).into()).build();
                    // No bootstore file: the table lives in memory and is dropped on exit.
                    let disc = Discv5Builder::new(local, chain_id, config)
                        .with_bootnodes(BootNodes::mainnet())
                        .build()
                        .map_err(|e| format!("discovery: {e}"))?;
                    let (handle, rx) = disc.start();
                    _discovery_handle = Some(handle);
                    discovery_rx = Some(rx);
                    let _ = emit(&mut store, &json!({"schema": SCHEMA, "type": "discovery-started",
                        "afterMs": begin.elapsed().as_millis()}));
                }
            }
            Some(enr) = async {
                match discovery_rx.as_mut() {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                enrs_received += 1;
                // The maintained driver already filtered by `opstack` chain 8453; re-check anyway.
                let usable = EnrValidation::validate(&enr, chain_id).is_valid()
                    && PeerUtils::enr_to_multiaddr(&enr)
                        .as_ref()
                        .and_then(ConnectionGater::peer_id_from_addr)
                        .map(|peer| { queue.offer(peer, Dial::Enr(enr)); })
                        .is_some();
                if !usable { enrs_unusable += 1; }
            }
            event = driver.next() => {
                let Some(event) = event else { reason = "swarm-ended"; break; };
                diag.observe_event(&event, &v4_topic, &mut queue, &mut boot_status);
                let Some(envelope) = driver.handle_event(event) else { continue; };
                let object = match encode_object(&envelope) {
                    Ok(bytes) => bytes,
                    Err(_) => { unsupported += 1; continue; }
                };
                match store.put(&object).map_err(|e| e.to_string())? {
                    None => { reason = "output-budget"; break; }
                    Some((_, StoreOutcome::AlreadyPresent)) => { duplicates += 1; }
                    Some((_, StoreOutcome::Written)) => {
                        let record = HeadRecord::new(&envelope, chain_id, args.signer, &object, now_ms());
                        highest = Some(highest.map_or(record.number, |h| h.max(record.number)));
                        let value = serde_json::to_value(&record).map_err(|e| e.to_string())?;
                        if !emit(&mut store, &value) { reason = "output-budget"; break; }
                        accepted += 1;
                    }
                }
            }
        }
    }

    let mut boots: Vec<_> = boot_status.values().copied().collect();
    boots.sort_unstable();
    let summary = json!({
        "schema": SCHEMA, "type": "summary", "reason": reason, "accepted": accepted,
        "duplicates": duplicates, "unsupportedVersion": unsupported, "highestNumber": highest,
        "bootnodes": boots.iter().map(|(i, s)| json!({"index": i, "outcome": s})).collect::<Vec<_>>(),
        "dials": queue.dials(), "uniqueCandidates": queue.unique(),
        "duplicateCandidates": queue.duplicates(), "queueOverflow": queue.overflow(),
        "undialedCandidates": queue.pending(),
        "discoveryStarted": discovery_rx.is_some(), "enrsReceived": enrs_received,
        "enrsUnusable": enrs_unusable, "stages": diag.snapshot(&driver, &v4_topic),
        "outputBytes": store.used(), "elapsedMs": begin.elapsed().as_millis(),
        "listen": bound.to_string(),
    });
    let _ = emit(&mut store, &summary);
    Ok(accepted)
}

/// A queued outbound dial.
#[derive(Debug, Clone)]
enum Dial {
    Enr(discv5::Enr),
    Addr(Multiaddr),
}

/// Staged connectivity evidence: transport → identify → meshsub → v4 subscription → messages.
#[derive(Debug, Default)]
struct Diag {
    established_outbound: u64,
    established_inbound: u64,
    closed: u64,
    peers_max: usize,
    dial_errors: BTreeMap<&'static str, u64>,
    identified: HashSet<PeerId>,
    meshsub: HashSet<PeerId>,
    agents: BTreeMap<String, u64>,
    subscribed_v4: HashSet<PeerId>,
    mesh_v4_max: usize,
    messages_v4: u64,
    messages_other_topic: u64,
}

impl Diag {
    fn observe_event(
        &mut self,
        event: &SwarmEvent<GossipEvent>,
        v4: &TopicHash,
        queue: &mut DialQueue<PeerId, Dial>,
        boot: &mut HashMap<PeerId, (usize, &'static str)>,
    ) {
        match event {
            SwarmEvent::ConnectionEstablished { peer_id, endpoint, .. } => {
                if endpoint.is_dialer() {
                    self.established_outbound += 1;
                } else {
                    self.established_inbound += 1;
                }
                queue.resolved(peer_id);
                if let Some(status) = boot.get_mut(peer_id) {
                    status.1 = "established";
                }
            }
            SwarmEvent::ConnectionClosed { .. } => self.closed += 1,
            SwarmEvent::OutgoingConnectionError { peer_id, error, .. } => {
                let class = classify_dial_error(&error.to_string());
                *self.dial_errors.entry(class).or_default() += 1;
                if let Some(peer) = peer_id {
                    queue.resolved(peer);
                    if let Some(status) = boot.get_mut(peer)
                        && status.1 != "established"
                    {
                        status.1 = class;
                    }
                }
            }
            SwarmEvent::Behaviour(GossipEvent::Identify(e)) => {
                if let identify::Event::Received { peer_id, info, .. } = e.as_ref()
                    && self.identified.insert(*peer_id)
                {
                    // Product name only (text before the first '/'), never full version strings.
                    let product = info.agent_version.split('/').next().unwrap_or("").chars().take(40);
                    let product: String = product.collect();
                    if self.agents.len() < MAX_AGENT_BUCKETS || self.agents.contains_key(&product) {
                        *self.agents.entry(product).or_default() += 1;
                    } else {
                        *self.agents.entry("(other)".to_owned()).or_default() += 1;
                    }
                    if info.protocols.iter().any(|p| p.as_ref().starts_with("/meshsub/")) {
                        self.meshsub.insert(*peer_id);
                    }
                }
            }
            SwarmEvent::Behaviour(GossipEvent::Gossipsub(e)) => match e.as_ref() {
                gossipsub::Event::Subscribed { peer_id, topic } if topic == v4 => {
                    self.subscribed_v4.insert(*peer_id);
                }
                gossipsub::Event::Message { message, .. } => {
                    if &message.topic == v4 {
                        self.messages_v4 += 1;
                    } else {
                        self.messages_other_topic += 1;
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }

    fn observe_mesh<G: ConnectionGate>(&mut self, driver: &GossipDriver<G>, v4: &TopicHash) {
        let mesh = driver.swarm.behaviour().gossipsub.mesh_peers(v4).count();
        self.mesh_v4_max = self.mesh_v4_max.max(mesh);
    }

    fn snapshot<G: ConnectionGate>(&self, driver: &GossipDriver<G>, v4: &TopicHash) -> serde_json::Value {
        json!({
            "transportEstablishedOutbound": self.established_outbound,
            "transportEstablishedInbound": self.established_inbound,
            "connectionsClosed": self.closed,
            "connectedNow": driver.connected_peers(),
            "peersMax": self.peers_max,
            "dialErrors": self.dial_errors,
            "identifiedPeers": self.identified.len(),
            "meshsubCapablePeers": self.meshsub.len(),
            "agentProducts": self.agents,
            "subscribedV4Peers": self.subscribed_v4.len(),
            "meshV4Now": driver.swarm.behaviour().gossipsub.mesh_peers(v4).count(),
            "meshV4Max": self.mesh_v4_max,
            "v4MessagesReceived": self.messages_v4,
            "otherTopicMessages": self.messages_other_topic,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(listen: &str, duration_secs: u64, max_peers: u32) -> ListenArgs {
        ListenArgs {
            signer: Address::ZERO,
            duration_secs,
            max_peers,
            max_output_bytes: 1 << 20,
            out_dir: PathBuf::from("unused"),
            listen: listen.parse().unwrap(),
            discovery: Discovery::Off,
            discovery_after_secs: 15,
        }
    }

    #[test]
    fn listener_must_be_loopback_and_bounded() {
        assert!(validate(&args("127.0.0.1:0", 60, 20)).is_ok());
        assert!(validate(&args("0.0.0.0:0", 60, 20)).is_err());
        assert!(validate(&args("192.168.1.10:9222", 60, 20)).is_err());
        assert!(validate(&args("[::1]:0", 60, 20)).is_err());
        assert!(validate(&args("127.0.0.1:0", 0, 20)).is_err());
        assert!(validate(&args("127.0.0.1:0", MAX_DURATION_SECS + 1, 20)).is_err());
        assert!(validate(&args("127.0.0.1:0", 60, 0)).is_err());
        assert!(validate(&args("127.0.0.1:0", 60, MAX_PEERS + 1)).is_err());
    }

    #[test]
    fn signer_is_required() {
        assert!(Cli::try_parse_from(["x", "listen", "--out-dir", "o"]).is_err());
        let cli = Cli::try_parse_from([
            "x", "listen", "--out-dir", "o", "--signer", "0xAf6E19BE0F9cE7f8afd49a1824851023A8249e8a",
        ])
        .unwrap();
        let Cmd::Listen(a) = cli.cmd else { panic!("listen") };
        assert_eq!((a.duration_secs, a.max_peers, a.max_output_bytes), (60, 20, 64 << 20));
        assert_eq!(a.discovery, Discovery::Off);
    }
}
