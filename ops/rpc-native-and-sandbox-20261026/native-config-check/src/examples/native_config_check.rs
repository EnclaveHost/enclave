//! derivation-native-config-check-stage (PREPARED; root runs it): EXACTLY r4's two native-only configuration checks, which the combined
//! harness intentionally omitted, as an isolated EXAMPLE of base-proof-zk-utils in the pinned base/base 5476069f workspace (tarball
//! 9784e20a, Cargo.lock f122da76 unchanged). Source: derivation-client-stage/r4/src/examples/derivation_harness.rs (6554926f), the two
//! tests copied verbatim except ONE compile fix: `rollup_config!(8453)` -> `rollup_config!(8453u64)`. RollupConfigSource is implemented
//! for u64/&u64/Chain/ChainConfig only, so an unsuffixed literal falls back to i32; upstream's own test passes a u64 chain_id
//! (crates/proof/zk/utils/src/boot.rs test_config_hash_matches_nitro_enclave, whose 8453 vector is this same 1607709d...3c57 pin).
//! No network, no witness, no mock: both tests read only the compiled Base mainnet config.

fn main() {
    eprintln!("native_config_check: tests only (cargo test --example native_config_check)");
}

#[cfg(test)]
mod tests {
    #[test]
    fn compiled_mainnet_config_hash_is_the_source_pin() {
        let pin = alloy_primitives::b256!("1607709d90d40904f790574404e2ad614eac858f6162faa0ec34c6bf5e5f3c57");
        let cfg = base_common_chains::rollup_config!(8453u64).expect("compiled Base mainnet rollup config");
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
        let cfg = base_common_chains::rollup_config!(8453u64).unwrap();
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
