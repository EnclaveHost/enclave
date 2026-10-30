// Root acceptance over actual generated composer/dispatch and durable host-incarnation file.
// Chain, runtime, inventory and app journal are explicit MOCKS. Not EVM or production qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {composeIndependentLifecycle} from '../src/network/lifecycle-host-authority.mjs';
import {withHostIncarnationJournal} from '../src/network/lifecycle-host-incarnation-journal.mjs';
import {fixture,H,NEW,CTRL,INDEP,PLATFORM,route} from './helpers/lifecycle-fixture.mjs';
const PROFILE='independent-host-registry-r1',BUNDLE='bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e';
const ARTIFACT='e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a',REG='0x'+'ab'.repeat(20),REGCODE=H('23');
const HOST=H('a1'),ID=H('a2');
async function world(t,{initial='running'}={}) {
 const f=fixture({hostId:HOST,state:initial,now:()=>1000}), state={generation:'1',status:'online',owner:INDEP,revision:'1'};
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'root-incarnation-'));
 t.after(()=>fs.rmSync(dir,{recursive:true}));
 const journal=withHostIncarnationJournal(f.journal,path.join(dir,'incarnation.json'));
 const pins={chainId:8453,host:HOST,profile:PROFILE,hostRegistry:{artifactSha256:ARTIFACT},contracts:{registry:{address:REG,codeHash:REGCODE},hostOwnership:{address:REG,codeHash:REGCODE},ledger:{address:NEW,codeHash:H('11')},lifecycle:{address:CTRL,codeHash:H('22')},catalog:{address:'0x'+'cd'.repeat(20),codeHash:H('24')}}};
 const adapter={...f.chain,profile:PROFILE,lifecycleSchema:3,lifecycleProofSchema:2,bundleSha256:BUNDLE,hostRegistry:{address:REG,runtimeCodeHash:REGCODE,artifactSha256:ARTIFACT},independence:{complete:false,blockers:['TEST mock chain/runtime']},
 async read(id){return {...await f.chain.read(id),profile:PROFILE,lifecycleSchema:3,lifecycleProofSchema:2,
 hostAuthority:{owner:state.owner,revision:state.revision,policyHash:H('55'),policyKnown:true},host:{ownerDenial:null},emergency:{pending:false},
 hostLifecycle:{codeConsistent:true,registry:REG,status:state.status,online:state.status==='online',generation:state.generation,owner:state.owner,revision:state.revision,policyHash:H('55'),qualificationDigest:H('61'),trustAnchorId:H('62'),hardwareId:H('63'),resourceDigest:H('64'),descriptorDigest:H('65')}};}};
 const binding={lifecycleSchema:3,profile:PROFILE,bundleSha256:BUNDLE,hostRegistry:REG,hostRegistryCodeHash:REGCODE,hostRegistryArtifactSha256:ARTIFACT};
 const parts={adapter,adapterPins:pins,runtime:f.runtime,journal,inventory:f.inventory,routes:[route(ID,binding)],platformWallets:[PLATFORM],capacityHeadroom:0.05,verifyQuiescence:f.verifyQuiescence,now:()=>1000};
 const c=composeIndependentLifecycle(parts);c.dispatch.attach(f.hostView(HOST));await c.dispatch.activate();
 return {f,state,journal,c};
}
test('default new-profile imported runtime with no saved incarnation stays fenced',async t=>{
 const {f,c,journal}=await world(t);const result=await c.dispatch.reconcile(ID);
 assert.equal(f.calls.serve.length,0,'unknown imported runtime must not get an automatic first-generation handoff');
 assert.notEqual(result.status,'running');assert.equal(journal.readHostIncarnation(HOST)?.bound[ID],undefined);
});
test('fresh queued app binds its incarnation before a new start',async t=>{
 const {f,c,journal}=await world(t,{initial:'queued'});const result=await c.dispatch.reconcile(ID);
 assert.equal(result.status,'pending',JSON.stringify(result));assert.equal(f.calls.ensureStaged.length,1);
 assert.equal(journal.readHostIncarnation(HOST)?.bound[ID]?.generation,'1');assert.equal(f.calls.submit.length,1);
});
test('explicit adoption rereads current host state rather than trusting a cached Online decision',async t=>{
 const {state,c,journal}=await world(t);await c.dispatch.reconcile(ID);
 const named=journal.readHostIncarnation(HOST).floor;
 state.status='offline';
 await assert.rejects(c.dispatch.adoptHostIncarnation(ID,{generation:named.generation,digest:named.digest}));
});
test('explicit adoption must not rebind while an old app transition is pending',async t=>{
 const {f,c,journal,state}=await world(t);await c.dispatch.reconcile(ID);
 f.journal.prepareTransition(ID,{digest:H('77'),target:'running',payload:'PUBLIC_TEST_INTENT'});
 state.generation='2';await c.dispatch.reconcile(ID);
 const named=journal.readHostIncarnation(HOST).floor;
 await assert.rejects(c.dispatch.adoptHostIncarnation(ID,{generation:named.generation,digest:named.digest}));
 assert.equal(f.journal.read(ID).pending.digest,H('77'));
});
test('adoption refuses when old runtime quiescence cannot be confirmed',async t=>{
 const {f,c,journal,state}=await world(t);await c.dispatch.reconcile(ID);
 f.S.stopResult=false;f.S.quiescence=()=>({verified:false,quiescent:false});
 state.generation='2';await c.dispatch.reconcile(ID);
 const named=journal.readHostIncarnation(HOST).floor;
 await assert.rejects(c.dispatch.adoptHostIncarnation(ID,{generation:named.generation,digest:named.digest}));
 assert.notEqual(journal.readHostIncarnation(HOST)?.bound[ID]?.generation,'2');
});
