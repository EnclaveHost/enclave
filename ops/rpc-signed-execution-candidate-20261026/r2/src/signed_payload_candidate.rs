//! ISOLATED CANDIDATE. Conditional one-block execution, never chain authority.
//! The production CLI is deliberately unavailable until a qualified caller and
//! branch policy exist. --offline-candidate accepts caller-owned trust fixtures.
use std::{io::Read, sync::Arc};
use alloy_consensus::{Header, Sealed};
use alloy_eips::eip7685::EMPTY_REQUESTS_HASH;
use alloy_primitives::{Address, B256, Bytes, keccak256};
use anyhow::{Result, anyhow, ensure};
use base_common_consensus::{BaseBlock, BaseTxEnvelope};
use base_common_rpc_types_engine::NetworkPayloadEnvelope;
use base_consensus_derive::{AttributesBuilder, ChainProvider, StatefulAttributesBuilder};
use base_proof::{BaseExecutor, BootInfo, OracleL1ChainProvider, OracleL2ChainProvider, SafeHeadFetcher};
use base_proof_executor::TrieDBProvider;
use base_proof_driver::Executor;
use base_proof_zk_utils::{boot::BootInfoStruct, precompiles::{CustomCrypto, ZkvmBaseEvmFactory},
    witness::preimage_store::WitnessOracle};
use base_protocol::{BatchValidationProvider, L2BlockInfo};
use serde::Deserialize;

#[allow(dead_code, unreachable_pub)]
#[path = "derivation_harness_combined.rs"] mod combined;
#[allow(dead_code, unreachable_pub)]
#[path = "derivation_harness_lease_v3.rs"] mod coverage;

const FORMAT: &str = "enclave-signed-payload-candidate/v1";
const MAX_CONTEXT: usize = 128 << 10;
const MAX_WITNESS: usize = 128 << 20;
const MAX_ENVELOPE: usize = 10 << 20;
const MAX_L1_WALK: u64 = 128;
const MAX_RESULT: usize = 16 << 20;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Context {
    format: String,
    // Exactly the existing ten caller-owned native inputs; no witness local key wins.
    base: serde_json::Value,
    parent_hash: B256,
    parent_number: u64,
    unsafe_signer: Address,
    envelope_keccak: B256,
}

/// Exact prefix equality prevents omitted/reordered deposits and upgrades.
/// The remaining transactions are later decoded/recovered/executed by BaseExecutor.
fn check_prefix(expected: &[Bytes], actual: &[Bytes]) -> Result<()> {
    ensure!(!expected.is_empty(), "authenticated system prefix is empty");
    ensure!(actual.starts_with(expected), "system/deposit/upgrade prefix differs");
    for tx in &actual[expected.len()..] {
        ensure!(!tx.is_empty() && tx[0] != 0x7e, "extra deposit or empty transaction");
    }
    Ok(())
}

fn bind_parent(candidate: &Header, parent: &Header, parent_hash: B256) -> Result<()> {
    ensure!(parent.hash_slow() == parent_hash, "parent hash mismatch");
    ensure!(candidate.parent_hash == parent_hash, "candidate does not extend trusted parent");
    ensure!(parent.number.checked_add(1) == Some(candidate.number), "candidate must be exactly parent+1");
    Ok(())
}

fn bind_executed(expected: &Header, actual: &Header, signed_hash: B256) -> Result<()> {
    ensure!(expected == actual && actual.hash_slow() == signed_hash,
        "computed full header differs from signed payload");
    Ok(())
}

/// No safe/finalized/current-chain assertion is returned. A caller-supplied L1
/// root is a precondition, not a proof of that root's provenance. Production
/// adapter must obtain it from its qualified local capability, never remote JSON.
pub fn evaluate(context: &[u8], witness: &[u8], compressed: &[u8]) -> Result<String> {
    ensure!(context.len() <= MAX_CONTEXT && witness.len() <= MAX_WITNESS && compressed.len() <= MAX_ENVELOPE,
        "input byte limit exceeded");
    let ctx: Context = serde_json::from_slice(context)?;
    ensure!(ctx.format == FORMAT, "wrong context format");
    ensure!(ctx.unsafe_signer != Address::ZERO, "missing caller-pinned signer");
    ensure!(keccak256(compressed) == ctx.envelope_keccak, "envelope digest mismatch");
    let trusted = combined::parse_trusted(&serde_json::to_vec(&ctx.base)?)?;
    ensure!(trusted.interval == 1 && ctx.parent_number.checked_add(1) == Some(trusted.claimed_number),
        "candidate supports one consecutive block only");
    let envelope = NetworkPayloadEnvelope::decode_v4(compressed)?;
    let recovered = envelope.signature.recover_address_from_prehash(
        &envelope.payload_hash.signature_message(trusted.chain_id))?;
    ensure!(recovered == ctx.unsafe_signer, "wrong envelope signer/domain");
    let signed_hash = envelope.payload.block_hash();
    let mut candidate: BaseBlock = envelope.payload.clone().try_into_block::<BaseTxEnvelope>()?;
    candidate.header.parent_beacon_block_root = envelope.parent_beacon_block_root;
    candidate.header.requests_hash = Some(EMPTY_REQUESTS_HASH); // V4 / post-Isthmus only.
    ensure!(candidate.header.hash_slow() == signed_hash, "signed payload blockHash mismatch");
    ensure!(candidate.header.number == trusted.claimed_number, "wrong candidate height");

    let mut w = combined::load_witness(witness)?;
    combined::strip_and_check_untrusted(&mut w)?;
    w.preimage_store.check_preimages().map_err(|e| anyhow!("preimage check: {e}"))?;
    // This path does not derive batches or consume blobs. Reject ignored side inputs.
    ensure!(w.blob_data.blobs.is_empty() && w.blob_data.commitments.is_empty() && w.blob_data.proofs.is_empty(),
        "blob data is unsupported in signed execution candidate");
    combined::inject_trusted(&mut w, &trusted)?;
    let oracle = Arc::new(WitnessOracle::new(w.preimage_store));
    let (boot_values, executed, captured) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        base_proof::block_on(async {
            // No derivation cursor/channel backtracking: this path executes one block.
            let boot = BootInfo::load(oracle.as_ref()).await?;
            let parent_hash = SafeHeadFetcher::fetch(oracle.as_ref(), trusted.agreed).await?;
            ensure!(parent_hash == ctx.parent_hash, "agreed output root names another parent");
            let mut l1 = OracleL1ChainProvider::new(trusted.l1_head, Arc::clone(&oracle));
            let mut l2 = OracleL2ChainProvider::new(parent_hash, Arc::new(boot.rollup_config.clone()), oracle);
            let parent_header = TrieDBProvider::header_by_hash(&l2, parent_hash)?;
            ensure!(parent_header.hash_slow() == parent_hash && parent_header.number == ctx.parent_number, "bootstrap parent differs");
            let pre_number = parent_header.number;
            let parent_mp = parent_header.withdrawals_root.ok_or_else(|| anyhow!("post-Isthmus parent required"))?;
            ensure!(combined::output_root_v0(parent_header.state_root, parent_mp, parent_hash) == trusted.agreed,
                "agreed output root does not bind the full parent header");
            let parent = Sealed::new_unchecked(parent_header, parent_hash);
            let parent_info = l2.l2_block_info_by_hash(parent_hash).await?;
            bind_parent(&candidate.header, parent.inner(), ctx.parent_hash)?;
            ensure!(boot.rollup_config.is_isthmus_active(candidate.header.timestamp), "only post-Isthmus V4 supported");
            let candidate_info = L2BlockInfo::from_block_and_genesis(&candidate, &boot.rollup_config.genesis)?;
            let epoch = candidate_info.l1_origin;
            // Oracle header_by_hash authenticates content, NOT ancestry. Walk from
            // the caller's L1 root explicitly before using origin receipts/config.
            let mut hash = trusted.l1_head;
            let mut header = l1.header_by_hash(hash).await?;
            ensure!(header.hash_slow() == hash && header.number == trusted.l1_head_number, "L1 head differs");
            ensure!(epoch.number <= header.number && header.number - epoch.number <= MAX_L1_WALK,
                "L1 origin outside bounded ancestry");
            while header.number > epoch.number {
                let number = header.number;
                hash = header.parent_hash;
                header = l1.header_by_hash(hash).await?;
                ensure!(header.hash_slow() == hash && header.number.checked_add(1) == Some(number), "broken L1 ancestry");
            }
            ensure!(hash == epoch.hash, "candidate origin is not on caller's L1 branch");
            // Conservative prototype scope: no over-drift empty-block exceptions.
            ensure!(candidate.header.timestamp <= header.timestamp.saturating_add(
                boot.rollup_config.max_sequencer_drift(candidate.header.timestamp)), "over-drift origin unsupported");
            let cfg = Arc::new(boot.rollup_config.clone());
            let mut builder = StatefulAttributesBuilder::new(Arc::clone(&cfg), Arc::new(boot.l1_config.clone()), l2.clone(), l1);
            let mut attributes = builder.prepare_payload_attributes(parent_info, epoch).await?;
            // Use the decoded payload's exact raw transaction bytes, not RPC logs.
            let txs: Vec<Bytes> = envelope.payload.transactions().clone();
            check_prefix(attributes.transactions.as_deref().unwrap_or_default(), &txs)?;
            attributes.transactions = Some(txs.clone());
            revm::precompile::install_crypto(CustomCrypto::default());
            let mut executor = BaseExecutor::new(&cfg, l2.clone(), l2,
                ZkvmBaseEvmFactory::new_with_activation_admin_address(boot.activation_admin_address), None);
            executor.update_safe_head(parent);
            let outcome = executor.execute_payload(attributes).await?;
            bind_executed(&candidate.header, outcome.header.inner(), signed_hash)?;
            let output_root = executor.compute_output_root()?;
            ensure!(output_root == trusted.claimed, "computed output root differs");
            let captured = coverage::CapturedBlock::compact(&cfg, &outcome.header,
                &outcome.execution_result.receipts, &txs, output_root);
            let values = BootInfoStruct::new(boot, pre_number, candidate.header.number, vec![output_root]);
            Ok::<_, anyhow::Error>((values, outcome.header, captured))
        })
    })).map_err(|_| anyhow!("execution aborted: missing/invalid witness or native panic"))??;
    combined::accept(&boot_values, &trusted)?;
    let cov = coverage::build_coverage(ctx.parent_hash, ctx.parent_number, executed.number, 1,
        &boot_values.intermediateRoots, &[captured], MAX_RESULT)?;
    let value = serde_json::json!({"format":FORMAT, "authority":false,
        "meaning":"conditional signed transition execution; not canonicality, freshness, safety or finality",
        "parentHash":ctx.parent_hash,"parentNumber":ctx.parent_number,
        "l1Head":trusted.l1_head,"l1HeadNumber":trusted.l1_head_number,
        "rollupConfigHash":boot_values.rollupConfigHash,"scheduleId":boot_values.scheduleId,
        "envelopeKeccak":ctx.envelope_keccak,"signer":ctx.unsafe_signer,
        "header":executed.inner(),"hash":executed.hash(),"outputRoot":trusted.claimed,"coverage":cov});
    let text = serde_json::to_string(&value)?;
    ensure!(text.len() <= MAX_RESULT, "result exceeds bound; never truncate coverage");
    Ok(text)
}

fn read_bounded(path: &str, max: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?.take((max + 1) as u64).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= max, "file exceeds byte limit");
    Ok(bytes)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let result = (|| -> Result<String> {
        ensure!(args.len() == 5 && args[1] == "--offline-candidate",
            "production qualified-L1/branch adapter unimplemented; use --offline-candidate context.json witness envelope.snappy for conditional evaluation only");
        evaluate(&read_bounded(&args[2], MAX_CONTEXT)?, &read_bounded(&args[3], MAX_WITNESS)?,
            &read_bounded(&args[4], MAX_ENVELOPE)?)
    })();
    match result {
        Ok(text) => println!("{text}"),
        Err(error) => { println!("{}",serde_json::json!({"format":FORMAT,"authority":false,"refused":error.to_string()})); std::process::exit(1); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tx(bytes: &[u8]) -> Bytes { Bytes::copy_from_slice(bytes) }
    #[test] fn prefix_retains_all_system_transactions() {
        let p = vec![tx(&[0x7e,1]),tx(&[0x7e,2])];
        assert!(check_prefix(&p,&[p[0].clone(),p[1].clone(),tx(&[2,3])]).is_ok());
        assert!(check_prefix(&p,&p).is_ok());
    }
    #[test] fn prefix_rejects_omission_reordering_and_extra_deposit() {
        let p = vec![tx(&[0x7e,1]),tx(&[0x7e,2])];
        for a in [vec![p[0].clone()],vec![p[1].clone(),p[0].clone()],vec![p[0].clone(),p[1].clone(),tx(&[0x7e,3])]] {
            assert!(check_prefix(&p,&a).is_err());
        }
        assert!(check_prefix(&[],&[]).is_err());
    }
    #[test] fn every_header_field_is_bound() {
        let h = Header::default(); let hash=h.hash_slow();
        assert!(bind_executed(&h,&h,hash).is_ok());
        let mut mutations=Vec::new();
        let mut x=h.clone();x.state_root=B256::repeat_byte(1);mutations.push(x);
        let mut x=h.clone();x.transactions_root=B256::repeat_byte(1);mutations.push(x);
        let mut x=h.clone();x.receipts_root=B256::repeat_byte(1);mutations.push(x);
        let mut x=h.clone();x.gas_used=1;mutations.push(x);
        for x in mutations {assert!(bind_executed(&h,&x,hash).is_err());}
        assert!(bind_executed(&h,&h,B256::ZERO).is_err());
    }
    #[test] fn consecutive_parent_is_mandatory() {
        let p=Header::default();let hash=p.hash_slow();
        let mut h=Header{number:1,parent_hash:hash,..Default::default()};
        assert!(bind_parent(&h,&p,hash).is_ok());h.number=2;
        assert!(bind_parent(&h,&p,hash).is_err());h.number=1;h.parent_hash=B256::ZERO;
        assert!(bind_parent(&h,&p,hash).is_err());
    }
    #[test] fn unsigned_empty_context_is_not_authority() {
        assert!(evaluate(b"{}",b"{}",b"").is_err());
    }
}
