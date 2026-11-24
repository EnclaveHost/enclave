import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {openStore} from '../availability/store.mjs';import {runRound} from '../availability/coordinator.mjs';
const policy={enabled:true,classId:'cpu',anchorRate6:10n,maximumRate6:100n,maximumJobSpend6:100000n,minimumMultiplierPpm:100000n,maximumMultiplierPpm:4000000n,maxObservationAgeSec:100n,quoteTtlSec:60n,minimumDurationSec:1n,maximumDurationSec:100n,maxChangePpmPerHour:1000000n};
const host=i=>({hardwareId:'hw'+i,hostId:'h'+i,operator:'op'+i,units:100n,spareUnits:100n,expiresSec:2000n,minimumRate6:0n});
const observation={classId:'cpu',atSec:1000n,windowSec:100n,paidDemandUnits:1n,qualifiedSupplyUnits:10000n,queuedDemandUnits:0n,hosts:[host(1),host(2),host(3)]};
test('persisted epochs prevent repeated assignments, ambiguous jobs retain reservations, revoked policy still cleans up',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capacity-round-'));const store=await openStore(dir);
 try{
  let fail=false;
  const chain={policy:async()=>({bps:100,expires:2000,available6:1000n,jobCap6:100000n}),validate:async()=>{if(fail)throw new Error('ambiguous submission');},createOrRecover:async j=>({id:j.id}),fundOrRecover:async()=>{},stopAndReconcile:async()=>true};
  const args={store,chain,policy,nowSec:1000n,loadObservation:async()=>observation,scheduling:{durationSec:10n,allocationUnits:10n,maxConcurrent:3,cooldownSec:100n}};
  let r=await runRound(args);assert.equal(r.created.length,3);const ids=r.created;
  fail=true;r=await runRound(args);assert.equal(r.created.length,0);assert.equal(r.pending,3);assert.equal(r.errors.length,3);
  for(const id of ids)await store.transition(id,'offered',{state:'stopping',failure:'cancelled'});
  r=await runRound({...args,policy:{...policy,enabled:false}});assert.equal(r.pending,0);
  r=await runRound(args);assert.equal(r.created.length,0);assert.match(r.reason,/consumed/);
 }finally{await store.close();await fs.rm(dir,{recursive:true});}
});
test('a host that is only up for another audit is offered one after its cooldown, and not before',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capacity-reaudit-'));const store=await openStore(dir);
 try{
  const chain={policy:async()=>({bps:100,expires:5000,available6:1000n,jobCap6:100000n}),validate:async()=>{},createOrRecover:async j=>({id:j.id}),fundOrRecover:async()=>{},lease:async()=>null,stopAndReconcile:async()=>true};
  // the only host there is: no qualified supply, its units stated as re-audit supply (accounting.mjs)
  const only=at=>({...observation,atSec:at,qualifiedSupplyUnits:0n,reauditSupplyUnits:10000n,hosts:[{...host(1),reaudit:true,expiresSec:9000n}]});
  const args={store,chain,policy,scheduling:{durationSec:10n,allocationUnits:10n,maxConcurrent:1,cooldownSec:100n}};
  let r=await runRound({...args,nowSec:1000n,loadObservation:async()=>only(1000n)});
  assert.equal(r.created.length,1,'priced against the host it is given to');
  await store.transition(r.created[0],'offered',{state:'failed',failure:'the guest did not answer over TLS within its lease'});
  r=await runRound({...args,nowSec:1050n,loadObservation:async()=>only(1050n)});
  assert.equal(r.created.length,0);assert.deepEqual(r.skipped.map(s=>s.reason),['cooldown']);
  r=await runRound({...args,nowSec:1101n,loadObservation:async()=>only(1101n)});
  assert.equal(r.created.length,1,'asked again once the cooldown is over');
  // with nothing at all to price against, as before
  const none=await fs.mkdtemp(path.join(os.tmpdir(),'capacity-none-'));const s2=await openStore(none);
  try{r=await runRound({...args,store:s2,nowSec:1000n,loadObservation:async()=>({...observation,qualifiedSupplyUnits:0n,hosts:[]})});
   assert.match(r.reason,/no qualified spare capacity/);}finally{await s2.close();await fs.rm(none,{recursive:true});}
 }finally{await store.close();await fs.rm(dir,{recursive:true});}
});
