// An unavailable guestd is not a dead guest. The REAL supervisor (DIRECT_CLAIM_SELFTEST's lifecycle mode: the claim
// loop's audit + sweep stages - considerClaim -> tryClaim -> adopt -> provisionTenant -> performTenantProvision ->
// spawnContainer -, vouchTenants/reconcileInstances and, where named, the billing ticker) against a scripted guestd whose
// GET /vms/<id> fails or answers unreadably in a window (L.vmFaults). Same fixture and 1:100 scale as
// isolation-post-adoption-lease.test.mjs. SUPERVISOR_UNDER_TEST names the file, so the same timelines run against the
// unrepaired one. Credentials are synthetic. Scripted transport throws stand in for guestd-control/1 failures; the real
// control-client failure/reconnect path is root's separate qualification.
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
const OWN=manifest.deployment, ORPHAN='0x'+'99'.repeat(32);
const guest=(id,name,extra={})=>({id,name,appId:manifest.appId,runtimeId:manifest.runtimeId,recordSha256:recordSha,directBootstrap:true,
  bootstrapSha256:pkg.sha256,createdAt:now-86400,leaseLeftMs:1840,reserved:{memMiB:1792,cpuPct:100},...extra});
const own=guest('gdown00001',OWN), orphan=guest('gdorph0001',ORPHAN,{recordSha256:'cc'.repeat(32)});
const rows=[row(),row({id:ORPHAN,runner:other})];
const admitted={serving:true,status:'current-admit',reason:'admitted'};
const scale={ttlMs:3000,silenceMs:1800,reconcileMs:600,claimMs:600,claimOffsetMs:300,reclaimMs:400,lastBeatAgoMs:1160};

function env(t,extra){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'liveness-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'pins.json');fs.writeFileSync(file,JSON.stringify({version:1,chainId:8453,contracts:pins}));
  return {PATH:process.env.PATH,SECRET:'direct-test-secret',ENABLE_MPS:'0',STATE_FILE:path.join(dir,'state.json'),
    ISOLATION_DIRECT_ONLY:'1',ISOLATION_BACKEND:tier,PROVISION_BACKEND:'vm',ENCLAVE_CONTRACT_PINS_FILE:file,ADDRESS_BOOK_ADDRESS:'',
    SECRETS_API:'',DOMAINS_API:'',CERTS_API:'',DNS_API:'',APP_CERT_DOMAIN:'',
    GUEST_BOOTSTRAP_GATEWAYS:A,IPFS_GATEWAY:JSON.stringify([new URL(A).origin]),
    REGISTRY_ENABLED:'1',REGISTRY_PRIVATE_KEY:'0x'+'01'.repeat(32),ENCLAVE_REPO:'independent/host',CLAIM_ENABLED:'1',
    PROVISION_DEFER_MS:'300',BILL_TICK_SEC:'1',...extra};
}
async function run(t,lifecycle,{rowsOf=rows,healthOf=health,extraEnv={}}={}){
  const config={catalog,health:healthOf,appId:manifest.appId,bytes:pkg.bytes.toString('base64'),enclaveId,endpoint:'https://host.independent.example',
    leaseUntil:now+3600,rows:rowsOf,replicas:{[A]:'serve'},lifecycle:{...scale,guests:[own,orphan],gate:[[0,admitted]],audit:true,endMs:6500,...lifecycle}};
  const {stdout}=await exec(process.execPath,[SUP],{cwd:new URL('..',import.meta.url),timeout:60000,
    env:{...env(t,extraEnv),DIRECT_CLAIM_SELFTEST:JSON.stringify(config)},maxBuffer:8<<20}).catch(e=>{throw Error(e.stderr||e.message);});
  return JSON.parse(stdout.trim().split('\n').at(-1));
}
const show=o=>JSON.stringify({events:o.events,records:o.records,detail:o.detail,snapshot:o.snapshot,deleted:o.deleted,txs:o.txs,
  notes:o.provisionFailureNotes,releases:o.releases,auditErrors:o.auditErrors,serving:o.serving});
const launches=o=>o.managerCalls.filter(c=>c.method==='POST'&&c.path==='/vms');
const created=o=>o.events.filter(e=>e.created);
const alive=(o,id)=>o.vms.some(v=>v.id===id);
// nothing destructive or authorization-changing happened to the held guest or its lease
function untouched(o,vmId=own.id){
  assert(!o.deleted.includes(vmId),'no DELETE of the held guest: '+show(o));
  assert.deepEqual(created(o),[],'no new guest: '+show(o));
  assert.deepEqual(o.txs,[],'no claim/release transaction: '+show(o));
  assert.deepEqual(o.releases.filter(r=>r.id===OWN),[],'no lease release: '+show(o));
  assert.deepEqual(o.provisionFailureNotes.filter(n=>n.id===OWN),[],'no provision-failure ladder: '+show(o));
  assert.equal(o.detail[OWN]?.deaths,0,'no death counted: '+show(o));
  assert(alive(o,vmId),'the held guest still runs: '+show(o));
}
const UNKNOWN=['timeout','econnreset','econnrefused','401','mac','json','503','malformed','unexpected','mismatch','wrongname'];

// held_resume_409_unknown_end_to_end + adoption_409_unknown: a cold boot resumes its own live lease; POST /vms answers 409
// for the held same-record guest and the follow-up GET is unverifiable until 2.4 s. Deferred (claimed, reserved, vouched,
// never reaped), then the audit's bounded retry adopts the SAME guest once guestd answers.
for (const how of ['timeout','401','json','malformed','503','mismatch','wrongname','econnreset','mac'])
  test(`held resume: POST 409 then an unverifiable GET (${how}) defers without DELETE/release, then adopts the same guest`,async t=>{
    const o=await run(t,{vmFaults:[{id:own.id,fromMs:0,toMs:2400,how}],snapshotAtMs:1800});
    untouched(o);
    const s=o.snapshot[OWN];
    assert(s&&s.status==='claimed','deferred, nonterminal, not serving while unverifiable: '+show(o));
    assert.equal(s.vmId,own.id,show(o)); assert.equal(s.deferred?.vmId,own.id,show(o));
    assert(s.gpu,'the held reservation is kept while deferred: '+show(o));
    assert(o.events.some(e=>e.beat&&e.t>=900&&e.t<2400&&e.beat.includes(OWN)),'vouched while deferred: '+show(o));
    assert(!alive(o,orphan.id),'the reconciler still reaps a real orphan: '+show(o));
    assert.equal(o.records[OWN]?.status,'running',show(o)); assert.equal(o.records[OWN].vmId,own.id,show(o));
    assert.equal(o.detail[OWN].gpu,s.gpu,'same reservation: '+show(o));
    assert.equal(o.detail[OWN].leaseUntil,rows[0].leaseUntil,'same lease: '+show(o));
    assert.equal(o.serving[OWN],true,show(o));
    assert(launches(o).length<=6,'bounded retry, not every tick: '+show(o));
  });

// adoption_409_same: no fault - adopted by id, nothing created or ended
test('held resume: POST 409 then the exact same record adopts the original guest',async t=>{
  const o=await run(t,{});
  untouched(o); assert.equal(o.records[OWN]?.vmId,own.id,show(o)); assert.equal(launches(o).length,1,show(o));
});

// adoption_409_different: a verified answer that the guest under this name is another record keeps deliberate replacement
test('held resume: POST 409 then an authenticated incompatible record is replaced',async t=>{
  const o=await run(t,{vmFaults:[{id:own.id,fromMs:0,toMs:1200,how:'incompatible'}]});
  assert(o.deleted.includes(own.id),show(o)); assert(created(o).length>=1,show(o));
  assert.equal(o.records[OWN]?.status,'running',show(o));
});

// audit_timeout / audit_connection_refused / audit_authentication / audit_unreadable / audit_transient_401: a resumed,
// running guest whose observation is unverifiable for 2.5 s, then running again
for (const how of UNKNOWN)
  test(`audit: running guest unverifiable (${how}) keeps guest, lease, reservation and crash count`,async t=>{
    const o=await run(t,{vmFaults:[{id:own.id,fromMs:1500,toMs:4000,how}],snapshotAtMs:3500});
    untouched(o);
    assert.equal(o.snapshot[OWN]?.status,'running',show(o)); assert.equal(o.snapshot[OWN].vmId,own.id,show(o));
    assert.equal(launches(o).length,1,'only the resume adoption ever POSTed: '+show(o));
    assert.equal(o.records[OWN].vmId,own.id,show(o)); assert.equal(o.serving[OWN],true,show(o));
  });

// billing_race: /health answers 200 while the instance read is unverifiable - the billing ticker must not respawn
for (const how of ['timeout','503','malformed'])
  test(`billing: healthy manager, unverifiable instance (${how}) - no respawn`,async t=>{
    const o=await run(t,{billing:true,vmFaults:[{id:own.id,fromMs:1500,toMs:4500,how}]});
    untouched(o); assert.equal(launches(o).length,1,show(o));
  });

// confirmed_running_starting: starting is live (no crash handling) but never serving
test('authenticated starting: live for crash suppression, not a serving proof',async t=>{
  const o=await run(t,{vmFaults:[{id:own.id,fromMs:1500,toMs:999999,how:'starting'}]});
  untouched(o); assert.equal(o.records[OWN]?.status,'running',show(o)); assert.equal(o.serving[OWN],false,show(o));
});

// confirmed_dead: an authenticated terminal state or 404 for the exact instance keeps crash recovery actionable
for (const how of ['failed','stopped','404'])
  test(`authenticated ${how}: crash recovery runs (death counted, guest ended and relaunched)`,async t=>{
    const o=await run(t,{vmFaults:[{id:own.id,fromMs:1500,toMs:2000,how}]});
    assert((o.detail[OWN]?.deaths||0)>=1,show(o)); assert(o.deleted.includes(own.id),show(o));
  });

// preempted: the preemption branch (no death, own backoff); a later unavailable window manufactures nothing
test('authenticated preemption keeps its distinct handling; later unavailability is not a death',async t=>{
  const o=await run(t,{vmFaults:[{id:own.id,fromMs:1500,toMs:2000,how:'preempted'},{id:own.id,fromMs:2000,toMs:3500,how:'timeout'}]});
  assert(o.detail[OWN]?.preemptedAt||o.records[OWN]?.status==='running',show(o));
  assert.equal(o.detail[OWN]?.deaths,0,show(o)); assert.deepEqual(o.provisionFailureNotes,[],show(o));
});

// authorization_change: owner stop and lease loss stay enforced while the instance is unverifiable, running or deferred
for (const [what,patch,want] of [['owner stop',{active:false},'terminated'],['lease loss',{runner:other},'expired']])
  for (const from of [0,1500])
    test(`${what} while the guest is unverifiable (from ${from} ms) is still enforced`,async t=>{
      const o=await run(t,{vmFaults:[{id:own.id,fromMs:from,toMs:999999,how:'timeout'}],rowPatches:[[2500,OWN,patch]],endMs:7000});
      assert.equal(o.records[OWN]?.status,want,show(o));
      assert.equal(o.detail[OWN]?.deaths||0,0,show(o)); assert.deepEqual(created(o),[],show(o));
    });

// identity_changed_during_await: the billing ticker's read is slow and answers 404 after the audit retired the record
// on an owner stop; that stale observation must not relaunch anything
test('a stale observation of a record stopped meanwhile relaunches nothing',async t=>{
  const o=await run(t,{billing:true,vmFaults:[{id:own.id,fromMs:1500,toMs:3000,how:'slow404',delayMs:900}],rowPatches:[[1500,OWN,{active:false}]]});
  assert.equal(o.records[OWN]?.status,'terminated',show(o));
  assert.equal(launches(o).length,1,show(o)); assert.deepEqual(created(o),[],show(o));
});

// eyesoff_fixture: the public held-guest identity and reservation (CURRENT-GUEST-FIXTURE.json: 64281 MiB, 1600%) on the
// original positive 98304 MiB / 24 CPU budget, through a deferred resume and recovery. The record digest is this
// fixture's synthetic derivation, not the live guest's.
test('eyesoff-shaped held guest: unknown then running resumes the same guest id and reservation',async t=>{
  const fx=guest('gd61126785',OWN,{reserved:{memMiB:64281,cpuPct:1600}});
  const o=await run(t,{guests:[fx],vmFaults:[{id:fx.id,fromMs:0,toMs:2400,how:'timeout'}],snapshotAtMs:1800},
    {rowsOf:[row({cpuMilli:1000})],healthOf:{...health,pool:pool(98304,2400)}});
  untouched(o,fx.id); assert.equal(o.snapshot[OWN]?.status,'claimed',show(o));
  assert.equal(o.records[OWN]?.vmId,fx.id,show(o)); assert.equal(o.records[OWN].status,'running',show(o));
});
