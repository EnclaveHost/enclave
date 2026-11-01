//! Fixed local RPC boundary for the measured CPU companion. No provider fallback.
use serde_json::{json, Value};
use std::{
    io::{self, Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
type R<T> = Result<T, &'static str>;
const HEADER: usize = 16 * 1024;
const REQUEST: usize = 1024 * 1024;
const RESPONSE: usize = 8 * 1024 * 1024;
const WIRE: usize = 2 * RESPONSE + HEADER;
const WINDOW: Duration = Duration::from_secs(10);
fn remaining(d: Instant) -> R<Duration> {
    d.checked_duration_since(Instant::now())
        .filter(|v| !v.is_zero())
        .ok_or("deadline")
}
fn retry(e: &io::Error, d: Instant) -> R<()> {
    if !matches!(
        e.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    ) {
        return Err("socket");
    }
    let left = remaining(d)?;
    thread::sleep(left.min(Duration::from_millis(1)));
    Ok(())
}
struct Conn {
    s: TcpStream,
    b: Vec<u8>,
    pos: usize,
    read: usize,
    d: Instant,
}
impl Conn {
    fn new(s: TcpStream, d: Instant) -> R<Self> {
        s.set_nonblocking(true).map_err(|_| "nonblocking")?;
        Ok(Self {
            s,
            b: Vec::new(),
            pos: 0,
            read: 0,
            d,
        })
    }
    fn more(&mut self) -> R<bool> {
        loop {
            remaining(self.d)?;
            let mut tmp = [0u8; 4096];
            match self.s.read(&mut tmp) {
                Ok(0) => return Ok(false),
                Ok(n) => {
                    self.read = self.read.checked_add(n).ok_or("wire limit")?;
                    if self.read > WIRE {
                        return Err("wire limit");
                    }
                    if self.pos > 0 {
                        self.b.drain(..self.pos);
                        self.pos = 0;
                    }
                    self.b.extend_from_slice(&tmp[..n]);
                    return Ok(true);
                }
                Err(e) => retry(&e, self.d)?,
            }
        }
    }
    fn until(&mut self, sep: &[u8], cap: usize) -> R<Vec<u8>> {
        loop {
            if let Some(i) = self.b[self.pos..].windows(sep.len()).position(|v| v == sep) {
                let n = i + sep.len();
                if n > cap {
                    return Err("header limit");
                }
                let v = self.b[self.pos..self.pos + n].to_vec();
                self.pos += n;
                return Ok(v);
            }
            if self.b.len() - self.pos >= cap {
                return Err("header limit");
            }
            if !self.more()? {
                return Err("truncated");
            }
        }
    }
    fn exact(&mut self, n: usize) -> R<Vec<u8>> {
        if n > RESPONSE {
            return Err("body limit");
        }
        while self.b.len() - self.pos < n {
            if !self.more()? {
                return Err("truncated");
            }
        }
        let v = self.b[self.pos..self.pos + n].to_vec();
        self.pos += n;
        Ok(v)
    }
    fn write(&mut self, b: &[u8]) -> R<()> {
        let mut p = 0;
        while p < b.len() {
            remaining(self.d)?;
            match self.s.write(&b[p..]) {
                Ok(0) => return Err("closed"),
                Ok(n) => p += n,
                Err(e) => retry(&e, self.d)?,
            }
        }
        Ok(())
    }
}
fn one<'a>(h: &'a [httparse::Header<'a>], name: &str) -> R<Option<&'a str>> {
    let mut found = None;
    for v in h {
        if v.name.eq_ignore_ascii_case(name) {
            if found.is_some() {
                return Err("duplicate header");
            }
            let s = std::str::from_utf8(v.value).map_err(|_| "header encoding")?;
            if s.bytes().any(|b| b < 32 || b == 127) {
                return Err("header control");
            }
            found = Some(s);
        }
    }
    Ok(found)
}
fn decimal(s: &str, cap: usize) -> R<usize> {
    if s.is_empty() || (s.len() > 1 && s.starts_with('0')) || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("length");
    }
    s.parse::<usize>()
        .ok()
        .filter(|n| *n <= cap)
        .ok_or("length")
}
struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}
fn request(c: &mut Conn) -> R<Request> {
    let raw = c.until(b"\r\n\r\n", HEADER)?;
    let mut slots = [httparse::EMPTY_HEADER; 64];
    let mut q = httparse::Request::new(&mut slots);
    if !q.parse(&raw).map_err(|_| "request")?.is_complete() || q.version != Some(1) {
        return Err("request");
    }
    if one(q.headers, "host")?.filter(|s| !s.is_empty()).is_none() {
        return Err("host");
    }
    if one(q.headers, "transfer-encoding")?.is_some()
        || one(q.headers, "expect")?.is_some()
        || one(q.headers, "content-encoding")?.is_some()
    {
        return Err("framing");
    }
    let method = q.method.ok_or("method")?.to_owned();
    let path = q.path.ok_or("path")?.to_owned();
    let n = one(q.headers, "content-length")?
        .map(|v| decimal(v, REQUEST))
        .transpose()?
        .unwrap_or(0);
    if method == "POST" {
        if n == 0 || one(q.headers, "content-type")? != Some("application/json") {
            return Err("content type");
        }
    } else if n != 0 {
        return Err("unexpected body");
    }
    let body = c.exact(n)?;
    if c.b.len() != c.pos {
        return Err("pipelining");
    }
    Ok(Request { method, path, body })
}
fn response(c: &mut Conn) -> R<Vec<u8>> {
    let raw = c.until(b"\r\n\r\n", HEADER)?;
    let mut slots = [httparse::EMPTY_HEADER; 64];
    let mut q = httparse::Response::new(&mut slots);
    if !q.parse(&raw).map_err(|_| "response")?.is_complete() || q.code != Some(200) {
        return Err("upstream status");
    }
    if one(q.headers, "content-encoding")?.is_some() {
        return Err("encoded upstream");
    }
    let cl = one(q.headers, "content-length")?;
    let te = one(q.headers, "transfer-encoding")?;
    if cl.is_some() && te.is_some() {
        return Err("ambiguous framing");
    }
    if let Some(v) = cl {
        return c.exact(decimal(v, RESPONSE)?);
    }
    if let Some(v) = te {
        if !v.eq_ignore_ascii_case("chunked") {
            return Err("transfer encoding");
        }
        let mut body = Vec::new();
        loop {
            let line = c.until(b"\r\n", 32)?;
            let s = std::str::from_utf8(&line[..line.len() - 2]).map_err(|_| "chunk")?;
            if s.is_empty() || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("chunk");
            }
            let n = usize::from_str_radix(s, 16).map_err(|_| "chunk")?;
            if n == 0 {
                if c.exact(2)? != b"\r\n" {
                    return Err("trailers");
                }
                return Ok(body);
            }
            if n > RESPONSE - body.len() {
                return Err("body limit");
            }
            body.extend(c.exact(n)?);
            if c.exact(2)? != b"\r\n" {
                return Err("chunk delimiter");
            }
        }
    }
    let mut body = c.b[c.pos..].to_vec();
    c.pos = c.b.len();
    while c.more()? {
        if c.b.len() - c.pos > RESPONSE - body.len() {
            return Err("body limit");
        }
        body.extend_from_slice(&c.b[c.pos..]);
        c.pos = c.b.len();
    }
    if body.len() > RESPONSE {
        return Err("body limit");
    }
    Ok(body)
}
fn local(port: u16, path: &str, body: Option<&[u8]>, d: Instant) -> R<Value> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let s = TcpStream::connect_timeout(&addr, remaining(d)?).map_err(|_| "local connect")?;
    let mut c = Conn::new(s, d)?;
    let data = body.unwrap_or(&[]);
    let head=format!("{} {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",if body.is_some(){"POST"}else{"GET"},path,port,data.len());
    c.write(head.as_bytes())?;
    c.write(data)?;
    let b = response(&mut c)?;
    remaining(d)?;
    serde_json::from_slice(&b).map_err(|_| "upstream JSON")
}
trait Local {
    fn rpc(&mut self, port: u16, method: &str, params: Value) -> R<Value>;
    fn beacon(&mut self, path: &str) -> R<Value>;
}
struct Live {
    d: Instant,
}
fn reply(v: &Value, id: &Value) -> R<()> {
    let o = v.as_object().ok_or("RPC response")?;
    if o.get("jsonrpc") != Some(&json!("2.0"))
        || o.get("id") != Some(id)
        || o.contains_key("result") == o.contains_key("error")
    {
        return Err("RPC response");
    }
    if let Some(e) = o.get("error") {
        if e.get("code").and_then(Value::as_i64).is_none()
            || e.get("message").and_then(Value::as_str).is_none()
        {
            return Err("RPC error");
        }
    }
    Ok(())
}
impl Local for Live {
    fn rpc(&mut self, port: u16, method: &str, params: Value) -> R<Value> {
        let b =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
                .map_err(|_| "JSON")?;
        let v = local(port, "/", Some(&b), self.d)?;
        reply(&v, &json!(1))?;
        v.get("result").cloned().ok_or("RPC failed")
    }
    fn beacon(&mut self, path: &str) -> R<Value> {
        let v = local(15052, path, None, self.d)?;
        v.get("data").cloned().ok_or("beacon")
    }
}
fn quantity(v: &Value) -> R<u64> {
    let s = v
        .as_str()
        .ok_or("quantity")?
        .strip_prefix("0x")
        .ok_or("quantity")?;
    if s.is_empty()
        || s.len() > 16
        || (s.len() > 1 && s.starts_with('0'))
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("quantity");
    }
    u64::from_str_radix(s, 16).map_err(|_| "quantity")
}
fn hash(v: &Value) -> R<&str> {
    let s = v.as_str().ok_or("hash")?;
    if s.len() != 66 || !s.starts_with("0x") || !s[2..].bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("hash");
    }
    Ok(s)
}
#[derive(Clone)]
struct Block {
    n: u64,
    h: String,
    t: u64,
}
fn block(v: &Value) -> R<Block> {
    Ok(Block {
        n: quantity(&v["number"])?,
        h: hash(&v["hash"])?.to_ascii_lowercase(),
        t: quantity(&v["timestamp"])?,
    })
}
fn fresh(t: u64, now: u64, max: u64) -> bool {
    t <= now.saturating_add(15) && now.saturating_sub(t) < max
}
fn chain(l: &mut impl Local, port: u16, id: u64, now: u64) -> R<(Block, Block)> {
    if quantity(&l.rpc(port, "eth_chainId", json!([]))?)? != id
        || l.rpc(port, "eth_syncing", json!([]))? != json!(false)
    {
        return Err("chain syncing or identity");
    }
    let latest = block(&l.rpc(port, "eth_getBlockByNumber", json!(["latest", false]))?)?;
    let safe = block(&l.rpc(port, "eth_getBlockByNumber", json!(["safe", false]))?)?;
    let finalized = block(&l.rpc(port, "eth_getBlockByNumber", json!(["finalized", false]))?)?;
    if finalized.n == 0
        || finalized.n > safe.n
        || safe.n > latest.n
        || finalized.t > safe.t
        || safe.t > latest.t
        || !fresh(latest.t, now, 120)
        || !fresh(finalized.t, now, 3600)
    {
        return Err("chain heads");
    }
    if (safe.n == latest.n && safe.h != latest.h)
        || (finalized.n == safe.n && finalized.h != safe.h)
    {
        return Err("same-height mismatch");
    }
    Ok((safe, finalized))
}
fn readiness(l: &mut impl Local, now: u64) -> R<()> {
    let (_, f) = chain(l, 18645, 1, now)?;
    let genesis = l.rpc(18645, "eth_getBlockByNumber", json!(["0x0", false]))?;
    if hash(&genesis["hash"])?
        != "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3"
    {
        return Err("L1 genesis");
    }
    let s = l.beacon("/eth/v1/node/syncing")?;
    for key in ["is_syncing", "is_optimistic", "el_offline"] {
        if s.get(key) != Some(&json!(false)) {
            return Err("consensus syncing");
        }
    }
    let g = l.beacon("/eth/v1/beacon/genesis")?;
    if g["genesis_validators_root"]
        != "0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95"
    {
        return Err("beacon genesis");
    }
    let b = l.beacon("/eth/v2/beacon/blocks/finalized")?;
    let p = &b["message"]["body"]["execution_payload"];
    let ns = p["block_number"].as_str().ok_or("beacon number")?;
    if ns.is_empty() || !ns.bytes().all(|b| b.is_ascii_digit()) {
        return Err("beacon number");
    }
    let n = ns.parse::<u64>().map_err(|_| "beacon number")?;
    let h = hash(&p["block_hash"])?;
    if n == 0 || n != f.n || !f.h.eq_ignore_ascii_case(h) {
        return Err("beacon finality");
    }
    let canonical = block(&l.rpc(
        18645,
        "eth_getBlockByNumber",
        json!([format!("0x{n:x}"), false]),
    )?)?;
    if canonical.n != n || !canonical.h.eq_ignore_ascii_case(h) {
        return Err("beacon canonical mismatch");
    }
    let (safe, finalized) = chain(l, 18545, 8453, now)?;
    let status = l.rpc(19545, "optimism_syncStatus", json!([]))?;
    for (key, expected) in [("safe_l2", safe), ("finalized_l2", finalized)] {
        let b = &status[key];
        if b["number"].as_u64() != Some(expected.n)
            || !hash(&b["hash"])?.eq_ignore_ascii_case(&expected.h)
        {
            return Err("Base node mismatch");
        }
    }
    Ok(())
}
fn allowed(m: &str) -> bool {
    matches!(
        m,
        "web3_clientVersion"
            | "web3_sha3"
            | "net_version"
            | "net_listening"
            | "net_peerCount"
            | "eth_chainId"
            | "eth_syncing"
            | "eth_blockNumber"
            | "eth_gasPrice"
            | "eth_maxPriorityFeePerGas"
            | "eth_feeHistory"
            | "eth_getBalance"
            | "eth_getStorageAt"
            | "eth_getTransactionCount"
            | "eth_getCode"
            | "eth_call"
            | "eth_estimateGas"
            | "eth_getBlockByHash"
            | "eth_getBlockByNumber"
            | "eth_getBlockTransactionCountByHash"
            | "eth_getBlockTransactionCountByNumber"
            | "eth_getTransactionByHash"
            | "eth_getTransactionByBlockHashAndIndex"
            | "eth_getTransactionByBlockNumberAndIndex"
            | "eth_getTransactionReceipt"
            | "eth_getBlockReceipts"
            | "eth_getLogs"
            | "eth_getProof"
            | "eth_sendRawTransaction"
    )
}
fn item(v: &Value) -> R<Value> {
    let o = v.as_object().ok_or("RPC object")?;
    if o.keys()
        .any(|k| !["jsonrpc", "id", "method", "params"].contains(&k.as_str()))
        || o.get("jsonrpc") != Some(&json!("2.0"))
    {
        return Err("RPC shape");
    }
    let id = o.get("id").ok_or("notification refused")?;
    if !(id.as_str().is_some_and(|s| s.len() <= 128)
        || id
            .as_i64()
            .is_some_and(|n| n.unsigned_abs() <= 9_007_199_254_740_991))
    {
        return Err("RPC id");
    }
    if !o.get("method").and_then(Value::as_str).is_some_and(allowed) {
        return Err("method refused");
    }
    if !o
        .get("params")
        .is_some_and(|p| p.is_array() || p.is_object())
    {
        return Err("params");
    }
    Ok(id.clone())
}
fn ids(v: &Value) -> R<Vec<Value>> {
    let values = if let Some(a) = v.as_array() {
        if a.is_empty() || a.len() > 16 {
            return Err("batch limit");
        }
        a.iter().collect::<Vec<_>>()
    } else {
        vec![v]
    };
    let mut ids = Vec::new();
    for v in values {
        let id = item(v)?;
        if ids.contains(&id) {
            return Err("duplicate id");
        }
        ids.push(id);
    }
    Ok(ids)
}
fn user_reply(v: &Value, batch: bool, ids: &[Value]) -> R<()> {
    let values = if batch {
        v.as_array()
            .ok_or("batch response")?
            .iter()
            .collect::<Vec<_>>()
    } else {
        vec![v]
    };
    if values.len() != ids.len() {
        return Err("response count");
    }
    let mut seen = Vec::new();
    for v in values {
        let id = v.get("id").ok_or("response id")?;
        if !ids.contains(id) || seen.contains(id) {
            return Err("response id");
        }
        reply(v, id)?;
        seen.push(id.clone());
    }
    Ok(())
}
fn send(c: &mut Conn, code: u16, body: Value, head: bool) -> R<()> {
    let b = serde_json::to_vec(&body).map_err(|_| "JSON")?;
    if b.len() > RESPONSE {
        return Err("response limit");
    }
    let h=format!("HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",code,if code==200{"OK"}else{"Unavailable"},b.len());
    c.write(h.as_bytes())?;
    if !head {
        c.write(&b)?;
    }
    Ok(())
}
fn handle(s: TcpStream) {
    let d = Instant::now() + WINDOW;
    let mut c = match Conn::new(s, d) {
        Ok(c) => c,
        Err(_) => return,
    };
    let q = match request(&mut c) {
        Ok(v) => v,
        Err(_) => {
            let _ = send(&mut c, 400, json!({"error":"invalid HTTP request"}), false);
            return;
        }
    };
    let head = q.method == "HEAD";
    if (q.method == "GET" || head) && q.path == "/" {
        let _ = send(
            &mut c,
            200,
            json!({"service":"Enclave RPC","chains":[1,8453],"routes":["/ethereum","/base"],"health":"/health","description":"Requests require current local execution and consensus readiness."}),
            head,
        );
        return;
    }
    let port = match (q.method.as_str(), q.path.as_str()) {
        ("POST", "/ethereum") => 18645,
        ("POST", "/base") => 18545,
        ("GET" | "HEAD", "/health") => 0,
        _ => {
            let _ = send(&mut c, 404, json!({"error":"route not found"}), head);
            return;
        }
    };
    let parsed = if port != 0 {
        match serde_json::from_slice::<Value>(&q.body)
            .map_err(|_| "JSON")
            .and_then(|v| {
                let i = ids(&v)?;
                Ok((v, i))
            }) {
            Ok(v) => Some(v),
            Err(_) => {
                let _ = send(
                    &mut c,
                    400,
                    json!({"error":"invalid or unsupported JSON-RPC request"}),
                    false,
                );
                return;
            }
        }
    } else {
        None
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if readiness(&mut Live { d }, now).is_err() || remaining(d).is_err() {
        let _ = send(&mut c, 503, json!({"localReady":false}), head);
        return;
    }
    if let Some((v, i)) = parsed {
        // Exactly one user submission. All readiness calls are read-only, separate methods.
        let b = match serde_json::to_vec(&v) {
            Ok(b) => b,
            Err(_) => return,
        };
        match local(port, "/", Some(&b), d).and_then(|r| {
            user_reply(&r, v.is_array(), &i)?;
            Ok(r)
        }) {
            Ok(r) => {
                let _ = send(&mut c, 200, r, false);
            }
            Err(_) => {
                let _ = send(
                    &mut c,
                    502,
                    json!({"error":"local RPC outcome unavailable; not retried"}),
                    false,
                );
            }
        }
    } else {
        let _ = send(
            &mut c,
            200,
            json!({"localReady":true,"chains":[1,8453]}),
            head,
        );
    }
}
fn main() {
    // Sequential processing bounds memory and upstream fanout. Outer app cgroups
    // and owner lifetime remain mandatory; this listener is not lifecycle authority.
    let listener = TcpListener::bind("127.0.0.1:8000").expect("fixed loopback listener");
    for stream in listener.incoming() {
        match stream {
            Ok(s) => handle(s),
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn stream(bytes: Vec<u8>) -> Conn {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let t = thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            s.set_write_timeout(Some(Duration::from_secs(1))).unwrap();
            let _ = s.write_all(&bytes);
        });
        let s = TcpStream::connect(addr).unwrap();
        t.join().unwrap();
        Conn::new(s, Instant::now() + Duration::from_secs(1)).unwrap()
    }
    fn req(raw: &str) -> R<Request> {
        request(&mut stream(raw.as_bytes().to_vec()))
    }
    #[test]
    fn request_framing() {
        assert!(req("POST /base HTTP/1.1\r\nHost: local\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}").is_ok());
        for s in [
            "GET / HTTP/1.1\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: a\r\n folded\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: a\r\nContent-Length: 00\r\n\r\n",
            "POST /base HTTP/1.1\r\nHost: a\r\nContent-Type: application/json\r\nContent-Length: 1048577\r\n\r\n",
            "GET / HTTP/1.1\r\nHost: a\r\n\r\nGET / HTTP/1.1\r\n\r\n",
        ] {assert!(req(s).is_err(),"{s}");}
    }
    #[test]
    fn upstream_framing() {
        for raw in [
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n1\r\n}\r\n0\r\n\r\n",
            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{}",
        ] {
            assert_eq!(
                response(&mut stream(raw.as_bytes().to_vec())).unwrap(),
                b"{}"
            );
        }
        for raw in [
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nContent-Length: 8388609\r\n\r\n",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n800001\r\n",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nFoo: bad\r\n\r\n",
        ] {
            assert!(response(&mut stream(raw.as_bytes().to_vec())).is_err());
        }
    }
    #[test]
    fn original_deadline_bounds_stalled_socket() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let s = TcpStream::connect(l.local_addr().unwrap()).unwrap();
        let (_held, _) = l.accept().unwrap();
        let start = Instant::now();
        let mut c = Conn::new(s, start + Duration::from_millis(25)).unwrap();
        assert_eq!(c.until(b"\r\n", HEADER).unwrap_err(), "deadline");
        assert!(start.elapsed() < Duration::from_secs(1));
    }
    #[test]
    fn public_methods_only() {
        for m in [
            "admin_peers",
            "engine_newPayloadV3",
            "personal_unlockAccount",
            "debug_traceTransaction",
            "trace_block",
            "eth_sendTransaction",
            "eth_sign",
            "eth_subscribe",
        ] {
            assert!(!allowed(m));
        }
        for m in [
            "eth_call",
            "eth_getProof",
            "eth_getLogs",
            "eth_sendRawTransaction",
        ] {
            assert!(allowed(m));
        }
    }
    fn query(id: Value) -> Value {
        json!({"jsonrpc":"2.0","id":id,"method":"eth_blockNumber","params":[]})
    }
    #[test]
    fn rpc_shape_and_batch_limits() {
        assert!(ids(&query(json!(1))).is_ok());
        assert!(ids(&json!([])).is_err());
        assert!(ids(&Value::Array(vec![query(json!(1)); 17])).is_err());
        assert!(ids(&json!([query(json!(1)), query(json!(1))])).is_err());
        for id in [
            json!(null),
            json!(true),
            json!(1.5),
            json!(9007199254740992u64),
        ] {
            assert!(ids(&query(id)).is_err());
        }
        let mut q = query(json!(1));
        q.as_object_mut().unwrap().remove("id");
        assert!(ids(&q).is_err());
        let mut q = query(json!(1));
        q["params"] = json!(null);
        assert!(ids(&q).is_err());
        let mut q = query(json!(1));
        q["method"] = json!("engine_getPayloadV3");
        assert!(ids(&q).is_err());
        assert!(user_reply(
            &json!({"jsonrpc":"2.0","id":2,"result":"0x1"}),
            false,
            &[json!(1)]
        )
        .is_err());
        assert!(user_reply(
            &json!({"jsonrpc":"2.0","id":1,"result":"0x1","error":{}}),
            false,
            &[json!(1)]
        )
        .is_err());
    }
    #[test]
    fn canonical_quantities_and_hashes() {
        for v in [
            json!(1),
            json!("0x"),
            json!("0x01"),
            json!("0xA"),
            json!("0x10000000000000000"),
        ] {
            assert!(quantity(&v).is_err());
        }
        assert_eq!(quantity(&json!("0x0")).unwrap(), 0);
        assert!(hash(&json!("0x12")).is_err());
    }
    struct Fixture {
        fault: &'static str,
    }
    fn h(n: u64) -> String {
        format!("0x{n:064x}")
    }
    fn b(n: u64, t: u64) -> Value {
        json!({"number":format!("0x{n:x}"),"hash":h(n),"timestamp":format!("0x{t:x}")})
    }
    impl Local for Fixture {
        fn rpc(&mut self, port: u16, m: &str, p: Value) -> R<Value> {
            if self.fault == "unknown" {
                return Err("unavailable");
            }
            Ok(match m {
                "eth_chainId" => json!(if self.fault == "wrong_chain" {
                    "0x2"
                } else if port == 18645 {
                    "0x1"
                } else {
                    "0x2105"
                }),
                "eth_syncing" => json!(if self.fault == "syncing" {
                    json!({"currentBlock":"0x1"})
                } else {
                    json!(false)
                }),
                "eth_getBlockByNumber" => match p[0].as_str().unwrap() {
                    "0x0" => {
                        json!({"hash":if self.fault=="wrong_genesis" {h(0)}else{"0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3".into()}})
                    }
                    "latest" => b(
                        30,
                        if self.fault == "stale" {
                            1
                        } else if self.fault == "future" {
                            1100
                        } else {
                            999
                        },
                    ),
                    "safe" => b(if self.fault == "order" { 5 } else { 20 }, 995),
                    "finalized" => b(if self.fault == "zero" { 0 } else { 10 }, 990),
                    "0xa" => b(
                        if self.fault == "beacon_mismatch" {
                            11
                        } else {
                            10
                        },
                        990,
                    ),
                    _ => return Err("unexpected method"),
                },
                "optimism_syncStatus" => {
                    json!({"safe_l2":{"number":20,"hash":h(if self.fault=="base_mismatch"{21}else{20})},"finalized_l2":{"number":10,"hash":h(10)}})
                }
                _ => return Err("unexpected method"),
            })
        }
        fn beacon(&mut self, path: &str) -> R<Value> {
            Ok(match path {
                "/eth/v1/node/syncing" => {
                    if self.fault == "missing_consensus" {
                        json!({})
                    } else {
                        json!({"is_syncing":false,"is_optimistic":self.fault=="optimistic","el_offline":false})
                    }
                }
                "/eth/v1/beacon/genesis" => {
                    json!({"genesis_validators_root":"0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95"})
                }
                "/eth/v2/beacon/blocks/finalized" => {
                    json!({"message":{"body":{"execution_payload":{"block_number":"10","block_hash":h(10)}}}})
                }
                _ => return Err("unexpected beacon path"),
            })
        }
    }
    #[test]
    fn local_readiness_consistency() {
        assert!(readiness(&mut Fixture { fault: "" }, 1000).is_ok());
    }
    #[test]
    fn local_readiness_refusals() {
        for fault in [
            "unknown",
            "wrong_chain",
            "wrong_genesis",
            "syncing",
            "stale",
            "future",
            "order",
            "zero",
            "beacon_mismatch",
            "base_mismatch",
            "missing_consensus",
            "optimistic",
        ] {
            assert!(readiness(&mut Fixture { fault }, 1000).is_err(), "{fault}");
        }
    }
}
