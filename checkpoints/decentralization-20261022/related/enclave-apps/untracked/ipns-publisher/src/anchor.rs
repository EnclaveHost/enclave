//! Release anchor: the published value comes from an on-chain ReleaseAnchor contract, read through a quorum of
//! independently chosen JSON-RPC endpoints at ONE agreed block (work/ipns-anchor-interface.txt).
//!
//! A round asks every endpoint (never first success), one endpoint per event-loop tick:
//!   A. eth_chainId + eth_blockNumber;
//!   B. target = (quorum-th highest head) - confirmations; eth_getBlockByNumber(target) must agree on
//!      (number, hash, timestamp) at `quorum` endpoints;
//!   C. eth_getCode + eth_call(state()) by that blockHash (EIP-1898, requireCanonical): the runtime must hash to the
//!      pinned codeHash and `quorum` call results must be identical;
//!   D. at the END of the round: freshness of the block timestamp, schema, name binding, high-water.
//! What a round proves is the anchor state at one canonical, recent block. It is not "the latest state": endpoints
//! may withhold the newest blocks, up to the freshness window.
//!
//! Signing is gated on the authority: the record's EOL never passes block.timestamp + authorityTtlSecs, so a state
//! the chain superseded at block time P stops validating by P + authorityTtlSecs whatever the publisher's network
//! or clock does afterwards. Once that passes without a fresh round, signing stops.

use std::time::Duration;

use sha3::{Digest, Keccak256};

use crate::multiformats::{hex, hex_decode, varint_read};
use crate::webreq;

pub const SCHEMA_ID: &str = "enclave.ipns-release-anchor.v1";
/// How far ahead of the local clock a block timestamp may be before the clock is called wrong.
pub const MAX_FUTURE_SECS: i64 = 120;
/// Signing needs at least this much authority left (the record must outlive its own propagation): 60 s, or a
/// quarter of authorityTtlSecs when that is shorter.
pub const MIN_AUTHORITY_LEFT_SECS: i64 = 60;

fn min_authority_left(cfg: &Config) -> i64 {
    MIN_AUTHORITY_LEFT_SECS.min(cfg.authority_ttl_secs as i64 / 4)
}
const MAX_ENDPOINTS: usize = 16;
const MAX_CID_LEN: usize = 128;

pub fn keccak256(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

pub fn schema() -> [u8; 32] {
    keccak256(SCHEMA_ID.as_bytes())
}

/// The contract's `nameHash` for an IPNS name: keccak256 of its peer multihash bytes.
pub fn name_hash(peer_mh: &[u8]) -> [u8; 32] {
    keccak256(peer_mh)
}

fn state_selector() -> [u8; 4] {
    let h = keccak256(b"state()");
    [h[0], h[1], h[2], h[3]]
}

// ---- config ------------------------------------------------------------------------------------------------------

pub struct Endpoint {
    /// Safe display label (canonical host:port): what logs and status show. The URL itself may carry a provider key in
    /// its path and is never printed.
    pub id: String,
    /// The vote identity: one per public host whatever its port or path; one per loopback port (local test listeners).
    pub identity: String,
    url: webreq::Url,
}

pub struct Config {
    pub chain_id: u64,
    pub contract: [u8; 20],
    pub code_hash: [u8; 32],
    pub endpoints: Vec<Endpoint>,
    pub quorum: usize,
    pub confirmations: u64,
    pub max_block_age_secs: u64,
    pub authority_ttl_secs: u64,
    pub poll_secs: u64,
    pub sequence_offset: u64,
    pub rpc_timeout: Duration,
}

fn fixed_hex<const N: usize>(v: &serde_json::Value, key: &str) -> Result<[u8; N], String> {
    let s = v.get(key).and_then(|x| x.as_str()).ok_or(format!("releaseAnchor.{key} is required (0x hex)"))?;
    let body = s.strip_prefix("0x").ok_or(format!("releaseAnchor.{key} must start with 0x"))?;
    let bytes = hex_decode(body).filter(|b| b.len() == N).ok_or(format!("releaseAnchor.{key} must be {N} bytes of hex"))?;
    Ok(bytes.try_into().unwrap())
}

/// One RPC URL under the endpoint policy, the same rule as the enclave repository's `network/rpc-identity.mjs` and the
/// s3-ipfs-adapter's `contract_wallet.rs` `RpcUrl` (whose strict grammar this is):
///   url  = ("https://" | "http://") host [":" port] [path]
///   host = name (letters, digits, '-' labels of 1..63, one optional trailing dot) | dotted-quad IPv4 | "[" IPv6 "]"
/// No credentials ('@'), query ('?'), fragment ('#'), percent-escapes, backslash, whitespace or non-ASCII anywhere.
/// A host whose last label is numeric must be a dotted quad (`127.1`, `0x7f.0.0.1`, `017.0.0.1` are refused, never
/// guessed at). An IPv4-mapped IPv6 address (::ffff:0:0/96) IS that IPv4 host; a NAT64 one (64:ff9b::/96) reaches it
/// through a translator: both share its vote, and only the mapped form can be loopback.
/// Plain http only for loopback: a parsed loopback address (127.0.0.0/8, ::1, or a mapped 127/8) or exactly
/// `localhost`. A DNS name that merely starts with "127." or "localhost" is a public name.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcUrl {
    pub https: bool,
    /// canonical: lowercase without the trailing dot, a dotted quad, or "[v6]" in compressed form
    pub host: String,
    pub port: u16,
    pub path: String,
    pub loopback: bool,
}

pub fn parse_rpc_url(u: &str) -> Result<RpcUrl, &'static str> {
    if !u.is_ascii() || u.bytes().any(|b| b.is_ascii_whitespace() || b.is_ascii_control()) {
        return Err("only plain ASCII, no spaces");
    }
    if u.contains(['@', '?', '#', '%', '\\']) {
        return Err("no credentials, query, fragment or escapes");
    }
    let (https, rest) = if let Some(r) = u.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = u.strip_prefix("http://") {
        (false, r)
    } else {
        return Err("the scheme must be https:// (or http:// on loopback)");
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    if !path.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~/".contains(&b)) {
        return Err("the path may hold only letters, digits and -._~/");
    }
    let (host, port_part, loopback) = if let Some(v6) = authority.strip_prefix('[') {
        let (inside, after) = v6.split_once(']').ok_or("an IPv6 host needs its closing bracket")?;
        let port = match after {
            "" => None,
            p => Some(p.strip_prefix(':').ok_or("junk after the IPv6 host")?),
        };
        let ip: std::net::Ipv6Addr = inside.parse().map_err(|_| "not an IPv6 address")?;
        let seg = ip.segments();
        if let Some(v4) = ip.to_ipv4_mapped() {
            (v4.to_string(), port, v4.is_loopback())
        } else if seg[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
            let v4 = std::net::Ipv4Addr::new((seg[6] >> 8) as u8, seg[6] as u8, (seg[7] >> 8) as u8, seg[7] as u8);
            (v4.to_string(), port, false) // through a translator: never this machine
        } else {
            (format!("[{ip}]"), port, ip.is_loopback())
        }
    } else {
        let (h, p) = match authority.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority, None),
        };
        let h = h.to_ascii_lowercase();
        let h = h.strip_suffix('.').unwrap_or(&h).to_string();
        if h.is_empty() || h.len() > 253 {
            return Err("no host");
        }
        let labels: Vec<&str> = h.split('.').collect();
        if labels.last().is_some_and(|l| !l.is_empty() && l.bytes().all(|b| b.is_ascii_digit())) {
            let ip: std::net::Ipv4Addr = h.parse().map_err(|_| "a numeric host must be a dotted-quad IPv4 address")?;
            (ip.to_string(), p, ip.is_loopback())
        } else {
            for l in &labels {
                let ok = (1..=63).contains(&l.len())
                    && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    && !l.starts_with('-')
                    && !l.ends_with('-');
                if !ok {
                    return Err("not a valid host name");
                }
            }
            let lo = h == "localhost";
            (h, p, lo)
        }
    };
    let port = match port_part {
        None => {
            if https {
                443
            } else {
                80
            }
        }
        Some(p) if !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()) => {
            p.parse::<u16>().ok().filter(|n| *n > 0).ok_or("the port must be 1..65535")?
        }
        Some(_) => return Err("the port must be 1..65535"),
    };
    if !https && !loopback {
        return Err("plain http is only for a loopback test node");
    }
    let path = if path.is_empty() { "/".to_string() } else { path.to_string() };
    Ok(RpcUrl { https, host, port, path, loopback })
}

impl RpcUrl {
    /// Who answers: a public host is one provider whatever its port or path; loopback spellings on one port are one
    /// local listener (a test rig may run several on distinct ports).
    pub fn identity(&self) -> String {
        if self.loopback {
            format!("loopback:{}", self.port)
        } else {
            self.host.clone()
        }
    }

    /// Safe for logs: canonical host and port, never the path (which may hold a provider key).
    pub fn label(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    /// The URL actually dialed: built from the parsed parts, so nothing the strict parse refused or folded can reach
    /// the connection (webreq::Url::parse does not normalize: it keeps userinfo, a trailing dot or a query in `host`).
    fn dial(&self) -> webreq::Url {
        let host = self.host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(&self.host).to_string();
        webreq::Url { https: self.https, host, port: self.port, path: self.path.clone() }
    }
}

/// Parse and bound `releaseAnchor`. Unknown keys are refused, so a typo cannot silently fall back to a default.
pub fn parse_config(v: &serde_json::Value, lifetime_secs: u64) -> Result<Config, String> {
    const KEYS: &[&str] = &[
        "chainId", "contract", "codeHash", "rpcs", "quorum", "confirmations", "maxBlockAgeSecs",
        "authorityTtlSecs", "pollSecs", "sequenceOffset", "rpcTimeoutSecs",
    ];
    let obj = v.as_object().ok_or("releaseAnchor must be an object")?;
    if let Some(k) = obj.keys().find(|k| !KEYS.contains(&k.as_str())) {
        return Err(format!("releaseAnchor: unknown key `{k}`"));
    }
    let req_u64 = |k: &str| v.get(k).and_then(|x| x.as_u64()).ok_or(format!("releaseAnchor.{k} is required (integer)"));
    let opt_u64 = |k: &str, d: u64| match v.get(k) {
        None => Ok(d),
        Some(x) => x.as_u64().ok_or(format!("releaseAnchor.{k} must be a non-negative integer")),
    };
    let chain_id = req_u64("chainId")?;
    if chain_id == 0 {
        return Err("releaseAnchor.chainId must be nonzero".into());
    }
    let contract = fixed_hex::<20>(v, "contract")?;
    if contract == [0; 20] {
        return Err("releaseAnchor.contract must not be the zero address".into());
    }
    let code_hash = fixed_hex::<32>(v, "codeHash")?;
    let rpcs = v.get("rpcs").and_then(|x| x.as_array()).ok_or("releaseAnchor.rpcs is required (a list of URLs)")?;
    if rpcs.is_empty() || rpcs.len() > MAX_ENDPOINTS {
        return Err(format!("releaseAnchor.rpcs must list 1..{MAX_ENDPOINTS} endpoints"));
    }
    let mut endpoints: Vec<Endpoint> = Vec::new();
    for (i, r) in rpcs.iter().enumerate() {
        // never echo the URL: it may carry a provider key
        let s = r.as_str().filter(|s| !s.is_empty()).ok_or(format!("releaseAnchor.rpcs[{i}] is empty or not a string (an unset $SECRET?)"))?;
        let parsed = parse_rpc_url(s).map_err(|why| format!("releaseAnchor.rpcs[{i}] is refused: {why}"))?;
        let identity = parsed.identity();
        if let Some(j) = endpoints.iter().position(|e| e.identity == identity) {
            return Err(format!(
                "releaseAnchor.rpcs[{i}] is the same provider as rpcs[{j}] ({identity}): a port, path, case or trailing \
                 dot does not make a second provider"
            ));
        }
        endpoints.push(Endpoint { id: parsed.label(), identity, url: parsed.dial() });
    }
    let quorum = req_u64("quorum")? as usize;
    if quorum < 2 || quorum > endpoints.len() {
        return Err(format!("releaseAnchor.quorum must be between 2 and the number of rpcs ({})", endpoints.len()));
    }
    let confirmations = opt_u64("confirmations", 6)?;
    if confirmations > 10_000 {
        return Err("releaseAnchor.confirmations must be <= 10000".into());
    }
    let max_block_age_secs = opt_u64("maxBlockAgeSecs", 120)?;
    if !(1..=3600).contains(&max_block_age_secs) {
        return Err("releaseAnchor.maxBlockAgeSecs must be 1..3600".into());
    }
    let poll_secs = opt_u64("pollSecs", 120)?;
    if poll_secs < 10 {
        return Err("releaseAnchor.pollSecs must be >= 10".into());
    }
    let authority_ttl_secs = opt_u64("authorityTtlSecs", 43_200)?;
    let floor = (4 * poll_secs).max(2 * max_block_age_secs);
    if authority_ttl_secs < floor || authority_ttl_secs > lifetime_secs {
        return Err(format!(
            "releaseAnchor.authorityTtlSecs must be >= max(4*pollSecs, 2*maxBlockAgeSecs) = {floor} and <= lifetimeSecs ({lifetime_secs})"
        ));
    }
    let sequence_offset = req_u64("sequenceOffset")?;
    let rpc_timeout_secs = opt_u64("rpcTimeoutSecs", 10)?;
    if !(1..=60).contains(&rpc_timeout_secs) {
        return Err("releaseAnchor.rpcTimeoutSecs must be 1..60".into());
    }
    Ok(Config {
        chain_id,
        contract,
        code_hash,
        endpoints,
        quorum,
        confirmations,
        max_block_age_secs,
        authority_ttl_secs,
        poll_secs,
        sequence_offset,
        rpc_timeout: Duration::from_secs(rpc_timeout_secs),
    })
}

// ---- JSON-RPC transport ------------------------------------------------------------------------------------------

pub trait Rpc {
    fn call(&mut self, ep: &Endpoint, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String>;
}

/// The real transport: one POST per call over webreq (rustls for https), bounded by the configured timeout.
pub struct HttpRpc {
    pub timeout: Duration,
    next_id: u64,
}

impl HttpRpc {
    pub fn new(timeout: Duration) -> HttpRpc {
        HttpRpc { timeout, next_id: 1 }
    }
}

impl Rpc for HttpRpc {
    fn call(&mut self, ep: &Endpoint, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let body = serde_json::json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string();
        let (status, resp, _) = webreq::request_timeout(
            "POST",
            &ep.url,
            &[("content-type", "application/json"), ("accept", "application/json")],
            body.as_bytes(),
            self.timeout,
        )?;
        if status != 200 {
            return Err(format!("{method}: HTTP {status}"));
        }
        let v: serde_json::Value = serde_json::from_slice(&resp).map_err(|_| format!("{method}: response is not JSON"))?;
        if v.get("id").and_then(|x| x.as_u64()) != Some(id) {
            return Err(format!("{method}: response id does not match the request"));
        }
        if let Some(err) = v.get("error") {
            let msg = err.get("message").and_then(|m| m.as_str()).unwrap_or("error");
            return Err(format!("{method}: {:.100}", msg));
        }
        v.get("result").cloned().ok_or(format!("{method}: no result"))
    }
}

fn quantity(v: &serde_json::Value, what: &str) -> Result<u64, String> {
    let s = v.as_str().ok_or(format!("{what}: not a hex quantity"))?;
    let h = s.strip_prefix("0x").ok_or(format!("{what}: not a hex quantity"))?;
    if h.is_empty() || h.len() > 16 {
        return Err(format!("{what}: bad hex quantity"));
    }
    u64::from_str_radix(h, 16).map_err(|_| format!("{what}: bad hex quantity"))
}

fn data(v: &serde_json::Value, what: &str) -> Result<Vec<u8>, String> {
    let s = v.as_str().ok_or(format!("{what}: not hex data"))?;
    let h = s.strip_prefix("0x").ok_or(format!("{what}: not hex data"))?;
    hex_decode(h).ok_or(format!("{what}: bad hex data"))
}

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex(b))
}

// ---- decision logic (pure) ---------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    pub number: u64,
    pub hash: [u8; 32],
    pub timestamp: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnchorState {
    pub seq: u64,
    pub cid: String,
    pub owner: [u8; 20],
    pub delegate: [u8; 20],
    pub delegate_until: u64,
    pub retired: bool,
    pub successor: [u8; 20],
}

#[derive(Clone, Debug)]
pub struct Authority {
    pub state: AnchorState,
    pub block: Block,
    /// local clock at the end of the round that produced this authority
    pub read_at: i64,
    /// block.timestamp + authorityTtlSecs: no record carrying this state may outlive it
    pub until: i64,
    pub agreeing: usize,
}

/// The highest block and anchor seq ever accepted for one (chainId, contract).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HighWater {
    pub chain_id: u64,
    pub contract: [u8; 20],
    pub block: u64,
    pub seq: u64,
}

impl HighWater {
    fn applies(&self, cfg: &Config) -> bool {
        self.chain_id == cfg.chain_id && self.contract == cfg.contract
    }

    pub fn to_json(&self) -> String {
        format!(
            "{{\"chainId\":{},\"contract\":\"{}\",\"block\":{},\"seq\":{}}}",
            self.chain_id,
            hex0x(&self.contract),
            self.block,
            self.seq
        )
    }

    pub fn from_json(v: &serde_json::Value) -> Option<HighWater> {
        let contract = hex_decode(v.get("contract")?.as_str()?.strip_prefix("0x")?)?;
        Some(HighWater {
            chain_id: v.get("chainId")?.as_u64()?,
            contract: contract.try_into().ok()?,
            block: v.get("block")?.as_u64()?,
            seq: v.get("seq")?.as_u64()?,
        })
    }
}

/// The block to read: the quorum-th highest reported head, minus the confirmations. With fewer than `quorum`
/// endpoints lying, this is at most the highest honest head, so inflated heads cannot pick a block no honest
/// endpoint has.
pub fn select_target(heads: &[Option<u64>], quorum: usize, confirmations: u64) -> Result<u64, String> {
    let mut hs: Vec<u64> = heads.iter().flatten().copied().collect();
    if hs.len() < quorum {
        return Err(format!("only {} of the required {quorum} endpoints answered the chain head", hs.len()));
    }
    hs.sort_unstable_by(|a, b| b.cmp(a));
    hs[quorum - 1]
        .checked_sub(confirmations)
        .ok_or_else(|| format!("chain head {} is below the {confirmations} confirmations", hs[quorum - 1]))
}

/// Exactly one (number, hash, timestamp) reported by at least `quorum` endpoints.
pub fn agree_block(blocks: &[Option<Block>], quorum: usize) -> Result<(Block, usize), String> {
    let mut groups: Vec<(Block, usize)> = Vec::new();
    for b in blocks.iter().flatten() {
        match groups.iter_mut().find(|(g, _)| g == b) {
            Some((_, n)) => *n += 1,
            None => groups.push((b.clone(), 1)),
        }
    }
    let winners: Vec<&(Block, usize)> = groups.iter().filter(|(_, n)| *n >= quorum).collect();
    match winners.as_slice() {
        [one] => Ok((one.0.clone(), one.1)),
        [] => Err(format!(
            "no {quorum} endpoints agree on the block ({} distinct answers from {})",
            groups.len(),
            blocks.iter().flatten().count()
        )),
        _ => Err("two different blocks each reached the quorum (a fork): refusing".into()),
    }
}

/// Exactly one call result returned by at least `quorum` endpoints.
pub fn agree_result(results: &[Option<Vec<u8>>], quorum: usize) -> Result<(Vec<u8>, usize), String> {
    let mut groups: Vec<(&Vec<u8>, usize)> = Vec::new();
    for r in results.iter().flatten() {
        match groups.iter_mut().find(|(g, _)| *g == r) {
            Some((_, n)) => *n += 1,
            None => groups.push((r, 1)),
        }
    }
    let winners: Vec<&(&Vec<u8>, usize)> = groups.iter().filter(|(_, n)| *n >= quorum).collect();
    match winners.as_slice() {
        [one] => Ok((one.0.clone(), one.1)),
        [] => Err(format!(
            "no {quorum} endpoints returned the same anchor state ({} distinct answers from {})",
            groups.len(),
            results.iter().flatten().count()
        )),
        _ => Err("two different anchor states each reached the quorum: refusing".into()),
    }
}

/// A CIDv1 in multibase base32-lower: what the contract's charset rule admits, decoded for real.
pub fn valid_cid(cid: &str) -> bool {
    if cid.len() < 8 || cid.len() > MAX_CID_LEN {
        return false;
    }
    let Some(bytes) = cid.strip_prefix('b').and_then(crate::multiformats::base32_decode) else { return false };
    let Some((version, a)) = varint_read(&bytes) else { return false };
    let Some((_codec, b)) = varint_read(&bytes[a..]) else { return false };
    let Some((_mh_code, c)) = varint_read(&bytes[a + b..]) else { return false };
    let Some((mh_len, d)) = varint_read(&bytes[a + b + c..]) else { return false };
    version == 1 && mh_len as usize == bytes.len() - (a + b + c + d)
}

fn word(raw: &[u8], i: usize) -> &[u8] {
    &raw[i * 32..i * 32 + 32]
}

fn word_u64(w: &[u8]) -> Option<u64> {
    w[..24].iter().all(|&b| b == 0).then(|| u64::from_be_bytes(w[24..].try_into().unwrap()))
}

fn word_addr(w: &[u8]) -> Option<[u8; 20]> {
    w[..12].iter().all(|&b| b == 0).then(|| w[12..].try_into().unwrap())
}

/// Strict ABI decode of state() -> (bytes32, bytes32, uint64, string, address, address, uint64, bool, address).
/// Returns (schema, nameHash, state). Any non-canonical encoding is refused.
pub fn decode_state(raw: &[u8]) -> Result<([u8; 32], [u8; 32], AnchorState), String> {
    const HEAD: usize = 9 * 32;
    let bad = |what: &str| format!("state(): {what}");
    if raw.len() < HEAD + 32 {
        return Err(bad("short result"));
    }
    let schema: [u8; 32] = word(raw, 0).try_into().unwrap();
    let name: [u8; 32] = word(raw, 1).try_into().unwrap();
    let seq = word_u64(word(raw, 2)).ok_or(bad("seq is not a uint64"))?;
    if word_u64(word(raw, 3)) != Some(HEAD as u64) {
        return Err(bad("unexpected string offset"));
    }
    let owner = word_addr(word(raw, 4)).ok_or(bad("owner is not an address"))?;
    let delegate = word_addr(word(raw, 5)).ok_or(bad("delegate is not an address"))?;
    let delegate_until = word_u64(word(raw, 6)).ok_or(bad("delegateUntil is not a uint64"))?;
    let retired = match word_u64(word(raw, 7)) {
        Some(0) => false,
        Some(1) => true,
        _ => return Err(bad("retired is not a bool")),
    };
    let successor = word_addr(word(raw, 8)).ok_or(bad("successor is not an address"))?;
    let len = word_u64(&raw[HEAD..HEAD + 32]).ok_or(bad("bad cid length"))? as usize;
    if len > MAX_CID_LEN {
        return Err(bad("cid too long"));
    }
    let padded = len.div_ceil(32) * 32;
    if raw.len() != HEAD + 32 + padded {
        return Err(bad("result length does not match the encoding"));
    }
    let body = &raw[HEAD + 32..];
    if body[len..].iter().any(|&b| b != 0) {
        return Err(bad("nonzero string padding"));
    }
    let cid = std::str::from_utf8(&body[..len]).map_err(|_| bad("cid is not utf-8"))?.to_string();
    Ok((schema, name, AnchorState { seq, cid, owner, delegate, delegate_until, retired, successor }))
}

/// Step D: everything that can only be judged once the last answer is in. `now_end` is the local clock read AFTER
/// the last response, so time spent on sequential reads counts against the freshness window.
pub fn finalize(
    cfg: &Config,
    block: &Block,
    agreeing: usize,
    raw_state: &[u8],
    hw: Option<&HighWater>,
    our_name_hash: &[u8; 32],
    now_end: i64,
) -> Result<Authority, String> {
    let ts = block.timestamp as i64;
    if ts + (cfg.max_block_age_secs as i64) < now_end {
        return Err(format!(
            "stale: block {} is {}s old at the end of the round (maxBlockAgeSecs {})",
            block.number,
            now_end - ts,
            cfg.max_block_age_secs
        ));
    }
    if ts > now_end + MAX_FUTURE_SECS {
        return Err(format!("block {} is {}s ahead of the local clock: the clock is wrong", block.number, ts - now_end));
    }
    let (schema_word, name, state) = decode_state(raw_state)?;
    if schema_word != schema() {
        return Err("anchor schema mismatch".into());
    }
    if &name != our_name_hash {
        return Err("anchor nameHash is not this publisher's IPNS name".into());
    }
    if let Some(hw) = hw.filter(|h| h.applies(cfg)) {
        if block.number < hw.block {
            return Err(format!("regression: block {} is below the accepted high-water {}", block.number, hw.block));
        }
        if state.seq < hw.seq {
            return Err(format!("regression: anchor seq {} is below the accepted high-water {}", state.seq, hw.seq));
        }
    }
    if !valid_cid(&state.cid) {
        return Err(format!("anchor cid is not a base32 CIDv1: {:.80}", state.cid));
    }
    Ok(Authority {
        state,
        block: block.clone(),
        read_at: now_end,
        until: ts.saturating_add(cfg.authority_ttl_secs as i64),
        agreeing,
    })
}

/// What a sign may produce under an authority: the value, the IPNS sequence, the EOL and the record TTL.
#[derive(Debug, PartialEq, Eq)]
pub struct SignPlan {
    pub value: Vec<u8>,
    pub sequence: u64,
    pub eol: i64,
    pub ttl_secs: u64,
}

pub fn plan_sign(
    cfg: &Config,
    auth: Option<&Authority>,
    now: i64,
    lifetime_secs: u64,
    ttl_secs: u64,
    recovered: Option<(u64, &[u8])>,
) -> Result<SignPlan, String> {
    let auth = auth.ok_or("no anchor authority yet (no successful quorum read): nothing is signed")?;
    if auth.state.retired {
        return Err("the anchor is retired: signing stopped until the owner configures a new anchor".into());
    }
    if now + min_authority_left(cfg) >= auth.until {
        return Err(format!(
            "authority expired: the last quorum read (block {}) allows records only until {}; signing stopped",
            auth.block.number, auth.until
        ));
    }
    let sequence = cfg
        .sequence_offset
        .checked_add(auth.state.seq)
        .ok_or("sequenceOffset + anchor seq overflows u64: refusing")?;
    let value = format!("/ipfs/{}", auth.state.cid).into_bytes();
    if let Some((rseq, rval)) = recovered {
        if rseq > sequence {
            return Err(format!(
                "a record with sequence {rseq} exists above the anchor's {sequence} (sequenceOffset too low, or a regression): refusing"
            ));
        }
        if rseq == sequence && rval != value.as_slice() {
            return Err(format!("sequence {sequence} already carries a different value: refusing"));
        }
    }
    let eol = (now + lifetime_secs as i64).min(auth.until);
    let ttl_secs = ttl_secs.min(cfg.authority_ttl_secs).min((eol - now) as u64).max(1);
    Ok(SignPlan { value, sequence, eol, ttl_secs })
}

// ---- the round (I/O, one endpoint per step) ----------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Heads,
    Block,
    Read,
}

pub struct Round {
    phase: Phase,
    next: usize,
    heads: Vec<Option<u64>>,
    target: u64,
    blocks: Vec<Option<Block>>,
    agreed: Option<(Block, usize)>,
    results: Vec<Option<Vec<u8>>>,
    /// per endpoint: the last outcome of this round ("ok" or why not)
    pub outcomes: Vec<String>,
}

impl Round {
    pub fn new(cfg: &Config) -> Round {
        let n = cfg.endpoints.len();
        Round {
            phase: Phase::Heads,
            next: 0,
            heads: vec![None; n],
            target: 0,
            blocks: vec![None; n],
            agreed: None,
            results: vec![None; n],
            outcomes: vec!["not asked".into(); n],
        }
    }

    /// Advance by one endpoint's requests. Some(result) once the round is decided.
    pub fn step(
        &mut self,
        cfg: &Config,
        rpc: &mut dyn Rpc,
        hw: Option<&HighWater>,
        our_name_hash: &[u8; 32],
        now: &dyn Fn() -> i64,
    ) -> Option<Result<Authority, String>> {
        let n = cfg.endpoints.len();
        match self.phase {
            Phase::Heads => {
                let i = self.next;
                let ep = &cfg.endpoints[i];
                let r = (|| -> Result<u64, String> {
                    let chain = quantity(&rpc.call(ep, "eth_chainId", serde_json::json!([]))?, "eth_chainId")?;
                    if chain != cfg.chain_id {
                        return Err(format!("wrong chain {chain}"));
                    }
                    quantity(&rpc.call(ep, "eth_blockNumber", serde_json::json!([]))?, "eth_blockNumber")
                })();
                self.record(i, r.as_ref().map(|_| ()));
                self.heads[i] = r.ok();
                self.next += 1;
                if self.next < n {
                    return None;
                }
                self.target = match select_target(&self.heads, cfg.quorum, cfg.confirmations) {
                    Ok(t) => t,
                    Err(e) => return Some(Err(e)),
                };
                if let Some(h) = hw.filter(|h| h.applies(cfg)) {
                    if self.target < h.block {
                        return Some(Err(format!(
                            "regression: the quorum's confirmed block {} is below the accepted high-water {}",
                            self.target, h.block
                        )));
                    }
                }
                self.phase = Phase::Block;
                self.next = 0;
                None
            }
            Phase::Block => {
                while self.next < n && self.heads[self.next].is_none() {
                    self.next += 1;
                }
                if self.next < n {
                    let i = self.next;
                    let ep = &cfg.endpoints[i];
                    let params = serde_json::json!([format!("0x{:x}", self.target), false]);
                    let r = rpc.call(ep, "eth_getBlockByNumber", params).and_then(|b| {
                        if b.is_null() {
                            return Err("eth_getBlockByNumber: no such block".into());
                        }
                        let block = Block {
                            number: quantity(&b["number"], "block.number")?,
                            hash: data(&b["hash"], "block.hash")?.try_into().map_err(|_| "block.hash: not 32 bytes")?,
                            timestamp: quantity(&b["timestamp"], "block.timestamp")?,
                        };
                        if block.number != self.target {
                            return Err(format!("asked block {} and got {}", self.target, block.number));
                        }
                        Ok(block)
                    });
                    self.record(i, r.as_ref().map(|_| ()));
                    self.blocks[i] = r.ok();
                    self.next += 1;
                    return None;
                }
                match agree_block(&self.blocks, cfg.quorum) {
                    Ok(a) => self.agreed = Some(a),
                    Err(e) => return Some(Err(e)),
                }
                for (i, b) in self.blocks.iter().enumerate() {
                    if b.is_some() && b.as_ref() != self.agreed.as_ref().map(|a| &a.0) {
                        self.outcomes[i] = "disagreed on the block".into();
                    }
                }
                self.phase = Phase::Read;
                self.next = 0;
                None
            }
            Phase::Read => {
                let (block, _) = self.agreed.clone().expect("read phase without an agreed block");
                while self.next < n && self.blocks[self.next].as_ref() != Some(&block) {
                    self.next += 1;
                }
                if self.next < n {
                    let i = self.next;
                    let ep = &cfg.endpoints[i];
                    let at = serde_json::json!({"blockHash": hex0x(&block.hash), "requireCanonical": true});
                    let r = (|| -> Result<Vec<u8>, String> {
                        let code = data(&rpc.call(ep, "eth_getCode", serde_json::json!([hex0x(&cfg.contract), at]))?, "eth_getCode")?;
                        if keccak256(&code) != cfg.code_hash {
                            return Err(if code.is_empty() { "no contract code at the block".into() } else { "runtime code hash is not the pinned codeHash".into() });
                        }
                        let call = serde_json::json!({"to": hex0x(&cfg.contract), "data": hex0x(&state_selector())});
                        data(&rpc.call(ep, "eth_call", serde_json::json!([call, at]))?, "eth_call")
                    })();
                    self.record(i, r.as_ref().map(|_| ()));
                    self.results[i] = r.ok();
                    self.next += 1;
                    return None;
                }
                let (raw, agreeing) = match agree_result(&self.results, cfg.quorum) {
                    Ok(x) => x,
                    Err(e) => return Some(Err(e)),
                };
                for (i, r) in self.results.iter().enumerate() {
                    if r.as_ref().is_some_and(|r| *r != raw) {
                        self.outcomes[i] = "returned a different anchor state".into();
                    }
                }
                Some(finalize(cfg, &block, agreeing, &raw, hw, our_name_hash, now()))
            }
        }
    }

    fn record(&mut self, i: usize, r: Result<(), &String>) {
        self.outcomes[i] = match r {
            Ok(()) => "ok".into(),
            Err(e) => e.clone(),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::HashMap;

    const CID_A: &str = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    const CID_B: &str = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
    const NAME: [u8; 32] = [7; 32];

    fn cfg_json(rpcs: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "chainId": 31337, "contract": format!("0x{}", "11".repeat(20)), "codeHash": format!("0x{}", hex(&keccak256(b"code"))),
            "rpcs": rpcs, "quorum": 2, "confirmations": 2, "maxBlockAgeSecs": 30, "authorityTtlSecs": 600,
            "pollSecs": 30, "sequenceOffset": 100
        })
    }

    fn cfg() -> Config {
        parse_config(&cfg_json(&["http://127.0.0.1:1", "http://127.0.0.1:2", "http://127.0.0.1:3"]), 172_800).unwrap()
    }

    fn encode_state(seq: u64, cid: &str, retired: bool, name: [u8; 32]) -> Vec<u8> {
        let mut out = Vec::new();
        let u = |v: u64| {
            let mut w = [0u8; 32];
            w[24..].copy_from_slice(&v.to_be_bytes());
            w
        };
        let a = |b: u8| {
            let mut w = [0u8; 32];
            w[12..].copy_from_slice(&[b; 20]);
            w
        };
        out.extend_from_slice(&schema());
        out.extend_from_slice(&name);
        out.extend_from_slice(&u(seq));
        out.extend_from_slice(&u(288));
        out.extend_from_slice(&a(0xaa));
        out.extend_from_slice(&a(0xbb));
        out.extend_from_slice(&u(1_900_000_000));
        out.extend_from_slice(&u(retired as u64));
        out.extend_from_slice(&[0u8; 32]);
        out.extend_from_slice(&u(cid.len() as u64));
        let mut body = cid.as_bytes().to_vec();
        body.resize(cid.len().div_ceil(32) * 32, 0);
        out.extend_from_slice(&body);
        out
    }

    #[test]
    fn selector_and_schema_match_the_contract() {
        // vectors from foundry (`cast sig "state()"`, `cast keccak "{SCHEMA_ID}"`); the deployed contract is also
        // read by the anvil e2e (work/ipns-release-anchor/test/anchor-e2e.test.mjs)
        assert_eq!(hex(&state_selector()), "c19d93fb");
        assert_eq!(format!("0x{}", hex(&schema())), "0x73dc521327409662b51f8200280bce58adeb2b714cf74bd755090c0f190c0f61");
        // the Keccak-256 (not SHA3-256) empty-input vector
        assert_eq!(hex(&keccak256(b"")), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    }

    #[test]
    fn config_bounds() {
        assert!(parse_config(&cfg_json(&["http://127.0.0.1:1", "https://rpc.example:443"]), 172_800).is_ok());
        let err = |v: serde_json::Value| parse_config(&v, 172_800).err().unwrap();
        // same provider twice, even with another path, is one endpoint
        assert!(err(cfg_json(&["https://Rpc.Example/a", "https://rpc.example:443/b"])).contains("same provider as rpcs[0] (rpc.example)"));
        assert!(err(cfg_json(&["http://rpc.example", "https://b.example"])).contains("plain http is only for a loopback"));
        let mut v = cfg_json(&["http://127.0.0.1:1", "http://127.0.0.1:2"]);
        v["quorum"] = 1.into();
        assert!(err(v.clone()).contains("quorum"));
        v["quorum"] = 3.into();
        assert!(err(v.clone()).contains("quorum"));
        v["quorum"] = 2.into();
        v["confirmatons"] = 1.into();
        assert!(err(v.clone()).contains("unknown key `confirmatons`"));
        let mut v = cfg_json(&["http://127.0.0.1:1", "http://127.0.0.1:2"]);
        v["authorityTtlSecs"] = 100.into(); // < 4 * pollSecs
        assert!(err(v.clone()).contains("authorityTtlSecs"));
        v["authorityTtlSecs"] = 200_000.into(); // > lifetimeSecs
        assert!(err(v.clone()).contains("authorityTtlSecs"));
        let mut v = cfg_json(&["http://127.0.0.1:1", ""]);
        assert!(err(v.clone()).contains("rpcs[1] is empty"));
        // the URL is never echoed, even when refused for its syntax
        let e = err(cfg_json(&["https://user:SECRETPW@rpc.example/", "https://b.example"]));
        assert!(!e.contains("SECRETPW") && e.contains("no credentials"), "{e}");
        v["rpcs"] = serde_json::json!(["http://127.0.0.1:1", "http://127.0.0.1:2"]);
        v.as_object_mut().unwrap().remove("sequenceOffset");
        assert!(err(v.clone()).contains("sequenceOffset is required"));
        v["sequenceOffset"] = 0.into();
        v["codeHash"] = "0x1234".into();
        assert!(err(v).contains("codeHash must be 32 bytes"));
        // a provider key in the URL never appears in an error
        let e = err(cfg_json(&["http://rpc.example/v2/SECRETKEY", "https://b.example"]));
        assert!(!e.contains("SECRETKEY"), "{e}");
    }

    /// Root review: a public host is ONE provider whatever its port, path, case or trailing dot, and only a parsed
    /// numeric loopback address (or exact `localhost`) may use plain http. Outcomes only, so the same test runs against
    /// the pre-fix source as a negative control.
    #[test]
    fn rpc_endpoint_policy_refuses_aliases_and_fake_loopback() {
        let mut violations: Vec<String> = Vec::new();
        let mut check = |ok: bool, what: String| if !ok { violations.push(what) };
        let two = |a: &str, b: &str| {
            let mut v = cfg_json(&[a, b]);
            v["quorum"] = 2.into();
            parse_config(&v, 172_800)
        };
        // public aliases cannot make a quorum of two
        for (a, b) in [
            ("https://rpc.example:443/a", "https://rpc.example:8443/b"),
            ("https://RPC.Example./x", "https://rpc.example/y"),
            ("https://rpc.example/key-one", "https://rpc.example/key-two"),
            ("https://rpc.example", "https://rpc.example.:9000/"),
            ("https://[::ffff:8.8.8.8]/", "https://8.8.8.8:8443/"),
            ("https://[64:ff9b::808:808]/", "https://8.8.8.8/"),
        ] {
            check(two(a, b).is_err(), format!("{a} + {b} counted as two providers"));
        }
        // loopback spellings on one port are one local listener
        for (a, b) in [("http://localhost:8545", "http://127.0.0.1:8545"), ("http://[::1]:8545", "http://127.0.0.1:8545/x"),
                       ("http://localhost.:8545", "http://LOCALHOST:8545"), ("http://127.0.0.2:8545", "http://127.0.0.1:8545")] {
            check(two(a, b).is_err(), format!("{a} + {b} counted as two loopback listeners"));
        }
        check(two("http://127.0.0.1:1", "http://localhost:2").is_ok(), format!("distinct local ports are distinct test listeners"));
        // plain http only for a real loopback address or exact localhost
        for bad in ["http://127.evil.example/", "http://127.0.0.1.evil.example/", "http://localhost.evil.example/",
                    "http://evil-localhost/", "http://127.1/", "http://0x7f.0.0.1/", "http://127.0.0.256/", "http://127.0.0/",
                    "http://017.0.0.1/", "http://[::2]/", "http://[::ffff:8.8.8.8]/", "http://[64:ff9b::7f00:1]/"] {
            check(two(bad, "https://other.example").is_err(), format!("{bad} accepted as plain-http loopback"));
        }
        // syntax that hides or moves the host is refused, not guessed at
        for bad in ["https://user@rpc.example/", "https://user:pw@rpc.example/", "https://rpc.example/?key=1", "https://rpc.example/#f",
                    "https://rpc%2eexample/", "https://rpc.example:/", "https://rpc.example:0/", "https://rpc.example:65536/",
                    "https://rpc.example:+443/", "https://-bad.example/", "https://a..b/", "https://rpc .example/",
                    "https://rpc.exämple/", "https://rpc.example\\x/", "https://[::1/", "https://1.2.3.4.5/", "https://12345/"] {
            check(two(bad, "https://other.example").is_err(), format!("{bad} accepted"));
        }
        // what remains valid
        check(two("https://RPC.Example.:8443/v2/abc", "https://other.example").is_ok(), "a valid public URL refused".into());
        check(two("http://[::1]:8545/", "http://localhost:8546").is_ok(), "valid loopback listeners refused".into());
        // every violation, not only the first: the negative control shows each defect of the old parser
        assert!(violations.is_empty(), "{} policy violations:\n{}", violations.len(), violations.join("\n"));
    }

    #[test]
    fn rpc_url_canonical_parts_and_dialed_url() {
        let u = parse_rpc_url("https://RPC.Example.:8443/v2/abc").unwrap();
        assert_eq!((u.host.as_str(), u.port, u.path.as_str(), u.loopback), ("rpc.example", 8443, "/v2/abc", false));
        assert_eq!((u.identity(), u.label()), ("rpc.example".to_string(), "rpc.example:8443".to_string()));
        let d = u.dial();
        assert_eq!((d.https, d.host.as_str(), d.port, d.path.as_str()), (true, "rpc.example", 8443, "/v2/abc"));
        for (raw, id) in [("http://localhost:8545", "loopback:8545"), ("http://127.0.0.1:8545/", "loopback:8545"),
                          ("http://127.9.9.9:8545", "loopback:8545"), ("http://[::1]:8545", "loopback:8545"),
                          ("http://[::ffff:127.0.0.1]:8545", "loopback:8545"), ("https://[::ffff:8.8.8.8]", "8.8.8.8"),
                          ("https://[64:ff9b::808:808]:9", "8.8.8.8"), ("https://[2001:DB8::1]:8443", "[2001:db8::1]")] {
            assert_eq!(parse_rpc_url(raw).unwrap().identity(), id, "{raw}");
        }
        // an IPv6 literal is dialed without brackets (what a socket address wants) and keeps them in its label
        let v6 = parse_rpc_url("http://[::1]:8545/x").unwrap();
        assert_eq!((v6.dial().host.as_str(), v6.label().as_str()), ("::1", "[::1]:8545"));
        // the publisher's production list: three providers
        let prod = ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://mainnet.base.org"];
        let ids: Vec<String> = prod.iter().map(|u| parse_rpc_url(u).unwrap().identity()).collect();
        assert_eq!(ids, ["base-rpc.publicnode.com", "base.drpc.org", "mainnet.base.org"]);
        // webreq::Url::parse itself does NOT normalize (measured): which is why the dialed URL comes from parse_rpc_url
        assert_eq!(webreq::Url::parse("https://user@rpc.example/").unwrap().host, "user@rpc.example");
        assert_eq!(webreq::Url::parse("http://127.evil.example/").unwrap().host, "127.evil.example");
        assert_eq!(webreq::Url::parse("https://rpc.example:/x").unwrap().host, "rpc.example:");
    }

    #[test]
    fn target_is_bounded_by_honest_heads() {
        // one liar inflating its head cannot raise the target above what 2 endpoints report
        assert_eq!(select_target(&[Some(1_000_000), Some(100), Some(99)], 2, 2), Ok(98));
        // one liar reporting a low head only lowers liveness
        assert_eq!(select_target(&[Some(100), Some(100), Some(3)], 2, 2), Ok(98));
        assert!(select_target(&[Some(100), None, None], 2, 2).is_err());
        assert!(select_target(&[Some(1), Some(1), None], 2, 2).is_err());
    }

    #[test]
    fn block_and_result_agreement() {
        let b = |h: u8| Some(Block { number: 9, hash: [h; 32], timestamp: 5 });
        assert_eq!(agree_block(&[b(1), b(1), b(2)], 2).unwrap().1, 2);
        assert!(agree_block(&[b(1), b(2), None], 2).is_err());
        assert!(agree_block(&[b(1), b(1), b(2), b(2)], 2).unwrap_err().contains("fork"));
        let r = |x: u8| Some(vec![x; 4]);
        assert_eq!(agree_result(&[r(1), r(3), r(1)], 2).unwrap(), (vec![1; 4], 2));
        assert!(agree_result(&[r(1), r(3), None], 2).is_err());
    }

    #[test]
    fn strict_state_decoding() {
        let raw = encode_state(5, CID_A, false, NAME);
        let (s, n, st) = decode_state(&raw).unwrap();
        assert_eq!((s, n, st.seq, st.cid.as_str(), st.retired), (schema(), NAME, 5, CID_A, false));
        assert_eq!(st.delegate, [0xbb; 20]);
        let mut x = raw.clone();
        x[2 * 32] = 1; // seq high bits
        assert!(decode_state(&x).is_err());
        let mut x = raw.clone();
        x[3 * 32 + 31] = 0x40; // offset
        assert!(decode_state(&x).is_err());
        let mut x = raw.clone();
        x[7 * 32 + 31] = 2; // bool
        assert!(decode_state(&x).is_err());
        let mut x = raw.clone();
        x.push(0); // trailing byte
        assert!(decode_state(&x).is_err());
        let mut x = raw.clone();
        let last = x.len() - 1;
        x[last] = 1; // padding
        assert!(decode_state(&x).is_err());
        assert!(decode_state(&raw[..300]).is_err());
    }

    #[test]
    fn cid_validation() {
        assert!(valid_cid(CID_A));
        assert!(valid_cid(CID_B));
        assert!(!valid_cid("bafybeigdyrzt5sfp7udm7hu76uh7y26")); // truncated: multihash length mismatch
        assert!(!valid_cid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"));
        assert!(!valid_cid("baaaaaaa"));
        assert!(!valid_cid(&format!("{CID_A}/index.html")));
    }

    fn block(ts: u64) -> Block {
        Block { number: 50, hash: [3; 32], timestamp: ts }
    }

    #[test]
    fn finalize_freshness_binding_and_high_water() {
        let c = cfg();
        let raw = encode_state(5, CID_A, false, NAME);
        let ok = finalize(&c, &block(1000), 2, &raw, None, &NAME, 1030).unwrap();
        assert_eq!((ok.state.seq, ok.until, ok.read_at), (5, 1600, 1030));
        assert!(finalize(&c, &block(1000), 2, &raw, None, &NAME, 1031).unwrap_err().starts_with("stale"));
        assert!(finalize(&c, &block(1000), 2, &raw, None, &NAME, 1000 - 121).unwrap_err().contains("clock is wrong"));
        assert!(finalize(&c, &block(1000), 2, &raw, None, &[8; 32], 1000).unwrap_err().contains("nameHash"));
        let mut other_schema = raw.clone();
        other_schema[0] ^= 1;
        assert!(finalize(&c, &block(1000), 2, &other_schema, None, &NAME, 1000).unwrap_err().contains("schema"));
        let hw = HighWater { chain_id: 31337, contract: [0x11; 20], block: 51, seq: 5 };
        assert!(finalize(&c, &block(1000), 2, &raw, Some(&hw), &NAME, 1000).unwrap_err().contains("block 50 is below"));
        let hw = HighWater { block: 50, seq: 6, ..hw };
        assert!(finalize(&c, &block(1000), 2, &raw, Some(&hw), &NAME, 1000).unwrap_err().contains("seq 5 is below"));
        // a high-water for another contract (a migration) does not apply
        let other = HighWater { contract: [0x22; 20], block: 999, seq: 999, ..hw };
        assert!(finalize(&c, &block(1000), 2, &raw, Some(&other), &NAME, 1000).is_ok());
        let bad_cid = encode_state(5, "bafybeigdyrzt5sfp7udm7hu76uh7y26", false, NAME);
        assert!(finalize(&c, &block(1000), 2, &bad_cid, None, &NAME, 1000).unwrap_err().contains("not a base32 CIDv1"));
    }

    fn auth(seq: u64, until: i64, retired: bool) -> Authority {
        Authority {
            state: AnchorState { seq, cid: CID_A.into(), owner: [0; 20], delegate: [0; 20], delegate_until: 0, retired, successor: [0; 20] },
            block: block(1000),
            read_at: 1000,
            until,
            agreeing: 2,
        }
    }

    #[test]
    fn sign_plan_rules() {
        let c = cfg(); // offset 100, authorityTtl 600
        let value = format!("/ipfs/{CID_A}").into_bytes();
        let p = plan_sign(&c, Some(&auth(5, 1600, false)), 1010, 172_800, 3600, None).unwrap();
        assert_eq!(p, SignPlan { value: value.clone(), sequence: 105, eol: 1600, ttl_secs: 590 });
        // EOL never passes the authority bound; the lifetime still caps it when shorter
        assert_eq!(plan_sign(&c, Some(&auth(5, 1600, false)), 1010, 100, 3600, None).unwrap().eol, 1110);
        assert!(plan_sign(&c, None, 1010, 172_800, 3600, None).unwrap_err().contains("no anchor authority"));
        assert!(plan_sign(&c, Some(&auth(5, 1600, false)), 1540, 172_800, 3600, None).unwrap_err().contains("authority expired"));
        assert!(plan_sign(&c, Some(&auth(5, 1600, true)), 1010, 172_800, 3600, None).unwrap_err().contains("retired"));
        // cutover: a recovered sequence above the mapped one, or equal with another value, refuses
        assert!(plan_sign(&c, Some(&auth(5, 1600, false)), 1010, 172_800, 3600, Some((106, b"/ipfs/x"))).unwrap_err().contains("exists above"));
        assert!(plan_sign(&c, Some(&auth(5, 1600, false)), 1010, 172_800, 3600, Some((105, b"/ipfs/x"))).unwrap_err().contains("different value"));
        assert!(plan_sign(&c, Some(&auth(5, 1600, false)), 1010, 172_800, 3600, Some((105, &value))).is_ok());
        assert!(plan_sign(&c, Some(&auth(5, 1600, false)), 1010, 172_800, 3600, Some((104, b"/ipfs/x"))).is_ok());
        let mut big = cfg();
        big.sequence_offset = u64::MAX - 4;
        assert!(plan_sign(&big, Some(&auth(5, 1600, false)), 1010, 172_800, 3600, None).unwrap_err().contains("overflows"));
        big.sequence_offset = u64::MAX - 5;
        assert_eq!(plan_sign(&big, Some(&auth(5, 1600, false)), 1010, 172_800, 3600, None).unwrap().sequence, u64::MAX);
    }

    /// A scripted chain view per endpoint: what each one answers.
    #[derive(Clone)]
    enum Mode {
        Honest,
        Down,
        WrongChain,
        LieHead(u64),
        LieState,
        OtherCode,
        ForkBlock,
    }

    struct FakeRpc {
        modes: HashMap<String, Mode>,
        head: u64,
        state: Vec<u8>,
        clock: std::rc::Rc<Cell<i64>>,
        tick_per_call: i64,
        calls: Vec<(String, String, serde_json::Value)>,
    }

    impl Rpc for FakeRpc {
        fn call(&mut self, ep: &Endpoint, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
            self.clock.set(self.clock.get() + self.tick_per_call);
            self.calls.push((ep.id.clone(), method.to_string(), params.clone()));
            let mode = self.modes[&ep.id].clone();
            let block_hash = |fork: bool| hex0x(&[if fork { 9 } else { 3 }; 32]);
            match (mode, method) {
                (Mode::Down, _) => Err("connect: refused".into()),
                (Mode::WrongChain, "eth_chainId") => Ok("0x1".into()),
                (_, "eth_chainId") => Ok(format!("0x{:x}", 31337).into()),
                (Mode::LieHead(h), "eth_blockNumber") => Ok(format!("0x{h:x}").into()),
                (_, "eth_blockNumber") => Ok(format!("0x{:x}", self.head).into()),
                (m, "eth_getBlockByNumber") => {
                    let n = quantity(&params[0], "n")?;
                    if n > self.head {
                        return Ok(serde_json::Value::Null);
                    }
                    Ok(serde_json::json!({"number": format!("0x{n:x}"), "hash": block_hash(matches!(m, Mode::ForkBlock)), "timestamp": "0x3e8"}))
                }
                (m, "eth_getCode") => {
                    assert_eq!(params[1]["blockHash"], block_hash(false), "EIP-1898: code read by the agreed hash");
                    assert_eq!(params[1]["requireCanonical"], true);
                    Ok(hex0x(if matches!(m, Mode::OtherCode) { b"evil" } else { b"code" }).into())
                }
                (m, "eth_call") => {
                    assert_eq!(params[1]["blockHash"], block_hash(false), "EIP-1898: state read by the agreed hash");
                    let mut s = self.state.clone();
                    if matches!(m, Mode::LieState) {
                        s = encode_state(99, CID_B, false, NAME);
                    }
                    Ok(hex0x(&s).into())
                }
                _ => Err("unexpected".into()),
            }
        }
    }

    fn run(modes: [Mode; 3], tick: i64, hw: Option<&HighWater>) -> (Result<Authority, String>, Vec<String>, FakeRpc) {
        let c = cfg();
        let clock = std::rc::Rc::new(Cell::new(1000));
        let mut rpc = FakeRpc {
            modes: c.endpoints.iter().map(|e| e.id.clone()).zip(modes).collect(),
            head: 52,
            state: encode_state(5, CID_A, false, NAME),
            clock: clock.clone(),
            tick_per_call: tick,
            calls: Vec::new(),
        };
        let mut round = Round::new(&c);
        let now = || clock.get();
        for _ in 0..20 {
            if let Some(r) = round.step(&c, &mut rpc, hw, &NAME, &now) {
                return (r, round.outcomes, rpc);
            }
        }
        panic!("round did not finish");
    }

    use Mode::*;

    #[test]
    fn round_tolerates_fewer_than_quorum_faults() {
        let (r, outcomes, rpc) = run([Honest, Honest, Honest], 0, None);
        let a = r.unwrap();
        assert_eq!((a.state.seq, a.block.number, a.agreeing), (5, 50, 3));
        assert_eq!(outcomes, vec!["ok", "ok", "ok"]);
        // every endpoint was asked in every phase: no first-success read
        assert_eq!(rpc.calls.len(), 3 * 4 + 3);
        for faulty in [Down, WrongChain, LieHead(1 << 40), LieState, OtherCode, ForkBlock] {
            let (r, outcomes, _) = run([Honest, faulty.clone(), Honest], 0, None);
            let a = r.unwrap_or_else(|e| panic!("one faulty endpoint blocked the round: {e}"));
            assert_eq!((a.state.seq, a.state.cid.as_str()), (5, CID_A));
            if !matches!(faulty, LieHead(_)) {
                assert_ne!(outcomes[1], "ok"); // an inflated head is harmless, so it is not flagged
            }
        }
    }

    #[test]
    fn round_refuses_without_quorum() {
        assert!(run([Honest, Down, Down], 0, None).0.unwrap_err().contains("only 1 of the required 2"));
        assert!(run([Honest, LieState, Down], 0, None).0.unwrap_err().contains("same anchor state"));
        assert!(run([Honest, OtherCode, OtherCode], 0, None).0.unwrap_err().contains("same anchor state"));
        assert!(run([Honest, ForkBlock, Down], 0, None).0.unwrap_err().contains("agree on the block"));
        assert!(run([WrongChain, WrongChain, Honest], 0, None).0.is_err());
    }

    #[test]
    fn time_spent_reading_counts_against_freshness() {
        // the block's timestamp is 1000 and the round starts at 1000: with maxBlockAge 30, a round whose 15 calls
        // take 2 s each ends at 1030 (fresh) but at 3 s each ends at 1045 (stale), though it STARTED fresh
        assert!(run([Honest, Honest, Honest], 2, None).0.is_ok());
        assert!(run([Honest, Honest, Honest], 3, None).0.unwrap_err().starts_with("stale"));
    }

    #[test]
    fn round_refuses_regression() {
        let hw = HighWater { chain_id: 31337, contract: [0x11; 20], block: 51, seq: 5 };
        assert!(run([Honest, Honest, Honest], 0, Some(&hw)).0.unwrap_err().contains("confirmed block 50 is below"));
        let hw = HighWater { block: 40, seq: 6, ..hw };
        assert!(run([Honest, Honest, Honest], 0, Some(&hw)).0.unwrap_err().contains("seq 5 is below"));
    }

    /// The real transport: webreq over loopback TCP to minimal JSON-RPC servers (one answers, one refuses the
    /// connection, one accepts and never answers).
    #[test]
    fn http_transport_over_loopback() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let honest = |head: u64| {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            std::thread::spawn(move || {
                for s in l.incoming() {
                    let mut s = s.unwrap();
                    let mut buf = vec![0u8; 8192];
                    let mut got = 0;
                    let body = loop {
                        let n = s.read(&mut buf[got..]).unwrap();
                        got += n;
                        let text = String::from_utf8_lossy(&buf[..got]).to_string();
                        if let Some((head, body)) = text.split_once("\r\n\r\n") {
                            let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length: ")).unwrap().parse().unwrap();
                            if body.len() >= len {
                                break body.to_string();
                            }
                        }
                    };
                    let req: serde_json::Value = serde_json::from_str(&body).unwrap();
                    let at = || req["params"][1]["blockHash"].as_str().unwrap().to_string();
                    let result = match req["method"].as_str().unwrap() {
                        "eth_chainId" => serde_json::json!("0x7a69"),
                        "eth_blockNumber" => serde_json::json!(format!("0x{head:x}")),
                        "eth_getBlockByNumber" => serde_json::json!({"number": req["params"][0], "hash": hex0x(&[3; 32]), "timestamp": "0x3e8"}),
                        "eth_getCode" => { assert_eq!(at(), hex0x(&[3; 32])); serde_json::json!(hex0x(b"code")) }
                        "eth_call" => { assert_eq!(at(), hex0x(&[3; 32])); serde_json::json!(hex0x(&encode_state(5, CID_A, false, NAME))) }
                        _ => unreachable!(),
                    };
                    let out = serde_json::json!({"jsonrpc": "2.0", "id": req["id"], "result": result}).to_string();
                    let _ = write!(s, "HTTP/1.1 200 OK\r\ncontent-length: {}\r\n\r\n{out}", out.len());
                }
            });
            port
        };
        let a = honest(52);
        let b = honest(53);
        let refused = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port(); // listener dropped
        let hang = TcpListener::bind("127.0.0.1:0").unwrap();
        let hang_port = hang.local_addr().unwrap().port();
        let mut j = cfg_json(&[]);
        j["rpcs"] = serde_json::json!([
            format!("http://127.0.0.1:{a}/"), format!("http://127.0.0.1:{refused}/"),
            format!("http://127.0.0.1:{hang_port}/"), format!("http://127.0.0.1:{b}/key/abc")
        ]);
        j["rpcTimeoutSecs"] = 1.into();
        let c = parse_config(&j, 172_800).unwrap();
        let mut rpc = HttpRpc::new(c.rpc_timeout);
        let mut round = Round::new(&c);
        let now = || 1010;
        let started = std::time::Instant::now();
        let mut result = None;
        for _ in 0..30 {
            if let Some(r) = round.step(&c, &mut rpc, None, &NAME, &now) {
                result = Some(r);
                break;
            }
        }
        let a = result.expect("round finished").expect("quorum of the two live endpoints");
        assert_eq!((a.state.seq, a.block.number, a.agreeing), (5, 50, 2)); // 2nd-highest head 52, minus 2
        assert_eq!(round.outcomes[0], "ok");
        assert!(round.outcomes[1].contains("connect"), "{}", round.outcomes[1]);
        assert!(round.outcomes[2].contains("timeout"), "{}", round.outcomes[2]);
        assert!(started.elapsed() < Duration::from_secs(10), "the hanging endpoint is bounded by rpcTimeoutSecs");
        drop(hang);
    }
}
