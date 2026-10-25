// Real Host planner, independent local release pins, no VM or public RPC.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fakeBaseRpc } from './helpers/fake-base-rpc.mjs';
const rpc=await fakeBaseRpc();
const { Host }=await import('../windows/node/host.mjs');
const { IsolationManagerClient }=await import('../windows/node/isolation-client.mjs');
const { DESKTOP_DERIVATION, DESKTOP_PORTS }=await import('../relay/shield-desktop-derive.mjs');
after(()=>rpc.close());
const v=JSON.parse(fs.readFileSync(new URL('../isolation/contract/catalog/desktop_vectors.json',import.meta.url))).ok.find(x=>x.name==='baseline');
const release={schema:'enclave-desktop-release/1',controllerCid:v.record.cid,
 controllerSha256:v.mapping.componentSha256,runtimeId:v.record.runtimeId,profileSha256:v.record.desktop.profileSha256,
 igvmSha256:'55'.repeat(32),launchMeasurement:'66'.repeat(32),minimumCpuMilli:250,policy:{cpuPercent:800,vcpus:8}};
const manager=()=>({backend:'hyperv-partition-per-app',canStart:true,catalog:{derivations:[DESKTOP_DERIVATION]},
 desktop:{ready:true,...structuredClone(release)},supports:{desktop:true,config:true,configCid:true,secrets:true,ports:true}});
function host(t,enabled=true) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-host-pins-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'release.json');const bytes=Buffer.from(JSON.stringify(release));fs.writeFileSync(file,bytes);
 const saved={};for(const key of ['ENCLAVE_DESKTOP_RELEASE_FILE','ENCLAVE_DESKTOP_RELEASE_SHA256']){saved[key]=process.env[key];delete process.env[key];}
 if(enabled){process.env.ENCLAVE_DESKTOP_RELEASE_FILE=file;process.env.ENCLAVE_DESKTOP_RELEASE_SHA256=crypto.createHash('sha256').update(bytes).digest('hex');}
 let h;
 try {h=new Host({dir,endpoint:'https://api.enclave.host/t/test',name:'test',isolationManager:'http://127.0.0.1:1',
  isolationRuntimeId:'77'.repeat(32),desktopRelease:release});}
 finally {for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
 h.secrets.set(v.record.secretDeployment,{syntheticTestMarker:'present'});
 h.appConfig=async()=>({egress:'public-web',codec:'h264'});
 return {h,file};
}
function verdict(h){return h.isolationVerdict(v.record.secretDeployment,{cpuMilli:500n,gpuMilli:750n,isPublic:true},
 {appId:v.record.catalog.app,index:1,cid:v.record.cid,memMb:16384,ports:['http:8000',...DESKTOP_PORTS].join(','),configCid:''},
 {envRead:true,envOpts:{isolationRequire:'hyperv-partition-per-app'}});}
test('Host passes independent immutable release to the native planner',async t=>{
 t.mock.method(IsolationManagerClient.prototype,'health',async()=>manager());
 const {h,file}=host(t);fs.writeFileSync(file,'{}');
 const p=await verdict(h);assert.equal(p.ok,true,JSON.stringify(p));assert.equal(p.derivation,DESKTOP_DERIVATION);
 assert.equal(p.spawn.derive.runtimeId,release.runtimeId);assert.notEqual(p.spawn.derive.runtimeId,h.cfg.isolationRuntimeId);
 assert.throws(()=>{h.desktopRelease=structuredClone(release);},TypeError);
});
test('manager or ordinary cfg cannot install native release authority',async t=>{
 t.mock.method(IsolationManagerClient.prototype,'health',async()=>({...manager(),desktopRelease:release}));
 const {h}=host(t,false);assert.equal(h.desktopRelease,null);assert.equal((await verdict(h)).ok,false);
});
test('Host refuses manager image mismatch and unknown secret state',async t=>{
 t.mock.method(IsolationManagerClient.prototype,'health',async()=>{const m=manager();m.desktop.igvmSha256='99'.repeat(32);return m;});
 const {h}=host(t);assert.equal((await verdict(h)).input,'manager.desktop.igvmSha256');
 t.mock.restoreAll();t.mock.method(IsolationManagerClient.prototype,'health',async()=>manager());
 h.secrets.clear();const p=await verdict(h);assert.equal(p.input,'hasSecrets');assert.equal(p.unknown,true);
});
test('client retains only explicit native identity fields for adoption checks',async()=>{
 const native={id:'test',name:v.record.secretDeployment,status:'running',derivation:DESKTOP_DERIVATION,
  componentSha256:release.controllerSha256,recordSha256:v.mapping.recordSha256,
  desktop:{...v.record.desktop,ignored:'not part of identity'}};
 const c=new IsolationManagerClient({base:'http://127.0.0.1:1',fetchImpl:async()=>new Response(JSON.stringify([native]))});
 const got=await c.findByName(native.name);assert.equal(got.derivation,DESKTOP_DERIVATION);
 assert.equal(got.componentSha256,release.controllerSha256);assert.deepEqual(got.desktop,v.record.desktop);
});

import { canonical, sha256Hex } from '../relay/shield-derive.mjs';
async function adoptionFixture(t,{race=false,stale=false}={}) {
 t.mock.method(IsolationManagerClient.prototype,'health',async()=>manager());
 const {h}=host(t);h.walletPolicyRefusal=async()=>null;h.heldReason=()=>null;h.capRefusal=()=>null;
 const planned=await verdict(h);assert.equal(planned.ok,true);const record=planned.spawn.derive;
 let live={id:'native-test',name:record.secretDeployment,status:'running',appId:v.mapping.appId,
  derivation:DESKTOP_DERIVATION,recordSha256:sha256Hex(canonical(record)),componentSha256:release.controllerSha256,
  runtimeId:release.runtimeId,imageRole:'desktop',igvmSha256:release.igvmSha256,image:release.igvmSha256,
  desktop:structuredClone(record.desktop),catalog:record.catalog,cid:record.cid,tier:'T0-hv',hostExcluded:false};
 let reads=0,removed=0,spawned=0;
 if(stale)live.recordSha256='99'.repeat(32);
 t.mock.method(IsolationManagerClient.prototype,'findByName',async()=>{
  reads++;if(race&&reads===3)live.componentSha256='99'.repeat(32);return live?structuredClone(live):null;
 });
 t.mock.method(IsolationManagerClient.prototype,'get',async()=>live?structuredClone(live):null);
 t.mock.method(IsolationManagerClient.prototype,'remove',async()=>{removed++;live=null;return {removed:true};});
 t.mock.method(IsolationManagerClient.prototype,'spawn',async()=>{spawned++;throw new Error('test ends before replacement launch');});
 const result=await h.ensureApp(record.secretDeployment,{appRef:`catalog://${record.catalog.app}/1`,
  leaseUntil:Math.floor(Date.now()/1000)+3600,cpuMilli:500,gpuMilli:750,isPublic:true,
  owner:'0x29479bf04ed889d46a7afb7f292b9bb26e12647c',
  configCid:JSON.stringify({isolation:{require:'hyperv-partition-per-app'}})},
  {version:{appId:record.catalog.app,index:1,version:1,cid:record.cid,memMb:16384,
   ports:['http:8000',...DESKTOP_PORTS].join(','),configCid:'',yanked:false}});
 return {result,reads,removed,spawned,h};
}
test('Host routes an exact native identity and preserves hostExcluded=false',async t=>{
 const {result,removed,spawned}=await adoptionFixture(t);assert.equal(result.status,'running',result.reason);
 assert.equal(result.isolation.hostExcluded,false);assert.equal(removed,0);assert.equal(spawned,0);
});
test('identity changed between precheck and reconcile is retired without routing',async t=>{
 const {result,removed,spawned}=await adoptionFixture(t,{race:true});
 assert.equal(result.status,'provisioning',result.reason);assert.match(result.reason,/componentSha256/);
 assert.equal(result.isolation,null);assert.equal(removed,1);assert.equal(spawned,0);
});
test('same catalog but stale native record is removed before any replacement attempt',async t=>{
 const {result,removed,spawned}=await adoptionFixture(t,{stale:true});
 assert.notEqual(result.status,'running');assert.equal(result.isolation,null);
 assert.equal(removed,1);assert.equal(spawned,1);
});
