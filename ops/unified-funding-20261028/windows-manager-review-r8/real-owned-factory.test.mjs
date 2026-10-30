// SOURCE-ONLY PROPOSAL, NOT EXECUTED. ROOT runs after reviewing the dependency tree and resource bounds.
// REAL: r8 composeProtectedAuthority -> real R18 openOwnedHostRegistryLifecycle -> actual parent journal,
// both owned sidecars/Linux flock, gate/runtime, composeIndependentLifecycle/createLifecycleDispatch and route validation.
// TEST doubles, explicitly LIMITED: canonical chain adapter identity/methods use the reviewed R18 O8 construction;
// finality, permit collector, manager/readiness/boundaries are inert constructors. No chain read, VM launch, RPC,
// signing, transaction, funding, Windows qualification or positive production-authority claim occurs.
// Crucially: no routes are invented, no precheck is replaced, no owned factory/dispatch/journal is mocked.
// This positive opening regression is EXPECTED TO FAIL on frozen r8 because accepted authority config cannot
// supply the routes mandatory in the actual R18 constructor. It checks real lock acquisition/cleanup before failing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const candidate = process.env.ENCLAVE_R8_FACTORY_CANDIDATE;
const network = process.env.ENCLAVE_R18_NETWORK_ROOT;
const tempRoot = process.env.TEST_TMPDIR;
for (const [k,v] of Object.entries({candidate,network,tempRoot})) {
  if (!v || !path.isAbsolute(v)) throw Error(`root must supply an absolute ${k} path; no implicit workspace or production defaults`);
}
const sha = b => createHash('sha256').update(b).digest('hex');
const pinnedImport = async (file, hash) => {
  assert.equal(sha(fs.readFileSync(file)), hash, `reviewed source differs: ${file}`);
  return import(pathToFileURL(file).href);
};
const own = await pinnedImport(path.join(network,'lifecycle-host-owned-authority.mjs'), 'ee1f93c8ab968ab6b26e3f38a18cf66604d476b87acd37acd7e9cb09ea6c302c');
const locks = await pinnedImport(path.join(network,'owned-durable-state.mjs'), '2bfe43b939a979dba3c9bfa42c2157c20968e7c85b191559eb8e8181d65ce1d1');
const factory = await import(pathToFileURL(path.join(candidate,'control/windows/node/protected-authority-factory.mjs')).href);
const supervisor = await import(pathToFileURL(path.join(candidate,'control/windows/node/protected-supervisor.mjs')).href);
const hostAuthority = await import(pathToFileURL(path.join(candidate,'control/network/deployment-host-authority.mjs')).href);
const H = b => '0x'+b.repeat(32), A = b => '0x'+b.repeat(20);
// Exact identity/profile construction from frozen R18 root-ownership-lifecycle.test.mjs O8.
const HOST=H('a1'), CTRL=A('c7'), REG=A('ab'), CODE=H('23'), LEDGER=A('e2');
const PROFILE='independent-host-registry-r1';
const BUNDLE='bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e';
const ARTIFACT='e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a';
const PINS={chainId:8453,lifecycle:CTRL,servingPermit:{version:2,profile:PROFILE}};
const ADAPTER_PINS={chainId:8453,host:HOST,profile:PROFILE,payee:A('99'),hostRegistry:{artifactSha256:ARTIFACT},contracts:{
  registry:{address:REG,codeHash:CODE},hostOwnership:{address:REG,codeHash:CODE},
  ledger:{address:LEDGER,codeHash:H('11')},lifecycle:{address:CTRL,codeHash:H('22')},catalog:{address:A('cd'),codeHash:H('24')},
}};

test('ROOT production factory opens real R18 owned runtime from its accepted config, without invented routes', {timeout:15000}, async t => {
  supervisor.TEST_resetProtectedComposition();
  const dir=fs.mkdtempSync(path.join(tempRoot,'r8-real-factory-'));
  fs.chmodSync(dir,0o700);
  t.after(()=>supervisor.TEST_resetProtectedComposition());
  const write=(name,value)=>{
    const file=path.join(dir,name),bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value));
    fs.writeFileSync(file,bytes,{mode:0o600});return {file,sha256:sha(bytes)};
  };
  const calls=[];
  const never=label=>async()=>{calls.push(label);throw Error(`TEST: ${label} must not run during constructor qualification`);};
  const reader=write('reader.mjs','export async function createAnchorReader(){return async()=>{throw Error("TEST anchor must not be read during constructor qualification")}}');
  const cfg={schema:factory.AUTHORITY_SCHEMA,host:HOST,journalFile:path.join(dir,'parent.json'),parentImportSha256:null,
    incarnationFile:path.join(dir,'inc.json'),permitFile:path.join(dir,'permit.json'),pins:write('pins.json',PINS),
    adapterPins:write('adapter-pins.json',ADAPTER_PINS),witnesses:{endpoints:[],timeoutMs:1000},
    operatorKeyFile:write('public-test-key.txt','0x'+'11'.repeat(32)).file,
    finality:{readerModule:reader.file,readerModuleSha256:reader.sha256,readerOptions:{},verifier:{url:'http://127.0.0.1:1'},maxAnchorAgeSec:3600},
    hostPolicyDir:dir,platformWallets:[],capacityHeadroom:0,lock:{flockPath:'/usr/bin/flock',timeoutMs:1000,withdrawDeadlineMs:1000}};
  const c=write('authority.json',cfg);
  const adapter={authorityKind:'derived',profile:PROFILE,lifecycleSchema:3,lifecycleProofSchema:2,bundleSha256:BUNDLE,
    hostRegistry:{address:REG,runtimeCodeHash:CODE,artifactSha256:ARTIFACT},
    independence:{complete:false,blockers:['TEST canonical adapter stand-in, same construction as R18 O8']},
    read:never('chain read'),prepare:never('transition preparation'),submit:never('transaction submit'),
    resolve:never('receipt reconciliation'),finalize:never('transition finalization')};
  const modules={owned:own,hostAuthority,
    accounts:{privateKeyToAccount:()=>({address:A('12')})},
    chain:{createLifecycleChainAdapter:()=>adapter},
    finality:{createLifecycleFinalitySnapshot:()=>never('finality snapshot')},
    collector:{createPermitCollector:()=>never('permit collection')}};
  assert.equal(modules.owned.openOwnedHostRegistryLifecycle,own.openOwnedHostRegistryLifecycle);
  const composed=await factory.composeProtectedAuthority({hostId:HOST,env:{
    ENCLAVE_PROTECTED_ENROLLMENT:path.join(dir,'not-read-by-factory-enrollment.json'),
    ENCLAVE_PROTECTED_AUTHORITY:c.file,ENCLAVE_PROTECTED_AUTHORITY_SHA256:c.sha256},modules});
  assert.ok(composed);
  const adapters={client:{findByName:never('VM inventory'),spawn:never('VM launch'),remove:never('VM removal')},
    plans:{read:never('plan')},readiness:{verify:never('readiness')},boundaries:{hold:never('hold'),allow:never('allow')},
    collectPermit:never('runtime permit collection')};
  let opened=null, error=null;
  try { opened=await supervisor.composition.openRuntime({host:HOST,bind:()=>adapters}); }
  catch(e){error=e;}
  if(opened) {
    assert.equal(opened.runtime.hostAuthorityPermit,true);
    assert.equal((await opened.release('TEST constructor cleanup')).released,true);
  }
  assert.deepEqual(calls,[], 'constructor test must not perform any chain, VM or financial operation');
  for(const f of [cfg.journalFile+'.parent-established',cfg.incarnationFile+'.established',cfg.permitFile+'.established'])
    assert.ok(fs.existsSync(f),`actual owned journal establishment must have been reached: ${path.basename(f)}`);
  // Failure must release all actual locks; require new acquisition rather than assuming async constructor cleanup finished.
  for(const f of [cfg.journalFile,cfg.incarnationFile,cfg.permitFile]) {
    const lock=await locks.openOwnedLock(f,{flockPath:'/usr/bin/flock',timeoutMs:1000});
    lock.release();
  }
  t.diagnostic(JSON.stringify({actualOwnedJournalsEstablished:true,allThreeLocksReacquired:true,
    unexpectedOperationalCalls:calls,constructorError:error?.message??null,noRoutesInjected:true}));
  fs.rmSync(dir,{recursive:true,force:true}); // only this test's exact private directory, after all locks are confirmed released
  assert.ifError(error); // frozen r8 fails here: "at least one explicit lifecycle route is required"
});
