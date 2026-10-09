//! A deployment's secrets, opened inside the VM (PVM-CPU.md "Secrets"; the relay's half is relay/pvm-secrets.mjs on main).
//!
//! The relay never gives a pVM host's operator a deployment's secrets in the clear. It seals them to this VM's X25519 seal
//! key for (app, deployment) -- derived by the payload from the VM instance's secret, so the same VM opens them again
//! after a relaunch -- and signs the result with its release key; the phone and the host agent carry ciphertext. Here:
//!   1. the relay's signature, by one of the keys pinned in this build, over
//!      sha256("enclave-secrets-release-v1 response\n" || id || ticket || sealKey || sha256(sealed))
//!      -- checked FIRST: the seal key is public, so a host could seal values of its own choosing to it;
//!   2. the seal (relay/secrets-release.mjs sealRelease): ephPub(32) || iv(12) || AES-256-GCM(plaintext) || tag(16), the key
//!      HKDF-SHA256(X25519(seal secret, ephPub), salt = ticket, info = "enclave-secrets-release-v1 seal\n" || id || ephPub ||
//!      sealKey);
//!   3. the plaintext {"id": <this deployment>, "secrets": {NAME: value}, "issuedAt": ...}, its names checked as the relay
//!      checks them, none of the platform's own (ENCLAVE_*).
//! Then `$NAME` in the app's ENCLAVE_CONFIG strings resolves from them (the platform runner's rule, `substitute`).
use ring::{aead, hkdf, signature};
use sha2::{Digest, Sha256};

pub const RESPONSE_DOMAIN: &[u8] = b"enclave-secrets-release-v1 response\n";
pub const SEAL_INFO: &[u8] = b"enclave-secrets-release-v1 seal\n";

/// The release as the host agent hands it over: ticket(32) || relay signature(64) || sealed.
pub struct Release<'a> {
    pub ticket: &'a [u8; 32],
    pub sig: &'a [u8; 64],
    pub sealed: &'a [u8],
}
impl<'a> Release<'a> {
    pub fn parse(b: &'a [u8]) -> Result<Release<'a>, String> {
        if b.len() < 32 + 64 + 32 + 12 + 16 {
            return Err("the sealed release is too short".into());
        }
        Ok(Release { ticket: b[..32].try_into().unwrap(), sig: b[32..96].try_into().unwrap(), sealed: &b[96..] })
    }
}

/// This VM's seal key pair from the payload's seed (RFC 7748 clamping, as libsodium's crypto_scalarmult_base).
pub fn seal_keypair(seed: &[u8; 32]) -> (x25519_dalek::StaticSecret, [u8; 32]) {
    let s = x25519_dalek::StaticSecret::from(*seed);
    let p = x25519_dalek::PublicKey::from(&s).to_bytes();
    (s, p)
}

struct Len32;
impl hkdf::KeyType for Len32 {
    fn len(&self) -> usize {
        32
    }
}

/// Verify, open and check a release for deployment `id`: the secrets, in the order the relay wrote them.
pub fn open(release: &[u8], seed: &[u8; 32], id: &[u8; 32], pinned: &[[u8; 32]]) -> Result<Vec<(String, String)>, String> {
    let r = Release::parse(release)?;
    let (secret, seal_pub) = seal_keypair(seed);
    // 1. the relay's signature, before anything is opened
    let digest = Sha256::new()
        .chain_update(RESPONSE_DOMAIN)
        .chain_update(id)
        .chain_update(r.ticket)
        .chain_update(seal_pub)
        .chain_update(Sha256::digest(r.sealed))
        .finalize();
    if !pinned.iter().any(|k| signature::UnparsedPublicKey::new(&signature::ED25519, k).verify(&digest, r.sig).is_ok()) {
        return Err("the release is not signed by a release key this build pins".into());
    }
    // 2. the seal
    let s = r.sealed;
    let (eph, iv, ct) = (&s[..32], &s[32..44], &s[44..]);
    let eph_pub = x25519_dalek::PublicKey::from(<[u8; 32]>::try_from(eph).unwrap());
    let shared = secret.diffie_hellman(&eph_pub);
    if shared.as_bytes().iter().all(|b| *b == 0) {
        return Err("an all-zero X25519 shared secret (a low-order ephemeral key)".into());
    }
    let info = [SEAL_INFO, &id[..], eph, &seal_pub[..]].concat();
    let mut key = [0u8; 32];
    hkdf::Salt::new(hkdf::HKDF_SHA256, r.ticket)
        .extract(shared.as_bytes())
        .expand(&[&info], Len32)
        .and_then(|okm| okm.fill(&mut key))
        .map_err(|_| "HKDF failed".to_string())?;
    let k = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &key).map_err(|_| "AES key".to_string())?);
    key.iter_mut().for_each(|b| *b = 0);
    let mut buf = ct.to_vec();
    let nonce = aead::Nonce::try_assume_unique_for_key(iv).map_err(|_| "iv".to_string())?;
    let plain = k.open_in_place(nonce, aead::Aad::empty(), &mut buf).map_err(|_| "the sealed release does not open under this VM's seal key".to_string())?;
    let text = std::str::from_utf8(plain).map_err(|_| "the release is not UTF-8".to_string())?;
    let parsed = crate::waf::serde_like::parse(text);
    buf.iter_mut().for_each(|b| *b = 0);
    let v = parsed.map_err(|e| format!("the release is not JSON: {e}"))?;
    // 3. for THIS deployment, and names the relay itself would accept
    let o = v.as_object().ok_or("the release is not an object")?;
    let get = |k: &str| o.iter().find(|(n, _)| n == k).map(|(_, v)| v);
    let want = format!("0x{}", id.iter().map(|b| format!("{b:02x}")).collect::<String>());
    if get("id").and_then(|x| x.as_str()) != Some(want.as_str()) {
        return Err("the release is for another deployment".into());
    }
    let mut out = Vec::new();
    for (name, val) in get("secrets").and_then(|x| x.as_object()).ok_or("the release carries no secrets object")? {
        let ok = !name.is_empty()
            && name.len() <= 64
            && name.bytes().next().is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            && !name.starts_with("ENCLAVE_");
        let val = val.as_str().ok_or_else(|| format!("{name} is not a string"))?;
        if !ok || val.contains('\0') {
            return Err(format!("{name:?} is not a secret this runtime sets"));
        }
        out.push((name.clone(), val.to_string()));
    }
    Ok(out)
}

/// `$NAME` / `${NAME}` in the JSON config's STRING VALUES, resolved from `secrets` (the platform runner's rule: keys untouched,
/// `$$` is a literal `$`, names that are not secrets stay as written). Everything outside a substituted string keeps its
/// bytes; a config that is not JSON is returned unchanged.
pub fn substitute(config: &str, secrets: &[(String, String)]) -> String {
    if secrets.is_empty() || !config.contains('$') || crate::waf::serde_like::parse(config).is_err() {
        return config.to_string();
    }
    let b = config.as_bytes();
    let mut out = String::with_capacity(config.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'"' {
            // copy one UTF-8 character
            let ch = config[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
            continue;
        }
        // a string token: find its end, decode it
        let start = i;
        i += 1;
        while i < b.len() && b[i] != b'"' {
            i += if b[i] == b'\\' { 2 } else { 1 };
        }
        let end = (i + 1).min(b.len());
        i = end;
        let raw = &config[start..end];
        let mut j = end;
        while j < b.len() && matches!(b[j], b' ' | b'\t' | b'\n' | b'\r') {
            j += 1;
        }
        let is_key = j < b.len() && b[j] == b':';
        let decoded = match crate::waf::serde_like::parse(raw) {
            Ok(crate::waf::serde_like::Value::Str(s)) => s,
            _ => {
                out.push_str(raw);
                continue;
            }
        };
        if is_key || !decoded.contains('$') {
            out.push_str(raw);
            continue;
        }
        let replaced = replace_names(&decoded, secrets);
        if replaced == decoded {
            out.push_str(raw);
        } else {
            out.push_str(&json_string(&replaced));
        }
    }
    out
}

fn replace_names(s: &str, secrets: &[(String, String)]) -> String {
    let lookup = |n: &str| secrets.iter().find(|(k, _)| k == n).map(|(_, v)| v.as_str());
    let name_ok = |c: char, first: bool| c == '_' || c.is_ascii_alphabetic() || (!first && c.is_ascii_digit());
    let cs: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < cs.len() {
        if cs[i] != '$' {
            out.push(cs[i]);
            i += 1;
            continue;
        }
        if i + 1 < cs.len() && cs[i + 1] == '$' {
            out.push('$');
            i += 2;
            continue;
        }
        if i + 1 < cs.len() && cs[i + 1] == '{' {
            let mut j = i + 2;
            while j < cs.len() && name_ok(cs[j], j == i + 2) {
                j += 1;
            }
            if j > i + 2 && j < cs.len() && cs[j] == '}' {
                let n: String = cs[i + 2..j].iter().collect();
                match lookup(&n) {
                    Some(v) => out.push_str(v),
                    None => out.extend(&cs[i..=j]),
                }
                i = j + 1;
                continue;
            }
            out.push('$');
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < cs.len() && name_ok(cs[j], j == i + 1) {
            j += 1;
        }
        if j > i + 1 {
            let n: String = cs[i + 1..j].iter().collect();
            match lookup(&n) {
                Some(v) => out.push_str(v),
                None => out.extend(&cs[i..j]),
            }
            i = j;
            continue;
        }
        out.push('$');
        i += 1;
    }
    out
}

/// A string as JSON.stringify writes it.
fn json_string(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\u{8}' => o.push_str("\\b"),
            '\u{c}' => o.push_str("\\f"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}
