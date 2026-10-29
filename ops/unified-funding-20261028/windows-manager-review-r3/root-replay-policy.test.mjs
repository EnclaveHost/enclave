import test from 'node:test';
import assert from 'node:assert/strict';
import {rig,permitRecord,waitFor,DEPLOYMENT} from './candidate/test/windows-permit/helpers/world.mjs';
test('ROOT stale sequence cannot revoke or extend current valid permit; its real expiry still removes compute',async t=>{
 const w=await rig(t);const st=await w.stage();assert.equal(st.status,202);const id=st.body.instanceId;await w.staged(id);
 assert.equal((await w.serve(id,{sequence:1})).status,200);const initial=w.journal.instance(id);
 const fresh=permitRecord({generation:initial.generation,sequence:2,now:w.now,lifeSec:3});
 const accepted=await w.permit(id,fresh);assert.equal(accepted.status,200);
 const before=w.journal.instance(id).permit;
 const stale=await w.permit(id,permitRecord({generation:initial.generation,sequence:1,now:w.now,lifeSec:20}));
 assert.equal(stale.status,403);assert.deepEqual(w.journal.instance(id).permit,before);assert.equal(w.journal.read(DEPLOYMENT).sequence,2);
 const stream=await w.splice(id);assert.match(stream.got(),/^OK/,'valid newer permit must still serve after rejected stale replay');
 try {await waitFor(()=>stream.closed(),7000);await waitFor(()=>!w.vms().some(v=>v.vmId===initial.vmId),8000);}
 finally {stream.c.destroy();}
 assert.equal(w.journal.instance(id).state,'removed');
});
