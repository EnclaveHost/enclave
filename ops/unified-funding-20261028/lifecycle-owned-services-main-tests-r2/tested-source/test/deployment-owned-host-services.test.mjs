import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setup, id, host, hash, pending, deferred, until } from './helpers/owned-host-services-fixture.mjs';
import { ownHostLifecycleRuntime } from '../network/deployment-owned-host-services.mjs';
import { ownLifecycleJournal } from '../network/deployment-journal-owner.mjs';
import { signServingPermit, servingPermitTypedData } from '../network/deployment-serving-permit.mjs';

async function fixture(t){const f=await setup();t.after(()=>f.cleanup());return f;}
test('owned runtime and three real signers serve v2, withdraw and cold reopen without settling an intent',async t=>{
 const f=await fixture(t);assert.equal((await f.service.runtime.ensureStaged(id,f.queued)).ready,true);
 await f.service.runtime.serve(id,f.running);assert.equal(f.allowed,true);
 assert.equal(f.service.gate.assert(id,{host,generation:2,hostAuthority:f.evidence.context.digest}),1018000);
 const before=fs.readFileSync(f.file);assert.equal((await f.service.close()).released,true);
 assert.equal(f.vm,null);assert.equal(f.allowed,false);assert.deepEqual(fs.readFileSync(f.file),before,'withdrawal does not mutate a closed parent');
 const next=await ownHostLifecycleRuntime(f.file,{...f.options,ownerOptions:{}});f.service=next;
 assert.deepEqual(next.journal.read(id).pending,pending);
 await assert.rejects(next.runtime.serve(id,f.running),/not verified/);assert.equal(f.allows,1);
});
test('a host owner revision withdraws the existing grant and rejects its old signatures',async t=>{
 const f=await fixture(t);await f.service.runtime.ensureStaged(id,f.queued);await f.service.runtime.serve(id,f.running);
 const envelope=await f.collect({...f.record,sequence:2});f.service.gate.observeHostAuthority(f.context('2'));
 await until(()=>!f.vm);assert.equal(f.allowed,false);
 await assert.rejects(f.service.gate.install(envelope,await f.read()),/rollback/);
});
test('a host authority advance retires staged compute before its first serving grant',async t=>{
 const f=await fixture(t);await f.service.runtime.ensureStaged(id,f.queued);
 f.service.gate.observeHostAuthority(f.context('2'));await until(()=>!f.vm);
 assert.equal(f.allows,0);assert.deepEqual(f.removed,['instance-1']);
 assert.equal((await f.service.close()).released,true);
});
test('authenticated Offline persists across cold reopen and cannot be undone by same-generation Online',async t=>{
 const f=await fixture(t);await f.service.runtime.ensureStaged(id,f.queued);await f.service.runtime.serve(id,f.running);
 const envelope=await f.collect({...f.record,sequence:2});
 assert.equal(f.service.gate.observeHostEvidence({...f.evidence,status:'offline',proofVerified:false}),'ignored');assert.equal(f.allowed,true);
 f.service.gate.observeHostEvidence({...f.evidence,status:'offline'});await until(()=>!f.vm);await f.service.close();
 const next=await ownHostLifecycleRuntime(f.file,{...f.options,ownerOptions:{}});f.service=next;
 await assert.rejects(next.gate.install(envelope,await f.read()),/Offline/);assert.deepEqual(next.journal.read(id).pending,pending);
});
test('close during a raw spawn retains the parent lock until the late exact instance is removed',async t=>{
 const f=await fixture(t),d=deferred();let entered=false;
 f.client.spawn=()=>{entered=true;return d.promise;};
 const staging=assert.rejects(f.service.runtime.ensureStaged(id,f.queued),/closed|revoked/);await until(()=>entered);
 let closed=false;const closing=f.service.close().then(r=>{closed=true;return r;});
 await assert.rejects(ownLifecycleJournal(f.file),/in use/);assert.equal(closed,false);
 f.vm={id:'late-owned',name:id,status:'running'};d.resolve({view:f.vm});await staging;
 assert.equal((await closing).released,true);assert.equal(f.vm,null);assert.deepEqual(f.removed,['late-owned']);assert.equal(f.allows,0);
});
test('authority advance invalidates an in-flight spawn before staged compute exists',async t=>{
 const f=await fixture(t),d=deferred();let entered=false;
 f.client.spawn=()=>{entered=true;return d.promise;};
 const staging=assert.rejects(f.service.runtime.ensureStaged(id,f.queued),/closed|revoked/);await until(()=>entered);
 f.service.gate.observeHostAuthority(f.context('2'));
 f.vm={id:'old-authority-late',name:id,status:'running'};d.resolve({view:f.vm});await staging;
 assert.equal(f.vm,null);assert.deepEqual(f.removed,['old-authority-late']);assert.equal(f.allows,0);
 assert.equal((await f.service.close()).released,true);
});
test('a permit collector response after app revocation cannot reopen the boundary',async t=>{
 const f=await fixture(t);await f.service.runtime.ensureStaged(id,f.queued);
 const d=deferred();let entered=false;const collect=f.collect;
 f.collect=async record=>{const envelope=await collect(record);entered=true;await d.promise;return envelope;};
 const serving=assert.rejects(f.service.runtime.serve(id,f.running),/closed|revoked/);await until(()=>entered);
 const retiring=f.service.gate.revoke(id);d.resolve();await serving;await retiring;
 assert.equal(f.allows,0);assert.equal(f.vm,null);assert.equal((await f.service.close()).released,true);
});
test('close waits for raw allow and fences a late remote effect before releasing ownership',async t=>{
 const f=await fixture(t);await f.service.runtime.ensureStaged(id,f.queued);
 const d=deferred();let entered=false;
 f.boundaries.allow=async(deployment,grant)=>{entered=true;await d.promise;f.allowed=true;return {deployment,...grant,expiryEnforced:true};};
 const serving=assert.rejects(f.service.runtime.serve(id,f.running),/no current|closed/);await until(()=>entered);
 let closed=false;const closing=f.service.close().then(r=>{closed=true;return r;});await until(()=>!f.vm);
 await assert.rejects(ownLifecycleJournal(f.file),/in use/);assert.equal(closed,false);
 d.resolve();await serving;assert.equal((await closing).released,true);assert.equal(f.allowed,false);
});
test('a witness refuses a host authority change during its final asynchronous read',async t=>{
 const f=await fixture(t);let reads=0;const read=f.read;
 f.read=async()=>{reads++;if(reads===3)f.evidence={...f.evidence,context:f.context('2')};return read();};
 const sig=await signServingPermit(f.accounts[3],f.pins,f.record);
 await assert.rejects(f.witnesses[0].witness.permit(f.record,sig),/changed/);assert.equal(reads,3);
 assert.ok(f.witnesses[0].journal.read(id).digest,'the signing intent remains durable');
});
test('witness close keeps its owner through a late authority read and releases no signature',async t=>{
 const f=await fixture(t),d=deferred();let reads=0;const read=f.read;
 f.read=async()=>{if(++reads===3)await d.promise;return read();};
 const sig=await signServingPermit(f.accounts[3],f.pins,f.record);
 const signing=assert.rejects(f.witnesses[0].witness.permit(f.record,sig),/closed|released/);await until(()=>reads===3);
 const closing=f.witnesses[0].close();await assert.rejects(ownLifecycleJournal(f.dir+'/witness-0.json'),/in use/);
 d.resolve();await signing;assert.equal((await closing).released,true);
});
test('v2 binds a separate signature domain and requires explicit profile selection',async t=>{
 const f=await fixture(t);const typed=servingPermitTypedData(f.pins,f.record);assert.equal(typed.domain.version,'2-host-authority');
 assert.throws(()=>servingPermitTypedData({...f.pins,servingPermit:undefined,profile:'independent-host-registry-r1'},f.record),/requires/);
 assert.throws(()=>servingPermitTypedData(f.pins,{...f.record,hostAuthority:undefined}),/missing/);
});
for(const mode of ['unacknowledged-hold','replacement'])test(mode+' retains ownership until exact process death',async t=>{
 const child=fork(new URL('./helpers/owned-host-services-failure-child.mjs',import.meta.url),[mode],{stdio:['ignore','ignore','inherit','ipc'],execArgv:[]});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const dead=once(child,'exit');child.kill('SIGKILL');await dead;}});
 let timer;let result;try{[result]=await Promise.race([once(child,'message'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('failure child timeout')),5000);})]);}finally{clearTimeout(timer);}
 assert.equal(result.released,false);assert.equal(result.fenced,true);assert.deepEqual(result.pending,pending);
 assert.equal(result.foreignRemoved,false);await assert.rejects(ownLifecycleJournal(result.file),/in use/);
 const dead=once(child,'exit');child.kill('SIGKILL');assert.equal((await dead)[1],'SIGKILL');
 const parent=await ownLifecycleJournal(result.file);assert.deepEqual(parent.journal.read(id).pending,pending);await parent.close();
 fs.rmSync(result.dir,{recursive:true,force:true});
});
