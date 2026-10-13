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
 return {m,started,published,setProviders:p=>{list=p;},setByoFails:v=>{byoFails=v;}};
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
 const short=selectNetworkCircuits([1,2,3].map(n=>prov(n)),{routes:2,ingress:true,egress:true,maxPricePerGiB6:0});
 assert.equal(short.length,1);assert.match(short.short,/1 of 2 route/);
 assert.throws(()=>selectNetworkCircuits([1].map(n=>prov(n)),{routes:1,ingress:true,egress:true,maxPricePerGiB6:0}),/2 distinct providers/);
});
test('too few qualified providers degrades to the circuits they allow (never to none), and recovers when one returns',async()=>{
 const r=rig({providers:[1,2,3].map(n=>prov(n))});await r.m.configure([app(defaultNetworkPolicy(id))]);await r.m.reconcile();
 let st=r.m.status()[0];assert.equal(r.m.apps.get(id).circuits.length,1);assert.equal(st.ready,true,'one route serves');assert.match(st.degraded,/1 of 2/);
 assert.equal(r.published.at(-1).length,1);
 r.setProviders([1,2,3,4].map(n=>prov(n)));await r.m.reconcile();
 st=r.m.status()[0];assert.equal(r.m.apps.get(id).circuits.length,2);assert.equal(st.degraded,null);assert.equal(r.published.at(-1).length,2);
});
test('direct hosting on a host that opted in: one direct route while its qualification is current, withdrawn when it lapses',async()=>{
 let until=Date.now()+600000;const started=[];
 const direct={qualification:async()=>({expiresAt:until}),runtime:{start:async a=>{const c=new EventEmitter();Object.assign(c,{...a,id:'d'.repeat(32),address:'45.0.0.9',closed:false,egress:'127.0.0.1:7',admit(){},async close(r){this.closed=true;this.emit('down',r);}});started.push(c);return c;}}};
 const admission={allows:()=>true,leases:new Map([[id,{validUntil:Date.now()+600000}]]),proofs:new Map([[id,{validUntil:Date.now()+600000}]])};
 const published=[];
 const m=new EnclaveNetworkManager({runtime:{start:async()=>{throw new Error('no network circuit for a direct app');}},admission,providers:async()=>[],direct,probe:async()=>{},publish:async(i,r)=>{published.push(r);}});
 await m.configure([app({version:5,deploymentId:id,nonce:1,issuedAt:1,mode:'direct',fallback:'none',direct:{maxPricePerGiB6:0}})]);await m.reconcile();
 assert.equal(started.length,1);assert.deepEqual(published.at(-1),[{circuit:'d'.repeat(32),address:'45.0.0.9',port:443,transport:'direct'}]);
 assert.equal(m.status()[0].ready,true);
 until=Date.now()-1;await m.reconcile();
 assert.ok(started[0].closed,'qualification lapsed: the direct route closes');assert.deepEqual(published.at(-1),[]);
 assert.match(m.status()[0].error,/qualification/);
});
test('the status says which modes this host can serve: no direct without the opt-in, direct with it (the Network tab offers only these)',async()=>{
 const r=rig();await r.m.configure([app({version:5,deploymentId:id,nonce:1,issuedAt:1,mode:'enclave-network',fallback:'none',enclaveNetwork:{routes:2,guard:true,maxPricePerGiB6:0,budget6:0}})]);
 assert.deepEqual(r.m.status()[0].modes,['enclave-network','byo-wireguard']);
 const d=new EnclaveNetworkManager({runtime:{start:async()=>{throw new Error('x');}},admission:r.m.admission,providers:async()=>[],direct:{qualification:async()=>null,runtime:{}},probe:async()=>{},publish:async()=>{}});
 assert.deepEqual(d.hostModes(),['enclave-network','byo-wireguard','direct']);
});
test('a direct-mode policy builds nothing here and says why (no qualified direct host)',async()=>{
 const r=rig();await r.m.configure([app({version:5,deploymentId:id,nonce:1,issuedAt:1,mode:'direct',fallback:'none',direct:{maxPricePerGiB6:0}})]);await r.m.reconcile();
 assert.equal(r.m.apps.get(id).circuits.length,0);assert.match(r.m.status()[0].error,/direct hosting is not available/);
});
test('one provider incident failing every app through it cools it down once, not once per app',async()=>{
 let t=1e12;const r=rig();r.m.now=()=>t;
 const p=prov(9);for(let i=0;i<5;i++)r.m.strike(p);
 assert.equal(r.m.drops.get(p.providerId),1);assert.equal(r.m.cooldown.get(p.providerId),t+60000);
 t+=61000;r.m.strike(p);assert.equal(r.m.drops.get(p.providerId),2,'a later incident still escalates');assert.equal(r.m.cooldown.get(p.providerId),t+120000);
});
test('BYO egress fails over to the authorized fallback and back without touching the website circuits',async()=>{
 const r=rig({providers:[1,2,3,4,5,6].map(n=>prov(n))});
 const policy={version:5,deploymentId:id,nonce:4,issuedAt:4,mode:'byo-wireguard',fallback:'enclave-network',byo:{configDigest:'cd'.repeat(32),ingress:'enclave-network'},enclaveNetwork:{routes:1,guard:true,maxPricePerGiB6:0,budget6:0}};
 await r.m.configure([app(policy)]);await r.m.reconcile();
 const web=r.m.apps.get(id).circuits.find(c=>c.kind==='network');assert.ok(web.ingress&&!web.egressReady);
 r.setByoFails(true);await r.m.apps.get(id).circuits.find(c=>c.kind==='byo').close('BYO endpoint gone');
 await r.m.reconcile();await r.m.reconcile();
 let cs=r.m.apps.get(id).circuits;const fb=cs.find(c=>c.fallback);
 assert.ok(!web.closed&&cs.includes(web),'the website circuit stays up during failover');
 assert.ok(fb&&fb.egressReady&&!fb.ingress,'egress through its own fallback circuit');
 assert.ok(![fb.guard.address,fb.exit.address].some(a=>[web.guard.address,web.exit.address].includes(a)),'distinct providers when there are enough');
 let st=r.m.status()[0];assert.equal(st.fallbackActive,true);assert.equal(st.ready,true);
 r.setByoFails(false);await r.m.reconcile();await r.m.reconcile();
 cs=r.m.apps.get(id).circuits;assert.ok(fb.closed&&!cs.includes(fb),'fallback withdrawn once BYO is back');
 assert.ok(!web.closed&&cs.includes(web)&&cs.some(c=>c.kind==='byo'));st=r.m.status()[0];assert.equal(st.fallbackActive,false);assert.equal(st.ready,true);
});
