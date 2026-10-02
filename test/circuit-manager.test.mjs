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
