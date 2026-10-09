//! egress-probe (PVM-CPU.md "Egress"): a wasi:http app that reaches out and reads its environment.
//!
//! GET /env?name=<NAME>    {"name":"<NAME>","value":"<its value>"|null}
//! GET /fetch?url=<url>    one outgoing GET (the url percent-encoded): {"status":N,"body":"<its first 256 bytes>"}, or
//!                         {"error":"<the wasi:http error code>"} when the request was not answered
//! GET /ping               {"ok":true}
#[allow(warnings)]
mod bindings;

use bindings::exports::wasi::http::incoming_handler::Guest;
use bindings::wasi::http::outgoing_handler;
use bindings::wasi::http::types::{Fields, IncomingRequest, Method, OutgoingBody, OutgoingRequest, OutgoingResponse, ResponseOutparam, Scheme};

fn answer(out: ResponseOutparam, status: u16, body: &str) {
    let headers = Fields::new();
    let _ = headers.set(&"content-type".to_string(), &[b"application/json".to_vec()]);
    let resp = OutgoingResponse::new(headers);
    let _ = resp.set_status_code(status);
    let b = resp.body().unwrap();
    ResponseOutparam::set(out, Ok(resp));
    let s = b.write().unwrap();
    let _ = s.blocking_write_and_flush(body.as_bytes());
    drop(s);
    let _ = OutgoingBody::finish(b, None);
}

fn json(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn query(pq: &str, key: &str) -> Option<String> {
    let q = pq.split_once('?')?.1;
    let v = q.split('&').find_map(|kv| kv.strip_prefix(&format!("{key}=")))?;
    let b = v.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            out.push(u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn fetch(url: &str) -> Result<(u16, String), String> {
    let (scheme, rest) = url.split_once("://").ok_or("not a url")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let req = OutgoingRequest::new(Fields::new());
    let _ = req.set_method(&Method::Get);
    let _ = req.set_scheme(Some(&if scheme == "http" { Scheme::Http } else { Scheme::Https }));
    let _ = req.set_authority(Some(authority));
    let _ = req.set_path_with_query(Some(path));
    let fut = outgoing_handler::handle(req, None).map_err(|e| format!("{e:?}"))?;
    fut.subscribe().block();
    let resp = fut.get().ok_or("no response")?.map_err(|_| "taken twice".to_string())?.map_err(|e| format!("{e:?}"))?;
    let status = resp.status();
    let body = resp.consume().map_err(|_| "no body")?;
    let stream = body.stream().map_err(|_| "no stream")?;
    let mut got = Vec::new();
    while got.len() < 256 {
        match stream.blocking_read(256 - got.len() as u64) {
            Ok(b) => got.extend_from_slice(&b),
            Err(_) => break,
        }
    }
    Ok((status, String::from_utf8_lossy(&got).into_owned()))
}

struct Probe;
impl Guest for Probe {
    fn handle(req: IncomingRequest, out: ResponseOutparam) {
        let pq = req.path_with_query().unwrap_or_else(|| "/".into());
        let path = pq.split('?').next().unwrap_or("/");
        match (req.method(), path) {
            (Method::Get, "/ping") => answer(out, 200, "{\"ok\":true}"),
            (Method::Get, "/env") => {
                let name = query(&pq, "name").unwrap_or_default();
                let v = std::env::var(&name).ok().map(|v| json(&v)).unwrap_or_else(|| "null".into());
                answer(out, 200, &format!("{{\"name\":{},\"value\":{v}}}", json(&name)));
            }
            (Method::Get, "/fetch") => match fetch(&query(&pq, "url").unwrap_or_default()) {
                Ok((status, body)) => answer(out, 200, &format!("{{\"status\":{status},\"body\":{}}}", json(&body))),
                Err(e) => answer(out, 200, &format!("{{\"error\":{}}}", json(&e))),
            },
            _ => answer(out, 404, "{\"error\":\"not_found\"}"),
        }
    }
}
bindings::export!(Probe with_types_in bindings);
