import test from 'node:test';
import assert from 'node:assert/strict';
import {rig} from './candidate/test/windows-permit/helpers/world.mjs';
test('ROOT authenticated hold must not acknowledge ingress closed after actual closeInstance fails',async t=>{
 let release;const held=new Promise(r=>release=r);
 const w=await rig(t,{hooks:{stop:()=>held}});
 const staged=await w.stage();assert.equal(staged.status,202);const id=staged.body.instanceId;
 await w.staged(id);assert.equal((await w.serve(id)).status,200);
 const stream=await w.splice(id);assert.match(stream.got(),/^OK/);
 const close=w.dp.closeInstance;let attempts=0,result;
 w.dp.closeInstance=()=>{attempts++;throw Error('TEST actual closeInstance failure');};
 try {
  result=await w.client.request('POST',`/protected/vms/${id}/hold`,undefined,{idempotent:false});
  assert.ok(attempts>0,'failure injection was actually exercised');
  assert.equal(stream.closed(),false,'fixture must observe the existing socket still open before checking the acknowledgment');
 } finally {
  w.dp.closeInstance=close;close.call(w.dp,id,'TEST cleanup');release();
  await Promise.allSettled([...w.enforcement.removals.values()]);
 }
 assert.notEqual(result?.body?.ingress,true,'MAC-authenticated reply claimed ingress closed despite failed closure and an open stream');
});
