import {test} from 'node:test';
import assert from 'node:assert/strict';
import {profile,inferenceRefusal,MODEL} from './shield-profile.mjs';
import {Manager} from './server.mjs';
import {isolationPlan,V4} from '../datapath/node-bridge.mjs';
const runtime={name:'wasmtime',version:'49.0.0',execution:'jit',targetIsa:'x86_64',hostIsa:'x86_64',cpuFeatures:'host-detected',wx:'enforced',cache:'none'};
const shield={...profile(runtime),ready:true};
const rec={derivation:V4,catalog:{app:'0x'+'3'.repeat(64),version:0},cid:'bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzytzvi455xfv23tyjnza',runtimeId:shield.runtimeId,policy:{vcpus:4,memMiB:8192,cpuPercent:400},inference:{model:MODEL,gpuMilli:1000}};
const body={derive:rec,name:'test',gpuShare:1,cpuShare:0.25,hasSecrets:false,isPublic:true};
test('profile refuses wrong runtime, share, model, memory, CPU and missing worker',()=>{
 assert.equal(inferenceRefusal(rec,body,shield),null);
 for (const [d,b,p] of [
  [{...rec,runtimeId:'0'.repeat(64)},body,shield],
  [rec,{...body,gpuShare:0.5},shield],
  [{...rec,inference:{...rec.inference,model:'unverified'}},body,shield],
  [{...rec,policy:{...rec.policy,memMiB:128}},body,shield],
  [rec,{...body,cpuShare:0.01},shield],
  [rec,body,{...shield,ready:false}],
 ]) assert.ok(inferenceRefusal(d,b,p));
});
test('reservation is atomic across async fetches; failed launch holds until removed',async()=>{
 let unblock;const gate=new Promise(r=>unblock=r);
 const m=new Manager({shield,fetchComponent:async()=>{await gate;return Buffer.from('0061736d0d000100','hex')},backend:{backend:'hyperv-partition-per-app',supports:{},start:async()=>{throw new Error('VM state unknown')},stop:async()=>{},canSurvey:false}});
 const a=m.spawn(body),b=m.spawn({...body,name:'second'});unblock();
 const results=await Promise.allSettled([a,b]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(results.filter(x=>x.status==='rejected').length,1);
 assert.equal(m.gpuAllocated(),1000);
 const id=m.list()[0].id; await m.remove(id);assert.equal(m.gpuAllocated(),0);
 m.domains.set('recovered',{id:'recovered',recovered:true}); assert.equal(m.health().inference.freeGpuMilli,0);
});
test('node creates V4 only for pinned model and complete profile',()=>{
 const a={deploymentId:'0x'+'5'.repeat(64),deployment:{isPublic:true,gpuMilli:1000,cpuMilli:250,appPort:8080},version:{appId:rec.catalog.app,index:0,cid:rec.cid,memMb:8192,ports:'',configCid:''},appConfig:JSON.stringify({volumes:[MODEL]}),hasSecrets:false,waf:{},volumes:[MODEL],runtimeId:'0'.repeat(64),require:'hyperv-partition-per-app',manager:{backend:'hyperv-partition-per-app',catalog:{derivations:[V4]},supports:{gpu:true},inference:shield},appConfigCid:''};
 const p=isolationPlan(a); assert.equal(p.ok,true,JSON.stringify(p));assert.equal(p.spawn.derive.runtimeId,shield.runtimeId);assert.deepEqual(p.spawn.derive.inference,rec.inference);assert.equal(p.spawn.gpuShare,1);
 for(const over of [{volumes:['unknown']},{hasSecrets:true},{appConfig:JSON.stringify({volumes:[MODEL],secret:'x'})},{manager:{...a.manager,inference:{...shield,ready:false}}},{deployment:{...a.deployment,cpuMilli:10}}]) assert.equal(isolationPlan({...a,...over}).ok,false);
});

test('a late readiness success cannot revive an exited Shield transport', async () => {
 let exitBridge, finishJudge;
 const exited=new Promise(r=>exitBridge=r), verdict=new Promise(r=>finishJudge=r);
 const m=new Manager({shield,fetchComponent:async()=>Buffer.from('0061736d0d000100','hex'),
  backend:{backend:'hyperv-partition-per-app',supports:{},canSurvey:false,
   start:async()=>({transport:{exited},tcpPort:1234,launcherVmId:'test-vm'}),stop:async()=>{}},
  judgeReady:async()=>verdict});
 const started=await m.spawn(body);
 exitBridge({code:1});await new Promise(r=>setImmediate(r));
 assert.equal(m.get(started.id).status,'failed');
 finishJudge({status:'running',transportKeySha256:'a'.repeat(64)});
 await m.judging.get(started.id);
 assert.equal(m.get(started.id).status,'failed');
 assert.equal(m.get(started.id).reason,'Shield transport exited');
 assert.equal(m.gpuAllocated(),1000);
});

test('profile budgets twelve GiB, with six GiB for each half-pool allocation',()=>{
 assert.equal(shield.cardBudgetBytes,12*2**30);
 assert.equal(shield.cardBudgetBytes*500/1000,6*2**30);
});
