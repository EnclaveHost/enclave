// 7d proposed patch (node-hold-host-review-20261021/proposed): every WalletAllowWriter commit retries a Windows sharing
// refusal of the replace (EPERM/EACCES/EBUSY) a bounded number of times, so allow() and heartbeat() are not turned into an
// UNKNOWN (a spurious hold of a healthy app) by the network agent's 1-s read; other errors and persistent refusals throw.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WalletAllowWriter,WalletAllowFile} from '../network/wallet-admission.mjs';
const runner='0x'+'12'.repeat(32),id='0x'+'ab'.repeat(32),ref='catalog://0x'+'cd'.repeat(32)+'/1';
const real=fs.renameSync;
function refuse(n,code){let left=n,calls=0;fs.renameSync=(a,b)=>{calls++;if(left-->0)throw Object.assign(new Error(code+': file in use'),{code});return real(a,b);};return ()=>calls;}
const setup=()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'wa-share-'));const file=path.join(d,'wallet-admission.json');return {d,file,w:new WalletAllowWriter({file,runner})};};
test('allow(): two sharing refusals then success -> published (no UNKNOWN)',()=>{
  const {d,file,w}=setup();const calls=refuse(2,'EPERM');
  try{const r=w.allow(id,{appRef:ref,configCid:'',validUntil:Date.now()+60_000});assert.equal(calls(),3);assert.equal(r.revision,2);}
  finally{fs.renameSync=real;}
  const f=new WalletAllowFile({file,runner});f.refresh();assert.deepEqual(f.status().allows,[id]);
  assert.deepEqual(fs.readdirSync(d).filter(n=>n.endsWith('.tmp')),[],'no temp left');
});
test('heartbeat(): EACCES/EBUSY refusals are retried too',()=>{
  for(const code of ['EACCES','EBUSY']){const {w}=setup();const calls=refuse(3,code);
    try{assert.equal(w.heartbeat().revision,2);assert.equal(calls(),4);}finally{fs.renameSync=real;}}
});
test('a refusal that persists throws after exactly 10 attempts; the previous document stays whole; no temp left',()=>{
  const {d,file,w}=setup();const before=fs.readFileSync(file,'utf8');const calls=refuse(1e9,'EBUSY');const t0=Date.now();
  try{assert.throws(()=>w.allow(id,{appRef:ref,configCid:'',validUntil:Date.now()+60_000}),/EBUSY/);}finally{fs.renameSync=real;}
  assert.equal(calls(),10);assert.ok(Date.now()-t0<3000,'bounded');
  assert.equal(fs.readFileSync(file,'utf8'),before,'never a torn or partial write');
  assert.deepEqual(fs.readdirSync(d).filter(n=>n.endsWith('.tmp')),[]);
});
test('any other error is not retried',()=>{
  const {w}=setup();const calls=refuse(1,'ENOSPC');
  try{assert.throws(()=>w.heartbeat(),/ENOSPC/);assert.equal(calls(),1);}finally{fs.renameSync=real;}
});
