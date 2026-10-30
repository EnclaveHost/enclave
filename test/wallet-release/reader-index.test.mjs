import test from 'node:test';
import assert from 'node:assert/strict';
const { viemReader } = await import(process.env.WALLET_READER_MODULE || '../../site/js/core/wallet-release-chain.js');
const hash='0x'+'ab'.repeat(32), bh='0x'+'cd'.repeat(32), other='0x'+'ef'.repeat(32);
function fixture(change={}) {
 const calls=[];
 const receipt={transactionHash:hash,blockHash:bh,blockNumber:42n,transactionIndex:1,status:'success',...change.receipt};
 const tx={hash,blockHash:bh,blockNumber:42n,transactionIndex:1,input:'0x1234',to:null,...change.tx};
 const block={hash:bh,number:42n,transactions:[other,hash],...change.block};
 const pc={
  async getTransaction(q){ calls.push(['tx',q]); if(q.hash) { if(change.directError)throw change.directError; if(change.direct)return tx; throw Error('Transaction could not be found'); } if(change.indexMissing)throw Error('Transaction could not be found');return tx; },
  async getTransactionReceipt(){calls.push(['receipt']);return change.noReceipt?null:receipt;},
  async getBlock(q){calls.push(['block',q]);return q.blockNumber!==undefined&&change.reorg?{...block,hash:other}:block;},
 };
 return {reader:viemReader(pc),calls,tx};
}
test('same-provider missing hash lookup recovers exact block-index transaction',async()=>{
 const f=fixture();assert.deepEqual(await f.reader.tx(hash),f.tx);
 assert.equal(f.calls.filter(x=>x[0]==='tx').length,2);
 assert.deepEqual(f.calls.find(x=>x[0]==='tx'&&!x[1].hash)[1],{blockHash:bh,index:1});
 assert.ok(f.calls.some(x=>x[0]==='block'&&x[1].blockNumber===42n));
});
if(!process.env.WALLET_READER_BASELINE){
 test('ordinary hash success performs no extra reads',async()=>{const f=fixture({direct:true});assert.equal(await f.reader.tx(hash),f.tx);assert.equal(f.calls.length,1);});
 test('transport failure does not trigger alternate request',async()=>{const f=fixture({directError:Error('timeout')});await assert.rejects(f.reader.tx(hash),/timeout/);assert.equal(f.calls.length,1);});
 test('missing receipt stays missing',async()=>{const f=fixture({noReceipt:true});assert.equal(await f.reader.tx(hash),null);assert.equal(f.calls.filter(x=>x[0]==='tx').length,1);});
 test('missing indexed transaction stays missing',async()=>{const f=fixture({indexMissing:true});assert.equal(await f.reader.tx(hash),null);});
 for(const [name,change] of Object.entries({
  'wrong receipt hash':{receipt:{transactionHash:other}},
  'negative index':{receipt:{transactionIndex:-1}},
  'fractional index':{receipt:{transactionIndex:1.5}},
  'wrong block hash':{block:{hash:other}},
  'wrong block number':{block:{number:43n}},
  'wrong membership':{block:{transactions:[hash,other]}},
  'wrong indexed hash':{tx:{hash:other}},
  'wrong indexed block':{tx:{blockHash:other}},
  'wrong indexed height':{tx:{blockNumber:43n}},
  'wrong indexed position':{tx:{transactionIndex:0}},
  'canonical reorg':{reorg:true},
 }))test('refuses '+name,async()=>{await assert.rejects(fixture(change).reader.tx(hash));});
}
