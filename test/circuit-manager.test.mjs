import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';
import {CircuitManager} from '../network/circuit-manager.mjs';
const id='0x'+'ab'.repeat(32);
const policy={version:2,deploymentId:id,mode:'guarded',directFallback:false,routes:2,maxPrice:'0.0002',budgetNkn:'1',diversity:'beneficiary-and-network'};
const nodes=Array.from({length:10},(_,i)=>({identity:(i+1).toString(16).padStart(64,'0'),address:`8.2.1.${i+1}`,price:'0.0002',beneficiary:`wallet${i}`,asn:100+i,services:['reverse','socksproxy'],expiresAt:Date.now()+60000}));
function fixture(){
 const publications=[],started=[];let allowed=true,probeFails=false;
 const wallets=Array.from({length:2},(_,slot)=>Object.fromEntries(['guard','public','egress'].map(role=>[role,{address:slot+role,fundedNkn:'0.1'}])));
 const admission={allows:()=>allowed,leases:new Map([[id,{validUntil:Date.now()+60000}]]),proofs:new Map([[id,{validUntil:Date.now()+60000}]])};
 const manager=new CircuitManager({admission,inventory:async()=>nodes,wallets:async()=>wallets,probe:async()=>{if(probeFails)throw Error('bad attestation')},publish:async(id,routes)=>publications.push({id,routes}),runtime:{start:async args=>{
  const c=new EventEmitter();Object.assign(c,{...args,id:String(started.length).padStart(32,'0'),providers:args.providers,address:args.providers.public.address,port:443,closed:false,admit(n){this.admitted=n},async close(reason){this.closed=true;this.emit('down',reason)}});started.push(c);return c;
 }}});
 return {manager,publications,started,wallets,setAllowed:v=>allowed=v,setProbeFails:v=>probeFails=v};
}
test('guard loss withdraws only its route and keeps its independent sibling',async()=>{
 const f=fixture();await f.manager.configure([{policy,names:['app.example']}]);await f.manager.reconcile();
 assert.equal(f.manager.status()[0].ready,true);assert.equal(f.started.length,2);
 const [first,second]=f.started;await f.manager.fail(f.manager.apps.get(id),first,'guard failed');
 assert.equal(first.admitted,0);assert.equal(first.closed,true);assert.equal(second.closed,false);
 assert.equal(f.publications.at(-1).routes.length,1);assert.equal(f.publications.at(-1).routes[0].circuit,second.id);
 await f.manager.reconcile();assert.equal(f.manager.status()[0].ready,true);assert.equal(second.closed,false);
 await f.manager.close();
});
test('TLS attestation failure never publishes an allocated endpoint',async()=>{
 const f=fixture();f.setProbeFails(true);await f.manager.configure([{policy,names:['app.example']}]);await f.manager.reconcile();
 assert.equal(f.manager.status()[0].ready,false);assert.ok(f.started.every(c=>c.closed));assert.ok(f.publications.every(p=>p.routes.length===0));
 await f.manager.close();
});
test('authorization expiry cuts live sockets and reused or overfunded identities are refused',async()=>{
 const f=fixture();await f.manager.configure([{policy,names:['app.example']}]);await f.manager.reconcile();
 f.setAllowed(false);f.manager.enforceAdmission();await new Promise(r=>setImmediate(r));
 assert.ok(f.started.every(c=>c.closed&&c.admitted===0));assert.equal(f.publications.at(-1).routes.length,0);
 f.wallets[0].guard.fundedNkn='1';await assert.rejects(f.manager.configure([{policy,names:['app.example']}]),/exceed app budget/);
 f.wallets[0].guard.fundedNkn='0.1';f.wallets[1].guard.address=f.wallets[0].guard.address;
 await assert.rejects(f.manager.configure([{policy,names:['app.example']}]),/identity reused/);
 await f.manager.close();
});

test('delayed publications cannot restore a route withdrawn while the write was in flight',async()=>{
 const f=fixture();let unblock,entered;
 const started=new Promise(r=>{entered=r}),gate=new Promise(r=>{unblock=r});
 const original=f.manager.publish;let first=true;
 f.manager.publish=async(id,routes)=>{if(first){first=false;entered();await gate;}await original(id,routes);};
 await f.manager.configure([{policy,names:['app.example']}]);const reconciling=f.manager.reconcile();await started;
 const dead=f.started[0],failing=f.manager.fail(f.manager.apps.get(id),dead,'guard failed during publication');
 unblock();await Promise.all([reconciling,failing]);
 assert.ok(f.publications.at(-1).routes.every(r=>r.circuit!==dead.id));assert.equal(dead.closed,true);
 await f.manager.close();
});

test('a stuck app allocation does not block other apps or reserve the same public port',async()=>{
 const f=fixture(),other='0x'+'cd'.repeat(32),until=Date.now()+60000;
 f.manager.admission.leases.set(other,{validUntil:until});f.manager.admission.proofs.set(other,{validUntil:until});
 f.manager.wallets=async app=>f.wallets.map(slot=>Object.fromEntries(Object.entries(slot).map(([role,w])=>[role,{...w,address:app+w.address}])));
 let unblock,entered;const blocked=new Promise(r=>unblock=r),started=new Promise(r=>entered=r);
 const original=f.manager.runtime.start,attempts=[];
 f.manager.runtime.start=async args=>{attempts.push(args);if(args.deploymentId===id){entered();await blocked;}return original(args);};
 await f.manager.configure([{policy,names:['one.example']},{policy:{...policy,deploymentId:other},names:['two.example']}]);
 const working=f.manager.reconcile();await started;
 try{
  for(let i=0;i<30&&!f.manager.status().find(a=>a.deploymentId===other).ready;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(f.manager.status().find(a=>a.deploymentId===other).ready,true);
  await f.manager.reconcile();assert.equal(attempts.filter(a=>a.deploymentId===id).length,1);
  assert.ok(attempts.filter(a=>a.deploymentId===other).every(a=>a.providers.public.address!==attempts[0].providers.public.address));
 }finally{unblock();await working;await f.manager.close();}
});

test('shutdown cancels allocations that have not become publishable circuits',async()=>{
 const f=fixture();let started,rejectAllocation;const entered=new Promise(r=>started=r);
 f.manager.runtime.start=async()=>{started();return new Promise((_r,j)=>rejectAllocation=j);};
 f.manager.runtime.close=async()=>rejectAllocation(new Error('runtime stopped'));
 await f.manager.configure([{policy,names:['app.example']}]);const pending=f.manager.reconcile();await entered;
 await f.manager.close();await pending;assert.ok(f.publications.every(p=>p.routes.length===0));
});
test('invalid app names are rejected before any allocation or spending',async()=>{
 const f=fixture();await assert.rejects(f.manager.configure([{policy,names:['a'.repeat(64)+'.app.example']}]),/hostnames/);assert.equal(f.started.length,0);
});
test('repairing one circuit does not delay its sibling health checks',async()=>{
 const f=fixture();let started,rejectAllocation;const entered=new Promise(r=>started=r);const original=f.manager.runtime.start;
 let calls=0;f.manager.runtime.start=async args=>{if(calls++===0)return original(args);started();return new Promise((_r,j)=>rejectAllocation=j);};
 await f.manager.configure([{policy,names:['app.example']}]);const pending=f.manager.reconcile();await entered;
 f.started[0].checkedAt=0;f.setProbeFails(true);await f.manager.reconcile();
 for(let i=0;i<10&&!f.started[0].closed;i++)await new Promise(r=>setImmediate(r));
 assert.equal(f.started[0].closed,true);assert.equal(f.publications.at(-1).routes.length,0);
 rejectAllocation(new Error('test repair ended'));await pending;await f.manager.close();
});
test('a public allocation failure is charged to the guard that carried it, and a success credits it',async()=>{
 const observed=[];let failNext=true;
 const wallets=Array.from({length:2},(_,slot)=>Object.fromEntries(['guard','public','egress'].map(role=>[role,{address:'c'+slot+role,fundedNkn:'0.1'}])));
 const admission={allows:()=>true,leases:new Map([[id,{validUntil:Date.now()+60000}]]),proofs:new Map([[id,{validUntil:Date.now()+60000}]])};
 const manager=new CircuitManager({admission,inventory:async()=>nodes,wallets:async()=>wallets,probe:async()=>{},publish:async()=>{},
  observe:async(providers,result)=>{observed.push({roles:Object.keys(providers).filter(r=>!result.role||r===result.role),ok:result.ok,guard:providers.carry?.identity||providers.guard?.identity});},
  runtime:{start:async args=>{
   if(failNext){failNext=false;const e=new Error('https provider allocation timeout');e.providerRole='public';throw e;}
   const c=new EventEmitter();Object.assign(c,{...args,id:'x'.repeat(32),providers:args.providers,address:args.providers.public.address,port:443,closed:false,admit(){},async close(){this.closed=true}});return c;
  }}});
 await manager.configure([{policy,names:['app.example']}]);await manager.reconcile();await new Promise(r=>setImmediate(r));
 const failures=observed.filter(o=>!o.ok),successes=observed.filter(o=>o.ok);
 assert.deepEqual(failures.map(o=>o.roles.join()).sort(),['carry','public']);
 assert.ok(successes.length>0&&successes.every(o=>o.roles.includes('carry')&&o.roles.includes('guard')));
 await manager.close();
});
test('a route survives two transient probe failures, is withdrawn on the third, and a mismatch fails it at once',async()=>{
 const f=fixture();let failure=null;f.manager.probe=async()=>{if(failure)throw failure;};
 await f.manager.configure([{policy,names:['app.example']}]);await f.manager.reconcile();
 const [first,second]=f.started;assert.equal(f.manager.status()[0].ready,true);
 const settle=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));};
 failure=new Error('TLS handshake timeout');
 for(const n of [1,2]){first.checkedAt=0;second.checkedAt=Date.now();await f.manager.checkHealth(f.manager.apps.get(id),nodes);await settle();
  assert.equal(first.closed,false,`still serving after ${n} transient failure(s)`);assert.equal(first.probeFailures,n);}
 first.checkedAt=0;await f.manager.checkHealth(f.manager.apps.get(id),nodes);await settle();assert.equal(first.closed,true);
 // A success resets the count; a mismatch does not get retries.
 second.checkedAt=0;failure=null;await f.manager.checkHealth(f.manager.apps.get(id),nodes);assert.equal(second.probeFailures,0);
 second.checkedAt=0;failure=new Error('app, nonce or TLS binding mismatch');await f.manager.checkHealth(f.manager.apps.get(id),nodes);await settle();
 assert.equal(second.closed,true);
 await f.manager.close();
});
