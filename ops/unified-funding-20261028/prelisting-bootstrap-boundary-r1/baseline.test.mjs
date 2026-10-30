import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCpuWorkload} from '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source/availability/workload.mjs';
import {createShieldExpectations} from '/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source/availability/shield.mjs';
const id='0x'+'12'.repeat(32),host='0x'+'34'.repeat(32),app='56'.repeat(32);
const job={deployment:{id},offer:{hostId:host,durationSec:2n},token:'PUBLIC_TEST_TOKEN',lease:{leaseUntil:0n},candidateOrigin:'https://independent.example/'};
test('legacy workload cannot execute an unlisted candidate even with a bounded local test authorization',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'prelisting-boundary-'));
 try {
  const ref=path.join(dir,'reference');
  await fs.writeFile(ref,'#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({digest:"fixture",rounds:1,memory_bytes:0,passes:1})));\n',{mode:0o700});
  let requests=0;
  const workload=createCpuWorkload({referenceBinary:ref,requestVerified:async()=>{requests++;throw new Error('must not reach transport');},rounds:1,memoryMiB:0,passes:1,timeoutMs:1000});
  await assert.rejects(workload.runAndVerify({...job,bootstrapAuthorization:{kind:'TEST-local-only',expiresAt:Date.now()+5000}}),/insufficient paid lease/);
  assert.equal(requests,0);
 } finally { await fs.rm(dir,{recursive:true}); }
});
function loader(row,counts){
 return createShieldExpectations({readRow:async()=>{counts.row++;return row;},readCatalog:async()=>{throw new Error('mock derivation only');},readConfig:async()=>{throw new Error('mock derivation only');},fetchVerified:async()=>{throw new Error('mock derivation only');},policy:{cpu:{runtimeId:'TEST-runtime'}},appRef:'TEST-app',expect:async()=>{counts.expect++;return{runtimeId:'TEST-runtime',appSha256:app};},hostSession:async()=>{counts.session++;return{session:{TEST:true},atMs:1000};}});
}
test('legacy Shield expectations reject an unlisted job before attestation session acquisition',async()=>{
 const counts={row:0,expect:0,session:0};
 await assert.rejects(loader(null,counts)(job),/ledger holds no such deployment/);
 assert.deepEqual(counts,{row:1,expect:0,session:0});
});
test('legacy successful Shield expectation selects Enclave DNS despite an independent candidate origin',async()=>{
 const counts={row:0,expect:0,session:0};
 const result=await loader({id,active:true,isPublic:true,runner:host,appRef:'TEST-app'},counts)(job);
 assert.equal(result.origin,'https://12121212.app.enclave.host/');
 assert.notEqual(result.origin,job.candidateOrigin);
 assert.deepEqual(counts,{row:1,expect:1,session:1});
});
