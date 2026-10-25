import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Manager} from './server.mjs';
import {canonical,sha256Hex,COMPONENT_PREAMBLE} from './derive.mjs';
import {DESKTOP_DERIVATION,DESKTOP_PORTS} from './desktop-derive.mjs';
import {runtimeId} from '../../../isolation/contract/runtime.mjs';
import {BOOT_STATEMENTS} from '../verify/boot-statements.mjs';
import {IsolationManagerClient} from '../../node/isolation-client.mjs';
const H=c=>c.repeat(64);
const component=Buffer.concat([COMPONENT_PREAMBLE,Buffer.from([0,1,0])]);
const runtime={name:'wasmtime',version:'native-test',execution:'jit',targetIsa:'x86_64',hostIsa:'x86_64',cpuFeatures:'baseline',wx:'enforced',cache:'none'};
function fixture(){
 const p=JSON.parse(fs.readFileSync(new URL('./testdata/desktop-platform/profile.json',import.meta.url),'utf8'));
 p.controllerSha256=sha256Hex(component);const profileText=canonical(p).toString()+'\n';
 const platform={igvmSha256:H('f'),runtimeId:runtimeId(runtime).toString('hex'),profileText,profileSha256:sha256Hex(Buffer.from(profileText)),
  media:[['root',p.root.imageBytes,p.root.imageSha256],['hashes',p.root.hashBytes,p.root.hashSha256],['models',p.models.imageBytes,p.models.imageSha256]]
   .map(([role,payloadBytes,payloadSha256],i)=>({role,path:`C:\\media\\${role}.iso`,bytes:payloadBytes+65536,sha256:H(String(i+1)),payloadBytes,payloadSha256,payloadOffset:65536}))};
 const record={derivation:DESKTOP_DERIVATION,catalog:{app:'0x'+H('1'),version:1},cid:'Qm'+'a'.repeat(44),runtimeId:platform.runtimeId,
  policy:{cpuPercent:400,memMiB:8192,vcpus:4},http:8000,ports:[...DESKTOP_PORTS],configBase64:Buffer.from('{"egress":"public-web"}').toString('base64'),secretDeployment:'0x'+H('2'),
  desktop:{profile:'kvm-box-masked-v1',profileSha256:platform.profileSha256,gpuMilli:500}};
 return {platform,record};
}
async function setup(over={}){
 const f=fixture(),state={starts:[],stops:[],judges:[],workerExit:null,egressExit:null,patch:null,stopFails:false};
 const worker={ready:true},transport={stop:async()=>{},exited:new Promise(r=>state.workerExit=r)},egress={stop:async()=>{},exited:new Promise(r=>state.egressExit=r)};
 let manager;
 const backend={canSurvey:true,desktopPlatform:f.platform,backend:'hyperv-partition-per-app',supports:{},survey:async()=>({vms:[]}),
  preflight:async()=>({ok:true,checks:[],hostLogicalProcessors:16,roles:{desktop:{ok:true,checks:[]}}}),
  start:async(mapping,opts)=>{
   state.starts.push({mapping,opts,gpu:manager.gpuAllocated(),ram:manager.physicalRamAllocated()});
   if(state.startGate)await state.startGate;
   const vmMiB=Math.ceil(opts.appMemoryMiB*3/4)*2;
   return {imageRole:'desktop',firmware:{sha256:f.platform.igvmSha256},image:f.platform.igvmSha256,guestIdentity:BOOT_STATEMENTS['linux-direct'],appId:mapping.appId,
    desktop:{profileSha256:f.platform.profileSha256,runtimeId:f.platform.runtimeId,gpuMilli:mapping.record.desktop.gpuMilli},
    memory:{appMiB:opts.appMemoryMiB,vmMiB},cpu:{appCpuPercent:opts.appCpu.appCpuPercent,guestOnlineVcpus:opts.appCpu.vcpus},transport,egress,vmId:'00000000-0000-4000-8000-000000000001',launcherVmId:'00000000-0000-4000-8000-000000000001',launcherKey:'test-key',tcpPort:1234,appReady:true,...state.patch};
  },stop:async h=>{state.stops.push(h);if(state.stopFails)throw Error('worker close uncertain');}};
 const options={backend,images:{legacy:{igvmSha256:H('a')},desktop:{platform:f.platform,runtime:{...runtime}}},desktopWorker:worker,
  ramPoolMiB:32768,physicalRamPoolMiB:32768,cpuPoolVcpus:16,configEnabled:true,secretsEnabled:true,configSocketServer:true,protectedPorts:true,
  egress:{enabled:true,mode:'test'},fetchConfig:async()=>Buffer.from('{}'),fetchComponent:async()=>component,
  judgeReady:async args=>{state.judges.push(args);if(state.judgeGate)await state.judgeGate;return{status:'running',transportKeySha256:H('d')};},...over};
 manager=new Manager(options);await manager.probe();await manager.recover();
 const body={name:f.record.secretDeployment,derive:f.record,cpuShare:.25,gpuShare:.5,hasSecrets:true,isPublic:true,firewall:[...DESKTOP_PORTS]};
 return {...f,manager,state,worker,backend,body,options};
}
const judged=async m=>{await Promise.all([...m.judging.values()]);};
test('native admission reserves full VM RAM and GPU before launch, then judges its own runtime and image',async()=>{
 const h=await setup(),m=h.manager;assert.equal(m.desktopReady,true);assert.ok(m.health().catalog.derivations.includes(DESKTOP_DERIVATION));
 let finish;h.state.judgeGate=new Promise(r=>finish=r);
 const a=await m.spawn(h.body);assert.equal(a.status,'starting');assert.equal(a.appReady,false);
 assert.equal(h.state.starts[0].gpu,500);assert.equal(h.state.starts[0].ram,12288);
 assert.equal(a.physicalMemoryMiB,12288);assert.equal(a.memory.appMiB,8192);
 assert.deepEqual(h.state.judges[0].expectRuntime,runtime);
 assert.equal(h.state.judges[0].expectedImageSha256,h.platform.igvmSha256);
 assert.deepEqual(h.state.judges[0].expectedStatement,BOOT_STATEMENTS['linux-direct']);
 finish();await judged(m);assert.equal(m.get(a.id).status,'running');await m.remove(a.id);
 assert.equal(m.gpuAllocated(),0);assert.equal(m.physicalRamAllocated(),0);
});
test('native configuration requires its own runtime, launcher, identity and full admission prerequisites',async()=>{
 const h=await setup();
 for(const patch of [{ramPoolMiB:null},{physicalRamPoolMiB:null},{secretsEnabled:false},{protectedPorts:false},{egress:null},{judgeReady:null},{desktopWorker:null},
  {backend:{...h.backend,canSurvey:false}},{backend:{...h.backend,desktopPlatform:null}},
  {images:{desktop:h.options.images.desktop}},
  {images:{...h.options.images,legacy:{igvmSha256:h.platform.igvmSha256}}},
  {images:{...h.options.images,desktop:{...h.options.images.desktop,runtime:{...runtime,version:'wrong'}}}}])
  assert.throws(()=>new Manager({...h.options,...patch}));
});
test('worker and role preflight govern only desktop availability and are checked again after fetch',async()=>{
 const h=await setup();h.worker.ready=false;
 assert.ok(!h.manager.health().catalog.derivations.includes(DESKTOP_DERIVATION));
 await assert.rejects(h.manager.spawn(h.body),/unavailable/);assert.equal(h.state.starts.length,0);
 h.worker.ready=true;h.manager._preflight.roles.desktop.ok=false;
 assert.equal(h.manager.health().canStart,true);await assert.rejects(h.manager.spawn(h.body),/unavailable/);
 h.manager._preflight.roles.desktop.ok=true;
 h.manager.fetchComponent=async()=>{h.worker.ready=false;return component;};
 await assert.rejects(h.manager.spawn(h.body),/unavailable/);assert.equal(h.manager.list().length,0);
});
test('malformed native requests are refused before reservations and backend start',async()=>{
 const h=await setup();
 for(const patch of [{hasSecrets:false},{name:'0x'+H('3')},{bootstrap:null},{custody:false},{gpuShare:.6},{gpuShare:'0.5'},
  {config:''},{firewall:[]},{isPublic:false},{secrets:{}},{env:{}},{volumes:['x']},{egress:'x'},{waf:{x:true}}])
  await assert.rejects(h.manager.spawn({...h.body,...patch}));
 assert.equal(h.state.starts.length,0);assert.equal(h.manager.list().length,0);
 for(const key of ['runtimeId','configBase64']){
  const record=structuredClone(h.record);record[key]=key==='runtimeId'?H('a'):Buffer.from('{}').toString('base64');
  await assert.rejects(h.manager.spawn({...h.body,derive:record}));
 }
 assert.equal(h.manager.list().length,0);
});
test('native GPU and physical reservations cannot be oversold by concurrent fetch completions',async()=>{
 for(const [milli,pool] of [[600,65536],[500,20000]]){
  let release;const gate=new Promise(r=>release=r);const h=await setup({physicalRamPoolMiB:pool,fetchComponent:async()=>{await gate;return component;}});
  h.record.desktop.gpuMilli=milli;h.body.gpuShare=milli/1000;
  const other=structuredClone(h.body);other.name=other.derive.secretDeployment='0x'+H('3');
  const pending=[h.manager.spawn(h.body),h.manager.spawn(other)];release();
  const results=await Promise.allSettled(pending);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected').length,1);
  assert.equal(h.state.starts.length,1);assert.equal(h.manager.gpuAllocated(),milli);assert.equal(h.manager.physicalRamAllocated(),12288);
 }
});
test('native request mutation cannot change the pending measured deployment',async()=>{
 let release;const gate=new Promise(r=>release=r);const h=await setup({fetchComponent:async()=>{await gate;return component;}});
 const expected=h.body.name;const pending=h.manager.spawn(h.body);
 h.body.name='0x'+H('9');h.record.policy.memMiB=65536;h.record.desktop.gpuMilli=1000;release();
 const a=await pending;assert.equal(a.name,expected);assert.equal(a.gpuMilli,500);assert.equal(a.physicalMemoryMiB,12288);
});
test('mismatched native launch statements fail and keep reservations for cleanup',async()=>{
 for(const patch of [{imageRole:'legacy'},{firmware:{sha256:H('a')}},{image:H('a')},{guestIdentity:null},{appId:H('a')},
  {desktop:{profileSha256:H('a')}},{transport:null},{egress:null},{memory:{appMiB:8192,vmMiB:8192}}]){
  const h=await setup();h.state.patch=patch;const a=await h.manager.spawn(h.body);
  assert.equal(a.status,'failed');assert.equal(h.manager.gpuAllocated(),500);assert.equal(h.manager.physicalRamAllocated(),12288);
  assert.equal(h.state.judges.length,0);await h.manager.remove(a.id);assert.equal(h.manager.gpuAllocated(),0);
 }
});
test('worker revocation cannot release reservations or be resurrected by late readiness',async()=>{
 const h=await setup();let finish;h.state.judgeGate=new Promise(r=>finish=r);
 const a=await h.manager.spawn(h.body);h.state.workerExit({code:1});await new Promise(r=>setImmediate(r));
 finish();await judged(h.manager);assert.equal(h.manager.get(a.id).status,'failed');
 h.state.stopFails=true;await assert.rejects(h.manager.remove(a.id),/worker close uncertain/);
 assert.equal(h.manager.gpuAllocated(),500);assert.equal(h.manager.physicalRamAllocated(),12288);
 h.state.stopFails=false;await h.manager.remove(a.id);assert.equal(h.manager.gpuAllocated(),0);
});
test('native allocations beyond measured profile bounds are refused before launch',async()=>{
 const h=await setup({ramPoolMiB:300000,physicalRamPoolMiB:400000});
 await assert.rejects(h.manager.spawn(h.body),/8192..65536/);assert.equal(h.manager.list().length,0);
});
test('the node client carries native measured configuration without adding legacy config fields',async()=>{
 const h=await setup();
 const input={...h.body,image:'ipfs://'+h.record.cid};
 const body=IsolationManagerClient.spawnBody(input);
 assert.equal(Object.hasOwn(body,'config'),false);assert.equal(Object.hasOwn(body,'configCid'),false);
 const started=await h.manager.spawn(body);await judged(h.manager);
 assert.equal(h.manager.get(started.id).status,'running');
 assert.throws(()=>IsolationManagerClient.spawnBody({...input,config:'{}'}),/measured record/);
 await assert.rejects(h.manager.spawn({...input,ports:['tcp:1234']}),/measured record/);
});

test('native purchased CPU is passed independently of the measured catalog default',async()=>{
 const h=await setup();h.body.cpuShare=.375;
 const a=await h.manager.spawn(h.body);await judged(h.manager);
 assert.equal(h.manager.get(a.id).status,'running');
 const {mapping,opts}=h.state.starts[0];
 assert.equal(mapping.record.policy.cpuPercent,400);assert.equal(mapping.record.policy.vcpus,4);
 assert.equal(opts.appCpu.appCpuPercent,600);assert.equal(opts.appCpu.vcpus,6);
 assert.equal(a.cpu.grantedUnits,600000);assert.equal(h.manager.cpuAllocated(),600000);
 await h.manager.remove(a.id);assert.equal(h.manager.cpuAllocated(),0);
});
test('native undersized CPU purchase is rejected even when its RAM fits',async()=>{
 const h=await setup({ramPoolMiB:65536,physicalRamPoolMiB:131072});h.body.cpuShare=.249;
 await assert.rejects(h.manager.spawn(h.body),/purchased native CPU allocation/);
 assert.equal(h.state.starts.length,0);assert.equal(h.manager.list().length,0);
 assert.equal(h.manager.cpuAllocated(),0);assert.equal(h.manager.gpuAllocated(),0);
});
test('native guest CPU mismatch fails readiness and retains all resources until confirmed cleanup',async()=>{
 for(const cpu of [null,{}, {appCpuPercent:400},{appCpuPercent:601}]){
  const h=await setup();h.body.cpuShare=.375;h.state.patch={cpu};
  const a=await h.manager.spawn(h.body);assert.equal(a.status,'failed');assert.equal(h.state.judges.length,0);
  assert.equal(h.manager.cpuAllocated(),600000);assert.equal(h.manager.gpuAllocated(),500);
  h.state.stopFails=true;await assert.rejects(h.manager.remove(a.id),/worker close uncertain/);
  assert.equal(h.manager.cpuAllocated(),600000);h.state.stopFails=false;
  await h.manager.remove(a.id);assert.equal(h.manager.cpuAllocated(),0);
 }
});
test('concurrent native purchases cannot oversell the paired CPU and RAM pools',async()=>{
 const h=await setup({physicalRamPoolMiB:131072});h.body.cpuShare=.625;
 const other=structuredClone(h.body);other.name=other.derive.secretDeployment='0x'+H('3');
 const r=await Promise.allSettled([h.manager.spawn(h.body),h.manager.spawn(other)]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(r.filter(x=>x.status==='rejected').length,1);
 assert.match(r.find(x=>x.status==='rejected').reason.message,/RAM pool|CPU|cpu/);
 assert.equal(h.state.starts.length,1);assert.equal(h.manager.cpuAllocated(),1000000);
});
test('native launch exception preserves its cleanup handle and role',async()=>{
 const h=await setup(),handle={imageRole:'desktop',vmId:'00000000-0000-4000-8000-000000000001'};
 h.backend.start=async()=>{const e=Error('launch failed');Object.defineProperty(e,'launchHandle',{value:handle});throw e;};
 const a=await h.manager.spawn(h.body);assert.equal(a.status,'failed');assert.equal(h.manager.cpuAllocated(),400000);
 await h.manager.remove(a.id);assert.equal(h.state.stops[0],handle);assert.equal(h.manager.cpuAllocated(),0);
});
test('native recovery and failed-launch inventory preserve the desktop cleanup role',async()=>{
 const {notesFor}=await import('./wmi-launcher.mjs');
 for(const recovered of [true,false]){
  const h=await setup();let id;
  if(recovered)id='hvrecovered';
  else{h.backend.start=async()=>{throw Error('failed before handle');};id=(await h.manager.spawn(h.body)).id;}
  const notes=notesFor({id,name:h.body.name,instanceId:'native-recovery',appId:H('d'),imageRole:'desktop'});
  h.backend.survey=async()=>({vms:[{name:'enclave-app-native-recovery',vmId:'00000000-0000-4000-8000-000000000001',state:'Off',notes}]});
  if(recovered)await h.manager.recover();
  await h.manager.remove(id);assert.equal(h.state.stops[0].imageRole,'desktop');
 }
});
