//! The real RpcExecutionProvider answers a hash request only with exactly that block (verifier-canonical-stage, round
//! 3; NOT yet compiled). Its block source here answers hash A with block B (the stale-index defect shape); the cache path
//! returns before any RPC, so no server is needed. The node over it refuses too.
#[path = "support/metadata.rs"]
mod metadata;
#[path = "support/canonical_fixture.rs"]
mod fx;

use alloy::primitives::B256;
use fx::{blk, hash_id, now, Mock};
use helios_common::execution_provider::BlockProvider;
use helios_core::execution::providers::rpc::RpcExecutionProvider;
use helios_ethereum::spec::Ethereum;

#[tokio::test]
async fn provider_refuses_a_different_block_for_a_hash() {
    let m = Mock::default(); let t = now();
    let p = blk(9, 0, B256::ZERO, t - 3); let a = blk(10, 1, p.header.hash, t - 2); let b = blk(10, 2, p.header.hash, t - 1);
    m.known(a.header.hash, &b);
    let exec = RpcExecutionProvider::<Ethereum, _, ()>::new("http://127.0.0.1:9".parse().unwrap(), m, metadata::forks());
    for f in [None, Some(false), Some(true)] {
        assert!(exec.get_block(hash_id(a.header.hash, f), false).await.is_err(), "{f:?}: block B answered for hash A");
    }
}

#[tokio::test]
async fn provider_still_answers_the_exact_block() {
    let m = Mock::default(); let t = now();
    let p = blk(9, 0, B256::ZERO, t - 3); let a = blk(10, 1, p.header.hash, t - 2); m.known(a.header.hash, &a);
    let exec = RpcExecutionProvider::<Ethereum, _, ()>::new("http://127.0.0.1:9".parse().unwrap(), m, metadata::forks());
    assert_eq!(exec.get_block(hash_id(a.header.hash, None), false).await.unwrap().map(|x| x.header.hash), Some(a.header.hash));
}
