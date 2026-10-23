// A Shield certificate request is authorized FRESH every time (relay/shield-marketplace.mjs admit): the deployment row from
// the chain quorum (confirmRow, before and after the guest proof), the catalog's CURRENT listing and approval, the owner
// exception and the staged-secrets rule. An earlier success, or a stale row held by the caller (certs.js reads cached ledger
// rows), never stands in for them, and an unavailable authorization read refuses without extending any earlier grant.
// (2026-10-23 root review: a whole-verdict reuse would have issued from an old proof after a catalog or ledger change.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createShieldMarketplace} from '../relay/shield-marketplace.mjs';
const vectors=JSON.parse(fs.readFileSync(new URL('../isolation/contract/catalog/derive_vectors.json',import.meta.url)));
const KEY='aa'.repeat(32);
function fixture({owner=false}={}) {
 let clock=1000000,sid='connection1',secret=false,ownerNow=owner;
 const record=vectors.ok[0].mapping.record;
 const row={id:'0x'+'11'.repeat(32),runner:'0x'+'22'.repeat(32),active:true,isPublic:true,leaseUntil:2000,owner:'0x'+'44'.repeat(20),
  appRef:`catalog://${record.catalog.app}/0`,cpuMilli:10,gpuMilli:0,configCid:'{"isolation":{"require":"hyperv-partition-per-app"}}'};
 const host={name:'nucbox-k11',mode:'hv-node',id:row.runner};
 const chain={row:{...row},fail:null};
 const catalog={app:{active:true},version:{cid:record.cid,memMb:128,ports:'',approval:1,yanked:false},fail:null};
 const calls={confirm:0,catalog:0};
 const hub={shieldSessionId:()=>sid,notifyShieldMarket:()=>{},
  fetchJson:async()=>({doc:{},handshakeSpki:Buffer.alloc(44).toString('base64')}),
  verifyShieldApp:(_n,input)=> input.expectedCsrSpkiSha256 && input.expectedCsrSpkiSha256 !== KEY ? {ok:false,reason:'wrong CSR'} : {ok:true,spkiSha256:KEY}};
 const market=createShieldMarketplace({hub,policy:{schema:'enclave-shield-app-policy/1',marketEnabled:true,hosts:[host.name],ekRoots:'test',cpu:{runtimeId:'ab'.repeat(32)}},
  now:()=>clock,
  confirmRow:async()=>{calls.confirm++;if(chain.fail)throw new Error(chain.fail);return {...chain.row};},
  hasSecrets:()=>secret,isOwnerDeployment:()=>ownerNow,
  readCatalog:async()=>{calls.catalog++;if(catalog.fail)throw new Error(catalog.fail);return {app:{...catalog.app},version:{...catalog.version}};},
  readConfig:async()=>({config:'',configCid:''}),
  fetchVerified:async()=>({ok:true,bytes:Buffer.from(vectors.component_hex,'hex')}),log:()=>{}});
 return {market,host,row,chain,catalog,calls,tick:s=>clock+=s*1000,setSecret:v=>secret=v,setOwner:v=>ownerNow=v};
}
async function granted(x){
 const r=await x.market.certificate(x.host,x.row,KEY);assert.equal(r.ok,true,JSON.stringify(r));
 return x.market.servesUntil(x.host,x.row);
}

test('every certificate request reads the chain row (twice) and the catalog afresh, even right after a success',async()=>{
 const x=fixture();await granted(x);
 const c=x.calls.confirm,k=x.calls.catalog;x.tick(5);
 assert.equal((await x.market.certificate(x.host,x.row,KEY)).ok,true);
 assert.equal(x.calls.confirm,c+2,'confirmRow before and after the proof');assert.equal(x.calls.catalog,k+1,'the catalog read');
});
test('a catalog change under the SAME appRef refuses the next certificate: rejected, yanked, pending, delisted, unreadable',async()=>{
 for(const [what,change] of [
  ['rejected by the catalog owner',c=>c.version.approval=2],
  ['yanked by its publisher',c=>c.version.yanked=true],
  ['pending again',c=>c.version.approval=0],
  ['delisted',c=>c.app.active=false],
  ['unreadable',c=>c.fail='only 1 of 3 RPCs answered the catalog read']]){
  const x=fixture();await granted(x);x.tick(5);change(x.catalog);
  const r=await x.market.certificate(x.host,x.row,KEY);
  assert.equal(r.ok,false,what);
 }
});
test('the chain decides, not the caller\'s stale row: a moved lease, an ended lease, a stopped or private app refuses',async()=>{
 for(const [what,change] of [
  ['lease moved to another host',r=>r.runner='0x'+'33'.repeat(32)],
  ['lease ended',r=>r.leaseUntil=900],
  ['deployment stopped',r=>r.active=false],
  ['made private',r=>r.isPublic=false]]){
  const x=fixture();await granted(x);x.tick(5);change(x.chain.row);
  // x.row - what certs.js hands over from its cached ledger rows - still shows the old, granted state
  const r=await x.market.certificate(x.host,x.row,KEY);
  assert.equal(r.ok,false,what);
 }
});
test('a PENDING catalog version is certified only while its owner is served (the owner exception); staged secrets refuse',async()=>{
 const x=fixture({owner:true});x.catalog.version.approval=0;
 await granted(x);x.tick(5);x.setOwner(false);
 assert.equal((await x.market.certificate(x.host,x.row,KEY)).ok,false,'owner no longer served: the pending version is refused');
 const z=fixture({owner:false});z.catalog.version.approval=0;
 assert.equal((await z.market.certificate(z.host,z.row,KEY)).ok,false,'a pending version without the owner exception');
 const y=fixture();await granted(y);y.tick(5);y.setSecret(true);
 assert.equal((await y.market.certificate(y.host,y.row,KEY)).ok,false,'staged secrets');
});
test('an unavailable authorization read refuses and never extends the earlier grant',async()=>{
 const x=fixture();const until=await granted(x);
 x.tick(60);x.chain.fail='RPC Request failed.';
 assert.equal((await x.market.certificate(x.host,x.row,KEY)).ok,false,'chain read unavailable');
 assert.equal(x.market.servesUntil(x.host,x.row),until,'a transient failure keeps the old grant to its own TTL, not longer');
 x.chain.fail=null;x.catalog.fail='HTTP request failed.';x.tick(60);
 assert.equal((await x.market.certificate(x.host,x.row,KEY)).ok,false,'catalog read unavailable');
 assert.equal(x.market.servesUntil(x.host,x.row),until);
 x.tick(181);assert.equal(x.market.servesUntil(x.host,x.row),0,'and it lapses at that TTL');
});
