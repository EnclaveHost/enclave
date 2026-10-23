//! Validated Base unsafe-head records and signed-envelope objects.
//!
//! Every head this crate emits was accepted by `base-consensus-gossip`'s
//! maintained `BlockHandler::block_valid` (base/base 5476069f): wall-clock
//! window, sequencer signature against the pinned signer, recomputed block hash,
//! version-specific fields and the Base time schedule. A record is the
//! **unsafe** tier only: the sequencer key signed it. It is not L1-derived,
//! not finalized and not proof of availability of any state.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use alloy_consensus::Block;
use alloy_eips::eip7685::EMPTY_REQUESTS_HASH;
use alloy_primitives::{Address, B256, keccak256};
use base_common_consensus::BaseTxEnvelope;
use base_common_genesis::RollupConfig;
use base_common_rpc_types_engine::{BaseExecutionPayload, NetworkPayloadEnvelope};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Output contract identifier. Bump on any incompatible field change.
pub const SCHEMA: &str = "enclave-base-unsafe-head/v1";

/// Object encoding: `NetworkPayloadEnvelope::encode_v4` (snappy, signature ‖
/// parent beacon root ‖ SSZ payload), the Base v4 gossip wire format.
pub const OBJECT_ENCODING: &str = "base-network-payload-envelope-v4-snappy";

/// The base/base commit the validation logic comes from.
pub const BASE_SOURCE_COMMIT: &str = "5476069f1eb74a56bccb56fdefd4b4bb0e3cda42";

/// Errors from object handling.
#[derive(Debug, thiserror::Error)]
pub enum ObjectError {
    /// Only v4 (post-Isthmus) payloads are stored.
    #[error("unsupported payload version {0}")]
    UnsupportedVersion(&'static str),
    /// Encoding through the maintained encoder failed.
    #[error("encode failed: {0}")]
    Encode(String),
    /// Decoding through the maintained decoder failed.
    #[error("decode failed: {0}")]
    Decode(String),
    /// The recovered signer is not the pinned signer.
    #[error("signer mismatch: expected {expected}, recovered {recovered}")]
    Signer {
        /// Pinned signer.
        expected: Address,
        /// Recovered signer.
        recovered: Address,
    },
    /// The signature could not be recovered.
    #[error("signature recovery failed")]
    Signature,
    /// The payload does not hash to its claimed block hash.
    #[error("block hash mismatch: claimed {claimed}, computed {computed}")]
    BlockHash {
        /// Claimed block hash.
        claimed: B256,
        /// Recomputed block hash.
        computed: B256,
    },
    /// The payload could not be converted into a block.
    #[error("invalid block: {0}")]
    InvalidBlock(String),
    /// Writing the object failed.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// The object file is larger than the cap; it was not read.
    #[error("object file is {size} bytes, over the {max}-byte cap")]
    ObjectTooLarge {
        /// File size.
        size: u64,
        /// Cap.
        max: u64,
    },
    /// The snappy preamble declares a payload outside the accepted range; nothing was allocated for it.
    #[error("declared envelope length {declared} is outside 97..={max}")]
    DeclaredLength {
        /// Declared decompressed length.
        declared: usize,
        /// Largest accepted envelope (signature + commitment data cap).
        max: usize,
    },
    /// The emitted bytes are not provably the bytes that were verified.
    #[error("commitment bytes do not bind to the verified envelope: {0}")]
    Binding(&'static str),
}

/// Object files above this are refused unread: base-consensus-gossip's MAX_GOSSIP_SIZE (10 MiB).
pub const MAX_OBJECT_BYTES: u64 = 10 << 20;
/// Default cap on commitment `data` bytes: op-head-relay.mjs MAX_DATA (4 MiB).
pub const DEFAULT_MAX_COMMITMENT_DATA: usize = 4 << 20;
/// Hard ceiling for `--max-data-bytes`: base MAX_DECOMPRESSED_ENVELOPE_BYTES (10 MiB) minus the signature.
pub const MAX_COMMITMENT_DATA_CEILING: usize = (10 << 20) - SIGNATURE_BYTES;
/// Envelope prefix: 65-byte signature (r ‖ s ‖ v).
pub const SIGNATURE_BYTES: usize = 65;
/// Schema of [`SignedCommitment`].
pub const COMMITMENT_SCHEMA: &str = "enclave-base-signed-commitment/v1";

/// Reads an object file only if its size is within `max`, and never more than `max` bytes.
pub fn read_object_bounded(path: &Path, max: u64) -> Result<Vec<u8>, ObjectError> {
    use std::io::Read;
    let file = fs::File::open(path)?;
    let size = file.metadata()?.len();
    if size > max {
        return Err(ObjectError::ObjectTooLarge { size, max });
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(ObjectError::ObjectTooLarge { size: bytes.len() as u64, max });
    }
    Ok(bytes)
}

/// Helios `SequencerCommitment` signature fields, taken from the original envelope bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitmentSignature {
    /// Bytes 0..32 of the envelope.
    pub r: B256,
    /// Bytes 32..64 of the envelope.
    pub s: B256,
    /// Parity of the verified signature (0 or 1).
    pub y_parity: u8,
}

/// Helios `SequencerCommitment`: `data` = the original decompressed envelope after the signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommitmentBody {
    /// `0x`-hex of parentBeaconRoot ‖ SSZ payload, exactly as signed.
    pub data: String,
    /// Signature over `keccak256(0^32 ‖ chainId ‖ keccak256(data))`.
    pub signature: CommitmentSignature,
}

/// Output of `commitment`: verified metadata plus the exact signed commitment bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedCommitment {
    /// Always [`COMMITMENT_SCHEMA`].
    pub schema: &'static str,
    /// Always `"commitment"`.
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// Always `"unsafe"`.
    pub tier: &'static str,
    /// Always `"none"`.
    pub finality: &'static str,
    /// Chain id of the signature domain that was checked.
    pub chain_id: u64,
    /// The pinned signer the signature recovered to.
    pub signer: Address,
    /// Verified block number.
    pub number: u64,
    /// Verified (recomputed) block hash.
    pub hash: B256,
    /// Parent hash.
    pub parent_hash: B256,
    /// State root.
    pub state_root: B256,
    /// Block timestamp (seconds).
    pub timestamp: u64,
    /// Payload version (always `"v4"`).
    pub payload_version: &'static str,
    /// sha256 of the object bytes that were read.
    pub object_sha256: String,
    /// keccak256 of `data` (equals the maintained decoder's payload hash).
    pub data_keccak256: B256,
    /// Length of `data` in bytes.
    pub data_bytes: usize,
    /// The commitment to hand to the Helios relay.
    pub commitment: CommitmentBody,
}

/// Verifies an object with the maintained checks and only then returns its exact signed commitment bytes.
///
/// Order: (1) the snappy preamble's declared length (maintained `snap::raw::decompress_len`, no allocation) must fit
/// `max_data`; (2) [`verify_object`] (maintained decode, signer, chain domain, block hash) must pass; (3) the same bytes
/// are decompressed once more with the maintained `snap` decoder into a buffer of exactly the declared length; (4) the
/// data after the 65-byte signature must hash to the verified envelope's payload hash and the raw r/s/parity must equal
/// the verified signature. Nothing is reconstructed or re-encoded.
pub fn signed_commitment(
    bytes: &[u8],
    rollup_config: &RollupConfig,
    signer: Address,
    max_data: usize,
) -> Result<SignedCommitment, ObjectError> {
    let max = SIGNATURE_BYTES + max_data.min(MAX_COMMITMENT_DATA_CEILING);
    let declared = snap::raw::decompress_len(bytes).map_err(|e| ObjectError::Decode(e.to_string()))?;
    if declared < SIGNATURE_BYTES + 32 || declared > max {
        return Err(ObjectError::DeclaredLength { declared, max });
    }
    let envelope = verify_object(bytes, rollup_config, signer)?;
    let mut raw = vec![0u8; declared];
    let written = snap::raw::Decoder::new()
        .decompress(bytes, &mut raw)
        .map_err(|e| ObjectError::Decode(e.to_string()))?;
    if written != declared {
        return Err(ObjectError::Binding("decompressed length differs from the declared length"));
    }
    let (sig, data) = raw.split_at(SIGNATURE_BYTES);
    if keccak256(data) != envelope.payload_hash.0 {
        return Err(ObjectError::Binding("data does not hash to the verified payload hash"));
    }
    let r = B256::from_slice(&sig[..32]);
    let s = B256::from_slice(&sig[32..64]);
    if r != B256::from(envelope.signature.r().to_be_bytes::<32>())
        || s != B256::from(envelope.signature.s().to_be_bytes::<32>())
    {
        return Err(ObjectError::Binding("raw r/s differ from the verified signature"));
    }
    let v1 = envelope.payload.as_v1();
    Ok(SignedCommitment {
        schema: COMMITMENT_SCHEMA,
        kind: "commitment",
        tier: "unsafe",
        finality: "none",
        chain_id: rollup_config.l2_chain_id.id(),
        signer,
        number: v1.block_number,
        hash: v1.block_hash,
        parent_hash: v1.parent_hash,
        state_root: v1.state_root,
        timestamp: v1.timestamp,
        payload_version: payload_version(&envelope.payload),
        object_sha256: object_sha256(bytes),
        data_keccak256: envelope.payload_hash.0,
        data_bytes: data.len(),
        commitment: CommitmentBody {
            data: format!("0x{}", hex::encode(data)),
            signature: CommitmentSignature { r, s, y_parity: u8::from(envelope.signature.v()) },
        },
    })
}

/// Returns the version label of a payload.
pub const fn payload_version(payload: &BaseExecutionPayload) -> &'static str {
    match payload {
        BaseExecutionPayload::V1(_) => "v1",
        BaseExecutionPayload::V2(_) => "v2",
        BaseExecutionPayload::V3(_) => "v3",
        BaseExecutionPayload::V4(_) => "v4",
    }
}

/// Encodes an accepted envelope into its immutable object bytes.
pub fn encode_object(envelope: &NetworkPayloadEnvelope) -> Result<Vec<u8>, ObjectError> {
    match &envelope.payload {
        BaseExecutionPayload::V4(_) => {
            envelope.encode_v4().map_err(|e| ObjectError::Encode(e.to_string()))
        }
        other => Err(ObjectError::UnsupportedVersion(payload_version(other))),
    }
}

/// Lowercase hex sha256 of object bytes; this is the object's content address.
pub fn object_sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Re-checks a stored object offline against a pinned signer.
///
/// This repeats the signer and block-hash steps of `block_valid`
/// (`crates/consensus/gossip/src/block_validity.rs:184-215` at 5476069f) with the
/// same maintained functions. It deliberately omits the wall-clock window and
/// the seen-block cache, which only make sense at receipt time. It proves "the
/// pinned key signed this payload, and the payload hashes to this block hash";
/// it says nothing about canonicality, finality or freshness.
pub fn verify_object(
    bytes: &[u8],
    rollup_config: &RollupConfig,
    signer: Address,
) -> Result<NetworkPayloadEnvelope, ObjectError> {
    let envelope =
        NetworkPayloadEnvelope::decode_v4(bytes).map_err(|e| ObjectError::Decode(e.to_string()))?;
    let msg = envelope.payload_hash.signature_message(rollup_config.l2_chain_id.id());
    let recovered =
        envelope.signature.recover_address_from_prehash(&msg).map_err(|_| ObjectError::Signature)?;
    if recovered != signer {
        return Err(ObjectError::Signer { expected: signer, recovered });
    }
    let claimed = envelope.payload.block_hash();
    let mut block: Block<BaseTxEnvelope> = envelope
        .payload
        .clone()
        .try_into_block()
        .map_err(|e| ObjectError::InvalidBlock(e.to_string()))?;
    block.header.parent_beacon_block_root = envelope.parent_beacon_block_root;
    if rollup_config.is_isthmus_active(envelope.payload.timestamp()) {
        block.header.requests_hash = Some(EMPTY_REQUESTS_HASH);
    }
    let computed = block.header.hash_slow();
    if computed != claimed {
        return Err(ObjectError::BlockHash { claimed, computed });
    }
    Ok(envelope)
}

/// One validated unsafe head, as emitted on stdout (JSON line).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadRecord {
    /// Always [`SCHEMA`].
    pub schema: &'static str,
    /// Always `"head"`.
    #[serde(rename = "type")]
    pub kind: &'static str,
    /// Always `"unsafe"`: sequencer-signed, not L1-derived.
    pub tier: &'static str,
    /// Always `"none"`.
    pub finality: &'static str,
    /// L2 chain id the signature domain used.
    pub chain_id: u64,
    /// Block number.
    pub number: u64,
    /// Block hash (recomputed and checked).
    pub hash: B256,
    /// Parent hash.
    pub parent_hash: B256,
    /// Post-state root committed by the block hash.
    pub state_root: B256,
    /// Receipts root committed by the block hash.
    pub receipts_root: B256,
    /// Block timestamp (seconds).
    pub timestamp: u64,
    /// Number of transactions.
    pub tx_count: usize,
    /// The pinned signer the signature was checked against.
    pub signer: Address,
    /// Payload version on the wire.
    pub payload_version: &'static str,
    /// Object encoding, [`OBJECT_ENCODING`].
    pub object_encoding: &'static str,
    /// sha256 of the object bytes (content address).
    pub object_sha256: String,
    /// Object size in bytes.
    pub object_bytes: usize,
    /// Local receive time, unix milliseconds.
    pub received_unix_ms: u128,
}

impl HeadRecord {
    /// Builds the record for an accepted envelope and its object bytes.
    pub fn new(
        envelope: &NetworkPayloadEnvelope,
        chain_id: u64,
        signer: Address,
        object: &[u8],
        received_unix_ms: u128,
    ) -> Self {
        let v1 = envelope.payload.as_v1();
        Self {
            schema: SCHEMA,
            kind: "head",
            tier: "unsafe",
            finality: "none",
            chain_id,
            number: v1.block_number,
            hash: v1.block_hash,
            parent_hash: v1.parent_hash,
            state_root: v1.state_root,
            receipts_root: v1.receipts_root,
            timestamp: v1.timestamp,
            tx_count: v1.transactions.len(),
            signer,
            payload_version: payload_version(&envelope.payload),
            object_encoding: OBJECT_ENCODING,
            object_sha256: object_sha256(object),
            object_bytes: object.len(),
            received_unix_ms,
        }
    }
}

/// Result of storing an object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreOutcome {
    /// Newly written.
    Written,
    /// Identical content already present (same content address).
    AlreadyPresent,
}

/// Write-once, content-addressed object directory with a hard byte budget.
#[derive(Debug)]
pub struct ObjectStore {
    dir: PathBuf,
    budget: u64,
    used: u64,
}

impl ObjectStore {
    /// Creates the store; `dir` must not already contain objects.
    pub fn create(dir: &Path, budget: u64) -> Result<Self, ObjectError> {
        fs::create_dir_all(dir)?;
        if fs::read_dir(dir)?.next().is_some() {
            return Err(ObjectError::Io(std::io::Error::other("object directory is not empty")));
        }
        Ok(Self { dir: dir.to_path_buf(), budget, used: 0 })
    }

    /// Bytes charged so far (objects plus any [`Self::charge`]d output).
    pub const fn used(&self) -> u64 {
        self.used
    }

    /// Charges `n` bytes of other output against the budget.
    pub fn charge(&mut self, n: u64) -> bool {
        if self.used.saturating_add(n) > self.budget {
            return false;
        }
        self.used += n;
        true
    }

    /// Path an object with this content address is stored at.
    pub fn path_for(&self, sha256_hex: &str) -> PathBuf {
        self.dir.join(format!("{sha256_hex}.v4.snappy"))
    }

    /// Writes `bytes` under its sha256 unless the budget would be exceeded.
    /// Returns `Ok(None)` when the budget refuses the write.
    pub fn put(&mut self, bytes: &[u8]) -> Result<Option<(String, StoreOutcome)>, ObjectError> {
        let sha = object_sha256(bytes);
        let path = self.path_for(&sha);
        if path.exists() {
            return Ok(Some((sha, StoreOutcome::AlreadyPresent)));
        }
        if !self.charge(bytes.len() as u64) {
            return Ok(None);
        }
        let mut file = OpenOptions::new().write(true).create_new(true).open(&path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(Some((sha, StoreOutcome::Written)))
    }
}

/// Coarse, address-free class of a libp2p outbound dial error, for diagnostics.
pub fn classify_dial_error(text: &str) -> &'static str {
    let t = text.to_ascii_lowercase();
    if t.contains("connection refused") {
        "transport-refused"
    } else if t.contains("timed out") || t.contains("timeout") {
        "transport-timeout"
    } else if t.contains("connection reset") || t.contains("broken pipe") {
        "transport-reset"
    } else if t.contains("unreachable") || t.contains("no route") {
        "transport-unreachable"
    } else if t.contains("wrong peer") || t.contains("wrongpeerid") || t.contains("unexpected peer") {
        "wrong-peer-id"
    } else if t.contains("denied") {
        "denied-local-limit"
    } else if t.contains("aborted") {
        "aborted"
    } else if t.contains("noise") || t.contains("handshake") {
        "handshake"
    } else if t.contains("multistream") || t.contains("negotiat") || t.contains("protocol") {
        "protocol-negotiation"
    } else {
        "other"
    }
}

/// Bounded, de-duplicated outbound dial schedule.
///
/// Every candidate is offered once per key; dials are released only while the
/// number of in-flight dials, the connected-peer cap and the total dial cap all
/// allow it. In-flight entries expire after `in_flight_ttl` so a dial the driver
/// silently dropped cannot wedge the schedule.
#[derive(Debug)]
pub struct DialQueue<K, V> {
    seen: std::collections::HashSet<K>,
    queue: std::collections::VecDeque<(K, V)>,
    in_flight: std::collections::HashMap<K, std::time::Instant>,
    max_queue: usize,
    max_dials: u32,
    max_in_flight: usize,
    in_flight_ttl: std::time::Duration,
    dials: u32,
    duplicates: u64,
    overflow: u64,
}

impl<K: std::hash::Hash + Eq + Clone, V> DialQueue<K, V> {
    /// Creates a queue with the given caps.
    pub fn new(
        max_queue: usize,
        max_dials: u32,
        max_in_flight: usize,
        in_flight_ttl: std::time::Duration,
    ) -> Self {
        Self {
            seen: Default::default(),
            queue: Default::default(),
            in_flight: Default::default(),
            max_queue,
            max_dials,
            max_in_flight,
            in_flight_ttl,
            dials: 0,
            duplicates: 0,
            overflow: 0,
        }
    }

    /// Offers a candidate. Returns `true` if it was new and queued.
    pub fn offer(&mut self, key: K, value: V) -> bool {
        if self.seen.contains(&key) {
            self.duplicates += 1;
            return false;
        }
        if self.queue.len() >= self.max_queue {
            self.overflow += 1;
            return false;
        }
        self.seen.insert(key.clone());
        self.queue.push_back((key, value));
        true
    }

    /// Releases the next dial if every cap allows it.
    pub fn next_dial(
        &mut self,
        connected: usize,
        max_peers: usize,
        now: std::time::Instant,
    ) -> Option<(K, V)> {
        let ttl = self.in_flight_ttl;
        self.in_flight.retain(|_, started| now.duration_since(*started) < ttl);
        if self.dials >= self.max_dials
            || self.in_flight.len() >= self.max_in_flight
            || connected + self.in_flight.len() >= max_peers
        {
            return None;
        }
        let (key, value) = self.queue.pop_front()?;
        self.in_flight.insert(key.clone(), now);
        self.dials += 1;
        Some((key, value))
    }

    /// Marks a dial as resolved (connected or failed).
    pub fn resolved(&mut self, key: &K) {
        self.in_flight.remove(key);
    }

    /// Total dials released.
    pub const fn dials(&self) -> u32 {
        self.dials
    }

    /// Unique candidates ever accepted.
    pub fn unique(&self) -> usize {
        self.seen.len()
    }

    /// Duplicate offers ignored.
    pub const fn duplicates(&self) -> u64 {
        self.duplicates
    }

    /// Offers refused because the queue was full.
    pub const fn overflow(&self) -> u64 {
        self.overflow
    }

    /// Candidates still waiting.
    pub fn pending(&self) -> usize {
        self.queue.len()
    }

    /// Dials currently in flight.
    pub fn in_flight(&self) -> usize {
        self.in_flight.len()
    }
}
