//! REAL Node per-method behaviour for EIP-1898 hash reads (verifier-canonical-stage, round 3; NOT yet compiled).
//! A real helios_core Node (mock Consensus, as core/tests/sync_readiness.rs) over a mock ExecutionProvider whose blocks
//! are the REAL BlockCache and whose state is keyed by the EXACT block hash it resolved. A scripted chain movement runs
//! DURING each read (after the block was resolved, before the answer), so before / during / after are exercised through
//! the node's real methods: get_balance, get_nonce, get_code, get_storage_at, get_proof, get_block (full),
//! get_block_receipts, get_transaction_by_block_and_index. call / estimate_gas / create_access_list need the EVM over
//! full proven accounts and are NOT driven here (structural test + provider/BLOCKHASH tests only).
#[path = "support/metadata.rs"]
mod metadata;
#[path = "support/canonical_fixture.rs"]
mod fx;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use alloy::consensus::TrieAccount;
use alloy::eips::{BlockId, BlockNumberOrTag};
use alloy::primitives::{Address, Bytes, B256, U256};
use alloy::rpc::types::{Block, EIP1186StorageProof, Filter, Log};
use async_trait::async_trait;
use eyre::{eyre, Result};
use fx::{blk, hash_id, now, Blk};
use helios_common::execution_provider::{
    AccountProvider, BlockProvider, ExecutionHintProvider, ExecutionProvider, LogProvider, ReceiptProvider, TransactionProvider,
};
use helios_common::{network_spec::NetworkSpec, types::Account};
use helios_core::client::{api::HeliosApi, node::Node};
use helios_core::consensus::{Consensus, TrustedBlockRef};
use helios_core::execution::providers::block::block_cache::BlockCache;
use helios_ethereum::spec::Ethereum;
use tokio::sync::{mpsc, watch};

const ADDR: Address = Address::repeat_byte(0xaa);

struct TestConsensus { latest: Option<mpsc::Receiver<TrustedBlockRef<Block>>>, finalized: Option<watch::Receiver<Option<TrustedBlockRef<Block>>>> }
#[async_trait]
impl Consensus<Block> for TestConsensus {
    fn block_recv(&mut self) -> Option<mpsc::Receiver<TrustedBlockRef<Block>>> { self.latest.take() }
    fn finalized_block_recv(&mut self) -> Option<watch::Receiver<Option<TrustedBlockRef<Block>>>> { self.finalized.take() }
    fn checkpoint_recv(&self) -> Option<watch::Receiver<Option<B256>>> { None }
    fn expected_highest_block(&self) -> u64 { 0 }
    fn chain_id(&self) -> u64 { 1 }
    fn shutdown(&self) -> Result<()> { Ok(()) }
    async fn wait_synced(&self) -> Result<()> { Ok(()) }
}

/// Blocks pushed as LATEST during the read (a reorg, an A-B-A flap, or a head advance).
type Plan = Arc<Mutex<Vec<Blk>>>;
struct MockExec { cache: Arc<BlockCache<Ethereum>>, balance: Arc<Mutex<HashMap<B256, U256>>>, plan: Plan }
impl MockExec {
    async fn resolve(&self, id: BlockId) -> Result<Blk> { self.cache.get_block(id, false).await?.ok_or_else(|| eyre!("block not found")) }
    async fn during(&self) {
        let blocks = std::mem::take(&mut *self.plan.lock().unwrap());
        for b in blocks { self.cache.push_block(b, BlockNumberOrTag::Latest.into()).await; }
    }
}
#[async_trait]
impl AccountProvider<Ethereum> for MockExec {
    async fn get_account(&self, _address: Address, slots: &[B256], with_code: bool, block_id: BlockId) -> Result<Account> {
        let b = self.resolve(block_id).await?;                 // the exact block of the request
        self.during().await;                                    // the chain moves while the read is in flight
        let bal = *self.balance.lock().unwrap().get(&b.header.hash).ok_or_else(|| eyre!("no state for this block"))?;
        Ok(Account {
            account: TrieAccount { nonce: b.header.number, balance: bal, ..Default::default() },
            code: with_code.then(|| Bytes::from(b.header.hash.to_vec())),
            account_proof: vec![],
            storage_proof: slots.iter().map(|s| EIP1186StorageProof { key: (*s).into(), value: bal, proof: vec![] }).collect(),
        })
    }
}
#[async_trait]
impl BlockProvider<Ethereum> for MockExec {
    async fn push_block(&self, b: Blk, id: BlockId) { self.cache.push_block(b, id).await }
    async fn get_block(&self, id: BlockId, full: bool) -> Result<Option<Blk>> {
        let r = self.cache.get_block(id, full).await?;
        if full { self.during().await; }                        // only the node's own block read (full_tx) moves the chain
        Ok(r)
    }
    async fn get_untrusted_block(&self, _id: BlockId, _full: bool) -> Result<Option<Blk>> { Ok(None) }
}
#[async_trait]
impl TransactionProvider<Ethereum> for MockExec {
    async fn send_raw_transaction(&self, _bytes: &[u8]) -> Result<B256> { Err(eyre!("unused")) }
    async fn get_transaction(&self, _hash: B256) -> Result<Option<<Ethereum as NetworkSpec>::TransactionResponse>> { Ok(None) }
    async fn get_transaction_by_location(&self, id: BlockId, _index: u64) -> Result<Option<<Ethereum as NetworkSpec>::TransactionResponse>> {
        self.resolve(id).await?; self.during().await; Ok(None)
    }
}
#[async_trait]
impl ReceiptProvider<Ethereum> for MockExec {
    async fn get_receipt(&self, _hash: B256) -> Result<Option<<Ethereum as NetworkSpec>::ReceiptResponse>> { Ok(None) }
    async fn get_block_receipts(&self, id: BlockId) -> Result<Option<Vec<<Ethereum as NetworkSpec>::ReceiptResponse>>> {
        self.resolve(id).await?; self.during().await; Ok(Some(vec![]))
    }
}
#[async_trait]
impl LogProvider<Ethereum> for MockExec { async fn get_logs(&self, _f: &Filter) -> Result<Vec<Log>> { Ok(vec![]) } }
#[async_trait]
impl ExecutionHintProvider<Ethereum> for MockExec {
    async fn get_execution_hint(&self, _c: &<Ethereum as NetworkSpec>::TransactionRequest, _v: bool, _id: BlockId) -> Result<HashMap<Address, Account>> { Err(eyre!("unused")) }
}
impl ExecutionProvider<Ethereum> for MockExec {}

struct H { node: Node<Ethereum, TestConsensus, MockExec>, cache: Arc<BlockCache<Ethereum>>, balance: Arc<Mutex<HashMap<B256, U256>>>, plan: Plan,
           _keep: (mpsc::Sender<TrustedBlockRef<Block>>, watch::Sender<Option<TrustedBlockRef<Block>>>) }
impl H {
    fn new() -> Self {
        let (ls, lr) = mpsc::channel(4); let (fs, fr) = watch::channel(None);
        let cache = Arc::new(BlockCache::<Ethereum>::new()); let balance = Arc::new(Mutex::new(HashMap::new())); let plan: Plan = Arc::default();
        let exec = MockExec { cache: cache.clone(), balance: balance.clone(), plan: plan.clone() };
        let node = Node::new(TestConsensus { latest: Some(lr), finalized: Some(fr) }, exec, metadata::forks());
        Self { node, cache, balance, plan, _keep: (ls, fs) }
    }
    async fn push(&self, b: &Blk) { self.cache.push_block(b.clone(), BlockNumberOrTag::Latest.into()).await }
    fn state(&self, b: &Blk, v: u64) { self.balance.lock().unwrap().insert(b.header.hash, U256::from(v)); }
    fn during(&self, blocks: &[&Blk]) { *self.plan.lock().unwrap() = blocks.iter().map(|b| (*b).clone()).collect(); }
}
/// p9 <- a10 (head, fresh); b10 is a sibling of a10; a11 its child. State: a10 -> 7, b10 -> 9, a11 -> 11.
async fn setup() -> (H, Blk, Blk, Blk) {
    let h = H::new(); let t = now();
    let p = blk(9, 0, B256::ZERO, t - 6); let a10 = blk(10, 1, p.header.hash, t - 4);
    let b10 = blk(10, 2, p.header.hash, t - 1); let a11 = blk(11, 1, a10.header.hash, t - 2);
    h.push(&p).await; h.push(&a10).await; h.state(&a10, 7); h.state(&b10, 9); h.state(&a11, 11);
    (h, a10, b10, a11)
}
/// Every driven method, as one read of `id`: Ok(()) when it answered, Err when it refused.
async fn each_method(h: &H, id: BlockId) -> Vec<(&'static str, Result<(), String>)> {
    let e = |r: Result<(), eyre::Report>| r.map_err(|e| e.to_string());
    let mut out = vec![];
    out.push(("get_balance", e(h.node.get_balance(ADDR, id).await.map(|v| assert_eq!(v, U256::from(7))))));
    out.push(("get_nonce", e(h.node.get_nonce(ADDR, id).await.map(|v| assert_eq!(v, 10)))));
    out.push(("get_code", e(h.node.get_code(ADDR, id).await.map(|_| ()))));
    out.push(("get_storage_at", e(h.node.get_storage_at(ADDR, U256::from(1), id).await.map(|v| assert_eq!(v, B256::from(U256::from(7)))))));
    out.push(("get_proof", e(h.node.get_proof(ADDR, &[B256::from(U256::from(1))], id).await.map(|p| assert_eq!(p.balance, U256::from(7))))));
    out.push(("get_block", e(h.node.get_block(id, true).await.map(|_| ()))));
    out.push(("get_block_receipts", e(h.node.get_block_receipts(id).await.map(|_| ()))));
    out.push(("get_transaction_by_block_and_index", e(h.node.get_transaction_by_block_and_index(id, 0).await.map(|_| ()))));
    out
}
const METHODS: usize = 8;

#[tokio::test]
async fn node_hash_reads_bind_the_exact_block_for_every_flag() {
    let (h, a10, ..) = setup().await;
    for f in [None, Some(false), Some(true)] {
        for (m, r) in each_method(&h, hash_id(a10.header.hash, f)).await { assert!(r.is_ok(), "{m} {f:?}: {r:?}"); }
    }
}

const NAMES: [&str; METHODS] = ["get_balance", "get_nonce", "get_code", "get_storage_at", "get_proof", "get_block",
                                 "get_block_receipts", "get_transaction_by_block_and_index"];
/// One real node method on `id`: true when it REFUSED.
async fn refused(h: &H, m: &str, id: BlockId) -> bool {
    match m {
        "get_balance" => h.node.get_balance(ADDR, id).await.is_err(),
        "get_nonce" => h.node.get_nonce(ADDR, id).await.is_err(),
        "get_code" => h.node.get_code(ADDR, id).await.is_err(),
        "get_storage_at" => h.node.get_storage_at(ADDR, U256::from(1), id).await.is_err(),
        "get_proof" => h.node.get_proof(ADDR, &[B256::ZERO], id).await.is_err(),
        "get_block" => h.node.get_block(id, true).await.is_err(),
        "get_block_receipts" => h.node.get_block_receipts(id).await.is_err(),
        "get_transaction_by_block_and_index" => h.node.get_transaction_by_block_and_index(id, 0).await.is_err(),
        _ => unreachable!(),
    }
}

// Each method alone, with the reorg A10 -> B10 scheduled DURING its own read (after the pre-check passed and the exact
// block was resolved): the post-check must refuse. The plan must be consumed, proving the reorg really ran mid-read.
#[tokio::test]
async fn node_reorg_during_read_refuses_every_method() {
    for m in NAMES {
        let (h, a10, b10, _) = setup().await;
        h.during(&[&b10]);
        assert!(refused(&h, m, hash_id(a10.header.hash, Some(true))).await, "{m}: answered although A10 was reorganized away DURING its read");
        assert!(h.plan.lock().unwrap().is_empty(), "{m}: the reorg did not run during the read");
    }
}

// The same reorg with requireCanonical absent: the exact read itself already found A10 (pre-check), so the answer is A's
// own state; it is not a canonicality claim. Documented semantics, asserted so a change is visible.
#[tokio::test]
async fn node_reorg_during_read_without_require_canonical_answers_exact_a() {
    let (h, a10, b10, _) = setup().await;
    h.during(&[&b10]);
    assert_eq!(h.node.get_balance(ADDR, hash_id(a10.header.hash, None)).await.unwrap(), U256::from(7), "A's own state, never B's");
}

#[tokio::test]
async fn node_aba_during_read_answers_a() {
    let (h, a10, b10, _) = setup().await;
    h.during(&[&b10, &a10]);                                    // A, B, A while reading
    assert_eq!(h.node.get_balance(ADDR, hash_id(a10.header.hash, Some(true))).await.unwrap(), U256::from(7), "A's own state, never B's 9");
}

#[tokio::test]
async fn node_head_advance_during_read_still_answers() {
    let (h, a10, _, a11) = setup().await;
    h.during(&[&a11]);                                          // the head moves forward on A's branch
    assert_eq!(h.node.get_balance(ADDR, hash_id(a10.header.hash, Some(true))).await.unwrap(), U256::from(7));
}

// ROOT COUNTEREXAMPLE through the real node: A10, A11, A12 then B10. A11 must not answer, with any flag.
#[tokio::test]
async fn node_root_counterexample_retained_descendant_refused() {
    let (h, _, b10, a11) = setup().await; let a12 = blk(12, 1, a11.header.hash, now() - 2);
    h.push(&a11).await; h.push(&a12).await; h.state(&a12, 12);
    h.push(&b10).await;                                                       // the reorg to B10
    for f in [None, Some(false), Some(true)] {
        assert!(h.node.get_balance(ADDR, hash_id(a11.header.hash, f)).await.is_err(), "A11 {f:?} answered after the reorg to B10");
    }
    assert_eq!(h.node.get_balance(ADDR, hash_id(b10.header.hash, Some(true))).await.unwrap(), U256::from(9));
}

#[tokio::test]
async fn node_stale_head_refuses_true_only() {
    let h = H::new(); let t = now();
    let p = blk(9, 0, B256::ZERO, t - 900); let a10 = blk(10, 1, p.header.hash, t - 600);   // head 10 minutes old
    h.push(&p).await; h.push(&a10).await; h.state(&a10, 7);
    assert!(h.node.get_balance(ADDR, hash_id(a10.header.hash, Some(true))).await.is_err());
    for f in [None, Some(false)] { assert_eq!(h.node.get_balance(ADDR, hash_id(a10.header.hash, f)).await.unwrap(), U256::from(7)); }
}

#[tokio::test]
async fn node_unknown_hash_refused_for_every_method() {
    let (h, ..) = setup().await;
    for f in [None, Some(false), Some(true)] {
        for (m, r) in each_method(&h, hash_id(B256::repeat_byte(0x77), f)).await { assert!(r.is_err(), "{m} {f:?}"); }
    }
}
