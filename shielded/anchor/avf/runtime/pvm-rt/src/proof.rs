//! The lease proof key (shielded/anchor/avf/PROOF-KEY.md): the secp256k1 key a pVM runner's registry entry publishes as its
//! `proofKey`, and the ONE thing it signs -- an `EnclaveProofOfTime` checkpoint (contracts/EnclaveProofOfTime.sol), built
//! here from typed fields:
//!   domain    = EIP712Domain(name "EnclaveProofOfTime", version "1", chainId, verifyingContract)
//!   message   = ProofOfTime(bytes32 id, bytes32 enclaveId, address operator, uint64 upto, uint64 anchorBlock, bytes32 anchorHash)
//!   digest    = keccak256("\x19\x01" || domainSeparator || hashStruct(message))
//!   signature = r || s || v, RFC 6979 nonces, s normalized low (the contract's malleability guard), v in {27, 28}
//! There is deliberately NO function that signs a caller's digest: whoever calls this chooses field values, never what is
//! signed. The key is derived from a 32-byte seed the payload takes from AVmPayload_getVmInstanceSecret and never stored:
//! k = seed read big-endian; while k is 0 or >= n, seed = SHA-256(seed). The payload holds the signing POLICY (its pins,
//! app serving, monotonic upto, the rate); this file holds the bytes.
use k256::ecdsa::{RecoveryId, SigningKey};
use sha2::{Digest as _, Sha256};
use sha3::Keccak256;

fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Keccak256::new();
    for p in parts { sha3::Digest::update(&mut h, p); }
    sha3::Digest::finalize(h).into()
}
fn word_u64(v: u64) -> [u8; 32] { let mut w = [0u8; 32]; w[24..].copy_from_slice(&v.to_be_bytes()); w }
fn word_addr(a: &[u8; 20]) -> [u8; 32] { let mut w = [0u8; 32]; w[12..].copy_from_slice(a); w }

/// The signing key for a seed (see the module note for the retry rule).
pub fn key_from_seed(seed: &[u8; 32]) -> SigningKey {
    let mut s = *seed;
    loop {
        if let Ok(k) = SigningKey::from_bytes((&s).into()) { return k; }
        s = Sha256::digest(s).into();
    }
}
/// The key's Ethereum address: keccak256 of the uncompressed public key without its 0x04 prefix, last 20 bytes.
pub fn address(key: &SigningKey) -> [u8; 20] {
    let p = key.verifying_key().to_encoded_point(false);
    let h = keccak(&[&p.as_bytes()[1..]]);
    let mut a = [0u8; 20];
    a.copy_from_slice(&h[12..]);
    a
}
/// The checkpoint's typed fields: the VM's pins (fixed per boot) and the three values each request supplies.
pub struct Checkpoint<'a> {
    pub chain_id: u64, pub proof_of_time: &'a [u8; 20], pub id: &'a [u8; 32], pub enclave_id: &'a [u8; 32], pub operator: &'a [u8; 20],
    pub upto: u64, pub anchor_block: u64, pub anchor_hash: &'a [u8; 32],
}
/// EnclaveProofOfTime.proofDigest, byte for byte.
pub fn digest(c: &Checkpoint) -> [u8; 32] {
    let domain_type = keccak(&[b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"]);
    let domain = keccak(&[&domain_type, &keccak(&[b"EnclaveProofOfTime"]), &keccak(&[b"1"]), &word_u64(c.chain_id), &word_addr(c.proof_of_time)]);
    let proof_type = keccak(&[b"ProofOfTime(bytes32 id,bytes32 enclaveId,address operator,uint64 upto,uint64 anchorBlock,bytes32 anchorHash)"]);
    let st = keccak(&[&proof_type, c.id, c.enclave_id, &word_addr(c.operator), &word_u64(c.upto), &word_u64(c.anchor_block), c.anchor_hash]);
    keccak(&[b"\x19\x01", &domain, &st])
}
/// The 65-byte signature over the checkpoint's digest: r || s || v, s low, v = 27 + recovery id.
pub fn sign(key: &SigningKey, c: &Checkpoint) -> Option<([u8; 65], [u8; 32])> {
    let d = digest(c);
    let (mut sig, mut rid) = key.sign_prehash_recoverable(&d).ok()?;
    if let Some(low) = sig.normalize_s() { sig = low; rid = RecoveryId::new(!rid.is_y_odd(), rid.is_x_reduced()); }
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = 27 + rid.to_byte();
    Some((out, d))
}

// ---- the payload's C ABI (the payload dlsyms these from libpvm_rt.so) ----
unsafe fn arr<const N: usize>(p: *const u8) -> Option<[u8; N]> {
    if p.is_null() { return None; }
    let mut a = [0u8; N];
    std::ptr::copy_nonoverlapping(p, a.as_mut_ptr(), N);
    Some(a)
}
/// The proof key's address for a seed: 0, or -1 on a null pointer.
#[no_mangle]
pub unsafe extern "C" fn pvmrt_pot_address(seed: *const u8, addr_out: *mut u8) -> i32 {
    let (Some(s), false) = (arr::<32>(seed), addr_out.is_null()) else { return -1 };
    let a = address(&key_from_seed(&s));
    std::ptr::copy_nonoverlapping(a.as_ptr(), addr_out, 20);
    0
}
/// One ProofOfTime checkpoint signature (65 bytes) and its digest (32), from typed fields only: 0, or -1.
#[no_mangle]
pub unsafe extern "C" fn pvmrt_pot_sign(seed: *const u8, chain_id: u64, proof_of_time: *const u8, id: *const u8, enclave_id: *const u8,
                                        operator: *const u8, upto: u64, anchor_block: u64, anchor_hash: *const u8,
                                        sig_out: *mut u8, digest_out: *mut u8) -> i32 {
    let (Some(s), Some(pot), Some(id), Some(eid), Some(op), Some(ah)) =
        (arr::<32>(seed), arr::<20>(proof_of_time), arr::<32>(id), arr::<32>(enclave_id), arr::<20>(operator), arr::<32>(anchor_hash)) else { return -1 };
    if sig_out.is_null() || digest_out.is_null() { return -1; }
    let c = Checkpoint { chain_id, proof_of_time: &pot, id: &id, enclave_id: &eid, operator: &op, upto, anchor_block, anchor_hash: &ah };
    let Some((sig, d)) = sign(&key_from_seed(&s), &c) else { return -1 };
    std::ptr::copy_nonoverlapping(sig.as_ptr(), sig_out, 65);
    std::ptr::copy_nonoverlapping(d.as_ptr(), digest_out, 32);
    0
}
