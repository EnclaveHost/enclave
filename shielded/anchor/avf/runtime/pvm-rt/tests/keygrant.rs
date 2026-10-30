// The host's proof key handed between sibling VMs (src/keygrant.rs), against chains from the synthetic AVF test CA
// (tests/keygrant-fixture.json, made by test/fixtures/avf-synthetic.mjs): the grant opens only for the requester that
// attested THIS challenge with THIS one-time key, of THIS build, in a secure VM; the sibling statement recovers to the key.
use pvm_rt::keygrant::{challenge, issue, open, sibling_digest, sign_digest, split_chain};
use sha2::{Digest, Sha256};

fn b64(s: &str) -> Vec<u8> {
    let t = |c: u8| (match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' => 62, b'/' => 63, _ => 0 }) as u32;
    let b: Vec<u8> = s.bytes().filter(|c| *c != b'=').collect();
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
struct F { root: Vec<u8>, inter: Vec<u8>, root_fp: [u8; 32], eph_pub: [u8; 32], requester: Vec<u8>, donor: Vec<u8>, other: Vec<u8>, insecure: Vec<u8> }
fn fixture() -> F {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/keygrant-fixture.json");
    let v = pvm_rt::waf::serde_like::parse(&std::fs::read_to_string(p).unwrap()).unwrap();
    let o = v.as_object().unwrap();
    let s = |k: &str| o.iter().find(|(n, _)| n == k).unwrap().1.as_str().unwrap().to_string();
    let hx = |x: String| (0..x.len()).step_by(2).map(|i| u8::from_str_radix(&x[i..i + 2], 16).unwrap()).collect::<Vec<u8>>();
    F { root: b64(&s("root")), inter: b64(&s("inter")), root_fp: hx(s("rootFp")).try_into().unwrap(), eph_pub: hx(s("ephPub")).try_into().unwrap(),
        requester: b64(&s("requester")), donor: b64(&s("donor")), other: b64(&s("otherBuild")), insecure: b64(&s("insecure")) }
}
fn h(s: &str) -> [u8; 32] { Sha256::digest(s.as_bytes()).into() }

#[test]
fn a_sibling_of_this_build_gets_the_seed_and_nobody_else_does() {
    let f = fixture();
    let (eph, nonce, seed) = (h("pvm keygrant test eph"), h("pvm keygrant test nonce"), h("the host's proof seed"));
    assert_eq!(x25519_pub(&eph), f.eph_pub, "the one-time key the fixture's challenge binds");
    let chain = vec![f.requester.clone(), f.inter.clone(), f.root.clone()];
    let own = vec![f.donor.clone(), f.inter.clone(), f.root.clone()];
    let grant = issue(&chain, &nonce, &f.eph_pub, &own, &seed, &[f.root_fp]).unwrap();
    assert_eq!(grant.len(), 92);
    assert_eq!(open(&eph, &nonce, &grant).unwrap(), seed, "the requester opens it");
    // another one-time key, another nonce, a flipped byte: nothing
    assert!(open(&h("another eph"), &nonce, &grant).is_err());
    assert!(open(&eph, &h("another nonce"), &grant).is_err());
    let mut g2 = grant.clone(); g2[50] ^= 1;
    assert!(open(&eph, &nonce, &g2).is_err());
    // the donor refuses: another challenge (another nonce or another one-time key), another build, an insecure VM, another root
    for (why, c, n, e) in [
        ("another nonce", chain.clone(), h("another nonce"), f.eph_pub),
        ("another one-time key", chain.clone(), nonce, x25519_pub(&h("another eph"))),
        ("another build", vec![f.other.clone(), f.inter.clone(), f.root.clone()], nonce, f.eph_pub),
        ("an insecure VM", vec![f.insecure.clone(), f.inter.clone(), f.root.clone()], nonce, f.eph_pub),
    ] {
        assert!(issue(&c, &n, &e, &own, &seed, &[f.root_fp]).is_err(), "{why}");
    }
    assert!(issue(&chain, &nonce, &f.eph_pub, &own, &seed, &[[7u8; 32]]).is_err(), "another root");
    assert_eq!(challenge(&nonce, &f.eph_pub).len(), 32);
}

#[test]
fn the_sibling_statement_recovers_to_the_proof_key() {
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
    let seed = h("the host's proof seed");
    let d = sibling_digest(&h("relay nonce"), b"spki", &h("instance"), &h("deployment"));
    let sig = sign_digest(&seed, &d).unwrap();
    let rec = VerifyingKey::recover_from_prehash(&d, &Signature::from_slice(&sig[..64]).unwrap(), RecoveryId::from_byte(sig[64] - 27).unwrap()).unwrap();
    assert_eq!(rec, *pvm_rt::proof::key_from_seed(&seed).verifying_key());
}

#[test]
fn chains_cross_the_c_boundary_length_prefixed() {
    let b = [&3u32.to_le_bytes()[..], b"abc", &1u32.to_le_bytes()[..], b"d"].concat();
    assert_eq!(split_chain(&b).unwrap(), vec![b"abc".to_vec(), b"d".to_vec()]);
    assert!(split_chain(&b[..5]).is_err());
}

fn x25519_pub(s: &[u8; 32]) -> [u8; 32] {
    x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(*s)).to_bytes()
}
