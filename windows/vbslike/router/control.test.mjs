import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {CompositeManager,LaunchJournal} from './control.mjs';
const pins={deployment:'0x'+'1'.repeat(64),catalogApp:'0x'+'2'.repeat(64),catalogVersion:0,cid:'b'+'a'.repeat(58),runtimeId:'3'.repeat(64),profileSha256:'4'.repeat(64),igvmSha256:'5'.repeat(64),controllerSha256:'6'.repeat(64)};
const nd='nd'+'7'.repeat(32);
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'.enclave-router-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 LaunchJournal.initialize(path.join(dir,'pending.json'));const journal=new LaunchJournal(path.join(dir,'pending.json'));
 const base={backend:'hyperv-partition-per-app',boundary:{tier:'t0-hv',hostExcluded:false},inventory:{state:'ready'},cpu:{poolVcpus:16,unitsPerVcpu:100000,hostLogicalProcessors:16},memory:{poolMiB:98304},physicalMemory:{poolMiB:84992},supports:{desktop:true,gpu:true},desktop:{ready:true,...Object.fromEntries(['runtimeId','profileSha256','igvmSha256','controllerSha256'].map(k=>[k,pins[k]]))},catalog:{derivations:['enclave-catalog-bundle/7','enclave-catalog-bundle/8'],derives:['enclave-catalog-bundle/7','enclave-catalog-bundle/8']},canStart:true,preflight:{roles:{desktop:{ok:true}}}};
 const health={legacy:{...structuredClone(base),managerEpoch:'old',vmScope:{prefix:'enclave-app-'}},native:{...structuredClone(base),managerEpoch:'new',vmScope:{prefix:'enclave-native-'}}};
 const rows={legacy:[{id:'hv1234',name:'0x'+'8'.repeat(64),status:'running',imageRole:'legacy',cpu:{grantedUnits:400000},memory:{appMiB:24576},physicalMemoryMiB:25216,gpuMilli:0}],native:[]};
 const calls=[];let action=null;
 const request=async(role,method,p,body,headers)=>{
  calls.push({role,method,path:p,body,headers});
  if(method==='GET'&&p==='/health')return {status:200,body:structuredClone(health[role])};
  if(method==='GET'&&p==='/vms')return {status:200,body:{managerEpoch:health[role].managerEpoch,vms:structuredClone(rows[role])}};
  if(action)return action(role,method,p,body,headers);
  if(method==='POST'&&p==='/vms'){
   const r={id:body.id||'hv5678',name:body.name,status:'starting',runtimeId:pins.runtimeId,cid:body.derive.cid,catalog:body.derive.catalog,desktop:body.derive.desktop,imageRole:role==='native'?'desktop':'legacy',cpu:{grantedUnits:400000},memory:{appMiB:24576},physicalMemoryMiB:role==='native'?32768:25216,gpuMilli:role==='native'?500:0};
   rows[role].push(r);return {status:201,body:structuredClone(r)};
  }
  return {status:404,body:{error:'not_found'}};
 };
 const manager=new CompositeManager({availableMemoryMiB:async()=>100000,request,journal,nativePins:pins,mint:()=>nd});
 const body={name:pins.deployment,cpuShare:.25,gpuShare:.5,hasSecrets:true,isPublic:true,derive:{derivation:'enclave-catalog-bundle/8',catalog:{app:pins.catalogApp,version:0},cid:pins.cid,runtimeId:pins.runtimeId,secretDeployment:pins.deployment,http:8000,ports:['tcp:47984','tcp:47989','tcp:48010','udp:47998','udp:47999','udp:48000'],configBase64:'e30=',desktop:{profile:'kvm-box-masked-v1',profileSha256:pins.profileSha256,gpuMilli:500},policy:{memMiB:8192,cpuPercent:400,vcpus:4}}};
 return {manager,journal,health,rows,calls,body,request,setAction:f=>action=f};
}
test('shared pools are not doubled; native image substitutes only desktop capability',async t=>{
 const f=fixture(t),h=(await f.manager.health()).body;
 assert.equal(h.memory.poolMiB,98304);assert.equal(h.physicalMemory.poolMiB,84992);assert.equal(h.physicalMemory.allocatedMiB,25216);assert.equal(h.boundary.hostExcluded,false);
 assert.equal(h.desktop.igvmSha256,pins.igvmSha256);assert.equal(h.vmScopes.length,2);
});
test('native launch is observed in same backend epoch before journal clears',async t=>{
 const f=fixture(t),r=await f.manager.spawn(f.body);assert.equal(r.body.id,nd);assert.equal(f.journal.pending(),false);
 assert.equal(f.rows.native.length,1);assert.equal(f.calls.filter(x=>x.method==='POST')[0].role,'native');
});
for(const [name,mutate] of [
 ['unknown inventory',f=>f.health.native.inventory.state='pending'],
 ['recovered legacy partition',f=>f.rows.legacy[0].recovered=true],
 ['missing physical reservation',f=>delete f.rows.legacy[0].physicalMemoryMiB],
 ['foreign native scope',f=>f.health.native.vmScope.prefix='enclave-app-'],
 ['mismatched memory pools',f=>f.health.native.memory.poolMiB=24576],
 ['unexpected image',f=>f.health.native.desktop.igvmSha256='9'.repeat(64)],
 ['native id in original manager',f=>f.rows.legacy[0].id=nd],
 ['native deployment remains in original manager',f=>f.rows.legacy[0].name=pins.deployment],
 ['oversold shared physical pool',f=>f.rows.legacy[0].physicalMemoryMiB=90000],
])test(name+' refuses before mutation',async t=>{const f=fixture(t);mutate(f);await assert.rejects(f.manager.spawn(f.body));assert.equal(f.calls.some(x=>x.method==='POST'),false);});
test('combined allocation refuses a native launch even when each manager has room',async t=>{
 const f=fixture(t);f.rows.legacy[0].physicalMemoryMiB=60000;await assert.rejects(f.manager.spawn(f.body),/shared capacity/);assert.equal(f.journal.pending(),false);
});
test('aggregate GPU limit is enforced',async t=>{const f=fixture(t);f.rows.legacy[0].gpuMilli=600;await assert.rejects(f.manager.spawn(f.body),/shared capacity/);});
test('concurrent native submissions create once and adopt existing domain',async t=>{
 const f=fixture(t);const r=await Promise.all([f.manager.spawn(f.body),f.manager.spawn(f.body)]);assert.deepEqual(r.map(x=>x.status),[201,409]);assert.equal(f.rows.native.length,1);
});
for(const code of [400,409,500])test('create then HTTP '+code+' keeps durable uncertainty latch',async t=>{
 const f=fixture(t);f.setAction(async()=>{f.rows.native.push({id:nd,name:pins.deployment});return {status:code,body:{error:'ambiguous backend'}};});
 await assert.rejects(f.manager.spawn(f.body),e=>e.status===503);assert.equal(f.journal.pending(),true);
 const restarted=new CompositeManager({availableMemoryMiB:async()=>100000,request:f.request,journal:new LaunchJournal(f.journal.file),nativePins:pins});
 await assert.rejects(restarted.spawn(f.body),/unreconciled/);assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
});
for(const mode of ['timeout','unobserved success','epoch changed'])test(mode+' never releases uncertain reservation',async t=>{
 const f=fixture(t);f.setAction(async()=>{if(mode==='timeout')throw Error('deadline');if(mode==='epoch changed')f.health.native.managerEpoch='changed';return {status:201,body:{id:nd,name:pins.deployment}};});
 await assert.rejects(f.manager.spawn(f.body));assert.equal(f.journal.pending(),true);await assert.rejects(f.manager.spawn(f.body),/unreconciled/);
});
test('journal write failure prevents backend mutation',async t=>{
 const f=fixture(t);f.journal.begin=()=>{throw Error('disk full');};await assert.rejects(f.manager.spawn(f.body),/disk full/);assert.equal(f.calls.some(x=>x.method==='POST'),false);
});
test('legacy GET/custody remains on original manager with exact bytes even if native unhealthy',async t=>{
 const f=fixture(t);f.health.native.inventory.state='pending';const bytes=Buffer.from('{ "signed": true }\n'),headers={'x-enclave-custody-callback':'signed-header'};
 await f.manager.handle('POST','/vms/hv1234/custody-auth',bytes,headers);const call=f.calls.at(-1);assert.equal(call.role,'legacy');assert.equal(call.body,bytes);assert.equal(call.headers,headers);
});
test('forged native namespace and deployment cannot be sent to legacy backend',async t=>{
 const f=fixture(t);for(const patch of [{id:nd,derive:{derivation:'enclave-catalog-bundle/7'}},{name:'0x'+'9'.repeat(64)},{cpuShare:.5},{gpuShare:1}])await assert.rejects(f.manager.spawn({...f.body,...patch}));assert.equal(f.calls.some(x=>x.method==='POST'),false);
});
for(const mode of ['missing','truncated','bad digest','group-readable','symlink','missing parent'])test('journal '+mode+' refuses reads and launches',async t=>{
 const f=fixture(t),file=f.journal.file;
 if(mode==='missing')fs.unlinkSync(file);
 if(mode==='truncated')fs.appendFileSync(file,'{"partial":');
 if(mode==='bad digest')fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('observed','pending'));
 if(mode==='group-readable')fs.chmodSync(file,0o640);
 if(mode==='symlink'){fs.renameSync(file,file+'.target');fs.symlinkSync(file+'.target',file);}
 if(mode==='missing parent')fs.rmSync(path.dirname(file),{recursive:true});
 assert.throws(()=>new LaunchJournal(file));await assert.rejects(f.manager.spawn(f.body));assert.equal(f.calls.some(c=>c.method==='POST'),false);
});
for(const id of ['nd-invalid','bad/id'])test('backend success with invalid id '+id+' is ambiguous 503',async t=>{
 const f=fixture(t);f.setAction(async()=>({status:201,body:{id,name:pins.deployment}}));
 await assert.rejects(f.manager.spawn(f.body),e=>e.status===503);assert.equal(f.journal.pending(),true);
});
test('unknown backend GPU reservation refuses before POST',async t=>{
 const f=fixture(t);delete f.rows.legacy[0].gpuMilli;await assert.rejects(f.manager.spawn(f.body),e=>e.status===503);assert.equal(f.calls.some(c=>c.method==='POST'),false);
});
for(const [share,inference] of [[undefined,undefined],[0,{gpuMilli:500}],[.5,undefined],[.5,{gpuMilli:250}]])test('legacy GPU declaration mismatch '+share+'/'+JSON.stringify(inference)+' refuses before POST',async t=>{
 const f=fixture(t),body={name:'0x'+'9'.repeat(64),cpuShare:.25,gpuShare:share,derive:{derivation:'enclave-catalog-bundle/4',policy:{memMiB:8192,cpuPercent:400,vcpus:4},inference}};
 await assert.rejects(f.manager.spawn(body),e=>e.status===400);assert.equal(f.calls.some(c=>c.method==='POST'),false);
});
test('invalid inventory id is unavailable, never caller refusal',async t=>{
 const f=fixture(t);f.rows.legacy[0].id='nd-invalid';await assert.rejects(f.manager.spawn(f.body),e=>e.status===503);
});
test('unavailable native inventory disables all admission while keeping legacy reads available',async t=>{
 const f=fixture(t);f.health.native.inventory.state='pending';const h=await f.manager.health();
 assert.equal(h.status,200);assert.equal(h.body.canStart,false);assert.equal(h.body.inventory.state,'pending');assert.deepEqual(h.body.catalog.derivations,[]);assert.equal(h.body.physicalMemory.freeMiB,0);
 await assert.rejects(f.manager.handle('GET','/vms'),e=>e.status===503);
 await f.manager.handle('GET','/vms/hv1234/');assert.equal(f.calls.at(-1).path,'/vms/hv1234/');
});
test('explicit reconciliation requires positive correlated reservation in original epoch',async t=>{
 const f=fixture(t);f.setAction(async(role,method,p,body)=>{
  f.rows.native.push({id:body.id,name:body.name,status:'starting',imageRole:'desktop',runtimeId:body.derive.runtimeId,cid:body.derive.cid,catalog:body.derive.catalog,desktop:body.derive.desktop,cpu:{grantedUnits:400000},memory:{appMiB:24576},physicalMemoryMiB:32768,gpuMilli:500});throw Error('response lost');
 });
 await assert.rejects(f.manager.spawn(f.body));assert.equal(f.journal.pending(),true);
 const result=await f.manager.reconcile();assert.equal(result.body.observed,true);assert.equal(f.journal.pending(),false);
});
for(const mode of ['absent','new epoch','wrong runtime','wrong memory','wrong catalog'])test('reconciliation '+mode+' leaves durable latch',async t=>{
 const f=fixture(t);f.setAction(async(role,method,p,body)=>{
  if(mode!=='absent')f.rows.native.push({id:body.id,name:body.name,status:'starting',imageRole:'desktop',runtimeId:body.derive.runtimeId,cid:body.derive.cid,catalog:body.derive.catalog,desktop:body.derive.desktop,cpu:{grantedUnits:400000},memory:{appMiB:24576},physicalMemoryMiB:32768,gpuMilli:500});throw Error('response lost');
 });
 await assert.rejects(f.manager.spawn(f.body));
 if(mode==='new epoch')f.health.native.managerEpoch='restarted';
 if(mode==='wrong runtime')f.rows.native[0].runtimeId='0'.repeat(64);
 if(mode==='wrong memory')f.rows.native[0].memory.appMiB=8192;
 if(mode==='wrong catalog')f.rows.native[0].catalog={app:pins.catalogApp,version:1};
 await assert.rejects(f.manager.reconcile());assert.equal(f.journal.pending(),true);
});
test('decoded routing preserves original authenticated path',async t=>{
 const f=fixture(t),bytes=Buffer.from('signed'),p='/vms/%68v1234/custody-auth/?probe=1';
 await f.manager.handle('POST',p,bytes,{});assert.equal(f.calls.at(-1).path,p);assert.equal(f.calls.at(-1).body,bytes);assert.equal(f.calls.at(-1).role,'legacy');
});
test('shared CPU reservations are aggregated across managers',async t=>{
 const f=fixture(t);f.rows.legacy[0].cpu.grantedUnits=1400000;
 await assert.rejects(f.manager.spawn(f.body),e=>e.status===507);assert.equal(f.calls.some(x=>x.method==='POST'),false);
 const h=(await f.manager.health()).body;assert.equal(h.cpu.allocatedUnits,1400000);assert.equal(h.cpu.freeUnits,200000);
});
test('unknown CPU allocation and different CPU pools fail closed',async t=>{
 const f=fixture(t);delete f.rows.legacy[0].cpu;await assert.rejects(f.manager.spawn(f.body),e=>e.status===503);
 f.rows.legacy[0].cpu={grantedUnits:100000};f.health.native.cpu.poolVcpus=32;await assert.rejects(f.manager.spawn(f.body),e=>e.status===503);
});
function legacyBody(){return {name:'0x'+'9'.repeat(64),cpuShare:.25,gpuShare:0,hasSecrets:false,isPublic:true,derive:{derivation:'enclave-catalog-bundle/1',catalog:{version:0,app:'0x'+'a'.repeat(64)},cid:'b'+'a'.repeat(58),runtimeId:pins.runtimeId,policy:{cpuPercent:100,memMiB:128,vcpus:1}}};}
for(const [name,change] of [
 ['non-deployment name',b=>b.name='invalid'],['bad catalog',b=>b.derive.catalog.app='invalid'],['bad CID',b=>b.derive.cid='not-a-cid'],['wrong witness',b=>{b.name='shield-readiness-v1';b.cpuShare=0;b.derive.policy={cpuPercent:100,memMiB:256,vcpus:1};}],
])test('deterministic legacy '+name+' refuses without persistent latch',async t=>{
 const f=fixture(t),b=legacyBody();f.health.legacy.catalog.runtimeId=pins.runtimeId;f.health.legacy.catalog.derivations.push('enclave-catalog-bundle/1');change(b);
 await assert.rejects(f.manager.spawn(b),e=>e.status===400);assert.equal(f.journal.pending(),false);assert.equal(f.calls.some(c=>c.method==='POST'),false);
});
test('successful legacy request correlates catalog fields independent of key order',async t=>{
 const f=fixture(t),b=legacyBody();f.health.legacy.catalog.runtimeId=pins.runtimeId;f.health.legacy.catalog.derivations.push('enclave-catalog-bundle/1');
 const r=await f.manager.spawn(b);assert.equal(r.status,201);assert.equal(f.journal.pending(),false);
});
test('physical host floor is checked before durable intent and POST',async t=>{
 const f=fixture(t);f.manager.availableMemoryMiB=async()=>40000;
 await assert.rejects(f.manager.spawn(f.body),e=>e.status===507);assert.equal(f.journal.pending(),false);assert.equal(f.calls.some(c=>c.method==='POST'),false);
});
test('journal maintenance threshold disables admission but preserves existing reads',async t=>{
 const f=fixture(t);for(let i=0;i<10;i++)f.journal.append('observed',{maintenanceFixture:'x'.repeat(91000)});
 assert.equal(f.journal.hasCapacity(),false);assert.equal((await f.manager.health()).body.canStart,false);
 await assert.rejects(f.manager.spawn(f.body),/maintenance/);assert.equal(f.calls.some(c=>c.method==='POST'),false);
 await f.manager.handle('GET','/vms/hv1234');assert.equal(f.calls.at(-1).role,'legacy');
});
test('unreadable journal disables admission while health and existing reads survive',async t=>{
 const f=fixture(t);fs.appendFileSync(f.journal.file,'partial');assert.equal((await f.manager.health()).body.canStart,false);
 await f.manager.handle('GET','/vms/hv1234');assert.equal(f.calls.at(-1).role,'legacy');
});


test('native router journals the same 32-GiB physical policy as the manager',async t=>{
 const f=fixture(t);f.rows.legacy[0].physicalMemoryMiB=51000;
 const begin=f.journal.begin.bind(f.journal);let recorded;
 f.journal.begin=record=>{recorded=record;return begin(record);};
 const result=await f.manager.spawn(f.body);
 assert.equal(result.status,201);assert.equal(recorded.expected.physicalMiB,32768);
 assert.equal(f.rows.native[0].physicalMemoryMiB,32768);assert.equal(f.journal.pending(),false);
});
