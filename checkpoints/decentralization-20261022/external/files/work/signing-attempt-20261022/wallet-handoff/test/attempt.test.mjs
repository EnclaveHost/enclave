import test from 'node:test';
import assert from 'node:assert/strict';
import { handoff, doUpload } from './harness.mjs';
async function ready() { const h=await handoff(); await h.post('/start'); assert.equal((await doUpload(h)).status,200); return h; }
const saved=h=>JSON.stringify(h.journals.publish.read());
const reject=(h,attemptId)=>h.post('/tx/rejected',{step:'publish',code:4001,attemptId});

test('identical transaction retries have different IDs; missing, stale, malformed, and duplicate rejections never mutate journals',async()=>{
 const h=await ready(); try {
  const a=await h.post('/tx/prepare',{step:'publish'}); assert.match(a.body.attemptId,/^[0-9a-f]{48}$/);
  assert.equal((await h.post('/tx/release',{step:'publish'})).status,200);
  const b=await h.post('/tx/prepare',{step:'publish'});
  assert.deepEqual(a.body.transaction,b.body.transaction); assert.notEqual(a.body.attemptId,b.body.attemptId);
  const before=saved(h);
  for(const id of [undefined,null,{},'', '0'.repeat(48),a.body.attemptId]) {
   assert.equal((await reject(h,id)).status,409); assert.equal(saved(h),before);
  }
  assert.equal((await reject(h,b.body.attemptId)).status,200);
  const after=saved(h); assert.equal((await reject(h,b.body.attemptId)).status,409); assert.equal(saved(h),after);
  assert.equal(h.journals.publish.read().attempts.length,1); // retained released attempt remains verifiable
 } finally { await h.close(); await h.gw.close(); }
});

test('attempt identity survives restart without a journal rewrite; current rejection remains valid',async()=>{
 const h=await ready(); let h2; try {
  const a=await h.post('/tx/prepare',{step:'publish'}); const before=saved(h); await h.close();
  h2=await handoff({dir:h.dir,model:h.model,gw:h.gw}); assert.equal(saved(h2),before);
  assert.equal((await reject(h2,a.body.attemptId)).status,200);
  assert.equal(h2.journals.publish.read().status,'ready');
 } finally { await (h2??h).close(); await h.gw.close(); }
});

test('legacy open journal loads byte-identically and refuses unidentified rejection; original hash still verifies',async()=>{
 const h=await ready(); let h2; try {
  const a=await h.post('/tx/prepare',{step:'publish'}); await h.close();
  const legacy=h.journals.publish.read(); delete legacy.request.attemptId; for(const a of legacy.attempts) delete a.attemptId;
  h.journals.publish.write(legacy); const before=saved(h);
  h2=await handoff({dir:h.dir,model:h.model,gw:h.gw}); assert.equal(saved(h2),before);
  assert.equal((await reject(h2,undefined)).status,409); assert.equal(saved(h2),before);
  const hash=h.model.land(a.body.transaction,{}); h.model.mine(2);
  const r=await h2.post('/tx/result',{step:'publish',hash}); assert.equal(r.body.verification.outcome,'confirmed');
 } finally { await (h2??h).close(); await h.gw.close(); }
});

test('legacy unanswered journal remains recoverable by existing chain-checked release',async()=>{
 const h=await ready(); let h2; try {
  await h.post('/tx/prepare',{step:'publish'}); await h.close();
  const legacy=h.journals.publish.read(); delete legacy.request.attemptId; for(const a of legacy.attempts) delete a.attemptId;
  h.journals.publish.write(legacy);
  h2=await handoff({dir:h.dir,model:h.model,gw:h.gw}); assert.equal((await h2.post('/tx/release',{step:'publish'})).status,200);
  const b=await h2.post('/tx/prepare',{step:'publish'}); assert.match(b.body.attemptId,/^[0-9a-f]{48}$/); assert.equal(b.body.transaction.nonce,'0x475');
 } finally { await (h2??h).close(); await h.gw.close(); }
});
