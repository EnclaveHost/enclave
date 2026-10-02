import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {startingShieldTransport} from '../network/shield-starting-transport.mjs';
const id='0x'+'42'.repeat(32),expected={appSha256:'ab'.repeat(32),runtimeId:'cd'.repeat(32),requiresConfigSocketServer:true,requiresSecretsV1:true};
const vm={name:id,secretDeployment:id,status:'starting',appId:expected.appSha256,runtimeId:expected.runtimeId,relay:{host:'127.0.0.1',port:31415}};
test('startup transport binds one configured command and loopback endpoint before TLS attestation',async()=>{
 let dial;
 const open=startingShieldTransport('http://127.0.0.1:8091',()=>expected,{fetchImpl:async()=>new Response(JSON.stringify({vms:[vm]})),connect:opts=>{dial=opts;const s=new EventEmitter();s.destroy=()=>{};queueMicrotask(()=>s.emit('connect'));return s;}});
 await open(id);assert.deepEqual(dial,{host:'127.0.0.1',port:31415});
 for(const bad of [{recovered:true},{launching:true},{status:'failed'},{name:'0x'+'43'.repeat(32)},{secretDeployment:'0x'+'43'.repeat(32)},{appId:'ff'.repeat(32)},{runtimeId:'ff'.repeat(32)},{relay:{host:'8.8.8.8',port:443}}]){
  const attempt=startingShieldTransport('http://127.0.0.1:8091',()=>expected,{fetchImpl:async()=>new Response(JSON.stringify({vms:[{...vm,...bad}]})),connect:()=>{throw Error('must not dial');}});
  await assert.rejects(attempt(id),/identity or loopback/);
 }
 assert.throws(()=>startingShieldTransport('http://example.com:8091',()=>expected),/loopback/);
 await assert.rejects(startingShieldTransport('http://127.0.0.1:8091',()=>({...expected,requiresSecretsV1:false}))(id),/expectation/);
});
