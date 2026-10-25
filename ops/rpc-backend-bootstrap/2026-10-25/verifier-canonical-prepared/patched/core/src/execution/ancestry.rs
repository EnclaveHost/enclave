//! BLOCKHASH ancestry bound to the PINNED block (verifier-canonical-stage; NOT yet compiled). revm-utils ProofDB uses
//! this instead of "the canonical block at that height now": the walk follows parent hashes from the pinned block with
//! exact-hash reads (each link: hash and height + 1), so a reorg flap between reads cannot mix another chain's ancestor
//! into a run pinned to this block. Only revm's 256-block window is served; a broken or unknown link refuses.
use alloy::consensus::BlockHeader;
use alloy::eips::{eip1898::RpcBlockHash, BlockId};
use alloy::network::{primitives::HeaderResponse, BlockResponse};
use alloy::primitives::B256;
use eyre::{eyre, Result};
use helios_common::{execution_provider::BlockProvider, network_spec::NetworkSpec};

pub const BLOCKHASH_WINDOW: u64 = 256;

pub async fn ancestor_block_hash<N: NetworkSpec, E: BlockProvider<N> + ?Sized>(execution: &E, pinned: RpcBlockHash, number: u64) -> Result<B256> {
    let pinned_id: BlockId = pinned.into();
    let mut cur = execution
        .get_block(pinned_id, false)
        .await?
        .ok_or_else(|| eyre!("pinned block {} not found", pinned.block_hash))?;
    if cur.header().hash() != pinned.block_hash {
        return Err(eyre!("pinned block {} answered by {}", pinned.block_hash, cur.header().hash()));
    }
    let top = cur.header().number();
    if number >= top || top - number > BLOCKHASH_WINDOW {
        return Err(eyre!("BLOCKHASH {number} outside the {BLOCKHASH_WINDOW}-block window of block {top}"));
    }
    while cur.header().number() > number {
        let parent = cur.header().parent_hash();
        let next = execution
            .get_block(BlockId::Hash(parent.into()), false)
            .await?
            .ok_or_else(|| eyre!("ancestor {parent} of {} not found", pinned.block_hash))?;
        if next.header().hash() != parent || next.header().number() + 1 != cur.header().number() {
            return Err(eyre!("ancestry of {} broken at height {}", pinned.block_hash, next.header().number()));
        }
        cur = next;
    }
    Ok(cur.header().hash())
}
