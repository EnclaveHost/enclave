import test from 'node:test';
import assert from 'node:assert/strict';
import {derive, DERIVATION_V7} from './derive.mjs';
import {isolationPlan} from '../datapath/node-bridge.mjs';
const id='0x'+'ab'.repeat(32), rt='cd'.repeat(32);
const base={derivation:DERIVATION_V7,catalog:{app:id,version:1},cid:'bafybeiftk3zeblrku6wr5cxd77szxcgg7icanbotl7ivu5lp6yadvlpi7i',runtimeId:rt,
 policy:{cpuPercent:100,memMiB:6144,vcpus:1},http:8000,ports:['tcp:2222','udp:47998'],config:'{"autostart":false}',secretDeployment:id};
const component=Buffer.from('0061736d0d000100','hex');
test('V7 binds every protected port and the secret deployment; V6 stays unchanged',()=>{
 const a=derive({record:base,component});
 assert.notEqual(a.appId,derive({record:{...base,ports:['tcp:2223','udp:47998']},component}).appId);
 assert.notEqual(a.appId,derive({record:{...base,secretDeployment:'0x'+'ef'.repeat(32)},component}).appId);
 for(const bad of [{ports:[]},{ports:['tcp:8000']},{ports:['udp:47998','tcp:2222']},{secretDeployment:''},{derivation:'enclave-catalog-bundle/6'}])
  assert.throws(()=>derive({record:{...base,...bad},component}));
});
test('RISC port plan requires explicitly enabled V7 and preserves all destinations',()=>{
 const input={deploymentId:id,deployment:{cpuMilli:250,gpuMilli:0,isPublic:true},version:{appId:id,index:1,cid:base.cid,memMb:6144,ports:'http:8000,udp:47998,tcp:2222'},appConfig:{autostart:false},hasSecrets:true,waf:{},volumes:[],runtimeId:rt,require:'hyperv-partition-per-app',appConfigCid:'',manager:{backend:'hyperv-partition-per-app',catalog:{derivations:[DERIVATION_V7]},supports:{config:true,secrets:true,ports:true},runtime:{configSocketServer:true}}};
 const plan=isolationPlan(input);assert.equal(plan.ok,true,JSON.stringify(plan));assert.deepEqual(plan.spawn.derive.ports,base.ports);assert.equal(plan.spawn.derive.secretDeployment,id);
 assert.equal(isolationPlan({...input,manager:{...input.manager,supports:{...input.manager.supports,ports:false}}}).ok,false);
 assert.equal(isolationPlan({...input,hasSecrets:false}).ok,false);
});
