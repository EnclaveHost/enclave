// A control cutover on the per-app guest tier (metal0 2026-10-21): the new control boots while guestd still runs the
// guests the previous control launched and vouched for. The REAL supervisor (DIRECT_CLAIM_SELFTEST's lifecycle mode: its
// claim sweep stage, considerClaim -> adopt -> provisionTenant, vouchTenants and reconcileInstances at their production
// cadence) against guestd's own dead-man rules (server.go lease/leaseExpired/tick/destroy, scaled 1:100: TTL 300 s,
// Silence 180 s, passes every 60 s, a guest's stop taking 40 s, during which it still reads "running" and holds its name).
// SUPERVISOR_UNDER_TEST names the file (default supervisor.js), so the same timelines run against the unrepaired one.
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
const health={backend:tier,catalog:{runtimeId:manifest.runtimeId,derivations:['enclave-catalog-bundle/1']},supports:{directBootstrap:true,gpu:false,protectedPorts:true},
  pool:{budget:{memMiB:32768,cpuPct:800},allocated:{memMiB:0,cpuPct:0},free:{memMiB:32768,cpuPct:800},guests:0,overcommitted:false,perGuest:{floorMiB:1024,runtimeMiB:384,unitOverheadMiB:768},hostAvailableMiB:65536,hostFloorMiB:16384}};
const now=Math.floor(Date.now()/1000);
const row=(o={})=>({id:manifest.deployment,owner,appRef:manifest.appRef,configCid:JSON.stringify({guestBootstrap:pkg.intent}),active:true,isPublic:true,
  gpuMilli:0,cpuMilli:100,leaseUntil:now+3600,runner:enclaveId,balance6:10_000_000,rate:1,spent6:0,createdAt:now-86400,...o});
const A='http://192.0.2.10:8189/ipfs';
const expectedDerive={derivation:'enclave-catalog-bundle/1',catalog:{app,version:0},cid:catalog.cid,policy:{cpuPercent:100,memMiB:256,vcpus:1},runtimeId:manifest.runtimeId};
const canon=v=>Array.isArray(v)?`[${v.map(canon).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')}}`:JSON.stringify(v);
const recordSha=createHash('sha256').update(canon(expectedDerive)).digest('hex');

// the paid guest the previous control launched for this host's live lease, and guests no lease of this host backs
const OWN=manifest.deployment, ORPHAN='0x'+'99'.repeat(32), HELD='0x'+'77'.repeat(32);
const guest=(id,name,extra={})=>({id,name,appId:manifest.appId,runtimeId:manifest.runtimeId,recordSha256:recordSha,directBootstrap:true,
  bootstrapSha256:pkg.sha256,createdAt:now-86400,leaseLeftMs:1840,reserved:{memMiB:1792,cpuPct:100},...extra});
const own=guest('gdown00001',OWN), orphan=guest('gdorph0001',ORPHAN,{recordSha256:'cc'.repeat(32)}), held=guest('gdheld0001',HELD);
const rows=[row(),row({id:ORPHAN,runner:other}),row({id:HELD})];   // ORPHAN: another host's lease; HELD: ours, release unresolved
const unreadable={serving:false,status:'unreadable',reason:'policy unreadable: RPCs disagree or only 2 RPCs could read block 52887497 (need 3; rpc_refused)'};
const admitted={serving:true,status:'current-admit',reason:'admitted'};
const banned={serving:false,banned:true,status:'current',reason:'this host is refused by the platform'};
// 1:100 - guestd's lease/silence and the passes; the previous control last beat 116 s before, its lease 183.9 s left
const scale={ttlMs:3000,silenceMs:1800,reconcileMs:600,claimMs:600,claimOffsetMs:300,reclaimMs:400,lastBeatAgoMs:1160};

function env(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'post-adoption-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'pins.json');fs.writeFileSync(file,JSON.stringify({version:1,chainId:8453,contracts:pins}));
  return {PATH:process.env.PATH,SECRET:'direct-test-secret',ENABLE_MPS:'0',STATE_FILE:path.join(dir,'state.json'),
    ISOLATION_DIRECT_ONLY:'1',ISOLATION_BACKEND:tier,PROVISION_BACKEND:'vm',ENCLAVE_CONTRACT_PINS_FILE:file,ADDRESS_BOOK_ADDRESS:'',
    SECRETS_API:'',DOMAINS_API:'',CERTS_API:'',DNS_API:'',APP_CERT_DOMAIN:'',
    GUEST_BOOTSTRAP_GATEWAYS:A,IPFS_GATEWAY:JSON.stringify([new URL(A).origin]),
    REGISTRY_ENABLED:'1',REGISTRY_PRIVATE_KEY:'0x'+'01'.repeat(32),ENCLAVE_REPO:'independent/host',CLAIM_ENABLED:'1'};
}
async function cutover(t,lifecycle){
  const config={catalog,health,appId:manifest.appId,bytes:pkg.bytes.toString('base64'),enclaveId,endpoint:'https://host.independent.example',
    leaseUntil:now+3600,rows,replicas:{[A]:'serve'},lifecycle:{...scale,...lifecycle}};
  const {stdout}=await exec(process.execPath,[SUP],{cwd:new URL('..',import.meta.url),timeout:60000,
    env:{...env(t),DIRECT_CLAIM_SELFTEST:JSON.stringify(config)},maxBuffer:8<<20}).catch(e=>{throw Error(e.stderr||e.message);});
  return JSON.parse(stdout.trim().split('\n').at(-1));
}
const alive=(out,id)=>out.vms.some(v=>v.id===id);
const ended=(out,id)=>out.events.filter(e=>e.deleted===id||e.lapsed===id);
const show=out=>JSON.stringify({events:out.events,vms:out.vms,records:out.records,declines:out.declines});

// The incident's shape: the first sweep holds (policy unreadable), the policy reads again ~70 s later and the sweep resumes
// the lease - while the reaper pass in between treats the unresumed guest as an orphan. Both orders of guestd's listing:
// the own guest's DELETE in flight when the resume adopts it, or queued behind the orphan's and sent after the adoption.
for (const [order,guests] of [['own guest listed first',[own,orphan,held]],['own guest listed after the orphan',[orphan,own,held]]])
  test(`an unreadable policy at boot, then admitted: the paid guest is adopted ALIVE and kept; the orphan is reaped (${order})`,async t=>{
    const out=await cutover(t,{guests,releaseHeld:[HELD],gate:[[0,unreadable],[1100,admitted]],endMs:6500});
    assert.equal(out.records[OWN]?.status,'running',show(out));
    assert.equal(out.records[OWN].vmId,own.id,'the resume adopted the guest the previous control launched: '+show(out));
    assert.deepEqual(ended(out,own.id),[],'the paid guest was neither deleted nor let lapse: '+show(out));
    assert(alive(out,own.id),'it is still running at the end, past one more full lease TTL: '+show(out));
    assert(!out.events.some(e=>e.created),'nothing was launched again: '+show(out));
    // a guest no lease of this host backs still ends (its lease lapses or the reaper deletes it)
    assert(!alive(out,orphan.id)&&ended(out,orphan.id).length>0,show(out));
    // a lease whose release from this host is unresolved is not vouched for: its guest is handed back, never resumed
    assert(!alive(out,held.id)&&out.records[HELD]==null,show(out));
    assert.match(out.declines[HELD]||'',/release of this deployment from this host is unresolved/);
    assert.deepEqual(out.txs,[],'a resume sends no transaction');
  });

test('a cold boot whose ledger read fails for ~4 minutes, then an unreadable policy past a whole lease TTL: the paid guest survives and is adopted',async t=>{
  const out=await cutover(t,{guests:[own,orphan],gate:[[0,unreadable],[4500,admitted]],ledgerFromMs:2500,endMs:8500});
  assert.equal(out.records[OWN]?.status,'running',show(out));
  assert.equal(out.records[OWN].vmId,own.id,show(out));
  assert.deepEqual(ended(out,own.id),[],show(out));
  assert(alive(out,own.id),show(out));
  // no heartbeat before this host knew its own leases: guestd's silence rule kept every guest, the orphan included...
  const first=out.events.find(e=>e.beat);
  assert(first&&first.t>=2500&&first.beat.includes(OWN),'the first beat came after the first ledger read and named the own lease: '+show(out));
  // ...and once it beat, the orphan (its lease long past) ended
  assert(!alive(out,orphan.id)&&ended(out,orphan.id).length>0,show(out));
});

test('an explicit platform refusal: the host stops vouching, its guests end and nothing is resumed',async t=>{
  const out=await cutover(t,{guests:[own,orphan],gate:[[0,banned]],endMs:6000});
  assert(!alive(out,own.id)&&ended(out,own.id).length>0,show(out));
  assert(!alive(out,orphan.id),show(out));
  assert.equal(out.records[OWN],null,show(out));
  assert.match(out.declines[OWN]||'',/platform host policy: this host is refused/);
  assert(out.events.filter(e=>e.beat).every(e=>!e.beat.includes(OWN)),'never vouched: '+show(out));
  assert.deepEqual(out.txs,[]);
});
