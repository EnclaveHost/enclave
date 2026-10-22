// 7d D1 v2 (node-hold-host-review-20261021/proposed): ONE retry layer in WalletAllowWriter.commit() for a Windows sharing
// violation of the atomic replace (EPERM/EACCES/EBUSY), within COMMIT_RETRY's exact budget. Simulated here by injecting
// the error into fs.renameSync (Linux cannot produce one); the native canary (native-writer/) observes real Windows holders.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WalletAllowWriter,WalletAllowFile,COMMIT_RETRY} from '../network/wallet-admission.mjs';
const runner='0x'+'12'.repeat(32),id='0x'+'ab'.repeat(32),ref='catalog://0x'+'cd'.repeat(32)+'/1';
const real=fs.renameSync;
function refuse(n,code,file){let left=n,calls=0;fs.renameSync=(a,b)=>{if(file&&b!==file)return real(a,b);calls++;if(left-->0)throw Object.assign(new Error(code+': file in use'),{code});return real(a,b);};return ()=>calls;}
const setup=(now)=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'wa-retry-'));const file=path.join(d,'wallet-admission.json');return {d,file,w:new WalletAllowWriter({file,runner,...(now?{now}:{})})};};
const tmps=d=>fs.readdirSync(d).filter(n=>n.endsWith('.tmp'));
test('the exact budget: 6 attempts, waits 25+50+75+100+125 = 375 ms',()=>{
  assert.deepEqual({...COMMIT_RETRY},{attempts:6,stepMs:25,budgetMs:375});
  let sum=0;for(let a=1;a<COMMIT_RETRY.attempts;a++)sum+=COMMIT_RETRY.stepMs*a;assert.equal(sum,COMMIT_RETRY.budgetMs);
});
test('transient refusals then success: allow, hold and heartbeat each commit (no UNKNOWN, no torn write)',()=>{
  for(const [op,code] of [['allow','EPERM'],['hold','EACCES'],['heartbeat','EBUSY']]){
    const {d,file,w}=setup();const calls=refuse(2,code,file);let r;
    try{r=op==='allow'?w.allow(id,{appRef:ref,configCid:'',validUntil:Date.now()+60_000}):op==='hold'?w.hold(id):w.heartbeat();}finally{fs.renameSync=real;}
    assert.equal(calls(),3,op);assert.equal(r.revision,2,op);assert.deepEqual(tmps(d),[],op);
    const f=new WalletAllowFile({file,runner});f.refresh();assert.equal(f.status().fresh,true,op);
  }
});
test('a persistent refusal throws after exactly 6 attempts and >= 375 ms; the previous document is intact; no temp left',()=>{
  const {d,file,w}=setup();const before=fs.readFileSync(file);const calls=refuse(1e9,'EBUSY',file);const t0=performance.now();
  try{assert.throws(()=>w.allow(id,{appRef:ref,configCid:'',validUntil:Date.now()+60_000}),/EBUSY/);}finally{fs.renameSync=real;}
  const took=performance.now()-t0;
  assert.equal(calls(),6);assert.ok(took>=370&&took<1500,`bounded wait ${took.toFixed(0)} ms`);
  assert.ok(fs.readFileSync(file).equals(before),'never torn or partial');assert.deepEqual(tmps(d),[]);
  assert.equal(w.heartbeat().revision,2,'the writer keeps working once the holder is gone');
});
test('any other error is not retried',()=>{
  const {file,w}=setup();const calls=refuse(1,'ENOSPC',file);
  try{assert.throws(()=>w.heartbeat(),/ENOSPC/);}finally{fs.renameSync=real;}assert.equal(calls(),1);
});
test('a retry never extends a deadline: issuedAt/expiresAt/validUntil are fixed before the first try',()=>{
  let clock=1_800_000_000_000;const now=()=>clock;const {file,w}=setup(now);
  const V=clock+60_000;let n=0;fs.renameSync=(a,b)=>{if(b===file&&n++<2){clock+=200;throw Object.assign(new Error('EPERM'),{code:'EPERM'});}return real(a,b);};
  const T0=clock;try{w.allow(id,{appRef:ref,configCid:'',validUntil:V});}finally{fs.renameSync=real;}
  const doc=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.equal(doc.issuedAt,T0,'issued when the commit began, not when the rename finally landed');assert.equal(doc.expiresAt,T0+30_000);
  assert.equal(doc.allows[id].validUntil,V,'the chain deadline is exactly the decision\'s');
  const f=new WalletAllowFile({file,runner,now});f.refresh();
  const until=f.until(id,{runner,appRef:ref,configCid:''});assert.equal(until,Math.min(T0+30_000,V));assert.ok(until<=V);
});
