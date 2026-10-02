import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {ProviderInventory} from '../network/provider-inventory.mjs';
test('live health ranks known outcomes, is bound to provider metadata, and expires',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'provider-health-'));let now=Date.now();
 const node={identity:'ab'.repeat(32),address:'8.8.8.8',beneficiary:'wallet',price:'0.0002',services:['reverse','socksproxy'],expiresAt:now+60000};
 const asnFile=path.join(dir,'asn.json');await fs.writeFile(asnFile,JSON.stringify({expiresAt:now+8*86400000,addresses:{'8.8.8.8':{asn:15169}}}));
 const inventory=new ProviderInventory({binary:'/unused',rpc:['https://rpc.example'],asnFile,now:()=>now,runCommand:async()=>({stdout:JSON.stringify([node])})});
 try{
  assert.equal((await inventory.refresh())[0].outcomes.public.successRate,0.5);
  await inventory.observe({public:node,egress:node},{ok:true,latencyMs:100});
  assert.equal((await inventory.refresh())[0].outcomes.public.successRate,1);assert.equal(inventory.nodes[0].outcomes.public.latencyMs,100);
  assert.equal(inventory.nodes[0].outcomes.guard.successRate,0.5);
  await inventory.observe({public:node,guard:node},{ok:false,role:'public'});assert.equal((await inventory.refresh())[0].outcomes.public.successRate,0.5);
  await inventory.observe({public:node},{ok:true,latencyMs:50});assert.equal((await inventory.refresh())[0].outcomes.public.latencyMs,90);
  node.beneficiary='different-wallet';assert.equal((await inventory.refresh())[0].outcomes.public.successRate,0.5);assert.equal(inventory.nodes[0].outcomes.public.latencyMs,undefined);
  node.beneficiary='wallet';now+=7*86400000+1;assert.equal((await inventory.refresh())[0].outcomes.public.successRate,0.5);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
