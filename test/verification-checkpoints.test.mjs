import test from 'node:test';import assert from 'node:assert/strict';
import {planCheckpoints} from '../windows/node/verification-checkpoints.mjs';
const ledger='0x'+'11'.repeat(20),proof='0x'+'22'.repeat(20),router='0x'+'33'.repeat(20),payer='0x'+'44'.repeat(20),ZERO='0x'+'00'.repeat(20);
const cp=n=>({id:'0x'+n.repeat(64),enclaveId:'0x'+'ab'.repeat(32),upto:50n,anchorBlock:9n,anchorHash:'0x'+'cd'.repeat(32),sig:'0x1234'});
function client({rev=15n,fee=router,boundLedger=ledger,boundProof=proof,policies={},error}={}){return {readContract:async q=>{
 if(error===q.functionName)throw Error('offline');
 switch(q.functionName){case 'deploymentsSchema':return rev;case 'feeRouter':return fee;case 'ledger':return boundLedger;case 'proof':return boundProof;case 'policies':return policies[q.args[0]]||[ZERO,ZERO,ZERO,0n,0n,0];default:throw Error(q.functionName);}
}};}
const active=[payer,payer,payer,100n,1n,125];
test('older ledgers and unconfigured routers retain the original batched proofs',async()=>{
 for(const c of [client({rev:13n}),client({fee:ZERO})]){
  const batch=[cp('a'),cp('b')];const plans=await planCheckpoints({client:c,ledger,proof,batch,nowSec:60n});
  assert.deepEqual(plans,[{address:proof,functionName:'checkpointMany',args:[batch],ids:batch.map(c=>c.id)}]);
 }
});
test('only active opted-in sources use the bound fee wrapper; signed arguments stay exact',async()=>{
 const a=cp('a'),b=cp('b'),c=cp('c');const plans=await planCheckpoints({client:client({policies:{[a.id]:active,[b.id]:[payer,payer,payer,59n,1n,125]}}),ledger,proof,batch:[a,b,c],nowSec:60n});
 assert.deepEqual(plans[0],{address:router,functionName:'checkpoint',args:[a.id,a.enclaveId,a.upto,a.anchorBlock,a.anchorHash,a.sig],ids:[a.id]});
 assert.deepEqual(plans[1],{address:proof,functionName:'checkpointMany',args:[[b,c]],ids:[b.id,c.id]});
});
test('RPC failures and mismatched bindings cannot redirect proof submissions',async()=>{
 for(const c of [client({error:'deploymentsSchema'}),client({error:'policies'}),client({boundLedger:ZERO}),client({boundProof:ZERO})]){
  const warnings=[],a=cp('a'),plans=await planCheckpoints({client:c,ledger,proof,batch:[a],nowSec:60n,onWarning:m=>warnings.push(m)});
  assert.equal(plans.length,1);assert.equal(plans[0].address,proof);assert.equal(plans[0].functionName,'checkpoint');assert.equal(warnings.length,1);
 }
});
test('an empty batch causes no reads or transactions',async()=>{
 assert.deepEqual(await planCheckpoints({client:{},ledger,proof,batch:[]}),[]);
});
