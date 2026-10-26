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
    L1_HEAD_KEY, L1_HEAD_NUMBER_KEY, L2_CHAIN_ID_KEY, L2_CLAIM_BLOCK_NUMBER_KEY, L2_CLAIM_KEY, L2_OUTPUT_ROOT_KEY,
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

pub const RESULT_FORMAT: &str = "enclave-base-derivation-result/v1";
const TRUSTED_KEYS: [&str; 9] = ["chainId", "l1Head", "l1HeadNumber", "agreedL2OutputRoot", "claimedL2OutputRoot",
    "claimedL2BlockNumber", "rollupConfig", "expectedRollupConfigHash", "expectedScheduleId"];
const BASE_MAINNET: u64 = 8453;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trusted {
    pub chain_id: u64,
    pub l1_head: B256,
    pub l1_head_number: u64,
    pub agreed: B256,
    pub claimed: B256,
    pub claimed_number: u64,
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
    Ok(Trusted { chain_id, l1_head: h32(&v, "l1Head")?, l1_head_number: num("l1HeadNumber")?, agreed: h32(&v, "agreedL2OutputRoot")?,
        claimed: h32(&v, "claimedL2OutputRoot")?, claimed_number: num("claimedL2BlockNumber")?, rollup_config_json: serde_json::to_vec(rc)?,
        expected_config_hash: h32(&v, "expectedRollupConfigHash")?, expected_schedule_id: h32(&v, "expectedScheduleId")? })
}

/// The untrusted witness may carry only hash-addressed preimages; everything else would be a host-chosen value.
pub fn refuse_untrusted_key_types(w: &DefaultWitnessData) -> Result<()> {
    for k in w.preimage_store.preimage_map.keys() {
        match k.key_type() {
            PreimageKeyType::Keccak256 | PreimageKeyType::Sha256 => {}
            t => bail!("untrusted witness carries a {t:?} preimage: refused (boot inputs are caller-owned; precompiles run natively; blobs are KZG-checked separately)"),
        }
    }
    Ok(())
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
    Ok(())
}

/// Every committed field must equal the caller's trusted input: L1 head, agreed root, claimed root and number, config hash, schedule.
pub fn accept(b: &BootInfoStruct, t: &Trusted) -> Result<()> {
    let checks = [("l1Head", b.l1Head == t.l1_head), ("l2PreRoot", b.l2PreRoot == t.agreed), ("l2PostRoot", b.l2PostRoot == t.claimed),
        ("l2BlockNumber", b.l2BlockNumber == t.claimed_number), ("rollupConfigHash", b.rollupConfigHash == t.expected_config_hash),
        ("scheduleId", b.scheduleId == t.expected_schedule_id)];
    let bad: Vec<&str> = checks.iter().filter(|(_, ok)| !ok).map(|(k, _)| *k).collect();
    if !bad.is_empty() {
        bail!("result does not bind the caller's trusted inputs: {bad:?}");
    }
    Ok(())
}

pub fn result_json(b: &BootInfoStruct, t: &Trusted) -> serde_json::Value {
    let abi = b.abi_encode();
    serde_json::json!({ "format": RESULT_FORMAT, "chainId": t.chain_id, "l1Head": b.l1Head, "l1HeadNumber": t.l1_head_number,
        "agreedL2OutputRoot": b.l2PreRoot, "l2PreBlockNumber": b.l2PreBlockNumber, "l2OutputRoot": b.l2PostRoot, "l2BlockNumber": b.l2BlockNumber,
        "rollupConfigHash": b.rollupConfigHash, "scheduleId": b.scheduleId, "bootInfoAbi": format!("0x{}", hex::encode(&abi)),
        "bootInfoKeccak": keccak256(&abi) })
}

async fn derive(oracle: Arc<WitnessOracle>, beacon: BlobStore) -> Result<BootInfoStruct> {
    let executor = WitnessExecutor::<WitnessOracle, BlobStore>::new();
    let (boot, input, pre_number) = get_inputs_for_pipeline(Arc::clone(&oracle)).await?;
    let (cursor, l1_provider, l2_provider) = input;
    let pipeline = executor.create_pipeline(Arc::new(boot.rollup_config.clone()), Arc::new(boot.l1_config.clone()), Arc::clone(&cursor),
        oracle, beacon, l1_provider, l2_provider.clone()).await?;
    let (boot, number, roots) = executor.run(boot, pipeline, cursor, l2_provider).await?;   // number + output root checked here
    Ok(BootInfoStruct::new(boot, pre_number, number, roots))
}

pub fn verify(trusted: &[u8], witness: &[u8]) -> Result<serde_json::Value> {
    let t = parse_trusted(trusted)?;
    let mut w = rkyv::from_bytes::<DefaultWitnessData, rkyv::rancor::Error>(witness).map_err(|e| anyhow!("witness: {e}"))?;
    refuse_untrusted_key_types(&w)?;
    w.preimage_store.check_preimages().map_err(|e| anyhow!("witness preimage: {e}"))?;
    inject_trusted(&mut w, &t)?;
    // KZG blob checks, WitnessOracle and the derivation panic on bad/missing data: a panic is a refusal, never a result
    let b = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        base_proof::block_on(async move {
            let (oracle, beacon) = w.get_oracle_and_blob_provider().await?;
            derive(oracle, beacon).await
        })
    }))
    .map_err(|_| anyhow!("derivation aborted (missing/invalid preimage or blob)"))??;
    accept(&b, &t)?;
    Ok(result_json(&b, &t))
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
            "claimedL2BlockNumber": 20, "rollupConfig": {"x": 1}, "expectedRollupConfigHash": format!("0x{}", "55".repeat(32)),
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
            rollupConfigHash: t.expected_config_hash, scheduleId: t.expected_schedule_id, intermediateBlockInterval: 10, intermediateRoots: Default::default() }
    }

    #[test]
    fn trusted_input_is_strict() {
        let mut j = trusted_json(); j["extra"] = 1.into();
        assert!(parse_trusted(&serde_json::to_vec(&j).unwrap()).is_err(), "unknown key");
        let mut j = trusted_json(); j["chainId"] = 10.into();
        assert!(parse_trusted(&serde_json::to_vec(&j).unwrap()).unwrap_err().to_string().contains("unsupported chain"));
        let mut j = trusted_json(); j["l1Head"] = "0x11".into();
        assert!(parse_trusted(&serde_json::to_vec(&j).unwrap()).is_err(), "short hash");
        let mut j = trusted_json(); j["l1Head"] = format!("0x{}", "AA".repeat(32)).into();
        assert!(parse_trusted(&serde_json::to_vec(&j).unwrap()).is_err(), "uppercase hex");
    }

    #[test]
    fn untrusted_witness_cannot_carry_boot_inputs_precompiles_blobs_or_generic() {
        for t in [PreimageKeyType::Local, PreimageKeyType::GlobalGeneric, PreimageKeyType::Precompile, PreimageKeyType::Blob] {
            let w = witness_with(PreimageKey::new([1u8; 32], t), vec![1]);
            assert!(refuse_untrusted_key_types(&w).is_err(), "{t:?} must refuse");
        }
        let v = b"node".to_vec();
        assert!(refuse_untrusted_key_types(&witness_with(PreimageKey::new_keccak256(*keccak256(&v)), v)).is_ok());
    }

    #[test]
    fn corrupt_keccak_preimage_is_refused_by_the_reused_check() {
        let w = witness_with(PreimageKey::new_keccak256([7u8; 32]), b"not that".to_vec());
        assert!(refuse_untrusted_key_types(&w).is_ok());
        assert!(w.preimage_store.check_preimages().is_err());
    }

    #[test]
    fn truncated_or_garbage_witness_is_refused() {
        let t = serde_json::to_vec(&trusted_json()).unwrap();
        assert!(verify(&t, b"\x00\x01garbage").is_err());
        assert!(verify(&t, &[]).is_err());
    }

    #[test]
    fn missing_preimages_refuse_instead_of_producing_a_result() {
        // an empty (but well-formed) witness: every chain read is missing -> WitnessOracle aborts -> refusal
        let t = serde_json::to_vec(&trusted_json()).unwrap();
        let w = rkyv::to_bytes::<rkyv::rancor::Error>(&DefaultWitnessData::default()).unwrap();
        assert!(verify(&t, &w).is_err());
    }

    #[test]
    fn result_must_bind_every_trusted_input() {
        let t = trusted();
        assert!(accept(&boot(&t), &t).is_ok());
        let muts: [fn(&mut BootInfoStruct); 6] = [|b| b.l1Head = B256::ZERO, |b| b.l2PreRoot = B256::ZERO, |b| b.l2PostRoot = B256::ZERO,
            |b| b.l2BlockNumber += 1, |b| b.rollupConfigHash = B256::ZERO, |b| b.scheduleId = B256::ZERO];
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
    }
}
