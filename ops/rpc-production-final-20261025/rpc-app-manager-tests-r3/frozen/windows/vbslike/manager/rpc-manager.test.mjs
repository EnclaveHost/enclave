import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Manager} from './server.mjs';
import {captureRPCAttempt} from './rpc-admission.mjs';
import {deriveRPC,validateRPCRecord,RPC_DERIVATION,RPC_PORTS,RPC_CONFIG} from './rpc-derive.mjs';
import {COMPONENT_PREAMBLE,DERIVATIONS,canonical} from './derive.mjs';
const H=c=>c.repeat(64),component=Buffer.from(COMPONENT_PREAMBLE);
const record=()=>({derivation:RPC_DERIVATION,catalog:{app:'0x'+H('a'),version:0},cid:'b'+'a'.repeat(58),runtimeId:H('b'),
 policy:{cpuPercent:400,memMiB:19456,vcpus:4},http:8000,ports:[...RPC_PORTS],configBase64:canonical(RPC_CONFIG).toString('base64'),
 secretDeployment:'0x'+H('c'),rpc:{profile:'ethereum-base-rpc-v1',profileSha256:H('d'),l1VolumeId:H('e'),baseVolumeId:H('f')}});
const body=()=>({id:'rpc'+'1'.repeat(32),name:'0x'+H('c'),derive:record(),cpuShare:.25,hasSecrets:true,isPublic:true,firewall:[...RPC_PORTS]});
async function setup(over={}) {
 const state={events:[],starts:[],stops:0,current:true,inventory:true,ordinary:0,judges:0};let m;
 const pool={poolHash:H('1'),boot:'2'.repeat(32),acquire:async c=>{state.events.push('acquire');state.claim=c;assert.equal(m.physicalRamAllocated(),20480);if(state.acquireGate)await state.acquireGate;if(state.acquireError)throw Error('acquire ambiguous');},consumeStart:async()=>{state.events.push('consume');if(state.consume)state.consume();}};
 const controller={runtimeId:H('b'),profileSha256:H('d'),assertInventory:()=>state.inventory,begin:id=>{
  state.events.push('begin');state.identity=id;
  return {originalClock:{originMs:'1000',deadlineMs:'901000'},assertCurrent:()=>state.current,
   start:async(launch,bundle)=>{state.events.push('start');state.starts.push({launch,bundle});if(state.startGate)await state.startGate;if(state.startError)throw Error('provider response lost');return {rpcReady:true,vmId:'ignored',appReady:true};},
   stop:async()=>{state.stops++;if(state.stopError)throw Error('stop response lost');}};
 }};
 const backend={canSurvey:true,backend:'test',supports:{},survey:async()=>({vms:[]}),preflight:async()=>({ok:true,hostLogicalProcessors:16,checks:[]}),
  start:async()=>{state.ordinary++;throw Error('legacy forbidden');},stop:async()=>{state.ordinary++;throw Error('legacy stop forbidden');}};
 const options={backend,rpcController:controller,ramPoolMiB:77824,cpuPoolVcpus:16,physicalRamPoolMiB:20480,physicalReservations:pool,
  fetchComponent:async()=>{state.events.push('fetch');if(state.fetchGate)await state.fetchGate;return component;},judgeReady:async()=>{state.judges++;return {status:'running'};},...over};
 m=new Manager(options);await m.probe();await m.recover();return {m,state,controller,options};
}
test('V9 matches actual Go mapper and owns bytes without enabling ordinary derivations',()=>{
 const dir=process.env.RPC_MAPPING_VECTOR_DIR;assert.ok(dir);
 const go=JSON.parse(fs.readFileSync(dir+'/rpc-mapping.json')),got=deriveRPC({record:record(),component});
 const {bundle,...receipt}=got;assert.deepEqual(receipt,go);assert.deepEqual(bundle,fs.readFileSync(dir+'/rpc-bundle.bin'));
 const r=record(),c=Buffer.from(component),owned=deriveRPC({record:r,component:c});r.ports[0]='udp:1';c.fill(1);
 assert.deepEqual(owned.record.ports,RPC_PORTS);assert.deepEqual(owned.bundle,bundle);assert.ok(!DERIVATIONS.includes(RPC_DERIVATION));
});
test('V9 rejects identity, command, budget and storage ambiguity',()=>{
 for(const mutate of [r=>r.vmId='old',r=>r.catalog.app='0x'+H('0'),r=>delete r.catalog.version,r=>r.policy.memMiB=19455,
  r=>r.rpc.baseVolumeId=r.rpc.l1VolumeId,r=>r.secretDeployment='0x'+H('0'),r=>r.ports[1]='tcp:8545',
  r=>r.configBase64=Buffer.from('{"startupSeconds":901}').toString('base64'),r=>r.cid+='\n',r=>r.runtimeId+='\n']) {
  const r=record();mutate(r);assert.throws(()=>validateRPCRecord(r));
 }
 assert.throws(()=>deriveRPC({record:record(),component:Buffer.alloc((8<<20)+1)}));
});
test('dedicated manager reserves full stack before one original start and never trusts readiness claims',async()=>{
 const {m,state}=await setup(),a=await m.spawn(body());
 assert.deepEqual(state.events,['begin','fetch','acquire','consume','start']);assert.equal(state.starts.length,1);
 const x=state.starts[0];assert.equal(x.launch.name,a.name);assert.equal(x.launch.id,a.id);assert.equal(x.launch.appId,deriveRPC({record:record(),component}).appId);
 assert.deepEqual(x.launch.originalClock,{originMs:'1000',deadlineMs:'901000'});assert.equal(state.claim.bytes,21474836480);
 assert.ok(Object.isFrozen(x.launch.record.rpc));assert.equal(m.memoryView().reservedMiB,19456);assert.equal(m.cpuAllocated(),400000);
 assert.equal(a.status,'starting');assert.equal(a.appReady,false);assert.equal(a.hostExcluded,false);assert.equal(a.reservationMayRelease,false);
 assert.equal(state.ordinary,0);assert.equal(state.judges,0);assert.ok(!m.health().catalog.derivations.includes(RPC_DERIVATION));
 assert.equal(a.vmId,undefined);assert.equal(a.handle,undefined);assert.throws(()=>{a.memory.appMiB=1;});
});
test('request mutation during fetch cannot redirect identity or volumes',async()=>{
 const {m,state}=await setup();let release;state.fetchGate=new Promise(r=>release=r);const b=body(),pending=m.spawn(b);
 b.name='0x'+H('9');b.derive.rpc.l1VolumeId=H('9');b.derive.policy.memMiB=1;release();
 const a=await pending;assert.equal(a.name,'0x'+H('c'));assert.equal(state.starts[0].launch.record.rpc.l1VolumeId,H('e'));
});
test('concurrent completions cannot oversell full physical reservation',async()=>{
 const {m,state}=await setup();let release;state.fetchGate=new Promise(r=>release=r);const b=body();b.id='rpc'+'3'.repeat(32);b.name=b.derive.secretDeployment='0x'+H('3');
 const pending=[m.spawn(body()),m.spawn(b)];release();const all=await Promise.allSettled(pending);
 assert.equal(all.filter(x=>x.status==='fulfilled').length,1);assert.equal(state.starts.length,1);assert.equal(m.physicalRamAllocated(),20480);
});
test('lost start and stop answers keep exact deployment and reservation with no retry or survey adoption',async()=>{
 const {m,state}=await setup();state.startError=true;const a=await m.spawn(body());assert.equal(a.status,'failed');
 await assert.rejects(m.spawn(body()),/already held|capacity/);assert.equal(state.starts.length,1);
 await assert.rejects(m.recover(),/cannot overlap/);state.stopError=true;
 await assert.rejects(m.remove(a.id),/stop response lost/);await assert.rejects(m.remove(a.id),/remains held/);
 assert.equal(state.stops,1);assert.equal(state.ordinary,0);assert.equal(m.physicalRamAllocated(),20480);assert.equal(m.get(a.id).reservationMayRelease,false);
});
test('deadline loss during preparation and after shared consume prevents dispatch',async()=>{
 const a=await setup();let release;a.state.fetchGate=new Promise(r=>release=r);const p=a.m.spawn(body());a.state.current=false;release();
 await assert.rejects(p,/deadline/);assert.equal(a.state.starts.length,0);assert.equal(a.m.list().length,0);
 const b=await setup();b.state.consume=()=>{b.state.current=false;};const r=await b.m.spawn(body());assert.equal(r.status,'failed');
 assert.equal(b.state.starts.length,0);assert.equal(b.m.physicalRamAllocated(),20480);
});
test('unknown or changed ownership inventory and ambiguous acquire prevent native submission',async()=>{
 const a=await setup();a.state.inventory=false;await assert.rejects(a.m.spawn(body()),/inventory/);assert.equal(a.state.events.length,0);
 const b=await setup();b.state.acquireError=true;const r=await b.m.spawn(body());assert.equal(r.status,'failed');assert.equal(b.state.starts.length,0);
 assert.equal(b.m.physicalRamAllocated(),20480);assert.deepEqual(b.state.events,['begin','fetch','acquire']);
});
test('default, mismatched profile, alternate VM inputs and under-purchase refuse without launch',async()=>{
 const {m,state,options}=await setup();const ordinary=new Manager({...options,rpcController:null});await ordinary.probe();await ordinary.recover();
 await assert.rejects(ordinary.spawn(body()),/unavailable/);
 for(const patch of [{vmId:'old'},{originalClock:{}},{ownerReceipt:'x'},{hasSecrets:false},{firewall:[]},{cpuShare:.2},{config:'{}'},{bootstrap:''}])
  await assert.rejects(m.spawn({...body(),...patch}));
 const b=body();b.derive.rpc.profileSha256=H('2');await assert.rejects(m.spawn(b),/profile differs/);
 assert.equal(state.starts.length,0);assert.equal(state.ordinary,0);assert.equal(m.list().length,0);
});
test('shared claim must complete before start and remove cannot race it',async()=>{
 const {m,state}=await setup();let release;state.acquireGate=new Promise(r=>release=r);const p=m.spawn(body());
 await new Promise(r=>setImmediate(r));assert.equal(m.allocationView().requests[0].phase,'reserved');assert.equal(state.starts.length,0);
 await assert.rejects(m.remove(body().id),/still launching/);release();await p;
 await assert.rejects(m.remove(body().id),/remains held/);assert.equal(state.stops,1);assert.equal(m.list().length,1);
});

test('failed RPC deployment cannot be resubmitted through ordinary V1',async()=>{
 const {m,state}=await setup();state.startError=true;const a=await m.spawn(body());assert.equal(a.status,'failed');
 const r={derivation:'enclave-catalog-bundle/1',catalog:{app:'0x'+H('a'),version:0},cid:'b'+'a'.repeat(58),runtimeId:H('b'),policy:{cpuPercent:100,memMiB:128,vcpus:1}};
 await assert.rejects(m.spawn({name:a.name,derive:r,cpuShare:.25,hasSecrets:false,isPublic:true}),/already live/);
 assert.equal(state.ordinary,0);assert.equal(m.physicalRamAllocated(),20480);assert.equal(state.starts.length,1);
});

test('native original clock rejects whitespace, overflow, reset and method replacement',()=>{
 const base={originalClock:{originMs:'1000',deadlineMs:'901000'},assertCurrent:()=>true,start:()=>{},stop:()=>{}};
 for(const clock of [{originMs:'1000\n',deadlineMs:'901000'},{originMs:'1000',deadlineMs:'901000\r'},
  {originMs:'01000',deadlineMs:'901000'},{originMs:'-1',deadlineMs:'899999'},
  {originMs:'9007199254000000',deadlineMs:'9007199254900000'},{originMs:'1000',deadlineMs:'901001'}])
  assert.throws(()=>captureRPCAttempt({...base,originalClock:clock}));
 const captured=captureRPCAttempt(base);base.originalClock.deadlineMs='999999';base.start=()=>{throw Error('replacement');};
 assert.equal(captured.originalClock.deadlineMs,'901000');captured.start();assert.ok(Object.isFrozen(captured.originalClock));
});
