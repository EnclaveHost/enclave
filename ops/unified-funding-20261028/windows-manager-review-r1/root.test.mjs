import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openOwnedLog, initializeOwnedLog, TEST_inProcessExclusion} from './candidate/control/windows/vbslike/manager/win-durable.mjs';
import {openPermitJournal} from './candidate/control/windows/vbslike/manager/permit-journal.mjs';
import {PermitGuard, GUARD_PURPOSE} from './candidate/control/windows/vbslike/guard/guard-core.mjs';
const D='0x'+'11'.repeat(32);
function logFor(t,purpose='enclave-manager-permit/1') {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'enclave-root-permit-test-'));
 const file=path.join(dir,'journal'); initializeOwnedLog(file,{purpose});
 const ex=TEST_inProcessExclusion();const open=()=>openOwnedLog(file,{purpose,exclusion:ex});
 const log=open();t.after(()=>{log.release();fs.rmSync(dir,{recursive:true,force:true});});return {log,open};
}
test('ROOT release immediately revokes retained admission while retaining physical ownership during withdrawal', async t=>{
 const {log,open}=logFor(t);const j=openPermitJournal(log);
 let finish;const held=new Promise(r=>finish=r);j.hostAuthority.onRelease(()=>held);
 const release=j.release('owner shutdown');await Promise.resolve();
 assert.throws(()=>open(),/owned/);
 let refused=false;try{j.observeAssignment(D,1,1);}catch{refused=true;}
 finish();await release;
 assert.equal(refused,true,'retained journal admitted a new assignment while release was pending');
});
test('ROOT authenticated hash chain does not admit semantically invalid replay rows',t=>{
 const {log,open}=logFor(t);
 log.append('lc',{id:D,row:{generation:-1,revision:1,sequence:0,digest:null,fenced:false,denial:null,binding:null}});log.release();
 const second=open();t.after(()=>second.release());
 assert.throws(()=>openPermitJournal(second),undefined,'negative generation accepted on cold replay');
});
test('ROOT rejected expired registration leaves no armed record invisible to session-death cleanup',async t=>{
 const {log}=logFor(t,GUARD_PURPOSE);
 const guard=new PermitGuard({log,backend:{survey:async()=>({vms:[]}),removeById:async()=>({found:false,removed:false})},bootId:'TEST',now:()=>1000,monotonic:()=>0,maxLaunchMs:0});
 await guard.start();const s=guard.attach({pid:1,created:'TEST',epoch:'a'.repeat(32)});
 assert.throws(()=>guard.register(s,{instanceId:'pp'+'b'.repeat(32),deployment:D,launchEpoch:'c'.repeat(32),wallUntil:999,remainingMs:1}),/deadline already passed/);
 guard.sessionEnded(s,'TEST death');await guard.stop();
 assert.equal(guard.status().armed,0,'rejected registration remains durably armed without a timer or session-death cleanup');
});
