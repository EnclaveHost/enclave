import test from 'node:test';
import assert from 'node:assert/strict';
import {rig,DEPLOYMENT} from './candidate/test/windows-permit/helpers/world.mjs';
test('ROOT terminal record does not conceal another unattributed protected VM',async t=>{
 const w=await rig(t),r=await w.stage();const id=r.body.instanceId;await w.staged(id);
 await w.client.request('DELETE',`/vms/${id}`,undefined,{idempotent:true});
 assert.equal(w.journal.instance(id).state,'removed');
 const stray='pp'+'e'.repeat(32);w.manager.domains.set(stray,{id:stray,name:DEPLOYMENT});
 let rejected=false;try{w.manager.protectedInventory(DEPLOYMENT);}catch(e){rejected=e.status===503;}finally{w.manager.domains.delete(stray);}
 assert.equal(rejected,true,'terminal old row concealed unmatched protected domain');
});
test('ROOT unsigned DELETE cannot stop an authenticated serving instance',async t=>{
 const w=await rig(t),r=await w.stage();const id=r.body.instanceId;await w.staged(id);assert.equal((await w.serve(id)).status,200);
 const stream=await w.splice(id);assert.match(stream.got(),/^OK/);let result;
 try{result=await w.plain('DELETE',`/vms/${id}`);}finally{stream.c.destroy();await w.enforcement.withdraw(id,'TEST cleanup').catch(()=>{});}
 assert.equal(result.status,401,'unsigned request reached protected Stop path');
});
