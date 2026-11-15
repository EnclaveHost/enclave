// The host's Enclave-network manager (network/wg-manager.mjs): which circuits a v5 policy builds, a policy change,
// BYO with Enclave-network ingress, the owner-authorized fallback, and revocation when a provider's qualification lapses.
import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {EnclaveNetworkManager,selectNetworkCircuits} from '../network/wg-manager.mjs';
import {defaultNetworkPolicy} from '../network/network-policy-core.mjs';

const id='0x'+'ab'.repeat(32);
const prov=(n,over={})=>({providerId:String(n).repeat(32).slice(0,32),address:`44.0.0.${n}`,wgExitKey:'x'+n,wgGuardKey:'g'+n,ports:{exit:51820,guard:51821,control:51822},
 region:'r'+n,kind:'enclave',pricePerGiB6:0,eligibleRoles:['guard','ingress','egress'],qualifiedUntil:Date.now()+600000,...over});
function rig({providers=[1,2,3,4].map(n=>prov(n)),byoFails=false,distance=null,oneHop=null,now=Date.now}={}){
 let list=providers;const started=[],published=[];
 const admission={allows:()=>true,leases:new Map([[id,{validUntil:Date.now()+600000}]]),proofs:new Map([[id,{validUntil:Date.now()+600000}]])};
 const runtime={start:async a=>{
  if(a.kind==='byo'&&byoFails)throw new Error('BYO endpoint unreachable');
  const c=new EventEmitter();Object.assign(c,{...a,id:String(started.length).padStart(32,'0'),closed:false,providers:a.kind==='byo'?{byo:{address:a.byo.endpoint.address}}:{guard:a.guard,exit:a.exit},
   address:a.kind==='byo'?null:a.exit.address,egressReady:!!a.egress,egress:a.egress?'127.0.0.1:9':null,admit(){},async close(r){this.closed=true;this.emit('down',r);}});started.push(c);return c;}};
 const m=new EnclaveNetworkManager({runtime,admission,providers:async()=>list,byoConfig:async()=>({endpoint:{address:'1.2.3.4',port:51820}}),probe:async()=>{},probeEgress:async()=>{},
  publish:async(app,routes)=>{published.push(routes);},distance,oneHop,now});
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

// Near routes (enclaveNetwork.nearRoutes on the host; network/provider-distance.mjs measures, here a fixed table):
// provider 3 is nearest to the host, then 4, then 1, then 2.
const far=new Map([[prov(1).providerId,160],[prov(2).providerId,186],[prov(3).providerId,25],[prov(4).providerId,85]]);
const pair=c=>[c.guard.address,c.exit.address],Q=Date.now()+86400000,four=()=>[1,2,3,4].map(n=>prov(n,{qualifiedUntil:Q}));
test('near routes: the nearest provider is the guard, the next nearest the exit; the second circuit takes what is left',()=>{
 const o={routes:2,ingress:true,egress:true,maxPricePerGiB6:0};
 assert.deepEqual(selectNetworkCircuits(four(),{...o,distance:far}).map(pair),[['44.0.0.3','44.0.0.4'],['44.0.0.1','44.0.0.2']]);
 // without a table the choice is what it was: price, qualification age, id; the exit first
 assert.deepEqual(selectNetworkCircuits(four(),o).map(pair),[['44.0.0.2','44.0.0.1'],['44.0.0.4','44.0.0.3']]);
 // price still comes first: the nearest provider, when it charges more than another, is not preferred
 const paid=four().map(p=>p.address==='44.0.0.3'?{...p,pricePerGiB6:5}:p);
 assert.deepEqual(selectNetworkCircuits(paid,{...o,maxPricePerGiB6:5,distance:far}).map(pair),[['44.0.0.4','44.0.0.1'],['44.0.0.2','44.0.0.3']]);
 // a provider nobody measured comes after every measured one
 const five=[...four(),prov(5,{qualifiedUntil:Q})];
 assert.deepEqual(selectNetworkCircuits(five,{...o,routes:1,distance:far}).map(pair),[['44.0.0.3','44.0.0.4']]);
 assert.equal(selectNetworkCircuits(five,{...o,routes:3,distance:far}).length,2,'five providers are two circuits');
 // the nearest provider is taken as the guard only if an exit is left for it; one that cannot be an exit is never one
 const guardOnly=[prov(3,{eligibleRoles:['guard']}),prov(4,{eligibleRoles:['guard']}),prov(1)].map(p=>({...p,qualifiedUntil:Q}));
 assert.deepEqual(selectNetworkCircuits(guardOnly,{...o,routes:1,distance:far}).map(pair),[['44.0.0.3','44.0.0.1']]);
 // a circuit that exists stays; a provider cooling down is passed over
 const kept=selectNetworkCircuits(four(),{...o,distance:far,keep:[{guard:prov(1),exit:prov(2)}]}).map(pair);
 assert.deepEqual(kept,[['44.0.0.1','44.0.0.2'],['44.0.0.3','44.0.0.4']]);
 const now=Date.now(),cool=new Map([[prov(3).providerId,now+60000]]);
 assert.deepEqual(selectNetworkCircuits(four(),{...o,routes:1,distance:far,cooldown:cool,now}).map(pair),[['44.0.0.4','44.0.0.1']]);
});
test('near routes: the name lists the near circuit only; the far one stands by and is listed when the near one fails',async()=>{
 let t=Date.now();const r=rig({providers:four(),distance:async()=>far,now:()=>t});
 await r.m.configure([app(defaultNetworkPolicy(id))]);await r.m.reconcile();
 const a=r.m.apps.get(id);assert.deepEqual(a.circuits.map(c=>[c.providers.guard.address,c.providers.exit.address]),[['44.0.0.3','44.0.0.4'],['44.0.0.1','44.0.0.2']]);
 assert.ok(a.circuits.every(c=>c.healthy),'both built and verified');
 assert.deepEqual(r.published.at(-1).map(x=>x.address),['44.0.0.4'],'only the near circuit\'s exit is in the name');
 const st=r.m.status()[0].circuits;
 assert.deepEqual(st.map(c=>[c.rttMs,c.standby]),[[{guard:25,exit:85},false],[{guard:160,exit:186},true]]);
 assert.equal(r.m.status()[0].ready,true);
 // the near circuit goes down: the standby is listed with the withdrawal, not a pass later
 const near=a.circuits[0];await near.close('exit unreachable');await new Promise(setImmediate);
 assert.deepEqual(r.published.at(-1).map(x=>x.address),['44.0.0.2']);assert.equal(r.m.status()[0].circuits[0].standby,false);
 // its provider's cooldown over, the near circuit is built again and the name goes back to it alone
 t+=2*60000;
 await r.m.reconcile();
 const again=r.m.apps.get(id).circuits;assert.equal(again.length,2);
 assert.deepEqual(r.published.at(-1).map(x=>x.address),['44.0.0.4']);
 assert.deepEqual(r.m.status()[0].circuits.filter(c=>c.standby).map(c=>c.address),['44.0.0.2']);
});
test('near routes: circuits about as near as each other are both listed, nearest first; nothing measured is as without',async()=>{
 const close=new Map([[prov(1).providerId,30],[prov(2).providerId,45],[prov(3).providerId,35],[prov(4).providerId,40]]);
 const r=rig({providers:four(),distance:async()=>close});await r.m.configure([app(defaultNetworkPolicy(id))]);await r.m.reconcile();
 // 30+35 and 40+45: the second is within 40 ms of the first
 assert.deepEqual(r.published.at(-1).map(x=>x.address),['44.0.0.3','44.0.0.2']);
 assert.ok(r.m.status()[0].circuits.every(c=>!c.standby));
 for(const distance of [async()=>new Map(),async()=>{throw new Error('no route to any provider');}]){
  const n=rig({providers:four(),distance});await n.m.configure([app(defaultNetworkPolicy(id))]);await n.m.reconcile();
  const cs=n.m.apps.get(id).circuits;
  assert.deepEqual(cs.map(c=>[c.providers.guard.address,c.providers.exit.address]),[['44.0.0.2','44.0.0.1'],['44.0.0.4','44.0.0.3']]);
  assert.equal(n.published.at(-1).length,2);assert.ok(n.m.status()[0].circuits.every(c=>c.rttMs===null&&!c.standby));
 }
 // a circuit with a provider nobody measured counts as far: it stands by behind a measured one
 const part=new Map([...far].filter(([k])=>k!==prov(2).providerId));
 const p=rig({providers:four(),distance:async()=>part});await p.m.configure([app(defaultNetworkPolicy(id))]);await p.m.reconcile();
 assert.deepEqual(p.m.status()[0].circuits.map(c=>c.rttMs),[{guard:25,exit:85},{guard:160,exit:null}]);
 assert.deepEqual(p.published.at(-1).map(x=>x.address),['44.0.0.4']);
});


// One hop (docs/design/enclave-network.md): the owner's guard:false and the operator's opt-in, both or nothing.
const oneHopPolicy=(over={})=>({...defaultNetworkPolicy(id),nonce:1,issuedAt:1,enclaveNetwork:{routes:2,guard:false,maxPricePerGiB6:0,budget6:0,...over}});
test('one hop: each circuit is one provider, never shared; the order is the usual one, nearest first with distances',()=>{
 const plain=selectNetworkCircuits(four(),{routes:2,ingress:true,egress:true,maxPricePerGiB6:0,oneHop:true});
 assert.deepEqual(plain.map(c=>[c.guard,c.exit.address]),[[null,'44.0.0.1'],[null,'44.0.0.2']]);assert.equal(plain.short,null);
 const near=selectNetworkCircuits(four(),{routes:2,ingress:true,egress:true,maxPricePerGiB6:0,oneHop:true,distance:far});
 assert.deepEqual(near.map(c=>[c.guard,c.exit.address]),[[null,'44.0.0.3'],[null,'44.0.0.4']]);
 // a kept circuit's provider is not used again; a guard-only provider is no exit; price and cooldown hold as always
 const kept=selectNetworkCircuits(four(),{routes:2,ingress:true,egress:true,maxPricePerGiB6:0,oneHop:true,distance:far,keep:[{guard:null,exit:prov(3)}]});
 assert.deepEqual(kept.map(c=>c.exit.address),['44.0.0.3','44.0.0.4']);
 const few=[prov(1,{qualifiedUntil:Q,eligibleRoles:['guard']}),prov(2,{qualifiedUntil:Q,pricePerGiB6:5}),prov(3,{qualifiedUntil:Q})];
 const one=selectNetworkCircuits(few,{routes:2,ingress:true,egress:true,maxPricePerGiB6:0,oneHop:true,cooldown:new Map()});
 assert.deepEqual(one.map(c=>c.exit.address),['44.0.0.3']);assert.match(one.short,/^1 of 2 route\(s\)/);
 assert.throws(()=>selectNetworkCircuits(few,{routes:1,ingress:true,egress:true,maxPricePerGiB6:0,oneHop:true,cooldown:new Map([[prov(3).providerId,Date.now()+60000]])}),/one-hop circuit needs 1/);
});
test('one hop needs both choices: the owner\'s guard:false alone, or the operator\'s opt-in alone, builds guarded circuits',async()=>{
 const guarded=a=>a.circuits.length===2&&a.circuits.every(c=>c.providers.guard&&c.providers.guard.address!==c.providers.exit.address);
 const ownerOnly=rig();await ownerOnly.m.configure([app(oneHopPolicy())]);await ownerOnly.m.reconcile();
 assert.ok(guarded(ownerOnly.m.apps.get(id)));assert.equal(ownerOnly.m.status()[0].oneHop,false);assert.equal(ownerOnly.m.status()[0].ready,true);
 const operatorOnly=rig({oneHop:{allows:()=>true}});await operatorOnly.m.configure([app(defaultNetworkPolicy(id))]);await operatorOnly.m.reconcile();
 assert.ok(guarded(operatorOnly.m.apps.get(id)));assert.equal(operatorOnly.m.status()[0].oneHop,true,'the status says what the host allows, not what was built');
 const otherApp=rig({oneHop:{allows:x=>x==='0x'+'cd'.repeat(32)}});await otherApp.m.configure([app(oneHopPolicy())]);await otherApp.m.reconcile();
 assert.ok(guarded(otherApp.m.apps.get(id)));
 // both: no guard asked of the runtime, one provider per circuit, the exits published as always
 const r=rig({oneHop:{allows:x=>x===id}});await r.m.configure([app(oneHopPolicy())]);await r.m.reconcile();
 const a=r.m.apps.get(id);assert.deepEqual(a.circuits.map(c=>[c.providers.guard,c.providers.exit.address]),[[null,'44.0.0.1'],[null,'44.0.0.2']]);
 assert.ok(r.started.every(c=>c.guard===null&&c.kind==='network'&&c.ingress&&c.egress));
 assert.deepEqual(r.published.at(-1).map(x=>x.address).sort(),['44.0.0.1','44.0.0.2']);
 const st=r.m.status()[0];assert.equal(st.oneHop,true);assert.equal(st.ready,true);
 assert.deepEqual(st.circuits.map(c=>[c.guard,c.exit.address]),[[null,'44.0.0.1'],[null,'44.0.0.2']]);
 assert.deepEqual(st.modes,['enclave-network','byo-wireguard'],'one hop is not a mode');
 // the owner signing a guard again rebuilds the app's circuits with guards
 await r.m.configure([app({...oneHopPolicy({guard:true}),nonce:2})]);assert.ok(a.circuits.length===0);await r.m.reconcile();
 assert.ok(guarded(r.m.apps.get(id)));
});
test('one hop with near routes: the name lists the nearest provider alone, the next stands by; a dead exit is struck, not a guard',async()=>{
 let t=Date.now();const r=rig({providers:four(),distance:async()=>far,oneHop:{allows:()=>true},now:()=>t});
 await r.m.configure([app(oneHopPolicy())]);await r.m.reconcile();
 const a=r.m.apps.get(id);assert.deepEqual(a.circuits.map(c=>c.providers.exit.address),['44.0.0.3','44.0.0.4']);
 assert.deepEqual(r.published.at(-1).map(x=>x.address),['44.0.0.3']);
 assert.deepEqual(r.m.status()[0].circuits.map(c=>[c.rttMs,c.standby]),[[{guard:null,exit:25},false],[{guard:null,exit:85},true]]);
 // the tunnel program reports a failure the runtime files under 'guard' for a guarded circuit: here there is only the exit
 a.circuits[0].failureRole='guard';await a.circuits[0].close('exit: handshake timeout');await new Promise(setImmediate);
 assert.deepEqual(r.published.at(-1).map(x=>x.address),['44.0.0.4']);
 assert.ok(r.m.cooldown.get(prov(3).providerId)>t);
 t+=2*60000;await r.m.reconcile();
 assert.deepEqual(r.published.at(-1).map(x=>x.address),['44.0.0.3']);
});
test('one hop: an operator who withdraws the opt-in gets guarded circuits back, and no provider is blamed',async()=>{
 let allowed=true;const r=rig({oneHop:{allows:()=>allowed}});
 await r.m.configure([app(oneHopPolicy({routes:1}))]);await r.m.reconcile();
 const first=r.m.apps.get(id).circuits[0];assert.equal(first.providers.guard,null);
 allowed=false;await r.m.reconcile();
 assert.ok(first.closed);assert.equal(r.m.cooldown.size,0);
 const now=r.m.apps.get(id).circuits;assert.equal(now.length,1);assert.ok(now[0].providers.guard);
 assert.match(r.m.apps.get(id).lastFailure.reason,/one hop is no longer permitted/);
 // and the other way: a guarded circuit does not outlive the choice for one hop either
 allowed=true;await r.m.reconcile();
 assert.ok(now[0].closed);assert.equal(r.m.apps.get(id).circuits[0].providers.guard,null);assert.equal(r.m.cooldown.size,0);
});
test('one hop covers a BYO policy\'s network ingress and its fallback egress; the BYO tunnel is untouched',async()=>{
 const byo={version:5,deploymentId:id,nonce:1,issuedAt:1,mode:'byo-wireguard',fallback:'enclave-network',byo:{configDigest:'cd'.repeat(32),ingress:'enclave-network'},enclaveNetwork:{routes:2,guard:false,maxPricePerGiB6:0,budget6:0}};
 const r=rig({oneHop:{allows:()=>true},byoFails:true});await r.m.configure([app(byo)]);await r.m.reconcile();
 const a=r.m.apps.get(id),net=a.circuits.filter(c=>c.kind==='network');
 assert.equal(net.length,3);assert.ok(net.every(c=>c.providers.guard===null));
 assert.deepEqual(net.map(c=>[!!c.ingress,!!c.egressReady,!!c.fallback]),[[true,false,false],[true,false,false],[false,true,true]]);
 assert.equal(new Set(net.map(c=>c.providers.exit.address)).size,3,'the fallback circuit takes a provider the website circuits do not use');
});
