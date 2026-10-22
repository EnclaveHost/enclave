// Independent review of the network-side wallet hold (work/node-hold-network-review-20261021): false-acknowledgement
// and liveness cases the revision-2 suite does not cover. Exact revision-2 sources; only runtimes/providers are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {once,EventEmitter} from 'node:events';
import {WalletAllowWriter,WalletAllowFile,walletHoldAcknowledged} from '../network/wallet-admission.mjs';
import {EnclaveNetworkManager} from '../network/wg-manager.mjs';
import {PrivacyAgent} from '../network/privacy-agent.mjs';
import {defaultNetworkPolicy} from '../network/network-policy-core.mjs';

const tick=()=>new Promise(r=>setImmediate(r));
const prov=n=>({providerId:String(n).repeat(32).slice(0,32),address:`44.0.0.${n}`,wgExitKey:'x'+n,wgGuardKey:'g'+n,ports:{exit:51820,guard:51821,control:51822},
 region:'r'+n,kind:'enclave',pricePerGiB6:0,eligibleRoles:['guard','ingress','egress'],qualifiedUntil:Date.now()+600000});
const one=id=>({...defaultNetworkPolicy(id),enclaveNetwork:{routes:1,guard:true,maxPricePerGiB6:0,budget6:0}});
const appOf=(id,policy)=>({deploymentId:id,names:[id.slice(2,10)+'.app.enclave.host'],policy,isPublic:true});

// A manager over a fake runtime whose start() waits for the test; `held` ids are refused like a wallet hold.
function managerRig(ids){
 const held=new Set(),circuits=[],waiting=[];
 const admission={allows:id=>!held.has(id),leases:new Map(ids.map(id=>[id,{validUntil:Date.now()+600000}])),proofs:new Map(ids.map(id=>[id,{validUntil:Date.now()+600000}]))};
 const runtime={start:a=>new Promise(resolve=>waiting.push({a,go:()=>{
  const c=new EventEmitter();Object.assign(c,{...a,id:'c'+circuits.length,closed:false,providers:{guard:a.guard,exit:a.exit},address:a.exit.address,egressReady:!!a.egress,
   egress:a.egress?'127.0.0.1:9':null,admits:[],admit(e){this.admits.push(e);},async close(r){this.closed=true;this.emit('down',r);}});
  circuits.push(c);resolve(c);}}))};
 const m=new EnclaveNetworkManager({runtime,admission,providers:async()=>[1,2,3,4].map(prov),probe:async()=>{},probeEgress:async()=>{},publish:async()=>{}});
 return {m,held,circuits,waiting,async started(n=1){while(waiting.length<n)await tick();}};
}

test('R1 a circuit whose allocation finishes after its app was replaced is never left running past an acknowledged hold',async()=>{
 const id='0x'+'ab'.repeat(32),r=managerRig([id]);
 await r.m.configure([appOf(id,one(id))]);
 const run=r.m.reconcile();await r.started();
 // the owner's policy changes while runtime.start is in flight: configure() replaces the app object
 await r.m.configure([appOf(id,{...one(id),nonce:1,issuedAt:1})]);
 r.waiting.shift().go();await run;for(let i=0;i<5;i++)await tick();
 // wallet hold of this deployment
 r.held.add(id);r.m.enforceAdmission();for(let i=0;i<5;i++)await tick();
 const live=r.circuits.filter(c=>!c.closed);
 assert.ok(!(r.m.admissionSettled()&&live.length),`acknowledgeable while ${live.length} circuit(s) still run (admitted ${JSON.stringify(live.map(c=>c.admits))}, never 0)`);
 assert.equal(live.length,0,'the late circuit is retired, not orphaned');
});

test('R1b the same race when the app is removed from the configuration entirely',async()=>{
 const id='0x'+'ac'.repeat(32),r=managerRig([id]);
 await r.m.configure([appOf(id,one(id))]);
 const run=r.m.reconcile();await r.started();
 await r.m.configure([]);
 r.waiting.shift().go();await run;for(let i=0;i<5;i++)await tick();
 r.held.add(id);r.m.enforceAdmission();for(let i=0;i<5;i++)await tick();
 const live=r.circuits.filter(c=>!c.closed);
 assert.ok(!(r.m.admissionSettled()&&live.length),'acknowledgeable while an orphaned circuit runs');
 assert.equal(live.length,0);
});

test('R3 a held app with nothing left is acknowledged while an unrelated allowed app is still allocating',async()=>{
 const a='0x'+'a1'.repeat(32),b='0x'+'b2'.repeat(32),r=managerRig([a,b]);
 await r.m.configure([appOf(a,one(a)),appOf(b,one(b))]);
 // b's allocation hangs (a slow provider: outer-ready/ready timeouts are 45 s each; grants, probes, publication follow)
 const run=r.m.reconcile();await r.started(2);
 r.waiting.find(w=>w.a.deploymentId===a).go();
 while(!r.m.apps.get(a).circuits.length||r.m.reconciling.has(a))await tick();
 r.held.add(a);r.m.enforceAdmission();for(let i=0;i<5;i++)await tick();
 assert.equal(r.circuits.filter(c=>c.deploymentId===a&&!c.closed).length,0,'a is fully withdrawn');
 assert.equal(r.m.admissionSettled(),true,'b\'s unrelated allocation must not withhold a\'s acknowledgement');
 // but an allocation of the held app itself still blocks, and so does a retiring circuit of it
 r.held.add(b);r.m.enforceAdmission();assert.equal(r.m.admissionSettled(),false,'b held with its allocation in flight');
 r.waiting.find(w=>w.a.deploymentId===b).go();await run;for(let i=0;i<5;i++)await tick();
 // b's late circuit was adopted with admit(0) and is still listed: no acknowledgement until the next enforcement tick
 assert.ok(r.circuits.filter(c=>c.deploymentId===b).every(c=>c.admits.at(-1)===0));assert.equal(r.m.admissionSettled(),false);
 r.m.enforceAdmission();for(let i=0;i<5;i++)await tick();
 assert.equal(r.circuits.filter(c=>!c.closed).length,0);assert.equal(r.m.admissionSettled(),true);
});

test('R3b a failed close of a held app still blocks; a failed close of another app does not block forever',async()=>{
 const a='0x'+'a3'.repeat(32),b='0x'+'b4'.repeat(32),r=managerRig([a,b]);
 await r.m.configure([appOf(a,one(a)),appOf(b,one(b))]);
 const stuck=id=>({id:'stuck-'+id.slice(2,6),deploymentId:id,providers:{},admit(){},on(){},close:async()=>{throw Error('child still alive');}});
 r.m.apps.get(b).circuits.push(stuck(b));r.held.add(b);r.m.enforceAdmission();for(let i=0;i<5;i++)await tick();
 assert.equal(r.m.admissionSettled(),false,'held b with a failed close');
 r.held.delete(b);r.held.add(a);r.m.enforceAdmission();for(let i=0;i<5;i++)await tick();
 assert.equal(r.m.admissionSettled(),true,'a (nothing running) is not blocked by b\'s old failed close while b is allowed again');
});

// Local app-to-app routing (local-app-router.mjs): app A's egress front hands a connection for B's website to B here.
async function twoApps(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hold-review-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let time=1000000;const now=()=>time,file=path.join(dir,'allows.json'),runner='0x'+'1'.repeat(64);
 const A='0x'+'2'.repeat(64),B='0x'+'6'.repeat(64),ref='catalog://0x'+'3'.repeat(64)+'/1';
 const expected={appRef:ref,configCid:'bafy-config',appSha256:'4'.repeat(64),runtimeId:'runtime'};
 const writer=new WalletAllowWriter({file,runner,now}),reader=new WalletAllowFile({file,runner,now});
 const guests=new Set(),guest=net.createServer(s=>{guests.add(s);s.on('error',()=>{});s.on('close',()=>guests.delete(s));s.pipe(s);});
 guest.listen(0,'127.0.0.1');await once(guest,'listening');
 // B's guest: an echo server; forward() is the host ingress forwarder's contract (local-app-transport.mjs)
 const forward=async(socket,id)=>{const up=net.connect({host:'127.0.0.1',port:guest.address().port});const close=()=>{socket.destroy();up.destroy();};
  up.on('error',close);socket.on('error',close);up.once('close',close);socket.once('close',close);socket.pipe(up).pipe(socket);socket.resume();};
 const agent=new PrivacyAgent({apps:[A,B].map(deploymentId=>({deploymentId,expected})),runner,wallet:reader,directory:path.join(dir,'agent'),dns:['1.1.1.1'],now,
  leaseReader:{get:()=>null},network:{runtime:{forward},providers:async()=>[]}});
 t.after(async()=>{agent.router?.close();for(const s of guests)s.destroy();await new Promise(r=>guest.close(r));});
 for(const id of [A,B]){
  agent.admission.observeLease({id,runner,owner:'0x'+'5'.repeat(40),...expected,active:true,isPublic:true,validUntil:time+90000,leaseUntil:time+90000});
  agent.admission.proofs.set(id,{deploymentId:id,appSha256:expected.appSha256,runtimeId:expected.runtimeId,validUntil:time+60000});
  writer.allow(id,{appRef:ref,configCid:expected.configCid,validUntil:time+60000});
 }
 await agent.manager.configure([A,B].map(id=>({...appOf(id,defaultNetworkPolicy(id))})));
 // A has one healthy egress circuit (its upstream is never used for a local route)
 agent.manager.apps.get(A).circuits.push({id:'a-egress',kind:'network',healthy:true,closed:false,egress:'127.0.0.1:9',providers:{},admit(){},on(){},close:async()=>{}});
 await agent.snapshot();
 const status=()=>JSON.parse(fs.readFileSync(path.join(dir,'agent','status.json'),'utf8'));
 const egress=()=>JSON.parse(fs.readFileSync(path.join(dir,'agent','egress-routes.json'),'utf8'));
 return {agent,writer,reader,runner,A,B,now,status,egress};
}
async function localStream(front,name){
 const [host,port]=[front.slice(0,front.lastIndexOf(':')),+front.slice(front.lastIndexOf(':')+1)];
 const c=net.connect({host,port});c.on('error',()=>{});await once(c,'connect');
 let reply=once(c,'data');c.write(Buffer.from([5,1,0]));assert.deepEqual((await reply)[0],Buffer.from([5,0]));
 reply=once(c,'data');c.write(Buffer.concat([Buffer.from([5,1,0,3,name.length]),Buffer.from(name),Buffer.from([1,187])]));assert.equal((await reply)[0][1],0);
 reply=once(c,'data');c.write('before-hold');assert.equal((await reply)[0].toString(),'before-hold');
 return c;
}

test('R2 a held app\'s established local-route ingress (from another app on this host) ends before the hold is acknowledged',{timeout:5000},async t=>{
 const f=await twoApps(t);
 const front=f.egress().apps[f.A].proxies[0];assert.match(front,/^127\.0\.0\.1:\d+$/);
 const c=await localStream(front,f.B.slice(2,10)+'.app.enclave.host');
 let closed=false;c.once('close',()=>{closed=true;});
 const hold=f.writer.hold(f.B);await f.agent.admit();await tick();await f.agent.admit();
 const acked=walletHoldAcknowledged({status:f.status(),runner:f.runner,id:f.B,hold,now:f.now()});
 let echoed=false;if(!closed){c.on('data',()=>{echoed=true;});c.write('after-hold');await new Promise(r=>setTimeout(r,200));}
 assert.ok(!(acked&&!closed),`hold acknowledged (${acked}) while the stream into the held app is open${echoed?' and still echoes':''}`);
 assert.equal(closed,true);
});

test('R2b the caller\'s own hold still closes its local-route streams (unchanged behaviour)',{timeout:5000},async t=>{
 const f=await twoApps(t);
 const c=await localStream(f.egress().apps[f.A].proxies[0],f.B.slice(2,10)+'.app.enclave.host');
 const closed=once(c,'close');const hold=f.writer.hold(f.A);await f.agent.admit();await closed;await tick();await f.agent.admit();
 assert.equal(walletHoldAcknowledged({status:f.status(),runner:f.runner,id:f.A,hold,now:f.now()}),true);
});
