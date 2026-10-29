// Actual locally deployed schema3 ledger/library/controller/prover + generated adapter + composer/dispatch/runner/journal.
// Runtime/manager, host interface, recursive dependencies, source-ledger quiescence and finality authority are TEST fixtures.
// This does NOT establish real Host isolation, positive Base authority, canonical host-registry Offline or production migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {useAnvil,step,mine,warp,HOST,chainNow} from './fixtures/r5-world.mjs';
import {world3,emergency3,reconcile3} from './fixtures/schema3-world.mjs';
import {composeIndependentLifecycle} from '../network/lifecycle-host-authority.mjs';
import {openLifecycleJournal} from '../network/deployment-lifecycle-journal.mjs';
import {fixture,route,H,PLATFORM} from './helpers/host-fixture.mjs';
useAnvil();
async function setup(t) {
 const w=await world3({payout:'owner'});await step(w,'queued','TEST initial enrollment');await mine();
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'schema3-composed-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const f=fixture({hostId:HOST,state:'queued',now:chainNow});f.V.ledger=w.contracts.legacyLedger.toLowerCase();
 f.S.staged={ready:true,ended:false,instance:'TEST-i'};f.S.health={ready:true,ended:false,instance:'TEST-i'};
 const routes=[route(w.id,{oldLedger:f.V.ledger,newLedger:w.contracts.ledger.toLowerCase(),controller:w.contracts.lifecycle.toLowerCase(),
  lifecycleSchema:3,profile:'independent-schema3-r1',bundleSha256:w.adapter().bundleSha256,
  ledgerCodeHash:w.pins.contracts.ledger.codeHash,controllerCodeHash:w.pins.contracts.lifecycle.codeHash})];
 const file=path.join(dir,'journal.json');
 async function compose(){
  const journal=openLifecycleJournal(file),c=composeIndependentLifecycle({adapter:w.adapter(),adapterPins:w.pins,
   runtime:f.runtime,journal,inventory:f.inventory,routes,platformWallets:[PLATFORM],capacityHeadroom:0,
   verifyQuiescence:f.verifyQuiescence,now:chainNow});
  c.dispatch.attach(f.hostView(HOST));await c.dispatch.activate();return {c,journal};
 }
 return {w,f,file,compose,...await compose()};
}
async function until(dispatch,id,wanted){
 let last;
 for(let i=0;i<6;i++){last=await dispatch.reconcile(id);if(last.status===wanted)return last;await mine();}
 assert.fail(`expected ${wanted}: ${JSON.stringify(last)}`);
}
test('actual schema3 composer persists one start, serves, and honors owner stop after reopening its real journal',async t=>{
 const {w,f,c,journal,compose}=await setup(t),before=w.sent.length;
 await until(c.dispatch,w.id,'running');assert.equal(w.sent.length,before+1);assert.ok(f.calls.serve.length>0);
 assert.equal((await w.assignment())[1],2);assert.equal(journal.readHostAuthority(HOST).floor.owner,w.operator.address.toLowerCase());
 const priorServe=f.calls.serve.length;await c.dispatch.restrict(w.id,'TEST local owner stops service');
 await until(c.dispatch,w.id,'queued');
 assert.equal((await w.assignment())[1],1);assert.equal(f.calls.serve.length,priorServe);assert.ok(f.calls.stop.length>0);
 const reopened=await compose();await reopened.c.dispatch.reconcile(w.id);
 assert.equal(f.calls.serve.length,priorServe);assert.ok(reopened.journal.readHostAuthority(HOST).holds[w.id]);
 assert.equal(w.sent.length,before+2,'one start and one revoke, no restart replay');
});
test('actual mined start with lost reply reconciles after composer restart without resending',async t=>{
 const {w,f,c,journal,compose}=await setup(t),before=w.sent.length;w.loseResponse=true;
 await c.dispatch.reconcile(w.id);assert.equal(w.sent.length,before+1);assert.ok(journal.read(w.id).pending);
 await mine();w.loseResponse=false;const reopened=await compose();
 await until(reopened.c.dispatch,w.id,'running');assert.equal(w.sent.length,before+1);
 assert.equal((await w.assignment())[1],2);assert.ok(f.calls.serve.length>0);assert.equal(reopened.journal.read(w.id).pending,null);
});
test('actual emergency cutoff fences composed service and keeps pending settlement from restart',async t=>{
 const {w,f,c}=await setup(t);await until(c.dispatch,w.id,'running');
 const priorServe=f.calls.serve.length;await emergency3(w);await mine();const sends=w.sent.length;
 const held=await c.dispatch.reconcile(w.id);assert.equal(held.status,'held');assert.match(held.reason,/pending/);
 assert.equal(f.calls.serve.length,priorServe);assert.equal(w.sent.length,sends);assert.ok(f.calls.fence.length>0);
 assert.equal(c.dispatch.emergencyOffline.code,'LIFECYCLE_REPORTER_NOT_CONFIGURED');
 await reconcile3(w);await mine();f.V.owner='TEST operator keeps stopped during accounting recovery';
 await c.dispatch.reconcile(w.id);assert.equal(f.calls.serve.length,priorServe);assert.equal((await w.assignment())[1],1);
});
