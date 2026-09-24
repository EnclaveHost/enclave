// Host run of the portable-runtime conformance vectors (runtime/conformance/vectors.json) through pvm-rt: the component is
// compiled to Pulley here and interpreted, and must print exactly what the reference (Cranelift JIT) printed. Plus every
// refusal: a wrong digest is never compiled, the memory limit and the deadline stop a runaway run, W^X holds, and the
// identity is the contract's field set with this crate's exact wasmtime version.
use std::time::Duration;

fn vectors() -> (Vec<u8>, [u8; 32], serde_like::Value) {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../conformance");
    let v = serde_like::parse(&std::fs::read_to_string(dir.join("vectors.json")).unwrap());
    let bundle = std::fs::read(dir.join(v.get("bundle").as_str())).unwrap();
    let mut want = [0u8; 32];
    let h = v.get("bundle_sha256").as_str();
    for i in 0..32 {
        want[i] = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap();
    }
    (bundle, want, v)
}

#[test]
fn conformance_cases_match_the_reference() {
    let (bundle, want, v) = vectors();
    for c in v.get("cases").as_array() {
        let args: Vec<String> = c
            .get("args")
            .as_array()
            .iter()
            .map(|a| a.as_str().to_string())
            .collect();
        let o = pvm_rt::run_cli(&bundle, &want, &args, 256 << 20, Duration::from_secs(60))
            .expect("runs");
        assert_eq!(
            String::from_utf8_lossy(&o.stdout),
            c.get("stdout").as_str(),
            "stdout for {args:?}"
        );
        assert_eq!(
            o.exit_code as i64,
            c.get("exit").as_i64(),
            "exit for {args:?}"
        );
    }
}

#[test]
fn a_wrong_digest_is_never_compiled() {
    let (bundle, mut want, _) = vectors();
    want[0] ^= 1;
    let e = pvm_rt::run_cli(&bundle, &want, &[], 256 << 20, Duration::from_secs(10))
        .err()
        .expect("refused");
    assert!(format!("{e:#}").contains("refusing to compile"), "{e:#}");
    let mut tampered = bundle.clone();
    let n = tampered.len();
    tampered[n - 1] ^= 1;
    let (_, good, _) = vectors();
    assert!(
        pvm_rt::run_cli(&tampered, &good, &[], 256 << 20, Duration::from_secs(10)).is_err(),
        "a changed byte is refused"
    );
}

#[test]
fn the_memory_limit_stops_a_runaway() {
    let (bundle, want, _) = vectors();
    let r = pvm_rt::run_cli(
        &bundle,
        &want,
        &["alloc".into(), "512".into()],
        64 << 20,
        Duration::from_secs(60),
    );
    match r {
        Err(_) => {}
        Ok(o) => assert_ne!(
            o.exit_code, 0,
            "512 MiB under a 64 MiB limit must not succeed"
        ),
    }
}

#[test]
fn the_deadline_stops_a_runaway() {
    let (bundle, want, _) = vectors();
    let t = std::time::Instant::now();
    let e = pvm_rt::run_cli(
        &bundle,
        &want,
        &["spin".into()],
        64 << 20,
        Duration::from_millis(500),
    )
    .err()
    .expect("interrupted");
    assert!(
        t.elapsed() < Duration::from_secs(20),
        "stopped near the deadline, took {:?}",
        t.elapsed()
    );
    let s = format!("{e:#}");
    assert!(s.contains("interrupt") || s.contains("epoch"), "{s}");
}

#[test]
fn w_x_holds_and_the_identity_is_the_contract_field_set() {
    assert_eq!(
        pvm_rt::wx_mappings(),
        0,
        "no writable+executable mapping in this process"
    );
    let id = pvm_rt::identity();
    let names: Vec<&str> = id.iter().map(|(k, _)| *k).collect();
    assert_eq!(
        names,
        [
            "name",
            "version",
            "execution",
            "targetIsa",
            "hostIsa",
            "cpuFeatures",
            "wx",
            "cache"
        ]
    );
    assert_eq!(id[2].1, "interpreter");
    assert_eq!(id[3].1, "pulley64");
    assert_eq!(id[6].1, "enforced");
    assert_eq!(id[7].1, "none");
    // the stated version is the wasmtime this crate is built against (Cargo.lock)
    let lock = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.lock"),
    )
    .unwrap();
    assert!(
        lock.contains(&format!(
            "name = \"wasmtime\"\nversion = \"{}\"",
            pvm_rt::RUNTIME_VERSION
        )),
        "RUNTIME_VERSION matches Cargo.lock"
    );
}

// a tiny JSON reader for the vectors (no serde dependency in the runtime)
mod serde_like {
    #[derive(Debug, Clone)]
    pub enum Value {
        S(String),
        N(i64),
        A(Vec<Value>),
        O(Vec<(String, Value)>),
        Other,
    }
    impl Value {
        pub fn get(&self, k: &str) -> &Value {
            match self {
                Value::O(kv) => &kv.iter().find(|(x, _)| x == k).expect(k).1,
                _ => panic!("not an object"),
            }
        }
        pub fn as_str(&self) -> &str {
            match self {
                Value::S(s) => s,
                _ => panic!("not a string"),
            }
        }
        pub fn as_i64(&self) -> i64 {
            match self {
                Value::N(n) => *n,
                _ => panic!("not a number"),
            }
        }
        pub fn as_array(&self) -> &Vec<Value> {
            match self {
                Value::A(a) => a,
                _ => panic!("not an array"),
            }
        }
    }
    pub fn parse(s: &str) -> Value {
        let b: Vec<char> = s.chars().collect();
        let mut i = 0;
        v(&b, &mut i)
    }
    fn ws(b: &[char], i: &mut usize) {
        while *i < b.len() && b[*i].is_whitespace() {
            *i += 1;
        }
    }
    fn v(b: &[char], i: &mut usize) -> Value {
        ws(b, i);
        match b[*i] {
            '{' => {
                *i += 1;
                let mut kv = vec![];
                loop {
                    ws(b, i);
                    if b[*i] == '}' {
                        *i += 1;
                        break;
                    }
                    let k = st(b, i);
                    ws(b, i);
                    *i += 1;
                    let x = v(b, i);
                    kv.push((k, x));
                    ws(b, i);
                    if b[*i] == ',' {
                        *i += 1;
                    }
                }
                Value::O(kv)
            }
            '[' => {
                *i += 1;
                let mut a = vec![];
                loop {
                    ws(b, i);
                    if b[*i] == ']' {
                        *i += 1;
                        break;
                    }
                    a.push(v(b, i));
                    ws(b, i);
                    if b[*i] == ',' {
                        *i += 1;
                    }
                }
                Value::A(a)
            }
            '"' => Value::S(st(b, i)),
            c if c == '-' || c.is_ascii_digit() => {
                let s = *i;
                while *i < b.len() && (b[*i] == '-' || b[*i].is_ascii_digit()) {
                    *i += 1;
                }
                Value::N(b[s..*i].iter().collect::<String>().parse().unwrap())
            }
            _ => {
                while *i < b.len() && b[*i].is_ascii_alphabetic() {
                    *i += 1;
                }
                Value::Other
            }
        }
    }
    fn st(b: &[char], i: &mut usize) -> String {
        *i += 1;
        let mut s = String::new();
        while b[*i] != '"' {
            if b[*i] == '\\' {
                *i += 1;
                s.push(match b[*i] {
                    'n' => '\n',
                    't' => '\t',
                    c => c,
                });
            } else {
                s.push(b[*i]);
            }
            *i += 1;
        }
        *i += 1;
        s
    }
}
