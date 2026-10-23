//! Witness checks for an untrusted execution-witness gateway, built ONLY from the verification Helios itself runs, so a
//! gateway can tell a valid witness from an invalid one before it serves or caches it:
//!
//! * `verify_head`: a sequencer commitment against a pinned signer and chain id (`SequencerCommitment::verify`), decoded
//!   and converted exactly as the opstack consensus client adopts a head (`payload_to_block`). The resulting
//!   (block hash -> state root) binding is the authenticated root every witness for that block is checked against. It
//!   never comes from a witness source.
//! * `verify_get_proof`: an `eth_getProof` answer against that root, bound to the exact request (address, the requested
//!   storage keys and nothing else, the block hash), with Helios's account and storage MPT proof checks.
//! * `verify_get_code`: an `eth_getCode` answer against the code hash of a verified account proof for the same address
//!   and block (Helios's `verify_code_hash_proof`).
//!
//! Proofs are checked semantically: two providers may encode a valid proof differently, and both pass.

use alloy::eips::BlockId;
use alloy::primitives::{Address, Bytes, B256};
use alloy::rpc::types::EIP1186AccountProofResponse;
use alloy::serde::JsonStorageKey;
use eyre::{bail, eyre, Result};
use helios_core::execution::proof::{
    verify_account_proof, verify_code_hash_proof, verify_storage_proof,
};
use serde::Serialize;
use serde_json::Value;

use crate::{consensus::payload_to_block, types::ExecutionPayload, SequencerCommitment};

/// A head that passed the same signature and conversion checks the opstack consensus client applies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedHead {
    pub block_hash: B256,
    pub parent_hash: B256,
    pub number: u64,
    pub timestamp: u64,
    pub state_root: B256,
}

pub fn verify_head(
    commitment: &SequencerCommitment,
    signer: Address,
    chain_id: u64,
) -> Result<VerifiedHead> {
    commitment.verify(signer, chain_id)?;
    let payload = ExecutionPayload::try_from(commitment)?;
    let block = payload_to_block(payload)?;
    Ok(VerifiedHead {
        block_hash: block.header.hash,
        parent_hash: block.header.parent_hash,
        number: block.header.number,
        timestamp: block.header.timestamp,
        state_root: block.header.state_root,
    })
}

/// The block an `eth_getProof`/`eth_getCode` request is pinned to: only a block hash pins a witness.
fn pinned_hash(at: &Value) -> Result<B256> {
    match serde_json::from_value::<BlockId>(at.clone())
        .map_err(|e| eyre!("invalid block id: {e}"))?
    {
        BlockId::Hash(h) => Ok(h.block_hash),
        BlockId::Number(_) => bail!("request is not pinned by block hash"),
    }
}

fn param<'a>(params: &'a [Value], i: usize, n: usize) -> Result<&'a Value> {
    if params.len() != n {
        bail!("expected {n} params, got {}", params.len());
    }
    Ok(&params[i])
}

fn check_block(params: &[Value], block_hash: B256) -> Result<()> {
    let at = pinned_hash(params.last().ok_or_else(|| eyre!("missing block id"))?)?;
    if at != block_hash {
        bail!("request block {at} is not the authenticated block {block_hash}");
    }
    Ok(())
}

/// `params` = [address, [storage keys], blockHash]: the exact request the answer is for.
pub fn verify_get_proof(
    state_root: B256,
    block_hash: B256,
    params: &[Value],
    result: &Value,
) -> Result<EIP1186AccountProofResponse> {
    check_block(params, block_hash)?;
    let address: Address = serde_json::from_value(param(params, 0, 3)?.clone())
        .map_err(|e| eyre!("invalid address: {e}"))?;
    let keys: Vec<JsonStorageKey> = serde_json::from_value(param(params, 1, 3)?.clone())
        .map_err(|e| eyre!("invalid storage keys: {e}"))?;
    let proof: EIP1186AccountProofResponse =
        serde_json::from_value(result.clone()).map_err(|e| eyre!("malformed proof: {e}"))?;

    // Exactly the checks Helios's RpcExecutionProvider::get_account makes ...
    if proof.address != address {
        bail!(
            "proof is for {}, not the requested {address}",
            proof.address
        );
    }
    verify_account_proof(&proof, state_root)?;
    verify_storage_proof(&proof)?;
    // ... and the request binding made exact: the answer proves the requested keys, each once, and nothing else.
    let mut want: Vec<B256> = keys.iter().map(|k| k.as_b256()).collect();
    let mut got: Vec<B256> = proof
        .storage_proof
        .iter()
        .map(|p| p.key.as_b256())
        .collect();
    want.sort();
    got.sort();
    if want != got {
        bail!("storage proofs do not match the requested keys");
    }
    Ok(proof)
}

/// `params` = [address, blockHash]; `account` = a verified account proof for that address at that block (any keys).
pub fn verify_get_code(
    state_root: B256,
    block_hash: B256,
    params: &[Value],
    result: &Value,
    account: &Value,
) -> Result<()> {
    check_block(params, block_hash)?;
    let address: Address = serde_json::from_value(param(params, 0, 2)?.clone())
        .map_err(|e| eyre!("invalid address: {e}"))?;
    let code: Bytes =
        serde_json::from_value(result.clone()).map_err(|e| eyre!("malformed code: {e}"))?;
    let proof: EIP1186AccountProofResponse = serde_json::from_value(account.clone())
        .map_err(|e| eyre!("malformed account proof: {e}"))?;
    if proof.address != address {
        bail!("account proof is for {}, not {address}", proof.address);
    }
    verify_account_proof(&proof, state_root)?;
    // empty code for an account without code; otherwise keccak(code) must equal the proven code hash
    verify_code_hash_proof(&proof, &code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::address;
    use serde_json::json;
    use std::str::FromStr;

    const DATA: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data");

    fn real_commitment() -> SequencerCommitment {
        let bytes = std::fs::read(format!(
            "{DATA}/ec197b9f01acd9b93c900014b5b16142183fc77b559e0e0a727687d171e3e467.v4.snappy"
        ))
        .unwrap();
        SequencerCommitment::new(&bytes).unwrap()
    }
    // Base mainnet's unsafe block signer (the real signer of the test object).
    const BASE_SIGNER: Address = address!("Af6E19BE0F9cE7f8afd49a1824851023A8249e8a");

    #[test]
    fn a_real_base_head_verifies_with_the_real_signer_and_nothing_else() {
        let c = real_commitment();
        let head = verify_head(&c, BASE_SIGNER, 8453).unwrap();
        assert_eq!(head.number, 52965074);
        assert_ne!(head.state_root, B256::ZERO);
        // the commitment's JSON form (what a consensus server's /latest answers) verifies to the same head
        let again: SequencerCommitment =
            serde_json::from_value(serde_json::to_value(&c).unwrap()).unwrap();
        assert_eq!(verify_head(&again, BASE_SIGNER, 8453).unwrap(), head);
        assert!(
            verify_head(&c, Address::ZERO, 8453).is_err(),
            "wrong signer"
        );
        assert!(
            verify_head(&c, BASE_SIGNER, 84532).is_err(),
            "wrong chain id"
        );
    }

    /// The recorded real Base proof (block 52965249, AddressBook 0xab21…0907, no slots) from the base-calls fixture.
    fn recorded() -> (B256, B256, Value) {
        let v: Value = serde_json::from_str(
            &std::fs::read_to_string(format!("{DATA}/witness-check-52965249.json")).unwrap(),
        )
        .unwrap();
        (
            B256::from_str(v["stateRoot"].as_str().unwrap()).unwrap(),
            B256::from_str(v["blockHash"].as_str().unwrap()).unwrap(),
            v,
        )
    }

    #[test]
    fn a_recorded_real_proof_verifies_bound_to_its_exact_request() {
        let (root, hash, v) = recorded();
        let p = &v["getProof"];
        verify_get_proof(root, hash, p["params"].as_array().unwrap(), &p["result"]).unwrap();
        // the bare-hash form alloy sends and the EIP-1898 object form pin the same block
        let mut obj = p["params"].as_array().unwrap().clone();
        obj[2] = json!({ "blockHash": hash });
        verify_get_proof(root, hash, &obj, &p["result"]).unwrap();
    }

    #[test]
    fn invalid_or_unbound_proofs_are_refused() {
        let (root, hash, v) = recorded();
        let p = &v["getProof"];
        let params = p["params"].as_array().unwrap().clone();
        let ok = &p["result"];
        // malformed (root's probe), tampered balance, tampered proof node, wrong root, wrong block, wrong address,
        // an extra unrequested storage proof, a missing requested key, an unpinned request
        assert!(verify_get_proof(
            root,
            hash,
            &params,
            &json!({ "accountProof": "not-an-array" })
        )
        .is_err());
        let mut t = ok.clone();
        t["balance"] = json!("0x1");
        assert!(verify_get_proof(root, hash, &params, &t).is_err());
        let mut t = ok.clone();
        let node = t["accountProof"][0].as_str().unwrap().to_string();
        t["accountProof"][0] = json!(format!(
            "{}{}",
            &node[..node.len() - 2],
            if node.ends_with("00") { "01" } else { "00" }
        ));
        assert!(verify_get_proof(root, hash, &params, &t).is_err());
        assert!(verify_get_proof(B256::repeat_byte(7), hash, &params, ok).is_err());
        assert!(verify_get_proof(root, B256::repeat_byte(7), &params, ok).is_err());
        let mut wrong = params.clone();
        wrong[0] = json!("0x0000000000000000000000000000000000000001");
        assert!(verify_get_proof(root, hash, &wrong, ok).is_err());
        let mut extra = ok.clone();
        extra["storageProof"] = json!([{ "key": "0x0", "value": "0x0", "proof": [] }]);
        assert!(verify_get_proof(root, hash, &params, &extra).is_err());
        let mut more = params.clone();
        more[1] = json!(["0x0"]);
        assert!(verify_get_proof(root, hash, &more, ok).is_err());
        let mut latest = params.clone();
        latest[2] = json!("latest");
        assert!(verify_get_proof(root, hash, &latest, ok).is_err());
    }

    #[test]
    fn recorded_real_code_verifies_against_the_proven_code_hash_only() {
        let (root, hash, v) = recorded();
        let c = &v["getCode"];
        let params = c["params"].as_array().unwrap();
        let account = &v["getProof"]["result"];
        verify_get_code(root, hash, params, &c["result"], account).unwrap();
        let code = c["result"].as_str().unwrap();
        let tampered = json!(format!(
            "{}{}",
            &code[..code.len() - 2],
            if code.ends_with("00") { "01" } else { "00" }
        ));
        assert!(verify_get_code(root, hash, params, &tampered, account).is_err());
        assert!(verify_get_code(root, hash, params, &json!("0x"), account).is_err());
        let mut forged = account.clone();
        forged["codeHash"] = json!(format!("{}", alloy::primitives::keccak256([0u8])));
        assert!(
            verify_get_code(root, hash, params, &json!("0x00"), &forged).is_err(),
            "forged code hash fails the account proof"
        );
    }
}
