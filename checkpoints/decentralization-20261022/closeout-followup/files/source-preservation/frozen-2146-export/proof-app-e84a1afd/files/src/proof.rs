//! The canary proof, independent of WASI (unit-tested on the host).
//!
//! Input: the component's environment. On the per-app tier (release-16c2999d, the custody/front-prod lineage 837c0061d)
//! the front hands init each staged secret, custody-released ones included, and init gives the app each as its own
//! variable (`--env NAME=VALUE`). Only names matching `^CANARY_[A-Z0-9_]{1,40}$` are looked at; every other variable is
//! dropped by name, its value never inspected. Of the CANARY_ names, only values in the canary driver's dedicated marker
//! format `CANARY_<YYYYMMDDTHHMMSSZ>_<set [a-z0-9-]{1,32}>_<64 lowercase hex>` (32 random bytes; driver/markers.mjs) are
//! hashed: any other value is not listed, so the app is never a guessing oracle for a low-entropy secret. More than 8
//! CANARY_ names, or one name twice: no proof at all.
//!
//! proof(NAME) = HMAC-SHA256(key = the marker's UTF-8 bytes,
//!                           msg = "enclave-custody-canary-proof-v1\n" || NAME || "\n" || c)   (c: the 64 hex ASCII characters)
//!
//! Nothing here returns, logs or measures a value: callers get names and proofs only.
use hmac::{Hmac, Mac};
use sha2::Sha256;

pub const DOMAIN: &[u8] = b"enclave-custody-canary-proof-v1\n";
pub const MAX_NAMES: usize = 8;

#[derive(Debug, PartialEq, Eq)]
pub enum Answer {
    /// 200: the JSON body
    Proofs(String),
    BadChallenge, // 400
    NotFound,     // 404
    NoMarkers,    // 409
}

/// `^CANARY_[A-Z0-9_]{1,40}$`
pub fn is_name(n: &str) -> bool {
    match n.strip_prefix("CANARY_") {
        Some(r) => !r.is_empty() && r.len() <= 40 && r.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'),
        None => false,
    }
}

fn is_hex64(s: &str) -> bool { s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }

/// `^CANARY_[0-9]{8}T[0-9]{6}Z_[a-z0-9-]{1,32}_[0-9a-f]{64}$`
fn is_marker(v: &str) -> bool {
    let Some(r) = v.strip_prefix("CANARY_") else { return false };
    let b = r.as_bytes();
    if b.len() < 16 + 1 + 1 + 64 || !b[..8].iter().all(u8::is_ascii_digit) || b[8] != b'T'
        || !b[9..15].iter().all(u8::is_ascii_digit) || b[15] != b'Z' || b[16] != b'_' { return false; }
    let rest = &r[17..];
    if rest.len() < 66 { return false; }
    let (set, hex) = rest.split_at(rest.len() - 64);
    let Some(set) = set.strip_suffix('_') else { return false };
    (1..=32).contains(&set.len()) && set.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && is_hex64(hex)
}

/// The usable markers, sorted by name, from (name, value) pairs; None = refused (more than 8 CANARY_ names, a duplicate).
pub fn markers<'a>(env: &'a [(String, String)]) -> Option<Vec<(&'a str, &'a str)>> {
    let mut named: Vec<(&str, &str)> = env.iter().filter(|(n, _)| is_name(n)).map(|(n, v)| (n.as_str(), v.as_str())).collect();
    named.sort_by(|a, b| a.0.cmp(b.0));
    if named.len() > MAX_NAMES || named.windows(2).any(|w| w[0].0 == w[1].0) { return None; }
    Some(named.into_iter().filter(|(_, v)| is_marker(v)).collect())
}

pub fn proof(marker: &str, name: &str, challenge: &str) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(marker.as_bytes()).expect("HMAC takes any key length");
    mac.update(DOMAIN);
    mac.update(name.as_bytes());
    mac.update(b"\n");
    mac.update(challenge.as_bytes());
    mac.finalize().into_bytes().into()
}

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }

/// The whole route table. `env`: the CANARY_-named variables (the caller may pass more; only CANARY_ names are used).
pub fn answer(method_is_get: bool, path_and_query: &str, env: &[(String, String)]) -> Answer {
    let c = match path_and_query.strip_prefix("/canary/proof?c=") {
        Some(c) if method_is_get => c,
        _ => return Answer::NotFound,
    };
    if !is_hex64(c) { return Answer::BadChallenge; }
    let m = match markers(env) { Some(m) if !m.is_empty() => m, _ => return Answer::NoMarkers };
    let names: Vec<String> = m.iter().map(|(n, _)| format!("\"{}\"", n)).collect();
    let proofs: Vec<String> = m.iter().map(|(n, v)| format!("\"{}\":\"{}\"", n, hex(&proof(v, n, c)))).collect();
    Answer::Proofs(format!("{{\"v\":1,\"names\":[{}],\"proofs\":{{{}}}}}", names.join(","), proofs.join(",")))
}

#[cfg(test)]
mod tests {
    use super::*;
    const C: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const M1: &str = "CANARY_20261023T000000Z_c1-rev1_1f3c5b7d9e0a2c4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6";
    const M2: &str = "CANARY_20261023T000000Z_c1-rev1_a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf";
    const H: &str = "1f3c5b7d9e0a2c4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6";

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> { pairs.iter().map(|(n, v)| (n.to_string(), v.to_string())).collect() }
    fn q() -> String { format!("/canary/proof?c={C}") }

    #[test]
    fn known_answer_vectors() {
        // independently computed (python3 hmac/hashlib, test/kat.py)
        assert_eq!(hex(&proof(M1, "CANARY_R1_A", C)), "8f239464100370f8e7c1355b9fc4d7f70f43a453c2872b58e3802731eb793bd1");
        assert_eq!(hex(&proof(M2, "CANARY_R1_B", C)), "2c92d87fd7d143e66908dd7df00670a8bb10d21b528a58a2dec3eae970393155");
    }

    #[test]
    fn the_response_lists_names_and_proofs_only() {
        let e = env(&[("HOME", "/tmp"), ("CANARY_R1_B", M2), ("API_TOKEN", M1), ("CANARY_R1_A", M1), ("ENCLAVE_CONFIG", "{}")]);
        let want = format!(r#"{{"v":1,"names":["CANARY_R1_A","CANARY_R1_B"],"proofs":{{"CANARY_R1_A":"{}","CANARY_R1_B":"{}"}}}}"#,
            hex(&proof(M1, "CANARY_R1_A", C)), hex(&proof(M2, "CANARY_R1_B", C)));
        assert_eq!(answer(true, &q(), &e), Answer::Proofs(want.clone()));
        assert!(!want.contains(M1) && !want.contains(M2) && !want.contains(H) && !want.contains("API_TOKEN"), "no value or other name leaves");
        // the whole shape, proofs blanked: no length, count or other field beyond v:1
        let mut skeleton = want.clone();
        for p in [hex(&proof(M1, "CANARY_R1_A", C)), hex(&proof(M2, "CANARY_R1_B", C))] { skeleton = skeleton.replace(&p, "P"); }
        assert_eq!(skeleton, r#"{"v":1,"names":["CANARY_R1_A","CANARY_R1_B"],"proofs":{"CANARY_R1_A":"P","CANARY_R1_B":"P"}}"#);
    }

    #[test]
    fn routes_and_challenge_refusals() {
        let e = env(&[("CANARY_X", M1)]);
        for p in ["/", "/canary/proof", "/canary/proof?", "/canary/proofs?c=00", "/canary/proof/?c=00", "/env", "/canary/proof?x=1&c=00"] {
            assert_eq!(answer(true, p, &e), Answer::NotFound, "{p}");
        }
        assert_eq!(answer(false, &q(), &e), Answer::NotFound, "POST etc.");
        for c in ["", "00", &C[..63], &format!("{C}0"), &C.to_uppercase(), &format!("{}g", &C[..63]), &format!("{C}&d=1")] {
            assert_eq!(answer(true, &format!("/canary/proof?c={c}"), &e), Answer::BadChallenge, "{c}");
        }
    }

    #[test]
    fn only_dedicated_markers_under_canary_names_are_hashed() {
        let bad_values = [
            "", "hunter2", H,                                                             // low entropy / bare hex: not the marker format
            &M1.to_uppercase(), &M1[..M1.len() - 1], &format!("{M1}0"),                   // case, length
            "CANARY_20261023T000000Z__1f3c5b7d9e0a2c4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6",       // empty set
            "CANARY_20261023T000000Z_C1_1f3c5b7d9e0a2c4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6",     // set case
            "CANARY_2026102T000000Z_c1_1f3c5b7d9e0a2c4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6",      // run form
            "CANARY_20261023T000000Z_c1-1f3c5b7d9e0a2c4e6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6",     // separator
            &format!("CANARY_20261023T000000Z_{}_{H}", "a".repeat(33)),                    // set too long
            "${CANARY_A}",                                                                 // an unresolved placeholder
        ];
        for v in bad_values {
            assert_eq!(answer(true, &q(), &env(&[("CANARY_A", v)])), Answer::NoMarkers, "{v}");
            // a bad value is skipped, never listed; a good one beside it still answers
            let a = answer(true, &q(), &env(&[("CANARY_A", v), ("CANARY_B", M1)]));
            assert!(matches!(&a, Answer::Proofs(b) if b.contains(r#""names":["CANARY_B"]"#)), "{v}: {a:?}");
        }
        assert!(matches!(answer(true, &q(), &env(&[("CANARY_A", &format!("CANARY_20261023T000000Z_{}_{H}", "a".repeat(32)))])), Answer::Proofs(_)));
        for n in ["canary_a", "CANARY_", "CANARY-A", "CANARY_a", "XCANARY_A", "CANARY_A ", &format!("CANARY_{}", "A".repeat(41))] {
            assert_eq!(answer(true, &q(), &env(&[(n, M1)])), Answer::NoMarkers, "{n}");
        }
        assert!(matches!(answer(true, &q(), &env(&[(&format!("CANARY_{}", "A".repeat(40)), M1)])), Answer::Proofs(_)));
        assert_eq!(answer(true, &q(), &env(&[])), Answer::NoMarkers);
        assert_eq!(answer(true, &q(), &env(&[("ENCLAVE_CONFIG", &format!(r#"{{"CANARY_A":"{M1}"}}"#)), ("API_TOKEN", M1)])), Answer::NoMarkers,
            "the config and other variables are never a source");
    }

    #[test]
    fn more_than_eight_names_or_a_duplicate_give_no_proof() {
        let names: Vec<String> = (0..9).map(|i| format!("CANARY_{i}")).collect();
        let eight: Vec<(String, String)> = names[..8].iter().map(|n| (n.clone(), M1.to_string())).collect();
        assert!(matches!(answer(true, &q(), &eight), Answer::Proofs(_)), "8 is allowed");
        let mut nine = eight.clone();
        nine.push((names[8].clone(), "low".to_string()));
        assert_eq!(answer(true, &q(), &nine), Answer::NoMarkers, "a 9th CANARY_ name refuses even with a non-marker value");
        let mut eight_plus_other = eight.clone();
        eight_plus_other.push(("OTHER".to_string(), M1.to_string()));
        assert!(matches!(answer(true, &q(), &eight_plus_other), Answer::Proofs(_)), "other names do not count");
        assert_eq!(answer(true, &q(), &env(&[("CANARY_A", M1), ("CANARY_A", M2)])), Answer::NoMarkers, "duplicate");
    }

    #[test]
    fn proofs_bind_name_challenge_and_marker() {
        let p = proof(M1, "CANARY_A", C);
        assert_ne!(p, proof(M1, "CANARY_B", C));
        assert_ne!(p, proof(M2, "CANARY_A", C));
        assert_ne!(p, proof(M1, "CANARY_A", &C.replace('0', "1")));
    }
}
