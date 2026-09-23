//! Small shared helpers: option parsing, wide strings, HRESULT text, JSON evidence files.
use std::collections::HashMap;
use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

pub struct Opts {
    map: HashMap<String, String>,
}

impl Opts {
    pub fn parse(args: &[String]) -> Opts {
        let mut map = HashMap::new();
        let mut i = 0;
        while i < args.len() {
            let a = &args[i];
            if let Some(k) = a.strip_prefix("--") {
                if i + 1 < args.len() && !args[i + 1].starts_with("--") {
                    map.insert(k.to_string(), args[i + 1].clone());
                    i += 2;
                } else {
                    map.insert(k.to_string(), "1".to_string());
                    i += 1;
                }
            } else {
                i += 1;
            }
        }
        Opts { map }
    }
    pub fn get(&self, k: &str) -> Option<&str> {
        self.map.get(k).map(|s| s.as_str())
    }
    pub fn num(&self, k: &str, d: u64) -> u64 {
        self.get(k).and_then(|v| v.parse().ok()).unwrap_or(d)
    }
    pub fn need(&self, k: &str) -> String {
        match self.get(k) {
            Some(v) => v.to_string(),
            None => {
                eprintln!("missing --{k}");
                std::process::exit(2)
            }
        }
    }
}

pub fn wide(s: &str) -> Vec<u16> {
    OsString::from(s).encode_wide().chain(std::iter::once(0)).collect()
}

pub fn hr_text(hr: i32) -> String {
    format!("0x{:08x}", hr as u32)
}

pub fn now_ms() -> f64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START.get_or_init(std::time::Instant::now).elapsed().as_secs_f64() * 1e3
}

pub fn unix_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn write_json(path: &Path, v: &serde_json::Value) {
    if let Some(p) = path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    match serde_json::to_string_pretty(v) {
        Ok(s) => {
            if let Err(e) = std::fs::write(path, s) {
                eprintln!("write {}: {e}", path.display());
            }
        }
        Err(e) => eprintln!("json {}: {e}", path.display()),
    }
}

/// Windows path -> the escaped form JSON needs inside an HCS document.
pub fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}
