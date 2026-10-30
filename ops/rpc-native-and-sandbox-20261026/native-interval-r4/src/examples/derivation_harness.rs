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
//! r4: + caller-authorized intermediateBlockInterval (required by upstream BootInfo::load; bound in the result).
//! Usage: derivation_harness <trusted.json> <witness.rkyv>   exit 0 verified (prints the result JSON), 1 refused, 2 usage.
use std::{collections::BTreeSet, sync::Arc};

use alloy_primitives::{B256, hex, keccak256};
use alloy_sol_types::SolValue;
use anyhow::{Result, anyhow, bail};
use base_proof::{
    INTERMEDIATE_BLOCK_INTERVAL_KEY, L1_HEAD_KEY, L1_HEAD_NUMBER_KEY, L2_CHAIN_ID_KEY, L2_CLAIM_BLOCK_NUMBER_KEY, L2_CLAIM_KEY,
    L2_OUTPUT_ROOT_KEY, L2_ROLLUP_CONFIG_KEY,
};
use core::num::NonZeroU64;
use base_proof_preimage::{PreimageKey, PreimageKeyType};
use base_proof_zk_utils::{
    BlobStore,
    boot::BootInfoStruct,
    witness::{
        DefaultWitnessData, WitnessData, WitnessExecutor, executor::get_inputs_for_pipeline, preimage_store::WitnessOracle,
    },
};

pub const RESULT_FORMAT: &str = "enclave-base-derivation-result/v1";
// r4: + intermediateBlockInterval. Upstream BootInfo::load REQUIRES INTERMEDIATE_BLOCK_INTERVAL_KEY (9) as a non-zero big-endian
// u64 (MissingIntermediateBlockInterval / ZeroIntermediateBlockInterval, proof/src/boot.rs); r3 never injected it, so every real
// run refused at boot. It is caller-authorized (the proven game's interval), never taken from the host witness (Local keys refused).
const TRUSTED_KEYS: [&str; 10] = ["chainId", "l1Head", "l1HeadNumber", "agreedL2OutputRoot", "claimedL2OutputRoot",
    "claimedL2BlockNumber", "rollupConfig", "expectedRollupConfigHash", "expectedScheduleId", "intermediateBlockInterval"];
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
    pub intermediate_block_interval: NonZeroU64,
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
        expected_config_hash: h32(&v, "expectedRollupConfigHash")?, expected_schedule_id: h32(&v, "expectedScheduleId")?,
        intermediate_block_interval: NonZeroU64::new(num("intermediateBlockInterval")?)
            .ok_or_else(|| anyhow!("trusted intermediateBlockInterval must be a non-zero u64"))? })
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
    put(s, INTERMEDIATE_BLOCK_INTERVAL_KEY, t.intermediate_block_interval.get().to_be_bytes().to_vec())?;   // r4: required by BootInfo::load
    Ok(())
}

/// Every committed field must equal the caller's trusted input: L1 head, agreed root, claimed root and number, config hash, schedule.
pub fn accept(b: &BootInfoStruct, t: &Trusted) -> Result<()> {
    let checks = [("l1Head", b.l1Head == t.l1_head), ("l2PreRoot", b.l2PreRoot == t.agreed), ("l2PostRoot", b.l2PostRoot == t.claimed),
        ("l2BlockNumber", b.l2BlockNumber == t.claimed_number), ("rollupConfigHash", b.rollupConfigHash == t.expected_config_hash),
        ("scheduleId", b.scheduleId == t.expected_schedule_id),
        ("intermediateBlockInterval", b.intermediateBlockInterval == t.intermediate_block_interval.get()),
        // r4: the sampler's last root must be the claim (upstream IntermediateRootSampler + executor already require it): re-checked
        ("intermediateRoots", intermediate_roots_end_at_claim(&b.intermediateRoots, &t.claimed))];
    let bad: Vec<&str> = checks.iter().filter(|(_, ok)| !ok).map(|(k, _)| *k).collect();
    if !bad.is_empty() {
        bail!("result does not bind the caller's trusted inputs: {bad:?}");
    }
    Ok(())
}

/// r4: `intermediateRoots` is the concatenation of 32-byte roots; it must be non-empty, whole roots, and end at the claimed root.
pub fn intermediate_roots_end_at_claim(roots: &[u8], claimed: &B256) -> bool {
    !roots.is_empty() && roots.len() % 32 == 0 && &roots[roots.len() - 32..] == claimed.as_slice()
}

pub fn result_json(b: &BootInfoStruct, t: &Trusted) -> serde_json::Value {
    let abi = b.abi_encode();
    serde_json::json!({ "format": RESULT_FORMAT, "chainId": t.chain_id, "l1Head": b.l1Head, "l1HeadNumber": t.l1_head_number,
        "agreedL2OutputRoot": b.l2PreRoot, "l2PreBlockNumber": b.l2PreBlockNumber, "l2OutputRoot": b.l2PostRoot, "l2BlockNumber": b.l2BlockNumber,
        "rollupConfigHash": b.rollupConfigHash, "scheduleId": b.scheduleId,
        "intermediateBlockInterval": b.intermediateBlockInterval, "intermediateRoots": format!("0x{}", hex::encode(&b.intermediateRoots)),
        "bootInfoAbi": format!("0x{}", hex::encode(&abi)),
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
            "expectedScheduleId": format!("0x{}", "44".repeat(32)), "intermediateBlockInterval": 10})
    }
    fn trusted() -> Trusted { parse_trusted(&serde_json::to_vec(&trusted_json()).unwrap()).unwrap() }
    fn witness_with(k: PreimageKey, v: Vec<u8>) -> DefaultWitnessData {
        let mut w = DefaultWitnessData::default();
        w.preimage_store.preimage_map.insert(k, v);
        w
    }
    fn boot(t: &Trusted) -> BootInfoStruct {
        BootInfoStruct { l1Head: t.l1_head, l2PreRoot: t.agreed, l2PostRoot: t.claimed, l2PreBlockNumber: 10, l2BlockNumber: t.claimed_number,
            rollupConfigHash: t.expected_config_hash, scheduleId: t.expected_schedule_id, intermediateBlockInterval: 10,
            intermediateRoots: [B256::repeat_byte(0x77).as_slice(), t.claimed.as_slice()].concat().into() }
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

    // ---- r4: intermediateBlockInterval (caller-authorized; upstream BootInfo::load requires it) ----------------------------------
    #[test]
    fn interval_is_a_required_non_zero_u64() {
        let mut j = trusted_json(); j.as_object_mut().unwrap().remove("intermediateBlockInterval");
        assert!(parse_trusted(&serde_json::to_vec(&j).unwrap()).is_err(), "missing interval");
        for bad in [serde_json::json!(0), serde_json::json!(-1), serde_json::json!(1.5), serde_json::json!("10"), serde_json::json!(null)] {
            let mut j = trusted_json(); j["intermediateBlockInterval"] = bad.clone();
            assert!(parse_trusted(&serde_json::to_vec(&j).unwrap()).is_err(), "{bad} must refuse");
        }
        let over = br#"{"chainId": 8453, "l1Head": "0x1111111111111111111111111111111111111111111111111111111111111111", "l1HeadNumber": 1,
            "agreedL2OutputRoot": "0x2222222222222222222222222222222222222222222222222222222222222222",
            "claimedL2OutputRoot": "0x3333333333333333333333333333333333333333333333333333333333333333", "claimedL2BlockNumber": 20,
            "rollupConfig": {"x": 1}, "expectedRollupConfigHash": "0x5555555555555555555555555555555555555555555555555555555555555555",
            "expectedScheduleId": "0x4444444444444444444444444444444444444444444444444444444444444444", "intermediateBlockInterval": 18446744073709551616}"#;
        assert!(parse_trusted(over).is_err(), "2^64 must refuse");
        let mut j = trusted_json(); j["intermediateBlockInterval"] = u64::MAX.into();
        assert_eq!(parse_trusted(&serde_json::to_vec(&j).unwrap()).unwrap().intermediate_block_interval.get(), u64::MAX);
    }

    #[test]
    fn interval_is_injected_only_from_the_trusted_input_never_from_the_witness() {
        let k = PreimageKey::new_local(INTERMEDIATE_BLOCK_INTERVAL_KEY.to());
        let w = witness_with(k, 10u64.to_be_bytes().to_vec());
        assert!(refuse_untrusted_key_types(&w).is_err(), "a host-chosen interval (Local key) must refuse");
        let mut fresh = DefaultWitnessData::default();
        assert!(fresh.preimage_store.save_preimage(k, vec![1u8; 8]).is_ok(), "absent before injection");
        let t = trusted();
        let mut w = DefaultWitnessData::default();
        inject_trusted(&mut w, &t).unwrap();
        assert!(w.preimage_store.save_preimage(k, 11u64.to_be_bytes().to_vec()).is_err(), "injected: another value cannot replace it");
    }

    #[test]
    fn result_binds_the_interval_and_roots_ending_at_the_claim() {
        let t = trusted();
        let mut b = boot(&t); b.intermediateBlockInterval = 20;
        assert!(accept(&b, &t).is_err(), "interval mismatch");
        for roots in [vec![], vec![0u8; 33], [t.claimed.as_slice(), B256::repeat_byte(0x77).as_slice()].concat()] {
            let mut b = boot(&t); b.intermediateRoots = roots.into();
            assert!(accept(&b, &t).is_err(), "roots must be whole, non-empty and end at the claim");
        }
        assert!(intermediate_roots_end_at_claim(t.claimed.as_slice(), &t.claimed));
    }

    #[test]
    fn compiled_mainnet_config_hash_is_the_source_pin() {
        let pin = alloy_primitives::b256!("1607709d90d40904f790574404e2ad614eac858f6162faa0ec34c6bf5e5f3c57");
        let cfg = base_common_chains::rollup_config!(8453).expect("compiled Base mainnet rollup config");
        assert_eq!(base_proof_zk_utils::boot::hash_rollup_config(&cfg), pin);
        let round: base_common_genesis::RollupConfig = serde_json::from_value(serde_json::to_value(&cfg).unwrap()).unwrap();
        assert_eq!(base_proof_zk_utils::boot::hash_rollup_config(&round), pin, "serde round trip keeps the hash");
    }

    /// The bridge (derivation-schedule-auth-stage/integration-r2) writes these upstream serde keys, in CONTRACT_VARIANTS order.
    const BRIDGE_SCHEDULE_KEYS: [&str; 15] = ["regolith_time", "canyon_time", "delta_time", "ecotone_time", "fjord_time", "granite_time",
        "holocene_time", "pectra_blob_schedule_time", "isthmus_time", "jovian_time", "base.azul", "base.beryl", "base.cobalt", "base.denim",
        "base.everest"];

    #[test]
    fn bridge_schedule_keys_are_the_upstream_serde_keys_in_contract_order() {
        use base_common_genesis::{BaseUpgrade, RollupConfig};
        let cfg = base_common_chains::rollup_config!(8453).unwrap();
        let mut v = serde_json::to_value(&cfg).unwrap();
        let o = v.as_object_mut().unwrap();
        let base = o.entry("base").or_insert_with(|| serde_json::json!({})).as_object_mut().unwrap();
        for k in ["v1", "v2", "v3"] { base.remove(k); }
        for (i, key) in BRIDGE_SCHEDULE_KEYS.iter().enumerate() {
            let val = serde_json::json!(1_000_000u64 + i as u64);
            match key.strip_prefix("base.") { Some(k) => { v["base"][k] = val; } None => { v[*key] = val; } }
        }
        let set: RollupConfig = serde_json::from_value(v.clone()).unwrap();
        assert_eq!(set.l2_chain_id.id(), 8453);
        for (i, u) in BaseUpgrade::CONTRACT_VARIANTS.iter().enumerate() {
            assert_eq!(set.upgrades.activation_timestamp(*u), Some(1_000_000 + i as u64), "{u:?} <- {}", BRIDGE_SCHEDULE_KEYS[i]);
        }
        for key in BRIDGE_SCHEDULE_KEYS {
            match key.strip_prefix("base.") { Some(k) => { v["base"].as_object_mut().unwrap().remove(k); } None => { v.as_object_mut().unwrap().remove(key); } }
        }
        let none: RollupConfig = serde_json::from_value(v).unwrap();
        for u in BaseUpgrade::CONTRACT_VARIANTS { assert_eq!(none.upgrades.activation_timestamp(u), None, "{u:?} absent -> None (Never)"); }
    }

}
