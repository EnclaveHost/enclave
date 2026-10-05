import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {planRound,advanceJob} from '../availability/scheduler.mjs';import {openStore} from '../availability/store.mjs';
const policy={enabled:true,classId:'cpu',anchorRate6:10n,maximumRate6:100n,maximumJobSpend6:100000n,minimumMultiplierPpm:100000n,maximumMultiplierPpm:4000000n,maxObservationAgeSec:100n,quoteTtlSec:60n,minimumDurationSec:1n,maximumDurationSec:100n,maxChangePpmPerHour:1000000n};
const host=i=>({hardwareId:'hw'+i,hostId:'h'+i,operator:'op'+i,units:100n,spareUnits:100n,expiresSec:2000n,minimumRate6:0n});
const args={observation:{classId:'cpu',atSec:1000n,windowSec:100n,paidDemandUnits:1n,qualifiedSupplyUnits:10000n,hosts:[host(1),host(2),host(3)]},policy,nowSec:1000n,durationSec:10n,availableBudget6:1000n,allocationUnits:10n,maxConcurrent:3,cooldownSec:100n,pick:()=>0};
test('one customer workload can support concurrent independent verification offers',()=>{
 const p=planRound(args);assert.equal(p.offers.length,3);assert.ok(p.reserved6<=1000n);assert.equal(new Set(p.offers.map(x=>x.hardwareId)).size,3);
});
test('customers, cooldowns, aliases and budget constrain assignments',()=>{
 assert.equal(planRound({...args,compatibleCustomerQueueUnits:1n}).offers.length,0);
 assert.equal(planRound({...args,availableBudget6:1n}).offers.length,0);
 assert.equal(planRound({...args,history:{hw1:{atSec:999,pending:true}}}).offers.length,2);
 assert.equal(planRound({...args,observation:{...args.observation,hosts:[host(1),host(1)]}}).offers.length,1);
});
test('durable lifecycle pays via adapter and does not rerun or report success after interrupted work',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capacity-jobs-'));const store=await openStore(dir);
 try {
  await assert.rejects(openStore(dir),/EEXIST/);
  const offer=planRound(args).offers[0];const id=offer.id;await store.create({id,offer,state:'offered'});
  let create=0,fund=0,run=0,stop=0;
  const chain={validate:async()=>{},createOrRecover:async()=>{create++;return {id:'deployment'};},fundOrRecover:async()=>{fund++;},lease:async()=>({hostId:offer.hostId,operator:offer.operator,rate6:offer.rate6}),stopAndReconcile:async()=>{stop++;}};
  const workload={runAndVerify:async()=>{run++;return {verified:true};}};
  const env={store,chain,workload,nowSec:1000n};
  for(let i=0;i<6;i++)await advanceJob(id,env);
  assert.equal((await store.get(id)).state,'complete');assert.deepEqual([create,fund,run,stop],[1,1,1,1]);
  const second={...offer,id:'0x'+'11'.repeat(32)};await store.create({id:second.id,offer:second,state:'checking'});
  await advanceJob(second.id,env);await advanceJob(second.id,env);
  assert.equal((await store.get(second.id)).state,'failed');assert.equal(run,1);
 }finally{await store.close();await fs.rm(dir,{recursive:true});}
});
test('wrong host is stopped, never accepted as evidence',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capacity-jobs-'));const store=await openStore(dir);
 try{const offer=planRound(args).offers[0];await store.create({id:offer.id,offer,state:'queued'});
 const r=await advanceJob(offer.id,{store,nowSec:1000n,chain:{lease:async()=>({hostId:'wrong',rate6:1n})}});
 assert.equal(r.state,'stopping');assert.match(r.failure,/unexpected/);
 }finally{await store.close();await fs.rm(dir,{recursive:true});}
});
test('shutdown waits for lease release; wrong operator never passes',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capacity-jobs-'));const store=await openStore(dir);
 try {
  const offer=planRound(args).offers[0];await store.create({id:offer.id,offer,state:'queued'});
  let r=await advanceJob(offer.id,{store,nowSec:1000n,chain:{lease:async()=>({hostId:offer.hostId,operator:'other',rate6:offer.rate6})}});
  assert.equal(r.state,'stopping');
  r=await advanceJob(offer.id,{store,nowSec:1000n,chain:{stopAndReconcile:async()=>false}});assert.equal(r.state,'stopping');
  r=await advanceJob(offer.id,{store,nowSec:1000n,chain:{stopAndReconcile:async()=>true}});assert.equal(r.state,'failed');
 }finally{await store.close();await fs.rm(dir,{recursive:true});}
});
