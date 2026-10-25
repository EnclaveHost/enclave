//! EIP-1898 requireCanonical gate (core/src/client/canonical.rs, round 3: exact ancestry of one fresh head snapshot),
//! with a mock verified provider and the real BlockCache (verifier-canonical-stage; NOT yet compiled).
#[path = "support/canonical_fixture.rs"]
mod fx;

use alloy::eips::BlockNumberOrTag;
use alloy::primitives::B256;
use fx::{blk, hash_id, now, Blk, Mock};
use helios_common::execution_provider::BlockProvider;
use helios_core::client::canonical::check_block_hash;
use helios_core::errors::ClientError;
use helios_core::execution::providers::block::block_cache::BlockCache;
use helios_ethereum::spec::Ethereum;

const FLAGS: [Option<bool>; 3] = [None, Some(false), Some(true)];
async fn gate<E: BlockProvider<Ethereum>>(e: &E, h: B256, f: Option<bool>) -> Result<(), ClientError> { check_block_hash::<Ethereum, _>(e, &hash_id(h, f), now()).await }
fn not_canonical(r: Result<(), ClientError>) { assert!(matches!(r, Err(ClientError::BlockNotCanonical(_))), "{r:?}"); }
/// p9 <- a10 <- a11 <- a12 (head a12, all known by hash; a12 fresh)
fn chain_a(m: &Mock) -> [Blk; 4] {
    let t = now();
    let p = blk(9, 0, B256::ZERO, t - 9); let a10 = blk(10, 1, p.header.hash, t - 6);
    let a11 = blk(11, 1, a10.header.hash, t - 4); let a12 = blk(12, 1, a11.header.hash, t - 2);
    for x in [&p, &a10, &a11] { m.canonical(x); } m.head(&a12);
    [p, a10, a11, a12]
}

#[tokio::test]
async fn gate_true_on_canonical_block_passes() {
    let m = Mock::default(); let [_, a10, _, a12] = chain_a(&m);
    for f in FLAGS { gate(&m, a12.header.hash, f).await.unwrap(); gate(&m, a10.header.hash, f).await.unwrap(); }
}

#[tokio::test]
async fn gate_true_on_known_noncanonical_refuses_not_canonical() {
    let m = Mock::default(); let [p, a10, ..] = chain_a(&m);
    let b10 = blk(10, 2, p.header.hash, now() - 1); m.head(&b10);         // head B10; A10 still known by hash
    not_canonical(gate(&m, a10.header.hash, Some(true)).await);
}

#[tokio::test]
async fn gate_false_and_absent_on_known_noncanonical_pass() {
    let m = Mock::default(); let [p, a10, ..] = chain_a(&m);
    m.head(&blk(10, 2, p.header.hash, now() - 1));
    for f in [None, Some(false)] { gate(&m, a10.header.hash, f).await.unwrap(); }
}

#[tokio::test]
async fn gate_unknown_hash_refused_for_every_flag() {
    let m = Mock::default(); chain_a(&m);
    for f in FLAGS { assert!(matches!(gate(&m, B256::repeat_byte(0x77), f).await, Err(ClientError::BlockNotFound(_))), "{f:?}"); }
}

#[tokio::test]
async fn gate_wrong_block_for_hash_refused_for_every_flag() {
    let m = Mock::default(); let [p, a10, ..] = chain_a(&m);
    m.known(a10.header.hash, &blk(10, 2, p.header.hash, now() - 1));       // hash A10 answered with another block
    for f in FLAGS { assert!(matches!(gate(&m, a10.header.hash, f).await, Err(ClientError::BlockNotFound(_))), "{f:?}"); }
}

#[tokio::test]
async fn gate_true_stale_head_refuses_false_passes() {
    let m = Mock::default(); let [_, a10, ..] = chain_a(&m);
    let later = now() + 600;
    let r = check_block_hash::<Ethereum, _>(&m, &hash_id(a10.header.hash, Some(true)), later).await;
    assert!(matches!(r, Err(ClientError::OutOfSync(_))), "{r:?}");
    for f in [None, Some(false)] { check_block_hash::<Ethereum, _>(&m, &hash_id(a10.header.hash, f), later).await.unwrap(); }
}

#[tokio::test]
async fn gate_true_missing_head_refuses() {
    let m = Mock::default(); let [_, a10, ..] = chain_a(&m);
    *m.latest.lock().unwrap() = None;
    assert!(matches!(gate(&m, a10.header.hash, Some(true)).await, Err(ClientError::OutOfSync(_))));
}

#[tokio::test]
async fn gate_never_uses_height_lookup() {
    let m = Mock::default(); let [_, a10, ..] = chain_a(&m);
    for f in FLAGS { gate(&m, a10.header.hash, f).await.unwrap(); }
    assert_eq!(*m.number_reads.lock().unwrap(), 0, "canonicality is ancestry by hash links, never 'the block at that height'");
}

// ROOT COUNTEREXAMPLE, gate alone: the provider still answers height 11 with A11 (a cache that failed to drop it),
// the head is B10. A11 is above the head and not its ancestor: refused.
#[tokio::test]
async fn gate_root_counterexample_retained_descendant_refused() {
    let m = Mock::default(); let [p, _, a11, _] = chain_a(&m);
    m.head(&blk(10, 2, p.header.hash, now() - 1));                         // by_number[11] = A11 retained on purpose
    not_canonical(gate(&m, a11.header.hash, Some(true)).await);
}

// Another branch BELOW the head: head B12 (p9 <- b10 <- b11 <- b12), and height 10 still answers A10 (stale).
#[tokio::test]
async fn gate_other_branch_below_head_refused_by_ancestry() {
    let m = Mock::default(); let [p, a10, ..] = chain_a(&m); let t = now();
    let b10 = blk(10, 2, p.header.hash, t - 3); let b11 = blk(11, 2, b10.header.hash, t - 2); let b12 = blk(12, 2, b11.header.hash, t - 1);
    m.known(b10.header.hash, &b10); m.known(b11.header.hash, &b11); m.head(&b12);
    m.by_number.lock().unwrap().insert(10, a10.clone());                    // stale by-height entry below the head
    not_canonical(gate(&m, a10.header.hash, Some(true)).await);
    gate(&m, b10.header.hash, Some(true)).await.unwrap();
}

#[tokio::test]
async fn gate_beyond_window_and_missing_link_refused() {
    let m = Mock::default(); let t = now();
    let old = blk(100, 1, B256::repeat_byte(1), t - 9); m.known(old.header.hash, &old);
    m.head(&blk(400, 1, B256::repeat_byte(2), t - 1));                      // 300 > MAX_CANONICAL_DEPTH below the head
    not_canonical(gate(&m, old.header.hash, Some(true)).await);
    let m2 = Mock::default(); let [_, a10, a11, _] = chain_a(&m2);
    m2.by_hash.lock().unwrap().remove(&a11.header.hash);                    // a link the walk cannot prove
    not_canonical(gate(&m2, a10.header.hash, Some(true)).await);
}

// A forged link: hash A11 is answered with X11 (another hash) whose parent is B10. Without the per-link check the walk
// from head A12 would "prove" B10 canonical.
#[tokio::test]
async fn gate_forged_ancestry_link_refused() {
    let m = Mock::default(); let [p, _, a11, _] = chain_a(&m);
    let b10 = blk(10, 2, p.header.hash, now() - 8); m.known(b10.header.hash, &b10);
    let x11 = blk(11, 9, b10.header.hash, now() - 7);
    m.known(a11.header.hash, &x11);
    not_canonical(gate(&m, b10.header.hash, Some(true)).await);
}

fn push(c: &BlockCache<Ethereum>, b: &Blk) -> impl std::future::Future<Output = ()> + '_ { let b = b.clone(); async move { c.push_block(b, BlockNumberOrTag::Latest.into()).await } }

#[tokio::test]
async fn block_cache_root_counterexample_refused() {
    let c = BlockCache::<Ethereum>::new(); let t = now();
    let p = blk(9, 0, B256::ZERO, t - 9); let a10 = blk(10, 1, p.header.hash, t - 6); let a11 = blk(11, 1, a10.header.hash, t - 4);
    let a12 = blk(12, 1, a11.header.hash, t - 3); let b10 = blk(10, 2, p.header.hash, t - 1);
    for x in [&p, &a10, &a11, &a12, &b10] { push(&c, x).await; }
    for f in FLAGS { assert!(gate(&c, a11.header.hash, f).await.is_err(), "{f:?}: A11 must not answer after B10"); }
    gate(&c, b10.header.hash, Some(true)).await.unwrap();
}

#[tokio::test]
async fn reorg_during_read_refuses_at_post_check() {
    let c = BlockCache::<Ethereum>::new(); let t = now();
    let p = blk(9, 0, B256::ZERO, t - 4); let a = blk(10, 1, p.header.hash, t - 2); let b = blk(10, 2, p.header.hash, t - 1);
    push(&c, &p).await; push(&c, &a).await;
    gate(&c, a.header.hash, Some(true)).await.unwrap();                     // pre
    push(&c, &b).await;                                                     // reorg A -> B during the read
    assert!(c.get_block(hash_id(a.header.hash, None), false).await.unwrap().is_none(), "the read by A's hash finds nothing (never B)");
    assert!(gate(&c, a.header.hash, Some(true)).await.is_err());            // post
}

#[tokio::test]
async fn aba_during_read_answers_a_and_post_check_passes() {
    let c = BlockCache::<Ethereum>::new(); let t = now();
    let p = blk(9, 0, B256::ZERO, t - 4); let a = blk(10, 1, p.header.hash, t - 2); let b = blk(10, 2, p.header.hash, t - 1);
    push(&c, &p).await; push(&c, &a).await;
    gate(&c, a.header.hash, Some(true)).await.unwrap();
    push(&c, &b).await; push(&c, &a).await;                                 // A, B, A
    let read = c.get_block(hash_id(a.header.hash, None), false).await.unwrap().expect("A again");
    assert_eq!(read.header.hash, a.header.hash);
    gate(&c, a.header.hash, Some(true)).await.unwrap();
}

#[tokio::test]
async fn concurrent_head_advance_keeps_ancestor_and_reorg_refuses() {
    let c = BlockCache::<Ethereum>::new(); let t = now();
    let p = blk(9, 0, B256::ZERO, t - 5); let a10 = blk(10, 1, p.header.hash, t - 4); let a11 = blk(11, 1, a10.header.hash, t - 2);
    let b10 = blk(10, 2, p.header.hash, t - 1);
    push(&c, &p).await; push(&c, &a10).await;
    gate(&c, a10.header.hash, Some(true)).await.unwrap();                   // pre, head A10
    push(&c, &a11).await;                                                   // head advances
    gate(&c, a10.header.hash, Some(true)).await.unwrap();                   // A10 is an ancestor of the new head
    push(&c, &b10).await;                                                   // reorg below
    assert!(gate(&c, a10.header.hash, Some(true)).await.is_err());
}

// STRUCTURAL (source text, not behaviour; node_canonical_methods drives 8 of these methods for real).
#[test]
fn every_block_id_method_is_gated_before_and_after() {
    let src = include_str!("../src/client/node.rs");
    for m in ["call", "estimate_gas", "create_access_list", "get_balance", "get_nonce", "get_code", "get_storage_at",
              "get_proof", "get_block", "get_block_receipts", "get_transaction_by_block_and_index"] {
        let start = src.find(&format!("    async fn {m}(")).unwrap_or_else(|| panic!("{m} not found"));
        let rest = &src[start + 10..];
        let body = &src[start..start + 10 + rest.find("\n    async fn ").unwrap_or(rest.len())];
        assert!(body.contains("self.check_block_id(&block"), "{m}: no pre-check");
        assert!(body.contains("self.recheck_canonical(&block"), "{m}: no post-check");
    }
}
