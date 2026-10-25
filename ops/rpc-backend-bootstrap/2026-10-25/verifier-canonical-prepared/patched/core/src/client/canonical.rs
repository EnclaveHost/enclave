//! EIP-1898 block-hash gate over the verified BlockProvider (verifier-canonical-stage, round 3; NOT yet compiled).
//! Node::check_block_id delegates here; tests drive it with the real BlockCache, a mock provider and a real Node.
//!
//! A hash BlockId:
//!   * the EXACT block must be known and authenticated: the provider's answer must have that header hash, otherwise
//!     BlockNotFound (a reorged-away or never-seen hash is unknown; it is never translated to a number);
//!   * requireCanonical == Some(true): ONE snapshot of the verified head, fresh (the node's unchanged 60 s rule), and the
//!     requested block must be that head's ANCESTOR-OR-SELF, proven by exact parent-hash links walked down from the head
//!     (each link from the verified cache or the EIP-2935-proven ancestry of the trusted latest block, never a public
//!     RPC). Its height must be <= the head's and within MAX_CANONICAL_DEPTH; anything not provable is
//!     BlockNotCanonical. No "block at that height" lookup is used: a cached block at a height proves nothing;
//!   * requireCanonical None or Some(false) (the EIP-1898 default): the exact authenticated block, no canonicality claim.
//! Callers run this BEFORE and AFTER a read bound to the hash's own state root (BLOCKHASH to its own ancestry,
//! execution::ancestry); each run takes its own fresh head snapshot, so the answer is returned only if the block is on
//! the head chain at the end.
use alloy::eips::{BlockId, BlockNumberOrTag};
use alloy::network::{primitives::HeaderResponse, BlockResponse};
use helios_common::{execution_provider::BlockProvider, network_spec::NetworkSpec};

use crate::errors::ClientError;

/// The node's head-age bound (Node::check_head_age): unchanged.
pub const MAX_HEAD_AGE_SECS: u64 = 60;
/// How far below the head canonicality is proven (the verified block cache window, MAX_STATE_HISTORY_LENGTH). Deeper
/// requests with requireCanonical:true are refused, never assumed.
pub const MAX_CANONICAL_DEPTH: u64 = 256;

/// One snapshot of the verified head: it exists and is at most 60 s old (Node::check_head_age's rule, explicit clock).
pub async fn fresh_head<N: NetworkSpec, E: BlockProvider<N> + ?Sized>(execution: &E, now_secs: u64) -> Result<N::BlockResponse, ClientError> {
    let tag: BlockId = BlockNumberOrTag::Latest.into();
    let head = execution
        .get_block(tag, false)
        .await
        .map_err(|_| ClientError::BlockNotFound(tag))?
        .ok_or(ClientError::OutOfSync(now_secs))?;
    let delay = now_secs.saturating_sub(head.header().timestamp());
    if delay > MAX_HEAD_AGE_SECS {
        return Err(ClientError::OutOfSync(delay));
    }
    Ok(head)
}

pub async fn check_head_age_at<N: NetworkSpec, E: BlockProvider<N> + ?Sized>(execution: &E, now_secs: u64) -> Result<(), ClientError> {
    fresh_head::<N, E>(execution, now_secs).await.map(|_| ())
}

/// The block at `number` on the ancestry of `head`, by exact parent-hash links walked down from `head` (each link: the
/// provider's answer for that hash IS that hash, exactly one height lower). Above the head, deeper than
/// MAX_CANONICAL_DEPTH, or any missing or broken link: BlockNotCanonical(id).
pub async fn ancestor_at<N: NetworkSpec, E: BlockProvider<N> + ?Sized>(execution: &E, head: &N::BlockResponse, number: u64, id: &BlockId) -> Result<N::BlockResponse, ClientError> {
    let top = head.header().number();
    if number > top || top - number > MAX_CANONICAL_DEPTH {
        return Err(ClientError::BlockNotCanonical(*id));
    }
    let mut cur = head.clone();
    while cur.header().number() > number {
        let parent = cur.header().parent_hash();
        let pid: BlockId = BlockId::Hash(parent.into());
        let next = execution
            .get_block(pid, false)
            .await
            .map_err(|_| ClientError::BlockNotCanonical(*id))?
            .ok_or(ClientError::BlockNotCanonical(*id))?;
        if next.header().hash() != parent || next.header().number() + 1 != cur.header().number() {
            return Err(ClientError::BlockNotCanonical(*id));
        }
        cur = next;
    }
    Ok(cur)
}

/// The gate for a hash BlockId (Ok for any other BlockId: tags keep Node::check_blocktag_age).
pub async fn check_block_hash<N: NetworkSpec, E: BlockProvider<N> + ?Sized>(execution: &E, block: &BlockId, now_secs: u64) -> Result<(), ClientError> {
    let BlockId::Hash(h) = block else { return Ok(()) };
    let b = execution
        .get_block(*block, false)
        .await
        .map_err(|_| ClientError::BlockNotFound(*block))?
        .ok_or(ClientError::BlockNotFound(*block))?;
    if b.header().hash() != h.block_hash {
        return Err(ClientError::BlockNotFound(*block));
    }
    if h.require_canonical == Some(true) {
        let head = fresh_head::<N, E>(execution, now_secs).await?;
        let at = ancestor_at::<N, E>(execution, &head, b.header().number(), block).await?;
        if at.header().hash() != h.block_hash {
            return Err(ClientError::BlockNotCanonical(*block));
        }
    }
    Ok(())
}
