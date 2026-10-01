import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createShieldMarketplace} from '../relay/shield-marketplace.mjs';
const vectors=JSON.parse(fs.readFileSync(new URL('../isolation/contract/catalog/derive_vectors.json',import.meta.url)));
function fixture(witness = null) {
 let clock=1000000,sid='connection1',secret=false;
 const record=vectors.ok[0].mapping.record;
 const row={id:'0x'+'11'.repeat(32),runner:'0x'+'22'.repeat(32),active:true,isPublic:true,leaseUntil:2000,
  appRef:`catalog://${record.catalog.app}/0`,cpuMilli:10,gpuMilli:0,configCid:'{"isolation":{"require":"hyperv-partition-per-app"}}'};
 const host={name:'nucbox-k11',mode:'hv-node',id:row.runner};
 const sent=[];
 const hub={shieldSessionId:()=>sid,notifyShieldMarket:(...v)=>sent.push(v),
  fetchJson:async()=>({doc:{},handshakeSpki:Buffer.alloc(44).toString('base64')}),
  verifyShieldApp:(_n,input)=> input.expectedCsrSpkiSha256 && input.expectedCsrSpkiSha256 !== 'aa'.repeat(32)
    ? {ok:false,reason:'wrong CSR'} : {ok:true,spkiSha256:'aa'.repeat(32)}};
 const market=createShieldMarketplace({hub,policy:{schema:'enclave-shield-app-policy/1',marketEnabled:true,...(witness ? {witness} : {}),hosts:[host.name],ekRoots:'test',cpu:{runtimeId:'ab'.repeat(32)}},
  now:()=>clock,confirmRow:async()=>({...row}),hasSecrets:()=>secret,
  readCatalog:async()=>({app:{active:true},version:{cid:record.cid,memMb:128,ports:'',approval:1,yanked:false}}),
  readConfig:async()=>({config:'',configCid:''}),fetchVerified:async()=>({ok:true,bytes:Buffer.from(vectors.component_hex,'hex')}),log:()=>{}});
 return {market,host,row,sent,setClock:v=>clock=v,setSession:v=>sid=v,setSecret:v=>secret=v,hub};
}
test('market qualification is connection-bound and routes only each verified live public app',async()=>{
 const x=fixture();assert.equal(x.market.eligible(x.host),false);
 await x.market.refresh([x.host],[x.row]);assert.equal(x.market.eligible(x.host),true);
 assert.ok(x.market.servesUntil(x.host,x.row)>1000);assert.equal(x.sent.length,1);
 assert.equal(x.market.servesUntil(x.host,{...x.row,configCid:'{}'}),0);
 assert.equal(x.market.servesUntil(x.host,{...x.row,id:'0x'+'33'.repeat(32)}),0);
 x.setSecret(true);assert.equal(x.market.servesUntil(x.host,x.row),0);x.setSecret(false);
 x.setSession('connection2');assert.equal(x.market.eligible(x.host),false);assert.equal(x.market.servesUntil(x.host,x.row),0);
 await x.market.refresh([x.host],[x.row]);assert.equal(x.market.eligible(x.host),true);
 x.setClock(1300001);assert.equal(x.market.eligible(x.host),false);assert.equal(x.market.servesUntil(x.host,x.row),0);
});
test('fresh certificate verification refuses another key and a reconnect during the challenge',async()=>{
 const x=fixture();assert.equal((await x.market.certificate(x.host,x.row,'aa'.repeat(32))).ok,true);
 assert.equal((await x.market.certificate(x.host,x.row,'bb'.repeat(32))).ok,false);
 assert.equal(x.market.servesUntil(x.host,x.row),0);
 x.hub.fetchJson=async()=>{x.setSession('replacement');return {doc:{},handshakeSpki:Buffer.alloc(44).toString('base64')};};
 assert.equal((await x.market.certificate(x.host,x.row,'aa'.repeat(32))).ok,false);
 assert.equal(x.market.eligible(x.host),false);
});
test('a change in the ledger during verification, private apps and staged secrets fail closed',async()=>{
 for(const mutation of [x=>x.row.isPublic=false,x=>x.setSecret(true),x=>x.row.cpuMilli=20]){
  const x=fixture();x.hub.fetchJson=async()=>{mutation(x);return {doc:{},handshakeSpki:Buffer.alloc(44).toString('base64')};};
  assert.equal((await x.market.certificate(x.host,x.row,'aa'.repeat(32))).ok,false);
  assert.equal(x.market.eligible(x.host),false);
 }
});

test('background failures are spaced rather than retried on every availability poll',async()=>{
 const x=fixture();let calls=0;
 x.hub.fetchJson=async()=>{calls++;throw new Error('temporary provider failure');};
 await x.market.refresh([x.host],[x.row]);
 await x.market.refresh([x.host],[x.row]);
 assert.equal(calls,1);assert.equal(x.market.eligible(x.host),false);
 x.setClock(1060001);await x.market.refresh([x.host],[x.row]);assert.equal(calls,2);
});

const witness={appSha256:'cd'.repeat(32),runtimeId:'ab'.repeat(32)};
test('a pinned witness qualifies an empty host without granting any app routes or certificates',async()=>{
 const x=fixture(witness);let nonce;
 x.hub.fetchJson=async(_name,path)=>{assert.match(path,/^\/v1\/shield\/readiness\?nonce=[0-9a-f]{64}$/);nonce=path.split('=')[1];return {doc:{},handshakeSpki:Buffer.alloc(44).toString('base64')};};
 x.hub.verifyShieldApp=(_name,input)=>{assert.equal(input.expectedAppSha256,witness.appSha256);assert.equal(input.expectedRuntimeId,witness.runtimeId);assert.equal(input.nonce.toString('hex'),nonce);return {ok:true};};
 await x.market.refresh([x.host],[]);assert.equal(x.market.eligible(x.host),true);
 assert.equal(x.market.servesUntil(x.host,x.row),0);assert.equal(x.sent.length,1);
 x.setSession('new');assert.equal(x.market.eligible(x.host),false);
 x.hub.verifyShieldApp=()=>({ok:false,reason:'replayed/wrong image'});
 await x.market.refresh([x.host],[]);assert.equal(x.market.eligible(x.host),false);
});
test('witness failure expires capacity and a reconnect during verification grants nothing',async()=>{
 const x=fixture(witness);await x.market.refresh([x.host],[]);assert.equal(x.market.eligible(x.host),true);
 x.hub.fetchJson=async()=>{throw Error('witness stopped');};x.setClock(1300001);
 await x.market.refresh([x.host],[]);assert.equal(x.market.eligible(x.host),false);
 const y=fixture(witness);y.hub.fetchJson=async()=>{y.setSession('new');return {doc:{},handshakeSpki:Buffer.alloc(44).toString('base64')};};
 await y.market.refresh([y.host],[]);assert.equal(y.market.eligible(y.host),false);assert.equal(y.sent.length,0);
});
