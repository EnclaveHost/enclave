// Actual staged composer/dispatcher/runner, mocked chain+runtime; no production or final-author claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import {composeIndependentLifecycle,createSnapshotHostAdmission} from '../src/network/lifecycle-host-authority.mjs';
import {fixture,H,NEW,CTRL,INDEP,PLATFORM,route} from './helpers/lifecycle-fixture.mjs';
const PROFILE='independent-host-registry-r1',BUNDLE='bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e';
const ARTIFACT='e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a',REG='0x'+'ab'.repeat(20),REGCODE=H('23');
const HOST=H('a1'),ID=H('a2');
function world(){
 const f=fixture({hostId:HOST}),state={generation:1,status:'online'};
 const pins={chainId:8453,host:HOST,profile:PROFILE,hostRegistry:{artifactSha256:ARTIFACT},contracts:{registry:{address:REG,codeHash:REGCODE},hostOwnership:{address:REG,codeHash:REGCODE},ledger:{address:NEW,codeHash:H('11')},lifecycle:{address:CTRL,codeHash:H('22')},catalog:{address:'0x'+'cd'.repeat(20),codeHash:H('24')}}};
 const adapter={...f.chain,profile:PROFILE,lifecycleSchema:3,lifecycleProofSchema:2,bundleSha256:BUNDLE,hostRegistry:{address:REG,runtimeCodeHash:REGCODE,artifactSha256:ARTIFACT},independence:{complete:false,blockers:['TEST mock chain/runtime']},
 async read(id){return {...await f.chain.read(id),profile:PROFILE,lifecycleSchema:3,lifecycleProofSchema:2,
 hostAuthority:{owner:INDEP,revision:'1',policyHash:H('55'),policyKnown:true},host:{ownerDenial:null},emergency:{pending:false},
 hostLifecycle:{verified:true,registry:REG,status:state.status,online:state.status==='online',generation:state.generation,owner:INDEP,revision:'1',policyHash:H('55')}};}};
 const binding={lifecycleSchema:3,profile:PROFILE,bundleSha256:BUNDLE,hostRegistry:REG,hostRegistryCodeHash:REGCODE,hostRegistryArtifactSha256:ARTIFACT};
 const parts={adapter,adapterPins:pins,runtime:f.runtime,journal:f.journal,inventory:f.inventory,routes:[route(ID,binding)],platformWallets:[PLATFORM],capacityHeadroom:0.05,verifyQuiescence:f.verifyQuiescence,now:()=>1000};
 return {f,state,parts};
}
test('canonical Online and observed Offline fence behavior is otherwise exercised',async()=>{
 const {f,state,parts}=world(),c=composeIndependentLifecycle(parts);c.dispatch.attach(f.hostView(HOST));await c.dispatch.activate();
 assert.equal((await c.dispatch.reconcile(ID)).status,'running');assert.equal(f.calls.serve.length,1);
 state.status='offline';await c.dispatch.reconcile(ID);assert.equal(f.calls.serve.length,1);assert.ok(f.calls.fence.length>0);
});
test('host recovery generation changes the serving authority even if owner and policy revision are unchanged',async()=>{
 const {state,parts}=world(),a=createSnapshotHostAdmission({hostId:HOST,profile:PROFILE,now:()=>1000});
 const before=await a.decision(ID,await parts.adapter.read(ID));state.generation=2;
 const after=await a.decision(ID,await parts.adapter.read(ID));assert.notDeepEqual(after,before,'host-generation change must not issue identical serving authority');
});
test('missed Offline followed by recovered Online cannot resume the old app context automatically',async()=>{
 const {f,state,parts}=world(),c=composeIndependentLifecycle(parts);c.dispatch.attach(f.hostView(HOST));await c.dispatch.activate();
 assert.equal((await c.dispatch.reconcile(ID)).status,'running');assert.equal(f.calls.serve.length,1);
 state.generation=2; // offchain observer missed Offline, chain shows qualified recovery; app assignment is unchanged
 const outcome=await c.dispatch.reconcile(ID);
 assert.equal(f.calls.serve.length,1,'must fence old-generation context rather than renew its permit');
 assert.notEqual(outcome.status,'running');assert.ok(f.calls.fence.length>0);
});
