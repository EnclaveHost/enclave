import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dispatchFixture,running,id,host,hash } from './helpers/owned-dispatch-fixture.mjs';
import { deferred,until } from './helpers/owned-host-services-fixture.mjs';
import { ownLifecycleJournal } from '../network/deployment-journal-owner.mjs';
import { independentAdmissionRefusal } from '../network/lifecycle-independent-admission.mjs';
import { createScopedHostAuthority } from '../network/lifecycle-host-authority.mjs';
import { hostAdmissionPolicyHash } from '../network/host-admission-policy.mjs';

const ownership='0x'+'51'.repeat(20),app='0x'+'61'.repeat(32),owner='0x'+'71'.repeat(20);
const policy=()=>({version:1,chainId:8453,ownershipContract:ownership,hostId:host,requireCatalogApproval:false,denyDeployments:[],denyAppRefs:[]});
const content=()=>({hostId:host,deploymentId:id,appRef:`catalog://${app}/0`,app:{appId:app,versionCount:1,active:false},version:{cid:'bafyTESTcommitment',createdAt:'1',yanked:true,approval:2}});
test('independent moderation is wallet elected while pinned content and wallet deny lists remain mandatory',()=>{
 const p=policy(),c=content();assert.equal(independentAdmissionRefusal(p,c),null);
 assert.match(independentAdmissionRefusal({...p,requireCatalogApproval:true},c),/moderation/);
 assert.match(independentAdmissionRefusal({...p,denyDeployments:[id]},c),/declines/);
 assert.match(independentAdmissionRefusal(p,{...c,version:{...c.version,cid:''}}),/commitment/);
 assert.throws(()=>independentAdmissionRefusal({...p,hostId:hash},c),/another host/);
});
test('scoped authority hash-checks wallet policy and rejects rollback, equivocation and unavailable policy',async()=>{
 const p=policy();let revision=1,who=owner,document=p;
 const reader={agreed:async fn=>({...await fn({readContract:async()=>[who,ownership,BigInt(revision),hostAdmissionPolicyHash(p)]},100n),timestamp:1000000})};
 const authority=createScopedHostAuthority({hostId:host,ownershipContract:ownership,reader,loadPolicy:async()=>document,now:()=>1000000});
 assert.equal((await authority.snapshot()).owner,owner);revision=2;await authority.snapshot();revision=1;await assert.rejects(authority.snapshot(),/replay/);
 revision=2;who=ownership;await assert.rejects(authority.snapshot(),/equivocation/);who=owner;document={...p,denyDeployments:[id]};await assert.rejects(authority.snapshot(),/match/);
});
test('owned dispatch stages and serves through wallet authority during platform refusal without recurring transactions',async t=>{
 const f=await dispatchFixture(t);await running(f);assert.equal(f.allowed,true);assert.equal(f.platformCalls,0);assert.equal(f.submits.length,1);
 for(let i=0;i<3;i++)assert.equal((await f.service.dispatch.reconcile(id)).status,'running');
 assert.equal(f.submits.length,1);assert.equal(f.platformCalls,0);assert.equal(f.service.dispatch.ingressRefusal(id),null);
 assert.equal((await f.service.close()).released,true);assert.equal(f.vm,null);assert.equal(f.allowed,false);
 await assert.rejects(f.service.dispatch.reconcile(id),/closed/);assert.match(f.service.dispatch.ingressRefusal(id),/closed/);
});
test('platform policy applies when the authenticated wallet actually owns this host',async t=>{
 const f=await dispatchFixture(t,{platformOwned:true});await f.service.dispatch.activate();
 assert.equal((await f.service.dispatch.reconcile(id)).status,'queued');assert.equal(f.spawns,0);assert.equal(f.submits.length,0);assert.ok(f.platformCalls>0);
});
test('authenticated owner refusal remains a local queue transition despite Online and new-work restrictions',async t=>{
 const f=await dispatchFixture(t);await running(f);f.paused=true;f.legacyHold='retained legacy release';f.neighborCPU=1;
 assert.equal((await f.service.dispatch.reconcile(id)).status,'pending');assert.equal(f.vm,null);assert.equal(f.allowed,false);
 assert.deepEqual(f.prepares,['running','queued']);assert.equal(f.submits.length,2);
 assert.equal(JSON.parse(f.service.journal.read(id).pending.payload).intent.target,1,'revocation is not an Online admission');
});
test('local owner hold survives close and cold reopen; claim hints cannot clear it',async t=>{
 const f=await dispatchFixture(t);await f.service.dispatch.activate();await f.service.dispatch.restrict(id,'owner requested hold');
 await f.service.dispatch.close();assert.equal((await f.service.close()).released,true);await f.open();
 assert.equal(f.service.dispatch.considerHint(id).accepted,false);await f.service.dispatch.activate();
 assert.equal((await f.service.dispatch.reconcile(id)).status,'queued');assert.equal(f.spawns,0);
 assert.match(f.service.journal.readHostAuthority(host).holds[id].why,/owner requested/);
});
test('capacity uncertainty and neighboring allocation refuse start without losing the reservation',async t=>{
 const f=await dispatchFixture(t);await f.service.dispatch.activate();f.neighborCPU=0.8;
 assert.equal((await f.service.dispatch.reconcile(id)).status,'held');assert.equal(f.spawns,0);
 f.neighborCPU=0;f.client.findByName=async()=>{throw Error('TEST inventory unavailable');};
 assert.equal((await f.service.dispatch.reconcile(id)).status,'held');assert.equal(f.spawns,0);assert.equal(f.service.dispatch.state()[0].allocation.state,'committed');
});
test('owner revision changes during unsigned preparation hold the exact intent and prevent broadcast',async t=>{
 const f=await dispatchFixture(t);await f.service.dispatch.activate();f.onPrepare=async()=>{f.ownerRevision='2';};
 assert.equal((await f.service.dispatch.reconcile(id)).status,'pending');assert.equal(f.submits.length,0);
 assert.ok(f.service.journal.read(id).pending);await until(()=>!f.vm);assert.equal(f.allows,0);
});
test('a cached or future snapshot cannot acquire a fresh direct start admission window',async t=>{
 const f=await dispatchFixture(t);await f.service.dispatch.activate();const read=f.snapshot;
 for(const blockAt of [f.now-21000,f.now+3000]){
  f.snapshot=()=>({...read(),blockAt});const planned=f.snapshot();await f.service.dispatch.observeRoute(id,planned);
  await assert.rejects(f.service.dispatch.admitStart(id,planned),/expired|block time/);
 }
 assert.equal(f.spawns,0);assert.equal(f.submits.length,0);assert.equal(f.service.dispatch.state()[0].reservation,null);
});
test('owner close during unsigned preparation holds locks until completion and never submits',async t=>{
 const f=await dispatchFixture(t),d=deferred();let entered=false;await f.service.dispatch.activate();f.onPrepare=()=>{entered=true;return d.promise;};
 const reconciling=f.service.dispatch.reconcile(id);await until(()=>entered);const closing=f.service.close();
 await assert.rejects(ownLifecycleJournal(f.file),/in use/);d.resolve();await reconciling;
 assert.equal((await closing).released,true);assert.equal(f.submits.length,0);assert.equal(f.vm,null);
 assert.equal(JSON.parse(fs.readFileSync(f.file,'utf8')).deployments.find(r=>r.id===id).pending,null);
});
test('owner close retains an actual pending sender and cold recovery does not repeat its ambiguous submission',async t=>{
 const f=await dispatchFixture(t),d=deferred();let entered=false;await f.service.dispatch.activate();f.onSubmit=()=>{entered=true;return d.promise;};
 const reconciling=f.service.dispatch.reconcile(id);await until(()=>entered);const intent=f.service.journal.read(id).pending;
 const closing=f.service.close();await assert.rejects(ownLifecycleJournal(f.file),/in use/);d.resolve();await reconciling;assert.equal((await closing).released,true);
 await f.open();await f.service.dispatch.activate();assert.deepEqual(f.service.journal.read(id).pending,intent);
 assert.equal((await f.service.dispatch.reconcile(id)).status,'pending');assert.equal(f.submits.length,1);assert.equal(f.spawns,1);
});
test('closing while quiescence proof is pending cannot activate a route after owner loss',async t=>{
 const f=await dispatchFixture(t),d=deferred();let entered=false;f.onProof=()=>{entered=true;return d.promise;};
 const activating=assert.rejects(f.service.dispatch.activate(),/closed/);await until(()=>entered);const closing=f.service.close();
 await assert.rejects(ownLifecycleJournal(f.file),/in use/);d.resolve();await activating;assert.equal((await closing).released,true);
 assert.equal(f.service.dispatch.state()[0].activated,false);assert.equal(f.spawns,0);
});
