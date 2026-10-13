// The Enclave-network provider's decisions (network/wg-provider/provider.mjs): who gets a peer, in which role.
import test from 'node:test';import assert from 'node:assert/strict';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {WgProvider,peerRequestMessage,grantMessage} from '../network/wg-provider/provider.mjs';
import {signNetworkPolicy} from '../network/network-policy.mjs';
import {recoverMessageAddress} from 'viem';
import {randomBytes} from 'node:crypto';

const id='0x'+'ab'.repeat(32),other='0x'+'cd'.repeat(32),runner='0x'+'11'.repeat(32);
const operator=privateKeyToAccount(generatePrivateKey()),stranger=privateKeyToAccount(generatePrivateKey()),owner=privateKeyToAccount(generatePrivateKey());
const providerKey=privateKeyToAccount(generatePrivateKey()),checker=privateKeyToAccount(generatePrivateKey());
const wgKey=()=>randomBytes(32).toString('base64');
function rig({roles=['guard','ingress','egress'],price=0,lease={},published=null,host={active:true,operator:null}}={}){
 let now=1_000_000_000;const kernel={peers:new Map(),synced:null,setPeer:async p=>kernel.peers.set(p.key,{...p}),removePeer:async p=>kernel.peers.delete(p.key),sync:async s=>{kernel.synced=s;},
  listPeers:async iface=>[...kernel.peers.values()].filter(p=>(p.role==='guard'?'wg-guard':'wg-exit')===iface).map(p=>p.key)};
 const leases=new Map([[id,{active:true,runner,runnerOperator:operator.address,owner:owner.address,isPublic:true,validUntil:now+60000,leaseUntil:now+3600000,...lease}]]);
 const seen=new Map();
 const p=new WgProvider({config:{providerId:'aa'.repeat(16),roles,pricePerGiB6:price,publicAddress:'134.199.235.187',exitKey:wgKey(),guardKey:wgKey(),ports:{exit:51820,guard:51821,control:51822},checkers:[checker.address]},
  signer:providerKey,kernel,leases:async x=>leases.get(x)||null,hosts:async x=>x===runner?{...host,operator:(host.operator||operator.address).toLowerCase()}:null,policyMemory:{get:async k=>seen.get(k),set:async(k,v)=>seen.set(k,v)},
  currentPolicy:async()=>published,domains:async x=>x===id?['www.example.org']:[],now:()=>now});
 return {p,kernel,leases,advance:ms=>{now+=ms;},now:()=>now};
}
async function request(r,over={},signer=operator){
 const req={version:1,providerId:'aa'.repeat(16),role:'exit',deploymentId:id,runner,wgPublicKey:wgKey(),policy:null,ingress:true,egress:true,issuedAt:r.now(),nonce:randomBytes(16).toString('hex'),expiresAt:r.now()+600000,...over};
 return {request:req,signature:await signer.signMessage({message:peerRequestMessage(req)})};
}

test('the current runner gets a signed exit grant; ingress names are the app label and its verified domains',async()=>{
 const r=rig();const env=await request(r);
 const {grant,signature}=await r.p.handle(env);
 assert.equal(await recoverMessageAddress({message:grantMessage(grant),signature}),providerKey.address);
 assert.deepEqual(grant.names,['abababab.app.enclave.host','www.example.org']);
 assert.equal(grant.endpoint,'134.199.235.187:51820');assert.match(grant.clientAddress,/^10\.77\./);
 assert.equal(r.p.route('WWW.example.org'),grant.clientAddress);assert.equal(r.p.route('other.example'),null);
 assert.deepEqual(r.kernel.synced.egress,[grant.clientAddress]);
 // renewal with the same key keeps the address
 const again=await r.p.handle(await request(r,{wgPublicKey:env.request.wgPublicKey}));assert.equal(again.grant.clientAddress,grant.clientAddress);
});
test('anyone but the current runner, a replay, a stale request or an inactive lease is refused',async()=>{
 const r=rig();
 await assert.rejects(r.p.handle(await request(r,{},stranger)),/current runner/);
 const env=await request(r);await r.p.handle(env);await assert.rejects(r.p.handle(env),/replayed/);
 await assert.rejects(r.p.handle(await request(r,{issuedAt:r.now()-120000})),/stale/);
 await assert.rejects(r.p.handle(await request(r,{deploymentId:other})),/current runner/);
 await assert.rejects(r.p.handle(await request(r,{providerId:'bb'.repeat(16)})),/another provider/);
 const tampered=await request(r);tampered.request.egress=false;await assert.rejects(r.p.handle(tampered),/current runner/);
 const off=rig({lease:{active:false}});await assert.rejects(off.p.handle(await request(off)),/current runner/);
 const priv=rig({lease:{isPublic:false}});await assert.rejects(priv.p.handle(await request(priv)),/public apps/);
 await priv.p.handle(await request(priv,{ingress:false}));                                  // a private app may still use egress
});
test('the owner\'s policy decides: BYO without network ingress gets no exit; prices above the limit are refused',async()=>{
 const byo=await signNetworkPolicy(owner,{version:5,deploymentId:id,nonce:2,issuedAt:1,mode:'byo-wireguard',fallback:'none',byo:{configDigest:'cd'.repeat(32),ingress:'none'}});
 const r=rig({published:byo});
 await assert.rejects(r.p.handle(await request(r)),/does not use the Enclave network/);
 await assert.rejects(r.p.handle(await request(r,{role:'guard',ingress:false,egress:false})),/does not use/);
 const byoIngress=await signNetworkPolicy(owner,{version:5,deploymentId:id,nonce:3,issuedAt:1,mode:'byo-wireguard',fallback:'none',byo:{configDigest:'cd'.repeat(32),ingress:'enclave-network'},enclaveNetwork:{routes:2,guard:true,maxPricePerGiB6:0,budget6:0}});
 const r2=rig({published:byoIngress});
 await assert.rejects(r2.p.handle(await request(r2)),/Enclave-network egress/);           // ingress yes, egress no
 await r2.p.handle(await request(r2,{egress:false}));
 // a runner sending an older policy than the relay publishes is refused; "no policy" after one exists too
 await assert.rejects(r2.p.handle(await request(r2,{egress:false,policy:byo})),/stale/);
 const r3=rig();await r3.p.handle(await request(r3,{policy:byoIngress,egress:false}));
 await assert.rejects(r3.p.handle(await request(r3,{egress:false})),/unavailable/);
 const paid=rig({price:5});await assert.rejects(paid.p.handle(await request(paid)),/above the policy/);
 const forged=await signNetworkPolicy(stranger,{...byoIngress.policy,nonce:9});
 await assert.rejects(rig().p.handle(await request(rig(),{policy:forged})),/owner signature/);
});
test('roles: a guard carries nothing itself; a provider only grants roles it offers',async()=>{
 const r=rig({roles:['guard']});
 const g=await r.p.handle(await request(r,{role:'guard',ingress:false,egress:false}));assert.match(g.grant.clientAddress,/^10\.78\./);assert.equal(g.grant.endpoint,'134.199.235.187:51821');
 await assert.rejects(r.p.handle(await request(r)),/does not offer/);
 await assert.rejects(r.p.handle(await request(r,{role:'guard',egress:true,ingress:false})),/invalid|carries no/);
});
test('at most two peers per app and role (handover); expiry and a lost lease remove peers',async()=>{
 const r=rig();const a=await r.p.handle(await request(r));r.advance(1000);const b=await r.p.handle(await request(r));r.advance(1000);const c=await r.p.handle(await request(r));
 assert.equal([...r.p.peers.values()].filter(p=>p.role==='exit').length,2);assert.ok(!r.kernel.peers.has(a.grant.clientPublicKey));
 assert.equal(r.p.route('abababab.app.enclave.host'),c.grant.clientAddress,'the newest peer holds the name');
 r.leases.set(id,{...r.leases.get(id),runner:'0x'+'22'.repeat(32)});await r.p.sweep();assert.equal(r.p.peers.size,0);assert.equal(r.kernel.peers.size,0);
 const r2=rig();await r2.p.handle(await request(r2));r2.advance(600001);await r2.p.sweep();assert.equal(r2.p.peers.size,0);
});
test('a trusted checker gets a short probe peer; the provider operator and strangers do not',async()=>{
 const r=rig();const zero='0x'+'0'.repeat(64);
 const ok=await r.p.handle(await request(r,{role:'probe',runner:zero,deploymentId:zero},checker));
 assert.match(ok.grant.names[0],/^probe-[0-9a-f]{32}\.probe\.enclave\.host$/);assert.equal(r.p.route(ok.grant.names[0]),ok.grant.clientAddress);
 assert.ok(ok.grant.expiresAt-r.now()<=300000);
 await assert.rejects(r.p.handle(await request(r,{role:'probe',runner:zero,deploymentId:zero},stranger)),/trusted checker/);
 await assert.rejects(r.p.handle(await request(r,{role:'probe',runner:zero,deploymentId:zero},providerKey)),/trusted checker/);
});
test('over the transfer budget nothing new is accepted',async()=>{const r=rig();r.p.accepting=false;await assert.rejects(r.p.handle(await request(r)),/not accepting/);});

test('a registered host gets egress-only control peers for its own traffic; nobody else does',async()=>{
 const zero='0x'+'0'.repeat(64);
 const r=rig();
 const c=await r.p.handle(await request(r,{role:'control',deploymentId:zero,ingress:false,egress:true}));
 assert.equal(c.grant.role,'control');assert.match(c.grant.clientAddress,/^10\.77\./);assert.deepEqual(c.grant.names,[]);
 assert.ok(r.kernel.synced.egress.includes(c.grant.clientAddress));
 const g=await r.p.handle(await request(r,{role:'guard',deploymentId:zero,ingress:false,egress:false}));assert.match(g.grant.clientAddress,/^10\.78\./);
 await assert.rejects(r.p.handle(await request(r,{role:'control',deploymentId:zero,ingress:true,egress:true})),/egress-only/);
 await assert.rejects(r.p.handle(await request(r,{role:'exit',deploymentId:zero,ingress:false,egress:true})),/only guard and control/);
 await assert.rejects(r.p.handle(await request(r,{role:'control',deploymentId:zero,ingress:false,egress:true},stranger)),/active registered host/);
 await assert.rejects(r.p.handle(await request(r,{role:'control',deploymentId:zero,ingress:false,egress:true,runner:'0x'+'99'.repeat(32)})),/active registered host/);
 const off=rig({host:{active:false}});await assert.rejects(off.p.handle(await request(off,{role:'control',deploymentId:zero,ingress:false,egress:true})),/active registered host/);
 // at most two per host and role; a host that leaves the registry loses them
 await r.p.handle(await request(r,{role:'control',deploymentId:zero,ingress:false,egress:true}));await r.p.handle(await request(r,{role:'control',deploymentId:zero,ingress:false,egress:true}));
 assert.equal([...r.p.peers.values()].filter(p=>p.role==='control').length,2);
 r.p.hosts=async()=>({active:false});await r.p.sweep();assert.equal([...r.p.peers.values()].filter(p=>p.control).length,0);
});

test('a restarted provider restores its peers at the same addresses (a renewal keeps working)',async()=>{
 let saved=null;const store={load:async()=>saved,save:async v=>{saved=structuredClone(v);}};
 const r=rig();r.p.store=store;const env=await request(r);const first=await r.p.handle(env);
 assert.ok(saved.peers.length===1);
 const again=rig();again.p.store=store;again.kernel.peers.set('orphan',{key:'orphan',role:'exit',address:'10.77.9.9'});
 assert.equal(await again.p.restore(),1);assert.ok(!again.kernel.peers.has('orphan'),'a kernel peer the table does not hold is removed');
 assert.ok(again.kernel.peers.has(env.request.wgPublicKey),'the kernel gets the peer back');
 assert.equal(again.p.route('abababab.app.enclave.host'),first.grant.clientAddress,'names route again at once');
 const renewed=await again.p.handle(await request(again,{wgPublicKey:env.request.wgPublicKey}));
 assert.equal(renewed.grant.clientAddress,first.grant.clientAddress);
 const fresh=await again.p.handle(await request(again));assert.notEqual(fresh.grant.clientAddress,first.grant.clientAddress,'no address handed out twice');
});
test('a lease read that fails keeps the peer (only a definite answer removes it); a renewal says so to the lease source',async()=>{
 const r=rig();const env=await request(r);const {grant}=await r.p.handle(env);
 const seen=[];r.p.leases=async(id,o={})=>{seen.push(o.renewal===true);throw new Error('no fresh agreeing chain quorum');};
 await r.p.sweep();assert.equal(r.p.peers.size,1,'a failed read is not "lease ended"');assert.ok(r.kernel.peers.has(env.request.wgPublicKey));
 // a renewal of the held key asks for the renewal fallback; a new key does not
 await assert.rejects(r.p.handle(await request(r,{wgPublicKey:env.request.wgPublicKey})),/quorum/);
 await assert.rejects(r.p.handle(await request(r)),/quorum/);
 assert.deepEqual(seen.slice(-2),[true,false]);
 // a definite answer (the lease ended) still removes it at once
 r.p.leases=async()=>null;await r.p.sweep();assert.equal(r.p.peers.size,0);assert.ok(grant.clientAddress);
});
