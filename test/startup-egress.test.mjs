import test from 'node:test';import assert from 'node:assert/strict';import {startupEgressReady} from '../windows/node/startup-egress.mjs';
const id='0x'+'12'.repeat(32),cfg={version:2,apps:[{deploymentId:id,startupEgress:true}]},route={version:1,expiresAt:1500,apps:{[id]:{proxies:['127.0.0.1:1234']}}};
const options=(r=route,c=cfg)=>({configFile:'config',routeFile:'routes',now:1000,read:f=>f==='config'?c:r});
test('startup secrets wait for only their own live private route',()=>{
 assert.equal(startupEgressReady(id,options()),true);
 for(const bad of [{...route,expiresAt:1000},{...route,expiresAt:121001},{...route,apps:{}},{...route,apps:{[id]:{proxies:['8.8.8.8:443']}}},{...route,apps:{[id]:{proxies:[]}}}])assert.equal(startupEgressReady(id,options(bad)),false);
 assert.equal(startupEgressReady('0x'+'13'.repeat(32),options()),true);
 assert.throws(()=>startupEgressReady(id,{configFile:'config'}),/config and routes/);
 assert.throws(()=>startupEgressReady(id,options(route,{})),/invalid/);
 assert.equal(startupEgressReady(id),true);
});
