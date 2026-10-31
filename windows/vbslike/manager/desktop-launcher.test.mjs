// Lifecycle orchestration against injected host/transport answers. Actual media
// attachment is separately qualified on NucBox; these tests do not claim that.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WmiHyperVLauncher, parseNotes} from './wmi-launcher.mjs';
import {NATIVE_24G_MEMORY_PROFILE} from './desktop-memory.mjs';
import {TYPE1,PREFLIGHT_OK,VM_ID,defineAnswer,keyOf} from './fake-hyperv.mjs';
import {canonical,sha256Hex,COMPONENT_PREAMBLE} from './derive.mjs';
import {deriveDesktop,DESKTOP_DERIVATION,DESKTOP_PORTS} from './desktop-derive.mjs';
import {EGRESS_SERVICE_GUID} from './egress.mjs';
const HASH=c=>c.repeat(64);
const component=Buffer.concat([COMPONENT_PREAMBLE,Buffer.from([0,1,0])]);
function fixture(){
 const profile={controllerSha256:sha256Hex(component),kernel:{bootSha256:HASH('a'),elfSha256:HASH('b'),release:'6.6.87.2-enclave-kvm-box'},
  models:{dataBlocks:3,hashStartBlock:4,imageBytes:20480,imageSha256:HASH('d'),rootHash:HASH('e'),salt:HASH('f')},
  profile:'kvm-box-masked-v1',root:{dataBlocks:2,hashBytes:4096,hashSha256:HASH('c'),imageBytes:8192,imageSha256:HASH('b'),rootHash:HASH('d'),salt:HASH('e')},schema:'enclave-native-desktop-profile/1'};
 const profileText=canonical(profile).toString()+'\n';
 const platform={igvmSha256:HASH('f'),runtimeId:HASH('e'),profileText,profileSha256:sha256Hex(Buffer.from(profileText)),media:
  [['root',8192,HASH('b')],['hashes',4096,HASH('c')],['models',20480,HASH('d')]].map(([role,payloadBytes,payloadSha256],i)=>({role,path:`C:\\media\\${role}.iso`,bytes:payloadBytes+65536,sha256:HASH(String(i+1)),payloadBytes,payloadSha256,payloadOffset:65536}))};
 const record={derivation:DESKTOP_DERIVATION,catalog:{app:'0x'+HASH('1'),version:1},cid:'Qm'+'a'.repeat(44),runtimeId:platform.runtimeId,
  policy:{cpuPercent:800,memMiB:8192,vcpus:8},http:8000,ports:[...DESKTOP_PORTS],configBase64:Buffer.from('{"egress":"public-web"}').toString('base64'),secretDeployment:'0x'+HASH('2'),
  desktop:{profile:'kvm-box-masked-v1',profileSha256:platform.profileSha256,gpuMilli:500}};
 const mapping=deriveDesktop({record,component});
 const opts={instanceId:'desktop-0001',identity:{id:'hv'+'a'.repeat(32),instanceId:'desktop-0001',name:record.secretDeployment,appId:mapping.appId}};
 return {platform,mapping,opts};
}
function setup(t,over={}){
 const f=fixture(),events=[],scripts=[];let definition,workerMapping,servedArgs;
 const bundleDir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-launcher-'));
 t.after(()=>fs.rmSync(bundleDir,{recursive:true,force:true}));
 let workerExit,egressExit;
 const worker={exited:new Promise(r=>workerExit=r),stop:async()=>{events.push('worker-stop');}};
 const egress={exited:new Promise(r=>egressExit=r),stop:async()=>{events.push('egress-stop');}};
 const run=async s=>{
  scripts.push(s);
  const key=s.startsWith('@{registered=')?'workerService':s.includes('$cpuWant =')?'processor':s.includes('desktop-media before')||s.includes("$phase = 'before-mutation'")?'media':keyOf(s);
  events.push(key);
  if(over.pause && key==='preflight')await over.pause;
  if(over.fail===key)return {code:1,stdout:'',stderr:'injected '+key+' failure'};
  let value;
  if(key==='preflight')value={...PREFLIGHT_OK,egressService:true};
  else if(key==='workerService')value={registered:over.registered??true};
  else if(key==='imageHash')value={present:true,sha256:f.platform.igvmSha256,bytes:123};
  else if(key==='define'){definition=defineAnswer(s,{hypervUtilitiesSha256:HASH('3'),...(over.definition??{})});value=definition;}
  else if(key==='processor'){const m=/\$cpuWant = @\{q=(\d+); l=(\d+); r=(\d+)\}/.exec(s);assert.ok(m);value={vcpus:+m[1],count:+m[1],limit:+m[2],reservation:+m[3],units:'percent / 1000',...(over.cpuBack??{})};}
  else if(key==='media')value={vmId:VM_ID,name:definition.name,notes:definition.notes,state:'Off',controllers:1,hardDisks:0,nics:0,bootEntries:0,
   media:f.platform.media.map((m,i)=>({role:m.role,path:m.path,sha256:m.sha256,bytes:m.bytes,controller:0,location:i,controllerType:'SCSI'})),...(over.media??{})};
  else if(key==='startAndRead')value={state:'Running',console:{connected:true,bytes:200,sawUntil:over.ready??true,head:'MON ready'}};
  else if(key==='removeById')value={found:true,removed:true};
  else if(key==='retire')value={present:true,retired:true};
  else throw Error('unexpected host command '+key);
  return {code:0,stdout:JSON.stringify(value),stderr:''};
 };
 const config={...TYPE1,run,imagePath:'C:\\native\\igvm.bin',imageSha256:f.platform.igvmSha256,imageRole:'desktop',desktopPlatform:f.platform,guestCpuAllowance:true,
  guestStateMasterSha256:HASH('4'),hypervUtilitiesSha256:HASH('3'),egressService:EGRESS_SERVICE_GUID,
  startTransport:async(id,m)=>{events.push('worker');assert.equal(id,VM_ID);workerMapping=m;return over.worker===undefined?worker:over.worker;},
  startEgress:async()=>{events.push('egress');return over.egress===undefined?egress:over.egress;},
  serve:{exe:'host.exe',bundleDir,portFor:async()=>12345,run:async args=>{events.push('serve');servedArgs=args;
   if(over.exitDuringServe)workerExit({code:1});
   return {vm:VM_ID,domainId:1,tcpPort:12345,guestPort:40001,launcherKey:'test',cpuPercent:over.reportedCpu===undefined?args.appCpuPercent:over.reportedCpu,stop:over.relayStop??(async()=>{events.push('relay-stop');return{closed:true};})};}}};
 const launcher=new WmiHyperVLauncher(config);
 return {...f,config,launcher,events,scripts,workerExit,egressExit,get definition(){return definition;},get workerMapping(){return workerMapping;},get servedArgs(){return servedArgs;}};
}

test('desktop uses its pinned media, 12-GiB partition and live transports before loading the controller',async t=>{
 const h=setup(t);const r=await h.launcher.start(h.mapping,h.opts);
 assert.deepEqual(h.events,['preflight','workerService','imageHash','define','media','startAndRead','worker','egress','serve']);
 assert.equal(h.definition.memBytes,12288*1048576);assert.equal(h.definition.vcpus,8);
 assert.equal(r.image,h.platform.igvmSha256);assert.equal(r.imageRole,'desktop');
 assert.equal(r.memory.appMiB,8192);assert.equal(r.memory.vmMiB,12288);assert.equal(r.media.media.length,3);
 assert.deepEqual(r.desktop,{profileSha256:h.platform.profileSha256,runtimeId:h.platform.runtimeId,gpuMilli:500});
 assert.equal(parseNotes(h.definition.notes).identity.imageRole,'desktop');
 assert.notEqual(h.workerMapping,h.mapping);assert.ok(h.workerMapping.bundle.equals(h.mapping.bundle));
 assert.equal(h.servedArgs.appId,h.mapping.appId);
 await r.stop();assert.deepEqual(h.events.slice(-5),['worker-stop','egress-stop','relay-stop','removeById','retire']);
});

test('native allocations honor the actual app allowance rather than only the catalog floor',async t=>{
 const h=setup(t);const r=await h.launcher.start(h.mapping,{...h.opts,appMemoryMiB:16384});
 assert.equal(r.memory.vmMiB,24576);assert.equal(h.servedArgs.appMemoryMiB,16384);await r.stop();
});

test('incomplete or contradictory desktop configuration is rejected before host work',t=>{
 const h=setup(t);
 for(const patch of [{imageRole:'legacy'},{boot:'uefi-medium',medium:'C:\\x.iso',mediumSha256:HASH('1')},{imageSha256:HASH('a')},{desktopPlatform:null},
  {startTransport:null},{startEgress:null},{egressService:null},{serve:null},{guestStateMasterSha256:null},{hypervUtilitiesSha256:null}])
  assert.throws(()=>new WmiHyperVLauncher({...h.config,...patch}));
 assert.deepEqual(h.events,[]);
});

test('invalid identities and allocations are refused before preflight',async t=>{
 const h=setup(t);
 for(const patch of [{identity:null},{identity:{...h.opts.identity,name:'0x'+HASH('3')}},{identity:{...h.opts.identity,appId:HASH('4')}},
  {identity:{...h.opts.identity,instanceId:'other'}},{bootstrap:false},{custody:{}},{appMemoryMiB:4096},{appMemoryMiB:'8192'},{appMemoryMiB:65537}])
  await assert.rejects(h.launcher.start(h.mapping,{...h.opts,...patch}));
 const bad=structuredClone(h.mapping);bad.bundle=Buffer.from(h.mapping.bundle);bad.appId=HASH('a');
 await assert.rejects(h.launcher.start(bad,h.opts));
 assert.deepEqual(h.events,[]);
});

test('mapping, identity and platform caller mutation cannot change a pending native launch',async t=>{
 let release;const pause=new Promise(r=>release=r);const h=setup(t,{pause});
 const expectedId=h.mapping.appId,expectedOwner=h.opts.identity.name;
 const pending=h.launcher.start(h.mapping,h.opts);
 h.mapping.bundle.fill(0);h.mapping.record.policy.memMiB=65536;h.opts.identity.name='0x'+HASH('9');
 h.platform.profileText='{}';h.platform.media[0].path='C:\\evil.iso';release();
 // The fake media answer must model the immutable media the host was ASKED for.
 h.platform.media[0].path='C:\\media\\root.iso';
 const r=await pending;
 assert.equal(r.appId,expectedId);assert.equal(r.memory.appMiB,8192);
 assert.equal(parseNotes(h.definition.notes).identity.name,expectedOwner);await r.stop();
});

for(const [name,over] of [
 ['media readback',{media:{nics:1}}],['missing TPM',{definition:{tpmEnabled:false}}],['monitor not ready',{ready:false}],
 ['worker missing',{worker:null}],['worker malformed',{worker:{}}],['egress missing',{egress:null}],['egress malformed',{egress:{}}],
 ['worker already exited',{worker:{exited:Promise.resolve({code:1}),stop:async()=>{}}}],['transport exits during app delivery',{exitDuringServe:true}],
 ['media command fails',{fail:'media'}],
])test('native launch cleans up when '+name,async t=>{
 const h=setup(t,over);await assert.rejects(h.launcher.start(h.mapping,h.opts));
 assert.ok(h.events.includes('removeById'));assert.ok(h.events.includes('retire'));
 if(!over.exitDuringServe)assert.ok(!h.events.includes('serve'));
});

test('missing worker service registration refuses before defining a VM',async t=>{
 const h=setup(t,{registered:false});await assert.rejects(h.launcher.start(h.mapping,h.opts),/native desktop worker service/);
 assert.deepEqual(h.events,['preflight','workerService']);
});

test('failed launch retains its private worker handle until cleanup can be retried',async t=>{
 let stopFails=true,stops=0;
 const worker={exited:new Promise(()=>{}),stop(){stops++;if(stopFails)throw Error('worker still alive');}};
 const h=setup(t,{worker,egress:null});
 let failure;
 try{await h.launcher.start(h.mapping,h.opts);}catch(e){failure=e;}
 assert.match(failure.message,/egress transport/);
 assert.equal(failure.transportCleanup.closed,false);
 assert.equal(failure.launchHandle.transport,worker);
 assert.equal(failure.launchHandle.vmId,VM_ID);
 assert.ok(!Object.keys(failure).includes('launchHandle'));
 assert.ok(h.events.includes('removeById'));
 await assert.rejects(h.launcher.stop(failure.launchHandle),/worker transport cleanup failed/);
 assert.equal(h.events.filter(x=>x==='removeById').length,2);
 stopFails=false;
 assert.equal((await h.launcher.stop(failure.launchHandle)).stopped,true);
 assert.equal(stops,3);
});

test('a synchronous relay stop failure cannot skip failed-launch VM removal',async t=>{
 const h=setup(t,{exitDuringServe:true,relayStop(){throw Error('relay stop failed');}});
 await assert.rejects(h.launcher.start(h.mapping,h.opts),e=>{
  assert.match(e.message,/transport or app delivery failed/);
  assert.equal(e.relay.closed,false);assert.match(e.relay.how,/relay stop failed/);
  assert.equal(e.launchHandle.vmId,VM_ID);return true;
 });
 assert.ok(h.events.includes('removeById'));assert.ok(h.events.includes('retire'));
});


test('installed native policy defines exactly the reserved 32 GiB with the native ownership marker',async t=>{
 const h=setup(t);const launcher=new WmiHyperVLauncher({...h.config,prefix:'enclave-native-',desktopMemoryProfile:NATIVE_24G_MEMORY_PROFILE});
 const r=await launcher.start(h.mapping,{...h.opts,appMemoryMiB:24576});
 assert.equal(h.definition.memBytes,32768*1048576);assert.equal(r.memory.vmMiB,32768);
 assert.equal(r.memory.rule,NATIVE_24G_MEMORY_PROFILE);
 assert.ok(h.definition.name.startsWith('enclave-native-'));
 assert.equal(parseNotes(h.definition.notes,{marker:'enclave-native-vbslike-domain'}).identity.imageRole,'desktop');
 assert.equal(parseNotes(h.definition.notes).identity,null);
 await r.stop();
});


test('native purchased CPU is frozen, configured before start and confirmed by guest',async t=>{
 let release;const pause=new Promise(r=>release=r),h=setup(t,{pause});
 const appCpu={vcpus:8,limit:50000,reservation:50000,appCpuPercent:400};
 const pending=h.launcher.start(h.mapping,{...h.opts,appCpu});
 appCpu.appCpuPercent=800;appCpu.limit=100000;release();
 const r=await pending;
 assert.equal(h.servedArgs.appCpuPercent,400);assert.equal(r.cpu.appCpuPercent,400);
 assert.ok(h.events.indexOf('processor')<h.events.indexOf('startAndRead'));
 assert.equal(r.cpu.limit,50000);await r.stop();
});
for(const [name,over] of [['processor mismatch',{cpuBack:{limit:99999}}],['guest quota missing',{reportedCpu:null}],['guest quota mismatch',{reportedCpu:401}]])
 test('native '+name+' refuses and cleans up exact partition',async t=>{
 const h=setup(t,over);
 await assert.rejects(h.launcher.start(h.mapping,{...h.opts,appCpu:{vcpus:8,limit:50000,reservation:50000,appCpuPercent:400}}));
 assert.ok(h.events.includes('removeById'));
 if(over.cpuBack)assert.equal(h.events.includes('startAndRead'),false);
 });
