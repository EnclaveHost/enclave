//! The Rust mirror of isolation/contract (Go): bundle format and app ID, report binding, the
//! one-field report request, and the lifecycle state machine. `vbslike-host vectors <vectors.json>`
//! runs isolation/contract/vectors.json against this code, so the two implementations cannot drift
//! without a failing check. Anything that changes meaning bumps ABI in both places.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Mutex;

pub const ABI: &str = "enclave-domain-abi/1";
pub const BUNDLE_MAGIC: &[u8] = b"ENCLAVE-BUNDLE/1\n";
pub const MAX_MANIFEST: usize = 64 << 10;
pub const NONCE_LEN: usize = 32;
/// The only artifact kind a bundle may carry: the portable component, compiled inside the domain.
pub const KIND_WASM_COMPONENT: &str = "wasm-component";
pub const TIER_HYPERV: &str = "T0-hv";
pub const ABI2: &str = "enclave-domain-abi/2";
pub const WX_ENFORCED: &str = "enforced";
pub const CACHE_NONE: &str = "none";
pub const CACHE_AUTHENTICATED: &str = "authenticated";

/// The runtime that compiles and runs the artifact inside the domain (isolation/contract/runtime.go):
/// name, version, target ISA, CPU-feature policy, W^X and cache mode. Bound into the report by bind2.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct RuntimeIdentity {
    pub name: String,
    pub version: String,
    /// "jit" (target == host ISA) or "interpreter" (target pulley64: a stock Pixel pVM allows no
    /// executable page, so the component is compiled to Pulley bytecode inside it and interpreted)
    pub execution: String,
    #[serde(rename = "targetIsa")]
    pub target_isa: String,
    #[serde(rename = "hostIsa")]
    pub host_isa: String,
    #[serde(rename = "cpuFeatures")]
    pub cpu_features: String,
    pub wx: String,
    pub cache: String,
}

impl RuntimeIdentity {
    /// Fail closed: an identity that cannot state the requirements is refused.
    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_empty() || self.version.is_empty() {
            return Err("runtime name and version are required".into());
        }
        if self.host_isa != "x86_64" && self.host_isa != "aarch64" {
            return Err(format!("host ISA {:?} is not one of x86_64, aarch64", self.host_isa));
        }
        match self.execution.as_str() {
            "jit" => {
                if self.target_isa != self.host_isa {
                    return Err(format!("a JIT emits the host's own ISA: target {:?} must equal host {:?}", self.target_isa, self.host_isa));
                }
            }
            "interpreter" => {
                if self.target_isa != "pulley64" {
                    return Err(format!("an interpreter runs pulley64 bytecode, not {:?}", self.target_isa));
                }
            }
            other => return Err(format!("execution {other:?} is not one of jit, interpreter")),
        }
        if self.cpu_features.is_empty() {
            return Err("the CPU-feature policy must be stated".into());
        }
        if self.wx != WX_ENFORCED {
            return Err("a runtime that cannot state W^X as enforced is not admissible".into());
        }
        if self.cache != CACHE_NONE && self.cache != CACHE_AUTHENTICATED {
            return Err(format!("cache mode {:?} is not one of none, authenticated", self.cache));
        }
        Ok(())
    }
}

pub fn runtime_id(r: &RuntimeIdentity) -> Result<[u8; 32], String> {
    r.validate()?;
    Ok(Sha256::digest(canonical(r)).into())
}

/// ABI/2: key, nonce and runtime identity in one binding for report_data[0:32].
pub fn bind2(spki: &[u8], nonce: &[u8], runtime_id: &[u8; 32]) -> Option<[u8; 32]> {
    if nonce.len() != NONCE_LEN {
        return None;
    }
    let mut h = Sha256::new();
    h.update(b"enclave-bind-v2\n");
    h.update(spki);
    h.update(nonce);
    h.update(runtime_id);
    Some(h.finalize().into())
}

/// A compiled artifact a domain may keep is named by the bundle AND the runtime identity.
pub fn cache_key(app: &[u8; 32], runtime_id: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"enclave-compiled-cache-v1\n");
    h.update(app);
    h.update(runtime_id);
    h.finalize().into()
}
pub const FORMAT_HYPERV: &str = "hyperv-partition-domain/v1";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Manifest {
    pub abi: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub label: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub world: String,
    pub artifact: Artifact,
    /// The port a `wasi:cli` command binds its own HTTP server on (enclave-catalog-bundle/2).
    ///
    /// It MUST be declared here or serde drops it on deserialize and `canonical(&m) != mb`, so
    /// every /2 bundle is refused at load as "manifest is not in canonical form" - found by
    /// enclave-5d by reading this file. In the canonical key order `http` sorts between `artifact`
    /// and `policy`, which is where this field sits, so the order needs nothing else.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub http: i64,
    pub policy: Policy,
}

fn is_zero(v: &i64) -> bool { *v == 0 }
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Artifact {
    pub kind: String,
    pub sha256: String,
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct Policy {
    #[serde(rename = "cpuPercent")]
    pub cpu_percent: i64,
    #[serde(rename = "memMiB")]
    pub mem_mib: i64,
    pub vcpus: i64,
}

/// Canonical JSON: compact, keys sorted at every level. serde_json's Value keeps a BTreeMap, and its
/// string escaping is the standard minimal one, which is what the Go side emits with HTML escaping off.
pub fn canonical<T: Serialize>(v: &T) -> Vec<u8> {
    let val: Value = serde_json::to_value(v).expect("serialises");
    serde_json::to_vec(&val).expect("serialises")
}

pub fn app_id(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}

pub fn is_bundle(b: &[u8]) -> bool {
    b.starts_with(BUNDLE_MAGIC)
}

#[derive(Debug, PartialEq)]
pub enum ParseError {
    NotBundle,
    Malformed(String),
}

pub fn parse(b: &[u8]) -> Result<(Manifest, &[u8]), ParseError> {
    if !is_bundle(b) {
        return Err(ParseError::NotBundle);
    }
    let p = &b[BUNDLE_MAGIC.len()..];
    if p.len() < 4 {
        return Err(ParseError::Malformed("truncated at manifest length".into()));
    }
    let ml = u32::from_le_bytes([p[0], p[1], p[2], p[3]]) as usize;
    let p = &p[4..];
    if ml > MAX_MANIFEST || ml > p.len() {
        return Err(ParseError::Malformed("manifest length out of range".into()));
    }
    let mb = &p[..ml];
    let p = &p[ml..];
    if p.len() < 4 {
        return Err(ParseError::Malformed("truncated at artifact length".into()));
    }
    let al = u32::from_le_bytes([p[0], p[1], p[2], p[3]]) as usize;
    let art = &p[4..];
    if al != art.len() {
        return Err(ParseError::Malformed(format!("artifact length {al} does not match {} bytes present", art.len())));
    }
    let m: Manifest = serde_json::from_slice(mb).map_err(|e| ParseError::Malformed(format!("manifest: {e}")))?;
    if canonical(&m) != mb {
        return Err(ParseError::Malformed("manifest is not in canonical form".into()));
    }
    if m.abi != ABI {
        return Err(ParseError::Malformed(format!("abi {:?} is not {ABI:?}", m.abi)));
    }
    if m.artifact.kind != KIND_WASM_COMPONENT {
        return Err(ParseError::Malformed(format!("artifact kind {:?} is not distributable: only {KIND_WASM_COMPONENT} is", m.artifact.kind)));
    }
    if m.artifact.sha256 != hex::encode(Sha256::digest(art)) {
        return Err(ParseError::Malformed("bundle manifest names a different artifact than it carries".into()));
    }
    // The world decides whether a port may be named, and mirrors isolation/contract/bundle.go Parse
    // so a bundle reads the same on every backend. A /1 bundle that names a port and a /2 bundle
    // that names none are each refused BY NAME rather than approximated.
    match m.world.as_str() {
        "" | "wasi:http" => {
            if m.http != 0 {
                return Err(ParseError::Malformed(format!(
                    "world {:?} serves no port of its own, and this manifest names http {}", m.world, m.http)));
            }
        }
        "wasi:cli" => {
            if m.http < 1 || m.http > 49999 {
                return Err(ParseError::Malformed(format!(
                    "a wasi:cli command must name its http port in 1..=49999, not {}", m.http)));
            }
        }
        other => return Err(ParseError::Malformed(format!("world {other:?} is not one this runtime serves"))),
    }
    Ok((m, art))
}

pub fn bind(spki: &[u8], nonce: &[u8]) -> Option<[u8; 32]> {
    if nonce.len() != NONCE_LEN {
        return None;
    }
    let mut h = Sha256::new();
    h.update(spki);
    h.update(nonce);
    Some(h.finalize().into())
}

pub fn report_data(bind: &[u8; 32], app: &[u8; 32]) -> [u8; 64] {
    let mut rd = [0u8; 64];
    rd[..32].copy_from_slice(bind);
    rd[32..].copy_from_slice(app);
    rd
}

/// The whole of what a domain may ask: `bind`. Any other field is not read.
pub fn parse_report_request(b: &[u8]) -> Result<[u8; 32], String> {
    let v: Value = serde_json::from_slice(b).map_err(|e| e.to_string())?;
    let s = v.get("bind").and_then(|x| x.as_str()).ok_or("bind must be 32 bytes of hex")?;
    let raw = hex::decode(s).map_err(|_| "bind must be 32 bytes of hex".to_string())?;
    if raw.len() != 32 {
        return Err("bind must be 32 bytes of hex".into());
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&raw);
    Ok(out)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    Starting,
    Running,
    Ending,
    Ended,
}
impl State {
    pub fn name(self) -> &'static str {
        match self {
            State::Starting => "starting",
            State::Running => "running",
            State::Ending => "ending",
            State::Ended => "ended",
        }
    }
}

/// starting -> running -> ending -> ended, reclamation exactly once (isolation/contract lifecycle.go).
pub struct Lifecycle {
    inner: Mutex<Inner>,
    once: std::sync::Once,
}
struct Inner {
    state: State,
    end_wanted: String,
    reclaims: u32,
}
impl Lifecycle {
    pub fn new(s: State) -> Lifecycle {
        Lifecycle { inner: Mutex::new(Inner { state: s, end_wanted: String::new(), reclaims: 0 }), once: std::sync::Once::new() }
    }
    pub fn state(&self) -> State {
        self.inner.lock().unwrap().state
    }
    pub fn request_end(&self, why: &str) -> bool {
        let mut i = self.inner.lock().unwrap();
        match i.state {
            State::Starting => {
                if i.end_wanted.is_empty() {
                    i.end_wanted = why.to_string();
                }
                false
            }
            State::Ending | State::Ended => false,
            State::Running => {
                i.state = State::Ending;
                true
            }
        }
    }
    pub fn finish_start(&self) -> String {
        let mut i = self.inner.lock().unwrap();
        if i.state == State::Starting {
            i.state = State::Running;
        }
        i.end_wanted.clone()
    }
    pub fn fail_start(&self) {
        self.inner.lock().unwrap().state = State::Ending;
    }
    pub fn reclaim(&self, f: impl FnOnce()) {
        self.once.call_once(|| {
            self.inner.lock().unwrap().reclaims += 1;
            f();
            self.inner.lock().unwrap().state = State::Ended;
        });
    }
    pub fn reclaims(&self) -> u32 {
        self.inner.lock().unwrap().reclaims
    }
}

/// Run isolation/contract/vectors.json against this implementation. Returns the failures.
pub fn run_vectors(path: &str) -> Result<Vec<String>, String> {
    let raw = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    let v: Value = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let mut fails = Vec::new();
    if v["abi"].as_str() != Some(ABI) {
        fails.push(format!("abi: vectors say {:?}, this code is {ABI}", v["abi"]));
    }
    for b in v["bundles"].as_array().cloned().unwrap_or_default() {
        let name = b["name"].as_str().unwrap_or("?");
        let bundle = hex::decode(b["bundle_hex"].as_str().unwrap_or("")).unwrap_or_default();
        if hex::encode(app_id(&bundle)) != b["app_id"].as_str().unwrap_or("") {
            fails.push(format!("bundle {name}: app id"));
        }
        let parses = b["parses"].as_bool().unwrap_or(false);
        match parse(&bundle) {
            Ok((m, art)) => {
                if !parses {
                    fails.push(format!("bundle {name}: parsed but must not"));
                }
                if hex::encode(art) != b["artifact_hex"].as_str().unwrap_or("") {
                    fails.push(format!("bundle {name}: artifact"));
                }
                let want: Manifest = serde_json::from_value(b["manifest"].clone()).unwrap_or_default();
                if m != want {
                    fails.push(format!("bundle {name}: manifest {m:?} != {want:?}"));
                }
            }
            Err(e) => {
                if parses {
                    fails.push(format!("bundle {name}: refused: {e:?}"));
                }
                if b["bare"].as_bool().unwrap_or(false) && e != ParseError::NotBundle {
                    fails.push(format!("bundle {name}: bare bytes must be NotBundle, got {e:?}"));
                }
            }
        }
    }
    for x in v["bind"].as_array().cloned().unwrap_or_default() {
        let spki = hex::decode(x["spki_hex"].as_str().unwrap_or("")).unwrap_or_default();
        let nonce = hex::decode(x["nonce_hex"].as_str().unwrap_or("")).unwrap_or_default();
        let b = bind(&spki, &nonce).unwrap_or([0; 32]);
        if hex::encode(b) != x["bind"].as_str().unwrap_or("") {
            fails.push("bind".into());
        }
        let mut app = [0u8; 32];
        app.copy_from_slice(&hex::decode(x["app_id"].as_str().unwrap_or("")).unwrap_or(vec![0; 32]));
        if hex::encode(report_data(&b, &app)) != x["report_data"].as_str().unwrap_or("") {
            fails.push("report_data".into());
        }
    }
    for r in v["report_requests"].as_array().cloned().unwrap_or_default() {
        let j = r["json"].as_str().unwrap_or("");
        let ok = r["ok"].as_bool().unwrap_or(false);
        match parse_report_request(j.as_bytes()) {
            Ok(b) => {
                if !ok || hex::encode(b) != r["bind"].as_str().unwrap_or("") {
                    fails.push(format!("request {j}: accepted wrongly"));
                }
            }
            Err(_) => {
                if ok {
                    fails.push(format!("request {j}: refused wrongly"));
                }
            }
        }
    }
    if v["abi2"].as_str() != Some(ABI2) {
        fails.push(format!("abi2: vectors say {:?}, this code is {ABI2}", v["abi2"]));
    }
    // runtime identities: validity, digest, binding and cache key, with the bind vector's key and nonce
    // and the reference bundle's app id
    let spki_v = hex::decode(v["bind"][0]["spki_hex"].as_str().unwrap_or("")).unwrap_or_default();
    let nonce_v = hex::decode(v["bind"][0]["nonce_hex"].as_str().unwrap_or("")).unwrap_or_default();
    let mut app_v = [0u8; 32];
    app_v.copy_from_slice(&hex::decode(v["bundles"][0]["app_id"].as_str().unwrap_or("")).unwrap_or(vec![0; 32]));
    for r in v["runtime"].as_array().cloned().unwrap_or_default() {
        let note = r["note"].as_str().unwrap_or("?").to_string();
        let id: RuntimeIdentity = serde_json::from_value(r["identity"].clone()).unwrap_or_default();
        let valid = r["valid"].as_bool().unwrap_or(false);
        match runtime_id(&id) {
            Ok(rid) => {
                if !valid {
                    fails.push(format!("runtime {note}: accepted but must be refused"));
                    continue;
                }
                if hex::encode(rid) != r["runtime_id"].as_str().unwrap_or("") {
                    fails.push(format!("runtime {note}: id"));
                }
                if hex::encode(bind2(&spki_v, &nonce_v, &rid).unwrap_or([0; 32])) != r["bind2"].as_str().unwrap_or("") {
                    fails.push(format!("runtime {note}: bind2"));
                }
                if hex::encode(cache_key(&app_v, &rid)) != r["cache_key"].as_str().unwrap_or("") {
                    fails.push(format!("runtime {note}: cache key"));
                }
            }
            Err(e) => {
                if valid {
                    fails.push(format!("runtime {note}: refused wrongly: {e}"));
                }
            }
        }
    }
    for s in v["lifecycle"].as_array().cloned().unwrap_or_default() {
        let name = s["name"].as_str().unwrap_or("?");
        let l = Lifecycle::new(State::Starting);
        let mut got = Vec::new();
        for op in s["ops"].as_array().cloned().unwrap_or_default() {
            let op = op.as_str().unwrap_or("");
            if let Some(why) = op.strip_prefix("request_end:") {
                got.push(format!("end:{}", l.request_end(why)));
            } else if op == "finish_start" {
                got.push(format!("start:{}", l.finish_start()));
            } else if op == "fail_start" {
                l.fail_start();
                got.push("fail".into());
            } else if op == "reclaim" {
                l.reclaim(|| {});
                got.push(format!("reclaim:{}", l.reclaims()));
            } else if op.starts_with("state") {
                got.push(format!("state:{}", l.state().name()));
            } else {
                got.push("unknown-op".into());
            }
        }
        let want: Vec<String> = s["results"].as_array().cloned().unwrap_or_default().iter().map(|x| x.as_str().unwrap_or("").to_string()).collect();
        if got != want || l.state().name() != s["final"].as_str().unwrap_or("") {
            fails.push(format!("lifecycle {name}: got {got:?} final {}, want {want:?} final {}", l.state().name(), s["final"]));
        }
    }
    Ok(fails)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Assemble a bundle the way Build does, so `parse` sees exactly what a real one carries.
    fn bundle(m: &Manifest, art: &[u8]) -> Vec<u8> {
        let mb = canonical(m);
        let mut b = Vec::from(BUNDLE_MAGIC);
        b.extend_from_slice(&(mb.len() as u32).to_le_bytes());
        b.extend_from_slice(&mb);
        b.extend_from_slice(&(art.len() as u32).to_le_bytes());
        b.extend_from_slice(art);
        b
    }

    fn manifest(world: &str, http: i64, art: &[u8]) -> Manifest {
        Manifest {
            abi: ABI.to_string(),
            label: String::new(),
            world: world.to_string(),
            artifact: Artifact { kind: KIND_WASM_COMPONENT.to_string(), sha256: hex::encode(Sha256::digest(art)) },
            http,
            policy: Policy { cpu_percent: 100, mem_mib: 512, vcpus: 1 },
        }
    }

    const ART: &[u8] = b"\x00asm\x0d\x00\x01\x00not-really-a-component";

    /// The defect this whole field exists for: without `http` on Manifest, serde dropped it on
    /// deserialize, `canonical(&m) != mb`, and EVERY /2 bundle was refused as non-canonical.
    #[test]
    fn a_wasi_cli_bundle_naming_a_port_round_trips() {
        let b = bundle(&manifest("wasi:cli", 8080, ART), ART);
        let (m, art) = parse(&b).expect("a /2 bundle must parse");
        assert_eq!(m.http, 8080, "the port must survive the round trip");
        assert_eq!(m.world, "wasi:cli");
        assert_eq!(art, ART);
    }

    /// A /1 bundle must serialise byte-for-byte as it did before the field existed.
    #[test]
    fn a_proxy_bundle_omits_http_entirely() {
        let m = manifest("wasi:http", 0, ART);
        let mb = canonical(&m);
        let s = String::from_utf8(mb.clone()).unwrap();
        assert!(!s.contains("\"http\""), "http must be omitted when zero, or every /1 AppID changes: {s}");
        parse(&bundle(&m, ART)).expect("a /1 bundle must still parse");
        // and the canonical key order puts http between artifact and policy when it IS present
        let s2 = String::from_utf8(canonical(&manifest("wasi:cli", 1, ART))).unwrap();
        let (a, h, p) = (s2.find("\"artifact\"").unwrap(), s2.find("\"http\"").unwrap(), s2.find("\"policy\"").unwrap());
        assert!(a < h && h < p, "http sorts between artifact and policy: {s2}");
    }

    #[test]
    fn a_world_that_serves_no_port_may_not_name_one() {
        for world in ["", "wasi:http"] {
            let e = parse(&bundle(&manifest(world, 8080, ART), ART)).unwrap_err();
            match e {
                ParseError::Malformed(m) => assert!(m.contains("serves no port of its own"), "{m}"),
                other => panic!("expected Malformed, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_command_must_name_a_port_in_range() {
        for http in [0, -1, 50000, 65535] {
            let e = parse(&bundle(&manifest("wasi:cli", http, ART), ART)).unwrap_err();
            match e {
                ParseError::Malformed(m) => assert!(m.contains("1..=49999"), "{http}: {m}"),
                other => panic!("expected Malformed for {http}, got {other:?}"),
            }
        }
        for http in [1, 49999] {
            parse(&bundle(&manifest("wasi:cli", http, ART), ART)).unwrap_or_else(|e| panic!("{http} must be accepted: {e:?}"));
        }
    }

    #[test]
    fn an_unknown_world_is_refused_by_name() {
        let e = parse(&bundle(&manifest("wasi:snake", 0, ART), ART)).unwrap_err();
        match e {
            ParseError::Malformed(m) => assert!(m.contains("wasi:snake"), "the refusal names the world: {m}"),
            other => panic!("expected Malformed, got {other:?}"),
        }
    }
}
