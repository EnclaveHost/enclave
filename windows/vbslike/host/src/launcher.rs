//! The launcher: one Hyper-V child partition per app, the SAME guest image inside each (the m3 monitor
//! image), driven over hv_sock with the contract's control protocol. Per partition:
//!
//!   1. bind the report-signing service to THIS partition's id (port 9001) before it exists, so the only
//!      thing that can ever reach it is code inside that partition;
//!   2. create + start (WSL kernel, our initramfs, `report_host=9001` on the command line);
//!   3. dial the in-guest monitor's control port (9000) and `load` the bundle; the monitor answers with
//!      the app ID it computed, which must equal the hash of what we sent -- HASH AGREEMENT -- or the
//!      partition is ended before it serves a byte;
//!   4. relay host TCP to the domain's port inside the partition; TLS ends in the domain;
//!   5. sign report_data for that partition only when its app half is the ID we loaded there;
//!   6. a partition that exits, is terminated, or is destroyed is retired exactly once (contract lifecycle).
use crate::contract::{self, Lifecycle, State};
use crate::hcs::{domain_document, DomainSpec, Partition};
use crate::hvsock;
use crate::report::{DomainId, LauncherId, LauncherKey, PartitionId, Platform, ReportDoc, SignedReport, FORMAT, TIER};
use crate::util::{now_ms, unix_ms};
use serde_json::{json, Value};
use sha2::Digest;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use windows_sys::core::GUID;

pub const CTRL_PORT: u32 = 9000;
pub const REPORT_PORT: u32 = 9001;
pub const MAX_LINE: usize = 64 << 10;
pub const MAX_REPORT_LINE: usize = 1 << 10;
pub const MAX_REPORTS_PER_PARTITION: u32 = 4;
pub const SDDL_ADMIN_SYSTEM: &str = "D:P(A;;FA;;;SY)(A;;FA;;;BA)";

pub struct Domain {
    pub id: u32,
    pub label: String,
    pub vm_id: GUID,
    pub vm_id_str: String,
    pub app_id: [u8; 32],
    pub app_sha: String,
    pub vcpus: u64,
    pub mem_mib: u64,
    pub guest_id: Mutex<u32>,   // the domain id the in-guest monitor assigned
    /// G1: the monitor's per-boot nonce from the load answer. Every stop/destroy carries it; a guest that
    /// rebooted answers `rebooted: true`, which means this domain is GONE (a known end), not an error.
    pub guest_boot: Mutex<Option<String>>,
    pub guest_port: Mutex<u32>, // the vsock port the domain serves on inside the partition
    pub tcp_port: u16,
    part: Partition,
    life: Lifecycle,
    exited: Mutex<bool>,
    exited_cv: Condvar,
    reports_in_flight: AtomicU32,
    pub events: Mutex<Vec<String>>,
    ended_reason: Mutex<Option<String>>,
    relay: Mutex<Option<Arc<TcpListener>>>,
    report_l: Mutex<Option<Arc<hvsock::Listener>>>,
    closing: std::sync::atomic::AtomicBool,
    console_path: PathBuf,
    pub loaded_ids: Mutex<Vec<[u8; 32]>>, // every app ID this launcher loaded into this partition
}

impl Domain {
    /// A stop/destroy for this domain's guest id, carrying the boot its load answer named (G1). Without a
    /// boot (a monitor older than 1e9e99fb) the field is omitted; a newer monitor refuses that with
    /// `bootRequired`, which is the correct refusal rather than a guess.
    pub fn guest_cmd(&self, cmd: &str) -> Value {
        let gid = *self.guest_id.lock().unwrap();
        match self.guest_boot.lock().unwrap().clone() {
            Some(b) => json!({"cmd": cmd, "id": gid, "boot": b}),
            None => json!({"cmd": cmd, "id": gid}),
        }
    }
    fn log(&self, s: String) {
        println!("LAUNCH partition {} {}", self.id, s);
        self.events.lock().unwrap().push(format!("{:.0} {}", now_ms(), s));
    }
    pub fn state(&self) -> State {
        self.life.state()
    }
    pub fn ended_reason(&self) -> Option<String> {
        self.ended_reason.lock().unwrap().clone()
    }
    fn mark_exited(&self) {
        *self.exited.lock().unwrap() = true;
        self.exited_cv.notify_all();
    }
    pub fn wait_exited(&self, d: Duration) -> bool {
        let e = self.exited.lock().unwrap();
        let (e, _) = self.exited_cv.wait_timeout_while(e, d, |x| !*x).unwrap();
        *e
    }
    /// One command to the in-guest monitor on a fresh control connection; one JSON line back.
    pub fn guest(&self, cmd: &Value, body: Option<&[u8]>, timeout: Duration) -> Result<Value, String> {
        let c = hvsock::dial(&self.vm_id, CTRL_PORT, Duration::from_secs(5)).map_err(|e| format!("control dial: {e}"))?;
        let _ = c.set_read_timeout(Some(timeout));
        let _ = c.set_write_timeout(Some(timeout));
        let mut w = c.try_clone().map_err(|e| e.to_string())?;
        let mut s = serde_json::to_string(cmd).unwrap();
        s.push('\n');
        w.write_all(s.as_bytes()).map_err(|e| format!("control write: {e}"))?;
        if let Some(b) = body {
            w.write_all(b).map_err(|e| format!("control body: {e}"))?;
        }
        let mut r = BufReader::new(c);
        let line = read_line(&mut r, MAX_LINE).map_err(|e| format!("control answer: {e}"))?;
        serde_json::from_str(&line).map_err(|e| format!("control answer not JSON: {e}: {line}"))
    }
    /// release frees everything the partition holds, exactly once: the relay and signing ports first,
    /// then the partition itself, then waits for it to be gone.
    fn release(&self, why: &str) {
        self.life.reclaim(|| {
            *self.ended_reason.lock().unwrap() = Some(why.to_string());
            self.closing.store(true, Ordering::SeqCst);
            // The service threads hold their own references and leave when they see `closing`; the
            // relay's accept is woken with a connection to itself so it notices at once. Nothing here
            // waits on a lock a service thread might be holding.
            drop(self.report_l.lock().unwrap().take());
            if let Some(l) = self.relay.lock().unwrap().take() {
                let _ = TcpStream::connect_timeout(&l.local_addr().unwrap(), Duration::from_millis(200));
                drop(l);
            }
            if !*self.exited.lock().unwrap() {
                match self.part.terminate() {
                    Ok(_) => self.log("terminate: partition told to stop".into()),
                    Err(e) => self.log(format!("terminate: {e}")),
                }
                if !self.wait_exited(Duration::from_secs(15)) {
                    self.log("WARN partition did not report exit within 15s; reclaiming anyway".into());
                }
            }
            self.log(format!("ended: {why}"));
        });
    }
}

pub struct Launcher {
    pub key: LauncherKey,
    pub kernel: String,
    pub initrd: String,
    pub kernel_sha: String,
    pub initrd_sha: String,
    pub out: PathBuf,
    pub boundary: String,
    pub platform: Platform,
    doms: Mutex<HashMap<u32, Arc<Domain>>>,
    by_vm: Mutex<HashMap<String, Arc<Domain>>>,
    ended: Mutex<HashMap<u32, Arc<Domain>>>, // retired partitions, kept for their event log only
    next: AtomicU32,
    tcp_base: u16,
}

pub struct LoadReq<'a> {
    pub label: &'a str,
    pub app: &'a [u8],
    pub vcpus: u64,
    pub mem_mib: u64,
    pub probe: bool,
}

pub struct LoadResult {
    pub domain: Arc<Domain>,
    pub t_create_ms: f64,
    pub t_start_ms: f64,
    pub t_monitor_ms: f64,
    pub t_loaded_ms: f64,
    pub guest_answer: Value,
}

fn sha_file(p: &str) -> String {
    std::fs::read(p).map(|b| hex::encode(sha2::Sha256::digest(&b))).unwrap_or_else(|e| format!("unreadable: {e}"))
}

impl Launcher {
    pub fn new(kernel: String, initrd: String, out: PathBuf, tcp_base: u16) -> Arc<Launcher> {
        let platform = Platform { os: "windows".into(), hypervisor: "hyper-v".into(), partition: "hcs-child-partition".into(), isolation: "none".into(), host_excluded: false };
        // The boundary tuple the m3 guest prints for itself is "tier=t0-hv ... host_excluded=no"; this
        // is the launcher's own statement of where it stands: in the root partition, trusted.
        let boundary = format!("tier={TIER} partition=hcs-child isolation=none host_excluded=no signer=launcher-in-root-partition");
        let kernel_sha = sha_file(&kernel);
        let initrd_sha = sha_file(&initrd);
        Arc::new(Launcher { key: LauncherKey::mint(), kernel, initrd, kernel_sha, initrd_sha, out, boundary, platform, doms: Mutex::new(HashMap::new()), by_vm: Mutex::new(HashMap::new()), ended: Mutex::new(HashMap::new()), next: AtomicU32::new(1), tcp_base })
    }
    pub fn launcher_id(&self) -> LauncherId {
        LauncherId { key: self.key.public_b64(), started_ms: self.key.started_ms }
    }
    fn register(&self, d: &Arc<Domain>) {
        self.doms.lock().unwrap().insert(d.id, d.clone());
        self.by_vm.lock().unwrap().insert(d.vm_id_str.clone(), d.clone());
    }
    fn deregister(&self, d: &Arc<Domain>) -> bool {
        self.ended.lock().unwrap().insert(d.id, d.clone());
        let mut doms = self.doms.lock().unwrap();
        let listed = doms.contains_key(&d.id);
        if doms.get(&d.id).map(|x| Arc::ptr_eq(x, d)).unwrap_or(false) {
            doms.remove(&d.id);
        }
        let mut bv = self.by_vm.lock().unwrap();
        if bv.get(&d.vm_id_str).map(|x| Arc::ptr_eq(x, d)).unwrap_or(false) {
            bv.remove(&d.vm_id_str);
        }
        listed
    }
    pub fn get(&self, id: u32) -> Option<Arc<Domain>> {
        self.doms.lock().unwrap().get(&id).cloned()
    }
    /// A partition's record whether it is live or already retired (for evidence, never for serving).
    pub fn record(&self, id: u32) -> Option<Arc<Domain>> {
        self.get(id).or_else(|| self.ended.lock().unwrap().get(&id).cloned())
    }
    pub fn snapshot(&self) -> Value {
        let doms = self.doms.lock().unwrap();
        let mut v: Vec<Value> = doms.values().map(|d| json!({"id": d.id, "label": d.label, "vmId": d.vm_id_str, "appSha256": d.app_sha, "state": d.state().name(), "guestId": *d.guest_id.lock().unwrap(), "guestPort": *d.guest_port.lock().unwrap(), "tcpPort": d.tcp_port})).collect();
        v.sort_by_key(|x| x["id"].as_u64());
        json!(v)
    }
    pub fn state(&self) -> Value {
        let hcs = crate::hcs::enumerate(r#"{"Owners":["vbslike"]}"#).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(json!(null));
        json!({"domains": self.doms.lock().unwrap().len(), "byVm": self.by_vm.lock().unwrap().len(), "hcsOwnedByVbslike": hcs.as_array().map(|a| a.len()).unwrap_or(0), "hcs": hcs})
    }
    fn abandon(&self, d: &Arc<Domain>, why: &str) {
        let listed = self.deregister(d);
        d.life.fail_start();
        d.release(why);
        if listed {
            println!("LAUNCH partition {} abandoned: {why}", d.id);
        }
    }
    pub fn retire(&self, d: &Arc<Domain>, why: &str) {
        let _ = self.deregister(d);
        if !d.life.request_end(why) {
            return;
        }
        d.release(why);
    }
    /// destroy: the in-guest domain first (its own reclamation), then the partition.
    pub fn destroy(&self, id: u32) -> Result<Value, String> {
        let d = self.get(id).ok_or_else(|| format!("no partition {id}"))?;
        let ans = d.guest(&d.guest_cmd("destroy"), None, Duration::from_secs(20)).unwrap_or_else(|e| json!({"error": e}));
        let why = if ans.get("rebooted").and_then(|x| x.as_bool()) == Some(true) {
            "destroyed at lease end; the guest had REBOOTED, so its domain was already gone (a known end)"
        } else { "destroyed at lease end" };
        self.retire(&d, why);
        Ok(ans)
    }
    /// stop: the in-guest graceful path (the monitor signals the domain's init, the front winds down),
    /// then the partition is ended.
    pub fn stop(&self, id: u32) -> Result<Value, String> {
        let d = self.get(id).ok_or_else(|| format!("no partition {id}"))?;
        let ans = d.guest(&d.guest_cmd("stop"), None, Duration::from_secs(30)).unwrap_or_else(|e| json!({"error": e}));
        let why = if ans.get("rebooted").and_then(|x| x.as_bool()) == Some(true) {
            "stopped at lease end; the guest had REBOOTED, so its domain was already gone (a known end)"
        } else { "stopped at lease end" };
        self.retire(&d, why);
        Ok(ans)
    }
    /// kill: the partition is terminated by the host with no notice to the guest -- the crash the lab
    /// injects. Whatever else happens, the exit path retires it.
    pub fn kill(&self, id: u32) -> Result<(), String> {
        let d = self.get(id).ok_or_else(|| format!("no partition {id}"))?;
        d.part.terminate().map(|_| ()).map_err(|e| e.to_string())
    }

    pub fn load(self: &Arc<Self>, req: LoadReq) -> Result<LoadResult, String> {
        let t0 = Instant::now();
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let app_id = contract::app_id(req.app);
        let app_sha = hex::encode(app_id);
        // a bundle that this side cannot parse is refused here, before a partition exists
        match contract::parse(req.app) {
            Ok(_) | Err(contract::ParseError::NotBundle) => {}
            // the same words the in-guest monitor uses (isolation/contract Parse), so a refusal reads the
            // same on every backend whichever layer refused first
            Err(contract::ParseError::Malformed(m)) => return Err(format!("bundle refused: {m}")),
        }
        let sys_id = new_guid_string();
        let console = self.out.join(format!("p{}-{}.console", id, req.label));
        let pipe = format!(r"\\.\pipe\vbslike-{}-{}-com1", std::process::id(), id);
        // The m3 image's own command line (isolation/m1/domain.env APPEND) plus the one thing a
        // Hyper-V partition needs: where its launcher signs reports.
        let cmdline = format!("console=ttyS0 rdinit=/init loglevel=3 nr_cpus={} report_host={REPORT_PORT}", req.vcpus);
        let doc = domain_document(&DomainSpec { kernel: &self.kernel, initrd: &self.initrd, cmdline: &cmdline, mem_mib: req.mem_mib, cpus: req.vcpus, console_pipe: &pipe, hvsock_sddl: SDDL_ADMIN_SYSTEM });
        let _ = std::fs::write(self.out.join(format!("p{}-{}.hcs.json", id, req.label)), &doc);

        let part = Partition::create(&sys_id, &doc).map_err(|e| e.to_string())?;
        let t_create = t0.elapsed().as_secs_f64() * 1e3;
        let props = part.properties("").unwrap_or_default();
        let runtime_id = serde_json::from_str::<Value>(&props).ok().and_then(|v| v.get("RuntimeId").and_then(|x| x.as_str()).map(|s| s.to_string())).unwrap_or_else(|| sys_id.clone());
        let vm = match hvsock::parse_guid(&runtime_id) {
            Some(g) => g,
            None => {
                let _ = part.terminate();
                return Err(format!("partition runtime id is not a GUID: {runtime_id:?}"));
            }
        };
        let vm_str = hvsock::guid_string(&vm);
        let d = Arc::new(Domain {
            id, label: req.label.to_string(), vm_id: vm, vm_id_str: vm_str.clone(), app_id, app_sha: app_sha.clone(), vcpus: req.vcpus, mem_mib: req.mem_mib,
            guest_id: Mutex::new(0), guest_boot: Mutex::new(None), guest_port: Mutex::new(0), tcp_port: self.tcp_base + id as u16, part, life: Lifecycle::new(State::Starting),
            exited: Mutex::new(false), exited_cv: Condvar::new(), reports_in_flight: AtomicU32::new(0), events: Mutex::new(Vec::new()), ended_reason: Mutex::new(None),
            relay: Mutex::new(None), report_l: Mutex::new(None), closing: std::sync::atomic::AtomicBool::new(false), console_path: console, loaded_ids: Mutex::new(vec![app_id]),
        });
        d.log(format!("created {sys_id} runtime_id={vm_str} app_id={app_sha} label={} image={} kernel={}", req.label, self.initrd_sha, self.kernel_sha));
        self.register(&d);

        // The signing service is bound to THIS partition's id before the partition runs.
        match hvsock::Listener::bind(&vm, REPORT_PORT) {
            Ok(l) => *d.report_l.lock().unwrap() = Some(Arc::new(l)),
            Err(e) => {
                self.abandon(&d, &format!("failed to start: hv_sock bind report service: {e}"));
                return Err(format!("hv_sock bind: {e}"));
            }
        }
        if let Err(e) = d.part.start() {
            self.abandon(&d, &format!("failed to start: {e}"));
            return Err(e.to_string());
        }
        let t_start = t0.elapsed().as_secs_f64() * 1e3;
        d.log("started".into());
        {
            let d2 = d.clone();
            std::thread::spawn(move || console_reader(d2));
        }
        {
            let m = self.clone();
            let d2 = d.clone();
            std::thread::spawn(move || {
                let how = d2.part.wait_exit(u32::MAX).unwrap_or_else(|e| format!("wait error: {e}"));
                d2.mark_exited();
                m.retire(&d2, &format!("partition exited: {}", how.trim()));
            });
        }
        {
            let m = self.clone();
            let d2 = d.clone();
            std::thread::spawn(move || report_service(m, d2));
        }

        // The in-guest monitor comes up in about a second; wait for its control port.
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut mon_state = None;
        while Instant::now() < deadline {
            if *d.exited.lock().unwrap() {
                break;
            }
            match d.guest(&json!({"cmd": "state"}), None, Duration::from_secs(5)) {
                Ok(v) => {
                    mon_state = Some(v);
                    break;
                }
                Err(_) => std::thread::sleep(Duration::from_millis(250)),
            }
        }
        let Some(mon_state) = mon_state else {
            self.abandon(&d, "failed to start: the in-guest monitor never answered on its control port");
            return Err("monitor never answered".into());
        };
        let t_monitor = t0.elapsed().as_secs_f64() * 1e3;
        d.log(format!("monitor up: {mon_state}"));

        let ans = match d.guest(&json!({"cmd": "load", "label": req.label, "size": req.app.len(), "probe": req.probe}), Some(req.app), Duration::from_secs(60)) {
            Ok(v) => v,
            Err(e) => {
                self.abandon(&d, &format!("failed to start: load: {e}"));
                return Err(e);
            }
        };
        if let Some(e) = ans.get("error") {
            self.abandon(&d, &format!("failed to start: the monitor refused the load: {e}"));
            return Err(format!("load refused: {e}"));
        }
        let guest_sha = ans.get("appSha256").and_then(|x| x.as_str()).unwrap_or("");
        // HASH AGREEMENT: the monitor names what it received; it must be what we sent.
        if guest_sha != app_sha {
            self.abandon(&d, &format!("failed to start: hash disagreement: launcher {app_sha} guest {guest_sha:?}"));
            return Err("hash disagreement".into());
        }
        // NO DEFAULTS (63's L4): a load answer that names no id or port is a failed start, not id 0.
        let (Some(gid), Some(gport)) = (ans.get("id").and_then(|x| x.as_u64()), ans.get("port").and_then(|x| x.as_u64())) else {
            self.abandon(&d, "failed to start: the load answer did not name the domain's id and port");
            return Err("load answer without id/port".into());
        };
        *d.guest_id.lock().unwrap() = gid as u32;
        *d.guest_port.lock().unwrap() = gport as u32;
        *d.guest_boot.lock().unwrap() = ans.get("boot").and_then(|x| x.as_str()).map(|s| s.to_string());
        let t_loaded = t0.elapsed().as_secs_f64() * 1e3;
        d.log(format!("loaded: guest agrees on {app_sha}; guest domain {} on vsock port {}", d.guest_id.lock().unwrap(), d.guest_port.lock().unwrap()));

        match TcpListener::bind(("127.0.0.1", d.tcp_port)) {
            Ok(l) => {
                let l = Arc::new(l);
                *d.relay.lock().unwrap() = Some(l.clone());
                let d2 = d.clone();
                std::thread::spawn(move || relay_loop(l, d2));
            }
            Err(e) => {
                self.abandon(&d, &format!("failed to start: relay bind: {e}"));
                return Err(e.to_string());
            }
        }
        let why = d.life.finish_start();
        if !why.is_empty() {
            self.retire(&d, &why);
            return Err(format!("partition {id} was ended during startup: {why}"));
        }
        d.log("running".into());
        Ok(LoadResult { domain: d, t_create_ms: t_create, t_start_ms: t_start, t_monitor_ms: t_monitor, t_loaded_ms: t_loaded, guest_answer: ans })
    }

    /// Sign report_data for a partition. The app half must be an ID this launcher loaded into THAT
    /// partition; the binding half is the domain's own and passes through untouched.
    pub fn issue(&self, d: &Domain, rd: &[u8; 64]) -> Result<SignedReport, String> {
        let mut app = [0u8; 32];
        app.copy_from_slice(&rd[32..]);
        if !d.loaded_ids.lock().unwrap().contains(&app) {
            return Err(format!("report_data names app {} which this launcher did not load into partition {}", hex::encode(app), d.vm_id_str));
        }
        let doc = ReportDoc {
            format: FORMAT.into(),
            tier: TIER.into(),
            platform: self.platform.clone(),
            launcher: self.launcher_id(),
            partition: PartitionId { vm_id: d.vm_id_str.clone(), guest_image_sha256: self.initrd_sha.clone(), kernel_sha256: self.kernel_sha.clone(), vcpus: d.vcpus, mem_mib: d.mem_mib },
            domain: DomainId { label: d.label.clone(), app_sha256: hex::encode(app) },
            report_data: hex::encode(rd),
            boundary: self.boundary.clone(),
            issued_ms: unix_ms(),
        };
        Ok(self.key.sign(&doc))
    }
}

fn read_line<R: BufRead>(r: &mut R, max: usize) -> std::io::Result<String> {
    let mut buf = Vec::new();
    loop {
        let avail = r.fill_buf()?;
        if avail.is_empty() {
            return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "connection closed"));
        }
        let n = avail.len();
        if let Some(p) = avail.iter().position(|&b| b == b'\n') {
            buf.extend_from_slice(&avail[..p]);
            r.consume(p + 1);
            break;
        }
        buf.extend_from_slice(avail);
        r.consume(n);
        if buf.len() > max {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, format!("line exceeds {max} bytes")));
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// The signing service of one partition. The listener is bound to the partition's id, so every
/// connection is from inside it; the request's only meaningful field is reportData; anything naming
/// another app is refused because the app half is checked against what was loaded HERE.
fn report_service(m: Arc<Launcher>, d: Arc<Domain>) {
    let Some(l) = d.report_l.lock().unwrap().clone() else { return };
    loop {
        if d.closing.load(Ordering::SeqCst) {
            return; // dropping `l` here closes the socket
        }
        let (mut c, peer) = match l.accept_timeout(500) {
            Ok(Some(x)) => x,
            Ok(None) => continue,
            Err(_) => return,
        };
        if hvsock::guid_string(&peer) != d.vm_id_str {
            d.log(format!("report service: connection from {} is not this partition; closed", hvsock::guid_string(&peer)));
            continue;
        }
        if d.reports_in_flight.fetch_add(1, Ordering::SeqCst) >= MAX_REPORTS_PER_PARTITION {
            d.reports_in_flight.fetch_sub(1, Ordering::SeqCst);
            let _ = c.write_all(b"{\"error\":\"too many concurrent report requests from this partition\"}\n");
            continue;
        }
        let _ = c.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = c.set_write_timeout(Some(Duration::from_secs(5)));
        let mut r = BufReader::new(c.try_clone().unwrap());
        let answer = match read_line(&mut r, MAX_REPORT_LINE).ok().and_then(|l| serde_json::from_str::<Value>(&l).ok()) {
            Some(v) => {
                let abi_ok = v.get("abi").and_then(|x| x.as_str()) == Some(contract::ABI);
                let rd = v.get("reportData").and_then(|x| x.as_str()).and_then(|h| hex::decode(h).ok());
                match (abi_ok, rd) {
                    (false, _) => json!({"error": format!("abi must be {}", contract::ABI)}),
                    (true, Some(rd)) if rd.len() == 64 => {
                        let mut arr = [0u8; 64];
                        arr.copy_from_slice(&rd);
                        match m.issue(&d, &arr) {
                            Ok(rep) => {
                                d.log(format!("signed a report: app {} bind {}", hex::encode(&rd[32..]), hex::encode(&rd[..32])));
                                json!({"report": rep})
                            }
                            Err(e) => {
                                d.log(format!("REFUSED to sign: {e}"));
                                json!({"error": e})
                            }
                        }
                    }
                    _ => json!({"error": "reportData must be 64 bytes of hex"}),
                }
            }
            None => json!({"error": "bad request"}),
        };
        let mut s = serde_json::to_string(&answer).unwrap();
        s.push('\n');
        let _ = c.write_all(s.as_bytes());
        d.reports_in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

fn relay_loop(l: Arc<TcpListener>, d: Arc<Domain>) {
    for c in l.incoming() {
        let Ok(c) = c else { return };
        if d.closing.load(Ordering::SeqCst) {
            return; // the last reference closes the port
        }
        let d2 = d.clone();
        std::thread::spawn(move || {
            let port = *d2.guest_port.lock().unwrap();
            let up = match hvsock::dial(&d2.vm_id, port, Duration::from_secs(5)) {
                Ok(u) => u,
                Err(e) => {
                    d2.log(format!("relay: domain port {port} unreachable: {e}"));
                    return;
                }
            };
            pump(c, up);
        });
    }
}

fn pump(a: TcpStream, b: TcpStream) {
    let (mut a1, mut b1) = (a.try_clone().unwrap(), b.try_clone().unwrap());
    let t = std::thread::spawn(move || {
        let _ = std::io::copy(&mut a1, &mut b1);
        let _ = b1.shutdown(std::net::Shutdown::Write);
    });
    let (mut a2, mut b2) = (a, b);
    let _ = std::io::copy(&mut b2, &mut a2);
    let _ = a2.shutdown(std::net::Shutdown::Write);
    let _ = t.join();
}

fn console_reader(d: Arc<Domain>) {
    let pipe = format!(r"\\.\pipe\vbslike-{}-{}-com1", std::process::id(), d.id);
    let mut f = None;
    for _ in 0..100 {
        match std::fs::OpenOptions::new().read(true).write(true).open(&pipe) {
            Ok(h) => {
                f = Some(h);
                break;
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    let Some(mut f) = f else {
        d.log(format!("console: could not open {pipe}"));
        return;
    };
    let Ok(mut out) = std::fs::File::create(&d.console_path) else { return };
    let mut buf = [0u8; 4096];
    loop {
        match f.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let _ = out.write_all(&buf[..n]);
                let _ = out.flush();
            }
            Err(_) => break,
        }
    }
}

/// A random version-4 GUID, formatted the way HCS prints ids.
fn new_guid_string() -> String {
    let mut b = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}", b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15])
}
