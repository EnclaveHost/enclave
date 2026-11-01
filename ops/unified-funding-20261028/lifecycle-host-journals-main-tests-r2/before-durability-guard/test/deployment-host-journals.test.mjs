import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { ownHostLifecycleJournals } from '../network/deployment-host-journal-owner.mjs';
import { ownLifecycleJournal } from '../network/deployment-journal-owner.mjs';
import { openLockedHostAuthorityJournal } from '../network/deployment-host-authority-journal.mjs';
import { hostAuthorityContextOf } from '../network/deployment-host-authority.mjs';
import { hostIncarnationOf } from '../network/lifecycle-host-profile.mjs';

const h = '0x'+'11'.repeat(32), app='0x'+'22'.repeat(32), hash='0x'+'33'.repeat(32), other='0x'+'44'.repeat(32);
const registry='0x'+'55'.repeat(20), wallet='0x'+'66'.repeat(20);
const intent={digest:hash,payload:'{"unsettled":true}'};
function fixture(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'host-journals-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return path.join(dir,'state.json'); }
function context(generation='1',status='online') {
 const hr={scope:'host',codeConsistent:true,registry,generation,status,owner:wallet,revision:generation,policyHash:hash,
  qualificationDigest:hash,trustAnchorId:hash,hardwareId:hash,resourceDigest:hash,descriptorDigest:hash,reporters:{keys:[],threshold:0,revision:'1'}};
 return {inc:hostIncarnationOf(hr,{hostId:h,registryCodeHash:hash}),perm:hostAuthorityContextOf(hr,{chainId:8453,hostId:h,registryCodeHash:hash})};
}
const open=(file,options={})=>ownHostLifecycleJournals(file,{hostId:h,...options});

test('host authority and owner holds survive cold reopen alongside an unresolved transaction',async t=>{
 const file=fixture(t),a=await open(file,{initialize:true}),c=context();
 a.journal.acceptHostAuthority(h,{revision:'7',owner:wallet,policyHash:hash});
 a.journal.holdHostLocal(h,app,{why:'owner-held',at:10});a.journal.prepareTransition(app,intent);
 a.journal.acceptHostIncarnation(h,c.inc);a.journal.bindHostIncarnation(h,app,{generation:'1',digest:c.inc.digest,reason:'fresh',at:10});
 a.hostAuthority.accept(h,c.perm);a.hostAuthority.bind(h,app,c.perm,{kind:'fresh-queued-start',at:10});
 assert.equal((await a.close()).released,true);
 const b=await open(file);t.after(()=>b.close());
 assert.deepEqual(b.journal.read(app).pending,intent);assert.equal(b.journal.readHostAuthority(h).holds[app].why,'owner-held');
 assert.equal(b.journal.readHostAuthority(h).sidecarsEstablished,true);
 assert.equal(b.journal.readHostIncarnation(h).bound[app].digest,c.inc.digest);assert.equal(b.hostAuthority.read(h).bound[app].digest,c.perm.digest);
 assert.throws(()=>b.journal.acceptHostAuthority(h,{revision:'6',owner:wallet,policyHash:hash}),/rollback/);
 assert.throws(()=>b.journal.releaseHostLocal(h,app),/later owner/);
 b.journal.advanceOwnerControls(h);b.journal.releaseHostLocal(h,app);
 assert.deepEqual(b.journal.read(app).pending,intent);
});

test('released parent and sidecar references cannot overwrite a replacement owner',async t=>{
 const file=fixture(t),a=await open(file,{initialize:true});a.journal.prepareTransition(app,intent);await a.close();
 const b=await open(file);t.after(()=>b.close());b.journal.acceptHostAuthority(h,{revision:'8',owner:wallet,policyHash:hash});
 assert.throws(()=>a.journal.settleTransition(app,hash),/closed|released|lock/);
 assert.throws(()=>a.journal.acceptHostAuthority(h,{revision:'9',owner:wallet,policyHash:hash}),/closed|released/);
 assert.throws(()=>a.hostAuthority.accept(h,context().perm),/released/);
 assert.throws(()=>a.journal.acceptHostIncarnation(h,context().inc),/released/);
 assert.equal(b.journal.readHostAuthority(h).floor.revision,'8');assert.deepEqual(b.journal.read(app).pending,intent);
});

test('same-generation Offline survives reopen in both authority sidecars',async t=>{
 const file=fixture(t),a=await open(file,{initialize:true}),c=context();
 a.journal.acceptHostIncarnation(h,c.inc);a.hostAuthority.accept(h,c.perm);
 a.journal.acceptHostIncarnation(h,context('1','offline').inc);
 a.hostAuthority.observe(h,{context:c.perm,status:'offline',proofVerified:true,blockHash:hash,blockNumber:'10'});await a.close();
 const b=await open(file);t.after(()=>b.close());
 assert.throws(()=>b.journal.acceptHostIncarnation(h,c.inc),/Offline/);assert.throws(()=>b.hostAuthority.accept(h,c.perm),/Offline/);
 const next=context('2');b.journal.acceptHostIncarnation(h,next.inc);b.hostAuthority.accept(h,next.perm);
 assert.equal(b.journal.readHostIncarnation(h).floor.generation,'2');assert.equal(b.hostAuthority.read(h).floor.hostGeneration,'2');
});

test('parent provenance rejects lost sidecars even before an authority floor was accepted',async t=>{
 const file=fixture(t),a=await open(file,{initialize:true});a.journal.prepareTransition(app,intent);await a.close();
 for(const suffix of ['.host-incarnation','.host-authority'])for(const name of fs.readdirSync(path.dirname(file)))
  if(name.startsWith(path.basename(file)+suffix))fs.unlinkSync(path.join(path.dirname(file),name));
 await assert.rejects(open(file,{initialize:true}),/missing|uncertain|established/);
 const parent=await ownLifecycleJournal(file);t.after(()=>parent.close());
 assert.deepEqual(parent.journal.read(app).pending,intent);assert.equal(parent.journal.readHostAuthority(h).sidecarsEstablished,true);
});

test('one reentrant withdrawal retains parent and both sidecar locks until actual completion',async t=>{
 const file=fixture(t),a=await open(file,{initialize:true});let finish,calls=0,nested;
 const pending=new Promise(r=>{finish=r;});a.onRelease(()=>{calls++;nested=a.close('reentrant');return pending;});
 const closing=a.close();assert.equal(nested,closing);assert.equal(a.close(),closing);assert.equal(calls,1);
 assert.throws(()=>a.journal.prepareTransition(app,intent),/released|closed/);
 await assert.rejects(ownLifecycleJournal(file),/in use/);
 await assert.rejects(openLockedHostAuthorityJournal(file+'.host-authority'),/in use/);
 finish();assert.equal((await closing).released,true);
 const b=await open(file);await b.close();assert.equal(calls,1);
});

test('sidecar lock loss withdraws the composite owner and retains pending evidence',async t=>{
 const file=fixture(t),a=await open(file,{initialize:true}),c=context();a.journal.prepareTransition(app,intent);a.journal.acceptHostIncarnation(h,c.inc);
 let withdrew=0;a.onRelease(()=>{withdrew++;});fs.unlinkSync(file+'.host-incarnation.lock');
 assert.throws(()=>a.journal.readHostIncarnation(h),/ownership lost/);
 await a.close('observed loss');assert.equal(withdrew,1);assert.throws(()=>a.hostAuthority.accept(h,c.perm),/released/);
 const b=await open(file);t.after(()=>b.close());assert.deepEqual(b.journal.read(app).pending,intent);
});

test('exact child death releases all three owners; cold process retains the hold and transaction',async t=>{
 const file=fixture(t),helper=new URL('./helpers/owned-host-journals-child.mjs',import.meta.url);
 const child=fork(helper,[file],{stdio:['ignore','ignore','inherit','ipc'],execArgv:[]});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const dead=once(child,'exit');child.kill('SIGKILL');await dead;}});
 let timer;try{await Promise.race([once(child,'message'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('child readiness timeout')),3000);})]);}finally{clearTimeout(timer);}
 await assert.rejects(open(file),/in use/);const dead=once(child,'exit');child.kill('SIGKILL');assert.equal((await dead)[1],'SIGKILL');
 const b=await open(file);t.after(()=>b.close());assert.deepEqual(b.journal.read(app).pending,intent);
 assert.equal(b.journal.readHostAuthority(h).holds[app].why,'retained-child-hold');
});
