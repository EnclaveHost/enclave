import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {rig,DEPLOYMENT,permitRecord,envelope} from './candidate/test/windows-permit/helpers/world.mjs';
import {initializeOwnedLog,openOwnedLog,TEST_inProcessExclusion} from './candidate/control/windows/vbslike/manager/win-durable.mjs';
import {ProtectedIsolationClient,ownedObligationStore,OBLIGATION_PURPOSE} from './candidate/control/windows/node/protected-isolation.mjs';

for (const lostResponse of [false,true]) test(`ROOT physical owner released during processed permit response (${lostResponse?'lost+reconciled':'delivered'}) cannot return serving`,async t=>{
 const w=await rig(t);const file=path.join(w.dir,'node-owned.log');initializeOwnedLog(file,{purpose:OBLIGATION_PURPOSE});const log=openOwnedLog(file,{purpose:OBLIGATION_PURPOSE,exclusion:TEST_inProcessExclusion()});let accepted=null;
 const c=new ProtectedIsolationClient({store:ownedObligationStore(log),control:{request:async(...args)=>{
  const r=await w.client.request(...args);
  if(args[0]==='POST'&&args[1].endsWith('/permit')){assert.equal(r.status,200);log.release();if(lostResponse)throw Object.assign(Error('TEST processed permit reply lost'),{mayHaveExecuted:true});}return r;
 }}});
 try{
  const b=await c.stage({deployment:DEPLOYMENT,stagingMs:30000,spawn:w.spawnBody});accepted=b.instanceId;await w.staged(accepted);
  w.authority.s.state='running';w.authority.s.generation=w.journal.instance(accepted).generation;
  const rec=permitRecord({generation:w.authority.s.generation,sequence:1,now:w.now});
  await assert.rejects(c.permit(accepted,await envelope(rec),w.attachment(accepted,rec),{hostAuthority:rec.hostAuthority.digest}),/owner|released|durab|unknown/i,'an in-flight permit must not restore released ownership');
 }finally{if(accepted)await w.enforcement.withdraw(accepted,'TEST cleanup').catch(()=>{});try{log.release();}catch{}}
});
