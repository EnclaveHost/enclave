import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reserveRequest } from './request.mjs';
import { verifyReserve } from './verify-reserve.mjs';
const read=p=>JSON.parse(fs.readFileSync(new URL(p,import.meta.url)));
const pre=read('../../outputs/app-lease-gas-review/production-funding-preflight.json');
const simulation=read('../lease-gas-production-preflight/multicall-simulation.json');
const request=reserveRequest({pre,draft:read('../lease-gas-production-preflight/reserve-creation-draft.json'),simulation,mainSourceHash:pre.provenance.EnclaveLeaseGasReserve.sourceSha256,now:Date.parse(pre.checkedAt)+1000});
const hash='0x'+'ab'.repeat(32), blockHash='0x'+'cd'.repeat(32);
function peers(mutate=()=>{}) {
 return ['a.example','b.example'].map((host,i)=>{
 const state={code:simulation.results[0].result[0].calls[0].returnData,blockHash,
   tx:{...request.transaction,hash,to:null,input:request.transaction.data},receipt:{transactionHash:hash,status:'success',contractAddress:request.predictedAddress,blockNumber:100n,blockHash},
   bindings:{...request.binding,l1Oracle:request.binding.oracle,executor:'0x'+'00'.repeat(20),paused:false,limits:Object.values(request.binding.limits).map(BigInt)}};
 mutate(state,i);
 return {transport:{url:'https://'+host},getBlockNumber:async()=>104n,getChainId:async()=>8453,getBlock:async()=>({hash:state.blockHash}),getTransaction:async()=>state.tx,
   getTransactionReceipt:async()=>state.receipt,getCode:async()=>state.code,readContract:async({functionName,blockNumber})=>{assert.equal(blockNumber,102n);return state.bindings[functionName]}};
 });
}
test('two matching canonical receipts, runtimes and bindings verify reserve without making it funding-ready',async()=>{
 const r=await verifyReserve({request,hash,clients:peers()});assert.equal(r.address,request.predictedAddress);assert.equal(r.fundingReady,false);assert.equal(r.providers,2);
});
for(const [name,change,pattern] of [
 ['owner',s=>s.bindings.owner='0x'+'11'.repeat(20),/unexpected owner/],
 ['ledger',s=>s.bindings.ledger='0x'+'11'.repeat(20),/unexpected ledger/],
 ['oracle',s=>s.bindings.l1Oracle='0x'+'11'.repeat(20),/unexpected oracle/],
 ['limits',s=>s.bindings.limits[0]++,/unexpected limit/],
 ['existing binding',s=>s.bindings.executor='0x'+'11'.repeat(20),/already bound/],
 ['receipt reorg',s=>s.receipt.blockHash='0x'+'12'.repeat(32),/not canonical/],
 ['insufficient confirmations',s=>s.receipt.blockNumber=103n,/two later blocks/],
 ['wrong returned tx',s=>s.tx.hash='0x'+'12'.repeat(32),/another transaction/],
 ['provider snapshot disagreement',s=>{s.blockHash='0x'+'12'.repeat(32);s.receipt.blockHash=s.blockHash},/providers disagree/],
])test('refuses one provider with changed '+name,async()=>{
 await assert.rejects(verifyReserve({request,hash,clients:peers((s,i)=>{if(i===1)change(s)})}),pattern);
});
test('refuses repeated client as false quorum',async()=>{const [c]=peers();await assert.rejects(verifyReserve({request,hash,clients:[c,c]}),/duplicate client/)});
