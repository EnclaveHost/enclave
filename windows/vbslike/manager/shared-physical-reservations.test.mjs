import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Manager} from './server.mjs';
import {DERIVATION,COMPONENT_PREAMBLE} from './derive.mjs';
const MiB=1048576;
const body=name=>({name:'0x'+name.repeat(64),cpuShare:.25,hasSecrets:false,isPublic:true,
  derive:{derivation:DERIVATION,catalog:{app:'0x'+'3'.repeat(64),version:0},
    cid:'bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzytzvi455xfv23tyjnza',runtimeId:'1'.repeat(64),
    policy:{vcpus:1,memMiB:512,cpuPercent:100}}});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixturePool(capacity=2048*MiB) {
  const claims=new Map(),consumed=new Set();
  return {poolHash:'a'.repeat(64),boot:'b'.repeat(32),claims,consumed,
    async acquire(c){if([...claims.values()].reduce((n,c)=>n+c.bytes,0)+c.bytes>capacity)throw Error('shared capacity exhausted');claims.set(c.id,c);},
    async consumeStart(c){assert.equal(claims.get(c.id),c);if(consumed.has(c.id))throw Error('dispatch consumed');consumed.add(c.id);}};
}
async function manager(pool,cpuPoolVcpus=null) {
  const calls=[];const m=new Manager({ramPoolMiB:4096,physicalRamPoolMiB:4096,physicalReservations:pool,cpuPoolVcpus,
    fetchComponent:async()=>COMPONENT_PREAMBLE,
    backend:{preflight:async()=>({ok:true,hostLogicalProcessors:16,checks:[]}),canSurvey:true,supports:{},backend:'hyperv-partition-per-app',survey:async()=>({vms:[]}),stop:async()=>{},
      start:async(_mapping,options)=>{calls.push(options);return {appReady:true,memory:{vmMiB:2048}};}}});
  await m.recover();await m.probe();return {m,calls};
}
test('direct requests to separate managers compete before either native submission',async()=>{
  const pool=fixturePool(),a=await manager(pool),b=await manager(pool);
  const results=await Promise.all([a.m.spawn(body('a')),b.m.spawn(body('b'))]);
  assert.equal(results.filter(r=>r.status==='running').length,1);
  assert.equal(results.filter(r=>r.status==='failed').length,1);
  assert.equal(a.calls.length+b.calls.length,1);assert.equal(pool.claims.size,1);assert.equal(pool.consumed.size,1);
});
test('existing RPC claim shares the same budget and blocks an oversized app allocation',async()=>{
  const pool=fixturePool();const rpc=Object.freeze({poolHash:pool.poolHash,boot:pool.boot,actor:'rpc',id:'c'.repeat(64),bytes:1024*MiB});
  await pool.acquire(rpc);const {m,calls}=await manager(pool);
  assert.equal((await m.spawn(body('a'))).status,'failed');assert.equal(calls.length,0);assert.equal(pool.claims.get(rpc.id),rpc);
});
test('async acquire holds the local reservation and rechecks capacity before consuming a start',async()=>{
  const pool=fixturePool(),gate=deferred(),entered=deferred(),acquire=pool.acquire;
  pool.acquire=async function(c){await acquire.call(this,c);entered.resolve();await gate.promise;};
  const {m,calls}=await manager(pool);const starting=m.spawn(body('a'));await entered.promise;
  assert.equal(m.physicalRamAllocated(),2048);assert.equal(m.health().allocation.requests[0].reservationLinked,true);
  m.physicalRamPoolMiB=1024;gate.resolve();assert.equal((await starting).status,'failed');
  assert.equal(calls.length,0);assert.equal(pool.consumed.size,0);assert.equal(pool.claims.size,1);
});
test('lost dispatch response retains both reservations without a native start or automatic release',async()=>{
  const pool=fixturePool(),consume=pool.consumeStart;
  pool.consumeStart=async function(c){await consume.call(this,c);throw Error('lost dispatch response');};
  const {m,calls}=await manager(pool);const result=await m.spawn(body('a'));
  assert.equal(result.status,'failed');assert.equal(calls.length,0);assert.equal(pool.consumed.size,1);
  assert.equal(m.physicalRamAllocated(),2048);await m.remove(result.id);
  assert.equal(pool.claims.size,1);assert.equal(pool.consumed.size,1);
});
test('backend ambiguity never releases a consumed shared claim',async()=>{
  const pool=fixturePool(),{m}=await manager(pool);m.backend.start=async()=>{throw Error('native outcome unknown');};
  const failed=await m.spawn(body('a'));assert.equal(failed.status,'failed');
  assert.equal(pool.claims.size,1);assert.equal(pool.consumed.size,1);assert.equal(m.physicalRamAllocated(),2048);
});
test('shared claim is exact, immutable, and cannot be supplied or resized by request body',async()=>{
  const pool=fixturePool(),{m}=await manager(pool),request=body('a');request.sharedPhysicalClaim={bytes:1};
  await m.spawn(request);const claim=[...pool.claims.values()][0];
  assert.equal(Object.isFrozen(claim),true);assert.equal(claim.bytes,2048*MiB);assert.equal(claim.actor,'app-legacy');
  assert.match(claim.id,/^[0-9a-f]{64}$/);assert.equal(claim.poolHash,pool.poolHash);assert.equal(claim.boot,pool.boot);
  assert.throws(()=>new Manager({physicalReservations:pool}),/pinned pool/);
});

for(const phase of ['acquire','consumeStart'])test('CPU observation revoked during '+phase+' prevents native start',async()=>{
 const pool=fixturePool(),gate=deferred(),entered=deferred(),original=pool[phase];
 pool[phase]=async function(c){await original.call(this,c);entered.resolve();await gate.promise;};
 const {m,calls}=await manager(pool,16),starting=m.spawn(body('a'));await entered.promise;
 assert.equal(m.cpuAllocated(),400000);
 m.backend.preflight=async()=>({ok:true,checks:[]});await m.probe();
 assert.equal(m.health().cpu.freeUnits,null);assert.equal(m.hostLogicalProcessors,null);
 gate.resolve();assert.equal((await starting).status,'failed');assert.equal(calls.length,0);
 assert.equal(pool.claims.size,1);assert.equal(pool.consumed.size,phase==='consumeStart'?1:0);
});
test('CPU reservation includes a launch blocked on shared physical admission',async()=>{
 const pool=fixturePool(8192*MiB),gate=deferred(),entered=deferred(),acquire=pool.acquire;
 pool.acquire=async function(c){await acquire.call(this,c);entered.resolve();await gate.promise;};
 const {m,calls}=await manager(pool,16),first={...body('a'),cpuShare:1};
 // One full RAM/CPU pool remains held while external admission is pending.
 m.physicalRamPoolMiB=8192;
 const starting=m.spawn(first);await entered.promise;assert.equal(m.cpuAllocated(),1600000);
 await assert.rejects(m.spawn(body('b')),/CPU|RAM|memory|capacity/);
 assert.equal(calls.length,0);gate.resolve();await starting;assert.equal(calls.length,1);
});


async function enrolledManager(over={}){
 const pool=fixturePool(),calls=[];
 const backend={prefix:'enclave-enrolled-',marker:'enclave-enrolled-vbslike-domain',canSurvey:true,supports:{},
  preflight:async()=>({ok:true,checks:[],hostLogicalProcessors:16}),survey:async()=>({vms:[]}),
  start:async(mapping,options)=>{calls.push(options);return {appReady:true,memory:{vmMiB:2048},cpu:{appCpuPercent:options.appCpu.appCpuPercent}};}};
 const config={backend,ramPoolMiB:4096,physicalRamPoolMiB:4096,cpuPoolVcpus:16,physicalReservations:pool,instanceNamespace:'nx',
  fetchComponent:async()=>COMPONENT_PREAMBLE,...over};
 const m=new Manager(config);await m.recover();await m.probe();return {m,pool,calls,config};
}
test('enrolled manager enforces new namespace even on direct API requests',async()=>{
 let fetches=0;const {m,pool,calls}=await enrolledManager({fetchComponent:async()=>{fetches++;return COMPONENT_PREAMBLE;}});
 for(const id of [undefined,'hv-old','nx-bad','nd'+'a'.repeat(32)])await assert.rejects(m.spawn({...body('a'),id}),/router-minted nx/);
 assert.equal(fetches,0);assert.equal(pool.claims.size,0);
 const id='nx'+'a'.repeat(32),result=await m.spawn({...body('a'),id});assert.equal(result.id,id);assert.equal(calls.length,1);
 assert.deepEqual(m.health().sharedPhysicalPool,{poolHash:pool.poolHash,boot:pool.boot});assert.equal(m.health().instanceNamespace,'nx');
});
test('enrolled identity stays fixed across component fetch and cannot turn into retained ID',async()=>{
 const gate=deferred(),entered=deferred();
 const {m,calls}=await enrolledManager({fetchComponent:async()=>{entered.resolve();await gate.promise;return COMPONENT_PREAMBLE;}});
 const request={...body('a'),id:'nx'+'a'.repeat(32)},pending=m.spawn(request);await entered.promise;
 request.id='hv-retained';request.name='0x'+'b'.repeat(64);gate.resolve();const result=await pending;
 assert.equal(result.id,'nx'+'a'.repeat(32));assert.equal(calls[0].identity.name,'0x'+'a'.repeat(64));
});
test('enrolled namespace refuses unshared authority and overlapping VM ownership',async()=>{
 const {config}=await enrolledManager();
 for(const patch of [{physicalReservations:null},{instanceNamespace:'hv'},{cpuPoolVcpus:null},
  {backend:{...config.backend,prefix:'enclave-app-'}},{backend:{...config.backend,marker:'enclave-vbslike-domain'}}])
  assert.throws(()=>new Manager({...config,...patch}),/enrolled namespace/);
});

test('enrolled manager holds allocation on missing guest CPU confirmation',async()=>{
 const {m,pool}=await enrolledManager();m.backend.start=async()=>({appReady:true,memory:{vmMiB:2048}});
 const result=await m.spawn({...body('a'),id:'nx'+'a'.repeat(32)});
 assert.equal(result.status,'failed');assert.match(result.reason,/exact guest CPU/);
 assert.equal(pool.claims.size,1);assert.equal(pool.consumed.size,1);assert.equal(m.physicalRamAllocated(),2048);
});

for(const actual of [3072,undefined])test('enrolled contradictory CPU and RAM preserves pessimistic memory: '+actual,async()=>{
 const {m,pool}=await enrolledManager();
 m.backend.start=async()=>({appReady:true,memory:{vmMiB:actual},cpu:{appCpuPercent:0}});
 const result=await m.spawn({...body('a'),id:'nx'+'a'.repeat(32)});
 assert.equal(result.status,'failed');assert.match(result.reason,/physical RAM/);
 assert.equal(m.physicalRamAllocated(),actual===undefined?null:actual);
 assert.equal(pool.claims.size,1);assert.equal(pool.consumed.size,1);
 assert.equal([...pool.claims.values()][0].bytes,2048*MiB);
});
