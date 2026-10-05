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
test('an untried provider inherits its network record for that role; its own record replaces it',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'provider-network-'));const now=Date.now();
 const mk=(n,ip)=>({identity:n.toString(16).padStart(64,'0'),address:ip,beneficiary:'w'+n,price:'0.0002',services:['reverse','socksproxy'],expiresAt:now+60000});
 const dead=[1,2,3].map(n=>mk(n,'9.9.9.'+n)),good=mk(4,'7.7.7.4'),freshDead=mk(5,'9.9.9.5'),freshGood=mk(6,'7.7.7.6'),lone=mk(7,'6.6.6.7');
 const asnFile=path.join(dir,'asn.json');
 await fs.writeFile(asnFile,JSON.stringify({expiresAt:now+8*86400000,addresses:{'9.9.9.1':{asn:900},'9.9.9.2':{asn:900},'9.9.9.3':{asn:900},'9.9.9.5':{asn:900},'7.7.7.4':{asn:700},'7.7.7.6':{asn:700},'6.6.6.7':{asn:600}}}));
 const inventory=new ProviderInventory({binary:'/unused',rpc:['https://rpc.example'],asnFile,now:()=>now,runCommand:async()=>({stdout:JSON.stringify([...dead,good,freshDead,freshGood,lone])})});
 try{
  for(const n of dead)await inventory.observe({public:n},{ok:false});
  for(let i=0;i<3;i++)await inventory.observe({public:good},{ok:true,latencyMs:10});
  await inventory.observe({guard:lone},{ok:false});
  const by=Object.fromEntries((await inventory.refresh()).map(n=>[n.address,n.outcomes]));
  assert.equal(by['9.9.9.5'].public.known,false);assert.equal(by['9.9.9.5'].public.successRate,0.5);
  assert.equal(by['9.9.9.5'].public.networkRate,1/5);assert.equal(by['7.7.7.6'].public.networkRate,4/5);
  // A network record is per role: no guard history on these networks yet.
  assert.equal(by['9.9.9.5'].guard.networkRate,undefined);
  // Fewer than three attempts on a network is not yet a record.
  assert.equal(by['6.6.6.7'].guard.known,true);assert.equal(by['6.6.6.7'].guard.networkRate,undefined);
  assert.equal(by['9.9.9.1'].public.known,true);assert.equal(by['9.9.9.1'].public.successRate,0);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
