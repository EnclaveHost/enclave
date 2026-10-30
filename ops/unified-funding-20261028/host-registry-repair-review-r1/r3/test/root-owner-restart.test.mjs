// Actual staged dispatch/runner and durable baseline journal. Mock chain/runtime/owner evidence only.
import {DISPATCH_URL,BASE_NETWORK} from './helpers/baseline.mjs';
import {fixture,route,H,INDEP,PLATFORM} from './helpers/lifecycle-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const {createLifecycleDispatch}=await import(DISPATCH_URL);
const {openLifecycleJournal}=await import(new URL('deployment-lifecycle-journal.mjs',BASE_NETWORK));
for (const kind of ['lower revision','same revision different owner']) {
 test(`durable host authority rejects ${kind} after process restart`,async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'root-owner-restart-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'journal.json'),id=H('aa'),host=H('99');
  const f=fixture({hostId:host});f.S.revision=3;f.S.owner=INDEP;
  const open=async()=>{
   const d=createLifecycleDispatch(f.parts([route(id)],{journal:openLifecycleJournal(file)}));
   d.attach(f.hostView(host));await d.activate();assert.equal(d.state()[0].activated,true);return d;
  };
  const stale=()=>{f.S.revision=kind==='lower revision'?2:3;f.S.owner=kind==='lower revision'?INDEP:PLATFORM;};
  const first=await open();assert.equal((await first.reconcile(id)).status,'running','positive control');
  stale();assert.equal((await first.reconcile(id)).status,'held','in-process floor already rejects this exact evidence');
  f.S.revision=3;f.S.owner=INDEP;assert.equal((await first.reconcile(id)).status,'running','valid authority still reconciles');
  const before=f.calls.serve.length;
  const restarted=await open();stale();
  assert.equal((await restarted.reconcile(id)).status,'held','restart must retain the authenticated host authority floor');
  assert.equal(f.calls.serve.length,before,'stale authority must not serve');
  assert.equal(f.calls.submit.length,0,'read-only refusal must not send a transaction');
 });
}
