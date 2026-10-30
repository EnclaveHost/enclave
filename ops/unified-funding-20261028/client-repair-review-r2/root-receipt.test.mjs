import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalReceipt, receiptFinality} from './lib/funding-client.mjs';
const h='0x'+'11'.repeat(32), other='0x'+'22'.repeat(32), b='0x'+'ab'.repeat(32), z='0x'+'00'.repeat(32);
const good=()=>({transactionHash:h,transactionIndex:'0x0',blockHash:b,blockNumber:'0x10',status:'0x1',logs:[]});
function rpc(rc,block={hash:b,number:'0x10',transactions:[h]}){return async(method)=>method==='eth_getTransactionReceipt'?rc:block;}
test('root: refuses a receipt for another transaction',async()=>{
 await assert.rejects(canonicalReceipt(rpc({...good(),transactionHash:other}),h));
});
test('root: zero block hash preconfirmation is pending even if endpoint echoes it',async()=>{
 assert.equal(await canonicalReceipt(rpc({...good(),blockHash:z},{hash:z,number:'0x10',transactions:[h]}),h),null);
});
test('root: rejects canonical header number mismatch',async()=>{
 await assert.rejects(canonicalReceipt(rpc(good(),{hash:b,number:'0x11',transactions:[h]}),h));
});
test('root: rejects transaction absent from canonical block',async()=>{
 await assert.rejects(canonicalReceipt(rpc(good(),{hash:b,number:'0x10',transactions:[other]}),h));
});
test('root: rejects log for different transaction',async()=>{
 const log={transactionHash:other,blockHash:b,blockNumber:'0x10',transactionIndex:'0x0',logIndex:'0x0',removed:false};
 await assert.rejects(canonicalReceipt(rpc({...good(),logs:[log]}),h));
});
test('root: canonical matching receipt passes',async()=>{
 assert.deepEqual(await canonicalReceipt(rpc(good()),h),good());
});

// ---- client-repair-r2 additions (UNREVIEWED, NOT RUN) ----------------------------------------------------------------
const addr='0x'+'55'.repeat(20), topic='0x'+'77'.repeat(32);
const okLog=(i=0)=>({address:addr,topics:[topic],data:'0x',transactionHash:h,blockHash:b,blockNumber:'0x10',transactionIndex:'0x0',logIndex:'0x'+i.toString(16),removed:false});
const code=(c)=>(e)=>e?.code===c;
test('r2: absent receipt and null block hash/number are pending (null)',async()=>{
 assert.equal(await canonicalReceipt(rpc(null),h),null);
 assert.equal(await canonicalReceipt(rpc({...good(),blockHash:null,blockNumber:null}),h),null);
});
test('r2: header with another hash at the receipt height = reorged out (null)',async()=>{
 assert.equal(await canonicalReceipt(rpc(good(),{hash:'0x'+'cd'.repeat(32),number:'0x10',transactions:[h]}),h),null);
});
test('r2: header not yet visible at the node = pending (null)',async()=>{
 assert.equal(await canonicalReceipt(rpc(good(),null),h),null);
});
test('r2: missing receipt metadata is malformed, not pending',async()=>{
 for(const k of ['transactionHash','transactionIndex','blockHash','blockNumber','status','logs']){
  const rc=good(); delete rc[k];
  await assert.rejects(canonicalReceipt(rpc(rc),h),code('receipt_malformed'),k);
 }
});
test('r2: missing log metadata is malformed',async()=>{
 for(const k of ['transactionHash','blockHash','blockNumber','transactionIndex','logIndex','removed']){
  const l=okLog(); delete l[k];
  await assert.rejects(canonicalReceipt(rpc({...good(),logs:[l]}),h),undefined,k);
 }
});
test('r2: removed log is refused',async()=>{
 await assert.rejects(canonicalReceipt(rpc({...good(),logs:[{...okLog(),removed:true}]}),h),code('receipt_log_removed'));
});
test('r2: log from another block / index, or repeated logIndex, is refused',async()=>{
 await assert.rejects(canonicalReceipt(rpc({...good(),logs:[{...okLog(),blockHash:'0x'+'cd'.repeat(32)}]}),h),code('receipt_identity'));
 await assert.rejects(canonicalReceipt(rpc({...good(),logs:[{...okLog(),transactionIndex:'0x1'}]}),h),code('receipt_identity'));
 await assert.rejects(canonicalReceipt(rpc({...good(),logs:[okLog(0),okLog(0)]}),h),code('receipt_malformed'));
});
test('r2: unknown or non-canonical status is refused; canonical revert throws tx_reverted',async()=>{
 await assert.rejects(canonicalReceipt(rpc({...good(),status:'0x2'}),h),code('receipt_status_unknown'));
 await assert.rejects(canonicalReceipt(rpc({...good(),status:'success'}),h),code('receipt_status_unknown'));
 await assert.rejects(canonicalReceipt(rpc({...good(),status:'0x0'}),h),code('tx_reverted'));
});
test('r2: transaction at another index of the canonical block is refused',async()=>{
 await assert.rejects(canonicalReceipt(rpc(good(),{hash:b,number:'0x10',transactions:[other,h]}),h),code('receipt_identity'));
});
test('r2: malformed identities are refused (zero block number, non-canonical quantity, bad hash)',async()=>{
 await assert.rejects(canonicalReceipt(rpc({...good(),blockNumber:'0x0'}),h),code('receipt_malformed'));
 await assert.rejects(canonicalReceipt(rpc({...good(),blockNumber:'0x010'}),h),code('receipt_malformed'));
 await assert.rejects(canonicalReceipt(rpc({...good(),blockHash:'0x1234'}),h),code('receipt_malformed'));
 await assert.rejects(canonicalReceipt(rpc(good()),z),code('receipt_malformed'));
});
test('r2: canonical receipt with valid logs passes unchanged',async()=>{
 const rc={...good(),logs:[okLog(0),okLog(1)]};
 assert.equal(await canonicalReceipt(rpc(rc),h),rc);
});
test('r2: finality is separate from canonical-at-observation',async()=>{
 const fin=(n,hashAt=b)=>async(method,params)=>params[0]==='finalized'?{number:n,hash:'0x'+'ef'.repeat(32)}:{number:'0x10',hash:hashAt};
 assert.deepEqual({...await receiptFinality(fin('0xf'),good())},{canonicalAtObservation:true,final:false,finalizedNumber:15n});
 assert.equal((await receiptFinality(fin('0x20'),good())).final,true);
 await assert.rejects(receiptFinality(fin('0x20','0x'+'cd'.repeat(32)),good()),code('receipt_reorged'));
});
