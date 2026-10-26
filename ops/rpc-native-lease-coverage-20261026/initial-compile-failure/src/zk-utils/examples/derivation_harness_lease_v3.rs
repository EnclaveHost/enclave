//! derivation-lease-coverage-stage: native result v3 = the frozen combined-r1 v2 harness (included UNCHANGED as `combined`, sha256
//! faa14271..., every trusted-input/witness/accept/bind_head check and its 9 tests reused) + `coverage`: every block executed in
//! (agreed, claimed] and every lease16 event (Claimed / Renewed / Released, any address) from the receipts THIS run's executor produced.
//! Capture point: the executor outcome inside the derivation loop. The pinned upstream hook (base_proof_driver::Executor) cannot be
//! implemented from this example: its execute_payload takes base_common_rpc_types_engine::BasePayloadAttributes, a crate zk-utils does
//! not depend on, and adding it would change the frozen Cargo.lock. So `advance_to_target` and the body of `WitnessExecutor::run` are
//! copied from upstream 5476069f VERBATIM; the only differences are lines ending in `// v3-capture` (insertions). The build job checks
//! that mechanically (jobs/check_upstream_copy.py) before compiling.
//! Bound before any output: interval 1, range <= 1800, exactly one executed block per number agreed+1..claimed, each extending the
//! previous (parent hash, starting at the agreed safe head), each sealed hash recomputed, each output root (stateRoot, withdrawalsRoot,
//! hash) == the executor's own root == intermediateRoots[i], receipts root (upstream compute_receipts_root) and transactions root
//! (the executed EIP-2718 bytes) == the header's, one receipt per transaction, the last block == the verified executed head.
//! logIndex counts every log in the block; txHash = keccak256 of the executed transaction bytes. No RPC or witness log metadata is
//! read. Size caps refuse; matching logs are never dropped. Trusted input keys are unchanged (exactly combined's 10).
//! Usage: derivation_harness_lease_v3 <trusted.json> <witness>   exit 0 verified (prints the v3 JSON), 1 refused, 2 usage.
use std::{fmt::Debug, sync::Arc};

use alloy_consensus::{BlockBody, Header, Sealed, proofs::ordered_trie_root_with_encoder};
use alloy_primitives::{Address, B256, Bytes, hex, keccak256};
use alloy_rlp::Decodable;
use anyhow::{Result, anyhow, bail};
use base_common_consensus::{BaseBlock, BaseReceiptEnvelope, BaseTxEnvelope, OpTxType};
use base_common_genesis::RollupConfig;
use base_consensus_derive::{Pipeline, PipelineError, PipelineErrorKind, Signal, SignalReceiver};
use base_proof::{BaseExecutor, BootInfo, IntermediateRootSampler, OracleL2ChainProvider};
use base_proof_driver::{Driver, DriverError, DriverPipeline, DriverResult, Executor, PipelineCursor, TipCursor};
use base_proof_executor::compute_receipts_root;
use base_proof_preimage::{CommsClient, FlushableCache};
use base_proof_zk_utils::{
    BlobStore,
    boot::BootInfoStruct,
    precompiles::{CustomCrypto, ZkvmBaseEvmFactory},
    witness::{
        WitnessData, WitnessExecutor,
        executor::{ensure_derived_block_matches_claim, get_inputs_for_pipeline},
        preimage_store::WitnessOracle,
    },
};
use base_protocol::L2BlockInfo;
use spin::RwLock;
use tracing::{error, info, warn};

#[allow(dead_code, unreachable_pub)]
#[path = "derivation_harness_combined.rs"]
mod combined;
use combined::{ExecutedHead, accept, bind_head, inject_trusted, load_witness, output_root_v0, parse_trusted, result_json, strip_and_check_untrusted};

pub const RESULT_FORMAT_V3: &str = "enclave-base-derivation-result/v3";
pub const COVERAGE_FORMAT: &str = "enclave-lease16-coverage/v1";
pub const FILTER_ID: &str = "lease16-events/v1";
/// The three EnclaveDeployments lease events, exactly as the contract's ABI declares them (checked against the compiled ABI by
/// test_lease_coverage_contract.mjs). topic0 = keccak256(signature).
pub const LEASE16_EVENT_SIGNATURES: [&str; 3] =
    ["Claimed(bytes32,bytes32,address,uint64,uint256)", "Renewed(bytes32,bytes32,uint64,uint256)", "Released(bytes32,bytes32,uint256)"];
pub const MAX_RANGE_BLOCKS: u64 = 1800;
pub const MAX_COVERAGE_BYTES: usize = 16 << 20;
pub const MAX_RESULT_BYTES: usize = 16 << 20;

pub fn lease16_topics() -> [B256; 3] {
    LEASE16_EVENT_SIGNATURES.map(|s| keccak256(s.as_bytes()))
}

fn hx(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

/// A lease16 event from one executed receipt: logIndex counts every log of the block; txHash = keccak256(executed tx bytes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoveredLog {
    pub address: Address,
    pub log_index: u64,
    pub topics: Vec<B256>,
    pub data: Bytes,
    pub tx_hash: B256,
}

/// One executed block, compacted AT CAPTURE TIME (memory stays O(matching logs), not O(all receipts of up to 1800 blocks)): the
/// receipts and transaction bytes are checked against the executed header's roots right here and then dropped. Any failure is kept
/// as `error` and refuses the whole coverage in build_coverage (the derivation loop's own error type cannot carry it).
#[derive(Debug, Clone)]
pub struct CapturedBlock {
    pub header: Sealed<Header>,
    pub output_root: B256,
    pub logs: Vec<CoveredLog>,
    pub error: Option<String>,
}

impl CapturedBlock {
    pub fn compact(cfg: &RollupConfig, header: &Sealed<Header>, receipts: &[BaseReceiptEnvelope], transactions: &[Bytes], output_root: B256) -> Self {
        let h = header.inner();
        let topics = lease16_topics();
        let mut logs = Vec::new();
        let error = if compute_receipts_root(receipts, cfg, h.timestamp) != h.receipts_root {
            Some(format!("executed block #{}: captured receipts do not reproduce receiptsRoot", h.number))
        } else if ordered_trie_root_with_encoder(transactions, |tx, buf| buf.extend_from_slice(tx)) != h.transactions_root {
            Some(format!("executed block #{}: captured transactions do not reproduce transactionsRoot", h.number))
        } else if receipts.len() != transactions.len() {
            Some(format!("executed block #{}: {} receipts for {} transactions", h.number, receipts.len(), transactions.len()))
        } else {
            let mut log_index: u64 = 0;
            for (r, tx) in receipts.iter().zip(transactions) {
                let tx_hash = keccak256(tx);
                for l in r.logs() {
                    if l.data.topics().first().is_some_and(|t| topics.contains(t)) {
                        logs.push(CoveredLog { address: l.address, log_index, topics: l.data.topics().to_vec(), data: l.data.data.clone(), tx_hash });
                    }
                    log_index += 1;
                }
            }
            None
        };
        Self { header: header.clone(), output_root, logs, error }
    }
}

/// The coverage of (agreed, claimed]: refuses unless every check in the header holds. `max_bytes`: MAX_COVERAGE_BYTES in production.
pub fn build_coverage(agreed_hash: B256, agreed_number: u64, claimed_number: u64, interval: u64, roots: &[u8],
    blocks: &[CapturedBlock], max_bytes: usize) -> Result<serde_json::Value> {
    if interval != 1 {
        bail!("lease coverage v1 requires intermediateBlockInterval 1 (got {interval})");
    }
    if claimed_number <= agreed_number || claimed_number - agreed_number > MAX_RANGE_BLOCKS {
        bail!("lease coverage range {agreed_number}..{claimed_number} must be 1..={MAX_RANGE_BLOCKS} blocks");
    }
    let n = (claimed_number - agreed_number) as usize;
    if blocks.len() != n {
        bail!("{} executed blocks captured, the range has {n}", blocks.len());
    }
    if roots.len() != n * 32 {
        bail!("intermediateRoots has {} bytes, not one 32-byte root per block ({n})", roots.len());
    }
    let mut parent = agreed_hash;
    let (mut out_blocks, mut logs) = (Vec::with_capacity(n), Vec::new());
    for (i, b) in blocks.iter().enumerate() {
        let h = b.header.inner();
        let hash = b.header.hash();
        let number = agreed_number + 1 + i as u64;
        if let Some(e) = &b.error {
            bail!("{e}");
        }
        if h.number != number {
            bail!("executed block {i} is #{}, expected #{number}", h.number);
        }
        if h.parent_hash != parent {
            bail!("executed block #{number} does not extend the previous executed block");
        }
        if h.hash_slow() != hash {
            bail!("executed block #{number}: sealed hash is not the header's hash");
        }
        let mp = h.withdrawals_root.ok_or_else(|| anyhow!("executed block #{number} has no withdrawalsRoot (pre-Isthmus)"))?;
        let out = output_root_v0(h.state_root, mp, hash);
        if out != b.output_root {
            bail!("executed block #{number}: the executor's output root is not the header's");
        }
        if out.as_slice() != &roots[i * 32..(i + 1) * 32] {
            bail!("executed block #{number}: output root is not intermediateRoots[{i}]");
        }
        let mut last_index = None;
        for l in &b.logs {
            if last_index.is_some_and(|p| l.log_index <= p) {
                bail!("executed block #{number}: lease logs are not in strictly increasing logIndex order");
            }
            last_index = Some(l.log_index);
            logs.push(serde_json::json!({ "address": hx(l.address.as_slice()), "blockNumber": number, "blockHash": hx(hash.as_slice()),
                "logIndex": l.log_index, "topics": l.topics.iter().map(|t| hx(t.as_slice())).collect::<Vec<_>>(),
                "data": hx(&l.data), "txHash": hx(l.tx_hash.as_slice()) }));
        }
        out_blocks.push(serde_json::json!({ "number": number, "hash": hx(hash.as_slice()), "stateRoot": hx(h.state_root.as_slice()),
            "messagePasserStorageRoot": hx(mp.as_slice()), "outputRoot": hx(out.as_slice()), "receiptsRoot": hx(h.receipts_root.as_slice()),
            "transactionsRoot": hx(h.transactions_root.as_slice()), "timestamp": h.timestamp }));
        parent = hash;
    }
    let cov = serde_json::json!({ "format": COVERAGE_FORMAT, "filterId": FILTER_ID, "fromBlock": agreed_number + 1, "toBlock": claimed_number,
        "blocks": out_blocks, "logs": logs });
    let size = serde_json::to_vec(&cov)?.len();
    if size > max_bytes {
        bail!("lease coverage is {size} bytes, over the {max_bytes}-byte cap: refused (matching logs are never dropped)");
    }
    Ok(cov)
}

/// The coverage's last block must be the verified executed head (bind_head checked it against the claimed output root).
pub fn coverage_ends_at_head(cov: &serde_json::Value, h: &ExecutedHead) -> Result<()> {
    let last = cov["blocks"].as_array().and_then(|b| b.last()).ok_or_else(|| anyhow!("lease coverage has no blocks"))?;
    if last["number"].as_u64() != Some(h.number) || last["hash"].as_str() != Some(hx(h.hash.as_slice()).as_str()) {
        bail!("lease coverage does not end at the verified executed head");
    }
    Ok(())
}

// BEGIN upstream 5476069f crates/proof/zk/utils/src/client.rs advance_to_target (verbatim; insertions end in `// v3-capture`)
#[allow(clippy::result_large_err)]
pub async fn advance_to_target<E, DP, P>(
    driver: &mut Driver<E, DP, P>,
    cfg: &RollupConfig,
    mut target: Option<u64>,
    mut intermediate_roots: IntermediateRootSampler,
    captured: &mut Vec<CapturedBlock>, // v3-capture
) -> DriverResult<(L2BlockInfo, B256, IntermediateRootSampler), E::Error>
where
    E: Executor + Send + Sync + Debug,
    DP: DriverPipeline<P> + Send + Sync + Debug,
    P: Pipeline + SignalReceiver + Send + Sync + Debug,
{
    loop {
        // Check if we have reached the target block number.
        let pipeline_cursor = driver.cursor.read();
        let tip_cursor = pipeline_cursor.tip();
        if let Some(tb) = target
            && tip_cursor.l2_safe_head.block_info.number >= tb
        {
            info!(target: "client", "Derivation complete, reached L2 safe head.");
            return Ok((
                tip_cursor.l2_safe_head,
                tip_cursor.l2_safe_head_output_root,
                intermediate_roots,
            ));
        }

        #[cfg(target_os = "zkvm")]
        println!("cycle-tracker-report-start: payload-derivation");
        let mut attributes = match driver.pipeline.produce_payload(tip_cursor.l2_safe_head).await {
            Ok(attrs) => attrs.take_inner(),
            Err(PipelineErrorKind::Critical(PipelineError::EndOfSource)) => {
                warn!(target: "client", "Exhausted data source; Halting derivation and using current safe head.");

                // Adjust the target block number to the current safe head, as no more blocks
                // can be produced.
                if target.is_some() {
                    target = Some(tip_cursor.l2_safe_head.block_info.number);
                };

                // If we are in interop mode, this error must be handled by the caller.
                // Otherwise, we continue the loop to halt derivation on the next iteration.
                if cfg.is_isthmus_active(tip_cursor.l2_safe_head.block_info.timestamp) {
                    return Err(PipelineError::EndOfSource.crit().into());
                }
                continue;
            }
            Err(e) => {
                error!(target: "client", error = ?e, "Failed to produce payload");
                return Err(e.into());
            }
        };
        #[cfg(target_os = "zkvm")]
        println!("cycle-tracker-report-end: payload-derivation");

        driver.executor.update_safe_head(tip_cursor.l2_safe_head_header.clone());

        #[cfg(target_os = "zkvm")]
        println!("cycle-tracker-report-start: block-execution");
        let outcome = match driver.executor.execute_payload(attributes.clone()).await {
            Ok(outcome) => outcome,
            Err(e) => {
                error!(target: "client", error = %e, "Failed to execute L2 block");

                if !cfg.is_holocene_active(attributes.payload_attributes.timestamp) {
                    // Pre-Holocene, discard the block if execution fails.
                    continue;
                }

                if !E::is_deposit_only_retryable(&e) {
                    return Err(DriverError::Executor(e));
                }

                // Retry with a deposit-only block.
                warn!(target: "client", "Flushing current channel and retrying deposit only block");

                // Flush the current batch and channel - if a block was replaced with a
                // deposit-only block due to execution failure, the
                // batch and channel it is contained in is forwards
                // invalidated.
                driver.pipeline.signal(Signal::FlushChannel).await?;

                // Strip out all transactions that are not deposits.
                attributes.transactions = attributes.transactions.map(|txs: Vec<Bytes>| {
                    txs.into_iter()
                        .filter(|tx| !tx.is_empty() && tx[0] == OpTxType::Deposit as u8)
                        .collect::<Vec<_>>()
                });

                // Retry the execution.
                driver.executor.update_safe_head(tip_cursor.l2_safe_head_header.clone());
                match driver.executor.execute_payload(attributes.clone()).await {
                    Ok(header) => header,
                    Err(e) => {
                        error!(
                            target: "client",
                            error = %e,
                            "Critical - Failed to execute deposit-only block",
                        );
                        return Err(DriverError::Executor(e));
                    }
                }
            }
        };
        #[cfg(target_os = "zkvm")]
        println!("cycle-tracker-report-end: block-execution");

        // Construct the block.
        let block = BaseBlock {
            header: outcome.header.inner().clone(),
            body: BlockBody {
                transactions: attributes
                    .transactions
                    .as_ref()
                    .unwrap_or(&Vec::new())
                    .iter()
                    .map(|tx: &Bytes| {
                        BaseTxEnvelope::decode(&mut tx.as_ref()).map_err(DriverError::Rlp)
                    })
                    .collect::<DriverResult<Vec<BaseTxEnvelope>, E::Error>>()?,
                ommers: Vec::new(),
                withdrawals: None,
            },
        };

        // Get the pipeline origin and update the tip cursor.
        let origin = driver.pipeline.origin().ok_or(PipelineError::MissingOrigin.crit())?;
        let l2_info =
            L2BlockInfo::from_block_and_genesis(&block, &driver.pipeline.rollup_config().genesis)?;
        let output_root = driver.executor.compute_output_root().map_err(DriverError::Executor)?;
        intermediate_roots.push(output_root);
        captured.push(CapturedBlock::compact(cfg, &outcome.header, &outcome.execution_result.receipts, attributes.transactions.as_deref().unwrap_or_default(), output_root)); // v3-capture
        let tip_cursor = TipCursor::new(l2_info, outcome.header, output_root);

        // Advance the derivation pipeline cursor
        drop(pipeline_cursor);
        driver.cursor.write().advance(origin, tip_cursor);

        // Add forget calls to save cycles
        #[cfg(target_os = "zkvm")]
        std::mem::forget(block);
    }
}
// END upstream advance_to_target

/// `WitnessExecutor::run` as a free function (its signature differs: no `&self`, the oracle type is a parameter, `captured` added).
pub async fn run_capturing<O, DP, P>(
    boot: BootInfo,
    pipeline: DP,
    cursor: Arc<RwLock<PipelineCursor>>,
    l2_provider: OracleL2ChainProvider<O>,
    captured: &mut Vec<CapturedBlock>,
) -> Result<(BootInfo, u64, Vec<B256>)>
where
    O: CommsClient + FlushableCache + Send + Sync + Debug,
    DP: DriverPipeline<P> + Send + Sync + Debug,
    P: Pipeline + SignalReceiver + Send + Sync + Debug,
{
    // BEGIN upstream 5476069f crates/proof/zk/utils/src/witness/executor.rs WitnessExecutor::run body (verbatim; insertions end in `// v3-capture`)
        // Install custom crypto provider for KZG point evaluation precompile
        revm::precompile::install_crypto(CustomCrypto::default());

        let boot_clone = boot.clone();
        let activation_admin_address = boot.activation_admin_address;

        let rollup_config = Arc::new(boot.rollup_config);

        let executor = BaseExecutor::new(
            rollup_config.as_ref(),
            l2_provider.clone(),
            l2_provider,
            ZkvmBaseEvmFactory::new_with_activation_admin_address(activation_admin_address),
            None,
        );
        let mut driver = Driver::new(cursor, executor, pipeline);
        // Run the derivation pipeline until we are able to produce the output root of the claimed
        // L2 block.

        // Use custom advance to target with cycle tracking.
        #[cfg(target_os = "zkvm")]
        println!("cycle-tracker-report-start: block-execution-and-derivation");
        let (safe_head, output_root, intermediate_roots) = advance_to_target(
            &mut driver,
            rollup_config.as_ref(),
            Some(boot.claimed_l2_block_number),
            IntermediateRootSampler::new(boot.intermediate_block_interval),
            captured, // v3-capture
        )
        .await?;
        let intermediate_roots = intermediate_roots.finish()?;
        #[cfg(target_os = "zkvm")]
        println!("cycle-tracker-report-end: block-execution-and-derivation");

        ////////////////////////////////////////////////////////////////
        //                          EPILOGUE                          //
        ////////////////////////////////////////////////////////////////

        let derived_l2_block_number = safe_head.block_info.number;
        ensure_derived_block_matches_claim(derived_l2_block_number, boot.claimed_l2_block_number)?;

        if output_root != boot.claimed_l2_output_root {
            return Err(anyhow!(
                "Failed to validate L2 block #{number} with claimed output root {claimed_output_root}. Got {output_root} instead",
                number = derived_l2_block_number,
                output_root = output_root,
                claimed_output_root = boot.claimed_l2_output_root,
            ));
        }

        info!(
            target: "client",
            block_number = derived_l2_block_number,
            output_root = %output_root,
            "successfully validated L2 block"
        );

        // SAFETY: Inside the zkVM, the process exits after proof generation completes.
        // Dropping `driver` and `rollup_config` triggers deep recursive destructors that
        // waste significant zkVM cycles without benefit, since all memory is reclaimed
        // on process exit. We intentionally leak them to avoid this overhead.
        #[cfg(target_os = "zkvm")]
        {
            std::mem::forget(driver);
            std::mem::forget(rollup_config);
        }

        Ok((boot_clone, derived_l2_block_number, intermediate_roots))
    // END upstream WitnessExecutor::run body
}

/// combined::derive with the capturing run; the range bound is checked BEFORE any block executes.
async fn derive_v3(oracle: Arc<WitnessOracle>, beacon: BlobStore) -> Result<(BootInfoStruct, ExecutedHead, serde_json::Value)> {
    let executor = WitnessExecutor::<WitnessOracle, BlobStore>::new();
    let (boot, input, pre_number) = get_inputs_for_pipeline(Arc::clone(&oracle)).await?;
    if boot.intermediate_block_interval != 1 {
        bail!("lease coverage v1 requires intermediateBlockInterval 1");
    }
    if boot.claimed_l2_block_number <= pre_number || boot.claimed_l2_block_number - pre_number > MAX_RANGE_BLOCKS {
        bail!("lease coverage range must be 1..={MAX_RANGE_BLOCKS} blocks");
    }
    let (cursor, l1_provider, l2_provider) = input;
    let tip_view = Arc::clone(&cursor);
    let agreed_hash = tip_view.read().tip().l2_safe_head_header.hash();
    let pipeline = executor.create_pipeline(Arc::new(boot.rollup_config.clone()), Arc::new(boot.l1_config.clone()), Arc::clone(&cursor),
        oracle, beacon, l1_provider, l2_provider.clone()).await?;
    let mut captured = Vec::new();
    let (boot, number, roots) = run_capturing(boot, pipeline, cursor, l2_provider, &mut captured).await?;
    let tip = tip_view.read().tip().clone();
    let hdr = &tip.l2_safe_head_header;
    let head = ExecutedHead { number: hdr.number, hash: hdr.hash(), state_root: hdr.state_root,
        message_passer_root: hdr.withdrawals_root.ok_or_else(|| anyhow!("executed head has no withdrawalsRoot (pre-Isthmus)"))?, timestamp: hdr.timestamp };
    if tip.l2_safe_head_output_root != output_root_v0(head.state_root, head.message_passer_root, head.hash) {
        bail!("pipeline tip output root is not the executed header's output root");
    }
    let b = BootInfoStruct::new(boot, pre_number, number, roots);
    let cov = build_coverage(agreed_hash, pre_number, number, b.intermediateBlockInterval, &b.intermediateRoots, &captured, MAX_COVERAGE_BYTES)?;
    Ok((b, head, cov))
}

pub fn verify_v3(trusted: &[u8], witness: &[u8]) -> Result<String> {
    let t = parse_trusted(trusted)?;
    if t.interval != 1 {
        bail!("lease coverage v1 requires intermediateBlockInterval 1");
    }
    let mut w = load_witness(witness)?;
    let _stripped_locals = strip_and_check_untrusted(&mut w)?;
    w.preimage_store.check_preimages().map_err(|e| anyhow!("witness preimage: {e}"))?;
    inject_trusted(&mut w, &t)?;
    let (b, h, cov) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        base_proof::block_on(async move {
            let (oracle, beacon) = w.get_oracle_and_blob_provider().await?;
            derive_v3(oracle, beacon).await
        })
    }))
    .map_err(|_| anyhow!("derivation aborted (missing/invalid preimage or blob)"))??;
    accept(&b, &t)?;
    bind_head(&h, &b)?;
    coverage_ends_at_head(&cov, &h)?;
    v3_result_text(&b, &t, &h, cov, MAX_RESULT_BYTES)
}

/// The v2 result with format v3 and the coverage; refused (never truncated) past `max_bytes`.
pub fn v3_result_text(b: &BootInfoStruct, t: &combined::Trusted, h: &ExecutedHead, cov: serde_json::Value, max_bytes: usize) -> Result<String> {
    let mut v = result_json(b, t, h);
    v["format"] = RESULT_FORMAT_V3.into();
    v["coverage"] = cov;
    let s = serde_json::to_string(&v)?;
    if s.len() > max_bytes {
        bail!("v3 result is {} bytes, over the {max_bytes}-byte stdout cap: refused (matching logs are never dropped)", s.len());
    }
    Ok(s)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 3 {
        eprintln!("usage: derivation_harness_lease_v3 <trusted.json> <witness>");
        std::process::exit(2);
    }
    match (|| -> Result<String> { verify_v3(&std::fs::read(&a[1])?, &std::fs::read(&a[2])?) })() {
        Ok(s) => println!("{s}"),
        Err(e) => {
            println!("{}", serde_json::json!({"format": RESULT_FORMAT_V3, "refused": e.to_string()}));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use alloy_consensus::{Eip658Value, Receipt, ReceiptWithBloom};
    use alloy_primitives::{Log, LogData, Sealable, logs_bloom};

    use super::*;

    const AGREED: u64 = 100;

    fn receipt(logs: Vec<Log>) -> BaseReceiptEnvelope {
        let bloom = logs_bloom(logs.iter());
        BaseReceiptEnvelope::Eip1559(ReceiptWithBloom { receipt: Receipt { status: Eip658Value::Eip658(true), cumulative_gas_used: 21_000, logs }, logs_bloom: bloom })
    }
    fn log(addr: u8, topics: Vec<B256>, data: &[u8]) -> Log {
        Log { address: Address::repeat_byte(addr), data: LogData::new_unchecked(topics, Bytes::copy_from_slice(data)) }
    }
    /// One executed block over `parent` whose header commits to exactly these receipts and transaction bytes.
    fn executed(parent: B256, i: usize, block_txs: Vec<Vec<Log>>) -> (Sealed<Header>, Vec<BaseReceiptEnvelope>, Vec<Bytes>, B256) {
        let transactions: Vec<Bytes> = (0..block_txs.len()).map(|j| Bytes::from(vec![0x02, i as u8, j as u8])).collect();
        let receipts: Vec<BaseReceiptEnvelope> = block_txs.into_iter().map(receipt).collect();
        let header = Header { parent_hash: parent, number: AGREED + 1 + i as u64, timestamp: 1_000 + i as u64,
            state_root: B256::repeat_byte(i as u8 + 1), withdrawals_root: Some(B256::repeat_byte(0x77)),
            receipts_root: compute_receipts_root(&receipts, &RollupConfig::default(), 1_000 + i as u64),
            transactions_root: ordered_trie_root_with_encoder(&transactions, |tx, buf| buf.extend_from_slice(tx)), ..Default::default() }
            .seal_slow();
        let output_root = output_root_v0(header.state_root, B256::repeat_byte(0x77), header.hash());
        (header, receipts, transactions, output_root)
    }
    /// A chain of executed blocks over AGREED, captured exactly as the derivation loop does (CapturedBlock::compact).
    fn chain(txs: Vec<Vec<Vec<Log>>>) -> (B256, Vec<CapturedBlock>, Vec<u8>) {
        let agreed = B256::repeat_byte(0xaa);
        let (mut parent, mut out, mut roots) = (agreed, Vec::new(), Vec::new());
        for (i, block_txs) in txs.into_iter().enumerate() {
            let (header, receipts, transactions, output_root) = executed(parent, i, block_txs);
            roots.extend_from_slice(output_root.as_slice());
            parent = header.hash();
            out.push(CapturedBlock::compact(&RollupConfig::default(), &header, &receipts, &transactions, output_root));
        }
        (agreed, out, roots)
    }
    fn cov(agreed: B256, blocks: &[CapturedBlock], roots: &[u8]) -> Result<serde_json::Value> {
        build_coverage(agreed, AGREED, AGREED + blocks.len() as u64, 1, roots, blocks, MAX_COVERAGE_BYTES)
    }
    fn reseal(b: &mut CapturedBlock, f: impl FnOnce(&mut Header)) {
        let mut h = b.header.inner().clone();
        f(&mut h);
        b.header = h.seal_slow();
    }

    #[test]
    fn topics_are_the_lease16_abi_event_hashes() {
        // the same constants relay/lease-generation.mjs and isolation/m2/bootstrap use for the live rev-16d ledger
        let want = ["0xa8cc21eb0ec0b0b7328426babbe37866c627edfd2ae57aeaed4f54abc0534bc0", "0xc3f167f2092d6942fb4264b1759de5eda7eedc20287375c9eddd62e98a560b3e",
            "0x0e334fd11ab7bea6d2bda89338c0f25674e099b70dd28aaaee262fbecba48882"];
        assert_eq!(lease16_topics().map(|t| hx(t.as_slice())), want);
    }

    #[test]
    fn every_block_and_every_matching_log_from_any_address_with_block_log_index_and_executed_tx_hash() {
        let [claimed, renewed, released] = lease16_topics();
        let other = keccak256(b"Transfer(address,address,uint256)");
        let id = B256::repeat_byte(0x11);
        let (agreed, blocks, roots) = chain(vec![
            vec![vec![]],                                                                      // an empty-event block is still covered
            vec![vec![log(1, vec![other], b""), log(2, vec![], b"x")],                         // logIndex 0,1 (not matching, one topicless)
                 vec![log(3, vec![claimed, id, B256::ZERO, B256::ZERO], b"c"), log(4, vec![renewed, id, B256::ZERO], b"r")]],
            vec![vec![log(5, vec![released, id, B256::ZERO], b"z")]],
        ]);
        let c = cov(agreed, &blocks, &roots).unwrap();
        assert_eq!((c["format"].as_str(), c["filterId"].as_str()), (Some(COVERAGE_FORMAT), Some(FILTER_ID)));
        assert_eq!((c["fromBlock"].as_u64(), c["toBlock"].as_u64()), (Some(AGREED + 1), Some(AGREED + 3)));
        let bs = c["blocks"].as_array().unwrap();
        assert_eq!(bs.len(), 3);
        for (i, b) in bs.iter().enumerate() {
            assert_eq!(b["outputRoot"].as_str().unwrap(), hx(&roots[i * 32..(i + 1) * 32]));
            assert_eq!(b["hash"].as_str().unwrap(), hx(blocks[i].header.hash().as_slice()));
            assert_eq!(b["receiptsRoot"].as_str().unwrap(), hx(blocks[i].header.receipts_root.as_slice()));
        }
        let ls = c["logs"].as_array().unwrap();
        assert_eq!(ls.len(), 3, "exactly the three lease16 events");
        assert_eq!((ls[0]["blockNumber"].as_u64(), ls[0]["logIndex"].as_u64()), (Some(AGREED + 2), Some(2)), "logIndex counts every log of the block");
        assert_eq!(ls[1]["logIndex"].as_u64(), Some(3));
        assert_eq!(ls[2]["logIndex"].as_u64(), Some(0));
        assert_eq!(ls[0]["address"].as_str().unwrap(), hx(Address::repeat_byte(3).as_slice()));
        assert_eq!(ls[2]["address"].as_str().unwrap(), hx(Address::repeat_byte(5).as_slice()), "any emitting address");
        let (_, _, txs1, _) = executed(blocks[0].header.hash(), 1, vec![vec![], vec![]]);
        assert_eq!(ls[0]["txHash"].as_str().unwrap(), hx(keccak256(&txs1[1]).as_slice()), "txHash of the executed bytes");
        assert_eq!(ls[0]["blockHash"].as_str().unwrap(), hx(blocks[1].header.hash().as_slice()));
        assert_eq!(ls[0]["data"].as_str(), Some("0x63"));
        assert_eq!(ls[0]["topics"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn gaps_forks_and_unbound_metadata_refuse() {
        let (agreed, blocks, roots) = chain(vec![vec![vec![log(1, vec![lease16_topics()[0]], b"")]], vec![vec![]], vec![vec![]]]);
        assert!(cov(agreed, &blocks, &roots).is_ok());
        // every case keeps the claimed range AGREED+1..=AGREED+3
        let refuse = |name: &str, bs: Vec<CapturedBlock>, rs: Vec<u8>, a: B256| {
            assert!(build_coverage(a, AGREED, AGREED + 3, 1, &rs, &bs, MAX_COVERAGE_BYTES).is_err(), "{name}");
        };
        refuse("missing block", blocks[..2].to_vec(), roots.clone(), agreed);
        refuse("foreign parent", blocks.clone(), roots.clone(), B256::repeat_byte(0xbb));
        // a block replaced by a fork block with its own consistent roots: the next block's parent linkage breaks
        let mut f = blocks.clone(); reseal(&mut f[1], |h| h.state_root = B256::repeat_byte(0x99));
        f[1].output_root = output_root_v0(f[1].header.state_root, B256::repeat_byte(0x77), f[1].header.hash());
        let mut fr = roots.clone(); fr[32..64].copy_from_slice(f[1].output_root.as_slice());
        refuse("fork block", f, fr, agreed);
        // captured receipts / transactions that are not the ones the executed header committed to
        let (h0, r0, t0, o0) = executed(agreed, 0, vec![vec![log(1, vec![lease16_topics()[0]], b"")]]);
        let mut f = blocks.clone(); f[0] = CapturedBlock::compact(&RollupConfig::default(), &h0, &[receipt(vec![])], &t0, o0);
        refuse("dropped log (receipts root)", f, roots.clone(), agreed);
        let mut f = blocks.clone(); f[0] = CapturedBlock::compact(&RollupConfig::default(), &h0, &r0, &[Bytes::from(vec![0x02, 9, 9])], o0);
        refuse("other tx bytes (transactions root)", f, roots.clone(), agreed);
        let mut f = blocks.clone(); f[0] = CapturedBlock::compact(&RollupConfig::default(), &h0, &r0, &[t0[0].clone(), t0[0].clone()], o0);
        refuse("receipt/transaction count", f, roots.clone(), agreed);
        assert!(CapturedBlock::compact(&RollupConfig::default(), &h0, &r0, &t0, o0).error.is_none(), "the honest capture is clean");
        // an intermediate root that is not this block's
        let mut fr = roots.clone(); fr[0] ^= 1;
        refuse("intermediate root", blocks.clone(), fr, agreed);
        // the executor's own output root differs
        let mut f = blocks.clone(); f[2].output_root = B256::ZERO;
        refuse("executor root", f, roots.clone(), agreed);
        // a non-contiguous number with otherwise consistent data
        let mut f = blocks.clone(); reseal(&mut f[0], |h| h.number = AGREED + 5);
        refuse("number gap", f, roots.clone(), agreed);
        // a sealed hash that is not the header's
        let mut f = blocks.clone(); f[2].header = Sealed::new_unchecked(f[2].header.inner().clone(), B256::repeat_byte(3));
        refuse("unsealed", f, roots.clone(), agreed);
        // pre-Isthmus (no message passer root)
        let mut f = blocks.clone(); reseal(&mut f[2], |h| h.withdrawals_root = None);
        refuse("no withdrawalsRoot", f, roots.clone(), agreed);
        // duplicated / reordered lease logs in one block
        let mut f = blocks.clone(); let dup = f[0].logs[0].clone(); f[0].logs.push(dup);
        refuse("duplicate logIndex", f, roots.clone(), agreed);
        refuse("roots length", blocks.clone(), roots[..64].to_vec(), agreed);
    }

    #[test]
    fn interval_range_and_size_caps_refuse_never_truncate() {
        let (agreed, blocks, roots) = chain(vec![vec![vec![log(1, vec![lease16_topics()[1]], &[0u8; 64])]]]);
        assert!(build_coverage(agreed, AGREED, AGREED + 1, 2, &roots, &blocks, MAX_COVERAGE_BYTES).is_err(), "interval 2");
        assert!(build_coverage(agreed, AGREED, AGREED, 1, &[], &[], MAX_COVERAGE_BYTES).is_err(), "empty range");
        assert!(build_coverage(agreed, AGREED, AGREED + MAX_RANGE_BLOCKS + 1, 1, &roots, &blocks, MAX_COVERAGE_BYTES).is_err(), "over 1800");
        let ok = build_coverage(agreed, AGREED, AGREED + 1, 1, &roots, &blocks, MAX_COVERAGE_BYTES).unwrap();
        let size = serde_json::to_vec(&ok).unwrap().len();
        let e = build_coverage(agreed, AGREED, AGREED + 1, 1, &roots, &blocks, size - 1).unwrap_err().to_string();
        assert!(e.contains("never dropped"), "{e}");
        assert!(build_coverage(agreed, AGREED, AGREED + 1, 1, &roots, &blocks, size).is_ok());
    }

    #[test]
    fn v3_result_keeps_every_v2_binding_and_ends_at_the_verified_head() {
        let (agreed, blocks, roots) = chain(vec![vec![vec![]], vec![vec![]]]);
        let c = cov(agreed, &blocks, &roots).unwrap();
        let last = blocks[1].header.inner();
        let h = ExecutedHead { number: last.number, hash: blocks[1].header.hash(), state_root: last.state_root,
            message_passer_root: B256::repeat_byte(0x77), timestamp: last.timestamp };
        assert!(coverage_ends_at_head(&c, &h).is_ok());
        assert!(coverage_ends_at_head(&c, &ExecutedHead { hash: B256::ZERO, ..h.clone() }).is_err(), "another head");
        assert!(coverage_ends_at_head(&c, &ExecutedHead { number: h.number + 1, ..h.clone() }).is_err(), "another number");
        let mut j = serde_json::json!({"chainId": 8453, "l1Head": format!("0x{}", "11".repeat(32)), "l1HeadNumber": 1,
            "agreedL2OutputRoot": format!("0x{}", "22".repeat(32)), "claimedL2OutputRoot": hx(&roots[32..64]),
            "claimedL2BlockNumber": AGREED + 2, "intermediateBlockInterval": 1, "rollupConfig": {"x": 1},
            "expectedRollupConfigHash": format!("0x{}", "55".repeat(32)), "expectedScheduleId": format!("0x{}", "44".repeat(32))});
        let t = parse_trusted(&serde_json::to_vec(&j).unwrap()).unwrap();
        let b = BootInfoStruct { l1Head: t.l1_head, l2PreRoot: t.agreed, l2PostRoot: t.claimed, l2PreBlockNumber: AGREED, l2BlockNumber: t.claimed_number,
            rollupConfigHash: t.expected_config_hash, scheduleId: t.expected_schedule_id, intermediateBlockInterval: 1, intermediateRoots: roots.clone().into() };
        assert!(accept(&b, &t).is_ok() && bind_head(&h, &b).is_ok());
        let s = v3_result_text(&b, &t, &h, c.clone(), MAX_RESULT_BYTES).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["format"].as_str(), Some(RESULT_FORMAT_V3));
        assert_eq!(v["coverage"], c);
        for k in ["l1Head", "agreedL2OutputRoot", "l2OutputRoot", "l2BlockNumber", "rollupConfigHash", "scheduleId", "intermediateBlockInterval",
                  "intermediateRoots", "bootInfoAbi", "bootInfoKeccak", "base"] {
            assert!(v.get(k).is_some(), "v2 field {k} kept");
        }
        assert!(v3_result_text(&b, &t, &h, c, s.len() - 1).is_err(), "stdout cap refuses");
        j["intermediateBlockInterval"] = 2.into();
        let t2 = serde_json::to_vec(&j).unwrap();
        assert!(verify_v3(&t2, b"{}").unwrap_err().to_string().contains("intermediateBlockInterval 1"), "interval 2 refused before any work");
        j["extra"] = 1.into();
        assert!(verify_v3(&serde_json::to_vec(&j).unwrap(), b"{}").is_err(), "still exactly the 10 trusted keys");
    }
}
