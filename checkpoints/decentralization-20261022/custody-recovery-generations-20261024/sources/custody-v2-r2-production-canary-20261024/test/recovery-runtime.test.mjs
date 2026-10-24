import test from 'node:test';import assert from 'node:assert/strict';
import {prepareCanaryRecovery,startCanaryRecovery,generationOptions} from '../driver/recovery-runtime.mjs';
const hex=x=>x.repeat(64);
function fixture(){const pins={runLabel:'20261024T000000Z',custodian:{captureDir:'/fixture/run/r2-launch-20261024T000000Z/capture'}},committeeId='0x'+'12'.repeat(32),originDigest=hex('a'),generation='20261024T010000Z';
 const stopped={status:'stopped-verified',processesAbsent:true,portsAbsent:true,protectedServicesUnchanged:true,unit:'enclave-custody-r2-'+pins.runLabel+'.service',invocation:'a'.repeat(32),bundleDigest:originDigest,recordHash:hex('b'),bootId:'same-boot',sealedState:{sha256:hex('c'),bytes:50,dev:'1',ino:'2',mtimeNs:'3',ctimeNs:'4'}};
 const calls=[];const f={pins,originDigest,generation,previousLabel:pins.runLabel,previousDigest:originDigest,committeeId,mode:'restore',io:{},inspectStopped:()=>structuredClone(stopped),readGenesis:async()=>({outcome:'pass',evidence:{deploymentId:committeeId,seats:1,threshold:1,resolves:{'committee.verified':{ok:true}}}}),stageBundle:arg=>{calls.push(arg);return arg;},stopped,calls};
 return f;
}
test('recovery preparation reconciles genesis between two live stopped observations before packaging',async()=>{const f=fixture();let reads=0;f.inspectStopped=()=>{reads++;return structuredClone(f.stopped);};const r=await prepareCanaryRecovery(f);assert.equal(reads,2);assert.equal(r.recovery.committeeId,f.committeeId);assert.equal(r.recovery.stopped.bundleDigest,f.originDigest);assert.equal(f.calls.length,1);});
test('missing/conflicting genesis or changed predecessor/sealed state never produces a recovery package',async()=>{
 for(const mutate of [f=>{f.readGenesis=async()=>({outcome:'fail'});},f=>{const rd=f.readGenesis;f.readGenesis=async()=>{const r=await rd();r.evidence.deploymentId='0x'+'34'.repeat(32);return r;};},f=>{f.readGenesis=async()=>{throw Error('RPC unavailable');};},f=>{const rd=f.readGenesis;f.readGenesis=async()=>{f.stopped.sealedState.sha256=hex('e');return rd();};},f=>{const rd=f.readGenesis;f.readGenesis=async()=>{f.stopped.invocation='f'.repeat(32);return rd();};},f=>{f.stopped.processesAbsent=false;}]){const f=fixture();mutate(f);await assert.rejects(()=>prepareCanaryRecovery(f));assert.equal(f.calls.length,0);}
});
test('recovery start rechecks the predecessor around chain reads; a changed state cannot reach the start effect',async()=>{
 const f=fixture(),pkg=await prepareCanaryRecovery(f),opts=generationOptions({pins:f.pins,runLabel:f.generation,digest:hex('d')});let effects=0;
 const args={...f,runLabel:f.generation,digest:opts.digest,verifyRecovery:()=>({runLabel:f.generation,recovery:pkg.recovery,launch:{}}),readAuthority:async()=>({outcome:'pass'}),
  startRuntime:async o=>{o.verifyBundle({requireFresh:true});await o.readAuthority();o.verifyBundle({requireFresh:true});effects++;return {status:'started-unverified'};}};
 assert.equal((await startCanaryRecovery(args)).status,'started-unverified');assert.equal(effects,1);
 args.readAuthority=async()=>{f.stopped.sealedState.sha256=hex('e');return {outcome:'pass'};};await assert.rejects(()=>startCanaryRecovery(args),/sealed state changed/);assert.equal(effects,1);
});

import {verifyRecoveredCanary} from '../driver/recovery-runtime.mjs';
test('recovery attestation binds current SNP identity to canonical genesis and final runtime without recording a lifecycle pass',async()=>{
 const committeeId='0x'+'12'.repeat(32),digest=hex('d'),runtime={status:'runtime-verified',unit:'unit',invocation:'invocation',bundleDigest:digest,hostPid:100,guestPid:101};
 const machine={identity:'0x'+'11'.repeat(20),encKey:'0x'+'22'.repeat(32),endpoint:'https://canary.example'},measurement='0x'+'33'.repeat(32);
 const args={committeeId,digest,now:()=>1000,inspectRuntime:async()=>runtime,verifyLaunch:async()=>({outcome:'pass',evidence:{runtime,publicQuote:{...machine,measurementSha256:measurement}}}),verifyGenesis:async()=>({outcome:'pass',evidence:{deploymentId:committeeId,seats:1,threshold:1,...machine,measurement,resolves:{'committee.verified':{ok:true}}}})};
 const r=await verifyRecoveredCanary(args);assert.equal(r.status,'recovery-attested');assert.equal(r.outcome,undefined);assert.match(r.scope,/No recipient release/);
 await assert.rejects(()=>verifyRecoveredCanary({...args,inspectRuntime:async()=>({...runtime,invocation:'replacement'})}),/runtime changed/);
 const g=await args.verifyGenesis();g.evidence.encKey='0x'+'44'.repeat(32);await assert.rejects(()=>verifyRecoveredCanary({...args,verifyGenesis:async()=>g}),/differs/);
 let n=0;await assert.rejects(()=>verifyRecoveredCanary({...args,now:()=>n++?122000:1000}),/expired/);
});
