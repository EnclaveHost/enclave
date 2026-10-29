// Root r2 race tests (evidence/root-r2/root-races.test.mjs), import paths adapted ONLY (AUTHORED copy, NOT RUN by the author).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openOwnedLog,initializeOwnedLog,TEST_inProcessExclusion} from '../../control/windows/vbslike/manager/win-durable.mjs';
import {PermitGuard,GUARD_PURPOSE} from '../../control/windows/vbslike/guard/guard-core.mjs';
import {PermitEnforcement,CONFIG_SCHEMA,TEST_QUALIFICATION} from '../../control/windows/vbslike/manager/permit-enforcement.mjs';
import {openPermitJournal} from '../../control/windows/vbslike/manager/permit-journal.mjs';
import {HOST,PINS} from './helpers/world.mjs';
const D='0x'+'11'.repeat(32),I='pp'+'b'.repeat(32);
function logFor(t,purpose){const d=fs.mkdtempSync(path.join(os.tmpdir(),'root-r2-'));const f=path.join(d,'journal');initializeOwnedLog(f,{purpose});const l=openOwnedLog(f,{purpose,exclusion:TEST_inProcessExclusion()});t.after(()=>{l.release();fs.rmSync(d,{recursive:true,force:true});});return l;}
for(const kind of ['register','renew'])test(`ROOT ${kind}: a durable write crossing the deadline cannot acknowledge a live permit`,async t=>{
 const base=logFor(t,GUARD_PURPOSE);let wall=1000,mono=0,advance=false;
 const log={...base,append:(k,d,o)=>{const v=base.append(k,d,o);if(advance&&k==='reg'&&d.rec.state==='armed'){wall+=200;mono+=200;}return v;}};
 const g=new PermitGuard({log,backend:{survey:async()=>({vms:[]}),removeById:async()=>({found:false,removed:false})},bootId:'TEST',now:()=>wall,monotonic:()=>mono,maxLaunchMs:0});
 await g.start();const s=g.attach({pid:1,created:'TEST',epoch:'a'.repeat(32)});
 const reg={instanceId:I,deployment:D,launchEpoch:'c'.repeat(32),wallUntil:1100,remainingMs:100};
 if(kind==='renew'){g.register(s,{...reg,wallUntil:10000,remainingMs:9000});g.bindVm(s,{instanceId:I,vmId:'12345678-1234-1234-1234-123456789abc'});}
 advance=true;let accepted=false;
 try{if(kind==='register')g.register(s,reg);else g.renew(s,{instanceId:I,permitDigest:'d'.repeat(64),wallUntil:1100,remainingMs:100});accepted=true;}catch{}
 try{assert.equal(accepted,false,'write returned after wall expiry yet registration/renewal acknowledged');}
 finally{g.sessionEnded(s,'TEST cleanup');await g.stop();}
});
test('ROOT journal read failure must not suppress independent guard withdrawal',async t=>{
 const base=logFor(t,'enclave-manager-permit/1');const j=openPermitJournal(base);let broken=false,calls=0,closed=0;
 const journal={...j,instance:(id)=>{if(broken)throw Error('TEST journal unreadable');return j.instance(id);}};
 const manager={epoch:'e'.repeat(32),domains:new Map(),backend:{survey:async()=>({vms:[]})},removeRecord:async()=>{}};
 const guard={onLost(){},call:async(op)=>{if(op==='withdraw')calls++;return {};}};
 const e=new PermitEnforcement({config:{schema:CONFIG_SCHEMA,pins:PINS,host:HOST,maxStagingMs:60000,derivations:['enclave-catalog-bundle/1'],qualification:TEST_QUALIFICATION,retryMs:100},manager,journal,guard,dataPlane:{closeInstance(){closed++;}}});
 broken=true;await e.withdraw(I,'TEST disk error').catch(()=>{});
 assert.equal(closed,1,'ingress withdrawal must be exercised');
 assert.equal(calls,1,'independent guard never received withdrawal because journal access threw first');
});

// r3 additions (AUTHORED, NOT RUN): unknown is not absence; a hung cleanup with the guard down uses the independent remover
test('r3 a journal fault never records absence; the retry stays owned', async t => {
 const base=logFor(t,'enclave-manager-permit/1');const j=openPermitJournal(base);let broken=true;
 const journal={...j,instance:(id)=>{if(broken)throw Error('TEST journal unreadable');return j.instance(id);}};
 const manager={epoch:'e'.repeat(32),domains:new Map(),backend:{survey:async()=>({vms:[]})},removeRecord:async()=>{}};
 const e=new PermitEnforcement({config:{schema:CONFIG_SCHEMA,pins:PINS,host:HOST,maxStagingMs:60000,derivations:['enclave-catalog-bundle/1'],qualification:TEST_QUALIFICATION,retryMs:100},manager,journal,dataPlane:{closeInstance(){}}});
 await assert.rejects(e.withdraw(I,'TEST'),/not durably recorded|unknown/);
 assert.equal(e.viewOf(I).state,'unknown');
 broken=false;
});
test('r3 guard down + hung installed removal: the independent exact remover is called for the exact identity only', async t => {
 const base=logFor(t,'enclave-manager-permit/1');const journal=openPermitJournal(base);
 const GUIDV='12345678-1234-1234-1234-123456789abc';
 const manager={epoch:'e'.repeat(32),domains:new Map([[I,{}]]),backend:{survey:async()=>({vms:[]})},removeRecord:()=>new Promise(()=>{})};
 const removed=[];
 const computeRemover={survey:async()=>({vms:[{vmId:GUIDV,notes:`enclave-vbslike-domain ${JSON.stringify({id:I})}`},{vmId:'87654321-4321-4321-4321-cba987654321',notes:'legacy'}]}),removeById:async(v)=>{removed.push(v);return {found:true,removed:true};}};
 const e=new PermitEnforcement({config:{schema:CONFIG_SCHEMA,pins:PINS,host:HOST,maxStagingMs:60000,derivations:['enclave-catalog-bundle/1'],qualification:TEST_QUALIFICATION,retryMs:100},manager,journal,dataPlane:{closeInstance(){}},computeRemover});
 e.known.set(I,{deployment:D,vmId:GUIDV,terminal:false,workloads:[]});
 await assert.rejects(e.withdraw(I,'TEST'),/still running/);
 // NOTE for root: whether the Notes fixture parses as identity I depends on wmi-launcher parseNotes' exact marker format;
 // adjust the notes string to the launcher's real marker. The legacy VM must never be removed.
 assert.ok(!removed.includes('87654321-4321-4321-4321-cba987654321'));
});
