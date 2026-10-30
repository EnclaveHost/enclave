// Independent reviewer regressions (root r1), retained unchanged in intent. Real runner, mock authority/transactions only.
import { DISPATCH_URL } from './helpers/baseline.mjs';
import { fixture, route, H } from './helpers/lifecycle-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { createLifecycleDispatch } = await import(DISPATCH_URL);
const HOST=H('99'), OTHER=H('88'), A=H('aa');
async function setup(state='running') {
 const f=fixture({hostId:HOST,state});
 const d=createLifecycleDispatch(f.parts([route(A)]));
 d.attach(f.hostView(HOST)); await d.activate();
 assert.equal(d.state()[0].activated,true);
 return {f,d};
}
test('an owner restriction during unsigned prepare prevents journaling and sending a new running intent',async()=>{
 const {f,d}=await setup('queued');
 const prepare=f.chain.prepare;
 f.chain.prepare=async(...args)=>{ const intent=await prepare(...args); await d.restrict(A,'owner stopped hosting'); return intent; };
 await d.reconcile(A);
 assert.equal(f.calls.submit.length,0,'unsigned prepared intent must be rechecked before it enters the journal');
 assert.equal(f.journal.read(A).pending,null);
});
test('a routed snapshot for a different local host is never served',async()=>{
 const {f,d}=await setup();
 f.S.over.set(A,{thisHost:OTHER,assignment:{state:'running',host:OTHER,generation:3,revision:1,startAfter:0}});
 await d.reconcile(A);
 assert.equal(f.calls.serve.length,0,'ledger/controller/id match is insufficient without attached host identity');
 assert.ok(f.calls.fence.includes(A));
});
// r2 companion: the post-await recheck must not turn into a revocation blocker.
test('an owner restriction during unsigned prepare of a REVOCATION still journals and sends it once',async()=>{
 const {f,d}=await setup();
 f.S.refusal='this host owner declines this deployment';
 const prepare=f.chain.prepare;
 f.chain.prepare=async(...args)=>{ const intent=await prepare(...args); await d.restrict(A,'owner stopped hosting'); return intent; };
 await d.reconcile(A);
 assert.deepEqual(f.calls.prepare.map(p=>p.target),['queued']);
 assert.equal(f.calls.submit.length,1); assert.equal(f.journal.read(A).pending.target,'queued');
});
