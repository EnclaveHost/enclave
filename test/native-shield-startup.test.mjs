import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { shieldExpectation } from '../network/shield-expectation.mjs';
import { startingShieldTransport } from '../network/shield-starting-transport.mjs';
import { createNetworkEnroll } from '../windows/node/network-enroll.mjs';
import { nativeEnrollmentInputs } from '../windows/node/desktop-inputs.mjs';
import { startupEgressReady } from '../windows/node/startup-egress.mjs';
import { createShieldSecrets } from '../windows/node/shield-secrets.mjs';

const v=JSON.parse(fs.readFileSync(new URL('./fixtures/native-startup.json',import.meta.url)));
const record=v.record,component=Buffer.from(v.component_hex,'hex');
const release={schema:'enclave-desktop-release/1',controllerCid:record.cid,controllerSha256:v.mapping.componentSha256,
 runtimeId:record.runtimeId,igvmSha256:'55'.repeat(32),profileSha256:record.desktop.profileSha256,launchMeasurement:'66'.repeat(32),
 minimumCpuMilli:250,policy:{cpuPercent:record.policy.cpuPercent,vcpus:record.policy.vcpus}};
const image={measurement:release.launchMeasurement,runtimeId:release.runtimeId,igvmSha256:release.igvmSha256,
 profileSha256:release.profileSha256,controllerSha256:release.controllerSha256,nativeDesktop:true,
 configBundleV5:true,secretsV1:true,configSocketServer:true,protectedPorts:true};
const policy={desktop:release,images:[image]},id=record.secretDeployment,runner='0x'+'22'.repeat(32);
const row={id,appRef:`catalog://${record.catalog.app}/${record.catalog.version}`,configCid:'{}',isPublic:true,
 cpuMilli:500,gpuMilli:record.desktop.gpuMilli,runner,active:true,leaseUntil:9999999999};
const version={cid:record.cid,memMb:record.policy.memMiB,ports:['http:8000',...record.ports].join(','),yanked:false};
const inputs={component,config:Buffer.from(record.configBase64,'base64').toString('utf8')};
const vm=()=>({id:'native-test',name:id,secretDeployment:id,status:'starting',appReady:false,launching:false,
 derivation:record.derivation,catalog:record.catalog,cid:record.cid,appId:v.mapping.appId,recordSha256:v.mapping.recordSha256,
 componentSha256:v.mapping.componentSha256,runtimeId:release.runtimeId,imageRole:'desktop',image:release.igvmSha256,
 igvmSha256:release.igvmSha256,desktop:record.desktop,gpuMilli:record.desktop.gpuMilli,relay:{host:'127.0.0.1',port:31415}});
const expect=(over={})=>shieldExpectation({row,version,vms:[vm()],policy,desktopInputs:inputs,...over});
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-shield-startup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}

test('starting native app independently derives the golden-vector identity and explicit role',()=>{
 const got=expect();assert.equal(got.expected?.appSha256,v.mapping.appId,JSON.stringify(got));assert.equal(got.startupEgress,true);
 assert.equal(got.expected.requiresDesktop,true);assert.equal(got.expected.requiresSecretsV1,true);
 assert.equal(got.expected.desktop.recordSha256,v.mapping.recordSha256);
 const ready=expect({vms:[{...vm(),status:'running',appReady:true}]});assert.deepEqual(ready,got);
});
test('native expectation refuses changed pins, bytes, resources and manager identity',()=>{
 for(const key of ['appId','recordSha256','componentSha256','runtimeId','imageRole','image','igvmSha256','secretDeployment','cid','derivation']){
  const changed=vm();changed[key]='wrong';assert.ok(expect({vms:[changed]}).skip,key);
 }
 for(const key of ['profile','profileSha256','gpuMilli'])assert.ok(expect({vms:[{...vm(),desktop:{...record.desktop,[key]:'wrong'}}]}).skip,key);
 for(const changed of [{...inputs,component:Buffer.from('not-wasm')},{...inputs,config:'{"egress":"public-web","changed":true}'}])
  assert.ok(expect({desktopInputs:changed}).skip);
 assert.ok(expect({row:{...row,gpuMilli:500}}).skip);assert.ok(expect({version:{...version,memMb:record.policy.memMiB+1024}}).skip);
 for(const key of ['nativeDesktop','configBundleV5','secretsV1','configSocketServer','protectedPorts'])
  assert.ok(expect({policy:{desktop:release,images:[{...image,[key]:false}]}}).skip,key);
 assert.ok(expect({policy:{gpu:{runtimeId:release.runtimeId}}}).skip,'never falls back to GPU inference policy');
});
test('ambiguous, recovered, launching or unavailable native partitions are held',()=>{
 for(const vms of [[],[vm(),vm()],[{...vm(),recovered:true}],[{...vm(),launching:true}],[{...vm(),status:'failed'}],
  [{...vm(),status:'running',appReady:false}],[{...vm(),directBootstrap:true}]])assert.ok(expect({vms}).wait);
 assert.ok(expect({desktopInputs:undefined}).wait);
});
test('startup transport checks full native identity before opening a socket',async()=>{
 const wanted=expect().expected;let dials=0;
 const attempt=async(list,want=wanted)=>{
  const open=startingShieldTransport('http://127.0.0.1:8091',()=>want,{fetchImpl:async()=>new Response(JSON.stringify({vms:list})),
   connect:()=>{dials++;const s=new EventEmitter();s.destroy=()=>{};queueMicrotask(()=>s.emit('connect'));return s;}});return open(id);
 };
 await attempt([vm()]);assert.equal(dials,1);
 for(const key of ['recordSha256','componentSha256','imageRole','image','igvmSha256'])await assert.rejects(attempt([{...vm(),[key]:'wrong'}]),/native startup/);
 await assert.rejects(attempt([vm()],{...wanted,requiresDesktop:undefined}),/explicit desktop/);
 for(const key of ['recordSha256','controllerSha256','igvmSha256','profileSha256','profile','gpuMilli']){
  const malformed=structuredClone(wanted);delete malformed.desktop[key];
  await assert.rejects(attempt([vm()],malformed),/native startup/,key);
 }
 await assert.rejects(attempt([vm(),vm()]),/identity or loopback/);assert.equal(dials,1);
});
test('enrollment writes a starting native app with a required startup route and exact expectation',async t=>{
 const dir=temp(t),agentDir=path.join(dir,'agent'),policyFile=path.join(dir,'policy.json');fs.mkdirSync(agentDir);fs.writeFileSync(policyFile,JSON.stringify(policy));
 let calls=0;const current=vm();
 const config={agentDir,binDir:path.join(dir,'bin'),nodeBinary:'node',operatorKeyFile:'unused-test.key',runner,
  endpoint:'https://host.example.test',relayBase:'https://relay.example.test',policyFile,tpmBinary:'test',tpmSha256:'aa'.repeat(32),
  addressBook:'0x'+'44'.repeat(20),chainRpc:['https://rpc.example.test'],enclaveNetwork:{checkers:['0x'+'57'.repeat(20)]}};
 const enroll=createNetworkEnroll({agentDir,binDir:config.binDir,runner,relayBase:config.relayBase,config,
  rows:async()=>[row],version:async()=>version,vms:async()=>[current],desktopInputs:async()=>{calls++;return inputs;},
  fetch:async()=>({ok:true,json:async()=>({domains:{}})})});
 const result=await enroll.pass();assert.equal(result.apps,1);assert.equal(calls,1);
 const cfg=JSON.parse(fs.readFileSync(path.join(agentDir,'privacy-config.json')));assert.equal(cfg.apps[0].startupEgress,true);
 const expected=JSON.parse(fs.readFileSync(cfg.apps[0].expectedFile));assert.deepEqual(expected,expect().expected);
 current.status='running';current.appReady=true;assert.equal((await enroll.pass()).changed,false);
});
test('public enrollment inputs rehash a cached controller and refuse an invalid plan',async t=>{
 const dir=temp(t),file=path.join(dir,'controller.wasm');fs.writeFileSync(file,component);let planned=0;
 const host={cfg:{dir},desktopRelease:release,envelopeOf:()=>({isolationRequire:'hyperv-partition-per-app'}),
  isolationVerdict:async(_id,_row,_version,options)=>{planned++;assert.equal(options.envRead,true);return {ok:true,derivation:record.derivation,spawn:{derive:record}};}};
 const fetchComponent=async opts=>{assert.equal(opts.cid,release.controllerCid);return {path:file,cached:true};};
 const got=await nativeEnrollmentInputs(host,row,version,{fetchComponent});assert.deepEqual(got,inputs);assert.equal(planned,1);
 const bad=Buffer.from(component);bad[bad.length-1]^=1;fs.writeFileSync(file,bad);
 await assert.rejects(nativeEnrollmentInputs(host,row,version,{fetchComponent}),/approved release hash/);
 host.isolationVerdict=async()=>({ok:false,input:'hasSecrets',why:'unknown'});
 await assert.rejects(nativeEnrollmentInputs(host,row,version,{fetchComponent}),/plan refused/);
});
test('native secret courier waits for explicit configuration and a fresh route',async t=>{
 const dir=temp(t),configFile=path.join(dir,'config.json'),routeFile=path.join(dir,'routes.json'),now=Date.now();
 const ready=()=>startupEgressReady(id,{configFile,routeFile,required:true,now});
 assert.equal(startupEgressReady(id,{required:true}),false);assert.equal(ready(),false);
 fs.writeFileSync(configFile,JSON.stringify({version:2,apps:[]}));assert.equal(ready(),false);
 fs.writeFileSync(configFile,JSON.stringify({version:2,apps:[{deploymentId:id,startupEgress:true}]}));
 fs.writeFileSync(routeFile,JSON.stringify({version:1,expiresAt:now+60000,apps:{}}));assert.equal(ready(),false);
 let requests=0,seenRequired;
 const courier=()=>createShieldSecrets({base:'http://manager.test',endpoint:'https://host.test',relayBase:'https://relay.test',sign:async()=> 'synthetic',
  egressReady:(got,required)=>{assert.equal(got,id);seenRequired=required;return ready();},fetchImpl:async(url)=>{
   if(url==='http://manager.test/vms')return {ok:true,json:async()=>({vms:[vm()]})};requests++;return {ok:true,json:async()=>({ok:true,count:1})};}});
 await courier().pass();assert.equal(seenRequired,true);assert.equal(requests,0);
 fs.writeFileSync(routeFile,JSON.stringify({version:1,expiresAt:now+60000,apps:{[id]:{proxies:['127.0.0.1:9050']}}}));
 await courier().pass();assert.equal(requests,1);
 fs.writeFileSync(routeFile,JSON.stringify({version:1,expiresAt:now-1,apps:{[id]:{proxies:['127.0.0.1:9050']}}}));
 await courier().pass();assert.equal(requests,1);
});
