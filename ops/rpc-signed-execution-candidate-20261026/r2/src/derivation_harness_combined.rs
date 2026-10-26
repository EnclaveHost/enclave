//! derivation-client-stage/combined-r1 = derivation-witness-stage v2 (9f0111aa) + the REQUIRED caller-authorized intermediate block interval
//! (upstream BootInfo::load refuses MissingIntermediateBlockInterval without Local key 9; r3 and v2 omitted it). combined adds:
//!   trusted input `intermediateBlockInterval` (u64 >= 1; the claimed range must be a multiple: upstream IntermediateRootSampler),
//!   injected as INTERMEDIATE_BLOCK_INTERVAL_KEY; accept() requires the committed BootInfoStruct.intermediateBlockInterval to equal it;
//!   the result reports intermediateBlockInterval, l2PreBlockNumber and the committed intermediateRoots.
//! Aligned with frozen r4 (6554926f): same trusted key name, same accept rule for the roots (non-empty whole 32-byte roots ENDING at the
//! claimed root) and the same encodings (intermediateRoots = one concatenated 0x string). Output = r4's v1 fields + `base{}` -> format v2.
//! v2 notes (unchanged):
//!   (1) a REAL upstream witness (base-proof-zk-witness PreimageWitnessCollector) records the Local boot keys it read: they are
//!       STRIPPED (never trusted) and replaced by the caller's trusted inputs; r3 refused every real witness here;
//!   (2) the executed safe-head header is read from the pipeline cursor after the reused run() and must reproduce the verified
//!       output root: keccak(0^32 || stateRoot || withdrawalsRoot(message passer) || hash) == l2OutputRoot; the result exposes
//!       base {number, hash, stateRoot, timestamp, outputRoot} for the lifecycle readAnchor;
//!   (3) the witness may be rkyv (DefaultWitnessData) or the serde JSON {"preimageStore","blobData"} written by witness_fetch.
//! Original r3 header follows.
//! derivation-client-stage: native in-domain derivation harness (PREPARED). Built as an EXAMPLE of base-proof-zk-utils inside the
//! pinned base/base 5476069f tree (codeload tarball 9784e20a...), so the workspace Cargo.lock is unchanged (--frozen).
//! It reuses, unmodified, the code Base's zkVM range program runs over an UNTRUSTED witness:
//!   PreimageStore::check_preimages (keccak256 / sha256 key == digest of value), WitnessOracle (a missing non-local key panics),
//!   BlobStore::from(BlobData) (EIP-4844 blobs checked by KZG), get_inputs_for_pipeline / WitnessExecutor (derivation + stateless
//!   execution; refuses unless the derived block == claimed number AND the computed output root == claimed root), BootInfoStruct.
//! TRUST BOUNDARY (caller-owned, never from the witness or its host):
//!   chainId, l1Head (+ l1HeadNumber), agreedL2OutputRoot, claimedL2OutputRoot, claimedL2BlockNumber, the rollup config whose
//!   contract-backed activations BootInfo reads, expectedRollupConfigHash and expectedScheduleId. They are injected here as the
//!   Local preimages; the untrusted witness may contain ONLY Keccak256/Sha256 preimages (+ separate KZG-checked blobs): any
//!   Local, GlobalGeneric, Blob-in-store or Precompile key is refused (precompiles execute natively in revm; nothing is
//!   accepted from a host). The result is then compared field by field with the caller's trusted inputs before it is printed.
//! Usage: derivation_harness <trusted.json> <witness.rkyv>   exit 0 verified (prints the result JSON), 1 refused, 2 usage.
use std::{collections::BTreeSet, sync::Arc};

use alloy_primitives::{B256, hex, keccak256};
use alloy_sol_types::SolValue;
use anyhow::{Result, anyhow, bail};
use base_proof::{
    INTERMEDIATE_BLOCK_INTERVAL_KEY, L1_HEAD_KEY, L1_HEAD_NUMBER_KEY, L2_CHAIN_ID_KEY, L2_CLAIM_BLOCK_NUMBER_KEY, L2_CLAIM_KEY, L2_OUTPUT_ROOT_KEY,
    L2_ROLLUP_CONFIG_KEY,
};
use base_proof_preimage::{PreimageKey, PreimageKeyType};
use base_proof_zk_utils::{
    BlobStore,
    boot::BootInfoStruct,
    witness::{
        DefaultWitnessData, WitnessData, WitnessExecutor, executor::get_inputs_for_pipeline, preimage_store::WitnessOracle,
    },
};

pub const RESULT_FORMAT: &str = "enclave-base-derivation-result/v2";   // combined keeps v2; adds interval fields
const TRUSTED_KEYS: [&str; 10] = ["chainId", "l1Head", "l1HeadNumber", "agreedL2OutputRoot", "claimedL2OutputRoot",
    "claimedL2BlockNumber", "intermediateBlockInterval", "rollupConfig", "expectedRollupConfigHash", "expectedScheduleId"];
const BASE_MAINNET: u64 = 8453;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trusted {
    pub chain_id: u64,
    pub l1_head: B256,
    pub l1_head_number: u64,
    pub agreed: B256,
    pub claimed: B256,
    pub claimed_number: u64,
    pub interval: u64,
    pub rollup_config_json: Vec<u8>,
    pub expected_config_hash: B256,
    pub expected_schedule_id: B256,
}

fn h32(v: &serde_json::Value, k: &str) -> Result<B256> {
    let s = v.get(k).and_then(|x| x.as_str()).ok_or_else(|| anyhow!("trusted {k} missing"))?;
    if s.len() != 66 || !s.starts_with("0x") || s[2..].chars().any(|c| !c.is_ascii_hexdigit() || c.is_ascii_uppercase()) {
        bail!("trusted {k} must be 0x + 64 lowercase hex");
    }
    Ok(B256::from_slice(&hex::decode(&s[2..])?))
}

/// Strict caller-owned input: exactly TRUSTED_KEYS, Base mainnet only.
pub fn parse_trusted(bytes: &[u8]) -> Result<Trusted> {
    let v: serde_json::Value = serde_json::from_slice(bytes)?;
    let o = v.as_object().ok_or_else(|| anyhow!("trusted input is not an object"))?;
    let keys: BTreeSet<&str> = o.keys().map(String::as_str).collect();
    if keys != TRUSTED_KEYS.iter().copied().collect() {
        bail!("trusted input keys must be exactly {TRUSTED_KEYS:?}");
    }
    let num = |k: &str| v.get(k).and_then(|x| x.as_u64()).ok_or_else(|| anyhow!("trusted {k} must be an unsigned integer"));
    let chain_id = num("chainId")?;
    if chain_id != BASE_MAINNET {
        bail!("unsupported chain {chain_id}: only Base mainnet {BASE_MAINNET}");
    }
    let rc = v.get("rollupConfig").filter(|x| x.is_object()).ok_or_else(|| anyhow!("trusted rollupConfig must be an object"))?;
    let interval = num("intermediateBlockInterval")?;
    if interval == 0 {
        bail!("trusted intermediateBlockInterval must be >= 1");
    }
    Ok(Trusted { chain_id, l1_head: h32(&v, "l1Head")?, l1_head_number: num("l1HeadNumber")?, agreed: h32(&v, "agreedL2OutputRoot")?,
        claimed: h32(&v, "claimedL2OutputRoot")?, claimed_number: num("claimedL2BlockNumber")?, interval, rollup_config_json: serde_json::to_vec(rc)?,
        expected_config_hash: h32(&v, "expectedRollupConfigHash")?, expected_schedule_id: h32(&v, "expectedScheduleId")? })
}

/// v2: Local keys (the boot inputs the upstream collector recorded) are REMOVED, never trusted; any other non-hash key refuses.
pub fn strip_and_check_untrusted(w: &mut DefaultWitnessData) -> Result<usize> {
    for k in w.preimage_store.preimage_map.keys() {
        match k.key_type() {
            PreimageKeyType::Keccak256 | PreimageKeyType::Sha256 | PreimageKeyType::Local => {}
            t => bail!("untrusted witness carries a {t:?} preimage: refused (precompiles run natively; blobs are KZG-checked separately)"),
        }
    }
    let before = w.preimage_store.preimage_map.len();
    w.preimage_store.preimage_map.retain(|k, _| k.key_type() != PreimageKeyType::Local);
    Ok(before - w.preimage_store.preimage_map.len())
}

/// OutputRoot v0 = keccak256(0^32 || stateRoot || messagePasserStorageRoot || blockHash)
pub fn output_root_v0(state_root: B256, message_passer_root: B256, block_hash: B256) -> B256 {
    let mut b = [0u8; 128];
    b[32..64].copy_from_slice(state_root.as_slice());
    b[64..96].copy_from_slice(message_passer_root.as_slice());
    b[96..128].copy_from_slice(block_hash.as_slice());
    keccak256(b)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutedHead {
    pub number: u64,
    pub hash: B256,
    pub state_root: B256,
    pub message_passer_root: B256,
    pub timestamp: u64,
}

/// v2: the executed header must reproduce the verified output root and be the claimed block.
pub fn bind_head(h: &ExecutedHead, b: &BootInfoStruct) -> Result<()> {
    if h.number != b.l2BlockNumber {
        bail!("executed head #{} is not the claimed block #{}", h.number, b.l2BlockNumber);
    }
    if output_root_v0(h.state_root, h.message_passer_root, h.hash) != b.l2PostRoot {
        bail!("executed head does not reproduce the verified output root");
    }
    Ok(())
}

pub fn load_witness(bytes: &[u8]) -> Result<DefaultWitnessData> {
    if bytes.first() == Some(&b'{') {
        let v: serde_json::Value = serde_json::from_slice(bytes)?;
        let o = v.as_object().ok_or_else(|| anyhow!("witness JSON is not an object"))?;
        if o.len() != 2 || !o.contains_key("preimageStore") || !o.contains_key("blobData") {
            bail!("witness JSON must be exactly {{preimageStore, blobData}}");
        }
        return Ok(DefaultWitnessData { preimage_store: serde_json::from_value(v["preimageStore"].clone())?, blob_data: serde_json::from_value(v["blobData"].clone())? });
    }
    rkyv::from_bytes::<DefaultWitnessData, rkyv::rancor::Error>(bytes).map_err(|e| anyhow!("witness: {e}"))
}

/// Inject the caller-owned boot inputs as Local preimages (after the untrusted ones were checked).
pub fn inject_trusted(w: &mut DefaultWitnessData, t: &Trusted) -> Result<()> {
    let s = &mut w.preimage_store;
    let put = |s: &mut base_proof_zk_utils::witness::preimage_store::PreimageStore, k: alloy_primitives::U256, v: Vec<u8>| {
        s.save_preimage(PreimageKey::new_local(k.to()), v).map_err(|e| anyhow!("inject: {e}"))
    };
    put(s, L1_HEAD_KEY, t.l1_head.to_vec())?;
    put(s, L2_OUTPUT_ROOT_KEY, t.agreed.to_vec())?;
    put(s, L2_CLAIM_KEY, t.claimed.to_vec())?;
    put(s, L2_CLAIM_BLOCK_NUMBER_KEY, t.claimed_number.to_be_bytes().to_vec())?;
    put(s, L2_CHAIN_ID_KEY, t.chain_id.to_be_bytes().to_vec())?;
    put(s, L2_ROLLUP_CONFIG_KEY, t.rollup_config_json.clone())?;
    put(s, L1_HEAD_NUMBER_KEY, t.l1_head_number.to_be_bytes().to_vec())?;
    put(s, INTERMEDIATE_BLOCK_INTERVAL_KEY, t.interval.to_be_bytes().to_vec())?;
    Ok(())
}

/// Every committed field must equal the caller's trusted input: L1 head, agreed root, claimed root and number, config hash, schedule.
pub fn accept(b: &BootInfoStruct, t: &Trusted) -> Result<()> {
    let checks = [("l1Head", b.l1Head == t.l1_head), ("l2PreRoot", b.l2PreRoot == t.agreed), ("l2PostRoot", b.l2PostRoot == t.claimed),
        ("l2BlockNumber", b.l2BlockNumber == t.claimed_number), ("rollupConfigHash", b.rollupConfigHash == t.expected_config_hash),
        ("scheduleId", b.scheduleId == t.expected_schedule_id), ("intermediateBlockInterval", b.intermediateBlockInterval == t.interval),
        ("intermediateRoots", intermediate_roots_end_at_claim(&b.intermediateRoots, &t.claimed))];
    let bad: Vec<&str> = checks.iter().filter(|(_, ok)| !ok).map(|(k, _)| *k).collect();
    if !bad.is_empty() {
        bail!("result does not bind the caller's trusted inputs: {bad:?}");
    }
    Ok(())
}

/// (from r4, verbatim) `intermediateRoots` is the concatenation of 32-byte roots; it must be non-empty, whole roots, and end at the claimed root.
pub fn intermediate_roots_end_at_claim(roots: &[u8], claimed: &B256) -> bool {
    !roots.is_empty() && roots.len() % 32 == 0 && &roots[roots.len() - 32..] == claimed.as_slice()
}

pub fn result_json(b: &BootInfoStruct, t: &Trusted, h: &ExecutedHead) -> serde_json::Value {
    let abi = b.abi_encode();
    serde_json::json!({ "format": RESULT_FORMAT, "chainId": t.chain_id, "l1Head": b.l1Head, "l1HeadNumber": t.l1_head_number,
        "base": { "number": h.number, "hash": h.hash, "stateRoot": h.state_root, "messagePasserStorageRoot": h.message_passer_root,
                  "timestamp": h.timestamp, "outputRoot": b.l2PostRoot },
        "agreedL2OutputRoot": b.l2PreRoot, "l2PreBlockNumber": b.l2PreBlockNumber, "l2OutputRoot": b.l2PostRoot, "l2BlockNumber": b.l2BlockNumber,
        "rollupConfigHash": b.rollupConfigHash, "scheduleId": b.scheduleId, "intermediateBlockInterval": b.intermediateBlockInterval,
        "intermediateRoots": format!("0x{}", hex::encode(&b.intermediateRoots)), "bootInfoAbi": format!("0x{}", hex::encode(&abi)),
        "bootInfoKeccak": keccak256(&abi) })
}

async fn derive(oracle: Arc<WitnessOracle>, beacon: BlobStore) -> Result<(BootInfoStruct, ExecutedHead)> {
    let executor = WitnessExecutor::<WitnessOracle, BlobStore>::new();
    let (boot, input, pre_number) = get_inputs_for_pipeline(Arc::clone(&oracle)).await?;
    let (cursor, l1_provider, l2_provider) = input;
    let tip_view = Arc::clone(&cursor);                                       // v2: read the executed head after run()
    let pipeline = executor.create_pipeline(Arc::new(boot.rollup_config.clone()), Arc::new(boot.l1_config.clone()), Arc::clone(&cursor),
        oracle, beacon, l1_provider, l2_provider.clone()).await?;
    let (boot, number, roots) = executor.run(boot, pipeline, cursor, l2_provider).await?;   // number + output root checked here
    let tip = tip_view.read().tip().clone();
    let hdr = &tip.l2_safe_head_header;
    let head = ExecutedHead { number: hdr.number, hash: hdr.hash(), state_root: hdr.state_root,
        message_passer_root: hdr.withdrawals_root.ok_or_else(|| anyhow!("executed head has no withdrawalsRoot (pre-Isthmus)"))?, timestamp: hdr.timestamp };
    if tip.l2_safe_head_output_root != output_root_v0(head.state_root, head.message_passer_root, head.hash) {
        bail!("pipeline tip output root is not the executed header's output root");
    }
    Ok((BootInfoStruct::new(boot, pre_number, number, roots), head))
}

pub fn verify(trusted: &[u8], witness: &[u8]) -> Result<serde_json::Value> {
    let t = parse_trusted(trusted)?;
    let mut w = load_witness(witness)?;
    let _stripped_locals = strip_and_check_untrusted(&mut w)?;
    w.preimage_store.check_preimages().map_err(|e| anyhow!("witness preimage: {e}"))?;
    inject_trusted(&mut w, &t)?;
    // KZG blob checks, WitnessOracle and the derivation panic on bad/missing data: a panic is a refusal, never a result
    let (b, h) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        base_proof::block_on(async move {
            let (oracle, beacon) = w.get_oracle_and_blob_provider().await?;
            derive(oracle, beacon).await
        })
    }))
    .map_err(|_| anyhow!("derivation aborted (missing/invalid preimage or blob)"))??;
    accept(&b, &t)?;
    bind_head(&h, &b)?;
    Ok(result_json(&b, &t, &h))
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 3 {
        eprintln!("usage: derivation_harness <trusted.json> <witness.rkyv>");
        std::process::exit(2);
    }
    let r = (|| -> Result<serde_json::Value> { verify(&std::fs::read(&a[1])?, &std::fs::read(&a[2])?) })();
    match r {
        Ok(v) => println!("{v}"),
        Err(e) => {
            println!("{}", serde_json::json!({"format": RESULT_FORMAT, "refused": e.to_string()}));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn trusted_json() -> serde_json::Value {
        serde_json::json!({"chainId": 8453, "l1Head": format!("0x{}", "11".repeat(32)), "l1HeadNumber": 1,
            "agreedL2OutputRoot": format!("0x{}", "22".repeat(32)), "claimedL2OutputRoot": format!("0x{}", "33".repeat(32)),
            "claimedL2BlockNumber": 20, "intermediateBlockInterval": 10, "rollupConfig": {"x": 1}, "expectedRollupConfigHash": format!("0x{}", "55".repeat(32)),
            "expectedScheduleId": format!("0x{}", "44".repeat(32))})
    }
    fn trusted() -> Trusted { parse_trusted(&serde_json::to_vec(&trusted_json()).unwrap()).unwrap() }
    fn witness_with(k: PreimageKey, v: Vec<u8>) -> DefaultWitnessData {
        let mut w = DefaultWitnessData::default();
        w.preimage_store.preimage_map.insert(k, v);
        w
    }
    fn boot(t: &Trusted) -> BootInfoStruct {
        BootInfoStruct { l1Head: t.l1_head, l2PreRoot: t.agreed, l2PostRoot: t.claimed, l2PreBlockNumber: 10, l2BlockNumber: t.claimed_number,
            rollupConfigHash: t.expected_config_hash, scheduleId: t.expected_schedule_id, intermediateBlockInterval: t.interval, intermediateRoots: t.claimed.to_vec().into() }
    }

    #[test]
    fn trusted_input_is_strict() {
        let mut j = trusted_json(); j["extra"] = 1.into();
        assert!(parse_trusted(&serde_json::to_vec(&j).unwrap()).is_err(), "unknown key");
        let mut j = trusted_json(); j["chainId"] = 10.into();
        assert!(parse_trusted(&serde_json::to_vec(&j).unwrap()).unwrap_err().to_string().contains("unsupported chain"));
        let mut j = trusted_json(); j["l1Head"] = "0x11".into();
        assert!(parse_trusted(&serde_json::to_vec(&j).unwrap()).is_err(), "short hash");
        let mut j = trusted_json(); j["intermediateBlockInterval"] = 0.into();
        assert!(parse_trusted(&serde_json::to_vec(&j).unwrap()).is_err(), "interval 0");
        let mut j = trusted_json(); j.as_object_mut().unwrap().remove("intermediateBlockInterval");
        assert!(parse_trusted(&serde_json::to_vec(&j).unwrap()).is_err(), "interval is required, never defaulted");
        let mut j = trusted_json(); j["l1Head"] = format!("0x{}", "AA".repeat(32)).into();
        assert!(parse_trusted(&serde_json::to_vec(&j).unwrap()).is_err(), "uppercase hex");
    }

    #[test]
    fn untrusted_witness_locals_are_stripped_and_other_unhashable_keys_refuse() {
        for t in [PreimageKeyType::GlobalGeneric, PreimageKeyType::Precompile, PreimageKeyType::Blob] {
            let mut w = witness_with(PreimageKey::new([1u8; 32], t), vec![1]);
            assert!(strip_and_check_untrusted(&mut w).is_err(), "{t:?} must refuse");
        }
        let mut w = witness_with(PreimageKey::new_local(L1_HEAD_KEY.to()), vec![0xEE; 32]);   // a host-chosen L1 head
        assert_eq!(strip_and_check_untrusted(&mut w).unwrap(), 1);
        assert!(w.preimage_store.preimage_map.is_empty(), "the host's Local value is gone");
        inject_trusted(&mut w, &trusted()).unwrap();                                          // and the caller's is used
        let v = b"node".to_vec();
        assert!(strip_and_check_untrusted(&mut witness_with(PreimageKey::new_keccak256(*keccak256(&v)), v)).is_ok());
    }

    #[test]
    fn executed_head_must_reproduce_the_verified_output_root_and_number() {
        let t = trusted();
        let h = ExecutedHead { number: t.claimed_number, hash: B256::repeat_byte(1), state_root: B256::repeat_byte(2), message_passer_root: B256::repeat_byte(3), timestamp: 9 };
        let mut b = boot(&t);
        b.l2PostRoot = output_root_v0(h.state_root, h.message_passer_root, h.hash);
        assert!(bind_head(&h, &b).is_ok());
        assert!(bind_head(&ExecutedHead { state_root: B256::repeat_byte(4), ..h.clone() }, &b).is_err(), "other state root");
        assert!(bind_head(&ExecutedHead { hash: B256::repeat_byte(5), ..h.clone() }, &b).is_err(), "other block hash");
        assert!(bind_head(&ExecutedHead { number: h.number + 1, ..h.clone() }, &b).is_err(), "other number");
    }

    #[test]
    fn json_witness_shape_is_strict() {
        assert!(load_witness(br#"{"preimageStore":{"preimage_map":[]},"blobData":{"blobs":[],"commitments":[],"proofs":[]},"x":1}"#).is_err());
        assert!(load_witness(b"{}").is_err());
    }

    #[test]
    fn corrupt_keccak_preimage_is_refused_by_the_reused_check() {
        let mut w = witness_with(PreimageKey::new_keccak256([7u8; 32]), b"not that".to_vec());
        assert!(strip_and_check_untrusted(&mut w).is_ok());
        assert!(w.preimage_store.check_preimages().is_err());
    }

    #[test]
    fn truncated_or_garbage_witness_is_refused() {
        let t = serde_json::to_vec(&trusted_json()).unwrap();
        assert!(verify(&t, b"\x00\x01garbage").is_err());
        assert!(verify(&t, &[]).is_err());
    }

    #[test]
    fn empty_witness_refuses_but_proves_nothing_about_execution() {
        // NOT an execution-rejection test: an empty witness may refuse already at rollup-config parsing. Real missing-preimage,
        // hash-bad and KZG-bad rejection is exercised only by runner/runner.py negatives on a REAL fetched witness.
        let t = serde_json::to_vec(&trusted_json()).unwrap();
        let w = rkyv::to_bytes::<rkyv::rancor::Error>(&DefaultWitnessData::default()).unwrap();
        assert!(verify(&t, &w).is_err());
    }

    #[test]
    fn result_must_bind_every_trusted_input() {
        let t = trusted();
        assert!(accept(&boot(&t), &t).is_ok());
        let muts: [fn(&mut BootInfoStruct); 9] = [|b| b.intermediateRoots = Default::default(), |b| b.intermediateRoots = B256::ZERO.to_vec().into(),
            |b| b.l1Head = B256::ZERO, |b| b.l2PreRoot = B256::ZERO, |b| b.l2PostRoot = B256::ZERO,
            |b| b.l2BlockNumber += 1, |b| b.rollupConfigHash = B256::ZERO, |b| b.scheduleId = B256::ZERO, |b| b.intermediateBlockInterval += 1];
        for m in muts {
            let mut b = boot(&t); m(&mut b);
            assert!(accept(&b, &t).is_err(), "a stale/replayed/foreign result must not be accepted");
        }
    }

    #[test]
    fn injected_local_keys_cannot_be_overwritten_with_other_values() {
        let t = trusted();
        let mut w = DefaultWitnessData::default();
        inject_trusted(&mut w, &t).unwrap();
        let k = PreimageKey::new_local(L1_HEAD_KEY.to());
        assert!(w.preimage_store.save_preimage(k, vec![9u8; 32]).is_err());
        let ki = PreimageKey::new_local(INTERMEDIATE_BLOCK_INTERVAL_KEY.to());
        assert_eq!(w.preimage_store.preimage_map.get(&ki), Some(&t.interval.to_be_bytes().to_vec()), "interval injected from the caller");
    }
}
