import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openOwnedLog,initializeOwnedLog,TEST_inProcessExclusion} from './candidate/control/windows/vbslike/manager/win-durable.mjs';
import {PermitGuard,GUARD_PURPOSE} from './candidate/control/windows/vbslike/guard/guard-core.mjs';
import {PermitEnforcement,CONFIG_SCHEMA,TEST_QUALIFICATION} from './candidate/control/windows/vbslike/manager/permit-enforcement.mjs';
import {openPermitJournal} from './candidate/control/windows/vbslike/manager/permit-journal.mjs';
import {HOST,PINS} from './candidate/test/windows-permit/helpers/world.mjs';
const D='0x'+'11'.repeat(32),I='pp'+'b'.repeat(32);
function logFor(t,purpose){const d=fs.mkdtempSync(path.join(os.tmpdir(),'root-r2-'));const f=path.join(d,'journal');initializeOwnedLog(f,{purpose});const l=openOwnedLog(f,{purpose,exclusion:TEST_inProcessExclusion()});t.after(()=>{l.release();fs.rmSync(d,{recursive:true,force:true});});return l;}
for(const kind of ['register','renew'])test(`ROOT ${kind}: a durable write crossing the deadline cannot acknowledge a live permit`,async t=>{
 const base=logFor(t,GUARD_PURPOSE);let wall=1000,mono=0,advance=false;
 const log={...base,append:(k,d,o)=>{const v=base.append(k,d,o);if(advance&&k==='reg'&&d.rec.state==='armed'){wall+=200;mono+=200;}return v;}};
 const g=new PermitGuard({log,backend:{survey:async()=>({vms:[]}),removeById:async()=>({found:false,removed:false})},bootId:'TEST',now:()=>wall,monotonic:()=>mono,maxLaunchMs:0});
 await g.start();const s=g.attach({pid:1,created:'TEST',epoch:'a'.repeat(32)});
 t.after(async()=>{g.sessionEnded(s,'TEST cleanup');await g.stop();});
 const reg={instanceId:I,deployment:D,launchEpoch:'c'.repeat(32),wallUntil:1100,remainingMs:100};
 if(kind==='renew'){g.register(s,{...reg,wallUntil:10000,remainingMs:9000});g.bindVm(s,{instanceId:I,vmId:'12345678-1234-1234-1234-123456789abc'});}
 advance=true;let accepted=false;
 try{if(kind==='register')g.register(s,reg);else g.renew(s,{instanceId:I,permitDigest:'d'.repeat(64),wallUntil:1100,remainingMs:100});accepted=true;}catch{}
 assert.equal(accepted,false,'write returned after wall expiry yet registration/renewal acknowledged');
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
