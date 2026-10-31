import os from 'node:os';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {lockJournal,availableMemoryMiB} from './platform.mjs';
test('only one service owns the journal; stale lock never clears automatically',t=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'.enclave-router-lock-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));const file=path.join(d,'journal');
 const release=lockJournal(file);assert.throws(()=>lockJournal(file),e=>e.code==='EEXIST');
 release();const again=lockJournal(file);assert.throws(()=>lockJournal(file),e=>e.code==='EEXIST');again();
 fs.writeFileSync(file+'.lock',JSON.stringify({pid:999999999,token:'stale'}));assert.throws(()=>lockJournal(file),e=>e.code==='EEXIST');assert.equal(fs.existsSync(file+'.lock'),true);
});

test('Windows available RAM is measured once in bytes and rounded down',async()=>{
 let calls=0;
 assert.equal(await availableMemoryMiB({platform:'win32',freeMemory:()=>{calls++;return 49*1024**3+1024**2-1;}}),49*1024);
 assert.equal(calls,1);
 assert.equal(await availableMemoryMiB({platform:'win32',freeMemory:()=>49*1024**3-1}),49*1024-1);
});
test('unknown memory and unsupported platforms fail closed',async()=>{
 for(const value of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,'1024',undefined])
  await assert.rejects(availableMemoryMiB({platform:'win32',freeMemory:()=>value}),/physical memory unknown/);
 await assert.rejects(availableMemoryMiB({platform:'linux',freeMemory:()=>{throw Error('must not query');}}),/Windows host/);
 await assert.rejects(availableMemoryMiB({platform:'win32',freeMemory:()=>{throw Error('query failed');}}),/query failed/);
});
