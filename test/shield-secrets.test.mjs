import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {generateKeyPairSync,randomBytes} from 'node:crypto';import {privateKeyToAccount} from 'viem/accounts';
import {derive,DERIVATION_V6} from '../windows/vbslike/manager/derive.mjs';
import {Manager} from '../windows/vbslike/manager/server.mjs';import {isolationPlan} from '../windows/vbslike/datapath/node-bridge.mjs';
import {expectedShieldApp} from '../relay/shield-app-verifier.mjs';import {createShieldSecretRelease,secretRequestMessage} from '../relay/shield-secrets.mjs';
import {rawPublicOf,openRelease,verifyResponse,ed25519RawPublic} from '../relay/secrets-release.mjs';
const vectors=JSON.parse(fs.readFileSync(new URL('../isolation/contract/catalog/derive_vectors.json',import.meta.url)));
const component=Buffer.from(vectors.component_hex,'hex'),base=vectors.ok[0].mapping.record;
const id='0x'+'24'.repeat(32),epId='0x'+'88'.repeat(32),endpoint='https://api.enclave.host/t/nucbox-test';
const record={...base,derivation:DERIVATION_V6,config:'{"api_key":"$API_KEY"}',secretDeployment:id};
const version={...base.catalog,appId:base.catalog.app,index:base.catalog.version,cid:base.cid,memMb:base.policy.memMiB,ports:'',approval:1,yanked:false,config:record.config,configCid:''};
const row={id,runner:epId,owner:'0x'+'66'.repeat(20),active:true,isPublic:true,leaseUntil:String(Math.floor(Date.now()/1000)+600),appRef:`catalog://${base.catalog.app}/${base.catalog.version}`,cpuMilli:250,gpuMilli:0,configCid:JSON.stringify({isolation:{require:'hyperv-partition-per-app'}})};
const policy={hosts:['nucbox-test'],cpu:{runtimeId:base.runtimeId,configBundleV5:true,secretsV1:true}};
const deps={policy,readCatalog:async()=>({app:{active:true},version}),readConfig:async()=>({config:record.config,configCid:''}),fetchVerified:async()=>({ok:true,bytes:component})};
test('V6 binds deployment and unresolved config; planner, manager, and relay agree without seeing a secret',async()=>{
 const m=new Manager({runtimeId:base.runtimeId,configEnabled:true,secretsEnabled:true,fetchConfig:async()=>Buffer.from('{}'),fetchComponent:async()=>component});
 const plan=isolationPlan({deploymentId:id,deployment:row,version,appConfig:record.config,hasSecrets:true,waf:{},volumes:[],runtimeId:base.runtimeId,require:'hyperv-partition-per-app',manager:m.health(),appConfigCid:''});
 assert.equal(plan.ok,true,plan.why);assert.equal(plan.spawn.derive.derivation,DERIVATION_V6);
 const got=await m.spawn(plan.spawn),expected=await expectedShieldApp(row,{...deps,secretsRequired:true});assert.equal(got.appId,expected.appSha256);assert.equal(got.secretDeployment,id);
 assert.notEqual(derive({record,component}).appId,derive({record:{...record,secretDeployment:'0x'+'25'.repeat(32)},component}).appId);
 await assert.rejects(m.spawn({...plan.spawn,secrets:{API_KEY:'never-manager-input'}}),/plaintext/);
 await assert.rejects(m.spawn({...plan.spawn,name:'0x'+'25'.repeat(32)}),/identity/);
 const off=new Manager({configEnabled:true,secretsEnabled:false,fetchConfig:async()=>Buffer.from('{}')});assert.equal(off.health().supports.secrets,false);
 await assert.rejects(off.spawn(plan.spawn),/not served/);
 assert.throws(()=>derive({record:{...record,secretDeployment:'bad'},component}));
});
function setup({verify=true,lease=true,mutate=false,sessionChange=false}={}){
 const account=privateKeyToAccount('0x'+'71'.repeat(32)),signing=generateKeyPairSync('ed25519').privateKey,seal=generateKeyPairSync('x25519').privateKey;
 let reads=0,confirms=0,requestCount=0,lastNonce;
 const hub={shieldSessionId:()=>sessionChange&&confirms>1?'new':'session',fetchJson:async(origin,path)=>{
  lastNonce=Buffer.from(new URL(path,'https://x').searchParams.get('nonce'),'hex');return {id,purpose:'enclave-shield-secrets/1',sealKey:rawPublicOf(seal).toString('base64'),handshakeSpki:Buffer.alloc(44,1).toString('base64'),doc:{}};
 },verifyShieldApp:async(name,input)=>{assert.equal(input.requiresSecretsV1,true);assert.equal(input.shieldRelease.id,id);return {ok:verify};},request:async(origin,{body})=>{
  requestCount++;const b=JSON.parse(body);assert.equal(body.includes('synthetic-private-value'),false);
  const fields={id,ticket:lastNonce,sealKey:rawPublicOf(seal),sealed:Buffer.from(b.sealed,'base64')};assert.equal(verifyResponse({...fields,publicKey:ed25519RawPublic(signing),sig:Buffer.from(b.sig,'base64')}),true);
  const opened=JSON.parse(openRelease({id,ticket:lastNonce,sealPrivateKey:seal,sealed:fields.sealed}));assert.equal(opened.secrets.API_KEY,'synthetic-private-value');assert.equal(opened.config,null);
  return {status:200,body:Buffer.from('{"ok":true}')};}};
 const deliver=createShieldSecretRelease({...deps,hub,confirmRow:async()=>{confirms++;return {...row,...(!lease?{runner:'0x'+'00'.repeat(32)}:{}),...(mutate&&confirms>1?{configCid:'{}'}:{})};},hostForEndpoint:()=>({name:'nucbox-test',mode:'hv-node'}),signingKey:()=>signing});
 const ctx={operatorOfEndpoint:async()=>account.address,endpointIdOf:async()=>epId};
 return {async go(over={}){const ts=Math.floor(Date.now()/1000);const b={id,endpoint,ts,opSig:await account.signMessage({message:secretRequestMessage(id,endpoint,ts)}),...over};return deliver(b,ctx,()=>{reads++;return {rev:2,env:{API_KEY:'synthetic-private-value'}};});},counts:()=>({reads,requestCount})};
}
test('relay authenticates operator, confirms lease twice, verifies guest and only forwards signed ciphertext',async()=>{const s=setup();assert.equal((await s.go()).ok,true);assert.deepEqual(s.counts(),{reads:1,requestCount:1});await assert.rejects(s.go(),/replayed/);});
test('wrong signer, missing lease, wrong evidence, row mutation and reattachment release no plaintext',async()=>{
 for(const options of [{lease:false},{verify:false},{mutate:true},{sessionChange:true}]){const s=setup(options);await assert.rejects(s.go());assert.deepEqual(s.counts(),{reads:0,requestCount:0});}
 const s=setup();await assert.rejects(s.go({opSig:'0x'+'00'.repeat(65)}));assert.equal(s.counts().reads,0);
});
