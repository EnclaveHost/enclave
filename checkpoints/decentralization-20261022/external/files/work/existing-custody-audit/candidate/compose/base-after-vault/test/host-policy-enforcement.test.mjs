// Enforcement adapters over a stand-in gate: route verification, discovery candidates, hot-path host admission caching
// and the measured host gate. The gate itself (anchor, quorum, signatures, persistence) is test/platform-host-policy.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {leaseHostAdmission,operatorDecider,hostAdmissions,measuredHostGate} from '../network/host-policy-adapters.mjs';
import {applyHostPolicy} from '../network/service-index.mjs';

const BAD='0x'+'4d'.repeat(32),GOOD='0x'+'11'.repeat(32),OPB='0x'+'c9'.repeat(20),OPG='0x'+'22'.repeat(20);
function fakeGate({banned=new Set([BAD]),behindOnce=false,throws=false}={}){
 let behind=behindOnce,refreshes=0,decides=0;
 const decision=(id)=>behind?{admit:false,status:'behind',reason:'behind'}:banned.has(id)?{admit:false,status:'current',reason:'banned by platform policy #3 (registryId): abuse'}:
   {admit:true,status:'current',reason:null,host:{operator:id===GOOD?OPG:OPB}};
 return {
  get refreshes(){return refreshes;},get decides(){return decides;},banned,
  async refresh(){refreshes++;behind=false;},
  async decide({registryIds}){decides++;if(throws)throw Error('rpc quorum unavailable');return {block:10n,decisions:Object.fromEntries(registryIds.map((id)=>[id,decision(id)]))};},
  async decideOperators(ops){return Object.fromEntries(ops.map((o)=>[o,o===OPB?{admit:false,status:'current',reason:'banned operator'}:{admit:true,status:'current'}]));},
 };
}
test('route verification refuses a banned lease host before anything else is trusted; absent gate is unchanged',async()=>{
 const g=fakeGate();
 const adm=leaseHostAdmission(g);
 assert.equal((await adm({runner:BAD,runnerOperator:OPB})).admit,false);
 assert.equal((await adm({runner:GOOD,runnerOperator:OPG})).admit,true);
 assert.match((await adm({runner:GOOD,runnerOperator:OPB})).reason,/operator differs/,'the lease operator must be the host\'s operator at the policy block');
 // verifyRoute with a full signed bundle: test/route-record.test.mjs 'platform host policy'
});
test('discovery: banned operators move to refusedByPolicy; a missing decision refuses',async()=>{
 const g=fakeGate();
 const r=await applyHostPolicy({candidates:[{operator:OPB,kind:'relay'},{operator:OPG,kind:'relay'}],rejected:[]},operatorDecider(g));
 assert.deepEqual(r.candidates.map((c)=>c.operator),[OPG]);assert.equal(r.refusedByPolicy[0].candidate.operator,OPB);
 const none=await applyHostPolicy({candidates:[{operator:OPG}]},async()=>({}));
 assert.equal(none.candidates.length,0);
});
test('hot-path admissions: refresh once when behind the anchor; admits cached for the TTL only; refusals never cached',async()=>{
 const g=fakeGate({behindOnce:true});let t=0;
 const adm=hostAdmissions(g,{ttlMs:30000,now:()=>t});
 let d=await adm([GOOD,BAD]);
 assert.equal(g.refreshes,1);assert.equal(d[GOOD].admit,true);assert.equal(d[BAD].admit,false);
 const before=g.decides;await adm([GOOD]);assert.equal(g.decides,before,'cached admit');
 await adm([BAD]);assert.equal(g.decides,before+1,'refusal re-asked');
 g.banned.add(GOOD);t+=30001;d=await adm([GOOD]);assert.equal(d[GOOD].admit,false,'a new ban reaches the hot path after the TTL');
});
test('measured host gate: a ban stops serving at once; transient loss keeps serving only within the grace',async()=>{
 let t=1000;const g=fakeGate();
 const ok=measuredHostGate({gate:g,hostId:GOOD,graceMs:60000,now:()=>t});
 assert.equal((await ok.check()).serving,true);
 const flaky=fakeGate({throws:true});const m=measuredHostGate({gate:{...g,decide:async(x)=>{if(t>5000)return flaky.decide(x);return g.decide(x);}},hostId:GOOD,graceMs:60000,now:()=>t});
 assert.equal((await m.check()).serving,true);t=10000;assert.equal((await m.check()).serving,true,'within grace');
 t=100000;assert.equal((await m.check()).serving,false,'grace exhausted');
 const banned=measuredHostGate({gate:fakeGate(),hostId:BAD,now:()=>t});
 const s=await banned.check();assert.deepEqual([s.serving,s.banned],[false,true]);
 assert.throws(()=>measuredHostGate({gate:g,hostId:'metal0'}),/registry id/);
});
