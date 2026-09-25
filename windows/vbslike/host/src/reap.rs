//! reap: terminate the probe partitions of ONE run, named by an exact id prefix, and nothing else.
//!
//! Why it exists: a probe that is killed (a timeout, an operator's Ctrl-C, a crash) can leave the
//! partition it had just created running, and ops/isolated-probe.ps1 must be able to clean up exactly
//! that one without going near any other virtual machine on the host. So this refuses to act on
//! anything it was not precisely pointed at:
//!
//!   - the prefix is required, must begin with "vbslike-iso-" and must be longer than that stem, so it
//!     names one run rather than the whole lab;
//!   - only compute systems whose Owner is exactly "vbslike" AND whose Id starts with that prefix are
//!     candidates. Every other system on the host is invisible to this code path;
//!   - each candidate is opened BY ID and terminated; nothing is enumerated for deletion by pattern
//!     inside the service.
//!
//! It prints one JSON object: what it found, what it terminated, and what failed. An empty match is a
//! success with `terminated: []`, because "nothing of this run is left" is the answer the caller wants.
use crate::hcs::{enumerate, Partition};
use crate::util::Opts;
use serde_json::{json, Value};

const STEM: &str = "vbslike-iso-";

pub fn run(o: &Opts) -> i32 {
    let prefix = match o.get("prefix") {
        Some(p) if p.starts_with(STEM) && p.len() > STEM.len() => p.to_string(),
        Some(p) => {
            println!("{}", json!({"ok": false, "error": format!("refusing prefix {p:?}: it must start with {STEM:?} and name one run")}));
            return 2;
        }
        None => {
            println!("{}", json!({"ok": false, "error": "--prefix is required"}));
            return 2;
        }
    };
    let raw = match enumerate(r#"{"Owners":["vbslike"]}"#) {
        Ok(r) => r,
        Err(e) => {
            println!("{}", json!({"ok": false, "error": format!("enumerate: {e}")}));
            return 1;
        }
    };
    let listed: Vec<Value> = match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Array(a)) => a,
        Ok(other) => {
            println!("{}", json!({"ok": false, "error": format!("the service returned {other} rather than an array")}));
            return 1;
        }
        Err(e) => {
            println!("{}", json!({"ok": false, "error": format!("the service's answer is not JSON: {e}")}));
            return 1;
        }
    };
    // Owner is checked here as well as in the query: a candidate must satisfy BOTH conditions in this
    // process, so a query that was ignored or widened cannot turn into a termination.
    let mut candidates = Vec::new();
    for s in &listed {
        let (id, owner) = (s.get("Id").and_then(|x| x.as_str()), s.get("Owner").and_then(|x| x.as_str()));
        match (id, owner) {
            (Some(id), Some("vbslike")) if id.starts_with(&prefix) => candidates.push(id.to_string()),
            (None, _) | (_, None) => {
                println!("{}", json!({"ok": false, "error": "an enumerated system has no Id or Owner: refusing to interpret the list"}));
                return 1;
            }
            _ => {}
        }
    }
    let mut terminated = Vec::new();
    let mut failed = Vec::new();
    for id in &candidates {
        match Partition::open(id).and_then(|p| p.terminate().map(|d| (p, d))) {
            Ok((p, _)) => {
                let _ = p.wait_exit(15_000);
                terminated.push(id.clone());
            }
            Err(e) => failed.push(json!({"id": id, "error": e.to_string()})),
        }
    }
    let ok = failed.is_empty();
    println!("{}", json!({"ok": ok, "prefix": prefix, "ownedByLab": listed.len(), "matched": candidates, "terminated": terminated, "failed": failed}));
    if ok { 0 } else { 1 }
}
