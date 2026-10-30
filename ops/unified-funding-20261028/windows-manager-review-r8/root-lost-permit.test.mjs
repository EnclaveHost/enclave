import test from 'node:test';
import assert from 'node:assert/strict';
import {rig,permitRecord,envelope} from './candidate/test/windows-permit/helpers/world.mjs';
import {ProtectedIsolationClient} from './candidate/control/windows/node/protected-isolation.mjs';
import {GuestdControlError} from './candidate/control/isolation/m4/guestd/control-client.mjs';
test('ROOT processed permit response loss reconciles exact manager-bound authority without resend',async t=>{
 const w=await rig(t),r=await w.stage(),id=r.body.instanceId;await w.staged(id);
 w.authority.s.state='running';w.authority.s.generation=w.journal.instance(id).generation;
 const rec=permitRecord({generation:w.authority.s.generation,sequence:1,now:w.now});const att=w.attachment(id,rec);let sends=0;
 const c=new ProtectedIsolationClient({control:{request:async(...args)=>{
  const out=await w.client.request(...args);
  if(args[0]==='POST'&&args[1].endsWith('/permit')){sends++;assert.equal(out.status,200);throw new GuestdControlError('transport','TEST actual processed response lost',true);}
  return out;
 }}});
 try{
  const out=await c.permit(id,await envelope(rec),att,{hostAuthority:rec.hostAuthority.digest});
  assert.equal(out.reconciled,true);assert.equal(out.hostAuthority,rec.hostAuthority.digest);assert.equal(out.permitDigest,att.permitDigest);assert.equal(sends,1);assert.equal(c.unknownPermits.size,0);
  const stream=await w.splice(id);assert.match(stream.got(),/^OK/);stream.c.destroy();
 }finally{await w.enforcement.withdraw(id,'TEST cleanup').catch(()=>{});}
});
