// r3: diagnostic POST 409 ids are not teardown authority, and a launch/observation that a REAL competing consumer
// superseded while it awaited publishes, fails, charges and releases nothing. Same harness, fixture and 1:100 scale as
// isolation-instance-liveness.test.mjs (DIRECT_CLAIM_SELFTEST lifecycle mode), plus the r3 seam: L.conflictIds (the 409
// names a given guest), L.gates (the nth REAL launchSpec/spawnContainer parks while abandonClaims / ledgerMoveSweep / a
// same-id replacement / a release intent runs, then resumes) and the "gated" billing read. SUPERVISOR_UNDER_TEST names
// the file; the frozen seed carries none of this seam, so the baseline differential needs root's port of it.
// WRITTEN, NOT RUN. Credentials are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {preparePackage} from '../sdk/bootstrap/package.mjs';
const exec=promisify(execFile),tier='snp-guest-per-app',SUP=process.env.SUPERVISOR_UNDER_TEST||'supervisor.js';

const pins={registry:'0x'+'a1'.repeat(20),deployments:'0x'+'a2'.repeat(20),appCatalog:'0x'+'a3'.repeat(20),proofOfTime:'0x'+'a4'.repeat(20),
  enclavePay:'0x'+'00'.repeat(20),verificationFees:'0x'+'00'.repeat(20),sessionVaultFactory:'0x'+'00'.repeat(20),secretVaultV2:'0x'+'00'.repeat(20)};
const app='0x'+'ab'.repeat(32),enclaveId='0x'+'e1'.repeat(32),other='0x'+'e2'.repeat(32),owner='0x'+'33'.repeat(20);
const catalog={app,publisher:'0x'+'44'.repeat(20),slug:'direct-app',version:'1.0.0',cid:'bafybeigdirectcomponent',memMb:256};
const manifest={version:1,chainId:8453,ledger:pins.deployments,deployment:'0x'+'11'.repeat(32),owner,appRef:`catalog://${app}/0`,
  appId:'45'.repeat(32),runtimeId:'55'.repeat(32),configText:'{"endpoint":"https://owner-chosen.example"}',secretsMode:'public'};
const pkg=preparePackage(manifest);
const pool=(memMiB,cpuPct)=>({budget:{memMiB,cpuPct},allocated:{memMiB:0,cpuPct:0},free:{memMiB,cpuPct},guests:0,overcommitted:false,
  perGuest:{floorMiB:1024,runtimeMiB:384,unitOverheadMiB:768},hostAvailableMiB:131072,hostFloorMiB:16384});
const health={backend:tier,catalog:{runtimeId:manifest.runtimeId,derivations:['enclave-catalog-bundle/1']},supports:{directBootstrap:true,gpu:false,protectedPorts:true},
  pool:pool(32768,800)};
const now=Math.floor(Date.now()/1000);
const row=(o={})=>({id:manifest.deployment,owner,appRef:manifest.appRef,configCid:JSON.stringify({guestBootstrap:pkg.intent}),active:true,isPublic:true,
  gpuMilli:0,cpuMilli:100,leaseUntil:now+3600,runner:enclaveId,balance6:10_000_000,rate:1,spent6:0,createdAt:now-86400,...o});
const A='http://192.0.2.10:8189/ipfs';
const expectedDerive={derivation:'enclave-catalog-bundle/1',catalog:{app,version:0},cid:catalog.cid,policy:{cpuPercent:100,memMiB:256,vcpus:1},runtimeId:manifest.runtimeId};
const canon=v=>Array.isArray(v)?`[${v.map(canon).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')}}`:JSON.stringify(v);
const recordSha=createHash('sha256').update(canon(expectedDerive)).digest('hex');
const OWN=manifest.deployment, ORPHAN='0x'+'99'.repeat(32), FOREIGN='0x'+'77'.repeat(32);
const guest=(id,name,extra={})=>({id,name,appId:manifest.appId,runtimeId:manifest.runtimeId,recordSha256:recordSha,directBootstrap:true,
  bootstrapSha256:pkg.sha256,createdAt:now-86400,leaseLeftMs:1840,reserved:{memMiB:1792,cpuPct:100},...extra});
const own=guest('gdown00001',OWN), orphan=guest('gdorph0001',ORPHAN,{recordSha256:'cc'.repeat(32)});
// another deployment's live guest: the 409 under OWN's name is scripted to name it (L.conflictIds). Fresh (createdAt
// now) and with a long guestd lease, so neither guestd's lapse nor the reconciler's orphan age ends it inside a run.
const foreign=guest('gdforeign01',FOREIGN,{createdAt:now,leaseLeftMs:999999});
const rows=[row(),row({id:ORPHAN,runner:other})];
const admitted={serving:true,status:'current-admit',reason:'admitted'};
const scale={ttlMs:3000,silenceMs:1800,reconcileMs:600,claimMs:600,claimOffsetMs:300,reclaimMs:400,lastBeatAgoMs:1160};
const ABANDON='scripted: public reachability lost';

function env(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stale-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'pins.json');fs.writeFileSync(file,JSON.stringify({version:1,chainId:8453,contracts:pins}));
  return {PATH:process.env.PATH,SECRET:'direct-test-secret',ENABLE_MPS:'0',STATE_FILE:path.join(dir,'state.json'),
    ISOLATION_DIRECT_ONLY:'1',ISOLATION_BACKEND:tier,PROVISION_BACKEND:'vm',ENCLAVE_CONTRACT_PINS_FILE:file,ADDRESS_BOOK_ADDRESS:'',
    SECRETS_API:'',DOMAINS_API:'',CERTS_API:'',DNS_API:'',APP_CERT_DOMAIN:'',
    GUEST_BOOTSTRAP_GATEWAYS:A,IPFS_GATEWAY:JSON.stringify([new URL(A).origin]),
    REGISTRY_ENABLED:'1',REGISTRY_PRIVATE_KEY:'0x'+'01'.repeat(32),ENCLAVE_REPO:'independent/host',CLAIM_ENABLED:'1',
    PROVISION_DEFER_MS:'300',BILL_TICK_SEC:'1'};
}
async function run(t,lifecycle){
  const config={catalog,health,appId:manifest.appId,bytes:pkg.bytes.toString('base64'),enclaveId,endpoint:'https://host.independent.example',
    leaseUntil:now+3600,rows,replicas:{[A]:'serve'},lifecycle:{...scale,guests:[own,orphan],gate:[[0,admitted]],audit:true,endMs:5000,...lifecycle}};
  const {stdout}=await exec(process.execPath,[SUP],{cwd:new URL('..',import.meta.url),timeout:60000,
    env:{...env(t),DIRECT_CLAIM_SELFTEST:JSON.stringify(config)},maxBuffer:8<<20}).catch(e=>{throw Error(e.stderr||e.message);});
  return JSON.parse(stdout.trim().split('\n').at(-1));
}
const show=o=>JSON.stringify({events:o.events,records:o.records,detail:o.detail,snapshot:o.snapshot,deleted:o.deleted,stops:o.stops,
  outcomes:o.outcomes,gates:o.gates,releases:o.releases,notes:o.provisionFailureNotes,gpuReleases:o.gpuReleases,intent:o.intent,serving:o.serving});
const ownStops=o=>o.stops.filter(s=>s.id===OWN);
// the first attempt outcome after gate g (the parked attempt resumes right after its act)
const after=(o,g,kind='provision')=>o.outcomes.find(x=>x.kind===kind&&x.t>=g.t);
// what the superseded continuation must not add on top of the teardown that won
function stale(o,g,{status,releaseWhy=null,kind='provision'}){
  const x=after(o,g,kind);
  assert(x,'the parked attempt completed: '+show(o));
  assert.notEqual(x.outcome,'served','a superseded attempt is never a successful launch: '+show(o));
  if(kind==='provision') assert.equal(x.outcome,'superseded','not a generic failure or deferral either: '+show(o));
  assert.equal(x.posts,g.postsAfter,'no POST /vms after the teardown: '+show(o));
  assert.equal(g.after.status,status,'the teardown\'s terminal state stands (no resurrection, no failed overwrite): '+show(o));
  assert.equal(g.after.vmId,g.before.vmId,'identity not rewritten by the stale result: '+show(o));
  assert.deepEqual(o.provisionFailureNotes.filter(n=>n.id===OWN),[],'no obsolete failure ladder: '+show(o));
  assert.deepEqual(o.releases.filter(r=>r.id===OWN&&r.why!==releaseWhy),[],'no obsolete/duplicate release: '+show(o));
  if(g.before.gpu) assert(o.gpuReleases.filter(r=>r.h===g.before.gpu).length<=1,'the slice is released once, by the teardown: '+show(o));
}

// ---- 1. unverified 409 id is diagnostic only ----------------------------------------------------------------------
// unverified_conflict_stop: no held guest under OWN's name, so no verified id; the 409 names another deployment's
// guest, whose authenticated GET says so. Deferred; then the REAL owner-stop / lease-loss branches never stop it.
for (const [what,patch,want] of [['owner stop',{active:false},'terminated'],['lease loss',{runner:other},'expired']])
  test(`unverified 409 id: deferred with no teardown identity; ${what} never DELETEs the named guest`,async t=>{
    const o=await run(t,{guests:[foreign,orphan],conflictIds:{[OWN]:foreign.id},snapshotAtMs:1800,rowPatches:[[2500,OWN,patch]],endMs:7000});
    const s=o.snapshot[OWN];
    assert.equal(s?.status,'claimed','deferred, never running while unverifiable: '+show(o));
    assert.equal(s.vmId,null,'the 409 id is not promoted to the record\'s guest: '+show(o));
    assert.equal(s.deferred?.vmId,foreign.id,'kept as the diagnostic: '+show(o));
    assert(!ownStops(o).some(x=>x.vmId===foreign.id),'no record-driven stop of the foreign guest: '+show(o));
    assert.equal(o.records[OWN]?.status,want,'the revocation itself stays enforced: '+show(o));
    assert.equal(o.serving[OWN],false,show(o));
    assert(!o.outcomes.some(x=>x.id===OWN&&x.outcome==='served'),'never a false success: '+show(o));
  });

// verified_held_conflicting_id: guestd's authenticated list holds OWN's guest A; the 409 names B (another deployment's)
// and B's GET answers for that deployment. A stays the identity (CPU slice: identity only, no reservation credit - the
// GPU slice's same-record credit path is unchanged code and is NOT reachable in this CPU-only harness); B never.
test('verified held id survives a 409 naming another guest: deferral keeps A, a genuine stop ends A only',async t=>{
  const o=await run(t,{guests:[own,foreign,orphan],conflictIds:{[OWN]:foreign.id},snapshotAtMs:1800,rowPatches:[[2500,OWN,{active:false}]],endMs:7000});
  const s=o.snapshot[OWN];
  assert.equal(s?.status,'claimed',show(o)); assert.equal(s.vmId,own.id,'the held list\'s id: '+show(o));
  assert.equal(s.deferred?.vmId,foreign.id,show(o)); assert(s.gpu,'the CPU slice handle is kept while deferred: '+show(o));
  assert.equal(o.records[OWN]?.status,'terminated',show(o));
  assert(ownStops(o).some(x=>x.vmId===own.id),'the genuine stop targets A: '+show(o));
  assert(!ownStops(o).some(x=>x.vmId===foreign.id),'and never B: '+show(o));
});
test('verified held id + conflicting 409, no revocation: deferred, vouched, nothing ended, released or noted',async t=>{
  const o=await run(t,{guests:[own,foreign,orphan],conflictIds:{[OWN]:foreign.id},endMs:5000});
  assert.equal(o.records[OWN]?.status,'claimed',show(o)); assert.equal(o.records[OWN].vmId,own.id,show(o));
  assert.deepEqual(ownStops(o),[],show(o)); assert(!o.deleted.includes(own.id)&&!o.deleted.includes(foreign.id),show(o));
  assert.deepEqual(o.releases.filter(r=>r.id===OWN),[],show(o)); assert.deepEqual(o.provisionFailureNotes,[],show(o));
  assert(o.events.some(e=>e.beat&&e.beat.includes(OWN)),'vouched while deferred: '+show(o));
  assert(o.outcomes.filter(x=>x.id===OWN&&x.outcome==='deferred').length>=2,'bounded retries, each deferred: '+show(o));
});
// unknown_reconnect: verified same held guest + timeout/401/malformed then reconnect adopting the SAME guest is the
// existing held-resume matrix in isolation-instance-liveness.test.mjs (now explicitly the verified-held case).

// ---- 2. provisioning continuations superseded by REAL teardown ----------------------------------------------------
test('pre_spawn_abandon: abandonClaims while launchSpec awaits - no POST, no resurrection, no obsolete note/release',async t=>{
  const o=await run(t,{gates:[{at:'launchSpec',nth:1,act:'abandon'}]});
  const g=o.gates[0]; assert.equal(g?.before?.status,'claimed',show(o));
  stale(o,g,{status:'expired',releaseWhy:ABANDON});
});
test('spawn_success_abandon: abandonClaims while spawn runs, then success - not published running, no duplicate release',async t=>{
  const o=await run(t,{gates:[{at:'spawn',nth:1,act:'abandon'}]});
  const g=o.gates[0]; stale(o,g,{status:'expired',releaseWhy:ABANDON});
  assert.equal(o.releases.filter(r=>r.id===OWN&&r.why===ABANDON).length,1,'exactly the teardown\'s release: '+show(o));
});
for (const how of ['error','unknown'])
  test(`spawn_error_abandon (${how}): abandonClaims then the spawn rejects - teardown state kept, no failure/deferral/release`,async t=>{
    const o=await run(t,{gates:[{at:'spawn',nth:1,act:'abandon',how}]});
    const g=o.gates[0]; stale(o,g,{status:'expired',releaseWhy:ABANDON});
    assert.equal(g.after.error,ABANDON,'the owner\'s evidence is the teardown\'s reason: '+show(o));
    assert.equal(g.after.deferred,false,'an unverifiable answer does not defer a torn-down record back: '+show(o));
  });
for (const how of ['resolve','error'])
  test(`spawn_ledger_move (${how}): ledgerMoveSweep while spawn runs - old record stays retired, nothing released`,async t=>{
    const o=await run(t,{gates:[{at:'spawn',nth:1,act:'ledgerMove',how}]});
    const g=o.gates[0]; stale(o,g,{status:'terminated'});
    assert.deepEqual(o.releases.filter(r=>r.id===OWN),[],'a retired ledger\'s lease is never released against the new one: '+show(o));
  });
for (const how of ['resolve','error'])
  test(`replacement_same_id (${how}): a different record under the same id/status/vmId - old completion mutates neither`,async t=>{
    const o=await run(t,{audit:false,gates:[{at:'spawn',nth:1,act:'replace',how}]});
    const g=o.gates[0], x=after(o,g);
    assert.equal(x?.outcome,'superseded',show(o)); assert.equal(x.sameObject,false,show(o));
    assert.deepEqual(x.current,g.replacedView,'the current record is exactly as installed when the old attempt completed: '+show(o));
    assert.deepEqual(g.after,g.before,'the replaced record object is not mutated either: '+show(o));
    assert.equal(g.replacementCurrent,true,show(o));
    assert.deepEqual(o.gpuReleases.filter(r=>r.t>=g.t),[],'the shared slice handle is not released: '+show(o));
    assert.deepEqual(o.releases.filter(r=>r.id===OWN),[],'the current lease is not released: '+show(o));
    assert.deepEqual(o.provisionFailureNotes,[],show(o));
  });
test('release_intent_during_await: an intent opened while launchSpec awaits - no launch, completion or release; journal identity kept',async t=>{
  const o=await run(t,{gates:[{at:'launchSpec',nth:1,act:'releaseIntent'}]});
  const g=o.gates[0]; stale(o,g,{status:'claimed'});
  assert.equal(o.intent?.same,true,'the open intent is the one the seam opened: '+show(o));
  assert.deepEqual(o.releases.filter(r=>r.id===OWN),[],show(o));
});

// actual_consumer_propagation: the audit's claimed-branch retry and its death relaunch receive a superseded result
test('audit claimed branch: a deferred retry superseded by abandonClaims is neither a failure nor a release',async t=>{
  const o=await run(t,{guests:[foreign,orphan],conflictIds:{[OWN]:foreign.id},gates:[{at:'spawn',nth:2,act:'abandon',how:'unknown'}]});
  assert(o.outcomes.some(x=>x.id===OWN&&x.outcome==='deferred'),'the first launch deferred: '+show(o));
  stale(o,o.gates[0],{status:'expired',releaseWhy:ABANDON});
});
test('audit death relaunch: a relaunch superseded by abandonClaims adds no failure note or release',async t=>{
  const o=await run(t,{vmFaults:[{id:own.id,fromMs:1500,toMs:2000,how:'failed'}],gates:[{at:'launchSpec',nth:2,act:'abandon'}]});
  const g=o.gates[0]; assert(g,'the death relaunch reached launchSpec: '+show(o));
  stale(o,g,{status:'expired',releaseWhy:ABANDON});
});
// restart route / version switch / envelope edit: same `=== false` / PROVISION_SUPERSEDED handling, code-reviewed only -
// the restart route is HTTP-only and the switch/edit need catalog and ledger scripting this fixture lacks.

// ---- 3. billing observations and respawns -------------------------------------------------------------------------
test('billing_replaced_observation: a dead read of a record replaced meanwhile - no respawn, charge, stop or release',async t=>{
  const o=await run(t,{audit:false,billing:true,vmFaults:[{id:own.id,fromMs:1500,toMs:4000,how:'gated',act:'replace'}]});
  const g=o.gates[0]; assert(g?.replacedView,'the billing read was gated: '+show(o));
  assert.equal(o.posted,g.postsAt,'no POST after the stale observation: '+show(o));
  assert.equal(g.after.consumedMs,g.before.consumedMs,'the replaced life is not charged: '+show(o));
  assert.deepEqual(g.after,g.before,show(o));
  assert.deepEqual(o.stops,[],'no reaper/teardown stop: '+show(o)); assert.deepEqual(o.releases.filter(r=>r.id===OWN),[],show(o));
  assert.equal(g.replacementCurrent,true,show(o)); assert.equal(g.replacementAfter.vmId,own.id,show(o));
  assert.deepEqual(o.gpuReleases,[],show(o));
});
test('billing_respawn_invalidated: confirmed death -> real respawn, abandonClaims during its launchSpec - no POST or rewrite',async t=>{
  const o=await run(t,{audit:false,billing:true,vmFaults:[{id:own.id,fromMs:1500,toMs:2600,how:'404'}],gates:[{at:'launchSpec',nth:2,act:'abandon'}]});
  const g=o.gates[0]; assert(g,'the respawn reached launchSpec: '+show(o));
  stale(o,g,{status:'expired',releaseWhy:ABANDON,kind:'respawn'});
});
test('billing_respawn_invalidated: replaced while the real respawn spawns - the stale result writes into neither record',async t=>{
  const o=await run(t,{audit:false,billing:true,vmFaults:[{id:own.id,fromMs:1500,toMs:2600,how:'404'}],gates:[{at:'spawn',nth:2,act:'replace'}]});
  const g=o.gates[0], x=after(o,g,'respawn'); assert(x,show(o));
  assert.notEqual(x.outcome,'served',show(o)); assert.equal(x.sameObject,false,show(o));
  assert.deepEqual(x.current,g.replacedView,'the current record is untouched by the old respawn: '+show(o));
  assert.deepEqual(g.after,g.before,'the old record keeps its identity: '+show(o));
  assert(!o.stops.length,'no record-driven stop of the returned guest: '+show(o));
});
// positive_compatibility: matching adoption, starting-not-serving, confirmed dead/404 recovery, incompatible
// same-name replacement and preemption remain the isolation-instance-liveness.test.mjs / post-adoption-lease cases.
