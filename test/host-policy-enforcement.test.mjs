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
test('discovery: only an explicit operator BAN removes a service ad; allowlist misses, not-activated and unreadable policy only annotate',async()=>{
 const OPA='0x'+'aa'.repeat(20),OPU='0x'+'ab'.repeat(20);
 const decide=async(ops)=>Object.fromEntries(ops.map((o)=>[o,o===OPB?{admit:false,status:'current',reason:'banned by platform policy #4 (operator): malware'}
   :o===OPA?{admit:false,status:'current',reason:'not admitted by platform allowlist #4'}:o===OPU?{admit:true,status:'not-activated'}:{admit:true,status:'current'}]));
 const r=await applyHostPolicy({candidates:[{operator:OPB,kind:'directory'},{operator:OPG,kind:'checker'},{operator:OPA,kind:'replica'},{operator:OPU,kind:'dns'}],rejected:[]},decide);
 assert.deepEqual(r.candidates.map((c)=>c.operator),[OPG,OPA,OPU],'a compute-host allowlist never drops provider/directory ads');
 assert.equal(r.refusedByPolicy[0].candidate.operator,OPB);assert.match(r.refusedByPolicy[0].reason,/malware/);
 assert.equal(r.candidates.find((c)=>c.operator===OPA).platformPolicy.reason,'not admitted by platform allowlist #4');
 const down=await applyHostPolicy({candidates:[{operator:OPG}]},async()=>{throw Error('rpc down');});
 assert.equal(down.candidates.length,1);assert.equal(down.candidates[0].platformPolicy.status,'unchecked');assert.match(down.platformPolicyNote,/unreadable/);
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

test('measured gate: admit -> explicit deny -> RPC failure / behind / unreadable stays REFUSED; only a new admit (unban) resumes',async()=>{
 let t=1000,mode='admit';const changes=[];
 const H='0x'+'11'.repeat(32);
 const gate={async refresh(){},async decide(){
   if(mode==='rpc')throw Error('rpc quorum unavailable');
   const d=mode==='admit'?{admit:true,status:'current'}:mode==='deny'?{admit:false,status:'current',reason:'banned by platform policy #4 (operator): abuse'}
     :mode==='inactive'?{admit:false,status:'inactive',reason:'host registry entry is not active'}:mode==='behind'?{admit:false,status:'behind',reason:'behind'}:{admit:false,status:'anchor',reason:'torn'};
   return {decisions:{[H]:d}};}};
 const g=measuredHostGate({gate,hostId:H,graceMs:60000,now:()=>t,onChange:(s)=>changes.push(s.serving)});
 assert.equal((await g.check()).serving,true);
 mode='rpc';t+=1000;assert.equal((await g.check()).serving,true,'transient outage before any known refusal: grace');
 mode='deny';t+=1000;let s=await g.check();assert.deepEqual([s.serving,s.banned],[false,true]);
 for(const m of ['rpc','behind','anchor']){mode=m;t+=1000;s=await g.check();assert.equal(s.serving,false,`${m} after a known ban must not resurrect service`);assert.equal(s.banned,true);}
 mode='rpc';t+=10;assert.equal((await g.check()).serving,false,'still within the old admit grace window: still refused');
 mode='admit';t+=1000;assert.equal((await g.check()).serving,true,'the admin\'s unban (a new authenticated admit) resumes');
 mode='rpc';t+=1000;assert.equal((await g.check()).serving,true,'grace again after the new admit');
 mode='inactive';t+=1000;s=await g.check();assert.deepEqual([s.serving,s.banned],[false,false]);
 mode='rpc';t+=1000;assert.equal((await g.check()).serving,false,'deregistration is sticky too');
 mode='admit';t+=1000;assert.equal((await g.check()).serving,true);
 assert.deepEqual(changes,[true,false,true,false,true],'onChange fires on every serving transition');
 const cold=measuredHostGate({gate:{async refresh(){},async decide(){throw Error('down');}},hostId:H,now:()=>t});
 assert.equal((await cold.check()).serving,false,'a cold start never serves without an authenticated admit');
});

test('measured gate: a delayed OLDER admit can never overwrite a newer explicit ban (serialized, block-monotonic)',async()=>{
 const H='0x'+'11'.repeat(32);const queue=[];
 const gate={async refresh(){},decide:()=>new Promise((res)=>queue.push(res))};
 const g=measuredHostGate({gate,hostId:H,graceMs:60000});
 const slowAdmit=g.check();const ban=g.check();             // the admit check started first and is slow
 await new Promise((r)=>setTimeout(r,10));
 assert.equal(queue.length,1,'serialized: the second check waits for the first');
 queue.shift()({block:10n,decisions:{[H]:{admit:true,status:'current'}}});await slowAdmit;
 await new Promise((r)=>setTimeout(r,10));
 queue.shift()({block:11n,decisions:{[H]:{admit:false,status:'current',reason:'banned by platform policy #9 (operator): abuse'}}});
 assert.deepEqual([(await ban).serving,(await ban).banned],[false,true]);
 const stale=g.check();await new Promise((r)=>setTimeout(r,10));
 queue.shift()({block:9n,decisions:{[H]:{admit:true,status:'current'}}});      // an answer from an OLDER block than the ban
 assert.equal((await stale).serving,false,'a stale admitting snapshot is discarded');
 const fresh=g.check();await new Promise((r)=>setTimeout(r,10));
 queue.shift()({block:12n,decisions:{[H]:{admit:true,status:'current'}}});
 assert.equal((await fresh).serving,true,'a NEWER authenticated admit (the unban) resumes');
});
test('measured gate persistence: only a known refusal is restored; a local admit timestamp never grants cold-start service',async()=>{
 const H='0x'+'11'.repeat(32);let saved=null;const persist={load:()=>saved,save:(v)=>{saved=v;}};
 let mode='ban';const gate={async refresh(){},async decide(){if(mode==='down')throw Error('rpc down');
   return {block:1n,decisions:{[H]:mode==='ban'?{admit:false,status:'current',reason:'banned'}:{admit:true,status:'current'}}};}};
 const g1=measuredHostGate({gate,hostId:H,persist});await g1.check();
 mode='down';const g2=measuredHostGate({gate,hostId:H,persist});
 assert.equal((await g2.check()).serving,false,'a banned host restarted during an outage stays refused');
 mode='admit';await g2.check();assert.equal(JSON.parse(saved).knownRefusal,null,'the unban clears the persisted refusal');
 saved=JSON.stringify({hostId:H,lastAdmit:Date.now(),knownRefusal:null});           // an edited local file claiming a recent admit
 mode='down';const g3=measuredHostGate({gate,hostId:H,persist});
 assert.equal((await g3.check()).serving,false,'no positive grace from unauthenticated local state');
 const failing=measuredHostGate({gate:{async refresh(){},async decide(){return {block:2n,decisions:{[H]:{admit:false,status:'current',reason:'banned'}}};}},hostId:H,
   persist:{load:()=>null,save:()=>{throw Error('disk full');}}});
 assert.equal((await failing.check()).serving,false,'a failed save leaves the in-memory refusal in force');
});

test('measured gate: admit -> CONFIRMED authority loss (rotation / withdrawn ERC-1271) -> RPC error stays refused; a current-owner re-sign resumes',async()=>{
 const H='0x'+'11'.repeat(32);let mode='admit',b=0n,refreshes=0;
 const gate={async refresh(){refreshes++;},async decide(){b++;if(mode==='rpc')throw Error('rpc quorum unavailable');
   const d=mode==='admit'?{admit:true,status:'current'}:mode==='authority'?{admit:false,status:'authority',reason:'the accepted policy is not signed by the current book owner at this block'}
     :{admit:false,status:'authority-unread',reason:'facts carry no current book owner'};
   return {block:b,decisions:{[H]:d}};}};
 const g=measuredHostGate({gate,hostId:H,graceMs:60000});
 assert.equal((await g.check()).serving,true);
 mode='authority-unread';assert.equal((await g.check()).serving,true,'UNREAD authority is undecided: grace');
 mode='authority';let s=await g.check();assert.equal(s.serving,false);assert.equal(refreshes>0,true,'an authority answer triggers a refresh (a re-signed copy may exist)');
 mode='rpc';s=await g.check();assert.equal(s.serving,false,'a confirmed authority loss is sticky through an RPC error');
 mode='authority-unread';assert.equal((await g.check()).serving,false);
 mode='admit';assert.equal((await g.check()).serving,true,'the current owner re-signed: a new authenticated admit resumes');
});
