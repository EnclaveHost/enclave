import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Manager} from './server.mjs';
import {DERIVATION, COMPONENT_PREAMBLE} from './derive.mjs';
import {type1VmMemMiB, notesFor} from './wmi-launcher.mjs';
const record={derivation:DERIVATION,catalog:{app:'0x'+'3'.repeat(64),version:0},
 cid:'bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzytzvi455xfv23tyjnza',runtimeId:'1'.repeat(64),
 policy:{vcpus:1,memMiB:512,cpuPercent:100}};
const body=name=>({name:'0x'+name.repeat(64),derive:structuredClone(record),cpuShare:.25,hasSecrets:false,isPublic:true});
async function setup(options={}){
 const state={starts:[],stops:[],inventory:{vms:[]},stopFails:false,startFails:false,reported:undefined};
 const backend={canSurvey:true,supports:{},backend:'hyperv-partition-per-app',
  survey:async()=>state.inventory,
  start:async(mapping,opts)=>{
   state.starts.push({mapping,opts});
   if(state.startFails)throw Error('launch state unknown');
   const vmMiB=type1VmMemMiB(opts.appMemoryMiB??mapping.record.policy.memMiB,{name:opts.identity.name,appId:mapping.appId});
   return {appReady:true,vmId:'test-'+state.starts.length,memory:state.reported===undefined?{vmMiB}:state.reported};
  },stop:async h=>{state.stops.push(h);if(state.stopGate)await state.stopGate;if(state.stopFails)throw Error('cleanup uncertain');}};
 const manager=new Manager({backend,fetchComponent:async()=>COMPONENT_PREAMBLE,ramPoolMiB:4096,physicalRamPoolMiB:3072,...options});
 await manager.recover();return {manager,state};
}
test('physical VM overhead limits admission separately from purchased app RAM',async()=>{
 const {manager:m,state}=await setup();
 const a=await m.spawn(body('a'));
 assert.equal(a.memory.appMiB,1024);assert.equal(a.physicalMemoryMiB,2048);
 assert.deepEqual(m.health().physicalMemory,{poolMiB:3072,allocatedMiB:2048,freeMiB:1024});
 await assert.rejects(m.spawn(body('b')),e=>e.status===507&&/physical RAM/.test(e.message));
 assert.equal(state.starts.length,1);
 await m.remove(a.id);assert.equal(m.physicalRamAllocated(),0);
 assert.equal((await m.spawn(body('b'))).status,'running');
});
test('concurrent component fetches cannot oversell physical capacity',async()=>{
 let release;const gate=new Promise(r=>release=r);
 const {manager:m,state}=await setup({fetchComponent:async()=>{await gate;return COMPONENT_PREAMBLE;}});
 const a=m.spawn(body('a')),b=m.spawn(body('b'));release();
 const result=await Promise.allSettled([a,b]);
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(result.filter(x=>x.status==='rejected'&&x.reason.status===507).length,1);
 assert.equal(state.starts.length,1);assert.equal(m.physicalRamAllocated(),2048);
});
test('failed launches and failed removal hold RAM until survey and stop confirm cleanup',async()=>{
 const {manager:m,state}=await setup();state.startFails=true;
 const failed=await m.spawn(body('a'));assert.equal(failed.status,'failed');
 assert.equal(m.physicalRamAllocated(),2048);
 state.inventory=null;await assert.rejects(m.remove(failed.id),/cannot confirm/);
 assert.equal(m.physicalRamAllocated(),2048);
 state.inventory={vms:[]};state.stopFails=true;
 await assert.rejects(m.remove(failed.id),/cleanup uncertain/);
 assert.equal(m.physicalRamAllocated(),2048);
 state.stopFails=false;await m.remove(failed.id);assert.equal(m.physicalRamAllocated(),0);
});
test('recovered or unattributed allocations block new physical admission',async()=>{
 for(const extra of [{recovered:true},{unattributed:true},{physicalMemoryMiB:null}]){
  const {manager:m,state}=await setup();m.domains.set('old',{id:'old',...extra});
  assert.equal(m.physicalRamAllocated(),null);assert.equal(m.health().physicalMemory.freeMiB,0);
  await assert.rejects(m.spawn(body('a')));assert.equal(state.starts.length,0);
 }
});
test('contradictory launcher allocation never reduces the reservation or admits another VM',async()=>{
 for(const report of [{vmMiB:1024},{vmMiB:4096},{vmMiB:'2048'},null]){
  const {manager:m,state}=await setup();state.reported=report;
  const failed=await m.spawn(body('a'));assert.equal(failed.status,'failed');
  assert.match(failed.reason,/confirm the reserved physical RAM/);
  assert.equal(m.physicalRamAllocated(),typeof report?.vmMiB==='number'?Math.max(2048,report.vmMiB):null);
  await assert.rejects(m.spawn(body('b')));assert.equal(state.starts.length,1);
  await m.remove(failed.id);assert.equal(m.physicalRamAllocated(),0);
 }
});
test('invalid physical budgets are refused and omission preserves legacy admission',async()=>{
 for(const value of [0,-1,1.5,'4096',NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
  assert.throws(()=>new Manager({physicalRamPoolMiB:value}),/positive integer/);
 const {manager:m,state}=await setup({physicalRamPoolMiB:null});
 await m.spawn(body('a'));await m.spawn(body('b'));
 assert.equal(state.starts.length,2);assert.equal(m.health().physicalMemory,undefined);
});

test('concurrent removal shares one cleanup attempt, including its failure, and can be retried',async()=>{
 const {manager:m,state}=await setup();const a=await m.spawn(body('a'));
 let release;state.stopGate=new Promise(r=>release=r);state.stopFails=true;
 const first=m.remove(a.id),second=m.remove(a.id);assert.equal(first,second);
 await new Promise(r=>setImmediate(r));assert.equal(state.stops.length,1);
 assert.equal(m.physicalRamAllocated(),2048);release();
 const outcomes=await Promise.allSettled([first,second]);
 assert.ok(outcomes.every(x=>x.status==='rejected'));
 assert.equal(m.physicalRamAllocated(),2048);
 state.stopFails=false;state.stopGate=null;await m.remove(a.id);
 assert.equal(state.stops.length,2);assert.equal(m.physicalRamAllocated(),0);
});

test('CPU launch failures without a handle also require a successful inventory before removal',async()=>{
 const {manager:m,state}=await setup({physicalRamPoolMiB:null});state.startFails=true;
 const a=await m.spawn(body('a'));state.inventory=null;
 await assert.rejects(m.remove(a.id),/cannot confirm/);assert.ok(!m.removedIds.has(a.id));
 const identity=state.starts[0].opts.identity;
 state.inventory={vms:[{vmId:'00000000-0000-4000-8000-000000000001',name:'enclave-app-failed',notes:notesFor(identity)}]};
 state.stopFails=true;await assert.rejects(m.remove(a.id),/cleanup uncertain/);
 assert.equal(state.stops[0].vmId,state.inventory.vms[0].vmId);assert.ok(!m.removedIds.has(a.id));
 state.stopFails=false;await m.remove(a.id);assert.ok(m.removedIds.has(a.id));
});

test('a stale liveness inventory cannot fail a VM started after the survey began',async()=>{
 const {manager:m}=await setup();let resolveSurvey;
 m.backend.survey=()=>new Promise(r=>resolveSurvey=r);
 const sweep=m.sweepLiveness();
 const a=await m.spawn(body('a'));assert.equal(a.status,'running');
 resolveSurvey({vms:[]});assert.deepEqual(await sweep,{checked:0,failed:0});
 assert.equal(m.get(a.id).status,'running');assert.equal(m.physicalRamAllocated(),2048);
 // A later inventory may legitimately observe that this established VM is gone.
 m.backend.survey=async()=>({vms:[]});
 assert.deepEqual(await m.sweepLiveness(),{checked:1,failed:1});
 assert.equal(m.get(a.id).status,'failed');assert.equal(m.physicalRamAllocated(),2048);
});
