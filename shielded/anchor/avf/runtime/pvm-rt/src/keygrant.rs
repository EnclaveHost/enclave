//! The host's proof key, shared among its sibling VMs (PVM-CPU.md "Slots by share"). The ledger holds ONE proof key per
//! registered host, and a host that runs one protected VM per app needs every one of those VMs to sign its own app's
//! checkpoints with it. The key is handed from a VM that holds it to a VM that asks, and only to a VM of the SAME build,
//! in protected mode, that attested the request itself -- verified here, inside the VM that gives (avf.rs):
//!
//!   donor      KEYNONCE                      a fresh nonce, single use, 120 s
//!   requester  KEYREQ <nonce>                a one-time X25519 key; an AVF attestation whose challenge is
//!                                            sha256("enclave-pvm-proofkey-request-v1\n" || nonce || one-time public key)
//!   donor      KEYGRANT (that chain)         verify_sibling against the donor's OWN code and authority hashes, then the
//!                                            seed sealed to the one-time key: X25519 + HKDF-SHA256 (salt = nonce) + AES-256-GCM
//!   requester  KEYINSTALL (the grant)        opened with the one-time key; the seed's address must be the one stated
//! The host (the phone, the agent) carries every byte and can read none that matter: the grant opens only under a key that
//! never left the requesting VM, which a genuine VM of this build attested to holding for this nonce.
//!
//! A sibling then states to the relay that it holds the host's key (`sibling_digest`, signed like a checkpoint): the relay
//! takes app evidence from a VM other than the one its tunnel attached when that VM proves the host's registered key.
use crate::avf;
use ring::{aead, hkdf, rand::SecureRandom};
use sha2::{Digest, Sha256};

pub const REQUEST_DOMAIN: &[u8] = b"enclave-pvm-proofkey-request-v1\n";
pub const GRANT_INFO: &[u8] = b"enclave-pvm-proofkey-grant-v1\n";
pub const SIBLING_DOMAIN: &[u8] = b"enclave-pvm-sibling-v1\n";

/// The AVF challenge a requester attests: binds the donor's nonce and the one-time key the grant will be sealed to.
pub fn challenge(nonce: &[u8; 32], eph_pub: &[u8; 32]) -> [u8; 32] {
    Sha256::new().chain_update(REQUEST_DOMAIN).chain_update(nonce).chain_update(eph_pub).finalize().into()
}

struct Len32;
impl hkdf::KeyType for Len32 {
    fn len(&self) -> usize {
        32
    }
}
fn grant_key(shared: &[u8; 32], nonce: &[u8; 32], eph_pub: &[u8; 32], donor_pub: &[u8; 32]) -> Result<aead::LessSafeKey, String> {
    if shared.iter().all(|b| *b == 0) {
        return Err("an all-zero X25519 shared secret".into());
    }
    let info = [GRANT_INFO, eph_pub, donor_pub].concat();
    let mut k = [0u8; 32];
    hkdf::Salt::new(hkdf::HKDF_SHA256, nonce)
        .extract(shared)
        .expand(&[&info], Len32)
        .and_then(|o| o.fill(&mut k))
        .map_err(|_| "HKDF".to_string())?;
    let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_256_GCM, &k).map_err(|_| "AES key".to_string())?);
    k.iter_mut().for_each(|b| *b = 0);
    Ok(key)
}

/// The donor's half: verify the requester's chain for (nonce, eph_pub) against this VM's own build (`own_chain`: this VM's own
/// attestation, any certificates of it), then seal `seed` to eph_pub: donor_pub(32) || iv(12) || ciphertext(32) || tag(16).
pub fn issue(req_chain: &[Vec<u8>], nonce: &[u8; 32], eph_pub: &[u8; 32], own_chain: &[Vec<u8>], seed: &[u8; 32], roots: &[[u8; 32]]) -> Result<Vec<u8>, String> {
    let own = own_chain.iter().find_map(|c| avf::read_leaf(c).ok()).ok_or("this VM's own attestation carries no AVF leaf")?;
    avf::verify_sibling(req_chain, &challenge(nonce, eph_pub), &own.code_hash, &own.authority_hash, roots)?;
    let rng = ring::rand::SystemRandom::new();
    let mut d = [0u8; 32];
    let mut iv = [0u8; 12];
    rng.fill(&mut d).map_err(|_| "rng".to_string())?;
    rng.fill(&mut iv).map_err(|_| "rng".to_string())?;
    let ds = x25519_dalek::StaticSecret::from(d);
    d.iter_mut().for_each(|b| *b = 0);
    let donor_pub = x25519_dalek::PublicKey::from(&ds).to_bytes();
    let shared = ds.diffie_hellman(&x25519_dalek::PublicKey::from(*eph_pub)).to_bytes();
    let key = grant_key(&shared, nonce, eph_pub, &donor_pub)?;
    let mut buf = seed.to_vec();
    key.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(iv), aead::Aad::from(nonce), &mut buf).map_err(|_| "seal".to_string())?;
    Ok([&donor_pub[..], &iv[..], &buf[..]].concat())
}

/// The requester's half: the seed from a grant sealed to this VM's one-time key.
pub fn open(eph_secret: &[u8; 32], nonce: &[u8; 32], grant: &[u8]) -> Result<[u8; 32], String> {
    if grant.len() != 32 + 12 + 32 + 16 {
        return Err("the grant is not the expected size".into());
    }
    let s = x25519_dalek::StaticSecret::from(*eph_secret);
    let eph_pub = x25519_dalek::PublicKey::from(&s).to_bytes();
    let donor_pub: [u8; 32] = grant[..32].try_into().unwrap();
    let shared = s.diffie_hellman(&x25519_dalek::PublicKey::from(donor_pub)).to_bytes();
    let key = grant_key(&shared, nonce, &eph_pub, &donor_pub)?;
    let mut buf = grant[44..].to_vec();
    let plain = key
        .open_in_place(aead::Nonce::try_assume_unique_for_key(&grant[32..44]).map_err(|_| "iv".to_string())?, aead::Aad::from(nonce), &mut buf)
        .map_err(|_| "the grant does not open under this VM's one-time key".to_string())?;
    let out: [u8; 32] = plain.try_into().map_err(|_| "the grant holds no 32-byte seed".to_string())?;
    buf.iter_mut().for_each(|b| *b = 0);
    Ok(out)
}

/// What a sibling signs for the relay with the host's proof key: this VM's attested transport key, its instance, the
/// deployment it serves, over the relay's nonce.
pub fn sibling_digest(nonce: &[u8; 32], transport_spki: &[u8], instance_id: &[u8; 32], deployment: &[u8; 32]) -> [u8; 32] {
    Sha256::new()
        .chain_update(SIBLING_DOMAIN)
        .chain_update(nonce)
        .chain_update(Sha256::digest(transport_spki))
        .chain_update(instance_id)
        .chain_update(deployment)
        .finalize()
        .into()
}

/// A recoverable secp256k1 signature (r || s || v, low s, v = 27 + recovery id) over a 32-byte digest with the proof key.
pub fn sign_digest(seed: &[u8; 32], digest: &[u8; 32]) -> Option<[u8; 65]> {
    use k256::ecdsa::RecoveryId;
    let key = crate::proof::key_from_seed(seed);
    let (mut sig, mut rid) = key.sign_prehash_recoverable(digest).ok()?;
    if let Some(low) = sig.normalize_s() {
        sig = low;
        rid = RecoveryId::new(!rid.is_y_odd(), rid.is_x_reduced());
    }
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = 27 + rid.to_byte();
    Some(out)
}

/// Length-prefixed certificates (u32 little-endian length, then the DER), as the payload hands chains over.
pub fn split_chain(b: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let mut out = Vec::new();
    let mut o = 0;
    while o < b.len() {
        if o + 4 > b.len() {
            return Err("truncated chain".into());
        }
        let n = u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) as usize;
        o += 4;
        if n == 0 || o + n > b.len() || out.len() >= 8 {
            return Err("malformed chain".into());
        }
        out.push(b[o..o + n].to_vec());
        o += n;
    }
    Ok(out)
}

// ---- the payload's C ABI ----
unsafe fn a32(p: *const u8) -> Option<[u8; 32]> {
    if p.is_null() {
        return None;
    }
    let mut a = [0u8; 32];
    std::ptr::copy_nonoverlapping(p, a.as_mut_ptr(), 32);
    Some(a)
}
unsafe fn put_err(err: *mut std::ffi::c_char, cap: usize, s: &str) {
    if err.is_null() || cap == 0 {
        return;
    }
    let b = s.as_bytes();
    let n = b.len().min(cap - 1);
    std::ptr::copy_nonoverlapping(b.as_ptr(), err as *mut u8, n);
    *err.add(n) = 0;
}

/// sha256(REQUEST_DOMAIN || nonce || eph_pub) into out (32): 0, or -1.
#[no_mangle]
pub unsafe extern "C" fn pvmrt_keygrant_challenge(nonce: *const u8, eph_pub: *const u8, out: *mut u8) -> i32 {
    let (Some(n), Some(e), false) = (a32(nonce), a32(eph_pub), out.is_null()) else { return -1 };
    std::ptr::copy_nonoverlapping(challenge(&n, &e).as_ptr(), out, 32);
    0
}

/// The donor's grant (issue) into out: its length (76), or -1 with the reason in err. Chains are length-prefixed (split_chain).
#[no_mangle]
pub unsafe extern "C" fn pvmrt_keygrant_issue(req_chain: *const u8, req_len: usize, nonce: *const u8, eph_pub: *const u8, own_chain: *const u8, own_len: usize,
                                              seed: *const u8, out: *mut u8, cap: usize, err: *mut std::ffi::c_char, errcap: usize) -> isize {
    let (Some(n), Some(e), Some(s)) = (a32(nonce), a32(eph_pub), a32(seed)) else { put_err(err, errcap, "null argument"); return -1 };
    if req_chain.is_null() || own_chain.is_null() || out.is_null() {
        put_err(err, errcap, "null argument");
        return -1;
    }
    let r = (|| {
        let rc = split_chain(std::slice::from_raw_parts(req_chain, req_len))?;
        let oc = split_chain(std::slice::from_raw_parts(own_chain, own_len))?;
        issue(&rc, &n, &e, &oc, &s, &avf::google_roots())
    })();
    match r {
        Ok(g) if g.len() <= cap => {
            std::ptr::copy_nonoverlapping(g.as_ptr(), out, g.len());
            g.len() as isize
        }
        Ok(_) => {
            put_err(err, errcap, "the grant does not fit");
            -1
        }
        Err(m) => {
            put_err(err, errcap, &m);
            -1
        }
    }
}

/// The requester's open: the seed into out (32), 0, or -1 with the reason in err.
#[no_mangle]
pub unsafe extern "C" fn pvmrt_keygrant_open(eph_secret: *const u8, nonce: *const u8, grant: *const u8, len: usize, out: *mut u8,
                                             err: *mut std::ffi::c_char, errcap: usize) -> i32 {
    let (Some(k), Some(n), false, false) = (a32(eph_secret), a32(nonce), grant.is_null(), out.is_null()) else { put_err(err, errcap, "null argument"); return -1 };
    match open(&k, &n, std::slice::from_raw_parts(grant, len)) {
        Ok(s) => {
            std::ptr::copy_nonoverlapping(s.as_ptr(), out, 32);
            0
        }
        Err(m) => {
            put_err(err, errcap, &m);
            -1
        }
    }
}

/// The sibling statement's signature (65 bytes) by the proof key: 0, or -1.
#[no_mangle]
pub unsafe extern "C" fn pvmrt_sibling_sign(seed: *const u8, nonce: *const u8, spki: *const u8, spki_len: usize, instance_id: *const u8, deployment: *const u8,
                                            out65: *mut u8) -> i32 {
    let (Some(s), Some(n), Some(i), Some(d), false, false) = (a32(seed), a32(nonce), a32(instance_id), a32(deployment), spki.is_null(), out65.is_null()) else { return -1 };
    match sign_digest(&s, &sibling_digest(&n, std::slice::from_raw_parts(spki, spki_len), &i, &d)) {
        Some(sig) => {
            std::ptr::copy_nonoverlapping(sig.as_ptr(), out65, 65);
            0
        }
        None => -1,
    }
}
