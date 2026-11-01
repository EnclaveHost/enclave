// Actual EVM state/receipts + current owned dispatcher/runtime/witnesses.
// Manager, health, storage/ingress/secrets and legacy quiescence are TEST doubles.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ownIndependentLifecycleDispatch } from '../../network/lifecycle-owned-dispatch.mjs';
import { ownHostLifecycleWitness } from '../../network/deployment-owned-host-services.mjs';
import { servingContextOf } from '../../network/deployment-host-authority.mjs';
import { signServingPermit } from '../../network/deployment-serving-permit.mjs';
import { HOST, chainNow } from '../fixtures/lifecycle-evm-base.mjs';

export async function evmOwnedDispatch(t,w){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evm-owned-')),adapter=w.adapter();
 const pins={chainId:8453,lifecycle:w.contracts.lifecycle,servingPermit:{version:2,profile:'independent-host-registry-r1'}};
 const f={dir,vm:null,allowed:false,spawns:0,platformCalls:0,records:new Map(),witnesses:[]};
 const lower=x=>x.toLowerCase();
 const route={deployment:w.id,oldLedger:lower(w.contracts.legacyLedger),newLedger:lower(w.contracts.ledger),controller:lower(w.contracts.lifecycle),
  deploymentsSchema:17,lifecycleSchema:3,ledgerCodeHash:w.pins.contracts.ledger.codeHash,controllerCodeHash:w.pins.contracts.lifecycle.codeHash,
  quiescenceDigest:w.pins.contracts.legacyLedger.codeHash,profile:adapter.profile,bundleSha256:adapter.bundleSha256,
  hostRegistry:lower(w.contracts.registry),hostRegistryCodeHash:adapter.hostRegistry.runtimeCodeHash,hostRegistryArtifactSha256:adapter.hostRegistry.artifactSha256};
 const client={findByName:async()=>f.vm,spawn:async()=>{f.spawns++;f.vm={id:'TEST-instance-'+f.spawns,name:w.id,status:'running',recovered:false};return {view:f.vm};},
  remove:async instance=>{if(f.vm?.id===instance)f.vm=null;}};
 const boundaries={hold:async deployment=>{f.allowed=false;return {deployment,ingress:true,storage:true,secrets:true};},
  allow:async(deployment,grant)=>{f.allowed=true;return {deployment,...grant,expiryEnforced:true};}};
 t.after(async()=>{if(f.service)await f.service.close();await Promise.all(f.witnesses.map(x=>x.close()));fs.rmSync(dir,{recursive:true,force:true});});
 for(const [i,account] of w.witnesses.entries())f.witnesses.push(await ownHostLifecycleWitness(path.join(dir,'witness-'+i+'.json'),{pins,host:HOST,
  ownerOptions:{initialize:true},account,now:chainNow,authority:{read:async()=>servingContextOf(pins,await adapter.read(w.id))},
  health:{verify:async (_id,_host,generation)=>({verified:true,deployment:w.id,host:HOST,generation,ready:!!f.vm,validUntil:Math.floor(chainNow()/1000)+20})}}));
 const collectPermit=async record=>{const sig=await signServingPermit(w.operator,pins,record);
  return {record,signatures:await Promise.all(f.witnesses.map(async x=>(await x.witness.permit(record,sig)).signature))};};
 const hostView={hostId:HOST,legacyHold:()=>null,legacyActivity:()=>[],ownerRestriction:()=>null,
  platformService:()=>{f.platformCalls++;return 'TEST platform refuses';},platformNewWork:()=>{f.platformCalls++;return 'TEST platform refuses';},
  shareOf:(_id,r)=>({cpuShare:r.cpuShare,gpuShare:r.gpuShare}),capacity:()=>({paused:false,cpuCap:1,gpuCap:1,cpuUsed:0,gpuUsed:0}),
  record:(id,row)=>f.records.set(id,row),log:()=>{}};
 f.service=await ownIndependentLifecycleDispatch(path.join(dir,'runtime.json'),{adapter,adapterPins:w.pins,hostView,
  ownerOptions:{initialize:true},routes:[route],platformWallets:[w.other.address],capacityHeadroom:0,now:chainNow,
  verifyQuiescence:async r=>({verified:true,proofVerified:true,authorityTier:'finalized',deployment:w.id,ledger:r.oldLedger,digest:r.quiescenceDigest,quiescent:true}),
  runtime:{client,boundaries,collectPermit,plans:{read:async()=>({verified:true,host:HOST,body:{name:w.id},stagingEnforced:true})},
   readiness:{verify:async({generation,view})=>({verified:true,ready:true,deployment:w.id,host:HOST,generation,instance:view.id,validUntil:chainNow()+20000})}}});
 return f;
}
