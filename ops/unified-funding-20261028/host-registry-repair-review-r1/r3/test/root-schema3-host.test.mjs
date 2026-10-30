import test from 'node:test';
import assert from 'node:assert/strict';
import {composeIndependentLifecycle,createSnapshotHostAdmission} from '../src/network/lifecycle-host-authority.mjs';
import {fixture,H,NEW,CTRL,INDEP,PLATFORM,route} from './helpers/lifecycle-fixture.mjs';
const PROFILE='independent-schema3-r1',BUNDLE='bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e';
const HOST=H('a1'), ID=H('a2');
function world(hostId=HOST, id=ID) {
 const f=fixture({hostId});
 const pins={chainId:8453,host:hostId,profile:PROFILE,contracts:{ledger:{address:NEW,codeHash:H('11')},lifecycle:{address:CTRL,codeHash:H('22')},hostOwnership:{address:'0x'+'ab'.repeat(20),codeHash:H('23')},catalog:{address:'0x'+'cd'.repeat(20),codeHash:H('24')}}};
 const adapter={...f.chain,profile:PROFILE,lifecycleSchema:3,lifecycleProofSchema:2,bundleSha256:BUNDLE,independence:{complete:false,blockers:['TEST MOCK: no actual chain authority']},
  async read(id){const s=await f.chain.read(id);return {...s,profile:PROFILE,lifecycleSchema:3,lifecycleProofSchema:2,hostAuthority:{owner:INDEP,revision:'1',policyHash:H('55'),policyKnown:true},host:{ownerDenial:null},emergency:{pending:false}};}};
 const parts={adapter,adapterPins:pins,runtime:f.runtime,journal:f.journal,inventory:f.inventory,routes:[route(id,{lifecycleSchema:3,profile:PROFILE,bundleSha256:BUNDLE})],platformWallets:[PLATFORM],capacityHeadroom:0.05,verifyQuiescence:f.verifyQuiescence};
 return {f,parts};
}
test('schema3 snapshot admission accepts only the explicitly selected schema3 profile',async()=>{
 const {parts}=world();const admission=createSnapshotHostAdmission({hostId:HOST,profile:PROFILE});
 assert.equal((await admission.decision(ID,await parts.adapter.read(ID))).owner,INDEP);
});
test('schema3 host composition binds exact profile and route before activation, then reconciles actual dispatcher/runner',async()=>{
 const {f,parts}=world();const c=composeIndependentLifecycle(parts);
 c.dispatch.attach(f.hostView(HOST));await c.dispatch.activate();
 assert.equal(c.dispatch.binding.lifecycleSchema,3);assert.equal(c.dispatch.binding.profile,PROFILE);
 assert.equal((await c.dispatch.reconcile(ID)).status,'running');assert.equal(f.calls.serve.length,1);
});
export {world,PROFILE,BUNDLE,HOST,ID};

test('schema3 routes require exact profile and bundle; no schema inference or cross-profile pairing',()=>{
 for(const change of [
  x=>{delete x.adapterPins.profile;},
  x=>{x.adapterPins.profile='independent-schema3-r2';},
  x=>{x.adapterPins.chainId=1;},
  x=>{x.adapter={...x.adapter,profile:'independent-r1'};},
  x=>{x.adapter={...x.adapter,lifecycleSchema:2};},
  x=>{x.adapter={...x.adapter,lifecycleProofSchema:1};},
  x=>{x.adapter={...x.adapter,bundleSha256:'0'.repeat(64)};},
  x=>{delete x.routes[0].profile;},
  x=>{delete x.routes[0].bundleSha256;},
  x=>{x.routes[0].bundleSha256='0'.repeat(64);},
  x=>{x.routes[0].lifecycleSchema=2;},
  x=>{x.routes[0].ledgerCodeHash=H('ee');},
 ]){const {parts}=world();change(parts);assert.throws(()=>composeIndependentLifecycle(parts));}
});

test('schema3 snapshot admission does not infer eligibility from a profile label or accept old-profile snapshots',async()=>{
 const {parts}=world(),s=await parts.adapter.read(ID),a=createSnapshotHostAdmission({hostId:HOST,profile:PROFILE});
 for(const over of [{profile:'independent-r1'},{lifecycleSchema:2},{lifecycleProofSchema:1},{verified:false},{thisHost:H('ff')},{hostAuthority:{...s.hostAuthority,policyKnown:false}}])
  await assert.rejects(a.decision(ID,{...s,...over}));
 const legacy=createSnapshotHostAdmission({hostId:HOST});await assert.rejects(legacy.decision(ID,s));
 assert.throws(()=>createSnapshotHostAdmission({hostId:HOST,profile:'schema>=2'}));
});

test('schema3 composer refuses a changed snapshot before runtime serving and retains explicit reporter gap',async()=>{
 const {f,parts}=world();const original=parts.adapter.read;let bad=false;
 parts.adapter.read=async id=>({...await original(id),...(bad?{lifecycleSchema:2}:{})});
 const c=composeIndependentLifecycle(parts);c.dispatch.attach(f.hostView(HOST));await c.dispatch.activate();
 assert.equal((await c.dispatch.reconcile(ID)).status,'running');assert.equal(f.calls.serve.length,1);
 bad=true;const r=await c.dispatch.reconcile(ID);
 assert.equal(r.status,'held');assert.match(r.reason,/mismatched profile/);assert.equal(f.calls.serve.length,1);
 assert.equal(c.dispatch.emergencyOffline.code,'LIFECYCLE_REPORTER_NOT_CONFIGURED');
 assert.ok(f.calls.fence.length>0);assert.equal(f.calls.submit.length,0);
});

test('schema3 owner refusal revokes service while a foreign platform refusal has no veto',async()=>{
 const {f,parts}=world();f.V.service='platform refuses this independent host';f.V.newWork='platform blocks';
 const c=composeIndependentLifecycle(parts);c.dispatch.attach(f.hostView(HOST));await c.dispatch.activate();
 assert.equal((await c.dispatch.reconcile(ID)).status,'running');assert.equal(f.calls.serve.length,1);
 f.V.owner='local owner shutdown';await c.dispatch.reconcile(ID);
 assert.equal(f.calls.serve.length,1);assert.ok(f.calls.fence.length>0);
 assert.ok(f.calls.prepare.some(x=>['queued','stopped'].includes(x.target)));
});

test('schema3 incomplete adapter holds only its exact routes without falling back to legacy',async()=>{
 const {f,parts}=world();delete parts.adapter.finalize;
 const c=composeIndependentLifecycle({...parts,onMissing:'hold'});
 assert.ok(c.missing.includes('adapter.finalize'));assert.equal(c.dispatch.owns(ID),true);
 c.dispatch.attach(f.hostView(HOST));const r=await c.dispatch.reconcile(ID);
 assert.equal(r.status,'held');assert.equal(f.calls.submit.length,0);assert.equal(f.calls.serve.length,0);
});

// Generated production Host source and actual dispatcher/runner; chain/runtime/authority are explicit TEST mocks.
test('generated Host composes schema3, retains uncertain resources and releases only confirmed removals',async()=>{
 const {CANDIDATE_HOST_URL}=await import('./helpers/baseline.mjs');
 const {Host,HOSTID,A,box,serve,settle}=await import(CANDIDATE_HOST_URL);
 const {f,parts}=world(HOSTID,A),c=composeIndependentLifecycle(parts);
 const {h}=await box(Host,c.dispatch);serve(h);await c.dispatch.activate();
 assert.equal(h.cpuShareFree(),0,'capacity starts unknown');
 assert.equal((await c.dispatch.reconcile(A)).status,'running');
 assert.ok(Math.abs(h.shareUse().cpu-0.1)<1e-9);assert.ok(h.cpuShareFree()>0);
 f.S.onRead=()=>{throw Error('TEST authority unavailable');};
 assert.equal((await c.dispatch.reconcile(A)).status,'held');
 assert.ok(Math.abs(h.shareUse().cpu-0.1)<1e-9);assert.equal(Host.occupies(h.records.get(A)),true);
 f.S.onRead=null;f.S.stopResult=false;h.caps.paused=true;
 await h.enforceOff();await settle();assert.ok(Math.abs(h.shareUse().cpu-0.1)<1e-9);
 f.S.stopResult=true;await h.enforceOff();await settle();
 assert.equal(h.shareUse().cpu,0);assert.equal(Host.occupies(h.records.get(A)),false);
 assert.deepEqual(f.calls.prepare.map(x=>x.target),['queued']);
});
