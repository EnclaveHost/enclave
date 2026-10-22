//! site-host: the Enclave website as an Enclave app.
//!
//! One wasi:http component serves ONE website release at the origin root of its deployment (its own
//! `<label>.app.enclave.host`, and any name the platform's custom-domain flow routes to it). The release is the
//! site-release tool's CARv1 (enclave repo scripts/site-release), embedded at build time (release/site.car, written by
//! scripts/embed-release.mjs). The component therefore IS the release: its catalog CID covers every site byte, and a
//! host serving it needs no gateway, bucket or network at all.
//!
//! The deployment pins what it must serve: ENCLAVE_CONFIG (or /config/config.json) = {"release": "<CID>"}, written by
//! the owner's create()/setConfig. A missing or different pin refuses the whole site (503), as does any defect the
//! release audit finds (site.rs). Every request re-verifies, from the pinned root, every block it serves.
//!
//! Routes (site.rs, matching the production vhost):
//!   - the release tree (files, canonical directory URIs, pretty routes from `_redirects`, the 404 page);
//!   - /install.sh and /install.ps1;
//!   - /.well-known/site-host, the served CID and audit counts.
//
// The wasi:http glue is compiled for wasm32 only. `cargo test` builds the same car/site/mime code natively, without the
// generated bindings.
#[cfg(target_arch = "wasm32")]
#[allow(warnings)]
mod bindings;
pub mod car;
pub mod mime;
pub mod site;

/// The embedded release (scripts/embed-release.mjs writes it).
pub static RELEASE: &[u8] = include_bytes!("../release/site.car");

/// Keys the platform stamps into an app's config at publish time (cli/enclave.mjs ROUTING_KEYS); they say nothing to
/// this app. Any other key besides "release" is refused, so a typo can never pass for a pin.
const PLATFORM_KEYS: [&str; 8] = ["wasi", "threads", "set", "mem64", "gpuOptional", "cpuFallback", "volumes", "_media"];

/// The deployment's pin, or why there is none.
pub fn pin_from_config(raw: Option<String>) -> Result<String, String> {
    let raw = raw.ok_or("the deployment has no config: it must pin {\"release\": \"<CID>\"}")?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("the deployment config is not JSON: {e}"))?;
    let o = v.as_object().ok_or("the deployment config is not a JSON object")?;
    for k in o.keys() {
        if k != "release" && !PLATFORM_KEYS.contains(&k.as_str()) {
            return Err(format!("the deployment config has an unknown key {k:?}"));
        }
    }
    o.get("release").and_then(|r| r.as_str()).map(str::to_string).ok_or_else(|| "the deployment config does not pin a release".to_string())
}

pub fn config_text() -> Option<String> {
    if let Ok(raw) = std::env::var("ENCLAVE_CONFIG") {
        if !raw.trim().is_empty() {
            return Some(raw);
        }
    }
    let file = std::env::var("ENCLAVE_CONFIG_FILE").unwrap_or_else(|_| "/config/config.json".into());
    std::fs::read_to_string(file).ok().filter(|s| !s.trim().is_empty())
}

#[cfg(target_arch = "wasm32")]
mod component {
    use super::{bindings, config_text, pin_from_config, site, RELEASE};
    use bindings::exports::wasi::http::incoming_handler::Guest;
    use bindings::wasi::http::types::{Fields, IncomingRequest, Method, OutgoingBody, OutgoingResponse, ResponseOutparam};

fn header(req: &IncomingRequest, name: &str) -> Option<String> {
    let vals = req.headers().get(&name.to_string());
    // a repeated validator header is ambiguous: ignore it rather than pick one
    if vals.len() != 1 {
        return None;
    }
    String::from_utf8(vals[0].clone()).ok()
}

fn send(out: ResponseOutparam, r: site::Response, head: bool) {
    let headers = Fields::new();
    for (k, v) in &r.headers {
        if head && k.eq_ignore_ascii_case("content-length") {
            continue;
        }
        let _ = headers.append(&k.to_ascii_lowercase(), &v.as_bytes().to_vec());
    }
    let resp = OutgoingResponse::new(headers);
    let _ = resp.set_status_code(r.status);
    let body = resp.body().unwrap();
    ResponseOutparam::set(out, Ok(resp));
    if !head {
        let stream = body.write().unwrap();
        // the platform caps a single body write at 4096 bytes
        for chunk in r.body.chunks(4000) {
            if stream.blocking_write_and_flush(chunk).is_err() {
                break;
            }
        }
        drop(stream);
    }
    let _ = OutgoingBody::finish(body, None);
}

struct Component;

impl Guest for Component {
    fn handle(req: IncomingRequest, out: ResponseOutparam) {
        let method = match req.method() {
            Method::Get => "GET",
            Method::Head => "HEAD",
            _ => "OTHER",
        };
        let pq = req.path_with_query().unwrap_or_else(|| "/".into());
        let path = pq.split('?').next().unwrap_or("/").to_string();
        let head = method == "HEAD";
        let opened = pin_from_config(config_text()).and_then(|pin| site::Site::open(RELEASE, Some(&pin)));
        let r = match opened {
            Err(why) => site::refused(&why, &path),
            Ok(s) => {
                let (inm, range, if_range) = (header(&req, "if-none-match"), header(&req, "range"), header(&req, "if-range"));
                s.handle(&site::Request {
                    method,
                    path_with_query: &pq,
                    if_none_match: inm.as_deref(),
                    range: range.as_deref(),
                    if_range: if_range.as_deref(),
                })
            }
        };
        send(out, r, head);
    }
}

bindings::export!(Component with_types_in bindings);
}
