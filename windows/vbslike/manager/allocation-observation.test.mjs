import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Manager} from './server.mjs';
import {DERIVATION, DERIVATION_V5, COMPONENT_PREAMBLE} from './derive.mjs';

function deferred() { let resolve, reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
function request(name='a') { return {name:'0x'+name.repeat(64),cpuShare:.25,hasSecrets:false,isPublic:true,
  derive:{derivation:DERIVATION,catalog:{app:'0x'+'3'.repeat(64),version:0},
    cid:'bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzytzvi455xfv23tyjnza',runtimeId:'1'.repeat(64),
    policy:{vcpus:1,memMiB:512,cpuPercent:100}}}; }
async function setup(options={}) {
  const state={starts:0,stopFails:false};
  const backend={canSurvey:true,supports:{},backend:'hyperv-partition-per-app',survey:async()=>({vms:[]}),
    start:async()=>{state.starts++; if(state.startGate)await state.startGate.promise;
      return {appReady:true,memory:{vmMiB:2048}};},
    stop:async()=>{if(state.stopFails)throw Error('not stopped');}};
  const m=new Manager({backend,ramPoolMiB:4096,physicalRamPoolMiB:4096,
    fetchComponent:async()=>COMPONENT_PREAMBLE,...options});
  await m.recover();return {m,state};
}
test('component waits are visible before /vms and become held before native submission',async()=>{
  const gate=deferred(),entered=deferred();
  const {m,state}=await setup({fetchComponent:async()=>{entered.resolve();await gate.promise;return COMPONENT_PREAMBLE;}});
  const initial=m.health().allocation;
  const promise=m.spawn(request()); await entered.promise;
  const waiting=m.health().allocation;
  assert.equal(m.list().length,0); assert.equal(state.starts,0);
  assert.equal(waiting.preparing,1);assert.equal(waiting.known,false);
  assert.equal(waiting.heldMiB,0);assert.equal(waiting.requests[0].domainId,null);
  assert.notEqual(waiting.revision,initial.revision);
  const submitted=deferred();state.startGate=deferred();
  const original=m.backend.start;
  m.backend.start=async(...args)=>{submitted.resolve(m.health().allocation);return original(...args);};
  gate.resolve();const held=await submitted.promise;
  assert.equal(held.preparing,0);assert.equal(held.known,true);assert.equal(held.heldMiB,2048);
  assert.equal(held.requests[0].requestId,waiting.requests[0].requestId);
  assert.equal(held.requests[0].phase,'reserved');
  assert.equal(held.requests[0].domainId,held.reservations[0].id);
  assert.equal(held.reservations[0].physicalMiB,2048);
  // The launcher's post-start memory.vmMiB is not available yet.
  assert.equal(m.list()[0].memory.vmMiB,undefined);
  state.startGate.resolve();await promise;
  const complete=m.health().allocation;assert.equal(complete.requests.length,0);
  assert.equal(complete.heldMiB,2048);assert.notEqual(complete.revision,held.revision);
});
test('config waits and rejected fetches remain unknown until settled, without publishing inputs',async()=>{
  const gate=deferred(),entered=deferred();
  const {m,state}=await setup({configEnabled:true,fetchConfig:async()=>{entered.resolve();return gate.promise;}});
  const body=request();body.derive.derivation=DERIVATION_V5;body.derive.configCid='private-test-input';
  const promise=m.spawn(body);const rejected=assert.rejects(promise,/config unavailable/);
  await entered.promise;const observed=m.health().allocation;
  assert.equal(observed.preparing,1);assert.equal(observed.known,false);
  assert.ok(!JSON.stringify(observed).includes('private-test-input'));
  gate.reject(Error('config unavailable'));await rejected;
  assert.equal(m.health().allocation.requests.length,0);assert.equal(m.health().allocation.known,true);
  assert.equal(state.starts,0);assert.equal(m.physicalRamAllocated(),0);
});
test('concurrent preparations have distinct identities and do not disappear when one rejects',async()=>{
  const a=deferred(),b=deferred();let n=0;
  const {m}=await setup({fetchComponent:()=>++n===1?a.promise:b.promise});
  const first=m.spawn(request('a')),second=m.spawn(request('b'));
  const firstRejected=assert.rejects(first,/first rejected/);
  const before=m.health().allocation;assert.equal(before.preparing,2);
  assert.equal(new Set(before.requests.map(r=>r.requestId)).size,2);
  a.reject(Error('first rejected'));await firstRejected;
  assert.equal(m.health().allocation.preparing,1);assert.equal(m.health().allocation.known,false);
  b.resolve(COMPONENT_PREAMBLE);await second;
  assert.equal(m.health().allocation.preparing,0);assert.equal(m.health().allocation.heldMiB,2048);
});
test('ambiguous backend failure and failed removal keep the physical reservation',async()=>{
  const {m,state}=await setup();m.backend.start=async()=>{throw Error('response lost');};
  const failed=await m.spawn(request());assert.equal(failed.status,'failed');
  const held=m.health().allocation;
  assert.equal(held.requests.length,0);assert.equal(held.heldMiB,2048);
  state.stopFails=true;await assert.rejects(m.remove(failed.id),/not stopped/);
  assert.deepEqual(m.health().allocation.reservations,held.reservations);
  state.stopFails=false;await m.remove(failed.id);
  assert.equal(m.health().allocation.heldMiB,0);
  assert.notEqual(m.health().allocation.revision,held.revision);
});
test('unknown allocations, unconfigured cap, and recovery in flight cannot report known',async()=>{
  const {m}=await setup();const gate=deferred();m.backend.survey=()=>gate.promise;
  const recovering=m.recover();assert.equal(m.health().allocation.inventoryReady,false);
  assert.equal(m.health().allocation.known,false);gate.resolve({vms:[]});await recovering;
  for(const extra of [{recovered:true,physicalMemoryMiB:2048},{physicalMemoryMiB:null},{physicalMemoryMiB:0}]) {
    m.domains.set('unknown',{id:'unknown',...extra});
    assert.equal(m.health().allocation.known,false);
    assert.deepEqual(m.health().allocation.unknown,['unknown']);
    assert.equal(m.health().allocation.heldMiB,null);m.domains.delete('unknown');
  }
  const {m:uncapped}=await setup({physicalRamPoolMiB:null});
  assert.equal(uncapped.health().allocation.known,false);
});
test('observations are detached, incarnation-bound and never grant host capacity',async()=>{
  const {m}=await setup();const result=await m.spawn(request());
  const view=m.health().allocation;
  assert.equal(view.schema,'enclave-manager-allocation/1');assert.equal(view.scope,'manager-local');
  assert.equal(view.managerEpoch,m.health().managerEpoch);assert.equal(view.atomicHostReservation,false);
  view.reservations[0].physicalMiB=1;view.reservations.push({id:'fake',physicalMiB:1});
  assert.deepEqual(m.health().allocation.reservations,[{id:result.id,physicalMiB:2048}]);
  const {m:other}=await setup();assert.notEqual(other.health().allocation.managerEpoch,view.managerEpoch);
});
