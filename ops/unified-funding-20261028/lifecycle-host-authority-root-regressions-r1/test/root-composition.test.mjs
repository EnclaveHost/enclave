// Independent composition regressions: real dispatch/runner/verifier, mock authority and runtime.
// The anchor booleans stand in for authenticated reads. No chain, signatures or funds are used.
import { DISPATCH_URL, BASE_NETWORK } from './helpers/baseline.mjs';
import { fixture, route, H, CTRL, INDEP } from './helpers/lifecycle-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { createLifecycleDispatch } = await import(DISPATCH_URL);
const { certificateWitnessesHash } = await import(new URL('deployment-generation-certificate.mjs',BASE_NETWORK));
const HOST=H('99'), A=H('aa'), B=H('bb');
const now=()=>2000000;
async function setup(ids=[A]) {
 const f=fixture({hostId:HOST,now});
 const d=createLifecycleDispatch(f.parts(ids.map(id=>route(id))));
 d.attach(f.hostView(HOST)); await d.activate();
 assert.ok(d.state().every(r=>r.activated));
 return {f,d};
}
function operational() {
 const policy={revision:1,threshold:3,witnesses:['11','22','33','44'].map(b=>'0x'+b.repeat(20)),maxAnchorAgeSec:1800,maxTransitionWei:'1000',stopReserveWei:'1000'};
 const anchor={proofVerified:true,tier:'finalized',hash:H('01'),number:100,timestamp:1000,observedAt:2000,enabled:true,admitted:true,hostAdmission:{host:HOST,admitted:true},funded:true,fundedUntil:2800,balanceWei:'100000',policyHash:certificateWitnessesHash(policy),ownerAuthority:INDEP,assignment:{deployment:A,generation:3,state:'running',host:HOST,operator:INDEP,changedAt:1000,startAfter:0,failures:0,crashHeld:false}};
 return {anchor,head:{proofVerified:true,tier:'unsafe',hash:H('02'),number:200,timestamp:2000,observedAt:2000,anchorHash:anchor.hash,ancestryVerified:true,denied:false},policy,certificates:[]};
}
test('recovered Running assignment remains charged to available host capacity',async()=>{
 const {f,d}=await setup();
 assert.equal((await d.reconcile(A)).status,'running');
 assert.equal(f.V.records.get(A).cpuShare,0.1,'recovery without an in-process start must retain authenticated resource shares');
});
test('current local owner denial still reaches ledger revocation with operational generation authority',async()=>{
 const {f,d}=await setup();
 f.S.over.set(A,{generationAuthority:operational()});
 // Positive control proves this fixture actually reaches the serving branch.
 assert.equal((await d.reconcile(A)).status,'running');
 f.calls.prepare.length=0; f.calls.submit.length=0;
 f.V.owner='authenticated local operator disabled hosting';
 await d.reconcile(A);
 assert.ok(f.calls.prepare.some(c=>c.target==='queued'||c.target==='stopped'),'the proof branch must not erase the local denial and leave only a local fence');
 assert.equal(f.calls.submit.length,1);
});
