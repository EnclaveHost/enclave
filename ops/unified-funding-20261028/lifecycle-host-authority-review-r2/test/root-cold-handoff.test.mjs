// Real durable lifecycle journal, real dispatch/runner; mock finalized handoff/runtime.
import {DISPATCH_URL,BASE_NETWORK} from './helpers/baseline.mjs';
import {fixture,route,H,OTHER} from './helpers/lifecycle-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const {createLifecycleDispatch}=await import(DISPATCH_URL);
const {openLifecycleJournal}=await import(new URL('deployment-lifecycle-journal.mjs',BASE_NETWORK));
test('cold restart after finalized handoff does not restore the old global address-book veto',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'root-handoff-restart-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'journal.json'),id=H('aa'),host=H('99');
 const f=fixture({hostId:host});
 const first=createLifecycleDispatch(f.parts([route(id)],{journal:openLifecycleJournal(file)}));
 first.attach(f.hostView(host)); await first.activate();
 assert.equal(first.state()[0].activated,true);
 assert.equal((await first.reconcile(id)).status,'running');
 // Identical route pins and exact finalized old-ledger proof remain available.
 // Only the mutable legacy address-book choice changes while the process is down.
 f.V.ledger=OTHER;
 const restarted=createLifecycleDispatch(f.parts([route(id)],{journal:openLifecycleJournal(file)}));
 restarted.attach(f.hostView(host)); await restarted.activate();
 assert.equal(restarted.state()[0].activated,true,'a restart must not restore authority to the old global address book');
 assert.equal((await restarted.reconcile(id)).status,'running');
});
