//! The deployment's protection rules (the options envelope's `waf`), enforced in the VM's front: the only place on this
//! host that sees the request in clear (TLS ends here). MIRRORED from the platform runner (supervisor.js wafGate /
//! wafPathBlocked) and the CPU host (windows/node/waf.mjs), down to the status codes and the error bodies: the relay
//! AND-folds `waf` across the fleet, so the same envelope must protect the same way on every host that says it does.
//!
//! The host agent validates the envelope with the platform's own parser (windows/node/waf.mjs parseWaf) and hands this
//! module its normalised JSON; `Waf::parse` checks that shape again rather than trusting it.
//!
//! WHO a limit counts. The app's hostname reaches the VM as TLS spliced through TUNA and the phone's bridge: nothing on
//! the way inserts a forwarded address, so any `x-forwarded-for` here was written by the caller and would let anyone mint
//! a fresh bucket per request. Every caller therefore shares ONE bucket and one concurrency count per deployment -- the
//! CPU host's app-zone rule, published there and here rather than implied.
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Root-anchored prefixes of the paths bulk scanners try. The platform's list, verbatim.
pub const SCANNER_PATHS: &[&str] = &[
    "/.env", "/.git", "/.svn", "/.aws", "/.ssh", "/.htaccess", "/.htpasswd", "/.ds_store", "/.vscode", "/.idea", "/wp-admin",
    "/wp-login.php", "/wp-includes", "/wp-content", "/xmlrpc.php", "/phpmyadmin", "/phpinfo", "/cgi-bin", "/vendor/phpunit",
    "/server-status", "/actuator", "/web.config", "/appsettings.json", "/id_rsa", "/backup.sql", "/dump.sql", "/config.php",
];

/// The rules, normalised (parseWaf's output).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Rules {
    pub rps: Option<f64>,
    pub burst: Option<f64>,
    pub max_concurrent: Option<u32>,
    pub max_body_mb: Option<f64>,
    pub methods: Option<Vec<String>>,
    pub path_block: Option<Vec<String>>,
    pub block_scanners: bool,
    pub ua_block: Option<Vec<String>>,
}

/// A refusal: the status, the error code, the message, and extra headers.
#[derive(Debug, Clone, PartialEq)]
pub struct Deny {
    pub status: u16,
    pub error: &'static str,
    pub message: String,
    pub retry_after: Option<u64>,
}
impl Deny {
    /// The answer's body, as the platform writes it.
    pub fn body(&self) -> String {
        format!("{{\"error\":{},\"message\":{}}}", json_str(self.error), json_str(&self.message))
    }
}

/// The rules and their per-deployment state (in memory only: a restart forgives a burst).
pub struct Waf {
    pub rules: Rules,
    bucket: Mutex<(f64, Instant)>,
    active: Arc<AtomicU32>,
}

/// Holds one concurrency slot; dropping it gives the slot back (once).
pub struct Slot(Option<Arc<AtomicU32>>);
impl Drop for Slot {
    fn drop(&mut self) {
        if let Some(a) = self.0.take() {
            a.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

fn num(v: &serde_like::Value, min: f64, max: f64, int: bool) -> Result<f64, String> {
    let x = v.as_f64().ok_or("not a number")?;
    if !x.is_finite() || x < min || x > max || (int && x.fract() != 0.0) {
        return Err(format!("must be {} in [{min}, {max}]", if int { "an integer" } else { "a number" }));
    }
    Ok(x)
}

impl Waf {
    /// The normalised rules from their JSON (`{"rps":..,"burst":..,"maxConcurrent":..,"maxBodyMb":..,"methods":[..],
    /// "pathBlock":[..],"blockScanners":true,"uaBlock":[..]}`), checked again: the platform's bounds, lower-cased lists.
    pub fn parse(json: &str) -> Result<Waf, String> {
        let v = serde_like::parse(json).map_err(|e| format!("waf is not JSON: {e}"))?;
        let o = v.as_object().ok_or("waf must be a JSON object")?;
        let mut r = Rules::default();
        for (k, x) in o {
            let bad = |e: String| format!("waf.{k} {e}");
            match k.as_str() {
                "rps" => r.rps = Some(num(x, 0.1, 10000.0, false).map_err(bad)?),
                "burst" => r.burst = Some(num(x, 1.0, 100000.0, true).map_err(bad)?),
                "maxConcurrent" => r.max_concurrent = Some(num(x, 1.0, 10000.0, true).map_err(bad)? as u32),
                "maxBodyMb" => r.max_body_mb = Some(num(x, 0.001, 1024.0, false).map_err(bad)?),
                "blockScanners" => r.block_scanners = x.as_bool().ok_or_else(|| bad("must be a boolean".into()))?,
                "methods" | "pathBlock" | "uaBlock" => {
                    let (max, max_len) = match k.as_str() { "methods" => (10, 10), "pathBlock" => (64, 200), _ => (32, 100) };
                    let a = x.as_array().filter(|a| !a.is_empty() && a.len() <= max).ok_or_else(|| bad(format!("must be an array of 1..{max}")))?;
                    let mut out: Vec<String> = Vec::new();
                    for e in a {
                        let s = e.as_str().map(str::trim).filter(|s| !s.is_empty() && s.len() <= max_len).ok_or_else(|| bad("entry is not a string".into()))?;
                        let ok = match k.as_str() {
                            "methods" => s.len() >= 3 && s.bytes().all(|b| b.is_ascii_alphabetic()),
                            "pathBlock" => s.starts_with('/'),
                            _ => s.len() >= 3,
                        };
                        if !ok {
                            return Err(bad(format!("entry {s:?} is not allowed")));
                        }
                        let s = if k == "methods" { s.to_ascii_uppercase() } else { s.to_lowercase() };
                        if !out.contains(&s) {
                            out.push(s);
                        }
                    }
                    match k.as_str() { "methods" => r.methods = Some(out), "pathBlock" => r.path_block = Some(out), _ => r.ua_block = Some(out) }
                }
                _ => return Err(format!("unknown waf option {k:?}")),
            }
        }
        if r.burst.is_some() && r.rps.is_none() {
            return Err("waf.burst needs waf.rps".into());
        }
        if let (Some(rps), None) = (r.rps, r.burst) {
            r.burst = Some((rps * 4.0).ceil().max(5.0)); // default: ~4 s of headroom
        }
        if r == Rules::default() {
            return Err("waf enables nothing".into());
        }
        let burst = r.burst.unwrap_or(0.0);
        Ok(Waf { rules: r, bucket: Mutex::new((burst, Instant::now())), active: Arc::new(AtomicU32::new(0)) })
    }

    /// The body ceiling in bytes, when the rules set one.
    pub fn body_limit(&self) -> Option<u64> {
        self.rules.max_body_mb.map(|mb| (mb * 1048576.0).ceil() as u64)
    }

    /// Is this request path blocked? Decoded first (percent-encoding must not dodge a prefix), the query stripped,
    /// lower-cased, leading slashes collapsed.
    pub fn path_blocked(&self, path_and_query: &str) -> bool {
        let raw = path_and_query.split('?').next().unwrap_or("/");
        let p = percent_decode(raw).unwrap_or_else(|| raw.to_string());
        let p = format!("/{}", p.trim_start_matches('/')).to_lowercase();
        (self.rules.block_scanners && SCANNER_PATHS.iter().any(|x| p.starts_with(x)))
            || self.rules.path_block.as_ref().is_some_and(|l| l.iter().any(|x| p.starts_with(x.as_str())))
    }

    /// One request: Ok(slot) to serve it (the slot is held until the response is done), or the refusal.
    pub fn check(&self, method: &str, path_and_query: &str, user_agent: &str, content_length: Option<u64>) -> Result<Slot, Deny> {
        let r = &self.rules;
        let deny = |status, error, message: String, retry_after| Deny { status, error, message, retry_after };
        if let Some(m) = &r.methods {
            if !m.iter().any(|x| x.eq_ignore_ascii_case(method)) {
                return Err(deny(405, "waf_method", format!("This deployment's protection rules allow only: {}.", m.join(", ")), None));
            }
        }
        if (r.block_scanners || r.path_block.is_some()) && self.path_blocked(path_and_query) {
            return Err(deny(403, "waf_path", "Blocked by this deployment's protection rules.".into(), None));
        }
        if let Some(l) = &r.ua_block {
            let ua = user_agent.to_lowercase();
            if l.iter().any(|s| ua.contains(s.as_str())) {
                return Err(deny(403, "waf_agent", "Blocked by this deployment's protection rules.".into(), None));
            }
        }
        if let (Some(mb), Some(cl)) = (r.max_body_mb, content_length) {
            if cl as f64 > mb * 1048576.0 {
                return Err(deny(413, "waf_body", format!("Request body exceeds this deployment's {} MB limit.", js_num(mb)), None));
            }
        }
        let mut slot = Slot(None);
        if let Some(max) = r.max_concurrent {
            let n = self.active.fetch_add(1, Ordering::AcqRel);
            if n >= max {
                self.active.fetch_sub(1, Ordering::AcqRel);
                return Err(deny(429, "waf_busy", format!("Too many concurrent requests from your address (limit {max})."), Some(1)));
            }
            slot = Slot(Some(self.active.clone()));
        }
        if let (Some(rps), Some(burst)) = (r.rps, r.burst) {
            let mut b = self.bucket.lock().unwrap_or_else(|p| p.into_inner());
            let now = Instant::now();
            b.0 = (b.0 + now.duration_since(b.1).as_secs_f64() * rps).min(burst);
            b.1 = now;
            if b.0 < 1.0 {
                let wait = ((1.0 - b.0) / rps).ceil().max(1.0) as u64;
                return Err(deny(429, "waf_rate_limited", format!("Rate limit: this deployment allows {} requests/sec per address (burst {}).", js_num(rps), js_num(burst)), Some(wait)));
            }
            b.0 -= 1.0;
        }
        Ok(slot)
    }
}

/// The refusal for a body found too big while it streams (no length was declared, or it lied).
pub fn body_refusal(limit: u64) -> Deny {
    Deny { status: 413, error: "waf_body", message: format!("Request body exceeds the {:.3} MB limit for this deployment.", limit as f64 / 1048576.0), retry_after: None }
}

/// A number as JavaScript prints it (10, 0.5, 2.25): the platform's messages are JS template strings.
fn js_num(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        format!("{}", x as i64)
    } else {
        format!("{x}")
    }
}

/// decodeURIComponent: None on a malformed escape or bytes that are not UTF-8 (then the raw path is matched).
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// The little JSON this module reads (no serde in the runtime): objects, arrays, strings, numbers, booleans, null.
pub mod serde_like {
    #[derive(Debug, Clone, PartialEq)]
    pub enum Value {
        Null,
        Bool(bool),
        Num(f64),
        Str(String),
        Arr(Vec<Value>),
        Obj(Vec<(String, Value)>),
    }
    impl Value {
        pub fn as_f64(&self) -> Option<f64> {
            if let Value::Num(x) = self { Some(*x) } else { None }
        }
        pub fn as_bool(&self) -> Option<bool> {
            if let Value::Bool(x) = self { Some(*x) } else { None }
        }
        pub fn as_str(&self) -> Option<&str> {
            if let Value::Str(x) = self { Some(x) } else { None }
        }
        pub fn as_array(&self) -> Option<&Vec<Value>> {
            if let Value::Arr(x) = self { Some(x) } else { None }
        }
        pub fn as_object(&self) -> Option<&Vec<(String, Value)>> {
            if let Value::Obj(x) = self { Some(x) } else { None }
        }
    }
    pub fn parse(s: &str) -> Result<Value, String> {
        let mut p = P { b: s.as_bytes(), i: 0, depth: 0 };
        let v = p.value()?;
        p.ws();
        if p.i != p.b.len() {
            return Err("trailing bytes".into());
        }
        Ok(v)
    }
    struct P<'a> {
        b: &'a [u8],
        i: usize,
        depth: u32,
    }
    impl P<'_> {
        fn ws(&mut self) {
            while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
                self.i += 1;
            }
        }
        fn eat(&mut self, c: u8) -> Result<(), String> {
            self.ws();
            if self.b.get(self.i) == Some(&c) {
                self.i += 1;
                Ok(())
            } else {
                Err(format!("expected {:?} at {}", c as char, self.i))
            }
        }
        fn value(&mut self) -> Result<Value, String> {
            self.ws();
            self.depth += 1;
            if self.depth > 32 {
                return Err("nested too deep".into());
            }
            let v = match self.b.get(self.i) {
                Some(b'{') => {
                    self.i += 1;
                    let mut o = Vec::new();
                    self.ws();
                    if self.b.get(self.i) == Some(&b'}') {
                        self.i += 1;
                    } else {
                        loop {
                            self.ws();
                            let k = self.string()?;
                            self.eat(b':')?;
                            let v = self.value()?;
                            if o.iter().any(|(x, _): &(String, Value)| x == &k) {
                                return Err(format!("duplicate key {k:?}"));
                            }
                            o.push((k, v));
                            self.ws();
                            match self.b.get(self.i) {
                                Some(b',') => self.i += 1,
                                Some(b'}') => {
                                    self.i += 1;
                                    break;
                                }
                                _ => return Err("expected , or }".into()),
                            }
                        }
                    }
                    Value::Obj(o)
                }
                Some(b'[') => {
                    self.i += 1;
                    let mut a = Vec::new();
                    self.ws();
                    if self.b.get(self.i) == Some(&b']') {
                        self.i += 1;
                    } else {
                        loop {
                            a.push(self.value()?);
                            self.ws();
                            match self.b.get(self.i) {
                                Some(b',') => self.i += 1,
                                Some(b']') => {
                                    self.i += 1;
                                    break;
                                }
                                _ => return Err("expected , or ]".into()),
                            }
                        }
                    }
                    Value::Arr(a)
                }
                Some(b'"') => Value::Str(self.string()?),
                Some(b't') if self.b[self.i..].starts_with(b"true") => {
                    self.i += 4;
                    Value::Bool(true)
                }
                Some(b'f') if self.b[self.i..].starts_with(b"false") => {
                    self.i += 5;
                    Value::Bool(false)
                }
                Some(b'n') if self.b[self.i..].starts_with(b"null") => {
                    self.i += 4;
                    Value::Null
                }
                Some(c) if *c == b'-' || c.is_ascii_digit() => {
                    let st = self.i;
                    while self.i < self.b.len() && matches!(self.b[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                        self.i += 1;
                    }
                    let t = std::str::from_utf8(&self.b[st..self.i]).map_err(|_| "number")?;
                    Value::Num(t.parse::<f64>().map_err(|_| format!("bad number {t}"))?)
                }
                _ => return Err(format!("unexpected byte at {}", self.i)),
            };
            self.depth -= 1;
            Ok(v)
        }
        fn string(&mut self) -> Result<String, String> {
            if self.b.get(self.i) != Some(&b'"') {
                return Err("expected a string".into());
            }
            self.i += 1;
            let mut out = String::new();
            loop {
                let c = *self.b.get(self.i).ok_or("unterminated string")?;
                self.i += 1;
                match c {
                    b'"' => return Ok(out),
                    b'\\' => {
                        let e = *self.b.get(self.i).ok_or("bad escape")?;
                        self.i += 1;
                        match e {
                            b'"' => out.push('"'),
                            b'\\' => out.push('\\'),
                            b'/' => out.push('/'),
                            b'b' => out.push('\u{8}'),
                            b'f' => out.push('\u{c}'),
                            b'n' => out.push('\n'),
                            b'r' => out.push('\r'),
                            b't' => out.push('\t'),
                            b'u' => {
                                let h = std::str::from_utf8(self.b.get(self.i..self.i + 4).ok_or("bad \\u")?).map_err(|_| "bad \\u")?;
                                let cp = u32::from_str_radix(h, 16).map_err(|_| "bad \\u")?;
                                self.i += 4;
                                out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                            }
                            _ => return Err("bad escape".into()),
                        }
                    }
                    c if c < 0x20 => return Err("control byte in a string".into()),
                    _ => {
                        // copy one UTF-8 sequence
                        let st = self.i - 1;
                        let len = match c { 0x00..=0x7f => 1, 0xc0..=0xdf => 2, 0xe0..=0xef => 3, _ => 4 };
                        let s = std::str::from_utf8(self.b.get(st..st + len).ok_or("bad UTF-8")?).map_err(|_| "bad UTF-8")?;
                        out.push_str(s);
                        self.i = st + len;
                    }
                }
            }
        }
    }
}
