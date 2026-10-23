//! `commitment` mode: maintained verification first, then the exact signed commitment bytes.
//! Real Base mainnet objects captured by the 2026-10-23T01:37Z live run (blocks 52965074..52965076).

use std::process::Command;

use alloy_primitives::{Address, address, keccak256};
use base_common_chains::ChainConfig;
use base_common_genesis::RollupConfig;
use base_common_rpc_types_engine::PayloadHash;
use enclave_base_head_listener::{
    COMMITMENT_SCHEMA, DEFAULT_MAX_COMMITMENT_DATA, MAX_OBJECT_BYTES, ObjectError, object_sha256,
    read_object_bounded, signed_commitment,
};

const SIGNER: Address = address!("Af6E19BE0F9cE7f8afd49a1824851023A8249e8a");
const BLOCKS: [u64; 3] = [52_965_074, 52_965_075, 52_965_076];
const BIN: &str = env!("CARGO_BIN_EXE_enclave-base-head-listener");

fn fixture(n: u64) -> (Vec<u8>, serde_json::Value) {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");
    let hex = std::fs::read_to_string(format!("{dir}/base-mainnet-{n}.v4.snappy.hex")).unwrap();
    let head = std::fs::read_to_string(format!("{dir}/base-mainnet-{n}.head.json")).unwrap();
    (hex::decode(hex.trim()).unwrap(), serde_json::from_str(&head).unwrap())
}

fn mainnet() -> RollupConfig {
    ChainConfig::mainnet().rollup_config()
}

#[test]
fn real_objects_yield_exact_signed_commitments() {
    for n in BLOCKS {
        let (bytes, head) = fixture(n);
        let c = signed_commitment(&bytes, &mainnet(), SIGNER, DEFAULT_MAX_COMMITMENT_DATA).unwrap();
        let json = serde_json::to_value(&c).unwrap();
        for key in ["number", "hash", "parentHash", "stateRoot", "timestamp"] {
            assert_eq!(json[key], head[key], "{n} {key}");
        }
        assert_eq!((c.schema, c.kind, c.tier, c.finality, c.chain_id), (COMMITMENT_SCHEMA, "commitment", "unsafe", "none", 8453));
        assert_eq!(c.object_sha256, head["objectSha256"].as_str().unwrap());
        // Independent recomputation with the maintained helpers: the emitted data hashes to the payload hash and the
        // emitted r/s/parity recover the pinned signer over Base's signature domain for chain 8453.
        let data = hex::decode(c.commitment.data.trim_start_matches("0x")).unwrap();
        assert_eq!(data.len(), c.data_bytes);
        assert_eq!(keccak256(&data), c.data_keccak256);
        let msg = PayloadHash(keccak256(&data)).signature_message(8453);
        let sig = alloy_primitives::Signature::from_scalars_and_parity(
            c.commitment.signature.r, c.commitment.signature.s, c.commitment.signature.y_parity == 1);
        assert_eq!(sig.recover_address_from_prehash(&msg).unwrap(), SIGNER);
        let sepolia = PayloadHash(keccak256(&data)).signature_message(84532);
        assert_ne!(sig.recover_address_from_prehash(&sepolia).unwrap(), SIGNER);
        // data is the whole decompressed envelope minus only the 65-byte signature prefix
        assert_eq!(snap::raw::decompress_len(&bytes).unwrap(), data.len() + 65);
    }
}

#[test]
fn wrong_pin_or_chain_is_refused_before_anything_is_emitted() {
    let (bytes, _) = fixture(52_965_076);
    assert!(matches!(
        signed_commitment(&bytes, &mainnet(), Address::repeat_byte(0x42), DEFAULT_MAX_COMMITMENT_DATA),
        Err(ObjectError::Signer { .. })
    ));
    let sepolia = ChainConfig::by_chain_id(84532).unwrap().rollup_config();
    assert!(matches!(
        signed_commitment(&bytes, &sepolia, SIGNER, DEFAULT_MAX_COMMITMENT_DATA),
        Err(ObjectError::Signer { .. })
    ));
}

#[test]
fn malformed_truncated_and_tampered_objects_are_refused() {
    let (bytes, _) = fixture(52_965_074);
    for cut in [0, 1, 3, 64, bytes.len() / 2, bytes.len() - 1] {
        assert!(signed_commitment(&bytes[..cut], &mainnet(), SIGNER, DEFAULT_MAX_COMMITMENT_DATA).is_err(), "cut {cut}");
    }
    let mut sig_flip = bytes.clone();
    sig_flip[10] ^= 1; // inside the literal that carries the signature's r value
    assert!(signed_commitment(&sig_flip, &mainnet(), SIGNER, DEFAULT_MAX_COMMITMENT_DATA).is_err());
    assert!(signed_commitment(b"not snappy at all", &mainnet(), SIGNER, DEFAULT_MAX_COMMITMENT_DATA).is_err());
}

#[test]
fn oversized_declared_lengths_are_refused_before_decoding() {
    // varint preamble declaring 20 MiB followed by garbage: refused on the preamble alone
    let mut big = vec![0x80, 0x80, 0x80, 0x0a];
    big.extend_from_slice(&[0u8; 64]);
    assert!(matches!(
        signed_commitment(&big, &mainnet(), SIGNER, DEFAULT_MAX_COMMITMENT_DATA),
        Err(ObjectError::DeclaredLength { declared: 20_971_520, .. })
    ));
    // a real object whose data exceeds a smaller cap
    let (bytes, _) = fixture(52_965_075);
    let need = snap::raw::decompress_len(&bytes).unwrap() - 65;
    assert!(matches!(signed_commitment(&bytes, &mainnet(), SIGNER, need - 1), Err(ObjectError::DeclaredLength { .. })));
    assert!(signed_commitment(&bytes, &mainnet(), SIGNER, need).is_ok());
}

#[test]
fn a_different_encoding_of_the_same_envelope_yields_identical_commitment_bytes() {
    // the run-r3 finding: flipping the middle byte of the 52965076 object re-encodes the identical envelope
    let (bytes, _) = fixture(52_965_076);
    let original = signed_commitment(&bytes, &mainnet(), SIGNER, DEFAULT_MAX_COMMITMENT_DATA).unwrap();
    let mut flipped = bytes.clone();
    let mid = flipped.len() / 2;
    flipped[mid] ^= 1;
    let again = signed_commitment(&flipped, &mainnet(), SIGNER, DEFAULT_MAX_COMMITMENT_DATA).unwrap();
    assert_eq!(again.commitment, original.commitment);
    assert_eq!(again.hash, original.hash);
    assert_ne!(again.object_sha256, original.object_sha256);
}

#[test]
fn object_files_over_the_cap_are_refused_unread() {
    let dir = tempfile::tempdir().unwrap();
    let big = dir.path().join("big.v4.snappy");
    let f = std::fs::File::create(&big).unwrap();
    f.set_len(MAX_OBJECT_BYTES + 1).unwrap(); // sparse: nothing is written or read
    assert!(matches!(read_object_bounded(&big, MAX_OBJECT_BYTES), Err(ObjectError::ObjectTooLarge { .. })));
    let (bytes, _) = fixture(52_965_074);
    let ok = dir.path().join("ok.v4.snappy");
    std::fs::write(&ok, &bytes).unwrap();
    assert_eq!(object_sha256(&read_object_bounded(&ok, MAX_OBJECT_BYTES).unwrap()), object_sha256(&bytes));
}

fn run(args: &[&str]) -> (i32, serde_json::Value, usize) {
    let out = Command::new(BIN).args(args).output().unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    assert_eq!(text.lines().count(), 1, "exactly one JSON line");
    (out.status.code().unwrap(), serde_json::from_str(text.trim()).unwrap(), text.len())
}

#[test]
fn cli_emits_one_bounded_line_and_fails_closed() {
    let dir = tempfile::tempdir().unwrap();
    let (bytes, head) = fixture(52_965_074);
    let file = dir.path().join("o.v4.snappy");
    std::fs::write(&file, &bytes).unwrap();
    let f = file.to_str().unwrap();
    let pin = "0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a";
    let (code, v, len) = run(&["commitment", "--signer", pin, "--file", f]);
    assert_eq!(code, 0);
    assert_eq!(v["ok"], true);
    assert_eq!(v["hash"], head["hash"]);
    assert!(len <= 2 * v["dataBytes"].as_u64().unwrap() as usize + 1024, "hex output bound");
    let (code, v, _) = run(&["commitment", "--signer", "0x4242424242424242424242424242424242424242", "--file", f]);
    assert_eq!((code, v["ok"].as_bool()), (1, Some(false)));
    assert!(v.get("commitment").is_none(), "nothing emitted on refusal");
    let (code, v, _) = run(&["commitment", "--signer", pin, "--file", f, "--max-data-bytes", "1000"]);
    assert_eq!((code, v["ok"].as_bool()), (1, Some(false)));
    let (code, _, _) = run(&["commitment", "--signer", pin, "--file", f, "--max-data-bytes", "99999999"]);
    assert_eq!(code, 1);
    let (code, _, _) = run(&["commitment", "--signer", pin, "--file", "/nonexistent/x"]);
    assert_eq!(code, 1);
}
