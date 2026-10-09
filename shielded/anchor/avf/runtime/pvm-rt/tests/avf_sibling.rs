// A sibling VM's attestation, verified in the VM (src/avf.rs), against a REAL Pixel 10 Pro XL chain
// (test/fixtures/avf/pixel10-pvm-cpu-chain.json, captured 2026-09-23: public certificates) and doctored copies of it.
use pvm_rt::avf::{google_roots, read_leaf, verify_sibling};

fn fixture() -> (Vec<Vec<u8>>, Vec<u8>, Vec<u8>, Vec<u8>) {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../../test/fixtures/avf/pixel10-pvm-cpu-chain.json");
    let v = pvm_rt::waf::serde_like::parse(&std::fs::read_to_string(p).unwrap()).unwrap();
    let o = v.as_object().unwrap();
    let get = |k: &str| o.iter().find(|(n, _)| n == k).unwrap().1.clone();
    let hx = |s: &str| (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect::<Vec<u8>>();
    use base64_lite::decode;
    let chain = get("chain").as_array().unwrap().iter().map(|c| decode(c.as_str().unwrap())).collect();
    (chain, hx(get("challenge").as_str().unwrap()), hx(get("codeHash").as_str().unwrap()), hx(get("authorityHash").as_str().unwrap()))
}
mod base64_lite {
    pub fn decode(s: &str) -> Vec<u8> {
        let t = |c: u8| match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' => 62, b'/' => 63, _ => 0 } as u32;
        let b: Vec<u8> = s.bytes().filter(|c| *c != b'=' && !c.is_ascii_whitespace()).collect();
        let mut out = Vec::new();
        for ch in b.chunks(4) {
            let mut n = 0u32;
            for (i, c) in ch.iter().enumerate() { n |= t(*c) << (18 - 6 * i); }
            out.push((n >> 16) as u8);
            if ch.len() > 2 { out.push((n >> 8) as u8); }
            if ch.len() > 3 { out.push(n as u8); }
        }
        out
    }
}

#[test]
fn a_real_pixel_chain_verifies_for_its_build_and_challenge() {
    let (chain, challenge, code, auth) = fixture();
    let a = verify_sibling(&chain, &challenge, &code, &auth, &google_roots()).unwrap();
    assert!(a.is_vm_secure);
    assert_eq!(a.code_hash, code);
    // the leaf alone tells a VM its own build
    let leaf = read_leaf(&chain[0]).or_else(|_| read_leaf(&chain[1])).unwrap();
    assert_eq!((leaf.code_hash, leaf.authority_hash), (code.clone(), auth.clone()));
    // any order
    let mut rev = chain.clone();
    rev.reverse();
    assert!(verify_sibling(&rev, &challenge, &code, &auth, &google_roots()).is_ok());
}

#[test]
fn another_build_another_signer_another_challenge_or_another_root_is_refused() {
    let (chain, challenge, code, auth) = fixture();
    let mut c2 = challenge.clone();
    c2[0] ^= 1;
    assert!(verify_sibling(&chain, &c2, &code, &auth, &google_roots()).unwrap_err().contains("not ours"));
    let mut other_code = code.clone();
    other_code[0] ^= 1;
    assert!(verify_sibling(&chain, &challenge, &other_code, &auth, &google_roots()).unwrap_err().contains("another build"));
    let mut other_auth = auth.clone();
    other_auth[0] ^= 1;
    assert!(verify_sibling(&chain, &challenge, &code, &other_auth, &google_roots()).unwrap_err().contains("another authority"));
    assert!(verify_sibling(&chain, &challenge, &code, &auth, &[[9u8; 32]]).unwrap_err().contains("not a pinned"));
    // a chain missing its middle does not link
    let short: Vec<Vec<u8>> = vec![chain[0].clone(), chain[chain.len() - 1].clone()];
    assert!(verify_sibling(&short, &challenge, &code, &auth, &google_roots()).is_err());
    // one flipped byte in the leaf's signed part breaks its signature
    let mut forged = chain.clone();
    let n = forged[0].len();
    forged[0][n / 2] ^= 1;
    assert!(verify_sibling(&forged, &challenge, &code, &auth, &google_roots()).is_err());
}
