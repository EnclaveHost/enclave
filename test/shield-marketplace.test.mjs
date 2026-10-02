import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createShieldMarketplace} from '../relay/shield-marketplace.mjs';
const vectors=JSON.parse(fs.readFileSync(new URL('../isolation/contract/catalog/derive_vectors.json',import.meta.url)));
function fixture() {
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
 const market=createShieldMarketplace({hub,policy:{schema:'enclave-shield-app-policy/1',marketEnabled:true,hosts:[host.name],ekRoots:'test',cpu:{runtimeId:'ab'.repeat(32)}},
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
test('a transient re-verification failure keeps the app served until its TTL; a mismatch revokes it',async()=>{
 const x=fixture();await x.market.refresh([x.host],[x.row]);
 assert.ok(x.market.servesUntil(x.host,x.row)>0);
 // Nan's chain read fails on the next round: the app stays served, not extended.
 const verifiedUntil=x.market.servesUntil(x.host,x.row);
 x.setClock(1060001);x.hub.fetchJson=async()=>null;await x.market.refresh([x.host],[x.row]);
 assert.equal(x.market.servesUntil(x.host,x.row),verifiedUntil);
 x.setClock(1120002);x.hub.fetchJson=async()=>{throw Object.assign(new Error('RPC Request failed.'),{});};await x.market.refresh([x.host],[x.row]);
 assert.equal(x.market.servesUntil(x.host,x.row),verifiedUntil);
 // It still lapses at the TTL with no successful round.
 x.setClock(1000000+300001);assert.equal(x.market.servesUntil(x.host,x.row),0);
 // A wrong proof revokes at once.
 const y=fixture();await y.market.refresh([y.host],[y.row]);assert.ok(y.market.servesUntil(y.host,y.row)>0);
 y.setClock(1060001);y.hub.verifyShieldApp=()=>({ok:false,reason:'app digest mismatch'});await y.market.refresh([y.host],[y.row]);
 assert.equal(y.market.servesUntil(y.host,y.row),0);
});
