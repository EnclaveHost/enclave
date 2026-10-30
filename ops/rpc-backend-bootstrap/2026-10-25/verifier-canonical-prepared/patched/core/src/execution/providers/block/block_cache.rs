use std::collections::BTreeMap;
use std::sync::Arc;

use alloy::consensus::BlockHeader;
use alloy::eips::{BlockId, BlockNumberOrTag};
use alloy::network::{primitives::HeaderResponse, BlockResponse};
use alloy::primitives::B256;
use alloy::rpc::types::BlockTransactions;
use async_trait::async_trait;

use eyre::Result;
use helios_common::{execution_provider::BlockProvider, network_spec::NetworkSpec};
use tokio::sync::RwLock;
use tracing::warn;

use crate::execution::constants::MAX_STATE_HISTORY_LENGTH;

pub struct BlockCache<N: NetworkSpec> {
    latest: Arc<RwLock<Option<N::BlockResponse>>>,
    finalized: Arc<RwLock<Option<N::BlockResponse>>>,
    blocks: Arc<RwLock<BTreeMap<u64, N::BlockResponse>>>,
    hashes: Arc<RwLock<BTreeMap<B256, u64>>>,
    size: usize,
}

impl<N: NetworkSpec> BlockCache<N> {
    pub fn new() -> Self {
        Self {
            latest: Arc::default(),
            finalized: Arc::default(),
            blocks: Arc::default(),
            hashes: Arc::default(),
            size: MAX_STATE_HISTORY_LENGTH,
        }
    }

    /// Clear all cached blocks except the finalized block
    #[allow(dead_code)]
    /// Finalized blocks are preserved since they cannot be reorganized
    async fn clear(&self) {
        let finalized_block = self.finalized.read().await.clone();

        self.blocks.write().await.clear();
        self.hashes.write().await.clear();
        *self.latest.write().await = None;

        // Re-insert finalized block if it exists
        if let Some(finalized) = finalized_block {
            let block_number = finalized.header().number();
            let block_hash = finalized.header().hash();

            self.blocks.write().await.insert(block_number, finalized);
            self.hashes.write().await.insert(block_hash, block_number);
        }
    }
}

impl<N: NetworkSpec> Default for BlockCache<N> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
impl<N: NetworkSpec> BlockProvider<N> for BlockCache<N> {
    async fn get_block(
        &self,
        block_id: BlockId,
        full_tx: bool,
    ) -> Result<Option<N::BlockResponse>> {
        let block = match block_id {
            BlockId::Number(tag) => match tag {
                BlockNumberOrTag::Latest => self.latest.read().await.clone(),
                BlockNumberOrTag::Finalized | BlockNumberOrTag::Safe => {
                    self.finalized.read().await.clone()
                }
                BlockNumberOrTag::Number(number) => self.blocks.read().await.get(&number).cloned(),
                BlockNumberOrTag::Pending | BlockNumberOrTag::Earliest => None,
            },
            BlockId::Hash(hash) => {
                // EXACT hash only: the block at the indexed height must still BE that hash. A hash whose block was
                // replaced by a reorg is unknown (None), never answered with the other block at that height.
                let hash: B256 = hash.into();
                let number = self.hashes.read().await.get(&hash).copied();
                match number {
                    Some(number) => self
                        .blocks
                        .read()
                        .await
                        .get(&number)
                        .filter(|b| b.header().hash() == hash)
                        .cloned(),
                    None => None,
                }
            }
        };

        if !full_tx {
            if let Some(mut block) = block {
                *block.transactions_mut() =
                    BlockTransactions::Hashes(block.transactions().hashes().collect());

                Ok(Some(block))
            } else {
                Ok(None)
            }
        } else {
            Ok(block)
        }
    }

    async fn get_untrusted_block(
        &self,
        _block_id: BlockId,
        _full_tx: bool,
    ) -> Result<Option<<N>::BlockResponse>> {
        Ok(None)
    }

    async fn push_block(&self, block: N::BlockResponse, block_id: BlockId) {
        let block_number = block.header().number();
        let block_hash = block.header().hash();
        let parent_hash = block.header().parent_hash();

        // ONE critical section, locks always in this order (blocks, hashes, latest, finalized): a reader never sees a
        // half-applied reorg (readers take one lock at a time, and a hash lookup re-checks the block's own hash).
        let mut blocks = self.blocks.write().await;
        let mut hashes = self.hashes.write().await;
        let mut latest = self.latest.write().await;
        let mut finalized = self.finalized.write().await;

        // Check if this block builds on top of existing history (unchanged rule)
        let is_consistent = if block_id.is_finalized() || block_number == 0 {
            true
        } else if let Some(parent_block) = blocks.get(&(block_number - 1)) {
            parent_block.header().hash() == parent_hash
        } else if let Some((latest_number, _)) = blocks.last_key_value() {
            *latest_number <= finalized.as_ref().map(|b| b.header().number()).unwrap_or_default()
        } else {
            true
        };
        if !is_consistent {
            warn!("inconsistent block history detected: clearing cache");
            blocks.clear();
            hashes.clear();
            *latest = None;
            if let Some(f) = finalized.clone() {
                hashes.insert(f.header().hash(), f.header().number());
                blocks.insert(f.header().number(), f);
            }
        }

        // A DIFFERENT block at this height (a reorg), or a new LATEST below cached heights: the cached block at this
        // height (another hash) and EVERY cached block above it belong to another branch or are ahead of the head.
        // Drop them with their hashes, so neither a hash nor a height can still answer with a stale descendant.
        let replaced = blocks.get(&block_number).is_some_and(|b| b.header().hash() != block_hash);
        let new_latest = matches!(block_id, BlockId::Number(BlockNumberOrTag::Latest));
        if replaced || new_latest {
            let stale: Vec<u64> = blocks.range(block_number + 1..).map(|(n, _)| *n).collect();
            for n in stale.into_iter().chain(replaced.then_some(block_number)) {
                if let Some(old) = blocks.remove(&n) {
                    hashes.remove(&old.header().hash());
                }
            }
        }

        // Update latest/finalized references
        if let BlockId::Number(tag) = block_id {
            match tag {
                BlockNumberOrTag::Latest => *latest = Some(block.clone()),
                BlockNumberOrTag::Finalized => *finalized = Some(block.clone()),
                _ => (),
            }
        }

        hashes.insert(block_hash, block_number);
        blocks.insert(block_number, block);

        // The latest tag must be a cached block of THIS chain: a finalized block that replaced its branch clears it
        // (fail closed until the next verified head).
        if latest
            .as_ref()
            .is_some_and(|l| blocks.get(&l.header().number()).map(|b| b.header().hash()) != Some(l.header().hash()))
        {
            *latest = None;
        }

        // Maintain cache size limit
        while blocks.len() > self.size {
            let Some((&num, _)) = blocks.first_key_value() else { break };
            if let Some(old) = blocks.remove(&num) {
                hashes.remove(&old.header().hash());
            }
        }
    }
}
