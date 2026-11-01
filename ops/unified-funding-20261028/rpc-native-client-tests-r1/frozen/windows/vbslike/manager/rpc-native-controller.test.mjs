import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createNativeRPCController,invokeNativeProcess} from './rpc-native-controller.mjs';import {canonical,COMPONENT_PREAMBLE,sha256Hex} from './derive.mjs';
import {deriveRPC,RPC_CONFIG,RPC_PORTS} from './rpc-derive.mjs';import {Manager} from './server.mjs';
const H=x=>x.repeat(64),id={managerEpoch:'a'.repeat(32),id:'rpc'+'b'.repeat(32),name:'0x'+H('c'),instanceId:'rpc'+'b'.repeat(32)};
function record(){return {derivation:'enclave-catalog-bundle/9',catalog:{app:'0x'+H('e'),version:1},cid:'b'+'a'.repeat(58),runtimeId:H('b'),policy:{cpuPercent:400,memMiB:19456,vcpus:4},http:8000,ports:[...RPC_PORTS],configBase64:canonical(RPC_CONFIG).toString('base64'),secretDeployment:id.name,rpc:{profile:'ethereum-base-rpc-v1',profileSha256:H('d'),l1VolumeId:H('e'),baseVolumeId:H('f')}};}
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rpc-native-client-')),transport=path.join(root,'transport');fs.mkdirSync(transport);const executable=path.join(root,'controller.exe');fs.writeFileSync(executable,'inert test actor marker');
 const config={schema:'native-rpc-manager-controller/1',ledgerRoot:root,attemptsRoot:root+'/attempts',workersRoot:root+'/workers',runtimeId:H('b'),profileSha256:H('d'),admissionSha256:H('a'),firmwareSha256:H('a'),initialStateSha256:H('a'),workerSha256:H('a'),admissionPath:root+'/admission',firmwarePath:root+'/firmware',initialStatePath:root+'/vmgs',profilePath:root+'/profile',workerPath:root+'/worker'};
 const configPath=path.join(root,'config.json');fs.writeFileSync(configPath,JSON.stringify(config));const configSha256=sha256Hex(fs.readFileSync(configPath));
 const options={executable,executableSha256:sha256Hex(fs.readFileSync(executable)),configPath,configSha256};
 const state={calls:[],inventory:{state:'empty',reservationMayRelease:false},clock:0,fail:null,original:null,frame:null};
 const invoke=async(exe,args,input)=>{
  const command=args[0];state.calls.push(command);if(state.fail===command)throw Error('fixture lost '+command);
  let value;
  if(command==='inspect')value=state.inventory;
  if(command==='begin'){
   assert.ok(fs.existsSync(path.join(transport,'begin.intent.json')));
   value={schema:'native-rpc-manager-attempt/1',config:configSha256,attempt:'1'.repeat(32),boot:'2'.repeat(32),managerEpoch:args[3],instance:args[4],deployment:args[5],originMs:'1000',deadlineMs:'901000',physicalMemoryMiB:20480,appMemoryMiB:19456,cpuUnits:400000,reservationMayRelease:false};state.original=value;
   state.inventory={state:'held',original:value,originalSha256:sha256Hex(Buffer.from(JSON.stringify(value))),launch:null,dispatchPresent:false,resultPresent:false,reservationMayRelease:false};
  }
  if(command==='stage'){
   assert.ok(fs.existsSync(path.join(transport,'stage.intent.json')));const raw=Buffer.concat(input),n=raw.readUInt32LE();const header=JSON.parse(raw.subarray(4,4+n));const bundle=raw.subarray(4+n);assert.equal(bundle.length,header.bundleBytes);const launch=JSON.parse(header.launch);
   assert.equal(sha256Hex(bundle),launch.appId);assert.equal(sha256Hex(Buffer.from(header.record)),launch.recordSha256);state.frame=raw;
   value={original:args[3],launchSha256:sha256Hex(Buffer.from(header.launch)),recordSha256:launch.recordSha256,bundleSha256:launch.appId,bundleBytes:bundle.length,reservationMayRelease:false};
  }
  if(command==='define-staged'){assert.ok(fs.existsSync(path.join(transport,'define.intent.json')));value={state:'defined-native-owned-off',startAuthorized:false,providerOperationFenced:false,reservationMayRelease:false};}
  if(command==='hold')value={held:true,reservationMayRelease:false,providerOperationFenced:false};
  return {schema:'native-rpc-manager-controller-result/1',command,value,elapsedMs:2,rpcReady:false,providerOperationFenced:false,reservationMayRelease:false};
 };
 return {root,transport,state,options,open:()=>createNativeRPCController(options,{invoke,now:()=>state.clock})};
}
function launch(a){const m=deriveRPC({record:record(),component:Buffer.from(COMPONENT_PREAMBLE)});return [{...id,appId:m.appId,record:m.record,recordSha256:m.recordSha256,componentSha256:m.componentSha256,originalClock:a.originalClock,physicalClaim:{poolHash:H('3'),boot:'2'.repeat(32),actor:'app-native',id:sha256Hex(Buffer.from(JSON.stringify([id.managerEpoch,id.id,m.appId]))),bytes:21474836480},physicalMemoryMiB:20480,memory:{appMiB:19456},cpu:{vcpus:4,grantedUnits:400000,appCpuPercent:400}},m.bundle];}
test('native client stages derived bytes after durable intents and never asserts RPC readiness',async()=>{
 const f=fixture();try{const c=await f.open(),a=await c.begin(id);assert.deepEqual(a.originalClock,{originMs:'1000',deadlineMs:'901000'});const [l,b]=launch(a);const result=await a.start(l,b);assert.equal(result.rpcReady,false);assert.deepEqual(f.state.calls,['inspect','begin','stage','define-staged']);await assert.rejects(a.start(l,b),/consumed/);assert.equal(fs.readdirSync(f.transport).length,6);assert.ok(f.state.frame.length>b.length);}finally{fs.rmSync(f.root,{recursive:true});}
});
test('lost native begin and stage responses survive process reconstruction without retry',async()=>{
 for(const phase of ['begin','stage']){const f=fixture();try{const c=await f.open();f.state.fail=phase;if(phase==='begin')await assert.rejects(c.begin(id),/lost/);else{const a=await c.begin(id);await assert.rejects(a.start(...launch(a)),/lost/);}const before=f.state.calls.length;f.state.fail=null;const recovered=await f.open();assert.equal(recovered.recoverHeld().length,1);await assert.rejects(recovered.begin(id),/held/);assert.equal(f.state.calls.length,before+1);assert.equal(recovered.recoverHeld()[0].reservationMayRelease,false);}finally{fs.rmSync(f.root,{recursive:true});}}
});
test('controller files and original expiry refuse another phase',async()=>{
 const f=fixture();try{const c=await f.open(),a=await c.begin(id);f.state.clock=870000;await assert.rejects(a.start(...launch(a)),/time insufficient/);assert.deepEqual(f.state.calls,['inspect','begin']);fs.appendFileSync(f.options.configPath,' ');assert.throws(()=>c.assertInventory(),/pin changed/);}finally{fs.rmSync(f.root,{recursive:true});}
});
test('held native inventory closes manager capacity and blocks survey adoption or remove',async()=>{
 const f=fixture();try{const c=await f.open();await c.begin(id);const recovered=await f.open();const backend={canSurvey:true,survey:async()=>({vms:[]}),preflight:async()=>({ok:true,hostLogicalProcessors:16,checks:[]})};
 const m=new Manager({rpcController:recovered,backend,ramPoolMiB:77824,cpuPoolVcpus:16,physicalRamPoolMiB:20480,physicalReservations:{poolHash:H('3'),boot:'2'.repeat(32),acquire:async()=>{},consumeStart:async()=>{}}});await m.probe();await m.recover();assert.equal(m.get(id.id).originalManagerEpoch,id.managerEpoch);assert.equal(m.memoryView().known,false);assert.equal(m.physicalRamAllocated(),null);await assert.rejects(m.remove(id.id),/association missing/);await assert.rejects(m.recover(),/cannot overlap/);assert.equal(m.get(id.id).reservationMayRelease,false);
 }finally{fs.rmSync(f.root,{recursive:true});}
});
test('native local hold cannot release a reservation or reopen start',async()=>{const f=fixture();try{const c=await f.open(),a=await c.begin(id);await assert.rejects(a.stop(),/settlement/);await assert.rejects(a.start(...launch(a)),/consumed/);assert.equal(a.assertCurrent(),false);assert.equal(f.state.calls.at(-1),'hold');}finally{fs.rmSync(f.root,{recursive:true});}});
test('partial client intent is unknown rather than empty',async()=>{const f=fixture();try{fs.writeFileSync(path.join(f.transport,'begin.intent.json'),'{');await assert.rejects(f.open());assert.equal(f.state.calls.length,0);}finally{fs.rmSync(f.root,{recursive:true});}});
test('actual child transport carries binary stdin and refuses excess output or timeout',async()=>{
 const f=fixture();try{const actor=path.join(f.root,'actor.mjs');fs.writeFileSync(actor,"const b=[];for await(const x of process.stdin)b.push(x);process.stdout.write(JSON.stringify({hex:Buffer.concat(b).toString('hex')}));");assert.deepEqual(await invokeNativeProcess(process.execPath,[actor],[Buffer.from([0,255,1])]),{hex:'00ff01'});
 fs.writeFileSync(actor,"process.stdout.write('x'.repeat(131073));");await assert.rejects(invokeNativeProcess(process.execPath,[actor],[]),/bound/);
 fs.writeFileSync(actor,"setInterval(()=>{},1000);");await assert.rejects(invokeNativeProcess(process.execPath,[actor],[],{timeoutMs:150}),/deadline/);
 }finally{fs.rmSync(f.root,{recursive:true});}
});
