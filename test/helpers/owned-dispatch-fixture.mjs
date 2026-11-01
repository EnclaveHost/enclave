// Real maintained owned runtime/witness/gate/dispatch/runner; authenticated chain
// snapshots, transition sender, manager and host accounting are inert test adapters.
import { keccak256,toBytes } from 'viem';
import { setup,id,host,hash } from './owned-host-services-fixture.mjs';
import { ownIndependentLifecycleDispatch } from '../../network/lifecycle-owned-dispatch.mjs';
import { HOST_REGISTRY_PROFILE,SCHEMA3_BUNDLE_SHA256,HOST_REGISTRY_ARTIFACT_SHA256 } from '../../network/lifecycle-host-profile.mjs';
export { id,host,hash };
const a=b=>'0x'+b.repeat(20);
export async function dispatchFixture(t,{platformOwned=false}={}){
 const f=await setup();f.service.journal.settleTransition(id,hash);await f.service.close();
 f.state='queued';f.ownerRevision='1';f.ownerDenial=null;f.hostStatus='online';f.confirmed=false;f.prepares=[];f.submits=[];f.records=new Map();f.platformCalls=0;
 const registry=f.evidence.context.registry,controller=f.pins.lifecycle.toLowerCase(),ledger=a('71'),oldLedger=a('72'),platform=a('73');
 f.adapterPins={chainId:8453,host,profile:HOST_REGISTRY_PROFILE,hostRegistry:{artifactSha256:HOST_REGISTRY_ARTIFACT_SHA256},
  contracts:{ledger:{address:ledger,codeHash:hash},lifecycle:{address:controller,codeHash:hash},registry:{address:registry,codeHash:hash},
   hostOwnership:{address:registry,codeHash:hash},catalog:{address:a('74'),codeHash:hash}}};
 f.route={deployment:id,oldLedger,newLedger:ledger,controller,deploymentsSchema:17,lifecycleSchema:3,ledgerCodeHash:hash,controllerCodeHash:hash,
  quiescenceDigest:hash,profile:HOST_REGISTRY_PROFILE,bundleSha256:SCHEMA3_BUNDLE_SHA256,hostRegistry:registry,hostRegistryCodeHash:hash,hostRegistryArtifactSha256:HOST_REGISTRY_ARTIFACT_SHA256};
 f.snapshot=()=>{
  const c=f.context(f.ownerRevision);f.evidence={...f.evidence,context:c,status:f.hostStatus};
  const hostLifecycle={scope:'host',codeConsistent:true,registry,status:f.hostStatus,generation:c.hostGeneration,owner:c.owner,revision:c.ownerRevision,
   policyHash:c.policyHash,qualificationDigest:c.qualificationDigest,trustAnchorId:c.trustAnchorId,hardwareId:c.hardwareId,resourceDigest:c.resourceDigest,
   descriptorDigest:c.descriptorDigest,reporters:{keys:[],threshold:0,revision:'1'}};
  return {...f.running,schema:2,profile:HOST_REGISTRY_PROFILE,lifecycleSchema:3,lifecycleProofSchema:2,thisHost:host,enabled:true,
   ledger,controller,hostAuthority:{owner:c.owner,revision:c.ownerRevision,policyHash:c.policyHash,policyKnown:true},hostLifecycle,
   host:{ownerDenial:f.ownerDenial},hostAuthorityEvidence:f.evidence,resources:{cpuShare:0.25,gpuShare:0},
   assignment:{...f.running.assignment,state:f.state,generation:f.state==='queued'?1:2,startAfter:0,crashHeld:false}};
 };
 f.adapter={profile:HOST_REGISTRY_PROFILE,lifecycleSchema:3,lifecycleProofSchema:2,bundleSha256:SCHEMA3_BUNDLE_SHA256,
  hostRegistry:{address:registry,runtimeCodeHash:hash,artifactSha256:HOST_REGISTRY_ARTIFACT_SHA256},independence:{complete:false,blockers:['TEST native adapters not qualified']},
  read:async()=>f.snapshot(),prepare:async(_id,snapshot,target)=>{f.prepares.push(target);if(f.onPrepare)await f.onPrepare();
   const payload=JSON.stringify({intent:{target:target==='running'?2:target==='queued'?1:3},generation:snapshot.assignment.generation});return {payload,digest:keccak256(toBytes(payload))};},
  submit:async(_id,intent)=>{f.submits.push(intent);if(f.onSubmit)await f.onSubmit();},
  resolve:async(_id,intent)=>({verified:true,proofVerified:true,authorityTier:'finalized',digest:intent.digest,outcome:f.confirmed?'confirmed':'unknown'}),
  finalize:async()=>({verified:false})};
 const view={hostId:host,legacyHold:()=>f.legacyHold??null,legacyActivity:()=>[],ownerRestriction:()=>f.paused?'owner hosting paused':null,
  platformService:()=>{f.platformCalls++;return 'TEST Enclave refuses service';},platformNewWork:()=>{f.platformCalls++;return 'TEST Enclave refuses new work';},
  shareOf:(_id,r)=>({cpuShare:r.cpuShare,gpuShare:r.gpuShare}),capacity:except=>({paused:false,cpuCap:1,gpuCap:1,
   cpuUsed:(f.neighborCPU??0)+[...f.records].filter(([key,r])=>key!==except&&r.lifecycleAllocated).reduce((v,[,r])=>v+r.cpuShare,0),gpuUsed:0}),
  record:(key,r)=>f.records.set(key,{...f.records.get(key),...r}),log:()=>{}};
 f.dispatchOptions={adapter:f.adapter,adapterPins:f.adapterPins,hostView:view,runtime:f.options,ownerOptions:{},routes:[f.route],
  platformWallets:[platformOwned?f.context().owner:platform],capacityHeadroom:0.1,now:()=>f.now,
  verifyQuiescence:async route=>{if(f.onProof)await f.onProof();return {verified:true,proofVerified:true,authorityTier:'finalized',deployment:id,ledger:route.oldLedger,digest:route.quiescenceDigest,quiescent:true};}};
 f.open=async()=>{f.service=await ownIndependentLifecycleDispatch(f.file,f.dispatchOptions);return f.service;};
 await f.open();t.after(()=>f.cleanup());return f;
}
export async function running(f){await f.service.dispatch.activate();
 const first=await f.service.dispatch.reconcile(id);if(first.status!=='pending')throw Error(JSON.stringify(first));
 f.confirmed=true;f.state='running';await f.service.dispatch.reconcile(id);
 const r=await f.service.dispatch.reconcile(id);if(r.status!=='running')throw Error(JSON.stringify(r));return r;
}
