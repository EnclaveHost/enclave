//! Offline tests: maintained `BlockHandler::block_valid` plus this crate's
//! object round trip, offline verifier and store budget.

use std::time::{SystemTime, UNIX_EPOCH};

use alloy_consensus::{Block, BlockBody, EMPTY_OMMER_ROOT_HASH, Header, proofs};
use alloy_eips::eip7685::EMPTY_REQUESTS_HASH;
use alloy_primitives::{Address, B256, Signature, U256, address};
use alloy_rpc_types_engine::ExecutionPayloadV3;
use alloy_signer::SignerSync;
use alloy_signer_local::PrivateKeySigner;
use base_common_chains::ChainConfig;
use base_common_consensus::BaseTxEnvelope;
use base_common_genesis::RollupConfig;
use base_common_rpc_types_engine::{
    BaseExecutionPayload, BaseExecutionPayloadV4, NetworkPayloadEnvelope, PayloadHash,
};
use base_consensus_gossip::{BlockHandler, BlockInvalidError};
use enclave_base_head_listener::{
    HeadRecord, ObjectError, ObjectStore, SCHEMA, StoreOutcome, encode_object, object_sha256,
    verify_object,
};

/// A block number well before the Denim activation block, so the Denim time
/// schedule does not apply regardless of the wall clock.
const TEST_BLOCK: u64 = 50_000_000;
const BASE_SEPOLIA: u64 = 84532;

fn mainnet() -> RollupConfig {
    ChainConfig::mainnet().rollup_config()
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
}

fn key() -> PrivateKeySigner {
    PrivateKeySigner::from_bytes(&B256::repeat_byte(0x11)).unwrap()
}

fn test_block(timestamp: u64) -> Block<BaseTxEnvelope> {
    let header = Header {
        parent_hash: B256::repeat_byte(1),
        ommers_hash: EMPTY_OMMER_ROOT_HASH,
        beneficiary: Address::repeat_byte(2),
        state_root: B256::repeat_byte(3),
        transactions_root: proofs::calculate_transaction_root::<BaseTxEnvelope>(&[]),
        receipts_root: B256::repeat_byte(4),
        number: TEST_BLOCK,
        gas_limit: 30_000_000,
        timestamp,
        mix_hash: B256::repeat_byte(5),
        base_fee_per_gas: Some(1_000_000),
        withdrawals_root: Some(B256::repeat_byte(6)),
        blob_gas_used: Some(0),
        excess_blob_gas: Some(0),
        parent_beacon_block_root: Some(B256::repeat_byte(7)),
        requests_hash: Some(EMPTY_REQUESTS_HASH),
        ..Default::default()
    };
    let mut body = BlockBody::default();
    body.withdrawals = Some(Default::default());
    Block { header, body }
}

/// Builds wire bytes signed for `chain_id`, using only maintained encoders.
fn signed_object(signer: &PrivateKeySigner, chain_id: u64, timestamp: u64) -> Vec<u8> {
    let block = test_block(timestamp);
    let v3 = ExecutionPayloadV3::from_block_slow(&block);
    let v4 = BaseExecutionPayloadV4::from_v3_with_withdrawals_root(
        v3,
        block.header.withdrawals_root.unwrap(),
    );
    let mut envelope = NetworkPayloadEnvelope {
        payload: BaseExecutionPayload::V4(v4),
        signature: Signature::new(U256::from(1), U256::from(1), false),
        payload_hash: PayloadHash(B256::ZERO),
        parent_beacon_block_root: block.header.parent_beacon_block_root,
    };
    let unsigned = envelope.encode_v4().unwrap();
    let decoded = NetworkPayloadEnvelope::decode_v4(&unsigned).unwrap();
    let msg = decoded.payload_hash.signature_message(chain_id);
    envelope.signature = signer.sign_hash_sync(&msg).unwrap();
    envelope.encode_v4().unwrap()
}

fn handler(signer: Address, config: RollupConfig) -> BlockHandler {
    let (_tx, rx) = tokio::sync::watch::channel(signer);
    BlockHandler::new(config, rx)
}

#[test]
fn pinned_chain_config_matches_audit() {
    let chain = ChainConfig::mainnet();
    assert_eq!(chain.chain_id, 8453);
    assert_eq!(chain.unsafe_block_signer, Some(address!("Af6E19BE0F9cE7f8afd49a1824851023A8249e8a")));
    assert_eq!(chain.cobalt_timestamp, Some(1_790_791_200));
    assert_eq!(chain.denim_timestamp, Some(1_793_901_600));
    assert_eq!(chain.bootnodes.consensus.len(), 5);
}

#[test]
fn accepts_valid_v4_and_object_round_trips() {
    let signer = key();
    let bytes = signed_object(&signer, 8453, now());
    let envelope = NetworkPayloadEnvelope::decode_v4(&bytes).unwrap();

    let mut handler = handler(signer.address(), mainnet());
    handler.block_valid(&envelope).expect("maintained validation accepts");

    // The stored object is exactly the maintained re-encoding of the accepted envelope.
    let object = encode_object(&envelope).unwrap();
    assert_eq!(object, bytes);
    let verified = verify_object(&object, &mainnet(), signer.address()).unwrap();
    assert_eq!(verified, envelope);

    let record = HeadRecord::new(&envelope, 8453, signer.address(), &object, 1);
    assert_eq!(record.schema, SCHEMA);
    assert_eq!((record.tier, record.finality, record.kind), ("unsafe", "none", "head"));
    assert_eq!(record.number, TEST_BLOCK);
    assert_eq!(record.hash, envelope.payload.block_hash());
    assert_eq!(record.state_root, B256::repeat_byte(3));
    assert_eq!(record.object_sha256, object_sha256(&object));
    let json = serde_json::to_value(&record).unwrap();
    for key in ["schema", "type", "tier", "finality", "chainId", "number", "hash", "parentHash",
        "stateRoot", "receiptsRoot", "timestamp", "txCount", "signer", "payloadVersion",
        "objectEncoding", "objectSha256", "objectBytes", "receivedUnixMs"]
    {
        assert!(json.get(key).is_some(), "missing {key}");
    }
}

#[test]
fn rejects_wrong_signer() {
    let signer = key();
    let bytes = signed_object(&signer, 8453, now());
    let envelope = NetworkPayloadEnvelope::decode_v4(&bytes).unwrap();
    let other = Address::repeat_byte(0x42);

    let mut handler = handler(other, mainnet());
    assert!(matches!(handler.block_valid(&envelope), Err(BlockInvalidError::Signer { .. })));
    assert!(matches!(verify_object(&bytes, &mainnet(), other), Err(ObjectError::Signer { .. })));
}

#[test]
fn rejects_wrong_chain_signature_domain() {
    let signer = key();
    let bytes = signed_object(&signer, BASE_SEPOLIA, now());
    let envelope = NetworkPayloadEnvelope::decode_v4(&bytes).unwrap();

    let mut handler = handler(signer.address(), mainnet());
    assert!(matches!(handler.block_valid(&envelope), Err(BlockInvalidError::Signer { .. })));
    assert!(matches!(
        verify_object(&bytes, &mainnet(), signer.address()),
        Err(ObjectError::Signer { .. })
    ));
}

#[test]
fn rejects_stale_and_future_at_receipt() {
    let signer = key();
    for timestamp in [now() - 120, now() + 30] {
        let bytes = signed_object(&signer, 8453, timestamp);
        let envelope = NetworkPayloadEnvelope::decode_v4(&bytes).unwrap();
        let mut handler = handler(signer.address(), mainnet());
        assert!(matches!(handler.block_valid(&envelope), Err(BlockInvalidError::Timestamp { .. })));
        // The offline verifier intentionally has no wall-clock window: an old
        // object stays verifiable as "signed by the pinned key", never as fresh.
        assert!(verify_object(&bytes, &mainnet(), signer.address()).is_ok());
    }
}

#[test]
fn rejects_tampered_payload() {
    let signer = key();
    let bytes = signed_object(&signer, 8453, now());
    let mut envelope = NetworkPayloadEnvelope::decode_v4(&bytes).unwrap();
    if let BaseExecutionPayload::V4(v4) = &mut envelope.payload {
        v4.payload_inner.payload_inner.payload_inner.state_root = B256::repeat_byte(9);
    }
    let tampered = envelope.encode_v4().unwrap();
    let decoded = NetworkPayloadEnvelope::decode_v4(&tampered).unwrap();

    let mut handler = handler(signer.address(), mainnet());
    assert!(handler.block_valid(&decoded).is_err());
    assert!(verify_object(&tampered, &mainnet(), signer.address()).is_err());

    let mut garbage = bytes;
    garbage.truncate(garbage.len() / 2);
    assert!(verify_object(&garbage, &mainnet(), signer.address()).is_err());
}

#[test]
fn object_store_is_write_once_and_budgeted() {
    let dir = tempfile::tempdir().unwrap();
    let objects = dir.path().join("objects");
    let mut store = ObjectStore::create(&objects, 100).unwrap();
    let (sha, outcome) = store.put(&[1u8; 60]).unwrap().unwrap();
    assert_eq!(outcome, StoreOutcome::Written);
    assert_eq!(std::fs::read(store.path_for(&sha)).unwrap(), vec![1u8; 60]);
    assert_eq!(store.put(&[1u8; 60]).unwrap().unwrap().1, StoreOutcome::AlreadyPresent);
    assert!(store.put(&[2u8; 60]).unwrap().is_none(), "budget must refuse");
    assert!(!store.charge(41));
    assert!(store.charge(40));
    assert_eq!(store.used(), 100);
    assert!(ObjectStore::create(&objects, 100).is_err(), "non-empty dir refused");
}

#[test]
fn dial_queue_dedups_and_respects_caps() {
    use std::time::{Duration, Instant};
    use enclave_base_head_listener::DialQueue;

    let t0 = Instant::now();
    let mut q: DialQueue<u32, &str> = DialQueue::new(4, 3, 2, Duration::from_secs(30));
    assert!(q.offer(1, "boot"));
    assert!(!q.offer(1, "boot-again"), "duplicate key refused");
    assert!(q.offer(2, "b"));
    assert!(q.offer(3, "c"));
    assert!(q.offer(4, "d"));
    assert!(!q.offer(5, "e"), "queue cap");
    assert_eq!((q.unique(), q.duplicates(), q.overflow()), (4, 1, 1));

    // FIFO: the first offered (bootnode) is dialed first; in-flight cap 2.
    assert_eq!(q.next_dial(0, 20, t0), Some((1, "boot")));
    assert_eq!(q.next_dial(0, 20, t0).map(|d| d.0), Some(2));
    assert_eq!(q.next_dial(0, 20, t0), None, "in-flight cap");
    q.resolved(&1);
    // Peer cap: connected + in-flight must stay below max_peers.
    assert_eq!(q.next_dial(1, 2, t0), None, "peer cap");
    assert_eq!(q.next_dial(0, 20, t0).map(|d| d.0), Some(3));
    // Total dial cap 3 reached even after everything resolves.
    q.resolved(&2);
    q.resolved(&3);
    assert_eq!(q.next_dial(0, 20, t0), None, "total dial cap");
    assert_eq!(q.dials(), 3);
    assert_eq!(q.pending(), 1);
}

#[test]
fn dial_queue_expires_silently_dropped_dials() {
    use std::time::{Duration, Instant};
    use enclave_base_head_listener::DialQueue;

    let t0 = Instant::now();
    let mut q: DialQueue<u32, ()> = DialQueue::new(8, 10, 1, Duration::from_secs(30));
    q.offer(1, ());
    q.offer(2, ());
    assert!(q.next_dial(0, 20, t0).is_some());
    assert!(q.next_dial(0, 20, t0 + Duration::from_secs(29)).is_none());
    assert_eq!(q.next_dial(0, 20, t0 + Duration::from_secs(31)).map(|d| d.0), Some(2));
}

#[test]
fn dial_errors_classify_without_addresses() {
    use enclave_base_head_listener::classify_dial_error;
    assert_eq!(
        classify_dial_error("Failed to negotiate transport protocol(s): [(/ip4/1.2.3.4/tcp/9222: Connection refused (os error 111))]"),
        "transport-refused"
    );
    assert_eq!(classify_dial_error("Dial error: Connection timed out"), "transport-timeout");
    assert_eq!(classify_dial_error("Dial error: dial was aborted."), "aborted");
    assert_eq!(classify_dial_error("Dial error: Denied { cause: .. }"), "denied-local-limit");
    assert_eq!(classify_dial_error("something new"), "other");
}

/// A real Base mainnet v4 envelope captured by the 2026-10-23T01:37Z live run
/// (accepted by `block_valid`, RPC-corroborated), stored as hex text.
const REAL_OBJECT_HEX: &str = include_str!("fixtures/base-mainnet-52965074.v4.snappy.hex");
const REAL_HEAD_JSON: &str = include_str!("fixtures/base-mainnet-52965074.head.json");
const MAINNET_SIGNER: Address = address!("Af6E19BE0F9cE7f8afd49a1824851023A8249e8a");

#[test]
fn real_mainnet_object_verifies_and_matches_its_record() {
    let bytes = hex::decode(REAL_OBJECT_HEX.trim()).unwrap();
    let head: serde_json::Value = serde_json::from_str(REAL_HEAD_JSON).unwrap();
    assert_eq!(object_sha256(&bytes), head["objectSha256"].as_str().unwrap());

    let envelope = verify_object(&bytes, &mainnet(), MAINNET_SIGNER).expect("pinned signer verifies");
    let record = HeadRecord::new(&envelope, 8453, MAINNET_SIGNER, &bytes, 0);
    let json = serde_json::to_value(&record).unwrap();
    for key in ["number", "hash", "parentHash", "stateRoot", "receiptsRoot", "timestamp", "txCount"] {
        assert_eq!(json[key], head[key], "{key}");
    }
    assert_eq!(encode_object(&envelope).unwrap(), bytes, "canonical re-encoding");
}

#[test]
fn real_mainnet_object_rejections() {
    let bytes = hex::decode(REAL_OBJECT_HEX.trim()).unwrap();
    // Wrong pinned signer.
    assert!(matches!(
        verify_object(&bytes, &mainnet(), Address::repeat_byte(0x42)),
        Err(ObjectError::Signer { .. })
    ));
    // Wrong chain domain: the same bytes checked as Base Sepolia recover another signer.
    let sepolia = ChainConfig::by_chain_id(BASE_SEPOLIA).unwrap().rollup_config();
    assert!(matches!(verify_object(&bytes, &sepolia, MAINNET_SIGNER), Err(ObjectError::Signer { .. })));
    // Stale at receipt: the maintained gossip validator refuses the genuine block now.
    let envelope = NetworkPayloadEnvelope::decode_v4(&bytes).unwrap();
    let mut handler = handler(MAINNET_SIGNER, mainnet());
    assert!(matches!(handler.block_valid(&envelope), Err(BlockInvalidError::Timestamp { .. })));
    // Tampered payload field, re-encoded without re-signing.
    let mut tampered = envelope;
    if let BaseExecutionPayload::V4(v4) = &mut tampered.payload {
        v4.payload_inner.payload_inner.payload_inner.gas_used ^= 1;
    }
    let tampered = tampered.encode_v4().unwrap();
    assert!(verify_object(&tampered, &mainnet(), MAINNET_SIGNER).is_err());
}
