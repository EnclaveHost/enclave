import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalReceipt} from './lib/funding-client.mjs';
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
