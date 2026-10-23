// A certificate request reuses the CURRENT Shield verdict for the exact attested TLS key, instead of re-running the whole
// verification inside the request (2026-10-23 0x59f1273d: the node's 60-s POST abort fired while the relay re-fetched the
// catalog component, so even a cached certificate was unreachable). Anything else still runs the full admit().
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createShieldMarketplace} from '../relay/shield-marketplace.mjs';
const vectors=JSON.parse(fs.readFileSync(new URL('../isolation/contract/catalog/derive_vectors.json',import.meta.url)));
const KEY='aa'.repeat(32);
function fixture({owner=false}={}) {
 let clock=1000000,sid='connection1',secret=false,ownerNow=owner;
 const record=vectors.ok[0].mapping.record;
 const row={id:'0x'+'11'.repeat(32),runner:'0x'+'22'.repeat(32),active:true,isPublic:true,leaseUntil:2000,
  appRef:`catalog://${record.catalog.app}/0`,cpuMilli:10,gpuMilli:0,configCid:'{"isolation":{"require":"hyperv-partition-per-app"}}'};
 const host={name:'nucbox-k11',mode:'hv-node',id:row.runner};
 const calls={evidence:0,component:0,confirm:0},logs=[];
 let componentHangs=false;
 const hub={shieldSessionId:()=>sid,notifyShieldMarket:()=>{},
  fetchJson:async()=>{calls.evidence++;return {doc:{},handshakeSpki:Buffer.alloc(44).toString('base64')};},
  verifyShieldApp:(_n,input)=> input.expectedCsrSpkiSha256 && input.expectedCsrSpkiSha256 !== KEY ? {ok:false,reason:'wrong CSR'} : {ok:true,spkiSha256:KEY}};
 const market=createShieldMarketplace({hub,policy:{schema:'enclave-shield-app-policy/1',marketEnabled:true,hosts:[host.name],ekRoots:'test',cpu:{runtimeId:'ab'.repeat(32)}},
  now:()=>clock,confirmRow:async()=>{calls.confirm++;return {...row};},hasSecrets:()=>secret,isOwnerDeployment:()=>ownerNow,
  readCatalog:async()=>({app:{active:true},version:{cid:record.cid,memMb:128,ports:'',approval:1,yanked:false}}),
  readConfig:async()=>({config:'',configCid:''}),
  fetchVerified:async()=>{calls.component++;if(componentHangs)return new Promise(()=>{});return {ok:true,bytes:Buffer.from(vectors.component_hex,'hex')};},
  log:m=>logs.push(m)});
 return {market,host,row,calls,logs,tick:s=>clock+=s*1000,setSession:v=>sid=v,setSecret:v=>secret=v,setOwner:v=>ownerNow=v,hang:()=>componentHangs=true};
}
const within=(p,ms)=>Promise.race([p,new Promise(r=>setTimeout(()=>r('TIMED OUT'),ms))]);
const snapshot=c=>({...c});

test('a certificate for the attested key reuses the current verdict: no evidence, chain or component work in the request',async()=>{
 const x=fixture();await x.market.refresh([x.host],[x.row]);
 const before=snapshot(x.calls);x.tick(30);x.hang();
 const r=await within(x.market.certificate(x.host,x.row,KEY),500);
 assert.notEqual(r,'TIMED OUT','a slow component fetch must not hold a request that a current verdict answers');
 assert.equal(r.ok,true);assert.equal(r.spkiSha256,KEY);assert.equal(r.reused,true);
 assert.deepEqual(x.calls,before,'nothing re-verified inside the request');
 assert.ok(x.logs.some(m=>/certificate nucbox-k11\/0x11111111: reusing the verdict of 30s ago/.test(m)));
});
test('without a current verdict the full admit runs (the old path), and a hung component fetch still holds it',async()=>{
 const x=fixture();x.hang();
 assert.equal(await within(x.market.certificate(x.host,x.row,KEY),300),'TIMED OUT');
 assert.equal(x.calls.component,1);
});
test('a verdict checked two refresh rounds ago or more is not reused: the request verifies afresh',async()=>{
 const x=fixture();await x.market.refresh([x.host],[x.row]);
 const n=x.calls.evidence;x.tick(120);
 const r=await x.market.certificate(x.host,x.row,KEY);
 assert.equal(r.ok,true);assert.equal(r.reused,undefined);assert.equal(x.calls.evidence,n+1);
});
test('another key, a new session, a changed row or lease, a private app, staged secrets and a lost owner exception all verify afresh',async()=>{
 const cases=[
  ['another key',x=>({spki:'bb'.repeat(32)})],
  ['new session',x=>{x.setSession('connection2');return {};}],
  ['changed fingerprint',x=>({row:{...x.row,cpuMilli:20}})],
  ['private',x=>({row:{...x.row,isPublic:false}})],
  ['inactive',x=>({row:{...x.row,active:false}})],
  ['lease ended',x=>({row:{...x.row,leaseUntil:1000}})],
  ['another runner',x=>({row:{...x.row,runner:'0x'+'33'.repeat(32)}})],
  ['staged secrets',x=>{x.setSecret(true);return {};}],
 ];
 for(const [name,change] of cases){
  const x=fixture();await x.market.refresh([x.host],[x.row]);x.tick(10);
  const {spki=KEY,row=x.row}=change(x)||{};
  const n=x.calls.evidence;
  const r=await x.market.certificate(x.host,row,spki);
  assert.notEqual(r.reused,true,name);assert.ok(x.calls.evidence>n||r.ok===false,name);
 }
 const y=fixture({owner:true});await y.market.refresh([y.host],[y.row]);y.tick(10);y.setOwner(false);
 const n=y.calls.evidence;const r=await y.market.certificate(y.host,y.row,KEY);
 assert.notEqual(r.reused,true,'owner exception lost');assert.equal(y.calls.evidence,n+1);
});
test('a refused key still revokes the verdict, so the attested key is then verified afresh too',async()=>{
 const x=fixture();await x.market.refresh([x.host],[x.row]);x.tick(10);
 assert.equal((await x.market.certificate(x.host,x.row,'bb'.repeat(32))).ok,false);
 assert.equal(x.market.servesUntil(x.host,x.row),0);
 const n=x.calls.evidence;const r=await x.market.certificate(x.host,x.row,KEY);
 assert.equal(r.reused,undefined);assert.equal(x.calls.evidence,n+1);
});
