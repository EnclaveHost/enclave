import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {rig,DEPLOYMENT} from './candidate/test/windows-permit/helpers/world.mjs';
import {initializeOwnedLog,openOwnedLog,TEST_inProcessExclusion} from './candidate/control/windows/vbslike/manager/win-durable.mjs';
import {ProtectedIsolationClient,ownedObligationStore,OBLIGATION_PURPOSE} from './candidate/control/windows/node/protected-isolation.mjs';
test('ROOT owner release after actual accepted stage cannot return an owned success',async t=>{
 const w=await rig(t);const file=path.join(w.dir,'node-owned.log');initializeOwnedLog(file,{purpose:OBLIGATION_PURPOSE});const log=openOwnedLog(file,{purpose:OBLIGATION_PURPOSE,exclusion:TEST_inProcessExclusion()});let accepted=null;
 const c=new ProtectedIsolationClient({store:ownedObligationStore(log),control:{request:async(...args)=>{const r=await w.client.request(...args);if(args[0]==='POST'&&args[1]==='/protected/vms'){assert.equal(r.status,202);accepted=r.body.instanceId;log.release();}return r;}}});
 try{await assert.rejects(c.stage({deployment:DEPLOYMENT,stagingMs:30000,spawn:w.spawnBody}),/owner|released|durab|unknown/i,'a successful response cannot reestablish released ownership');}
 finally{if(accepted)await w.enforcement.withdraw(accepted,'TEST cleanup').catch(()=>{});try{log.release();}catch{}}
});
