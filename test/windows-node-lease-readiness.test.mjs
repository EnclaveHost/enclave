import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fakeBaseRpc,DEPLOYMENTS,CATALOG} from './helpers/fake-base-rpc.mjs';
process.env.NODE_OPERATOR_KEY='0x'+'7f'.repeat(32);
const rpc=await fakeBaseRpc();
const chain=await import('../windows/node/chain.mjs');
chain.addresses.deployments=DEPLOYMENTS;chain.addresses.appCatalog=CATALOG;chain.loadOperator();
const {Host}=await import('../windows/node/host.mjs');
const dirs=[];after(()=>{rpc.close();for(const dir of dirs)fs.rmSync(dir,{recursive:true,force:true});});
const id='0x'+'ab'.repeat(32), id2='0x'+'ac'.repeat(32),ref='catalog://0x'+'cd'.repeat(32)+'/1',endpoint='https://api.enclave.host/t/lease-readiness-test';
const version={cid:'bafy',version:'1',vramMb:0,gpuGflops:0,memMb:512,cpuGflops:0,createdAt:1n,verified:true,yanked:false,ports:'',approval:1,config:'{}'};
const row=(h,key=id,seconds=3600)=>({id:key,owner:chain.operatorAddress(),appRef:ref,ports:'',configCid:'',gpuMilli:0,cpuMilli:100,appPort:8000,isPublic:true,
 active:true,createdAt:1n,rate:1n,balance6:1000000n,spent6:0n,runner:h.enclaveId,runnerOperator:chain.operatorAddress(),leaseUntil:BigInt(Math.floor(Date.now()/1000)+seconds)});
async function box(answer=async()=>null){
 rpc.row.current=null;rpc.rows.current=null;rpc.rows.failGet=null;rpc.chainTx.mine=false;rpc.catalog.current=version;
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lease-readiness-'));dirs.push(dir);
 const cfg={dir,endpoint,name:'test',appsEnabled:true,vcpus:8,ramGb:16,cpuPricePerSec6:0,hostAdmission:{hostId:chain.enclaveIdOf(endpoint),refusal:answer}};
 const h=new Host(cfg);h.chainReady=true;h.registered={cpuPricePerSec6:'0'};await h.refreshOwners();
 for(const name of ['followBook','enforceOff','ensureRegistered','ensurePriced','scanLedger','retireForeignRecovered'])h[name]=async()=>{};
 h.ensureApp=async key=>{const r={...h.records.get(key),status:'running'};h.records.set(key,r);return r;};
 return {h,cfg};
}
function serving(h,key=id){h.tracked.add(key);h.records.set(key,{id:key,status:'running',appRef:ref,isolationRequired:false});h.apps.set(key,{state:'running',stop:async()=>{},alive:async()=>true});}
const health=(h,key=id)=>h.leaseReadiness().deployments.find(r=>r.id===key);

test('cold process cannot advertise a completed pass, even with a persisted tracked deployment',async()=>{
 const {h,cfg}=await box();fs.writeFileSync(path.join(cfg.dir,'host-state.json'),JSON.stringify({tracked:[id],leaseReadiness:{sequence:100,completedAt:Date.now()}}));
 const restarted=new Host(cfg);assert.ok(restarted.tracked.has(id));assert.deepEqual(restarted.leaseReadiness(),{sequence:0,startedAt:0,completedAt:0,inFlight:false,deployments:[]});
});

test('completed pass reports actual lease/runner and running adoption without sending needless renewal',async()=>{
 const {h}=await box();serving(h);rpc.row.current=row(h);const before=rpc.chainTx.sent.length;const t=Date.now();await h.tick();
 const r=h.leaseReadiness();assert.equal(r.sequence,1);assert.equal(r.inFlight,false);assert.ok(r.completedAt>=r.startedAt&&r.startedAt>=t);
 assert.equal(health(h).status,'ready');assert.equal(health(h).runner,h.enclaveId.toLowerCase());assert.equal(health(h).leaseUntil,Number(rpc.row.current.leaseUntil));assert.ok(health(h).observedAt>=t);assert.equal(rpc.chainTx.sent.length,before);
 r.deployments[0].status='forged';assert.equal(health(h).status,'ready','returned rows cannot alter private readiness');
});

test('slow policy remains pending; overlapping tick joins the same pass',async()=>{
 let release,entered;const seen=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 const {h}=await box(async()=>{entered();await gate;return null;});serving(h);rpc.row.current=row(h);
 const a=h.tick();await seen;const b=h.tick();assert.equal(a,b);assert.equal(h.leaseReadiness().completedAt,0);assert.equal(h.leaseReadiness().inFlight,true);assert.equal(health(h).status,'pending');
 release();await a;assert.equal(health(h).status,'ready');assert.equal(h.leaseReadiness().sequence,1);
});

test('a failed subsequent pass clears old completion and ready rows',async()=>{
 const {h}=await box();serving(h);rpc.row.current=row(h);await h.tick();assert.equal(health(h).status,'ready');
 h.followBook=async()=>{throw Error('book unavailable');};await assert.rejects(h.tick(),/book unavailable/);
 assert.equal(h.leaseReadiness().sequence,2);assert.equal(h.leaseReadiness().completedAt,0);assert.equal(h.leaseReadiness().inFlight,false);assert.equal(health(h).status,'pending');
});

test('unknown wallet policy cannot reuse earlier ready evidence',async()=>{
 let unknown=false;const {h}=await box(async()=>{if(unknown)throw Error('policy unavailable');return null;});serving(h);rpc.row.current=row(h);await h.tick();assert.equal(health(h).status,'ready');
 unknown=true;await h.tick();assert.equal(health(h).status,'pending');assert.notEqual(h.records.get(id).status,'running');
});

test('one unreadable lease never hides behind another running deployment',async()=>{
 const {h}=await box();serving(h);serving(h,id2);rpc.rows.current=[row(h),row(h,id2)];rpc.rows.failGet=key=>key===id2;
 await h.tick();assert.equal(health(h).status,'ready');assert.equal(health(h,id2).status,'pending');assert.ok(h.leaseReadiness().completedAt>0);
});

test('renewal failure is not ready even though the existing app remains running',async()=>{
 const {h}=await box();serving(h);rpc.row.current=row(h,id,60);await h.tick();
 assert.equal(h.records.get(id).status,'running');assert.match(h.records.get(id).reason,/renew failed|will not renew/);assert.equal(health(h).status,'not-ready');
});

test('unsuccessful adoption never reports readiness',async()=>{
 const {h}=await box();serving(h);h.apps.delete(id);rpc.row.current=row(h);h.ensureApp=async()=>{h.records.set(id,{...h.records.get(id),status:'held'});};
 await h.tick();assert.equal(health(h).status,'not-ready');
});

// a NATIVE gate: the cutover helper is PowerShell (cutover/tools beside this repository). Without a PowerShell (PWSH) and
// those tools it cannot run here; it is then reported NOT RUN, never passed (run-suite.py counts it separately).
const cutoverTools=new URL('../../cutover/tools/gate-from-report.ps1',import.meta.url);
const nativeGate=!process.env.PWSH?'NOT RUN (native gate): no PowerShell (PWSH unset); the cutover gate is a native PowerShell check':
 !fs.existsSync(cutoverTools)?'NOT RUN (native gate): cutover/tools/gate-from-report.ps1 is not beside this repository':false;
test('actual Host readiness serializes into the exact cutover gate; a cold successor is refused',{skip:nativeGate},async()=>{
 const {spawnSync}=await import('node:child_process');const {fileURLToPath}=await import('node:url');
 const here=path.dirname(fileURLToPath(import.meta.url));const tools=path.resolve(here,'../../cutover/tools');
 const script=path.resolve(tools,'../helper/node-hold-cutover.ps1');const sinceMs=Date.now()-1;
 const {h,cfg}=await box();serving(h);rpc.row.current=row(h);await h.tick();
 const file=path.join(cfg.dir,'readiness-fixture.json');
 function gate(host){
  fs.writeFileSync(file,JSON.stringify({sinceMs,params:{runner:h.enclaveId,expectedIds:[id],lease:{marginSec:180}},state:{deployments:host.deployments(),leaseReadiness:host.leaseReadiness()}}));
  const r=spawnSync(process.env.PWSH,['-NoProfile','-NonInteractive','-File',path.join(tools,'gate-from-report.ps1'),'-Script',script,'-Fixture',file],{encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout).ready;
 }
 assert.equal(gate(h),true);assert.equal(gate(new Host(cfg)),false);
});
