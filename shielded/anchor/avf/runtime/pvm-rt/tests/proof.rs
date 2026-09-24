// The lease proof key's bytes (src/proof.rs, PROOF-KEY.md) against an INDEPENDENT implementation: tests/proof-vectors.json
// was made with viem (privateKeyToAccount, hashTypedData, signTypedData). The address, the EIP-712 digest and the 65-byte
// signature must equal viem's exactly -- RFC 6979 on both sides makes the signature deterministic, so a byte difference is
// a real difference, not randomness. Seeds 2 and 3 (all 0xff, all 0) exercise the SHA-256 retry rule for an out-of-range seed.
use pvm_rt::proof::{address, digest, key_from_seed, sign, Checkpoint};

fn unhex(s: &str) -> Vec<u8> {
    let s = s.trim_start_matches("0x");
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }
fn field<'a>(obj: &'a str, key: &str) -> &'a str {
    let i = obj.find(&format!("\"{key}\":")).unwrap_or_else(|| panic!("no {key}")) + key.len() + 3;
    let rest = obj[i..].trim_start();
    if let Some(r) = rest.strip_prefix('"') { &r[..r.find('"').unwrap()] } else { &rest[..rest.find([',', '\n', '}']).unwrap()] }
}
fn a<const N: usize>(s: &str) -> [u8; N] { unhex(s).try_into().unwrap() }

#[test]
fn matches_viem_on_every_vector() {
    let json = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/proof-vectors.json")).unwrap();
    let objs: Vec<&str> = json.split("\"seed\":").skip(1).collect();
    assert_eq!(objs.len(), 3, "three vectors");
    for (i, o) in objs.iter().enumerate() {
        let o = &format!("\"seed\":{o}");
        let key = key_from_seed(&a::<32>(field(o, "seed")));
        assert_eq!(format!("0x{}", hex(&address(&key))), field(o, "address"), "vector {i}: address");
        let (pot, id, eid, op, ah) = (a::<20>(field(o, "proofOfTime")), a::<32>(field(o, "id")), a::<32>(field(o, "enclaveId")), a::<20>(field(o, "operator")), a::<32>(field(o, "anchorHash")));
        let c = Checkpoint { chain_id: field(o, "chainId").parse().unwrap(), proof_of_time: &pot, id: &id, enclave_id: &eid, operator: &op,
                             upto: field(o, "upto").parse().unwrap(), anchor_block: field(o, "anchorBlock").parse().unwrap(), anchor_hash: &ah };
        assert_eq!(format!("0x{}", hex(&digest(&c))), field(o, "digest"), "vector {i}: the EIP-712 digest");
        let (sig, d) = sign(&key, &c).unwrap();
        assert_eq!(format!("0x{}", hex(&d)), field(o, "digest"));
        assert_eq!(format!("0x{}", hex(&sig)), field(o, "sig"), "vector {i}: the signature, byte for byte");
        assert!(sig[64] == 27 || sig[64] == 28, "v is 27 or 28");
        // low s: the contract refuses s > n/2
        let half: [u8; 32] = a("7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");
        assert!(sig[32..64] <= half[..], "vector {i}: s is low");
    }
}

#[test]
fn another_field_is_another_signature() {
    let key = key_from_seed(&[7u8; 32]);
    let (pot, id, eid, op, ah) = ([1u8; 20], [2u8; 32], [3u8; 32], [4u8; 20], [5u8; 32]);
    let base = Checkpoint { chain_id: 8453, proof_of_time: &pot, id: &id, enclave_id: &eid, operator: &op, upto: 100, anchor_block: 9, anchor_hash: &ah };
    let d0 = digest(&base);
    let id2 = [9u8; 32];
    let pot2 = [8u8; 20];
    for (what, c) in [("another deployment", Checkpoint { id: &id2, ..base }), ("another chain", Checkpoint { chain_id: 1, ..base }),
                      ("another contract", Checkpoint { proof_of_time: &pot2, ..base }), ("another upto", Checkpoint { upto: 101, ..base })] {
        assert_ne!(digest(&c), d0, "{what} changes the digest");
    }
    assert_eq!(sign(&key, &base).unwrap().0, sign(&key, &base).unwrap().0, "deterministic (RFC 6979)");
}
