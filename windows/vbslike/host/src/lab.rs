//! The lab driver: the launcher on a line protocol over stdin/stdout, so the verifier
//! (verify/lab.mjs, separate code) can interleave its own checks between lifecycle steps.
//!   load <label> <file> [probe] | kill <id> | stop <id> | destroy <id> | guest <id> <json>
//!   state | list | events <id> | wait <id> <secs> | quit
use crate::launcher::{Launcher, LoadReq};
use crate::util::{write_json, Opts};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant};

pub fn run(o: &Opts) -> i32 {
    let out = PathBuf::from(o.need("out"));
    let _ = std::fs::create_dir_all(&out);
    let m = Launcher::new(o.need("kernel"), o.need("initrd"), out.clone(), o.num("tcp-base", 45000) as u16);
    let vcpus = o.num("cpus", 1);
    let mem = o.num("mem", 512);
    write_json(&out.join("launcher.json"), &json!({"launcherKey": m.key.public_b64(), "startedMs": m.key.started_ms, "boundary": m.boundary, "platform": m.platform, "kernel": m.kernel, "kernelSha256": m.kernel_sha, "initrd": m.initrd, "initrdSha256": m.initrd_sha}));
    println!("{}", json!({"ready": true, "launcherKey": m.key.public_b64(), "boundary": m.boundary, "initrdSha256": m.initrd_sha, "kernelSha256": m.kernel_sha}));
    let stdin = std::io::stdin();
    let mut line = String::new();
    loop {
        line.clear();
        if stdin.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }
        let id_of = |s: &str| s.parse::<u32>().map_err(|e| e.to_string());
        let answer: Value = match parts[0] {
            "load" if parts.len() >= 3 => match std::fs::read(parts[2]) {
                Ok(app) => {
                    let t = Instant::now();
                    match m.load(LoadReq { label: parts[1], app: &app, vcpus, mem_mib: mem, probe: parts.len() > 3 && parts[3] == "probe" }) {
                        Ok(r) => json!({"loaded": {"id": r.domain.id, "label": parts[1], "vmId": r.domain.vm_id_str, "appSha256": r.domain.app_sha, "guestId": *r.domain.guest_id.lock().unwrap(), "guestPort": *r.domain.guest_port.lock().unwrap(), "tcpPort": r.domain.tcp_port,
                            "ms": {"create": r.t_create_ms, "start": r.t_start_ms, "monitor": r.t_monitor_ms, "loaded": r.t_loaded_ms, "total": t.elapsed().as_secs_f64()*1e3}, "guest": r.guest_answer}}),
                        Err(e) => json!({"error": e}),
                    }
                }
                Err(e) => json!({"error": format!("read {}: {e}", parts[2])}),
            },
            "kill" if parts.len() >= 2 => match id_of(parts[1]).and_then(|id| m.kill(id)) {
                Ok(()) => json!({"killed": parts[1]}),
                Err(e) => json!({"error": e}),
            },
            "stop" if parts.len() >= 2 => match id_of(parts[1]).and_then(|id| m.stop(id)) {
                Ok(g) => json!({"stopped": parts[1], "guest": g}),
                Err(e) => json!({"error": e}),
            },
            "destroy" if parts.len() >= 2 => match id_of(parts[1]).and_then(|id| m.destroy(id)) {
                Ok(g) => json!({"destroyed": parts[1], "guest": g}),
                Err(e) => json!({"error": e}),
            },
            "guest" if parts.len() >= 3 => {
                let cmd: Result<Value, _> = serde_json::from_str(&parts[2..].join(" "));
                match (id_of(parts[1]), cmd) {
                    (Ok(id), Ok(c)) => match m.get(id) {
                        Some(d) => match d.guest(&c, None, Duration::from_secs(20)) {
                            Ok(a) => json!({"guest": a}),
                            Err(e) => json!({"error": e}),
                        },
                        None => json!({"error": "no such partition"}),
                    },
                    _ => json!({"error": "guest <id> <json>"}),
                }
            }
            "wait" if parts.len() >= 3 => {
                let id: u32 = parts[1].parse().unwrap_or(0);
                let secs: u64 = parts[2].parse().unwrap_or(10);
                let t = Instant::now();
                let mut gone = false;
                while t.elapsed() < Duration::from_secs(secs) {
                    if m.get(id).is_none() {
                        gone = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                json!({"waited": id, "gone": gone, "ms": t.elapsed().as_secs_f64()*1e3})
            }
            "events" if parts.len() >= 2 => {
                let id: u32 = parts[1].parse().unwrap_or(0);
                match m.record(id) {
                    Some(d) => json!({"events": *d.events.lock().unwrap(), "state": d.state().name(), "live": m.get(id).is_some()}),
                    None => json!({"events": [], "state": "unknown"}),
                }
            }
            "state" => json!({"state": m.state()}),
            "list" => json!({"domains": m.snapshot()}),
            "quit" => break,
            _ => json!({"error": "unknown command"}),
        };
        println!("{answer}");
    }
    let ids: Vec<u64> = m.snapshot().as_array().map(|a| a.iter().filter_map(|d| d["id"].as_u64()).collect()).unwrap_or_default();
    for id in ids {
        let _ = m.destroy(id as u32);
    }
    println!("{}", json!({"exit": true, "state": m.state()}));
    0
}
