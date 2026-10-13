// The host's Enclave-network manager (network/wg-manager.mjs): which circuits a v5 policy builds, a policy change,
// BYO with Enclave-network ingress, the owner-authorized fallback, and revocation when a provider's qualification lapses.
import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {EnclaveNetworkManager,selectNetworkCircuits} from '../network/wg-manager.mjs';
import {defaultNetworkPolicy} from '../network/network-policy-core.mjs';

const id='0x'+'ab'.repeat(32);
const prov=(n,over={})=>({providerId:String(n).repeat(32).slice(0,32),address:`44.0.0.${n}`,wgExitKey:'x'+n,wgGuardKey:'g'+n,ports:{exit:51820,guard:51821,control:51822},
 region:'r'+n,kind:'enclave',pricePerGiB6:0,eligibleRoles:['guard','ingress','egress'],qualifiedUntil:Date.now()+600000,...over});
function rig({providers=[1,2,3,4].map(n=>prov(n)),byoFails=false}={}){
 let list=providers;const started=[],published=[];
 const admission={allows:()=>true,leases:new Map([[id,{validUntil:Date.now()+600000}]]),proofs:new Map([[id,{validUntil:Date.now()+600000}]])};
 const runtime={start:async a=>{
  if(a.kind==='byo'&&byoFails)throw new Error('BYO endpoint unreachable');
  const c=new EventEmitter();Object.assign(c,{...a,id:String(started.length).padStart(32,'0'),closed:false,providers:a.kind==='byo'?{byo:{address:a.byo.endpoint.address}}:{guard:a.guard,exit:a.exit},
   address:a.kind==='byo'?null:a.exit.address,egressReady:!!a.egress,egress:a.egress?'127.0.0.1:9':null,admit(){},async close(r){this.closed=true;this.emit('down',r);}});started.push(c);return c;}};
 const m=new EnclaveNetworkManager({runtime,admission,providers:async()=>list,byoConfig:async()=>({endpoint:{address:'1.2.3.4',port:51820}}),probe:async()=>{},probeEgress:async()=>{},
  publish:async(app,routes)=>{published.push(routes);}});
 return {m,started,published,setProviders:p=>{list=p;}};
}
const app=(policy,names=['abababab.app.enclave.host'])=>({deploymentId:id,names,policy,isPublic:true});

test('the default policy: two circuits through four distinct providers, both exits published',async()=>{
 const r=rig();await r.m.configure([app(defaultNetworkPolicy(id))]);await r.m.reconcile();
 const a=r.m.apps.get(id);assert.equal(a.circuits.length,2);
 const addrs=a.circuits.flatMap(c=>[c.providers.guard.address,c.providers.exit.address]);assert.equal(new Set(addrs).size,4,'no provider shared');
 assert.ok(a.circuits.every(c=>c.ingress&&c.egressReady));
 assert.deepEqual(r.published.at(-1).map(x=>x.address).sort(),a.circuits.map(c=>c.address).sort());
 assert.ok(r.published.at(-1).every(x=>x.transport==='enclave-network'&&x.port===443));
});
test('an owner policy change rebuilds the circuits to match it (routes 2 -> 1)',async()=>{
 const r=rig();await r.m.configure([app(defaultNetworkPolicy(id))]);await r.m.reconcile();const before=[...r.m.apps.get(id).circuits];
 const one={...defaultNetworkPolicy(id),nonce:1,issuedAt:1,enclaveNetwork:{routes:1,guard:true,maxPricePerGiB6:0,budget6:0}};
 await r.m.configure([app(one)]);assert.ok(before.every(c=>c.closed),'old circuits withdrawn on a policy change');
 await r.m.reconcile();assert.equal(r.m.apps.get(id).circuits.length,1);assert.equal(r.published.at(-1).length,1);
});
test('BYO with Enclave-network ingress: a BYO egress tunnel plus ingress-only network circuits',async()=>{
 const r=rig();
 const byo={version:5,deploymentId:id,nonce:2,issuedAt:2,mode:'byo-wireguard',fallback:'none',byo:{configDigest:'cd'.repeat(32),ingress:'enclave-network'},enclaveNetwork:{routes:2,guard:true,maxPricePerGiB6:0,budget6:0}};
 await r.m.configure([app(byo)]);await r.m.reconcile();
 const cs=r.m.apps.get(id).circuits;
 assert.equal(cs.filter(c=>c.kind==='byo').length,1);assert.ok(cs.find(c=>c.kind==='byo').egressReady);
 const net=cs.filter(c=>c.kind==='network');assert.equal(net.length,2);assert.ok(net.every(c=>c.ingress&&!c.egressReady),'network circuits carry the website only');
 assert.equal(r.m.status()[0].egress,'byo-wireguard');
});
test('BYO down: no fallback unless the owner authorized one; with it, Enclave-network egress and it says so',async()=>{
 const base={version:5,deploymentId:id,nonce:3,issuedAt:3,mode:'byo-wireguard',byo:{configDigest:'cd'.repeat(32),ingress:'none'}};
 const r=rig({byoFails:true});await r.m.configure([app({...base,fallback:'none'})]);await r.m.reconcile();await r.m.reconcile();
 assert.equal(r.m.apps.get(id).circuits.length,0,'no silent switch to another network');
 const f=rig({byoFails:true});await f.m.configure([app({...base,fallback:'enclave-network',enclaveNetwork:{routes:1,guard:true,maxPricePerGiB6:0,budget6:0}})]);
 await f.m.reconcile();await f.m.reconcile();
 const cs=f.m.apps.get(id).circuits;assert.equal(cs.length,1);assert.ok(cs[0].egressReady&&!cs[0].ingress&&cs[0].fallback);
 assert.equal(f.m.status()[0].fallbackActive,true);
});
test('a provider whose qualification lapses loses its circuits at once; an over-price provider is never chosen',async()=>{
 const r=rig();await r.m.configure([app(defaultNetworkPolicy(id))]);await r.m.reconcile();
 const victim=r.m.apps.get(id).circuits[0],vid=victim.providers.exit.providerId;
 r.setProviders([1,2,3,4,5,6].map(n=>prov(n)).filter(p=>p.providerId!==vid));
 await r.m.reconcile();assert.ok(victim.closed,'revoked');assert.ok(r.m.apps.get(id).circuits.every(c=>c.providers.exit.providerId!==vid&&c.providers.guard.providerId!==vid));
 assert.throws(()=>selectNetworkCircuits([1,2,3,4].map(n=>prov(n,{pricePerGiB6:5})),{routes:1,ingress:true,egress:true,maxPricePerGiB6:0}),/not enough/);
 assert.throws(()=>selectNetworkCircuits([1,2,3].map(n=>prov(n)),{routes:2,ingress:true,egress:true,maxPricePerGiB6:0}),/4 distinct providers/);
});
test('a direct-mode policy builds nothing here and says why (no qualified direct host)',async()=>{
 const r=rig();await r.m.configure([app({version:5,deploymentId:id,nonce:1,issuedAt:1,mode:'direct',fallback:'none',direct:{maxPricePerGiB6:0}})]);await r.m.reconcile();
 assert.equal(r.m.apps.get(id).circuits.length,0);assert.match(r.m.status()[0].error,/direct hosting is not available/);
});
