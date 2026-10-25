//! BLOCKHASH ancestry bound to the pinned block (core/src/execution/ancestry.rs, used by revm-utils ProofDB)
//! (verifier-canonical-stage; NOT yet compiled).
#[path = "support/canonical_fixture.rs"]
mod fx;

use alloy::eips::{eip1898::RpcBlockHash, BlockNumberOrTag};
use alloy::primitives::B256;
use fx::{blk, now, Mock};
use helios_common::execution_provider::BlockProvider;
use helios_core::execution::ancestry::ancestor_block_hash;
use helios_core::execution::providers::block::block_cache::BlockCache;
use helios_ethereum::spec::Ethereum;

fn pin(h: B256) -> RpcBlockHash { RpcBlockHash { block_hash: h, require_canonical: None } }

#[tokio::test]
async fn ancestor_follows_pinned_chain_not_canonical_by_number() {
    let m = Mock::default(); let t = now();
    let g = blk(1, 0, B256::ZERO, t - 9);
    let (a2, b2) = (blk(2, 1, g.header.hash, t - 8), blk(2, 2, g.header.hash, t - 8));
    let a3 = blk(3, 1, a2.header.hash, t - 7);
    m.canonical(&g); m.known(a2.header.hash, &a2); m.known(a3.header.hash, &a3);
    m.canonical(&b2);                // "the canonical block at height 2 now" is the OTHER chain
    assert_eq!(ancestor_block_hash::<Ethereum, _>(&m, pin(a3.header.hash), 2).await.unwrap(), a2.header.hash, "A's own ancestor, never B2");
    assert_eq!(ancestor_block_hash::<Ethereum, _>(&m, pin(a3.header.hash), 1).await.unwrap(), g.header.hash);
    assert_eq!(*m.number_reads.lock().unwrap(), 0, "no height lookup at all");
}

#[tokio::test]
async fn ancestor_refuses_broken_link_and_wrong_pinned_answer() {
    let m = Mock::default(); let t = now();
    let g = blk(1, 0, B256::ZERO, t - 9); let a2 = blk(2, 1, g.header.hash, t - 8); let a3 = blk(3, 1, a2.header.hash, t - 7);
    let other = blk(2, 9, g.header.hash, t - 8);
    m.known(a3.header.hash, &a3); m.known(a2.header.hash, &other);   // the parent hash answered with another block
    assert!(ancestor_block_hash::<Ethereum, _>(&m, pin(a3.header.hash), 2).await.is_err());
    let m2 = Mock::default(); m2.known(a3.header.hash, &a2);           // the pinned hash answered with another block
    assert!(ancestor_block_hash::<Ethereum, _>(&m2, pin(a3.header.hash), 2).await.is_err());
}

#[tokio::test]
async fn ancestor_refuses_unknown_pinned_and_outside_window() {
    let m = Mock::default(); let t = now();
    assert!(ancestor_block_hash::<Ethereum, _>(&m, pin(B256::repeat_byte(5)), 1).await.is_err());
    let top = blk(300, 1, B256::repeat_byte(1), t); m.known(top.header.hash, &top);
    assert!(ancestor_block_hash::<Ethereum, _>(&m, pin(top.header.hash), 300).await.is_err(), "not below the block");
    assert!(ancestor_block_hash::<Ethereum, _>(&m, pin(top.header.hash), 43).await.is_err(), "more than 256 back");
}

#[tokio::test]
async fn ancestor_through_block_cache_after_aba() {
    let c = BlockCache::<Ethereum>::new(); let t = now();
    let g = blk(1, 0, B256::ZERO, t - 9); let a2 = blk(2, 1, g.header.hash, t - 8); let b2 = blk(2, 2, g.header.hash, t - 8);
    let a3 = blk(3, 1, a2.header.hash, t - 7);
    for x in [&g, &a2, &b2, &a2, &a3] { c.push_block(x.clone(), BlockNumberOrTag::Latest.into()).await; }
    assert_eq!(ancestor_block_hash::<Ethereum, _>(&c, pin(a3.header.hash), 2).await.unwrap(), a2.header.hash);
}
