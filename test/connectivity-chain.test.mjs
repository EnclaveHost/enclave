import test from 'node:test';
import assert from 'node:assert/strict';
import {LeaseReader} from '../network/lease-reader.mjs';
const address='0x'+'11'.repeat(20),ledger='0x'+'22'.repeat(20),owner='0x'+'33'.repeat(20),id='0x'+'aa'.repeat(32),runner='0x'+'bb'.repeat(32),now=1700000000000;
function peer({nonce=1n,expires=1700000600n,boundLedger=ledger}={}) {
 return {getChainId:async()=>8453,getBlockNumber:async()=>1000n,getBlock:async()=>({timestamp:1699999995n,hash:'0x'+'cc'.repeat(32)}),
  readContract:async({functionName,args,blockNumber})=>{
   assert.equal(blockNumber,998n);
   if(functionName==='addr')return args[0].startsWith('0x6465706c6f796d656e7473')?ledger:address;
   if(functionName==='deploymentsSchema')return 16n;
   if(functionName==='get')return {id,runner,owner,runnerOperator:owner,leaseUntil:1700003600n,active:true};
   if(functionName==='ledger')return boundLedger;
   if(functionName==='policies')return [owner,nonce,expires,1000n,10000n,10n,8000];
   if(functionName==='hosts')return [true,true,1000n,1700000300n,'0x'+'dd'.repeat(32),owner,address];
   if(functionName==='capabilities')return [true,true];
   throw Error('unexpected call');
  }};
}
test('direct policy and split are agreed at the same block as the lease',async()=>{
 const reader=new LeaseReader({addressBook:address,clients:[peer(),peer()],includeConnectivity:true,now:()=>now});
 const [lease]=await reader.refresh([id]);
 assert.equal(lease.connectivity.providerBps,8000);assert.equal(lease.connectivity.nonce,'1');assert.equal(lease.connectivity.spent6,'10');
 reader.clients=[peer({expires:0n}),peer({expires:0n})];
 assert.equal((await reader.refresh([id]))[0].connectivity.expires,'0');
});
test('one peer cannot fabricate a policy or bind a foreign ledger',async()=>{
 for(const peers of [[peer(),peer({nonce:2n})],[peer({boundLedger:address}),peer({boundLedger:address})]]){
  const reader=new LeaseReader({addressBook:address,clients:peers,includeConnectivity:true,now:()=>now});
  await assert.rejects(reader.refresh([id]),/quorum/);assert.equal(reader.get(id),null);
 }
});
