//! derivation-witness-stage overlay (PREPARED; NOT built or run by Claude): an EXAMPLE of base-proof-zk-witness (base/base 5476069f,
//! tarball 9784e20a), so Cargo.lock is unchanged. It drives the UPSTREAM host-side witness capture unmodified:
//!   OPSuccinctDataFetcher::from_rpc_config_with_rollup_config -> SuccinctHost::fetch(start, end, Some(l1Head), ..) -> SuccinctHost::run
//! and writes the collected DefaultWitnessData as serde JSON {"preimageStore","blobData"} (this crate has serde_json, not rkyv).
//! The witness and everything the host reports (rollup config, output roots, L1 data) are UNTRUSTED: derivation_harness_v2 strips the
//! recorded Local boot keys and uses only the caller's trusted inputs. This tool never decides anything.
//! Endpoints must be loopback (own L1 EL, own L1 beacon, own Base EL, own Base node); the L1 head hash is the caller's authenticated
//! L1-finalized head (never the host's own L1-head estimate).
//! Usage: witness_fetch <l1_rpc> <l1_beacon> <l2_rpc> <l2_node_rpc> <l2_start> <l2_end> <l1_head_hash> <interval> <out.json>
use std::{num::NonZeroU64, sync::Arc};

use alloy_primitives::B256;
use anyhow::{Result, anyhow, bail};
use base_proof_zk_witness::{
    fetcher::{OPSuccinctDataFetcher, RPCConfig},
    host::SuccinctHost,
};

fn loopback(s: &str) -> Result<reqwest::Url> {
    let u = reqwest::Url::parse(s)?;                         // the fetcher's own Url type (reqwest is a direct dependency)
    let host_ok = matches!(u.host_str(), Some("127.0.0.1") | Some("[::1]") | Some("::1"));
    if u.scheme() != "http" || !host_ok || u.port().is_none() || !u.username().is_empty() || u.password().is_some() {
        bail!("{s}: only http://127.0.0.1:<port> (our own nodes) is accepted");
    }
    Ok(u)
}

fn main() -> Result<()> {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 10 {
        bail!("usage: witness_fetch <l1_rpc> <l1_beacon> <l2_rpc> <l2_node_rpc> <l2_start> <l2_end> <l1_head_hash> <interval> <out.json>");
    }
    let rpc = RPCConfig { l1_rpc: loopback(&a[1])?, l1_beacon_rpc: Some(loopback(&a[2])?), l2_rpc: loopback(&a[3])?, l2_node_rpc: loopback(&a[4])?,
                          l1_config_dir: None, l2_config_dir: None };
    let (start, end): (u64, u64) = (a[5].parse()?, a[6].parse()?);
    if end <= start {
        bail!("l2_end must be above l2_start");
    }
    let l1_head: B256 = a[7].parse().map_err(|e| anyhow!("l1_head_hash: {e}"))?;
    let interval = NonZeroU64::new(a[8].parse()?).ok_or_else(|| anyhow!("interval must be > 0"))?;
    if (end - start) % interval.get() != 0 {
        bail!("the range must span a multiple of the intermediate interval");
    }
    if std::path::Path::new(&a[9]).exists() {
        bail!("{} exists: never overwritten", a[9]);
    }
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
    let witness = rt.block_on(async move {
        let fetcher = OPSuccinctDataFetcher::from_rpc_config_with_rollup_config(rpc).await?;
        let host = SuccinctHost::new(Arc::new(fetcher));
        let cfg = host.fetch(start, end, Some(l1_head), false, None, interval).await?;
        host.run(&cfg).await
    })?;
    let doc = serde_json::json!({ "preimageStore": witness.preimage_store, "blobData": witness.blob_data });
    let tmp = format!("{}.partial", a[9]);
    std::fs::write(&tmp, serde_json::to_vec(&doc)?)?;
    std::fs::rename(&tmp, &a[9])?;
    eprintln!("witness_fetch: {} preimages, {} blobs -> {}", witness.preimage_store.preimage_map.len(), witness.blob_data.blobs.len(), a[9]);
    Ok(())
}
