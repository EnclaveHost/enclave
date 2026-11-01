// Real owned files/flocks and EIP-712 signatures; inert manager, health and chain readers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ownHostLifecycleRuntime, ownHostLifecycleWitness } from '../../network/deployment-owned-host-services.mjs';
import { hostAuthorityContextOf, servingContextOf } from '../../network/deployment-host-authority.mjs';
import { signServingPermit } from '../../network/deployment-serving-permit.mjs';
export const id='0x'+'21'.repeat(32), host='0x'+'31'.repeat(32), hash='0x'+'41'.repeat(32);
export const pending={digest:hash,payload:'{"testUnsettled":true}'};
export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
export async function until(check){const end=Date.now()+2000;while(!check()&&Date.now()<end)await new Promise(r=>setTimeout(r,2));if(!check())throw Error('fixture condition timeout');}
export async function setup(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owned-host-services-')),file=path.join(dir,'runtime.json');
 const accounts=Array.from({length:4},()=>privateKeyToAccount(generatePrivateKey()));
 const pins={chainId:8453,lifecycle:accounts[3].address,servingPermit:{version:2,profile:'independent-host-registry-r1'}};
 const f={dir,file,pins,accounts,now:1000000,mono:0,vm:null,allowed:false,spawns:0,allows:0,removed:[],witnesses:[]};
 f.context=(revision='1')=>hostAuthorityContextOf({scope:'host',codeConsistent:true,registry:accounts[3].address,
  generation:'1',status:'online',owner:accounts[3].address,revision,policyHash:hash,qualificationDigest:hash,
  trustAnchorId:hash,hardwareId:hash,resourceDigest:hash,descriptorDigest:hash,reporters:{keys:[],threshold:0,revision:'1'}},
  {chainId:8453,hostId:host,registryCodeHash:hash});
 f.evidence={context:f.context(),status:'online',proofVerified:true,blockHash:hash,blockNumber:'100'};
 const policy={revision:1,threshold:3,witnesses:accounts.slice(0,3).map(a=>a.address)};
 f.running={id,assignment:{state:'running',generation:2,revision:1,host,operator:accounts[3].address},policy,
  admitted:true,funded:true,verified:true,authorityTier:'safe',blockAt:1000000,blockHash:hash,hostAuthorityEvidence:f.evidence};
 f.queued={...f.running,assignment:{...f.running.assignment,state:'queued',generation:1}};
 f.read=async()=>servingContextOf(pins,{...f.running,hostAuthorityEvidence:f.evidence});
 f.plan={verified:true,host,body:{name:id},stagingEnforced:true};
 f.client={findByName:async()=>f.vm,spawn:async()=>{f.spawns++;f.vm={id:'instance-'+f.spawns,name:id,status:'running',recovered:false};return {view:f.vm};},
  remove:async instance=>{f.removed.push(instance);if(f.vm?.id===instance)f.vm=null;}};
 f.boundaries={hold:async deployment=>{f.allowed=false;return {deployment,ingress:true,storage:true,secrets:true};},
  allow:async(deployment,grant)=>{f.allows++;f.allowed=true;return {deployment,...grant,expiryEnforced:true};}};
 for(let i=0;i<3;i++)f.witnesses.push(await ownHostLifecycleWitness(path.join(dir,'witness-'+i+'.json'),{pins,host,
  ownerOptions:{initialize:true},account:accounts[i],now:()=>f.now,authority:{read:(...a)=>f.read(...a)},
  health:{verify:async()=>({verified:true,deployment:id,host,generation:2,ready:true,validUntil:1020})}}));
 f.collect=async record=>{const sig=await signServingPermit(accounts[3],pins,record);return {record,signatures:await Promise.all(f.witnesses.map(async w=>(await w.witness.permit(record,sig)).signature))};};
 f.options={pins,host,ownerOptions:{initialize:true},now:()=>f.now,monotonic:()=>f.mono,
  client:f.client,plans:{read:async()=>f.plan},boundaries:f.boundaries,
  readiness:{verify:async({view,generation})=>({verified:true,ready:true,deployment:id,host,generation,instance:view.id,validUntil:f.now+20000})},
  collectPermit:(...a)=>f.collect(...a)};
 f.service=await ownHostLifecycleRuntime(file,f.options);f.service.journal.prepareTransition(id,pending);
 f.record={deployment:id,host,generation:2,policyRevision:1,sequence:1,issuedAt:1000,validUntil:1020,hostAuthority:f.evidence.context};
 f.cleanup=async()=>{await f.service.close();await Promise.all(f.witnesses.map(w=>w.close()));fs.rmSync(dir,{recursive:true,force:true});};
 return f;
}
