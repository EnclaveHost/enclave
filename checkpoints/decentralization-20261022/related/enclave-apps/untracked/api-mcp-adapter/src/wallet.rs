//! Direct wallet sign-in: an EIP-4361 ("Sign-In with Ethereum") message the
//! visitor's own wallet signed, verified here. No issuer, no account API, no
//! outbound call: the deployment's config (on-chain, owner-chosen) names the
//! audience and the sites a message may be signed for, and this module is the
//! whole decision.
//!
//! It sits BESIDE Sign in with Enclave (sso.rs), never instead of it: an EST1
//! token still means what it always meant. The difference is who vouches.
//! EST1 is the platform's signature over "account X signed in"; EWS1 is the
//! wallet's own signature over "I sign in to <domain>, for deployment <id>,
//! until <time>", so the only parties are the visitor and this enclave.
//!
//! Token format (EWS1, "Enclave Wallet Sign-in v1"):
//!
//!   EWS1.<base64url(the exact EIP-4361 message, UTF-8)>.<base64url(65-byte r||s||v)>
//!
//! The signature is EIP-191 personal_sign over the message bytes - what every
//! wallet's SIWE prompt produces - so the browser carries the signed message
//! itself, byte-exact, with nothing to canonicalize.
//!
//! What is checked, every request (a stateless verifier has no other time):
//!   - the signature recovers the message's own address;
//!   - `domain` is one this deployment answers on (config `domains`, else the
//!     platform's ENCLAVE_HOSTS): a message a wallet signed for another site
//!     opens nothing here, which is SIWE's phishing defence carried through;
//!   - `URI` is that same origin, `Version` is 1, `Chain ID` is the configured
//!     chain (Base by default);
//!   - exactly ONE `urn:enclave:deployment:<id>` resource, naming this
//!     deployment (or one in `accept`): the audience, as EST1's `aud`;
//!   - `Issued At` not in the future (skew allowed), `Expiration Time` present,
//!     not passed, and no more than `ttl_secs` after `Issued At`;
//!     `Not Before`, when present, reached;
//!   - with `nonce_key` configured, the nonce carries this deployment's MAC over
//!     the domain, the address, the times and the audience, so only a message
//!     THIS deployment issued (GET /auth/wallet/challenge) is accepted, with the
//!     expiry it chose.
//!
//! Replay, said plainly: inside its window an EWS1 token is a bearer credential
//! exactly as an EST1 token is - whoever holds it may use it, which is what a
//! session is. What cannot be replayed is a signature made for another site,
//! another deployment, another chain, or after it expired. Expiry is the only
//! revocation, so the window is short and owner-capped.
//!
//! IDENTITY. A wallet sign-in names `wallet_0x<40 lowercase hex>`. That is a
//! namespace of its own on purpose: an EST1 `sub` is a relay ACCOUNT
//! (`acct_<hex>`, or a bare `0x` address from older mints), and this app cannot
//! know which wallets an account links. Mapping a wallet onto an account - or
//! onto a bare address some other signer vouched for - would hand one party's
//! data to another on an assumption, so nothing here ever does: the same wallet
//! signed in both ways is two identities until something that can prove the
//! link exists.
//!
//! CONTRACT WALLETS. An ordinary (EOA or EIP-7702-delegated) key's 65-byte
//! signature is checked here with no network at all. A smart-contract wallet's
//! signature needs the chain, so it is accepted only where the owner pinned
//! chain readers (`contract_wallets`, check_1271): deployed wallets through
//! EIP-1271 isValidSignature, and wallets not deployed yet through EIP-6492
//! (the signature carries the wallet's factory call; the readers simulate the
//! deployment and the check in one deployless call). Both are decided by the
//! same agreeing-snapshot quorum. The platform's own sign-in accepted both, so
//! a smart-wallet user who signed in through EST1 can sign in here too.
//!
//! This file is shared verbatim by eyesoff-ai, jot, depot and api-mcp-adapter
//! (like sso.rs, a copy per crate); the vector test pins all four to one format.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use sha3::{Digest, Keccak256};

/// The identity prefix a wallet sign-in carries (see IDENTITY above).
pub const ID_PREFIX: &str = "wallet_";
/// The resource naming the audience deployment.
pub const AUD_URN: &str = "urn:enclave:deployment:";
/// The longest window an owner may allow: EST1's own ceiling.
pub const MAX_TTL_SECS: u64 = 604_800;
const MIN_TTL_SECS: u64 = 300;
/// A token is a header value; anything this long is not one. Room for a
/// contract wallet's longer signature: a multisig's concatenated ECDSA, a
/// passkey's WebAuthn assertion inside a Safe signature, or an EIP-6492
/// wrapper carrying the wallet's whole factory call.
const MAX_TOKEN_BYTES: usize = 16384;
pub const MAX_SIGNATURE_BYTES: usize = 6144;
/// The resources an ACCOUNT LINK message carries beside the deployment: the
/// account being linked and the hash of the credential that proved it.
pub const LINK_ACCOUNT_URN: &str = "urn:enclave:link:account:";
pub const LINK_PROOF_URN: &str = "urn:enclave:link:proof:";
/// A link signature is an act, not a session: it is good for minutes.
pub const LINK_MAX_TTL_SECS: u64 = 600;
/// Base mainnet: the platform's chain. A wallet's EOA signature is valid on
/// every chain, so this pins what the visitor was shown, not the key.
pub const DEFAULT_CHAIN_ID: u64 = 8453;

/// The `wallet` block of an app config.
#[derive(Clone, Debug)]
pub struct WalletConfig {
    /// THIS deployment's id (0x + 64 hex): the audience a message must name
    pub audience: String,
    /// other deployment ids whose wallet sign-ins this app honours (a
    /// companion app serving another deployment's visitors)
    pub accept: Vec<String>,
    /// the hosts a message may be signed for (`host` or `host:port`,
    /// lowercase); empty = the hostnames the platform lists in ENCLAVE_HOSTS
    pub domains: Vec<String>,
    pub chain_id: u64,
    /// the session length the challenge offers and the ceiling a message may ask
    pub ttl_secs: u64,
    /// tolerated clock drift on `Issued At` / `Not Before`
    pub skew_secs: u64,
    /// true (default): the app's gated routes require a sign-in
    pub required: bool,
    /// MAC key binding nonces to challenges this deployment issued. Reference
    /// a deployment secret; a literal `$NAME` left unresolved fails CLOSED.
    pub nonce_key: Option<String>,
    /// optional address allowlist (lowercase 0x + 40 hex); empty = any wallet
    pub allow: Vec<String>,
    /// EIP-1271 contract wallets, only when the owner pins chain readers
    /// (`contract_wallets`). None: EOA signatures only, no chain involved.
    pub contract: Option<ContractCfg>,
}

/// `wallet.contract_wallets`: how a contract wallet's signature is checked.
/// Explicitly pinned JSON-RPC readers (distinct hosts). A verdict counts only
/// when at least `quorum` of them return the IDENTICAL snapshot - block
/// number, block hash, block time and isValidSignature's answer at that hash -
/// and no other snapshot also reaches `quorum` (check_1271). One reader can
/// neither approve nor veto; `quorum` colluding readers can do either, so
/// choose more than half of `rpcs`, from operators you do not expect to collude.
///
/// ELAPSED TIME. Readers are asked one after another: up to `rpcs.len()` head
/// requests, then up to two requests (header, call) per remaining reader, each
/// bounded by `timeout_secs`. A check can therefore take up to about
/// 3 x readers x timeout_secs (7 readers at 15 s: ~5 minutes). Freshness and
/// sign-in expiry are judged AFTER that, so readers that hang until their
/// timeout can push an honest check past `max_age_secs` (or past the sign-in's
/// expiry) and refuse it. Slow readers are tolerated only within that budget:
/// keep 3 x readers x timeout_secs well under `max_age_secs`.
#[derive(Clone, Debug, PartialEq)]
pub struct ContractCfg {
    pub rpcs: Vec<String>,
    pub quorum: usize,
    /// blocks behind the lowest reported head the check is made at
    pub confirmations: u64,
    /// how old that block may be, seconds
    pub max_age_secs: u64,
    /// per reader request
    pub timeout_secs: u64,
    pub max_bytes: usize,
}

impl WalletConfig {
    /// Parse the `wallet` object itself. Errors name the field at fault.
    pub fn parse(s: &serde_json::Value) -> Result<WalletConfig, String> {
        if !s.is_object() {
            return Err("wallet must be an object".into());
        }
        let str_of = |k: &str| s.get(k).and_then(|x| x.as_str()).map(str::trim).unwrap_or("").to_string();
        let audience = str_of("audience").to_lowercase();
        if !is_hex(&audience, 64) {
            return Err("wallet.audience must be this deployment's id (0x + 64 hex)".into());
        }
        let list = |k: &str| -> Result<Vec<String>, String> {
            match s.get(k) {
                None | Some(serde_json::Value::Null) => Ok(Vec::new()),
                Some(serde_json::Value::Array(a)) => a
                    .iter()
                    .map(|x| x.as_str().map(|x| x.trim().to_string()).ok_or(format!("wallet.{k} entries must be strings")))
                    .collect(),
                _ => Err(format!("wallet.{k} must be an array")),
            }
        };
        let mut accept = Vec::new();
        for id in list("accept")? {
            if !is_hex(&id, 64) {
                return Err("wallet.accept entries must be deployment ids (0x + 64 hex)".into());
            }
            accept.push(id.to_lowercase());
        }
        let mut domains = Vec::new();
        for d in list("domains")? {
            let h = norm_host(&d).ok_or(format!("wallet.domains entry {d:?} is not a host name"))?;
            if !domains.contains(&h) {
                domains.push(h);
            }
        }
        let mut allow = Vec::new();
        for a in list("allow")? {
            if !is_hex(&a, 40) {
                return Err("wallet.allow entries must be addresses (0x + 40 hex)".into());
            }
            allow.push(a.to_lowercase());
        }
        let num = |k: &str, d: u64| -> Result<u64, String> {
            match s.get(k) {
                None | Some(serde_json::Value::Null) => Ok(d),
                Some(v) => v.as_u64().ok_or(format!("wallet.{k} must be a non-negative integer")),
            }
        };
        let chain_id = num("chain_id", DEFAULT_CHAIN_ID)?;
        if chain_id == 0 {
            return Err("wallet.chain_id must be a chain id".into());
        }
        let ttl_secs = num("ttl_secs", 86_400)?.clamp(MIN_TTL_SECS, MAX_TTL_SECS);
        let skew_secs = num("skew_secs", 300)?.min(3600);
        let required = match s.get("required") {
            None | Some(serde_json::Value::Null) => true,
            Some(v) => v.as_bool().ok_or("wallet.required must be true or false")?,
        };
        let nonce_key = Some(str_of("nonce_key")).filter(|k| !k.is_empty());
        let contract = match s.get("contract_wallets") {
            None | Some(serde_json::Value::Null) => None,
            Some(c) => Some(ContractCfg::parse(c)?),
        };
        Ok(WalletConfig { audience, accept, domains, chain_id, ttl_secs, skew_secs, required, nonce_key, allow, contract })
    }

    /// The top-level `wallet` block of a whole config: Ok(None) when absent.
    pub fn from_config(v: &serde_json::Value) -> Result<Option<WalletConfig>, String> {
        match v.get("wallet") {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(w) => WalletConfig::parse(w).map(Some),
        }
    }

    /// The hosts a message may name: the configured list, else the platform's.
    pub fn allowed_domains(&self) -> Vec<String> {
        self.allowed_with(std::env::var("ENCLAVE_HOSTS").ok().as_deref())
    }

    /// As allowed_domains, with the platform's list passed in.
    pub fn allowed_with(&self, enclave_hosts: Option<&str>) -> Vec<String> {
        if !self.domains.is_empty() {
            return self.domains.clone();
        }
        enclave_hosts.unwrap_or_default().split(',').filter_map(norm_host).collect()
    }

    fn key(&self) -> Result<Option<&str>, String> {
        match self.nonce_key.as_deref() {
            None => Ok(None),
            // the platform leaves a missing secret's placeholder literal; a key
            // printed in the published config would be no key at all
            Some(k) if k.starts_with('$') => Err("wallet sign-in is misconfigured: wallet.nonce_key names a secret that is not set".into()),
            Some(k) => Ok(Some(k)),
        }
    }
}

impl ContractCfg {
    pub fn parse(c: &serde_json::Value) -> Result<ContractCfg, String> {
        let rpcs: Vec<String> = c
            .get("rpcs")
            .and_then(|r| r.as_array())
            .ok_or("wallet.contract_wallets.rpcs must be a list of JSON-RPC URLs")?
            .iter()
            .map(|u| u.as_str().map(|u| u.trim().to_string()).ok_or("wallet.contract_wallets.rpcs entries must be strings".to_string()))
            .collect::<Result<_, _>>()?;
        if !(2..=7).contains(&rpcs.len()) {
            return Err("wallet.contract_wallets.rpcs must name 2 to 7 readers".into());
        }
        // Each URL is parsed strictly, and each must be a distinct READER: one
        // public host is one vote however its port, path, case or trailing dot
        // is spelled. Diagnostics name the entry by index and canonical host,
        // never by URL - a path or query may carry an API key.
        let mut seen: Vec<(String, usize)> = Vec::new();
        for (i, u) in rpcs.iter().enumerate() {
            let r = RpcUrl::parse(u).map_err(|why| format!("wallet.contract_wallets.rpcs[{i}] is not a usable reader URL: {why}"))?;
            if let Some((_, j)) = seen.iter().find(|(id, _)| *id == r.reader_id()) {
                return Err(format!(
                    "wallet.contract_wallets.rpcs[{i}] is the same reader as rpcs[{j}] ({}): each reader must be a distinct host",
                    r.reader_id()
                ));
            }
            seen.push((r.reader_id(), i));
        }
        let num = |k: &str, d: u64| -> Result<u64, String> {
            match c.get(k) {
                None | Some(serde_json::Value::Null) => Ok(d),
                Some(v) => v.as_u64().ok_or(format!("wallet.contract_wallets.{k} must be a non-negative integer")),
            }
        };
        let quorum = num("quorum", 2)? as usize;
        if quorum < 2 || quorum > rpcs.len() {
            return Err("wallet.contract_wallets.quorum must be at least 2 and at most the number of readers".into());
        }
        Ok(ContractCfg {
            rpcs,
            quorum,
            confirmations: num("confirmations", 2)?.min(64),
            max_age_secs: num("max_age_secs", 120)?.clamp(10, 3600),
            timeout_secs: num("timeout_secs", 5)?.clamp(1, 15),
            max_bytes: (num("max_bytes", 65_536)? as usize).clamp(4096, 1 << 20),
        })
    }
}

/// A pinned reader URL, parsed strictly. Grammar accepted, nothing else:
///
///   ("https" | "http") "://" host [":" port] ["/" path]
///   host = DNS name (letters, digits, hyphens; labels 1..63, total <= 253,
///          one optional trailing dot) | dotted-quad IPv4 | "[" IPv6 "]"
///   port = 1..65535 in decimal, no sign
///   path = letters, digits and "-._~/" only
///
/// No credentials (`@`), query (`?`), fragment (`#`), percent-escapes,
/// whitespace or non-ASCII anywhere. A name whose last label is numeric must
/// be a valid dotted quad (so `127.1` or `0x7f.0.0.1` are refused, not
/// guessed at). Plain http only on loopback, a local node under test.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcUrl {
    pub https: bool,
    /// canonical: lowercase, no trailing dot; IPv4 dotted quad; IPv6 in
    /// brackets in its compressed form (an IPv4-mapped one as its IPv4)
    pub host: String,
    pub port: u16,
    pub loopback: bool,
}

impl RpcUrl {
    pub fn parse(u: &str) -> Result<RpcUrl, &'static str> {
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
        let (host_part, port_part) = if let Some(v6) = authority.strip_prefix('[') {
            let (inside, after) = v6.split_once(']').ok_or("an IPv6 host needs its closing bracket")?;
            let port = match after {
                "" => None,
                p => Some(p.strip_prefix(':').ok_or("junk after the IPv6 host")?),
            };
            let ip: std::net::Ipv6Addr = inside.parse().map_err(|_| "not an IPv6 address")?;
            let host = match ip.to_ipv4_mapped() {
                Some(v4) => v4.to_string(),
                None => format!("[{ip}]"),
            };
            (host, port)
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
            let numeric_tail = labels.last().is_some_and(|l| l.bytes().all(|b| b.is_ascii_digit()));
            if numeric_tail {
                let ip: std::net::Ipv4Addr = h.parse().map_err(|_| "a numeric host must be a dotted-quad IPv4 address")?;
                (ip.to_string(), p)
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
                (h, p)
            }
        };
        let port = match port_part {
            None => if https { 443 } else { 80 },
            Some(p) if !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()) => {
                p.parse::<u16>().ok().filter(|n| *n > 0).ok_or("the port must be 1..65535")?
            }
            Some(_) => return Err("the port must be 1..65535"),
        };
        let loopback = matches!(host_part.as_str(), "localhost" | "127.0.0.1" | "[::1]");
        if !https && !loopback {
            return Err("plain http is only for a loopback test node");
        }
        Ok(RpcUrl { https, host: host_part, port, loopback })
    }

    /// Who answers: one public HOST is one reader whatever its port or path;
    /// on loopback (a test rig, where every reader is the same machine) the
    /// port tells readers apart, and the three loopback spellings are one.
    pub fn reader_id(&self) -> String {
        if self.loopback {
            format!("loopback port {}", self.port)
        } else {
            self.host.clone()
        }
    }
}

/// What a verified wallet sign-in says. Not every app sharing this file reads
/// every field.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct Claims {
    /// `wallet_0x<lowercase address>`: the identity (see IDENTITY above)
    pub sub: String,
    /// the lowercase address
    pub address: String,
    pub domain: String,
    pub aud: String,
    pub iat: u64,
    pub exp: u64,
}

/// The identity a wallet address signs in as.
pub fn identity_of(address: &str) -> Option<String> {
    is_hex(address, 40).then(|| format!("{ID_PREFIX}{}", address.to_lowercase()))
}

/// Is `sub` a wallet identity? Returns its canonical form.
pub fn canonical_wallet_sub(sub: &str) -> Option<String> {
    let addr = sub.strip_prefix(ID_PREFIX)?;
    identity_of(addr)
}

fn is_hex(s: &str, digits: usize) -> bool {
    s.len() == 2 + digits && s.starts_with("0x") && s[2..].chars().all(|c| c.is_ascii_hexdigit())
}

/// A configured or presented host, normalized: lowercase, no scheme, no
/// trailing slash, no default port. None for anything that is not a bare
/// host[:port] - a wildcard, a path, credentials, whitespace.
pub fn norm_host(s: &str) -> Option<String> {
    let mut h = s.trim().to_ascii_lowercase();
    for scheme in ["https://", "http://"] {
        if let Some(rest) = h.strip_prefix(scheme) {
            h = rest.to_string();
        }
    }
    let h = h.trim_end_matches('/');
    let h = h.strip_suffix(":443").unwrap_or(h);
    let ok = !h.is_empty()
        && h.len() <= 253
        && !h.starts_with('.')
        && !h.starts_with(':')
        && h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']'));
    ok.then(|| h.to_string())
}

/// Loopback hosts are the one place a plain-http origin is admissible (local
/// `wasmtime serve`); everything else signs for https.
fn is_loopback(host: &str) -> bool {
    let name = if host.starts_with('[') {
        host.split(']').next().map(|s| format!("{s}]")).unwrap_or_default()
    } else {
        host.split(':').next().unwrap_or("").to_string()
    };
    matches!(name.as_str(), "localhost" | "127.0.0.1" | "[::1]")
}

fn keccak(bytes: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(bytes);
    h.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// EIP-191 personal-message hash: what a wallet's personal_sign signs.
fn eip191_hash(msg: &[u8]) -> [u8; 32] {
    let mut h = Keccak256::new();
    h.update(format!("\u{19}Ethereum Signed Message:\n{}", msg.len()).as_bytes());
    h.update(msg);
    h.finalize().into()
}

fn address_of(vk: &VerifyingKey) -> String {
    let point = vk.to_encoded_point(false);
    format!("0x{}", hex(&keccak(&point.as_bytes()[1..])[12..]))
}

/// EIP-55 mixed-case spelling, which EIP-4361 requires in the message.
pub fn checksum_address(addr: &str) -> Option<String> {
    if !is_hex(addr, 40) {
        return None;
    }
    let lower = addr[2..].to_ascii_lowercase();
    let h = keccak(lower.as_bytes());
    let mut out = String::from("0x");
    for (i, c) in lower.chars().enumerate() {
        let nib = (h[i / 2] >> (if i % 2 == 0 { 4 } else { 0 })) & 0xf;
        out.push(if c.is_ascii_alphabetic() && nib >= 8 { c.to_ascii_uppercase() } else { c });
    }
    Some(out)
}

// ---- RFC 3339 (the message's timestamps) ------------------------------------

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp as i64 + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYY-MM-DDTHH:MM:SSZ` for a unix time.
pub fn rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// RFC 3339 date-time to unix seconds (fractions dropped). Strict: the
/// grammar EIP-4361 names, nothing looser.
pub fn parse_rfc3339(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<u32> {
        let t = s.get(r)?;
        t.bytes().all(|c| c.is_ascii_digit()).then(|| t.parse().ok())?
    };
    let (y, mo, d, h, mi, se) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&mo) || d == 0 || d > dim[mo as usize - 1] || h > 23 || mi > 59 || se > 59 {
        return None;
    }
    let mut rest = &s[19..];
    if let Some(frac) = rest.strip_prefix('.') {
        let n = frac.bytes().take_while(|c| c.is_ascii_digit()).count();
        if n == 0 {
            return None;
        }
        rest = &frac[n..];
    }
    let offset: i64 = match rest {
        "Z" | "z" => 0,
        _ => {
            let rb = rest.as_bytes();
            if rb.len() != 6 || !matches!(rb[0], b'+' | b'-') || rb[3] != b':' {
                return None;
            }
            let oh: i64 = rest[1..3].parse().ok().filter(|_| rest[1..3].bytes().all(|c| c.is_ascii_digit()))?;
            let om: i64 = rest[4..6].parse().ok().filter(|_| rest[4..6].bytes().all(|c| c.is_ascii_digit()))?;
            if oh > 23 || om > 59 {
                return None;
            }
            let o = oh * 3600 + om * 60;
            if rb[0] == b'+' { o } else { -o }
        }
    };
    let t = days_from_civil(y as i64, mo, d) * 86_400 + (h * 3600 + mi * 60 + se) as i64 - offset;
    u64::try_from(t).ok()
}

// ---- the message -------------------------------------------------------------

/// The fields of an EIP-4361 message this verifier reads.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Siwe {
    pub domain: String,
    pub address: String,
    pub statement: Option<String>,
    pub uri: String,
    pub version: String,
    pub chain_id: u64,
    pub nonce: String,
    pub issued_at: String,
    pub expiration_time: Option<String>,
    pub not_before: Option<String>,
    pub request_id: Option<String>,
    pub resources: Vec<String>,
}

const PREAMBLE: &str = " wants you to sign in with your Ethereum account:";

impl Siwe {
    /// The message text, exactly as EIP-4361 lays it out.
    pub fn render(&self) -> String {
        let mut m = format!("{}{PREAMBLE}\n{}\n\n", self.domain, self.address);
        if let Some(s) = &self.statement {
            m.push_str(s);
            m.push('\n');
        }
        m.push_str(&format!(
            "\nURI: {}\nVersion: {}\nChain ID: {}\nNonce: {}\nIssued At: {}",
            self.uri, self.version, self.chain_id, self.nonce, self.issued_at
        ));
        if let Some(e) = &self.expiration_time {
            m.push_str(&format!("\nExpiration Time: {e}"));
        }
        if let Some(n) = &self.not_before {
            m.push_str(&format!("\nNot Before: {n}"));
        }
        if let Some(r) = &self.request_id {
            m.push_str(&format!("\nRequest ID: {r}"));
        }
        if !self.resources.is_empty() {
            m.push_str("\nResources:");
            for r in &self.resources {
                m.push_str(&format!("\n- {r}"));
            }
        }
        m
    }

    /// Strict parse: the EIP-4361 line grammar, fields in their fixed order,
    /// LF only. Anything else is refused rather than guessed at.
    pub fn parse(msg: &str) -> Result<Siwe, String> {
        const BAD: &str = "malformed wallet sign-in message";
        if msg.contains('\r') {
            return Err(BAD.into());
        }
        let lines: Vec<&str> = msg.split('\n').collect();
        let mut i = 0;
        let mut next = || -> Result<&str, String> {
            let l = lines.get(i).copied().ok_or(BAD)?;
            i += 1;
            Ok(l)
        };
        let mut out = Siwe::default();
        out.domain = next()?.strip_suffix(PREAMBLE).ok_or(BAD)?.to_string();
        out.address = next()?.to_string();
        if !is_hex(&out.address, 40) || !next()?.is_empty() {
            return Err(BAD.into());
        }
        let l = next()?;
        if !l.is_empty() {
            if l.starts_with("URI: ") {
                return Err(BAD.into());
            }
            out.statement = Some(l.to_string());
            if !next()?.is_empty() {
                return Err(BAD.into());
            }
        }
        let field = |l: &str, name: &str| l.strip_prefix(name).map(str::to_string).ok_or_else(|| BAD.to_string());
        out.uri = field(next()?, "URI: ")?;
        out.version = field(next()?, "Version: ")?;
        out.chain_id = field(next()?, "Chain ID: ")?.parse().map_err(|_| BAD)?;
        out.nonce = field(next()?, "Nonce: ")?;
        out.issued_at = field(next()?, "Issued At: ")?;
        let mut rest = lines[i..].iter().copied().peekable();
        if let Some(v) = rest.peek().and_then(|l| l.strip_prefix("Expiration Time: ")) {
            out.expiration_time = Some(v.to_string());
            rest.next();
        }
        if let Some(v) = rest.peek().and_then(|l| l.strip_prefix("Not Before: ")) {
            out.not_before = Some(v.to_string());
            rest.next();
        }
        if let Some(v) = rest.peek().and_then(|l| l.strip_prefix("Request ID: ")) {
            out.request_id = Some(v.to_string());
            rest.next();
        }
        if rest.peek() == Some(&"Resources:") {
            rest.next();
            for l in rest.by_ref() {
                out.resources.push(l.strip_prefix("- ").ok_or(BAD)?.to_string());
            }
        }
        if rest.next().is_some() {
            return Err(BAD.into());
        }
        Ok(out)
    }
}

fn nonce_mac(key: &str, client: &str, m: &Siwe, aud: &str) -> String {
    let mut h = Keccak256::new();
    h.update((key.len() as u64).to_le_bytes());
    h.update(key.as_bytes());
    // the resources name the ACT (a sign-in, or linking one account): a
    // challenge issued for one is never good for the other
    let bound = format!(
        "EWN1|{client}|{}|{}|{}|{}|{}|{}|{}",
        m.domain,
        m.address.to_lowercase(),
        m.issued_at,
        m.expiration_time.as_deref().unwrap_or(""),
        aud,
        m.chain_id,
        m.resources.join(",")
    );
    h.update(bound.as_bytes());
    hex(&h.finalize()[..16])
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// The message GET /auth/wallet/challenge hands the page to sign: this
/// deployment's domain (the request's own Host, if it is one of ours), the
/// visitor's address, the configured chain and window, and the audience.
/// `client_nonce` is the page's own randomness (16..64 alphanumerics); with a
/// nonce_key the nonce also carries this deployment's MAC.
pub fn challenge(cfg: &WalletConfig, host: Option<&str>, address: &str, client_nonce: &str, now: u64) -> Result<String, String> {
    compose(
        cfg,
        host,
        address,
        client_nonce,
        now,
        "Sign in to this app with your wallet. This is not a transaction and costs nothing; it proves you hold this address.".into(),
        Vec::new(),
        cfg.ttl_secs,
    )
}

/// The statement an account-link message carries, word for word: what the
/// wallet shows the person before they sign.
pub fn link_statement(account: &str) -> String {
    format!(
        "Link the Enclave account {account} to this wallet on this app. Sign only if you started this yourself: \
         from now on this wallet can act as that account here. This is not a transaction."
    )
}

/// Is `sub` one of the platform's ACCOUNT shapes (what an EST1 token or a
/// derived key names): `acct_…` or a lowercase bare address. A wallet
/// identity is never an account to link.
pub fn is_account_sub(sub: &str) -> bool {
    let acct = (6..=80).contains(&sub.len())
        && sub.starts_with("acct_")
        && sub[5..].chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    acct || (is_hex(sub, 40) && sub == sub.to_lowercase())
}

/// The digest a link message names its account credential by: keccak-256
/// of the credential's exact bytes (the token as presented).
pub fn proof_hash(credential: &str) -> [u8; 32] {
    keccak(credential.as_bytes())
}

/// The message an app's link-challenge route hands the page: the same frame
/// as a sign-in, but the ACT is linking `account`, proven by `credential`
/// (which the app has ALREADY verified names that account), and the window is
/// minutes, not a session.
#[allow(clippy::too_many_arguments)]
pub fn link_challenge(
    cfg: &WalletConfig,
    host: Option<&str>,
    address: &str,
    client_nonce: &str,
    now: u64,
    account: &str,
    credential: &str,
) -> Result<String, String> {
    if !is_account_sub(account) {
        return Err("only an Enclave account (acct_… or a lowercase 0x address) can be linked".into());
    }
    let proof = hex(&proof_hash(credential));
    compose(
        cfg,
        host,
        address,
        client_nonce,
        now,
        link_statement(account),
        vec![format!("{LINK_ACCOUNT_URN}{account}"), format!("{LINK_PROOF_URN}{proof}")],
        cfg.ttl_secs.min(LINK_MAX_TTL_SECS),
    )
}

#[allow(clippy::too_many_arguments)]
fn compose(
    cfg: &WalletConfig,
    host: Option<&str>,
    address: &str,
    client_nonce: &str,
    now: u64,
    statement: String,
    extra: Vec<String>,
    ttl: u64,
) -> Result<String, String> {
    let domain = host
        .and_then(norm_host)
        .filter(|h| cfg.allowed_domains().contains(h))
        .ok_or("this host is not one this deployment accepts wallet sign-ins for (wallet.domains)")?;
    let address = checksum_address(address.trim()).ok_or("address must be 0x + 40 hex")?;
    if !(16..=64).contains(&client_nonce.len()) || !client_nonce.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("nonce must be 16 to 64 letters and digits".into());
    }
    let scheme = if is_loopback(&domain) { "http" } else { "https" };
    let mut m = Siwe {
        uri: format!("{scheme}://{domain}/"),
        domain,
        address,
        statement: Some(statement),
        version: "1".into(),
        chain_id: cfg.chain_id,
        nonce: client_nonce.to_string(),
        issued_at: rfc3339(now),
        expiration_time: Some(rfc3339(now + ttl)),
        resources: std::iter::once(format!("{AUD_URN}{}", cfg.audience)).chain(extra).collect(),
        ..Siwe::default()
    };
    if let Some(key) = cfg.key()? {
        m.nonce = format!("{client_nonce}{}", nonce_mac(key, client_nonce, &m, &cfg.audience));
    }
    Ok(m.render())
}

/// Assemble the token from the signed message and the wallet's signature
/// (0x-hex, 65 bytes) - what the page does after personal_sign.
pub fn token(message: &str, signature_hex: &str) -> Option<String> {
    let s = signature_hex.strip_prefix("0x").unwrap_or(signature_hex);
    if s.is_empty() || s.len() % 2 != 0 || s.len() > 2 * MAX_SIGNATURE_BYTES {
        return None;
    }
    let bytes: Option<Vec<u8>> = (0..s.len() / 2).map(|i| u8::from_str_radix(s.get(2 * i..2 * i + 2)?, 16).ok()).collect();
    Some(format!("EWS1.{}.{}", URL_SAFE_NO_PAD.encode(message.as_bytes()), URL_SAFE_NO_PAD.encode(bytes?)))
}

/// How a reader is reached: POST `body` (JSON-RPC) to `url`, within
/// `timeout_secs`, reading at most `max_bytes`. Each app supplies its own
/// outbound HTTP; this file makes no call itself.
pub type RpcPost<'a> = &'a mut dyn ChainReaders;

/// The pinned readers as the app reaches them, and the app's clock. The clock
/// is asked again AFTER the reads, so a slow round of readers cannot carry a
/// block or a sign-in past its freshness: the decision is made at decision
/// time, not at the time the request arrived.
pub trait ChainReaders {
    /// POST `body` (JSON-RPC) to `url` within `timeout_secs`, reading at most `max_bytes`
    fn post(&mut self, url: &str, body: &[u8], timeout_secs: u64, max_bytes: usize) -> Result<Vec<u8>, String>;
    /// unix seconds, now
    fn now(&self) -> u64;
}

/// An app's outbound HTTP function as ChainReaders, on the system clock.
pub struct HttpReaders<F: FnMut(&str, &[u8], u64, usize) -> Result<Vec<u8>, String>>(pub F);

impl<F: FnMut(&str, &[u8], u64, usize) -> Result<Vec<u8>, String>> ChainReaders for HttpReaders<F> {
    fn post(&mut self, url: &str, body: &[u8], timeout_secs: u64, max_bytes: usize) -> Result<Vec<u8>, String> {
        (self.0)(url, body, timeout_secs, max_bytes)
    }
    fn now(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    }
}

/// What a verification is FOR. A sign-in message never links an account, and
/// a link message never opens a session: the resources and the statement say
/// which act the wallet agreed to.
pub enum Act<'a> {
    Session,
    /// linking `account`, proven by the credential whose proof_hash is `proof`
    Link { account: &'a str, proof: [u8; 32] },
}

/// Verify one EWS1 sign-in. Errors are user-facing prose for the 401 body.
/// EOA signatures only: a deployment with `contract_wallets` checks those
/// through verify_with, with the app's outbound HTTP.
pub fn verify(cfg: &WalletConfig, token: &str, now: u64) -> Result<Claims, String> {
    verify_act(cfg, token, now, Act::Session, None)
}

/// verify, with chain readers for contract wallets when the config pins them.
pub fn verify_with(cfg: &WalletConfig, token: &str, now: u64, rpc: Option<RpcPost>) -> Result<Claims, String> {
    verify_act(cfg, token, now, Act::Session, rpc)
}

/// Verify one EWS1 token for the act it must name. Everything that needs no
/// network is checked first; a contract wallet's chain check comes last.
pub fn verify_act(cfg: &WalletConfig, token: &str, now: u64, act: Act, rpc: Option<RpcPost>) -> Result<Claims, String> {
    if token.len() > MAX_TOKEN_BYTES {
        return Err("malformed wallet sign-in".into());
    }
    let rest = token.strip_prefix("EWS1.").ok_or("not a wallet sign-in")?;
    let (msg_b64, sig_b64) = rest.split_once('.').ok_or("malformed wallet sign-in")?;
    let msg_bytes = URL_SAFE_NO_PAD.decode(msg_b64).map_err(|_| "malformed wallet sign-in")?;
    let msg = String::from_utf8(msg_bytes).map_err(|_| "malformed wallet sign-in")?;
    let m = Siwe::parse(&msg)?;
    let sig_bytes = URL_SAFE_NO_PAD.decode(sig_b64).map_err(|_| "malformed wallet signature")?;
    if sig_bytes.is_empty() || sig_bytes.len() > MAX_SIGNATURE_BYTES {
        return Err("malformed wallet signature".into());
    }
    let address = m.address.to_lowercase();

    // where the wallet was told it was signing in
    let domain = norm_host(&m.domain).filter(|d| *d == m.domain.to_ascii_lowercase()).ok_or("malformed wallet sign-in message")?;
    if !cfg.allowed_domains().contains(&domain) {
        return Err("wallet sign-in was signed for a different site".into());
    }
    let scheme = if is_loopback(&domain) { "http" } else { "https" };
    let origin_ok = m
        .uri
        .strip_prefix(&format!("{scheme}://"))
        .map(|r| r.split(['/', '?', '#']).next().unwrap_or(""))
        .and_then(norm_host)
        .is_some_and(|h| h == domain);
    if !origin_ok {
        return Err("wallet sign-in URI is not the site it was signed for".into());
    }
    if m.version != "1" {
        return Err("unsupported wallet sign-in version".into());
    }
    if m.chain_id != cfg.chain_id {
        return Err("wallet sign-in names a different chain".into());
    }

    // whom it is for: exactly one deployment, and one this app serves
    let auds: Vec<&str> = m.resources.iter().filter_map(|r| r.strip_prefix(AUD_URN)).collect();
    let [aud] = auds.as_slice() else {
        return Err("wallet sign-in must name exactly one deployment".into());
    };
    let aud = aud.to_lowercase();
    if !is_hex(&aud, 64) {
        return Err("malformed wallet sign-in message".into());
    }

    // what for: a session, or linking exactly one account - never both, and
    // a link only for THIS deployment, never one it merely accepts
    let link_accounts: Vec<&str> = m.resources.iter().filter_map(|r| r.strip_prefix(LINK_ACCOUNT_URN)).collect();
    let link_proofs: Vec<&str> = m.resources.iter().filter_map(|r| r.strip_prefix(LINK_PROOF_URN)).collect();
    let mut max_ttl = cfg.ttl_secs;
    match &act {
        Act::Session => {
            if m.resources.iter().any(|r| r.starts_with("urn:enclave:link:")) {
                return Err("this is an account-link signature, not a sign-in".into());
            }
            if aud != cfg.audience && !cfg.accept.contains(&aud) {
                return Err("wallet sign-in was made for a different deployment".into());
            }
        }
        Act::Link { account, proof } => {
            if aud != cfg.audience {
                return Err("account link was signed for a different deployment".into());
            }
            let ([a], [p]) = (link_accounts.as_slice(), link_proofs.as_slice()) else {
                return Err("not an account-link signature (it must name exactly one account and one proof)".into());
            };
            if *a != *account || m.statement.as_deref() != Some(link_statement(account).as_str()) {
                return Err("the wallet signed a link for a different account".into());
            }
            if !ct_eq(p.to_ascii_lowercase().as_bytes(), hex(proof).as_bytes()) {
                return Err("the wallet signed a link for a different account credential".into());
            }
            if m.resources.len() != 3 {
                return Err("an account-link signature names nothing but the deployment, the account and the proof".into());
            }
            max_ttl = max_ttl.min(LINK_MAX_TTL_SECS);
        }
    }

    // when
    let iat = parse_rfc3339(&m.issued_at).ok_or("malformed wallet sign-in message")?;
    let exp = m
        .expiration_time
        .as_deref()
        .ok_or("wallet sign-in has no expiration time")
        .and_then(|e| parse_rfc3339(e).ok_or("malformed wallet sign-in message"))?;
    if iat > now.saturating_add(cfg.skew_secs) {
        return Err("wallet sign-in is not valid yet".into());
    }
    if let Some(nb) = &m.not_before {
        let nb = parse_rfc3339(nb).ok_or("malformed wallet sign-in message")?;
        if nb > now.saturating_add(cfg.skew_secs) {
            return Err("wallet sign-in is not valid yet".into());
        }
    }
    if now >= exp {
        return Err("wallet sign-in expired; sign in again".into());
    }
    if exp <= iat || exp - iat > max_ttl {
        return Err("wallet sign-in asks for a longer session than this deployment allows".into());
    }

    // the nonce: SIWE's minimum shape always, this deployment's MAC when keyed
    if m.nonce.len() < 8 || !m.nonce.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("malformed wallet sign-in message".into());
    }
    if let Some(key) = cfg.key()? {
        let n = m.nonce.len();
        if n < 32 + 16 {
            return Err("wallet sign-in was not issued by this deployment".into());
        }
        let (client, mac) = m.nonce.split_at(n - 32);
        if !ct_eq(mac.as_bytes(), nonce_mac(key, client, &m, &aud).as_bytes()) {
            return Err("wallet sign-in was not issued by this deployment".into());
        }
    }
    if !cfg.allow.is_empty() && !cfg.allow.contains(&address) {
        return Err("this wallet is not on this deployment's allowlist".into());
    }

    // and the signature, last: an EOA recovers with no network at all; only
    // a deployment that pinned chain readers asks them about a contract wallet
    let hash = eip191_hash(msg.as_bytes());
    if recover_eoa(&hash, &sig_bytes).as_deref() != Some(address.as_str()) {
        match (&cfg.contract, rpc) {
            (Some(c), Some(readers)) => {
                check_1271(c, cfg.chain_id, &address, &hash, &sig_bytes, &mut *readers)?;
                // the reads took time: the sign-in must still be live NOW
                if readers.now() >= exp {
                    return Err("wallet sign-in expired; sign in again".into());
                }
            }
            (Some(_), None) => return Err("this app cannot check contract-wallet signatures here".into()),
            (None, _) => return Err("wallet signature is not from the address the message names".into()),
        }
    }
    let sub = identity_of(&address).ok_or("malformed wallet sign-in message")?;
    Ok(Claims { sub, address, domain, aud, iat, exp })
}

/// The address a 65-byte EOA signature over `hash` recovers to, if any.
fn recover_eoa(hash: &[u8; 32], sig_bytes: &[u8]) -> Option<String> {
    if sig_bytes.len() != 65 {
        return None;
    }
    let v = match sig_bytes[64] {
        27 | 28 => sig_bytes[64] - 27,
        b @ (0 | 1) => b,
        _ => return None,
    };
    let sig = Signature::from_slice(&sig_bytes[..64]).ok()?;
    let recid = RecoveryId::try_from(v).ok()?;
    VerifyingKey::recover_from_prehash(hash, &sig, recid).ok().map(|vk| address_of(&vk))
}

// ---- EIP-1271: contract wallets, by agreeing pinned readers ------------------

/// isValidSignature(bytes32,bytes) and its success value
const EIP1271_MAGIC: [u8; 4] = [0x16, 0x26, 0xba, 0x7e];

/// ERC-6492: the 32 bytes a counterfactual (not yet deployed) wallet's
/// signature ends in, after abi.encode(address factory, bytes factoryCalldata,
/// bytes signature).
pub const ERC6492_MAGIC: [u8; 32] = [0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92,
                                     0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92, 0x64, 0x92];
/// ERC-6492's off-chain validator (`ValidateSigOffchain`, constructor
/// (address signer, bytes32 hash, bytes signature)): run as a DEPLOYLESS
/// eth_call it deploys the wallet through its factory call if it has no code,
/// asks isValidSignature, and returns one byte, 0x01 or 0x00. Byte-exact copy
/// of viem 2.53.1 `erc6492SignatureValidatorByteCode`, 1684 bytes, sha256 of
/// this hex text 037d6b69e53bae264a9a752be534c6373b3f829fb606456f184d2ba841de6ea4,
/// keccak-256 041473019f1c0ec0ea1e4e47621014f0be087857c75b5cd71e7df4fa962d57b9 (pinned by
/// a test). Nothing is deployed: an eth_call is a simulation.
pub const ERC6492_VALIDATOR: &str = "0x608060405234801561001057600080fd5b5060405161069438038061069483398101604081905261002f9161051e565b600061003c848484610048565b9050806000526001601ff35b60007f64926492649264926492649264926492649264926492649264926492649264926100748361040c565b036101e7576000606080848060200190518101906100929190610577565b60405192955090935091506000906001600160a01b038516906100b69085906105dd565b6000604051808303816000865af19150503d80600081146100f3576040519150601f19603f3d011682016040523d82523d6000602084013e6100f8565b606091505b50509050876001600160a01b03163b60000361016057806101605760405162461bcd60e51b815260206004820152601e60248201527f5369676e617475726556616c696461746f723a206465706c6f796d656e74000060448201526064015b60405180910390fd5b604051630b135d3f60e11b808252906001600160a01b038a1690631626ba7e90610190908b9087906004016105f9565b602060405180830381865afa1580156101ad573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906101d19190610633565b6001600160e01b03191614945050505050610405565b6001600160a01b0384163b1561027a57604051630b135d3f60e11b808252906001600160a01b03861690631626ba7e9061022790879087906004016105f9565b602060405180830381865afa158015610244573d6000803e3d6000fd5b505050506040513d601f19601f820116820180604052508101906102689190610633565b6001600160e01b031916149050610405565b81516041146102df5760405162461bcd60e51b815260206004820152603a602482015260008051602061067483398151915260448201527f3a20696e76616c6964207369676e6174757265206c656e6774680000000000006064820152608401610157565b6102e7610425565b5060208201516040808401518451859392600091859190811061030c5761030c61065d565b016020015160f81c9050601b811480159061032b57508060ff16601c14155b1561038c5760405162461bcd60e51b815260206004820152603b602482015260008051602061067483398151915260448201527f3a20696e76616c6964207369676e617475726520762076616c756500000000006064820152608401610157565b60408051600081526020810180835289905260ff83169181019190915260608101849052608081018390526001600160a01b0389169060019060a0016020604051602081039080840390855afa1580156103ea573d6000803e3d6000fd5b505050602060405103516001600160a01b0316149450505050505b9392505050565b600060208251101561041d57600080fd5b508051015190565b60405180606001604052806003906020820280368337509192915050565b6001600160a01b038116811461045857600080fd5b50565b634e487b7160e01b600052604160045260246000fd5b60005b8381101561048c578181015183820152602001610474565b50506000910152565b600082601f8301126104a657600080fd5b81516001600160401b038111156104bf576104bf61045b565b604051601f8201601f19908116603f011681016001600160401b03811182821017156104ed576104ed61045b565b60405281815283820160200185101561050557600080fd5b610516826020830160208701610471565b949350505050565b60008060006060848603121561053357600080fd5b835161053e81610443565b6020850151604086015191945092506001600160401b0381111561056157600080fd5b61056d86828701610495565b9150509250925092565b60008060006060848603121561058c57600080fd5b835161059781610443565b60208501519093506001600160401b038111156105b357600080fd5b6105bf86828701610495565b604086015190935090506001600160401b0381111561056157600080fd5b600082516105ef818460208701610471565b9190910192915050565b828152604060208201526000825180604084015261061e816060850160208701610471565b601f01601f1916919091016060019392505050565b60006020828403121561064557600080fd5b81516001600160e01b03198116811461040557600080fd5b634e487b7160e01b600052603260045260246000fdfe5369676e617475726556616c696461746f72237265636f7665725369676e6572";

/// Is `sig` an ERC-6492 wrapper, and a well-formed one? The suffix, then the
/// strict ABI shape abi.encode(address, bytes, bytes): an address word, two
/// in-range offsets, lengths that fit, and a non-empty inner signature. Err for
/// a suffix over a malformed body: that is refused, never guessed at.
fn erc6492_parts(sig: &[u8]) -> Result<Option<(String, usize, usize)>, String> {
    let Some(body) = sig.strip_suffix(&ERC6492_MAGIC[..]) else { return Ok(None) };
    let bad = || "contract wallet: malformed EIP-6492 signature".to_string();
    let word = |at: usize| body.get(at..at + 32).ok_or_else(bad);
    let small = |w: &[u8]| -> Result<usize, String> {
        if w[..24].iter().any(|b| *b != 0) { return Err(bad()); }
        Ok(u64::from_be_bytes(w[24..32].try_into().unwrap()) as usize)
    };
    let factory = word(0)?;
    if factory[..12].iter().any(|b| *b != 0) {
        return Err(bad());
    }
    let dynamic = |head: usize| -> Result<usize, String> {
        let off = small(word(head)?)?;
        if off % 32 != 0 || off < 96 { return Err(bad()); }
        let len = small(word(off)?)?;
        let end = off.checked_add(32).and_then(|x| x.checked_add(len)).ok_or_else(bad)?;
        if end > body.len() { return Err(bad()); }
        Ok(len)
    };
    let (calldata_len, inner_len) = (dynamic(32)?, dynamic(64)?);
    if inner_len == 0 {
        return Err(bad());
    }
    Ok(Some((format!("0x{}", hex(&factory[12..])), calldata_len, inner_len)))
}

/// The deployless validator call for an ERC-6492 signature: the validator's
/// creation code followed by its constructor arguments.
fn calldata_6492(address: &str, hash: &[u8; 32], sig: &[u8]) -> String {
    let word = |n: usize| format!("{n:064x}");
    let mut padded = hex(sig);
    while padded.len() % 64 != 0 {
        padded.push('0');
    }
    format!("{}{:0>64}{}{}{}{}", ERC6492_VALIDATOR, address.trim_start_matches("0x"), hex(hash), word(96), word(sig.len()), padded)
}

/// How a reader's eth_call answer is read as a vote.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Verdict {
    /// isValidSignature's return: the magic value, left-aligned in a word
    Eip1271,
    /// the ERC-6492 validator's single byte
    Erc6492,
}

fn calldata_1271(hash: &[u8; 32], sig: &[u8]) -> String {
    let word = |n: usize| format!("{n:064x}");
    let mut padded = hex(sig);
    while padded.len() % 64 != 0 {
        padded.push('0');
    }
    format!("0x{}{}{}{}{}", hex(&EIP1271_MAGIC), hex(hash), word(64), word(sig.len()), padded)
}

fn hex_u64(v: &serde_json::Value) -> Option<u64> {
    let s = v.as_str()?.strip_prefix("0x")?;
    if s.is_empty() || s.len() > 16 {
        return None;
    }
    u64::from_str_radix(s, 16).ok()
}

/// 0x-prefixed hex to bytes. Anything that is not ASCII hex digits is refused
/// BEFORE any slicing: a reader's answer is hostile input, and slicing a
/// multi-byte character in half would panic the app.
fn hex_bytes(s: &str) -> Option<Vec<u8>> {
    let s = s.strip_prefix("0x")?;
    if s.len() % 2 != 0 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let b = s.as_bytes();
    let nib = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    (0..b.len() / 2).map(|i| Some(nib(b[2 * i])? << 4 | nib(b[2 * i + 1])?)).collect()
}

fn rpc_call(readers: &mut dyn ChainReaders, c: &ContractCfg, url: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let bytes = readers.post(url, body.to_string().as_bytes(), c.timeout_secs, c.max_bytes)?;
    if bytes.len() > c.max_bytes {
        return Err("reader answered too much".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "reader did not answer JSON".to_string())
}

/// A 32-byte hash as 0x + 64 lowercase hex, or None.
fn block_hash(v: Option<&serde_json::Value>) -> Option<String> {
    let h = v?.as_str()?.to_ascii_lowercase();
    (h.len() == 66 && h.starts_with("0x") && h[2..].bytes().all(|b| b.is_ascii_hexdigit())).then_some(h)
}

/// One reader's COMPLETE answer: the block it read (number, hash, time) and
/// what isValidSignature said there. Two readers agree only when all four
/// match; a verdict is never counted apart from the block it was read at.
#[derive(Clone, PartialEq, Debug)]
struct Snapshot {
    number: u64,
    hash: String,
    timestamp: u64,
    valid: bool,
}

fn first_result(r: &serde_json::Value, id: u64) -> Option<&serde_json::Value> {
    let item = match r {
        serde_json::Value::Array(items) => items.iter().find(|i| i.get("id").and_then(|x| x.as_u64()) == Some(id))?,
        one => one,
    };
    item.get("result")
}

/// What one reader says at block `target`: the block's header first, then the
/// call AT THAT EXACT HASH (EIP-1898 `{blockHash}`), so the verdict is bound to
/// the block the reader named and to nothing else. None when the reader gives
/// no usable answer (down, no such block, a malformed hash, garbage): that is
/// absence, never a vote either way. A revert IS a vote: "not valid".
fn snapshot_at(readers: &mut dyn ChainReaders, c: &ContractCfg, url: &str, target: u64, call_obj: &serde_json::Value, verdict: Verdict) -> Option<Snapshot> {
    let q = serde_json::json!([{ "jsonrpc": "2.0", "id": 1, "method": "eth_getBlockByNumber", "params": [format!("0x{target:x}"), false] }]);
    let r = rpc_call(readers, c, url, &q).ok()?;
    let block = first_result(&r, 1)?;
    if hex_u64(block.get("number")?)? != target {
        return None;
    }
    let hash = block_hash(block.get("hash"))?;
    let timestamp = hex_u64(block.get("timestamp")?)?;
    let call = serde_json::json!([{ "jsonrpc": "2.0", "id": 2, "method": "eth_call",
        "params": [call_obj, { "blockHash": hash, "requireCanonical": true }] }]);
    let r = rpc_call(readers, c, url, &call).ok()?;
    let item = match &r {
        serde_json::Value::Array(items) => items.iter().find(|i| i.get("id").and_then(|x| x.as_u64()) == Some(2))?.clone(),
        one => one.clone(),
    };
    let valid = if let Some(res) = item.get("result") {
        let ret = hex_bytes(res.as_str()?)?; // garbage: no vote
        match verdict {
            Verdict::Eip1271 => ret.len() >= 32 && ret[..4] == EIP1271_MAGIC && ret[4..32].iter().all(|b| *b == 0),
            // exactly one byte, 0 or 1; anything else is no answer at all
            Verdict::Erc6492 => match ret.as_slice() { [1] => true, [0] => false, _ => return None },
        }
    } else {
        // an execution revert is the contract saying no; any other error
        // (unknown block, rate limit, internal) is no answer at all
        let e = item.get("error")?;
        let code = e.get("code").and_then(|x| x.as_i64());
        let msg = e.get("message").and_then(|x| x.as_str()).unwrap_or("").to_ascii_lowercase();
        if code == Some(3) || msg.contains("revert") { false } else { return None }
    };
    Some(Snapshot { number: target, hash, timestamp, valid })
}

/// EIP-1271 by the pinned readers, decided by AGREEMENT ON THE WHOLE ANSWER.
///
///   1. Each reader states its chain id and head. A reader on another chain, or
///      that cannot say, takes no further part.
///   2. The target block is the `quorum`-th highest head (so at least `quorum`
///      readers claim to have it) minus `confirmations`. One reader lagging,
///      stale or lying about its head can neither drag the check to an old
///      block nor push it past what the others have.
///   3. Each remaining reader returns a SNAPSHOT: that block's number, hash and
///      time, and the wallet's verdict read AT THAT HASH: isValidSignature on
///      the wallet for an ordinary contract signature, or - for an EIP-6492
///      signature from a wallet that may not exist yet - the deployless
///      ERC-6492 validator, which simulates the wallet's factory call and asks
///      the same question in one eth_call.
///   4. Identical snapshots are counted. Approve only when exactly one
///      snapshot - and it says valid - is held by at least `quorum` distinct
///      readers, and no other snapshot also reaches `quorum` (a split refuses).
///      Refuse when a "not valid" snapshot reaches quorum, or when nothing
///      does. One reader can therefore neither approve (it is one vote short)
///      nor veto (a lone "no", revert or garbage is outvoted).
///   5. The winning block must be fresh by the clock read AFTER the network
///      reads, not the clock from before them.
pub fn check_1271(c: &ContractCfg, chain_id: u64, address: &str, hash: &[u8; 32], sig: &[u8], readers: RpcPost) -> Result<(), String> {
    // a malformed EIP-6492 wrapper is refused before any reader is asked
    erc6492_parts(sig)?;
    // 1. who is on this chain, and how far each has got
    let mut heads: Vec<(&str, u64)> = Vec::new();
    for url in &c.rpcs {
        let q = serde_json::json!([
            { "jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": [] },
            { "jsonrpc": "2.0", "id": 2, "method": "eth_getBlockByNumber", "params": ["latest", false] },
        ]);
        let Ok(r) = rpc_call(&mut *readers, c, url, &q) else { continue };
        let on_chain = first_result(&r, 1).and_then(hex_u64) == Some(chain_id);
        if let (true, Some(n)) = (on_chain, first_result(&r, 2).and_then(|b| b.get("number")).and_then(hex_u64)) {
            heads.push((url.as_str(), n));
        }
    }
    if heads.len() < c.quorum {
        return Err("contract wallet: too few chain readers on this chain answered; try again".into());
    }
    // 2. the block at least `quorum` readers have reached, a few confirmations deep
    let mut ns: Vec<u64> = heads.iter().map(|(_, n)| *n).collect();
    ns.sort_unstable_by(|a, b| b.cmp(a));
    let target = ns[c.quorum - 1].saturating_sub(c.confirmations);
    // 3. complete snapshots, asked the right question for the signature's kind
    let (call_obj, verdict) = match erc6492_parts(sig)? {
        None => (serde_json::json!({ "to": address, "data": calldata_1271(hash, sig) }), Verdict::Eip1271),
        Some(_) => (serde_json::json!({ "data": calldata_6492(address, hash, sig) }), Verdict::Erc6492),
    };
    let snaps: Vec<Snapshot> = heads.iter().filter_map(|(url, _)| snapshot_at(&mut *readers, c, url, target, &call_obj, verdict)).collect();
    // 4. agreement on the whole answer
    let mut tally: Vec<(&Snapshot, usize)> = Vec::new();
    for s in &snaps {
        match tally.iter_mut().find(|(t, _)| *t == s) {
            Some((_, n)) => *n += 1,
            None => tally.push((s, 1)),
        }
    }
    let carried: Vec<&Snapshot> = tally.iter().filter(|(_, n)| *n >= c.quorum).map(|(s, _)| *s).collect();
    let winner = match carried.as_slice() {
        [] => return Err("contract wallet: the chain readers did not agree on an answer; refused (try again)".into()),
        [one] => *one,
        _ => return Err("contract wallet: the chain readers split between answers; refused".into()),
    };
    if !winner.valid {
        return Err("contract wallet: the wallet contract does not accept this signature".into());
    }
    // 5. fresh at decision time
    let now = readers.now();
    if winner.timestamp > now + 60 || now.saturating_sub(winner.timestamp) > c.max_age_secs {
        return Err("contract wallet: the agreed block is stale; refused".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use k256::ecdsa::SigningKey;

    const AUD: &str = "0xcc1f4f3f000000000000000000000000000000000000000000000000000000aa";
    const OTHER: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const NOW: u64 = 1_800_000_000;
    const NONCE: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[0x42u8; 32].into()).unwrap()
    }
    fn addr(k: &SigningKey) -> String {
        address_of(k.verifying_key())
    }
    fn cfg() -> WalletConfig {
        WalletConfig::parse(&serde_json::json!({
            "audience": AUD, "domains": ["chat.example.com", "https://Mirror.Example.org/"],
        }))
        .unwrap()
    }
    fn sign(k: &SigningKey, msg: &str) -> String {
        let (sig, rec) = k.sign_prehash_recoverable(&eip191_hash(msg.as_bytes())).unwrap();
        let mut b = sig.to_bytes().to_vec();
        b.push(rec.to_byte() + 27);
        token(msg, &format!("0x{}", hex(&b))).unwrap()
    }
    fn issued(c: &WalletConfig, host: &str, k: &SigningKey) -> String {
        challenge(c, Some(host), &addr(k), NONCE, NOW).unwrap()
    }

    #[test]
    fn challenge_signs_and_verifies_as_a_wallet_identity() {
        let c = cfg();
        let msg = issued(&c, "chat.example.com", &key());
        assert!(msg.starts_with("chat.example.com wants you to sign in with your Ethereum account:\n0x17c5185167401eD00cF5F5b2fc97D9BBfDb7D025\n\n"), "{msg}");
        assert!(msg.ends_with(&format!("Resources:\n- urn:enclave:deployment:{AUD}")), "{msg}");
        let got = verify(&c, &sign(&key(), &msg), NOW + 10).expect("verifies");
        assert_eq!(got.sub, "wallet_0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025");
        assert_eq!(got.address, "0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025");
        assert_eq!(got.exp, NOW + 86_400);
        // a mirror the owner listed works the same, bound to ITS name
        let m = issued(&c, "mirror.example.org", &key());
        assert_eq!(verify(&c, &sign(&key(), &m), NOW).unwrap().domain, "mirror.example.org");
    }

    #[test]
    fn the_message_round_trips_through_the_parser() {
        let msg = issued(&cfg(), "chat.example.com", &key());
        let p = Siwe::parse(&msg).unwrap();
        assert_eq!(p.render(), msg);
        assert_eq!(p.chain_id, 8453);
        assert_eq!(p.version, "1");
        // statement is optional in EIP-4361: two blank lines then URI
        let mut q = p.clone();
        q.statement = None;
        assert_eq!(Siwe::parse(&q.render()).unwrap(), q);
        // CRLF, trailing text, out-of-order fields: refused, never guessed
        assert!(Siwe::parse(&msg.replace('\n', "\r\n")).is_err());
        assert!(Siwe::parse(&format!("{msg}\nextra")).is_err());
        assert!(Siwe::parse(&msg.replace("Version: 1\nChain ID: 8453", "Chain ID: 8453\nVersion: 1")).is_err());
    }

    #[test]
    fn a_signature_for_another_site_opens_nothing() {
        let c = cfg();
        // the challenge refuses a host this deployment does not list
        assert!(challenge(&c, Some("evil.example"), &addr(&key()), NONCE, NOW).is_err());
        // and a message the wallet signed for that site, hand-built, is refused
        let mut m = Siwe::parse(&issued(&c, "chat.example.com", &key())).unwrap();
        m.domain = "evil.example".into();
        m.uri = "https://evil.example/".into();
        let e = verify(&c, &sign(&key(), &m.render()), NOW).unwrap_err();
        assert!(e.contains("different site"), "{e}");
        // the right domain with a URI elsewhere is refused too
        let mut m = Siwe::parse(&issued(&c, "chat.example.com", &key())).unwrap();
        m.uri = "https://evil.example/chat.example.com".into();
        assert!(verify(&c, &sign(&key(), &m.render()), NOW).unwrap_err().contains("URI"));
        // plain http is a loopback-only spelling
        let mut m = Siwe::parse(&issued(&c, "chat.example.com", &key())).unwrap();
        m.uri = "http://chat.example.com/".into();
        assert!(verify(&c, &sign(&key(), &m.render()), NOW).is_err());
    }

    #[test]
    fn a_signature_for_another_deployment_or_chain_is_refused() {
        let c = cfg();
        let t = sign(&key(), &issued(&c, "chat.example.com", &key()));
        let mut other = cfg();
        other.audience = OTHER.into();
        assert!(verify(&other, &t, NOW).unwrap_err().contains("different deployment"));
        // unless that deployment explicitly accepts this one's visitors
        other.accept = vec![AUD.into()];
        assert!(verify(&other, &t, NOW).is_ok());
        // two deployments in one signature: refused, whichever they are
        let mut m = Siwe::parse(&issued(&c, "chat.example.com", &key())).unwrap();
        m.resources.push(format!("{AUD_URN}{OTHER}"));
        assert!(verify(&c, &sign(&key(), &m.render()), NOW).unwrap_err().contains("exactly one"));
        let mut m = Siwe::parse(&issued(&c, "chat.example.com", &key())).unwrap();
        m.resources.clear();
        assert!(verify(&c, &sign(&key(), &m.render()), NOW).is_err());
        let mut m = Siwe::parse(&issued(&c, "chat.example.com", &key())).unwrap();
        m.chain_id = 1;
        assert!(verify(&c, &sign(&key(), &m.render()), NOW).unwrap_err().contains("chain"));
    }

    #[test]
    fn expiry_window_and_clock() {
        let c = cfg();
        let t = sign(&key(), &issued(&c, "chat.example.com", &key()));
        assert!(verify(&c, &t, NOW + 86_399).is_ok());
        assert!(verify(&c, &t, NOW + 86_400).unwrap_err().contains("expired"), "exp second is dead");
        assert!(verify(&c, &t, NOW - 301).unwrap_err().contains("not valid yet"));
        assert!(verify(&c, &t, NOW - 299).is_ok(), "issued-at skew absorbed");
        // a hand-built message asking for a longer session than the owner allows
        let mut m = Siwe::parse(&issued(&c, "chat.example.com", &key())).unwrap();
        m.expiration_time = Some(rfc3339(NOW + 86_401));
        assert!(verify(&c, &sign(&key(), &m.render()), NOW).unwrap_err().contains("longer session"));
        // no expiry at all: refused (expiry is the only revocation)
        m.expiration_time = None;
        assert!(verify(&c, &sign(&key(), &m.render()), NOW).unwrap_err().contains("no expiration"));
        // not-before in the future
        let mut m = Siwe::parse(&issued(&c, "chat.example.com", &key())).unwrap();
        m.not_before = Some(rfc3339(NOW + 3600));
        assert!(verify(&c, &sign(&key(), &m.render()), NOW).unwrap_err().contains("not valid yet"));
    }

    #[test]
    fn tampering_and_wrong_signers_fail() {
        let c = cfg();
        let msg = issued(&c, "chat.example.com", &key());
        let t = sign(&key(), &msg);
        // another key signing a message that names our address
        let other = SigningKey::from_bytes(&[0x43u8; 32].into()).unwrap();
        assert!(verify(&c, &sign(&other, &msg), NOW).unwrap_err().contains("not from the address"));
        // the signed bytes edited after signing (a later expiry)
        let sig = t.rsplit('.').next().unwrap();
        let edited = msg.replace(&rfc3339(NOW + 86_400), &rfc3339(NOW + 86_000));
        let forged = format!("EWS1.{}.{sig}", URL_SAFE_NO_PAD.encode(edited.as_bytes()));
        assert!(verify(&c, &forged, NOW).is_err());
        for junk in ["", "EWS1.", "EWS1..", "EWS1.!!.!!", "EST1.a.b", "EWS1.YQ.AAAA", &"EWS1.".repeat(1000)] {
            assert!(verify(&c, junk, NOW).is_err(), "{junk:?}");
        }
    }

    #[test]
    fn keyed_nonces_bind_the_challenge() {
        let mut c = cfg();
        c.nonce_key = Some("0f1e2d3c4b5a69788796a5b4c3d2e1f0".into());
        let msg = issued(&c, "chat.example.com", &key());
        assert!(verify(&c, &sign(&key(), &msg), NOW).is_ok());
        // a message the page made up itself (its own nonce, no MAC)
        let mut m = Siwe::parse(&msg).unwrap();
        m.nonce = NONCE.into();
        assert!(verify(&c, &sign(&key(), &m.render()), NOW).unwrap_err().contains("not issued by this deployment"));
        // the issued nonce reused with a different window
        let mut m = Siwe::parse(&msg).unwrap();
        m.issued_at = rfc3339(NOW + 60);
        m.expiration_time = Some(rfc3339(NOW + 60 + 86_400));
        assert!(verify(&c, &sign(&key(), &m.render()), NOW + 120).is_err());
        // issued to one wallet, signed by another over the same nonce
        let other = SigningKey::from_bytes(&[0x43u8; 32].into()).unwrap();
        let mut m = Siwe::parse(&msg).unwrap();
        m.address = checksum_address(&addr(&other)).unwrap();
        assert!(verify(&c, &sign(&other, &m.render()), NOW).is_err());
        // a key left as an unresolved secret fails closed, both ways
        c.nonce_key = Some("$WALLET_NONCE_KEY".into());
        assert!(challenge(&c, Some("chat.example.com"), &addr(&key()), NONCE, NOW).is_err());
        assert!(verify(&c, &sign(&key(), &msg), NOW).is_err());
    }

    #[test]
    fn allowlist_and_platform_hosts() {
        let mut c = cfg();
        c.allow = vec!["0x0000000000000000000000000000000000000001".into()];
        let t = sign(&key(), &issued(&c, "chat.example.com", &key()));
        assert!(verify(&c, &t, NOW).unwrap_err().contains("allowlist"));
        c.allow.push(addr(&key()));
        assert!(verify(&c, &t, NOW).is_ok());
        // with no domains configured the platform's own list decides (passed
        // in: ENCLAVE_HOSTS is process-global and other tests set it)
        let c = WalletConfig::parse(&serde_json::json!({ "audience": AUD })).unwrap();
        assert_eq!(c.allowed_with(Some("cc1f4f3f.app.enclave.host,Chat.Example.com:443, ,*.x")),
                   vec!["cc1f4f3f.app.enclave.host", "chat.example.com"]);
        assert!(c.allowed_with(None).is_empty(), "no hosts known, nothing allowed");
        // and a configured list replaces the platform's rather than extending it
        assert_eq!(cfg().allowed_with(Some("cc1f4f3f.app.enclave.host")), vec!["chat.example.com", "mirror.example.org"]);
    }

    #[test]
    fn loopback_signs_for_http() {
        let c = WalletConfig::parse(&serde_json::json!({ "audience": AUD, "domains": ["localhost:8080"] })).unwrap();
        let msg = challenge(&c, Some("localhost:8080"), &addr(&key()), NONCE, NOW).unwrap();
        assert!(msg.contains("\nURI: http://localhost:8080/\n"), "{msg}");
        assert!(verify(&c, &sign(&key(), &msg), NOW).is_ok());
    }

    #[test]
    fn config_is_validated() {
        let ok = |v: serde_json::Value| WalletConfig::parse(&v);
        assert!(ok(serde_json::json!({})).is_err(), "audience required");
        assert!(ok(serde_json::json!({ "audience": "0x12" })).is_err());
        assert!(ok(serde_json::json!({ "audience": AUD, "domains": ["*.example.com"] })).is_err(), "no wildcards");
        assert!(ok(serde_json::json!({ "audience": AUD, "domains": ["example.com/path"] })).is_err());
        assert!(ok(serde_json::json!({ "audience": AUD, "accept": ["nope"] })).is_err());
        assert!(ok(serde_json::json!({ "audience": AUD, "allow": ["0x12"] })).is_err());
        assert!(ok(serde_json::json!({ "audience": AUD, "required": "yes" })).is_err());
        let c = ok(serde_json::json!({ "audience": AUD.to_uppercase().replace("0X", "0x"), "ttl_secs": 99_999_999 })).unwrap();
        assert_eq!(c.ttl_secs, MAX_TTL_SECS, "the owner's ceiling is EST1's ceiling");
        assert_eq!(c.audience, AUD);
        assert!(c.required);
        assert!(WalletConfig::from_config(&serde_json::json!({})).unwrap().is_none());
    }

    #[test]
    fn identities_never_collide_with_platform_subs() {
        let a = "0x00a329c0648769a73afac7f9381e08fb43dbea72";
        assert_eq!(identity_of(a).unwrap(), format!("wallet_{a}"));
        assert_eq!(canonical_wallet_sub(&format!("wallet_{}", a.to_uppercase().replace("0X", "0x"))).unwrap(), format!("wallet_{a}"));
        for bad in ["wallet_", "wallet_0x12", "0x00a329c0648769a73afac7f9381e08fb43dbea72", "acct_x", "wallet_acct_x"] {
            assert!(canonical_wallet_sub(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn rfc3339_round_trips() {
        for t in [0u64, 951_782_400, 1_755_000_000, NOW, 4_102_444_800] {
            assert_eq!(parse_rfc3339(&rfc3339(t)), Some(t));
        }
        assert_eq!(parse_rfc3339("2027-01-15T08:00:00.123+02:00"), parse_rfc3339("2027-01-15T06:00:00Z"));
        for bad in ["2027-02-29T00:00:00Z", "2027-01-15 08:00:00Z", "2027-01-15T08:00:00", "2027-13-01T00:00:00Z", "2027-01-15T08:00:00.Z", "x"] {
            assert!(parse_rfc3339(bad).is_none(), "{bad}");
        }
    }

    // ---- account links: an explicit act, never a sign-in, never the reverse --

    const ACCT: &str = "acct_0e64d1897f10b32d3a1bc84e";
    fn proof_of(cred: &str) -> [u8; 32] {
        proof_hash(cred)
    }

    fn link_msg(c: &WalletConfig, k: &SigningKey, account: &str, cred: &str) -> String {
        link_challenge(c, Some("chat.example.com"), &addr(k), NONCE, NOW, account, cred).unwrap()
    }

    #[test]
    fn a_link_signature_binds_account_credential_deployment_and_minutes() {
        let c = cfg();
        let cred = "EST1.the-account-credential.sig";
        let msg = link_msg(&c, &key(), ACCT, cred);
        assert!(msg.contains(&link_statement(ACCT)), "{msg}");
        assert!(msg.contains(&format!("\nExpiration Time: {}", rfc3339(NOW + LINK_MAX_TTL_SECS))), "a link is minutes, not a session");
        let t = sign(&key(), &msg);
        let ok = verify_act(&c, &t, NOW, Act::Link { account: ACCT, proof: proof_of(cred) }, None).unwrap();
        assert_eq!(ok.sub, "wallet_0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025");
        // the same signature names no other account, credential or deployment
        assert!(verify_act(&c, &t, NOW, Act::Link { account: "acct_other", proof: proof_of(cred) }, None).is_err());
        assert!(verify_act(&c, &t, NOW, Act::Link { account: ACCT, proof: proof_of("another credential") }, None).is_err());
        let mut other = cfg();
        other.audience = OTHER.into();
        other.accept = vec![AUD.into()];
        assert!(verify_act(&other, &t, NOW, Act::Link { account: ACCT, proof: proof_of(cred) }, None).unwrap_err().contains("different deployment"),
                "an accepted audience is good for sign-ins, never for links");
        // minutes: dead after ten
        assert!(verify_act(&c, &t, NOW + LINK_MAX_TTL_SECS, Act::Link { account: ACCT, proof: proof_of(cred) }, None).is_err());
    }

    #[test]
    fn a_routine_sign_in_never_links_and_a_link_never_signs_in() {
        let c = cfg();
        let session = sign(&key(), &issued(&c, "chat.example.com", &key()));
        let e = verify_act(&c, &session, NOW, Act::Link { account: ACCT, proof: proof_of("x") }, None).unwrap_err();
        assert!(e.contains("not an account-link"), "{e}");
        let link = sign(&key(), &link_msg(&c, &key(), ACCT, "x"));
        assert!(verify(&c, &link, NOW).unwrap_err().contains("account-link signature, not a sign-in"));
        // a hand-made message with the link resources but a session statement
        let mut m = Siwe::parse(&link_msg(&c, &key(), ACCT, "x")).unwrap();
        m.statement = Some("Sign in".into());
        assert!(verify_act(&c, &sign(&key(), &m.render()), NOW, Act::Link { account: ACCT, proof: proof_of("x") }, None).is_err());
        // or asking for a session-length window
        let mut m = Siwe::parse(&link_msg(&c, &key(), ACCT, "x")).unwrap();
        m.expiration_time = Some(rfc3339(NOW + 3600));
        assert!(verify_act(&c, &sign(&key(), &m.render()), NOW, Act::Link { account: ACCT, proof: proof_of("x") }, None).is_err());
        // a wallet identity is not an account to link
        assert!(link_challenge(&c, Some("chat.example.com"), &addr(&key()), NONCE, NOW, "wallet_0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025", "x").is_err());
        // keyed nonces bind the act: a sign-in challenge's nonce cannot be reused for a link
        let mut k = cfg();
        k.nonce_key = Some("0f1e2d3c4b5a69788796a5b4c3d2e1f0".into());
        let sess = Siwe::parse(&issued(&k, "chat.example.com", &key())).unwrap();
        let mut m = Siwe::parse(&link_challenge(&k, Some("chat.example.com"), &addr(&key()), NONCE, NOW, ACCT, "x").unwrap()).unwrap();
        m.nonce = sess.nonce;
        m.expiration_time = sess.expiration_time.clone();
        m.expiration_time = Some(rfc3339(NOW + LINK_MAX_TTL_SECS));
        assert!(verify_act(&k, &sign(&key(), &m.render()), NOW, Act::Link { account: ACCT, proof: proof_of("x") }, None).unwrap_err().contains("not issued"));
    }

    // ---- EIP-1271 over pinned readers ------------------------------------------

    fn run_1271(readers: Vec<sim::Reader>, quorum: usize, good_sig: bool) -> Result<(), String> {
        let (h, good) = ([7u8; 32], vec![9u8; 130]);
        let mut ch = sim::Chain::new(readers, NOW);
        ch.quorum = quorum;
        ch.good.push((h, good.clone()));
        let c = ch.cfg();
        let sig = if good_sig { good } else { vec![1u8; 65] };
        check_1271(&c, DEFAULT_CHAIN_ID, sim::WALLET, &h, &sig, &mut ch)
    }

    /// Enough honest POSITIVE snapshots authorize, whatever one other reader
    /// says: a lone "no", a revert, garbage, a stale or forked view, another
    /// chain, a lagging or lying head, a malformed hash, or silence.
    #[test]
    fn eip1271_one_reader_cannot_veto_two_honest_approvals() {
        use sim::Reader::*;
        for third in [Honest, Denies, Reverts, Garbage, Stale, Forked, WrongChain, LowHead, HighHead, BadHash, Down] {
            assert!(run_1271(vec![Honest, Honest, third], 2, true).is_ok(), "{third:?} vetoed two honest approvals");
            assert!(run_1271(vec![third, Honest, Honest], 2, true).is_ok(), "{third:?} (first) vetoed two honest approvals");
        }
    }

    /// Enough honest NEGATIVE snapshots refuse, whatever one other reader says:
    /// a lone "yes" is one vote short.
    #[test]
    fn eip1271_one_reader_cannot_approve_against_two_honest_refusals() {
        use sim::Reader::*;
        for third in [Honest, Approves, Garbage, Forked, WrongChain, LowHead, HighHead, BadHash, Down] {
            assert!(run_1271(vec![Honest, Honest, third], 2, false).is_err(), "{third:?} approved a bad signature");
            assert!(run_1271(vec![third, Honest, Honest], 2, false).is_err(), "{third:?} (first) approved a bad signature");
        }
        assert!(run_1271(vec![Honest, Honest, Approves], 2, false).unwrap_err().contains("does not accept"));
    }

    /// Without an agreement there is no decision for the wallet: a split, too
    /// few on this chain, or too few with the same answer all refuse - and
    /// none of them is a first-answer fallback.
    #[test]
    fn eip1271_splits_and_missing_quorums_refuse() {
        use sim::Reader::*;
        // 2 vs 2 at quorum 2: both answers carried, so neither is
        assert!(run_1271(vec![Honest, Honest, Denies, Denies], 2, true).unwrap_err().contains("split"));
        assert!(run_1271(vec![Honest, Honest, Approves, Approves], 2, false).unwrap_err().contains("split"));
        // one each way, the third silent: nothing reaches quorum
        assert!(run_1271(vec![Honest, Denies, Down], 2, true).unwrap_err().contains("did not agree"));
        assert!(run_1271(vec![Honest, Down, Down], 2, true).unwrap_err().contains("too few"));
        assert!(run_1271(vec![Honest, WrongChain, WrongChain], 2, true).unwrap_err().contains("too few"));
        assert!(run_1271(vec![Honest, Forked, Down], 2, true).is_err());
        assert!(run_1271(vec![Honest, BadHash, BadHash], 2, true).is_err());
        assert!(run_1271(vec![Stale, Stale, Stale], 2, true).unwrap_err().contains("stale"));
        // the configured threshold is respected: 3 of 3 needs all three
        assert!(run_1271(vec![Honest, Honest, Honest], 3, true).is_ok());
        assert!(run_1271(vec![Honest, Honest, Denies], 3, true).is_err());
        // and 3 of 4 tolerates one bad reader in either direction
        assert!(run_1271(vec![Honest, Honest, Honest, Denies], 3, true).is_ok());
        assert!(run_1271(vec![Honest, Honest, Honest, Approves], 3, false).is_err());
    }

    /// The target block is the quorum-th highest head: one reader lagging (or
    /// lying low) cannot drag two honest readers to an old, unusable block,
    /// and one lying high cannot push them past their own head.
    #[test]
    fn eip1271_head_selection_ignores_one_outlier() {
        use sim::Reader::*;
        let mut ch = sim::Chain::new(vec![Honest, Honest, LowHead], NOW);
        ch.good.push(([7u8; 32], vec![9u8; 130]));
        let c = ch.cfg();
        assert!(check_1271(&c, DEFAULT_CHAIN_ID, sim::WALLET, &[7u8; 32], &[9u8; 130], &mut ch).is_ok());
        assert!(run_1271(vec![HighHead, Honest, Honest], 2, true).is_ok());
        assert!(run_1271(vec![HighHead, HighHead, Honest], 2, true).is_err(), "two liars claiming a future head leave no quorum at it");
    }

    /// Freshness and expiry are judged by the clock AFTER the reads.
    #[test]
    fn eip1271_decides_at_decision_time() {
        use sim::Reader::*;
        let (h, good) = ([7u8; 32], vec![9u8; 130]);
        // every request takes a minute: the agreed block is fresh when asked
        // about, stale by the time the answers are in
        let mut ch = sim::Chain::new(vec![Honest, Honest, Honest], NOW);
        ch.good.push((h, good.clone()));
        ch.secs_per_request = 60;
        let c = ch.cfg();
        assert!(check_1271(&c, DEFAULT_CHAIN_ID, sim::WALLET, &h, &good, &mut ch).unwrap_err().contains("stale"));
        // and a sign-in that expires while the readers are answering is refused
        let mut cc = cfg();
        let mut ch = sim::Chain::new(vec![Honest, Honest, Honest], NOW + 86_399);
        ch.secs_per_request = 1;
        cc.contract = Some(ch.cfg());
        let msg = challenge(&cc, Some("chat.example.com"), sim::WALLET, NONCE, NOW).unwrap();
        ch.good.push((sim::hash_of(&msg), good.clone()));
        let tok = format!("EWS1.{}.{}", URL_SAFE_NO_PAD.encode(msg.as_bytes()), URL_SAFE_NO_PAD.encode(&good));
        let e = verify_with(&cc, &tok, NOW + 86_399, Some(&mut ch)).unwrap_err();
        assert!(e.contains("expired"), "{e}");
        // with a quick round the same sign-in is accepted
        let mut ch2 = sim::Chain::new(vec![Honest, Honest, Honest], NOW + 10);
        ch2.good.push((sim::hash_of(&msg), good.clone()));
        assert!(verify_with(&cc, &tok, NOW + 10, Some(&mut ch2)).is_ok());
    }

    /// Reader identity is the canonical PUBLIC host: port, path, case and a
    /// trailing dot do not make a second reader. On loopback (a test rig) the
    /// port does, and the three loopback spellings are one host.
    #[test]
    fn reader_identity_is_the_canonical_host() {
        let cfg_of = |urls: &[&str]| ContractCfg::parse(&serde_json::json!({ "rpcs": urls }));
        for same in [
            ["https://rpc.example", "https://rpc.example:443"],
            ["https://rpc.example", "https://rpc.example.:8443"],
            ["https://RPC.Example/v1", "https://rpc.example/v2"],
            ["https://rpc.example./a", "https://rpc.EXAMPLE:9000/b"],
            ["https://1.2.3.4", "https://1.2.3.4:8545"],
            ["https://1.2.3.4", "https://[::ffff:1.2.3.4]"],
            ["https://[2001:db8::1]", "https://[2001:0db8:0000::0001]:8443"],
            ["http://localhost:8545", "http://127.0.0.1:8545"],
            ["http://[::1]:8545", "http://localhost.:8545"],
        ] {
            let e = cfg_of(&same).unwrap_err();
            assert!(e.contains("same reader as rpcs[0]"), "{same:?}: {e}");
        }
        for distinct in [
            ["https://a.example", "https://b.example"],
            ["https://a.example:8443", "https://a.example.org"],
            ["http://127.0.0.1:8545", "http://localhost:8546"],
            ["https://0xrpc.example", "https://rpc.example"],
        ] {
            assert!(cfg_of(&distinct).is_ok(), "{distinct:?}");
        }
        let r = RpcUrl::parse("https://RPC.Example.:8443/v1/k").unwrap();
        assert_eq!((r.host.as_str(), r.port, r.loopback), ("rpc.example", 8443, false));
        assert_eq!(RpcUrl::parse("http://[::1]:9").unwrap().reader_id(), "loopback port 9");
    }

    /// The parser refuses rather than guesses, and its diagnostics never echo a
    /// URL (a path or query may hold an API key).
    #[test]
    fn reader_urls_are_parsed_strictly() {
        for bad in [
            "https://a.example/?key=1", "https://a.example/#f", "https://u:p@a.example", "https://a.example/%2e",
            "https://rpç.example", "https://a.example /x", "https://a.example\\x", "http://a.example", "ftp://a.example",
            "HTTPS://a.example", "https://127.1", "https://0x7f.0.0.1", "https://1.2.3.256", "https://01.2.3.4",
            "https://a.example:0", "https://a.example:65536", "https://a.example:+443", "https://a.example:",
            "https://-a.example", "https://a-.example", "https://a..example", "https://.", "https://",
            "https://[::1", "https://[::1]x", "https://[zz::1]", "http://[2001:db8::1]", "https://a.example:443:1",
        ] {
            assert!(RpcUrl::parse(bad).is_err(), "{bad}");
        }
        let secret = "s3cr3t-api-key-0123456789";
        for urls in [
            vec![format!("https://a.example/v1/{secret}"), format!("https://a.example/v2/{secret}")],
            vec![format!("https://a.example/v1/{secret}?x=1"), "https://b.example".to_string()],
        ] {
            let e = ContractCfg::parse(&serde_json::json!({ "rpcs": urls })).unwrap_err();
            assert!(!e.contains(secret), "a diagnostic echoed the URL: {e}");
        }
    }

    /// A reader's answer is hostile input: non-ASCII where hex belongs is no
    /// answer, never a panic.
    #[test]
    fn malformed_hex_cannot_panic() {
        for bad in ["0xé1", "0x€€", "0xñ0ñ0", "0xzz", "0x1", "é", "", "0x\u{0}0"] {
            assert_eq!(hex_bytes(bad), None, "{bad:?}");
        }
        assert_eq!(hex_bytes("0x00ff1A").unwrap(), vec![0x00, 0xff, 0x1a]);
        assert_eq!(hex_bytes("0x").unwrap(), Vec::<u8>::new());
        use sim::Reader::*;
        assert!(run_1271(vec![Honest, Honest, Unicode], 2, true).is_ok(), "an outvoted non-ASCII reader changes nothing");
        assert!(run_1271(vec![Unicode, Honest, Honest], 2, false).is_err());
        assert!(run_1271(vec![Honest, Unicode, Unicode], 2, true).is_err(), "non-ASCII answers are no votes");
    }

    /// EIP-6492: a wallet not deployed yet signs with its factory call wrapped
    /// around the signature; the readers' deployless validator decides, by the
    /// SAME snapshot quorum as a deployed wallet's isValidSignature.
    #[test]
    fn eip6492_counterfactual_wallets_use_the_same_quorum() {
        use sim::Reader::*;
        let h = [7u8; 32];
        let good = sim::wrap_6492(sim::FACTORY, &[0xab; 100], &[9u8; 130]);
        let run = |readers: Vec<sim::Reader>, sig: &[u8]| {
            let mut ch = sim::Chain::new(readers, NOW);
            ch.good.push((h, good.clone()));
            let c = ch.cfg();
            let r = check_1271(&c, DEFAULT_CHAIN_ID, sim::WALLET, &h, sig, &mut ch);
            (r, ch.calls)
        };
        assert!(run(vec![Honest, Honest, Honest], &good).0.is_ok());
        for third in [Denies, Reverts, Garbage, Stale, Forked, WrongChain, LowHead, HighHead, BadHash, Down, Unicode] {
            assert!(run(vec![Honest, Honest, third], &good).0.is_ok(), "{third:?} vetoed a counterfactual wallet");
        }
        // a wrapped signature the (simulated) wallet would not accept, or one for another factory
        let other_inner = sim::wrap_6492(sim::FACTORY, &[0xab; 100], &[1u8; 130]);
        let other_factory = sim::wrap_6492("0x00000000000000000000000000000000000bad00", &[0xab; 100], &[9u8; 130]);
        for bad in [&other_inner, &other_factory] {
            for third in [Honest, Approves, Garbage, Down] {
                let e = run(vec![Honest, Honest, third], bad).0.unwrap_err();
                assert!(e.contains("does not accept"), "{third:?}: {e}");
            }
        }
        // the 6492 verdict is not the 1271 one: the unwrapped inner signature is a different question
        assert!(run(vec![Honest, Honest, Honest], &[9u8; 130]).0.is_err());
        // malformed wrappers are refused before any reader is asked
        // the inner signature cut short: its stated length runs past the body
        let mut truncated = good[..good.len() - 32 - 40].to_vec();
        truncated.extend(ERC6492_MAGIC);
        let empty_inner = sim::wrap_6492(sim::FACTORY, &[0xab; 100], &[]);
        let mut dirty_address = good.clone();
        dirty_address[0] = 1;
        let mut huge_len = good.clone();
        huge_len[96 + 24..96 + 32].fill(0xff); // the calldata length runs past the end (and overflows)
        let mut odd_offset = good.clone();
        odd_offset[32 + 31] = 97; // an offset that is not a word boundary
        for (i, bad) in [truncated, empty_inner, dirty_address, huge_len, odd_offset, ERC6492_MAGIC.to_vec()].into_iter().enumerate() {
            let (r, calls) = run(vec![Honest, Honest, Honest], &bad);
            assert!(r.unwrap_err().contains("malformed EIP-6492"), "accepted malformed wrapper #{i}");
            assert_eq!(calls, 0, "malformed wrapper #{i} reached the readers");
        }
        // revocation before deployment: the factory's wallet stops accepting it
        let mut ch = sim::Chain::new(vec![Honest, Honest, Approves], NOW);
        ch.good.push((h, good.clone()));
        let c = ch.cfg();
        assert!(check_1271(&c, DEFAULT_CHAIN_ID, sim::WALLET, &h, &good, &mut ch).is_ok());
        ch.good.clear();
        assert!(check_1271(&c, DEFAULT_CHAIN_ID, sim::WALLET, &h, &good, &mut ch).unwrap_err().contains("does not accept"));
    }

    /// The pinned validator is byte-exact viem 2.53.1, and a large wrapped
    /// signature fits a token (page and server limits agree on 6144 bytes).
    #[test]
    fn erc6492_validator_is_pinned_and_large_signatures_fit() {
        assert_eq!(ERC6492_VALIDATOR.len(), 2 + 2 * 1684);
        // keccak-256 of the hex text (its sha256, in the constant's doc, is 037d6b69...)
        assert_eq!(hex(&keccak(ERC6492_VALIDATOR.as_bytes())), "041473019f1c0ec0ea1e4e47621014f0be087857c75b5cd71e7df4fa962d57b9");
        let c = cfg();
        let msg = issued(&c, "chat.example.com", &key());
        let big = format!("0x{}", "ab".repeat(MAX_SIGNATURE_BYTES));
        let t = token(&msg, &big).expect("a 6144-byte signature makes a token");
        assert!(t.len() <= MAX_TOKEN_BYTES);
        assert!(token(&msg, &format!("{big}ab")).is_none());
        // and the verifier reads it as a contract signature (needing readers), not as malformed
        assert!(verify(&c, &t, NOW).unwrap_err().contains("not from the address"));
    }

    /// Revocation: the contract stops accepting the signature, honest readers
    /// say so, and the next check refuses.
    #[test]
    fn eip1271_revocation_is_seen_on_the_next_check() {
        use sim::Reader::*;
        let (h, good) = ([7u8; 32], vec![9u8; 130]);
        let mut ch = sim::Chain::new(vec![Honest, Honest, Approves], NOW);
        ch.good.push((h, good.clone()));
        let c = ch.cfg();
        assert!(check_1271(&c, DEFAULT_CHAIN_ID, sim::WALLET, &h, &good, &mut ch).is_ok());
        ch.good.clear();
        assert!(check_1271(&c, DEFAULT_CHAIN_ID, sim::WALLET, &h, &good, &mut ch).unwrap_err().contains("does not accept"));
    }

    #[test]
    fn contract_wallets_only_where_the_owner_pinned_readers() {
        let c = cfg();
        // a signature that does not recover to the message's address: refused
        // with no network when no readers are pinned
        let msg = issued(&c, "chat.example.com", &key());
        let mut bad = sign(&key(), &msg);
        bad.truncate(bad.rfind('.').unwrap());
        let bad = format!("{bad}.{}", URL_SAFE_NO_PAD.encode([9u8; 130]));
        assert!(verify(&c, &bad, NOW).unwrap_err().contains("not from the address"));
        let mut cc = cfg();
        cc.contract = Some(ContractCfg::parse(&serde_json::json!({ "rpcs": ["https://a.example", "https://b.example"] })).unwrap());
        assert!(verify(&cc, &bad, NOW).unwrap_err().contains("cannot check contract-wallet"));
        // an EOA never touches the readers even when they are pinned
        struct Never;
        impl ChainReaders for Never {
            fn post(&mut self, _: &str, _: &[u8], _: u64, _: usize) -> Result<Vec<u8>, String> { panic!("an EOA asked the chain") }
            fn now(&self) -> u64 { panic!("an EOA asked the readers' clock") }
        }
        assert!(verify_with(&cc, &sign(&key(), &msg), NOW, Some(&mut Never)).is_ok());
        // config: two to seven distinct https readers, quorum at least two
        for bad in [serde_json::json!({ "rpcs": ["https://a.example"] }),
                    serde_json::json!({ "rpcs": ["https://a.example", "https://a.example"] }),
                    serde_json::json!({ "rpcs": ["http://a.example", "https://b.example"] }),
                    serde_json::json!({ "rpcs": ["https://a.example", "https://b.example"], "quorum": 1 }),
                    serde_json::json!({ "rpcs": ["https://a.example", "https://b.example"], "quorum": 3 }),
                    serde_json::json!({ "rpcs": ["https://u:p@a.example", "https://b.example"] }),
                    serde_json::json!({ "rpcs": ["https://a.example/v1/one", "https://a.example/v1/two"] })] {
            assert!(ContractCfg::parse(&bad).is_err(), "{bad}");
        }
        assert!(ContractCfg::parse(&serde_json::json!({ "rpcs": ["http://127.0.0.1:8545", "https://b.example/v1/key"] })).is_ok());
    }

    /// The shared vector: every app carrying this file must verify exactly this
    /// token for this config and time (and the page's own token assembly must
    /// reproduce it). If it moves, update every copy and the docs together.
    #[test]
    fn shared_vector() {
        let c = cfg();
        let msg = issued(&c, "chat.example.com", &key());
        let t = sign(&key(), &msg);
        eprintln!("wallet vector token: {t}");
        assert_eq!(verify(&c, &t, NOW).unwrap().sub, "wallet_0x17c5185167401ed00cf5f5b2fc97d9bbfdb7d025");
        assert_eq!(
            hex(&keccak(t.as_bytes())),
            VECTOR_KECCAK,
            "the token bytes changed: the shared format moved"
        );
    }
    const VECTOR_KECCAK: &str = "57fcd8c9286f84b032f68b4dcf0f90eabf54ccf4cfe19fed27a66f935a0b9649";
}

/// A simulated chain behind pinned readers, for every app's request-level
/// tests (this file is shared, so each crate gets the same simulator). The
/// wallet CONTRACT is honest: it approves exactly the (EIP-191 hash,
/// signature) pairs in `good`, read out of the real calldata, at the block
/// hash the call names. Each reader may lie, lag, fork, sit on another chain,
/// answer garbage, or be down. Clearing `good` is the contract revoking a
/// signature. The clock advances `secs_per_request` per request, so a slow
/// round of reads is a test case too.
#[cfg(test)]
pub mod sim {
    use super::*;

    #[derive(Clone, Copy, PartialEq, Debug)]
    pub enum Reader {
        Honest,
        /// says every signature is valid
        Approves,
        /// says no signature is valid
        Denies,
        /// every block it reports is an hour old
        Stale,
        /// a different chain history at the same numbers
        Forked,
        Down,
        /// reverts every call
        Reverts,
        /// answers a call with something that is not hex
        Garbage,
        /// reports chain id 8454
        WrongChain,
        /// claims a head 400 blocks back (a lagging or lying reader)
        LowHead,
        /// claims a head far in the future, and has no such blocks
        HighHead,
        /// names a block hash that is not 32 bytes of hex
        BadHash,
        /// answers with non-ASCII text where hex belongs (hash and call result)
        Unicode,
    }
    pub const HEAD: u64 = 1_000;
    pub const WALLET: &str = "0x00000000000000000000000000000000000c0de1";
    /// the counterfactual wallet's factory (EIP-6492 cases)
    pub const FACTORY: &str = "0x00000000000000000000000000000000000fac70";

    /// An ERC-6492 wrapper: abi.encode(factory, factoryCalldata, inner) ++ magic.
    pub fn wrap_6492(factory: &str, factory_calldata: &[u8], inner: &[u8]) -> Vec<u8> {
        let word = |n: usize| { let mut w = [0u8; 32]; w[24..].copy_from_slice(&(n as u64).to_be_bytes()); w.to_vec() };
        let padded = |b: &[u8]| { let mut v = b.to_vec(); while v.len() % 32 != 0 { v.push(0); } v };
        let mut f = vec![0u8; 12];
        f.extend(hex_bytes(factory).unwrap());
        let a = padded(factory_calldata);
        let mut out = f;
        out.extend(word(96));
        out.extend(word(96 + 32 + a.len()));
        out.extend(word(factory_calldata.len()));
        out.extend(a);
        out.extend(word(inner.len()));
        out.extend(padded(inner));
        out.extend(ERC6492_MAGIC);
        out
    }

    pub struct Chain {
        pub readers: Vec<Reader>,
        pub good: Vec<([u8; 32], Vec<u8>)>,
        pub now: u64,
        pub quorum: usize,
        pub secs_per_request: u64,
        /// requests answered, so a test can show a path made none
        pub calls: usize,
    }

    /// The hash a wallet contract is asked about for `message`.
    pub fn hash_of(message: &str) -> [u8; 32] {
        eip191_hash(message.as_bytes())
    }

    fn honest_hash(n: u64) -> String {
        format!("0x{:064x}", n * 7 + 1)
    }

    impl Chain {
        pub fn new(readers: Vec<Reader>, now: u64) -> Chain {
            Chain { readers, good: Vec::new(), now, quorum: 2, secs_per_request: 0, calls: 0 }
        }
        pub fn urls(&self) -> Vec<String> {
            (0..self.readers.len()).map(|i| format!("https://rpc{i}.example")).collect()
        }
        /// the `contract_wallets` config block naming these readers
        pub fn json(&self) -> serde_json::Value {
            serde_json::json!({ "rpcs": self.urls(), "quorum": self.quorum, "confirmations": 2, "max_age_secs": 120 })
        }
        pub fn cfg(&self) -> ContractCfg {
            ContractCfg::parse(&self.json()).unwrap()
        }
        fn answer(&self, r: Reader, it: &serde_json::Value) -> serde_json::Value {
            let id = it["id"].clone();
            let ok = |v: serde_json::Value| serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": v });
            let err = |code: i64, m: &str| serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": m } });
            // block times are facts of the chain, fixed at the simulation's start;
            // only the readers' clock (ChainReaders::now) advances
            let now = self.now;
            let hash_of_block = |n: u64| match r {
                Reader::Forked => format!("0x{:064x}", n * 7 + 2),
                Reader::WrongChain => format!("0x{:064x}", n * 13 + 5),
                Reader::BadHash => format!("0x{}", "zz".repeat(32)),
                Reader::Unicode => format!("0x{}", "é".repeat(32)),
                _ => honest_hash(n),
            };
            let block = |n: u64| {
                let ts = if r == Reader::Stale { now.saturating_sub(3600) } else { now.saturating_sub((HEAD.saturating_sub(n)) * 2) };
                serde_json::json!({ "number": format!("0x{n:x}"), "hash": hash_of_block(n), "timestamp": format!("0x{ts:x}") })
            };
            match it["method"].as_str().unwrap_or("") {
                "eth_chainId" => ok(serde_json::json!(format!("0x{:x}", if r == Reader::WrongChain { DEFAULT_CHAIN_ID + 1 } else { DEFAULT_CHAIN_ID }))),
                "eth_getBlockByNumber" => match it["params"][0].as_str().unwrap_or("") {
                    "latest" => ok(block(match r { Reader::LowHead => HEAD - 400, Reader::HighHead => HEAD + 10_000, _ => HEAD })),
                    h => {
                        let n = u64::from_str_radix(h.trim_start_matches("0x"), 16).unwrap_or(u64::MAX);
                        if n > HEAD { ok(serde_json::Value::Null) } else { ok(block(n)) }
                    }
                },
                "eth_call" => {
                    // the call is read AT the block hash it names; an unknown hash is an error
                    let at = it["params"][1]["blockHash"].as_str().unwrap_or("").to_string();
                    if !(0..=HEAD).any(|n| hash_of_block(n) == at) {
                        return err(-32000, "header not found");
                    }
                    let to = it["params"][0]["to"].as_str();
                    let data = it["params"][0]["data"].as_str().unwrap_or("0x");
                    // a deployless call of the ERC-6492 validator: (signer, hash, wrapped signature) follow its code
                    if to.is_none() {
                        let Some(args) = data.strip_prefix(ERC6492_VALIDATOR).and_then(|a| hex_bytes(&format!("0x{a}"))) else {
                            return err(-32000, "not the ERC-6492 validator");
                        };
                        let honest = args.len() >= 128 && hex(&args[12..32]) == WALLET[2..] && {
                            let h: [u8; 32] = args[32..64].try_into().unwrap();
                            let len = u64::from_str_radix(&hex(&args[96..128]), 16).unwrap_or(0) as usize;
                            let sig = args.get(128..128 + len).unwrap_or(&[]);
                            // the counterfactual wallet: its factory must be the one it is deployed by
                            matches!(erc6492_parts(sig), Ok(Some((f, _, _))) if f == FACTORY) && self.good.iter().any(|(gh, gs)| *gh == h && gs[..] == *sig)
                        };
                        return match r {
                            Reader::Reverts => err(3, "execution reverted"),
                            Reader::Garbage => ok(serde_json::json!("0xnot-hex")),
                            Reader::Unicode => ok(serde_json::json!("0xñ€")),
                            _ => ok(serde_json::json!(match r { Reader::Approves => "0x01", Reader::Denies => "0x00", _ => if honest { "0x01" } else { "0x00" } })),
                        };
                    }
                    let to = to.unwrap_or("");
                    let raw = hex_bytes(data).unwrap_or_default();
                    let honest = to == WALLET && raw.len() >= 100 && raw[..4] == EIP1271_MAGIC && {
                        let h: [u8; 32] = raw[4..36].try_into().unwrap();
                        let len = u64::from_str_radix(&hex(&raw[68..100]), 16).unwrap_or(0) as usize;
                        let sig = raw.get(100..100 + len).unwrap_or(&[]);
                        self.good.iter().any(|(gh, gs)| *gh == h && gs[..] == *sig)
                    };
                    match r {
                        Reader::Reverts => err(3, "execution reverted"),
                        Reader::Garbage => ok(serde_json::json!("0xnot-hex")),
                        Reader::Unicode => ok(serde_json::json!(format!("0x{}", "ñ€".repeat(16)))),
                        _ => {
                            let approve = match r { Reader::Approves => true, Reader::Denies => false, _ => honest };
                            ok(serde_json::json!(if approve { format!("0x1626ba7e{}", "0".repeat(56)) } else { format!("0xffffffff{}", "0".repeat(56)) }))
                        }
                    }
                }
                m => err(-32601, m),
            }
        }
    }

    impl ChainReaders for Chain {
        fn post(&mut self, url: &str, body: &[u8], _t: u64, _m: usize) -> Result<Vec<u8>, String> {
            let i = self.urls().iter().position(|u| u == url).ok_or("unknown reader")?;
            let r = self.readers[i];
            self.calls += 1;
            if r == Reader::Down {
                return Err("connection refused".into());
            }
            let req: serde_json::Value = serde_json::from_slice(body).map_err(|_| "bad JSON")?;
            let items = req.as_array().ok_or("expected a batch")?;
            Ok(serde_json::Value::Array(items.iter().map(|it| self.answer(r, it)).collect()).to_string().into_bytes())
        }
        fn now(&self) -> u64 {
            self.now + self.calls as u64 * self.secs_per_request
        }
    }
}
