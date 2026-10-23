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
//! * `canonical_head` / `verify_header`: the CANONICAL header of a signed head (Helios's payload conversion plus
//!   Base's three envelope header fields, checked by recomputing the block hash), and an untrusted header bound to an already authenticated hash (alloy `hash_slow`) - for a
//!   block a gateway missed, the parent hash of a verified child authenticates the ancestor's header and state root.
//!
//! Proofs are checked semantically: two providers may encode a valid proof differently, and both pass.

use alloy::consensus::constants::EMPTY_OMMER_ROOT_HASH;
use alloy::eips::eip7685::EMPTY_REQUESTS_HASH;
use alloy::eips::BlockId;
use alloy::primitives::{Address, Bytes, B256};
use alloy::rpc::types::{EIP1186AccountProofResponse, Header as RpcHeader};
use alloy::serde::JsonStorageKey;
use base_common_chains::{ChainUpgrades, Upgrades};
use eyre::{bail, eyre, Result};
use helios_core::execution::proof::{
    verify_account_proof, verify_code_hash_proof, verify_storage_proof,
};
use serde::{Deserialize, Serialize};
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

/// The fork schedule the header rules below follow (base/base v1.5.1 `ChainUpgrades`).
fn upgrades(chain_id: u64) -> Result<ChainUpgrades> {
    match chain_id {
        8453 => Ok(ChainUpgrades::mainnet()),
        84532 => Ok(ChainUpgrades::sepolia()),
        _ => bail!("no Base fork schedule for chain {chain_id}"),
    }
}

/// A verified head with its CANONICAL header. Helios's own `payload_to_block` (the conversion its opstack consensus
/// applies) with the three header fields Base sets from the envelope rather than the payload list, exactly as
/// base/base v1.5.1 does (`BaseExecutionPayloadV4::into_block_raw`: the L2 withdrawals root;
/// `BlockHandler::block_valid`: the envelope's parent beacon block root and, from Isthmus, `EMPTY_REQUESTS_HASH`).
/// alloy's `hash_slow()` of the result must equal the signed payload's block hash, so every header field (such as
/// the state root) is bound to that hash by recomputation, not by assertion; a mismatch is an error.
pub fn canonical_head(
    commitment: &SequencerCommitment,
    signer: Address,
    chain_id: u64,
) -> Result<(VerifiedHead, RpcHeader)> {
    let (head, header, signed) = rebuild_header(commitment, signer, chain_id)?;
    if header.hash != signed || header.hash != head.block_hash {
        bail!(
            "canonical header hash {} is not the signed block hash {signed}",
            header.hash
        );
    }
    Ok((head, header))
}

/// TEST FIXTURES ONLY (never a binding): the header `canonical_head` rebuilds and the signed block hash, WITHOUT
/// requiring them to be equal. A synthetic commitment (e.g. real header fields signed by a test key without the
/// block's transactions) yields a header whose recomputed hash is a synthetic block identity; the caller must label it.
pub fn rebuild_header(
    commitment: &SequencerCommitment,
    signer: Address,
    chain_id: u64,
) -> Result<(VerifiedHead, RpcHeader, B256)> {
    let head = verify_head(commitment, signer, chain_id)?;
    let payload = ExecutionPayload::try_from(commitment)?;
    let (signed, withdrawals_root) = (payload.block_hash, payload.withdrawals_root);
    let mut header = payload_to_block(payload)?.header.inner;
    // signed data = parent beacon block root (32 bytes) || SSZ payload (lib.rs: ExecutionPayload::try_from)
    header.parent_beacon_block_root = Some(B256::from_slice(&commitment.data[..32]));
    if upgrades(chain_id)?.is_isthmus_active_at_timestamp(header.timestamp) {
        header.withdrawals_root = Some(withdrawals_root);
        header.requests_hash = Some(EMPTY_REQUESTS_HASH);
    }
    if header.state_root != head.state_root {
        bail!("rebuilt header state root differs from the verified head");
    }
    let hash = header.hash_slow();
    let rpc = RpcHeader {
        hash,
        inner: header,
        total_difficulty: None,
        size: None,
    };
    Ok((head, rpc, signed))
}

/// The verified child an ancestor header is bound to: its signed (or already bound) parent hash.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Child {
    pub number: u64,
    pub timestamp: u64,
    pub parent_hash: B256,
}

/// An UNTRUSTED header (eth_getBlockByHash/eth_getHeaderByHash JSON; extra block fields are ignored) checked
/// against `expect`: alloy's `hash_slow()` of the decoded consensus header must equal it (and the claimed
/// `hash` field). With `child` (a verified block whose parent hash is `expect`) the header is an
/// authenticated ancestor: one block lower and not later. Base header rules: post-merge constants, a base
/// fee, and from Isthmus the L2 withdrawals root, parent beacon root and empty requests hash.
pub fn verify_header(
    header: &Value,
    expect: B256,
    child: Option<Child>,
    chain_id: u64,
) -> Result<VerifiedHead> {
    let h: RpcHeader =
        serde_json::from_value(header.clone()).map_err(|e| eyre!("malformed header: {e}"))?;
    let hash = h.inner.hash_slow();
    if hash != expect {
        bail!("header hashes to {hash}, not {expect}");
    }
    if h.hash != hash {
        bail!("header claims hash {}, but hashes to {hash}", h.hash);
    }
    let c = &h.inner;
    if c.ommers_hash != EMPTY_OMMER_ROOT_HASH
        || !c.difficulty.is_zero()
        || !c.nonce.is_zero()
        || c.base_fee_per_gas.is_none()
    {
        bail!("not a post-merge OP-stack header");
    }
    if upgrades(chain_id)?.is_isthmus_active_at_timestamp(c.timestamp)
        && (c.withdrawals_root.is_none()
            || c.parent_beacon_block_root.is_none()
            || c.requests_hash != Some(EMPTY_REQUESTS_HASH))
    {
        bail!("header lacks the Isthmus fields");
    }
    if let Some(child) = child {
        if child.parent_hash != hash
            || c.number.checked_add(1) != Some(child.number)
            || c.timestamp > child.timestamp
        {
            bail!(
                "header is not the parent of block {} (number {}, timestamp {})",
                child.number,
                c.number,
                c.timestamp
            );
        }
    }
    Ok(VerifiedHead {
        block_hash: hash,
        parent_hash: c.parent_hash,
        number: c.number,
        timestamp: c.timestamp,
        state_root: c.state_root,
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

    // Block 52965075, the real child of the test object: its signed parent hash, number and timestamp, as recorded by
    // the rpc-peer-audit head listener (tests/fixtures/base-mainnet-52965075.head.json, signer 0xaf6e…9e8a).
    fn child_75() -> Child {
        Child {
            number: 52965075,
            timestamp: 1792719497,
            parent_hash: B256::from_str(
                "0x39aa5527e39d83183030676fd86b70a2ce3fa9d0896e7cfbe19a272d80e9e172",
            )
            .unwrap(),
        }
    }

    #[test]
    fn a_real_base_head_has_a_canonical_header_that_hashes_to_its_signed_block_hash() {
        let (head, header) = canonical_head(&real_commitment(), BASE_SIGNER, 8453).unwrap();
        assert_eq!(header.hash, child_75().parent_hash);
        assert_eq!(header.inner.hash_slow(), head.block_hash);
        assert_eq!(header.inner.state_root, head.state_root);
        assert!(
            header.inner.requests_hash.is_some() && header.inner.parent_beacon_block_root.is_some()
        );
        assert!(
            canonical_head(&real_commitment(), Address::ZERO, 8453).is_err(),
            "wrong signer"
        );
        // the RPC JSON form round-trips: it is an authenticated ancestor of its real child
        let json = serde_json::to_value(&header).unwrap();
        let verified = verify_header(&json, head.block_hash, Some(child_75()), 8453).unwrap();
        assert_eq!(verified, head);
        assert_eq!(
            verify_header(&json, head.block_hash, None, 8453).unwrap(),
            head
        );
    }

    #[test]
    fn untrusted_headers_that_do_not_bind_are_refused() {
        let (head, header) = canonical_head(&real_commitment(), BASE_SIGNER, 8453).unwrap();
        let json = serde_json::to_value(&header).unwrap();
        let h = head.block_hash;
        // tampered state root (hash field left as is), a claimed hash that is not the content hash, another block's hash
        let mut t = json.clone();
        t["stateRoot"] = json!(B256::repeat_byte(1));
        assert!(verify_header(&t, h, Some(child_75()), 8453).is_err());
        let mut t = json.clone();
        t["hash"] = json!(B256::repeat_byte(2));
        assert!(verify_header(&t, h, Some(child_75()), 8453).is_err());
        assert!(verify_header(&json, B256::repeat_byte(3), None, 8453).is_err());
        // the child does not link: another parent hash, a number gap, a parent from the future
        let c = child_75();
        assert!(verify_header(
            &json,
            h,
            Some(Child {
                parent_hash: B256::repeat_byte(4),
                ..c
            }),
            8453
        )
        .is_err());
        assert!(verify_header(
            &json,
            h,
            Some(Child {
                number: c.number + 1,
                ..c
            }),
            8453
        )
        .is_err());
        assert!(verify_header(
            &json,
            h,
            Some(Child {
                timestamp: head.timestamp - 1,
                ..c
            }),
            8453
        )
        .is_err());
        // a malformed header, and a chain without a Base fork schedule
        assert!(verify_header(&json!({ "hash": h }), h, None, 8453).is_err());
        assert!(verify_header(&json, h, None, 10).is_err());
    }

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
