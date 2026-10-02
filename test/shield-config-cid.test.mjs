import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { derive, appConfigText, DERIVATION_V5, MAX_CONFIG_BYTES, BUNDLE_MAGIC } from '../windows/vbslike/manager/derive.mjs';
import { Manager } from '../windows/vbslike/manager/server.mjs';
import { isolationPlan } from '../windows/vbslike/datapath/node-bridge.mjs';
import { expectedShieldApp } from '../relay/shield-app-verifier.mjs';
const vectors = JSON.parse(fs.readFileSync(new URL('../isolation/contract/catalog/derive_vectors.json', import.meta.url)));
const component = Buffer.from(vectors.component_hex, 'hex'), base = vectors.ok[0].mapping.record;
const configBytes = Buffer.from(JSON.stringify({title:'CID canary',http:[{name:'ping',url:'https://example.com/'}],padding:'x'.repeat(8200)}));
const config = appConfigText(configBytes.toString());
const configCid = 'bafkrei'+'a'.repeat(52);
const record = {...base,derivation:DERIVATION_V5,config,configCid};
const dep = '0x'+'11'.repeat(32);
const version = {appId:base.catalog.app,index:base.catalog.version,cid:base.cid,memMb:base.policy.memMiB,ports:'',approval:1,yanked:false,config:'{}',configCid};
const row = {id:dep,appRef:`catalog://${base.catalog.app}/${base.catalog.version}`,cpuMilli:250,gpuMilli:0,isPublic:true,configCid:JSON.stringify({isolation:{require:'hyperv-partition-per-app'},configCid})};
const policy = {cpu:{runtimeId:base.runtimeId,configBundleV5:true}};
const deps = {policy,readCatalog:async()=>({app:{active:true},version}),readConfig:async()=>({config:'{}',configCid}),
 fetchVerified:async cid=>({ok:true,bytes:cid===configCid?configBytes:component})};
const manager = extra => new Manager({runtimeId:base.runtimeId,configEnabled:true,fetchConfig:async()=>configBytes,fetchComponent:async()=>component,...extra});
const body = {name:dep,isPublic:true,hasSecrets:false,cpuShare:.25,gpuShare:0,derive:record};
test('CID config larger than ledger limit crosses planner, manager and independent relay with the same identity',async()=>{
 const m=manager(); const health=m.health();
 const plan=isolationPlan({deploymentId:dep,deployment:row,version,appConfig:config,hasSecrets:false,waf:{},volumes:[],runtimeId:base.runtimeId,require:'hyperv-partition-per-app',manager:health,appConfigCid:configCid});
 assert.equal(plan.ok,true,plan.why);
 const actual=await m.spawn(plan.spawn);
 const expected=await expectedShieldApp(row,deps);
 assert.equal(actual.appId,expected.appSha256);
 const bundle=derive({record:plan.spawn.derive,component}).bundle;
 const manifest=JSON.parse(bundle.subarray(BUNDLE_MAGIC.length+4,BUNDLE_MAGIC.length+4+bundle.readUInt32LE(BUNDLE_MAGIC.length)));
 assert.equal(Buffer.from(manifest.configBase64,'base64').toString(),config);
});
test('changing config changes the measured app, while legacy bundles stay byte-identical',()=>{
 assert.equal(derive({record:base,component}).appId,vectors.ok[0].mapping.appId);
 assert.notEqual(derive({record,component}).appId,derive({record:{...record,config:'{}'},component}).appId);
 assert.equal(appConfigText('{"_media":{"title":"store"},"title":"app"}'),'{"title":"app"}');
 for(const text of ['null','[]','bad',JSON.stringify({padding:'x'.repeat(MAX_CONFIG_BYTES)})])assert.throws(()=>appConfigText(text));
 assert.throws(()=>derive({record:{...base,config:'{}'},component}),/V5/);
 assert.notEqual(derive({record:{...record,http:8080},component}).appId,derive({record,component}).appId);
});
test('manager gates old images, tampered config, extra unmeasured inputs and staged secrets',async()=>{
 await assert.rejects(manager({configEnabled:false}).spawn(body),/not served/);
 await assert.rejects(manager({fetchConfig:async()=>Buffer.from('{"tampered":true}')}).spawn(body),/differs/);
 await assert.rejects(manager({fetchConfig:async()=>Buffer.from([0xff])}).spawn(body));
 for(const extra of [{config:'{}'},{configCid},{appConfigCid:configCid},{hasSecrets:true}])await assert.rejects(manager().spawn({...body,...extra}));
 assert.equal(manager({fetchConfig:null}).health().supports.configCid,false);
});
test('relay refuses unverified bytes, wrong image policy and failed CID reads',async()=>{
 await assert.rejects(expectedShieldApp(row,{...deps,policy:{cpu:{runtimeId:base.runtimeId}}}),/not supported/);
 await assert.rejects(expectedShieldApp(row,{...deps,fetchVerified:async()=>({ok:false})}),/CID-verified/);
 await assert.rejects(expectedShieldApp(row,{...deps,fetchVerified:async()=>({ok:true,bytes:Buffer.from([255])})}));
 const changed=await expectedShieldApp(row,{...deps,fetchVerified:async cid=>({ok:true,bytes:cid===configCid?Buffer.from('{"changed":true}'):component})});
 assert.notEqual(changed.appSha256,(await expectedShieldApp(row,deps)).appSha256);
});
test('explicit inline override takes precedence over a catalog CID, deployment CID takes precedence over routing inline',async()=>{
 const inline={...row,configCid:JSON.stringify({isolation:{require:'hyperv-partition-per-app'},config:{title:'override'}})};
 const calls=[];
 const got=await expectedShieldApp(inline,{...deps,fetchVerified:async cid=>{calls.push(cid);return {ok:true,bytes:component};}});
 assert.deepEqual(calls,[version.cid]);
 assert.notEqual(got.appSha256,(await expectedShieldApp(row,deps)).appSha256);
 const withRouting={...row,configCid:JSON.stringify({isolation:{require:'hyperv-partition-per-app'},configCid,config:{volumes:[]}})};
 assert.equal((await expectedShieldApp(withRouting,deps)).appSha256,(await expectedShieldApp(row,deps)).appSha256);
});
test('configured command services require an explicit runtime capability and preserve identity across the claim, manager and relay',async()=>{
 const commandVersion={...version,ports:'http:8000'};
 for(const secrets of [false,true]) {
  const m=manager({configSocketServer:true,secretsEnabled:secrets});
  const planArgs={deploymentId:dep,deployment:row,version:commandVersion,appConfig:config,hasSecrets:secrets,waf:{},volumes:[],runtimeId:base.runtimeId,require:'hyperv-partition-per-app',manager:m.health(),appConfigCid:configCid};
  const old=manager({secretsEnabled:secrets});
  assert.equal(isolationPlan({...planArgs,manager:old.health()}).ok,false);
  const plan=isolationPlan(planArgs);assert.equal(plan.ok,true,plan.why);
  await assert.rejects(old.spawn(plan.spawn),/configured command/);
  const actual=await m.spawn(plan.spawn);
  const options={...deps,secretsRequired:secrets,readCatalog:async()=>({app:{active:true},version:commandVersion}),policy:{cpu:{...policy.cpu,secretsV1:secrets,configSocketServer:true}}};
  const expected=await expectedShieldApp(row,options);
  assert.equal(actual.appId,expected.appSha256);
  assert.equal(expected.requiresConfigSocketServer,true);
  assert.equal(expected.requiresSecretsV1,secrets);
  await assert.rejects(expectedShieldApp(row,{...options,policy:{cpu:{...options.policy.cpu,configSocketServer:false}}}),/not supported/);
  const changed={...plan.spawn.derive,http:8001};
  assert.notEqual(derive({record:changed,component}).appId,actual.appId);
  if(secrets) {
   assert.throws(()=>derive({record:{...changed,http:443},component}),/unprivileged/);
   await assert.rejects(m.spawn({...plan.spawn,name:'0x'+'22'.repeat(32)}),/deployment differs/);
  }
 }
});
