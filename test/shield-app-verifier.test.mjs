import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { expectedShieldApp, createShieldAppVerifier } from '../relay/shield-app-verifier.mjs';
import { derive } from '../windows/vbslike/manager/derive.mjs';
const vectors = JSON.parse(fs.readFileSync(new URL('../isolation/contract/catalog/derive_vectors.json', import.meta.url)));
const component = Buffer.from(vectors.component_hex, 'hex'), base = vectors.ok[0].mapping.record;
const policy = {cpu:{runtimeId:'ab'.repeat(32)},gpu:{runtimeId:'cd'.repeat(32),model:'qwen2.5-0.5b-q8-gguf'}};
const row = {id:'0x'+'11'.repeat(32),appRef:`catalog://${base.catalog.app}/0`,cpuMilli:10,gpuMilli:0,isPublic:true,
  configCid:JSON.stringify({isolation:{require:'hyperv-partition-per-app'}})};
const version = {cid:base.cid,memMb:128,ports:'',approval:1,yanked:false};
const deps = {policy,readCatalog:async()=>({app:{active:true},version}),readConfig:async()=>({config:'',configCid:''}),
  fetchVerified:async()=>({ok:true,bytes:component})};
test('relay derives CPU and GPU app identities from catalog bytes and purchased GPU share',async()=>{
 const cpu=await expectedShieldApp(row,deps);
 assert.equal(cpu.appSha256,derive({record:{...base,catalog:{app:base.catalog.app,version:0},runtimeId:policy.cpu.runtimeId,
   policy:{cpuPercent:100,memMiB:128,vcpus:1}},component}).appId);
 const d={...deps,readCatalog:async()=>({app:{active:true},version:{...version,memMb:8192}}),
   readConfig:async()=>({config:JSON.stringify({volumes:[policy.gpu.model]}),configCid:''})};
 const a=await expectedShieldApp({...row,gpuMilli:500,cpuMilli:250},d);
 const b=await expectedShieldApp({...row,gpuMilli:600,cpuMilli:250},d);
 assert.notEqual(a.appSha256,b.appSha256);assert.equal(a.runtimeId,policy.gpu.runtimeId);
});
test('unsupported, unapproved and unverified inputs never acquire an expected identity',async()=>{
 for(const r of [{...row,isPublic:false},{...row,configCid:'{"isolation":{"cpuTee":true}}'}, {...row,configCid:'{"isolation":{"gpuTee":true}}'},{...row,appRef:'host:chosen'},
  {...row,gpuMilli:500},{...row,configCid:JSON.stringify({isolation:{require:'hyperv-partition-per-app'},waf:{enabled:true}})}])
  await assert.rejects(expectedShieldApp(r,deps));
 for(const d of [{...deps,fetchVerified:async()=>({ok:false})},
  {...deps,readCatalog:async()=>({app:{active:true},version:{...version,approval:0}})},
  {...deps,readConfig:async()=>({config:'{}',configCid:'unavailable'})},
  {...deps,readConfig:async()=>({config:'{"secret":"undelivered"}',configCid:''})}])
  await assert.rejects(expectedShieldApp(row,d));
});
test('fresh nonce, independent expectations and CSR key reach the current-session verifier',async()=>{
 const seen=[];
 const hub={fetchJson:async(origin,path)=>{seen.push(path);assert.equal(origin,'tunnel://nucbox-k11');return {doc:{appSha256:'untrusted'},handshakeSpki:Buffer.alloc(44).toString('base64')};},
  verifyShieldApp:(name,input)=>{assert.equal(name,'nucbox-k11');assert.notEqual(input.expectedAppSha256,'untrusted');
   assert.equal(input.expectedCsrSpkiSha256,'ee'.repeat(32));assert.ok(seen.at(-1).endsWith(input.nonce.toString('hex')));return {ok:true};}};
 const verify=createShieldAppVerifier({...deps,hub});
 assert.equal((await verify('nucbox-k11',row,{csrSpkiSha256:'ee'.repeat(32)})).ok,true);
 assert.equal((await verify('nucbox-k11',row,{csrSpkiSha256:'ee'.repeat(32)})).ok,true);
 assert.notEqual(seen[0],seen[1]);
 assert.equal((await verify('nucbox-k11',{...row,isPublic:false})).ok,false);
});

test('only the relay-authorized owner exception admits pending test versions; rejection remains final', async()=>{
 const pending={...deps,readCatalog:async()=>({app:{active:true},version:{...version,approval:0}})};
 await assert.rejects(expectedShieldApp(row,pending));
 assert.ok((await expectedShieldApp(row,{...pending,allowPendingOwner:true})).appSha256);
 await assert.rejects(expectedShieldApp(row,{...pending,allowPendingOwner:true,
  readCatalog:async()=>({app:{active:true},version:{...version,approval:2}})}));
});

test('no TEE requirement permits Shield without relaxing app identity verification', async()=>{
 const a=await expectedShieldApp(row,deps);
 for(const configCid of ['', '{"isolation":{"cpuTee":false,"gpuTee":false}}'])
  assert.deepEqual(await expectedShieldApp({...row,configCid},deps),a);
});
