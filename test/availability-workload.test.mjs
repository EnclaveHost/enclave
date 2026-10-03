import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createCpuWorkload} from '../availability/workload.mjs';
test('result acceptance requires live identity binding, exact output and sufficient lease',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'capacity-reference-'));
 try {
  const binary=path.join(dir,'reference');const body={digest:'reference',rounds:1,memory_bytes:0,passes:1};
  await fs.writeFile(binary,'#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>console.log('+JSON.stringify(JSON.stringify(body))+'));\n',{mode:0o700});
  const job={token:'secret',offer:{hostId:'host',durationSec:2n},deployment:{id:'deployment'},lease:{leaseUntil:BigInt(Math.floor(Date.now()/1000)+60)}};
  const good={body,hostId:'host',deploymentId:'deployment',attestationVerified:true};
  const make=actual=>createCpuWorkload({referenceBinary:binary,requestVerified:async()=>actual,rounds:1,memoryMiB:0,passes:1,timeoutMs:1000});
  assert.equal((await make(good).runAndVerify(job)).verified,true);
  for(const bad of [{...good,attestationVerified:false},{...good,hostId:'other'},{...good,deploymentId:'other'},{...good,body:{...body,digest:'wrong'}}])await assert.rejects(make(bad).runAndVerify(job));
  await assert.rejects(make(good).runAndVerify({...job,lease:{leaseUntil:0n}}),/paid lease/);
  assert.throws(()=>createCpuWorkload({referenceBinary:binary,requestVerified:async()=>good,rounds:1,memoryMiB:256,passes:1,timeoutMs:1000,referenceMemoryBudgetMiB:128}),/memory budget/);
 }finally{await fs.rm(dir,{recursive:true});}
});
