//! The site: one verified release, routed exactly like the production vhost it replaces.
//!
//! The reference is the DigitalOcean Caddy vhost for enclave.host (work/site-recovery-endpoints/*.candidate.caddy):
//!   - the release ledger's headers on every response;
//!   - COOP removed for the SSO popup documents;
//!   - `Cache-Control: no-cache` on /js/boot.js;
//!   - /install.sh and /install.ps1 as text/plain from the shipped installers;
//!   - the site's `_redirects` rendered as pretty routes (scripts/network/site-pretty-routes.mjs: an exact,
//!     case-insensitive path, applied only when neither {path} nor {path}/index.html is a file);
//!   - file_server's canonical directory URIs;
//!   - the branded 404.html with a real 404.
//! Deliberate, stricter differences:
//!   - no response compression (so no Vary and no encoding-dependent cache keys);
//!   - ETag is the file's own CID, and there is no Last-Modified;
//!   - explicit Cache-Control on every response (hashed chunks immutable, other files revalidate, errors no-store);
//!   - a request path with encoded separators, dot segments, control bytes or empty interior segments is refused
//!     (400) rather than cleaned.
//!
//! Every refusal of the release itself is total. A wrong or missing pin, a malformed ledger or header policy, an
//! unsupported file type, a reserved platform path or a HAMT shard makes every request a 503 that serves no release
//! byte.
use crate::car::{Car, Cid, Error, Node};
use crate::mime;
use serde_json::Value;

pub const LEDGER_PATH: &str = ".well-known/enclave-site-release.json";
/// This app's own evidence route. A release that ships a file at that path is refused, so it can never be shadowed.
pub const EVIDENCE_PATH: &str = "/.well-known/site-host";
const RETAIN_HOURS_MIN: u64 = 48;
const INSTALL_ROUTES: [(&str, &str); 2] = [("/install.sh", "get/install.sh"), ("/install.ps1", "get/install.ps1")];
const SSO_POPUP: [&str; 4] = ["/sso/authorize", "/sso/authorize.html", "/sso-authorize", "/sso-authorize.html"];
/// Paths the platform answers in front of every app. A release file there would never be served as built.
const PLATFORM_RESERVED: [&str; 9] = [
    ".well-known/enclave-attestation", ".well-known/enclave-csr", ".well-known/enclave-cert",
    ".well-known/enclave-names", ".well-known/enclave-app-zone", ".well-known/enclave-ready",
    ".well-known/enclave-secrets", ".well-known/enclave-history-checkpoint", ".well-known/site-host",
];
const PLATFORM_RESERVED_DIRS: [&str; 2] = [".well-known/enclave-tunnel", "__enclave"];
const MAX_PATH: usize = 2048;

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// The request facts routing depends on: nothing else of the request is read.
pub struct Request<'r> {
    pub method: &'r str,
    pub path_with_query: &'r str,
    pub if_none_match: Option<&'r str>,
    pub range: Option<&'r str>,
    pub if_range: Option<&'r str>,
}

struct Rule {
    from: String,
    to: String,
    status: u16,
}

pub struct Site<'a> {
    car: Car<'a>,
    headers: Vec<(String, String)>,
    rules: Vec<Rule>,
    built_at: String,
    files: usize,
}

fn refuse<T>(why: impl Into<String>) -> Result<T, String> {
    Err(why.into())
}

fn car_err(e: Error) -> String {
    match e {
        Error::Format(m) => format!("the embedded archive is malformed: {m}"),
        Error::Integrity(m) => format!("the embedded archive fails verification: {m}"),
        Error::Unsupported(m) => format!("the embedded release uses {m}, which this app refuses"),
    }
}

/// A header name is a token and a value plain text: the same rule as the release tool's loadHeaders.
fn header_ok(k: &str, v: &str) -> bool {
    let name = !k.is_empty() && k.len() <= 64 && k.as_bytes()[0].is_ascii_alphabetic()
        && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    let value = !v.is_empty() && v.len() <= 4096 && !v.bytes().any(|b| matches!(b, b'"' | b'\\' | b'\r' | b'\n' | b'{' | b'}') || b < 0x20 || b == 0x7f);
    name && value
}

fn iso_time(v: &Value) -> Option<&str> {
    // the release tool writes Date.toISOString(): YYYY-MM-DDTHH:MM:SS.sssZ
    let s = v.as_str()?;
    let b = s.as_bytes();
    let shape = b.len() == 24 && b[4] == b'-' && b[7] == b'-' && b[10] == b'T' && b[13] == b':' && b[16] == b':' && b[19] == b'.' && b[23] == b'Z'
        && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22].iter().all(|&i| b[i].is_ascii_digit());
    if shape { Some(s) } else { None }
}

fn csp_hash_ok(h: &str) -> bool {
    // 'sha256-<43 base64 chars>='
    let b = h.as_bytes();
    b.len() == 53 && h.starts_with("'sha256-") && h.ends_with("='")
        && b[8..51].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'+' || *c == b'/')
}

/// The ledger -> the effective header list, exactly the release tool's effectiveHeaders (which headers.caddy renders).
fn ledger_headers(ledger: &Value) -> Result<(Vec<(String, String)>, String), String> {
    let o = ledger.as_object().ok_or("the release ledger is not a JSON object")?;
    if o.get("schema").and_then(Value::as_str) != Some("enclave-site-release-ledger/1") {
        return refuse("the release ledger has an unknown schema");
    }
    let built_at = iso_time(o.get("builtAt").unwrap_or(&Value::Null)).ok_or("the release ledger's builtAt is not an ISO time")?.to_string();
    if !o.get("retainHours").and_then(Value::as_u64).map_or(false, |h| h >= RETAIN_HOURS_MIN) {
        return refuse("the release ledger keeps old chunks for less than 48 hours");
    }
    let retained = o.get("retained").and_then(Value::as_array).ok_or("the release ledger has no retained list")?;
    for r in retained {
        let ok = r.get("path").and_then(Value::as_str).map_or(false, |p| p.starts_with("js/chunks/")) && iso_time(r.get("lastBuiltAt").unwrap_or(&Value::Null)).is_some();
        if !ok {
            return refuse("the release ledger has a malformed retained entry");
        }
    }
    let csp = o.get("csp").and_then(Value::as_object).ok_or("the release ledger has no csp")?;
    let base = csp.get("scriptSrcBase").and_then(Value::as_str).ok_or("the release ledger has no scriptSrcBase")?;
    let mut script_src = vec![base.to_string()];
    for h in csp.get("hashes").and_then(Value::as_array).ok_or("the release ledger has no CSP hashes")? {
        let hash = h.get("hash").and_then(Value::as_str).filter(|x| csp_hash_ok(x)).ok_or("the release ledger has a malformed CSP hash")?;
        if iso_time(h.get("lastBuiltAt").unwrap_or(&Value::Null)).is_none() {
            return refuse("the release ledger has a malformed CSP hash date");
        }
        script_src.push(hash.to_string());
    }
    let policy = o.get("headers").and_then(Value::as_object).ok_or("the release ledger has no header policy")?;
    if !o.get("installers").map_or(false, Value::is_array) {
        return refuse("the release ledger has no installers list");
    }
    let csp_value = policy.get("Content-Security-Policy").and_then(Value::as_str).ok_or("the header policy has no Content-Security-Policy")?;
    if !(csp_value.contains("script-src SCRIPT_SRC;") || csp_value.ends_with("script-src SCRIPT_SRC")) {
        return refuse("the Content-Security-Policy lacks the script-src SCRIPT_SRC slot");
    }
    let script_src = script_src.join(" ");
    let mut out = Vec::new();
    // serde_json's map is ordered by key here, so the emitted order is stable for a given ledger
    for (k, v) in policy {
        let v = v.as_str().ok_or("a header policy value is not a string")?;
        if !header_ok(k, v) {
            return refuse(format!("header {k:?} is not a plain token/value"));
        }
        let lower = k.to_ascii_lowercase();
        if matches!(lower.as_str(), "content-type" | "content-length" | "etag" | "cache-control" | "location" | "content-range" | "accept-ranges" | "set-cookie" | "transfer-encoding" | "connection") {
            return refuse(format!("the header policy may not set {k}"));
        }
        let v = if k == "Content-Security-Policy" { v.replacen("SCRIPT_SRC", &script_src, 1) } else { v.to_string() };
        out.push((k.clone(), v));
    }
    Ok((out, built_at))
}

/// The `_redirects` file under the production generator's exact rules: `/* /404.html 404` is the 404 handler,
/// everything else is an exact path with status 200, 301 or 302; anything else refuses the release.
fn parse_redirects(text: &str) -> Result<Vec<Rule>, String> {
    let ok_path = |p: &str| p.starts_with('/') && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'.' | b'_' | b'-'));
    let mut rules = Vec::new();
    for line in text.lines() {
        let value = line.split('#').next().unwrap_or("").trim();
        if value.is_empty() {
            continue;
        }
        let parts: Vec<&str> = value.split_whitespace().collect();
        if parts == ["/*", "/404.html", "404"] {
            continue;
        }
        if parts.len() != 3 || !ok_path(parts[0]) || !ok_path(parts[1]) || !matches!(parts[2], "200" | "301" | "302") {
            return refuse(format!("unsupported site redirect: {value}"));
        }
        rules.push(Rule { from: parts[0].to_string(), to: parts[1].to_string(), status: parts[2].parse().unwrap() });
    }
    Ok(rules)
}

impl<'a> Site<'a> {
    /// Open and judge the embedded release against the deployment's pin. Any failure refuses the whole site.
    pub fn open(car_bytes: &'a [u8], pin: Option<&str>) -> Result<Site<'a>, String> {
        let car = Car::open(car_bytes).map_err(car_err)?;
        let pin = pin.map(str::trim).filter(|p| !p.is_empty()).ok_or("no release is pinned: the deployment config must name {\"release\": \"<CID>\"}")?;
        let want = Cid::parse(pin).ok_or_else(|| format!("the pinned release {pin:?} is not a base32 CIDv1"))?;
        if want != car.root {
            return refuse(format!("the pinned release {} is not the embedded release {}", want.to_base32(), car.root.to_base32()));
        }
        let mut site = Site { car, headers: Vec::new(), rules: Vec::new(), built_at: String::new(), files: 0 };
        site.files = site.audit_tree()?;
        let ledger_bytes = site.file_bytes(LEDGER_PATH)?.ok_or("the release has no ledger (/.well-known/enclave-site-release.json)")?;
        let ledger: Value = serde_json::from_slice(&ledger_bytes).map_err(|e| format!("the release ledger is not JSON: {e}"))?;
        let (headers, built_at) = ledger_headers(&ledger)?;
        let installers: Vec<&str> = ledger["installers"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        for (_, p) in INSTALL_ROUTES {
            if !installers.contains(&p) || site.file_bytes(p)?.is_none() {
                return refuse(format!("the release does not ship the installer {p}"));
            }
        }
        if site.file_bytes("404.html")?.is_none() {
            return refuse("the release has no 404.html");
        }
        let redirects = site.file_bytes("_redirects")?.ok_or("the release has no _redirects")?;
        site.rules = parse_redirects(std::str::from_utf8(&redirects).map_err(|_| "_redirects is not UTF-8")?)?;
        site.headers = headers;
        site.built_at = built_at;
        Ok(site)
    }

    /// Walk every directory once: every name must have a known type and none may sit on a platform path.
    fn audit_tree(&self) -> Result<usize, String> {
        let mut files = 0usize;
        let mut stack = vec![(String::new(), self.car.root)];
        while let Some((dir, cid)) = stack.pop() {
            let links = match self.car.node(&cid).map_err(car_err)? {
                Node::Dir(l) => l,
                Node::File(_) => return refuse("the release root is not a directory"),
            };
            for l in links {
                let rel = if dir.is_empty() { l.name.clone() } else { format!("{dir}/{}", l.name) };
                if PLATFORM_RESERVED.contains(&rel.as_str()) || PLATFORM_RESERVED_DIRS.iter().any(|d| rel == *d || rel.starts_with(&format!("{d}/"))) {
                    return refuse(format!("the release ships {rel}, a path the platform or this app answers"));
                }
                if l.name.bytes().any(|b| b < 0x20 || b == 0x7f || b == b'\\' || b == b'%') {
                    return refuse(format!("the release has an unservable name {rel:?}"));
                }
                match self.car.node(&l.cid).map_err(car_err)? {
                    Node::Dir(_) => stack.push((rel, l.cid)),
                    Node::File(_) => {
                        if mime::of(&l.name).is_none() {
                            return refuse(format!("the release ships {rel}, whose type this app does not serve"));
                        }
                        files += 1;
                    }
                }
            }
        }
        Ok(files)
    }

    fn entry(&self, rel: &str) -> Result<Option<Node>, String> {
        let segs: Vec<&str> = if rel.is_empty() { Vec::new() } else { rel.split('/').collect() };
        self.car.lookup(&segs).map_err(car_err)
    }

    fn file_bytes(&self, rel: &str) -> Result<Option<Vec<u8>>, String> {
        match self.entry(rel)? {
            Some(Node::File(cid)) => {
                let mut out = Vec::new();
                self.car.read_file(&cid, &mut out).map_err(car_err)?;
                Ok(Some(out))
            }
            _ => Ok(None),
        }
    }

    fn is_file(&self, rel: &str) -> Result<bool, String> {
        Ok(matches!(self.entry(rel)?, Some(Node::File(_))))
    }

    pub fn root(&self) -> String {
        self.car.root.to_base32()
    }

    pub fn evidence(&self) -> String {
        serde_json::json!({
            "app": "site-host", "version": env!("CARGO_PKG_VERSION"), "release": self.root(),
            "ledgerBuiltAt": self.built_at, "files": self.files, "blocks": self.car.block_count(),
            "verification": "every served block is re-hashed against the pinned root on each request; nothing is fetched",
        }).to_string()
    }

    fn base_headers(&self, orig_path: &str) -> Vec<(String, String)> {
        let sso = SSO_POPUP.iter().any(|p| p.eq_ignore_ascii_case(orig_path));
        self.headers.iter().filter(|(k, _)| !(sso && k.eq_ignore_ascii_case("Cross-Origin-Opener-Policy"))).cloned().collect()
    }

    /// Route one request. Never panics on input; an archive fault while serving is a 502 with no content.
    pub fn handle(&self, req: &Request) -> Response {
        match self.route(req) {
            Ok(r) => r,
            Err(why) => plain(502, &format!("site-host: {why}\n"), self.base_headers("")),
        }
    }

    fn route(&self, req: &Request) -> Result<Response, String> {
        let (raw_path, query) = match req.path_with_query.split_once('?') {
            Some((p, q)) => (p, Some(q)),
            None => (req.path_with_query, None),
        };
        let head = req.method == "HEAD";
        if req.method != "GET" && !head {
            let mut r = plain(405, "method not allowed\n", self.base_headers(""));
            r.headers.push(("Allow".into(), "GET, HEAD".into()));
            return Ok(r);
        }
        let path = match clean_path(raw_path) {
            Some(p) => p,
            None => return Ok(finish(plain(400, "bad request path\n", self.base_headers("")), head)),
        };
        let mut headers = self.base_headers(&path);
        if path == EVIDENCE_PATH {
            headers.push(("Content-Type".into(), "application/json".into()));
            headers.push(("Cache-Control".into(), "no-store".into()));
            return Ok(finish(Response { status: 200, headers, body: self.evidence().into_bytes() }, head));
        }
        for (route, file) in INSTALL_ROUTES {
            if path.eq_ignore_ascii_case(route) {
                return self.serve_file(file, Some("text/plain; charset=utf-8"), &path, headers, req, head);
            }
        }
        let rel = &path[1..];
        // pretty routes: only when neither {path} nor {path}/index.html is a file (Caddy `not file {path} {path}/index.html`)
        if let Some(rule) = self.rules.iter().find(|r| r.from.eq_ignore_ascii_case(&path)) {
            let shadowed = !rel.is_empty() && !rel.ends_with('/') && (self.is_file(rel)? || self.is_file(&format!("{rel}/index.html"))?);
            if !shadowed {
                if rule.status == 200 {
                    return self.serve_path(&rule.to, &path, query, headers, req, head);
                }
                let loc = with_query(&rule.to, query);
                return Ok(finish(redirect(rule.status, &loc, headers), head));
            }
        }
        self.serve_path(&path, &path, query, headers, req, head)
    }

    /// file_server on a (possibly rewritten) path: files, canonical directory URIs with index.html, else the 404 page.
    fn serve_path(&self, path: &str, orig: &str, query: Option<&str>, headers: Vec<(String, String)>, req: &Request, head: bool) -> Result<Response, String> {
        let slash = path.ends_with('/');
        let rel = path[1..].trim_end_matches('/');
        match self.entry(rel)? {
            Some(Node::File(_)) if !slash => self.serve_file(rel, None, orig, headers, req, head),
            Some(Node::File(_)) => Ok(finish(redirect(308, &with_query(path.trim_end_matches('/'), query), headers), head)),
            Some(Node::Dir(_)) => {
                let index = if rel.is_empty() { "index.html".to_string() } else { format!("{rel}/index.html") };
                if !self.is_file(&index)? {
                    return self.not_found(headers, head);
                }
                if slash {
                    self.serve_file(&index, None, orig, headers, req, head)
                } else {
                    Ok(finish(redirect(308, &with_query(&format!("{path}/"), query), headers), head))
                }
            }
            None => self.not_found(headers, head),
        }
    }

    fn not_found(&self, mut headers: Vec<(String, String)>, head: bool) -> Result<Response, String> {
        let body = self.file_bytes("404.html")?.ok_or("the 404 page vanished")?;
        headers.push(("Content-Type".into(), "text/html; charset=utf-8".into()));
        headers.push(("Cache-Control".into(), "no-store".into()));
        Ok(finish(Response { status: 404, headers, body }, head))
    }

    fn serve_file(&self, rel: &str, ctype: Option<&str>, orig: &str, mut headers: Vec<(String, String)>, req: &Request, head: bool) -> Result<Response, String> {
        let cid = match self.entry(rel)? {
            Some(Node::File(c)) => c,
            _ => return self.not_found(headers, head),
        };
        let name = rel.rsplit('/').next().unwrap_or(rel);
        let ctype = ctype.or_else(|| mime::of(name)).ok_or_else(|| format!("{rel} has no servable type"))?;
        let etag = format!("\"{}\"", cid.to_base32());
        let cache = if orig.eq_ignore_ascii_case("/js/boot.js") {
            "no-cache"
        } else if rel.starts_with("js/chunks/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        headers.push(("ETag".into(), etag.clone()));
        headers.push(("Cache-Control".into(), cache.into()));
        if let Some(inm) = req.if_none_match {
            if inm.trim() == "*" || inm.split(',').any(|t| t.trim().trim_start_matches("W/") == etag) {
                return Ok(Response { status: 304, headers, body: Vec::new() });
            }
        }
        let mut body = Vec::new();
        self.car.read_file(&cid, &mut body).map_err(car_err)?;
        headers.push(("Content-Type".into(), ctype.into()));
        headers.push(("Accept-Ranges".into(), "bytes".into()));
        let range = req.range.filter(|_| req.if_range.map_or(true, |ir| ir.trim() == etag));
        if let Some(r) = range {
            match parse_range(r, body.len() as u64) {
                RangeAsk::Ignore => {}
                RangeAsk::Unsatisfiable => {
                    headers.retain(|(k, _)| k != "Content-Type" && k != "Cache-Control");
                    headers.push(("Content-Type".into(), "text/plain; charset=utf-8".into()));
                    headers.push(("Cache-Control".into(), "no-store".into()));
                    headers.push(("Content-Range".into(), format!("bytes */{}", body.len())));
                    return Ok(finish(Response { status: 416, headers, body: b"range not satisfiable\n".to_vec() }, head));
                }
                RangeAsk::Part(s, e) => {
                    headers.push(("Content-Range".into(), format!("bytes {s}-{e}/{}", body.len())));
                    let part = body[s as usize..=e as usize].to_vec();
                    return Ok(finish(Response { status: 206, headers, body: part }, head));
                }
            }
        }
        Ok(finish(Response { status: 200, headers, body }, head))
    }
}

/// The served-path form of a raw request path, or None to refuse it. Percent-decoding is strict: encoded separators,
/// control bytes, invalid UTF-8, dot segments and empty interior segments are refused, never normalized.
pub fn clean_path(raw: &str) -> Option<String> {
    if !raw.starts_with('/') || raw.len() > MAX_PATH {
        return None;
    }
    let b = raw.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c == b'%' {
            let hex = |x: u8| (x as char).to_digit(16);
            let (h, l) = (hex(*b.get(i + 1)?)?, hex(*b.get(i + 2)?)?);
            let v = (h * 16 + l) as u8;
            if v == b'/' || v == b'\\' || v == b'%' {
                return None;
            }
            out.push(v);
            i += 3;
        } else {
            out.push(c);
            i += 1;
        }
    }
    let s = String::from_utf8(out).ok()?;
    if s.chars().any(|c| c.is_control() || c == '\\') {
        return None;
    }
    let inner = s.strip_suffix('/').unwrap_or(&s);
    if inner.len() > 0 && inner[1..].split('/').any(|seg| seg.is_empty() || seg == "." || seg == "..") {
        return None;
    }
    if s.len() > 1 && inner.is_empty() {
        return None;
    }
    Some(s)
}

enum RangeAsk {
    Ignore,
    Unsatisfiable,
    Part(u64, u64),
}

/// One `bytes=` range (first-last, first-, or -suffix). Multiple ranges or another unit: ignored (a full 200).
fn parse_range(h: &str, len: u64) -> RangeAsk {
    let spec = match h.trim().strip_prefix("bytes=") {
        Some(s) if !s.contains(',') => s.trim(),
        _ => return RangeAsk::Ignore,
    };
    let (a, b) = match spec.split_once('-') {
        Some(x) => x,
        None => return RangeAsk::Ignore,
    };
    let num = |s: &str| if !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) && s.len() <= 19 { s.parse::<u64>().ok() } else { None };
    let (s, e) = match (a.trim(), b.trim()) {
        ("", n) => match num(n) {
            Some(0) => return RangeAsk::Unsatisfiable,
            Some(n) if len > 0 => (len.saturating_sub(n), len - 1),
            Some(_) => return RangeAsk::Unsatisfiable,
            None => return RangeAsk::Ignore,
        },
        (f, "") => match num(f) {
            Some(f) => (f, len.saturating_sub(1)),
            None => return RangeAsk::Ignore,
        },
        (f, l) => match (num(f), num(l)) {
            (Some(f), Some(l)) if f <= l => (f, l.min(len.saturating_sub(1))),
            _ => return RangeAsk::Ignore,
        },
    };
    if len == 0 || s >= len {
        return RangeAsk::Unsatisfiable;
    }
    RangeAsk::Part(s, e)
}

fn with_query(path: &str, query: Option<&str>) -> String {
    match query {
        Some(q) if !q.is_empty() => format!("{path}?{q}"),
        _ => path.to_string(),
    }
}

fn redirect(status: u16, location: &str, mut headers: Vec<(String, String)>) -> Response {
    headers.push(("Location".into(), location.into()));
    headers.push(("Cache-Control".into(), "no-cache".into()));
    headers.push(("Content-Type".into(), "text/plain; charset=utf-8".into()));
    Response { status, headers, body: Vec::new() }
}

pub fn plain(status: u16, text: &str, mut headers: Vec<(String, String)>) -> Response {
    headers.push(("Content-Type".into(), "text/plain; charset=utf-8".into()));
    headers.push(("Cache-Control".into(), "no-store".into()));
    Response { status, headers, body: text.as_bytes().to_vec() }
}

/// HEAD: the same status and headers, no body. Content-Length is sent on GET only: wasi:http checks a declared length
/// against the bytes written, so a HEAD that declared one would fail.
fn finish(mut r: Response, head: bool) -> Response {
    if head {
        r.body.clear();
    } else {
        r.headers.push(("Content-Length".into(), r.body.len().to_string()));
    }
    r
}

/// The whole-site refusal: no release byte, no release header, nothing cacheable.
pub fn refused(why: &str, path: &str) -> Response {
    let headers = vec![
        ("Content-Security-Policy".to_string(), "default-src 'none'".to_string()),
        ("X-Content-Type-Options".to_string(), "nosniff".to_string()),
    ];
    let mut r = if path == EVIDENCE_PATH {
        let mut r = plain(503, &serde_json::json!({ "app": "site-host", "refused": why }).to_string(), headers);
        r.headers.retain(|(k, _)| k != "Content-Type");
        r.headers.push(("Content-Type".into(), "application/json".into()));
        r
    } else {
        plain(503, &format!("site-host refuses to serve: {why}\n"), headers)
    };
    r.headers.push(("Content-Length".into(), r.body.len().to_string()));
    r
}
