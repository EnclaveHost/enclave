// ROOT regression: actual AllocationOwner and Linux flock/durable state, TEST clock and capacity.
// No Hyper-V, Windows qualification, real allocation, network, keys or funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.ALLOCATION_CANDIDATE_ROOT;
if(!root||!path.isAbsolute(root))throw Error('explicit absolute frozen candidate required');
const {COVERAGE_TERMS,establishDurableDomain,openDurableAllocationStore,openAllocationOwner}=await import(pathToFileURL(path.join(root,'control/windows/vbslike/manager/allocation-owner.mjs')));
const domain={id:'root-test-qualified-hold',floorMiB:18432,roles:['general','native'],commitReserveMiB:128,vmCommitOverheadMiB:128,maxSampleAgeMs:1000,maxTtlMs:60000,isolated:true};
const coverage=()=>Object.fromEntries(['physical','commit'].map(side=>[side,Object.fromEntries(COVERAGE_TERMS.map(k=>[k,1]))]));
const request=id=>({id,name:id,vmInstanceId:id,appId:'ab'.repeat(32)});
async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'root-allocation-hold-'));
 const file=path.join(dir,'ledger.json');let clock=100,owner;
 const sample=async()=>({availablePhysicalMiB:18432+384+8,availableCommitMiB:128+512+8,at:clock,source:'TEST finite capacity; not a physical host'});
 const open=async()=>openAllocationOwner({store:await openDurableAllocationStore(file),domainId:domain.id,sampler:sample,coverage:async()=>coverage(),monotonic:()=>clock,now:()=>1700000000000+clock});
 const identities={general:{managerIncarnation:'11'.repeat(16),epoch:'21'.repeat(16),baseline:[]},native:{managerIncarnation:'12'.repeat(16),epoch:'22'.repeat(16),baseline:[]}};
 t.after(async()=>{await owner?.close('TEST cleanup');fs.rmSync(dir,{recursive:true,force:true});});
 await establishDurableDomain(file,{domain});owner=await open();
 const register=async()=>{for(const role of domain.roles)await owner.register(role,identities[role]);};
 await register();
 const body=(role,b)=>({...b,managerIncarnation:identities[role].managerIncarnation,ownerIncarnation:owner.ownerIncarnation});
 return {get owner(){return owner;},advance(){clock+=100;},async restart(){await owner.close('TEST owner restart, qualification process has not ended');owner=await open();await register();},
 acquire:async(role,kind,id)=>owner.acquire(role,body(role,{kind,request:request(id),physicalMiB:384,commitMiB:512,ttlMs:10})),
 observe:async(role,b)=>owner.observe(role,body(role,b))};
}
for(const mode of ['ttl-expiry','owner-restart'])test(`ROOT qualification hold survives ${mode} until exact end; second allocation must be refused`,async(t)=>{
 const f=await fixture(t);
 const hold=await f.acquire('general','qualification','running-test-envelope');
 if(mode==='ttl-expiry')f.advance();else await f.restart();
 // acquire invokes the real sweep; no qualification-ended/death/removal event was supplied.
 let competing;try{competing={admitted:true,grant:await f.acquire('native','vm','competing-vm')};}catch(e){competing={admitted:false,status:e.status,message:e.message};}
 assert.equal(competing.admitted,false,`capacity was reused without qualification end: ${JSON.stringify(competing)}`);
 assert.equal(competing.status,507,'capacity refusal, not a malformed fixture or missing manager registration');
 assert.ok(f.owner.snapshot().active[hold.rid],'qualification accounting must remain durable');
 await f.observe('general',{rid:hold.rid,outcome:'absent',evidence:{kind:'qualification-ended',request:request('running-test-envelope')}});
 assert.ok((await f.acquire('native','vm','after-explicit-end')).rid,'exact end permits capacity reuse');
});
