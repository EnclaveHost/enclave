//! EIP-1898 exact-hash semantics of the verified block cache under reorgs (verifier-canonical-stage, NOT yet compiled).
//! A -> B at one height: A's hash no longer resolves (never to B); A -> B -> A (ABA): only the current block's hash
//! resolves; an unknown hash is None; the number lookup follows the current chain only.
use alloy::consensus::Header as ConsensusHeader;
use alloy::eips::{BlockId, BlockNumberOrTag};
use alloy::network::primitives::HeaderResponse;
use alloy::network::BlockResponse;
use alloy::primitives::B256;
use alloy::rpc::types::{Block, Header};
use helios_common::execution_provider::BlockProvider;
use helios_core::execution::providers::block::block_cache::BlockCache;
use helios_ethereum::spec::Ethereum;

fn blk(number: u64, salt: u8, parent: B256) -> Block {
    let inner = ConsensusHeader { number, parent_hash: parent, extra_data: vec![salt].into(), ..Default::default() };
    let hash = inner.hash_slow();
    Block { header: Header { hash, inner, total_difficulty: None, size: None }, ..Default::default() }
}
async fn by_hash(c: &BlockCache<Ethereum>, h: B256) -> Option<B256> {
    c.get_block(BlockId::Hash(h.into()), false).await.unwrap().map(|b| b.header().hash())
}
async fn at(c: &BlockCache<Ethereum>, n: u64) -> Option<B256> {
    c.get_block(BlockNumberOrTag::Number(n).into(), false).await.unwrap().map(|b| b.header().hash())
}

#[tokio::test]
async fn reorg_a_to_b_unindexes_a() {
    let c = BlockCache::<Ethereum>::new();
    let p = blk(9, 0, B256::ZERO);
    c.push_block(p.clone(), BlockNumberOrTag::Latest.into()).await;
    let a = blk(10, 1, p.header.hash);
    c.push_block(a.clone(), BlockNumberOrTag::Latest.into()).await;
    assert_eq!(by_hash(&c, a.header.hash).await, Some(a.header.hash));
    let b = blk(10, 2, p.header.hash);
    c.push_block(b.clone(), BlockNumberOrTag::Latest.into()).await;
    assert_eq!(by_hash(&c, a.header.hash).await, None, "a reorged-away hash must not resolve (and never to B)");
    assert_eq!(by_hash(&c, b.header.hash).await, Some(b.header.hash));
    assert_eq!(at(&c, 10).await, Some(b.header.hash));
    assert_eq!(by_hash(&c, B256::repeat_byte(0x77)).await, None, "unknown hash");
}

#[tokio::test]
async fn aba_resolves_only_the_current_block() {
    let c = BlockCache::<Ethereum>::new();
    let p = blk(9, 0, B256::ZERO);
    c.push_block(p.clone(), BlockNumberOrTag::Latest.into()).await;
    let a = blk(10, 1, p.header.hash);
    let b = blk(10, 2, p.header.hash);
    for x in [&a, &b, &a] { c.push_block((*x).clone(), BlockNumberOrTag::Latest.into()).await; }
    assert_eq!(by_hash(&c, a.header.hash).await, Some(a.header.hash));
    assert_eq!(by_hash(&c, b.header.hash).await, None);
    assert_eq!(at(&c, 10).await, Some(a.header.hash));
}

// Root review (round 3): a reorg at a LOWER height must drop every cached descendant of the old branch.
#[tokio::test]
async fn multi_height_reorg_drops_stale_descendants() {
    let c = BlockCache::<Ethereum>::new();
    let p = blk(9, 0, B256::ZERO);
    let a10 = blk(10, 1, p.header.hash); let a11 = blk(11, 1, a10.header.hash); let a12 = blk(12, 1, a11.header.hash);
    for x in [&p, &a10, &a11, &a12] { c.push_block((*x).clone(), BlockNumberOrTag::Latest.into()).await; }
    let b10 = blk(10, 2, p.header.hash);
    c.push_block(b10.clone(), BlockNumberOrTag::Latest.into()).await;
    for stale in [a10.header.hash, a11.header.hash, a12.header.hash] { assert_eq!(by_hash(&c, stale).await, None, "stale descendant by hash"); }
    assert_eq!(at(&c, 11).await, None, "no stale block at 11"); assert_eq!(at(&c, 12).await, None, "no stale block at 12");
    assert_eq!(at(&c, 10).await, Some(b10.header.hash));
    let latest = c.get_block(BlockNumberOrTag::Latest.into(), false).await.unwrap().map(|b| b.header().hash());
    assert_eq!(latest, Some(b10.header.hash));
}

#[tokio::test]
async fn finalized_conflict_drops_unsafe_branch_and_clears_latest() {
    let c = BlockCache::<Ethereum>::new();
    let p = blk(9, 0, B256::ZERO); let a10 = blk(10, 1, p.header.hash); let a11 = blk(11, 1, a10.header.hash);
    for x in [&p, &a10, &a11] { c.push_block((*x).clone(), BlockNumberOrTag::Latest.into()).await; }
    let f10 = blk(10, 3, p.header.hash);
    c.push_block(f10.clone(), BlockNumberOrTag::Finalized.into()).await;
    assert_eq!(by_hash(&c, a10.header.hash).await, None); assert_eq!(by_hash(&c, a11.header.hash).await, None);
    assert_eq!(at(&c, 10).await, Some(f10.header.hash)); assert_eq!(at(&c, 11).await, None);
    assert!(c.get_block(BlockNumberOrTag::Latest.into(), false).await.unwrap().is_none(), "latest of a replaced branch is cleared (fail closed)");
}
