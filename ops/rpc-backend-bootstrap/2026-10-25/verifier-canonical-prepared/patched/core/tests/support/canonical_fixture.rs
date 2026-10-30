//! Shared fixtures for the canonical-block tests (verifier-canonical-stage; NOT yet compiled): Ethereum blocks with
//! real header hashes, and a mock verified BlockProvider whose by-hash and by-number answers can disagree (a known but
//! non-canonical block, a wrong block for a hash, "the canonical block at that height is another chain").
#![allow(dead_code)]
use std::collections::HashMap;
use std::sync::Mutex;

use alloy::eips::{BlockId, BlockNumberOrTag};
use alloy::primitives::B256;
use alloy::rpc::types::{Block, Transaction};
use async_trait::async_trait;
use eyre::Result;
use helios_common::execution_provider::BlockProvider;
use helios_ethereum::spec::Ethereum;

pub type Blk = Block<Transaction>;

/// A block at `number` with `parent`, distinguished by `salt`, timestamped `ts`; its hash is its real header hash.
pub fn blk(number: u64, salt: u8, parent: B256, ts: u64) -> Blk {
    let mut b = Blk::default();
    b.header.number = number;
    b.header.parent_hash = parent;
    b.header.timestamp = ts;
    b.header.extra_data = vec![salt].into();
    b.header.hash = b.header.hash_slow();
    b
}
pub fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() }
pub fn hash_id(h: B256, require_canonical: Option<bool>) -> BlockId {
    BlockId::Hash(alloy::eips::eip1898::RpcBlockHash { block_hash: h, require_canonical })
}

#[derive(Default)]
pub struct Mock {
    pub by_hash: Mutex<HashMap<B256, Blk>>,     // what a hash lookup answers (may be a wrong block, on purpose)
    pub by_number: Mutex<HashMap<u64, Blk>>,    // the verified canonical block at a height
    pub latest: Mutex<Option<Blk>>,
    pub number_reads: Mutex<u32>,
}
impl Mock {
    pub fn known(&self, key: B256, b: &Blk) { self.by_hash.lock().unwrap().insert(key, b.clone()); }
    pub fn canonical(&self, b: &Blk) { self.by_number.lock().unwrap().insert(b.header.number, b.clone()); self.known(b.header.hash, b); }
    pub fn head(&self, b: &Blk) { self.canonical(b); *self.latest.lock().unwrap() = Some(b.clone()); }
}
#[async_trait]
impl BlockProvider<Ethereum> for Mock {
    async fn push_block(&self, _b: Blk, _id: BlockId) {}
    async fn get_block(&self, id: BlockId, _full: bool) -> Result<Option<Blk>> {
        Ok(match id {
            BlockId::Hash(h) => self.by_hash.lock().unwrap().get(&h.block_hash).cloned(),
            BlockId::Number(BlockNumberOrTag::Latest) => self.latest.lock().unwrap().clone(),
            BlockId::Number(BlockNumberOrTag::Number(n)) => { *self.number_reads.lock().unwrap() += 1; self.by_number.lock().unwrap().get(&n).cloned() }
            _ => None,
        })
    }
    async fn get_untrusted_block(&self, _id: BlockId, _full: bool) -> Result<Option<Blk>> { Ok(None) }
}
