// Actual frozen Host class/tick/private protectedLaunch/shareUse; external services are explicitly TEST doubles.
// No Host source rewrite, private-method extraction, network, chain sends or VM execution.
// These regressions prove reachability/accounting only, NOT authenticated lifecycle/Windows/Base operation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {ENROLLMENT_SCHEMA,TEST_resetProtectedComposition} from './candidate/control/windows/node/protected-supervisor.mjs';
const hostURL=new URL('./candidate/control/windows/node/host.mjs',import.meta.url);
const HOST='0x'+'ab'.repeat(32), DEP='0x'+'cd'.repeat(32);
const fixture={host:HOST,yanked:false,rowFailure:false,reads:0,catalog:0};
globalThis.__r9HostFixture=fixture;
const exportsBySpec=new Map();
for(const m of fs.readFileSync(hostURL,'utf8').matchAll(/^import\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];/gm)) {
  if(!m[2].startsWith('.')||m[2]==='./protected-supervisor.mjs')continue;
  const names=m[1].trim().startsWith('{')?m[1].replace(/[{}]/g,'').split(',').map(x=>x.trim()).filter(Boolean):[];
  exportsBySpec.set(m[2],names);
}
const implementations={
 desktopReleaseFromEnv:'()=>null',
 loadCaps:'()=>({caps:{paused:false,cpuShare:1,gpuShare:1},error:null})',
 hostAdmissionFromEnv:'()=>null',
 createHostServiceGate:'()=>({enabled:false,serviceRefusal:()=>null,newWorkRefusal:()=>null})',
 shieldStartupEnvelope:'()=>null',
};
const chainSource=`const f=globalThis.__r9HostFixture;
 export const enclaveIdOf=()=>f.host,setLeaseJournal=()=>{},rpcUrls=()=>[],addressBook=()=>({}),setLeaseRelayPolicy=()=>{};
 export const resolvePendingReleases=async()=>[],releaseHold=()=>null,parseEnvelope=()=>({}),effectiveCpuShare=()=>0;
 export const readDeployment=async()=>{f.reads++;if(f.rowFailure)throw Error('TEST retired ledger unavailable');return {appRef:'fixture',configCid:'fixture',gpuMilli:0,cpuMilli:250,owner:'0x'+'11'.repeat(20),isPublic:true};};
 export const resolveAppRef=async()=>{f.catalog++;return {yanked:f.yanked};};`;
const hooks=registerHooks({resolve(spec,ctx,next){
  if(ctx.parentURL!==hostURL.href||!spec.startsWith('.')||spec==='./protected-supervisor.mjs')return next(spec,ctx);
  let source;
  if(spec==='./chain.mjs')source=chainSource;
  else if(spec==='./isolation-client.mjs')source='export class IsolationManagerClient { constructor(){ } }';
  else if(spec==='./isolation-lifecycle.mjs')source="export const reconcile=()=>{throw Error('TEST unexpected actual stage');};";
  else {const names=exportsBySpec.get(spec);if(!names)throw Error('TEST unlisted dependency '+spec);
    source=names.map(name=>`export const ${name}=${implementations[name]||`(...args)=>{throw Error(${JSON.stringify('TEST unexpected dependency '+spec+':'+name)});}`};`).join('\n');}
  return {url:'data:text/javascript;base64,'+Buffer.from(source).toString('base64'),shortCircuit:true};
}});
const {Host}=await import(hostURL.href);
function makeHost(t){
  TEST_resetProtectedComposition();fixture.yanked=false;fixture.rowFailure=false;fixture.reads=0;fixture.catalog=0;
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r9host-'));
  const policy={schema:ENROLLMENT_SCHEMA,host:HOST,manager:'http://127.0.0.1:1',controlKeyFile:path.join(dir,'TEST-key'),deployments:[DEP],stagingMs:30000};
  const bytes=Buffer.from(JSON.stringify(policy));const file=path.join(dir,'enrollment.json');fs.writeFileSync(file,bytes);
  fs.writeFileSync(policy.controlKeyFile,'11'.repeat(32),{mode:0o600});
  process.env.ENCLAVE_PROTECTED_ENROLLMENT=file;process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256=createHash('sha256').update(bytes).digest('hex');
  const host=new Host({dir,endpoint:'TEST',appsEnabled:true,ownerStartup:null,walletAdmission:null});
  host.chainReady=true;host.registered={};
  for(const name of ['followBook','enforceOff','refreshOwners','ensureRegistered','ensurePriced','scanLedger','retireForeignRecovered'])host[name]=async()=>{};
  host.sharesCoupled=()=>false;
  const reached=[];
  host.isolationVerdict=async(id)=>{reached.push(id);return {ok:false,unknown:true,input:'TEST',why:'reachability probe; no stage permitted'};};
  t.after(()=>{delete process.env.ENCLAVE_PROTECTED_ENROLLMENT;delete process.env.ENCLAVE_PROTECTED_ENROLLMENT_SHA256;TEST_resetProtectedComposition();fs.rmSync(dir,{recursive:true,force:true});});
  return {host,reached};
}
test('ROOT actual Host positive control reaches protected reconciliation with unchanged catalog',async t=>{
 const {host,reached}=makeHost(t);await host.tick();assert.deepEqual(reached,[DEP]);assert.equal(fixture.catalog,1);
});
test('ROOT actual Host must not veto independent protected reconciliation solely on publisher yank',async t=>{
 const {host,reached}=makeHost(t);fixture.yanked=true;await host.tick();
 assert.deepEqual(reached,[DEP],'publisher metadata must not block the protected consumer before authority/withdrawal reconciliation');
});
test('ROOT actual Host must reconcile enrolled route while retired book lookup fails',async t=>{
 const {host,reached}=makeHost(t);host.followBook=async()=>{throw Error('TEST retired book unavailable');};
 let error;try{await host.tick();}catch(e){error=e.message;}
 assert.deepEqual(reached,[DEP],`old book must not precede independent reconciliation (observed ${error})`);
});
test('ROOT actual Host must count recovered lifecycle commitments alongside ordinary neighbors',t=>{
 const {host}=makeHost(t);host.records.set('neighbor',{id:'neighbor',status:'running',cpuShare:.2,gpuShare:.1});
 host.lifecycleView().record(DEP,{id:DEP,status:'held',lifecycleAllocated:true,lifecycleCapacity:'committed',cpuShare:.4,gpuShare:.3});
 assert.equal(host.shareUse().cpu,.2+.4,'pending/recovered lifecycle allocation must remain reserved before an instance id is known');
 assert.equal(host.lifecycleView().capacity('new').gpuUsed,.1+.3);
});
test.after(()=>{hooks.deregister();delete globalThis.__r9HostFixture;});
