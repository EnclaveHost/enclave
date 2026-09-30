#!/usr/bin/env node
// Real WASI HTTP component vs independently compiled native reference.
// This is a local execution test, not a hardware-attestation test.
import {spawn,execFileSync} from 'node:child_process';import {randomBytes} from 'node:crypto';
import net from 'node:net';import assert from 'node:assert/strict';
const root=process.argv[2];if(!root)throw new Error('pass the capacity-work directory');
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const token=randomBytes(32).toString('hex');
const proc=spawn('wasmtime',['serve','-S','cli','--addr',`127.0.0.1:${port}`,'--env',`CAPACITY_WORK_TOKEN=${token}`,
 `${root}/target/wasm32-wasip2/release/capacity_work.wasm`],{stdio:['ignore','pipe','pipe']});
let output='';proc.stderr.on('data',x=>output+=x);proc.stdout.on('data',x=>output+=x);
try {
 let ready=false;for(let i=0;i<100;i++) {if(proc.exitCode!==null)throw new Error(output);try{await fetch(`http://127.0.0.1:${port}/`,{signal:AbortSignal.timeout(500)});ready=true;break;}catch{await new Promise(r=>setTimeout(r,100));}}
 if(!ready)throw new Error('WASI server did not start: '+output);
 const url=`http://127.0.0.1:${port}/v1/run`;
 assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
 for(const memory of [0,1,8]) {
  const work={seed:randomBytes(32).toString('hex'),rounds:1000,memory_mib:memory,passes:2};
  const expected=JSON.parse(execFileSync(`${root}/target/release/reference`,[],{input:JSON.stringify(work),timeout:30000,encoding:'utf8'}));
  const start=performance.now();const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(work),signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),expected);
  console.log(JSON.stringify({memoryMiB:memory,verified:true,elapsedMs:Math.round(performance.now()-start)}));
 }
 assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({seed:'ff'.repeat(32),rounds:1,memory_mib:2049,passes:1})})).status,422);
 assert.equal((await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token},body:'x'.repeat(4097)})).status,413);
 console.log('HTTP authorization, bounds and three independently verified work sizes passed.');
} finally {if(proc.exitCode===null&&!proc.signalCode){const ended=new Promise(r=>proc.once('exit',r));proc.kill('SIGTERM');await ended;}}
