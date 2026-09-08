import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..'),host=join(root,'shielded/anchor/avf/host');
const flags=['-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-pthread'];
const env={...process.env,ASAN_OPTIONS:'detect_leaks=1:abort_on_error=1',UBSAN_OPTIONS:'halt_on_error=1'};
test('native worker bridge: bounded bidirectional pump over socketpairs keeps bytes exact under backpressure, partial I/O and EINTR; half-close, cancel, no-progress deadline, non-socket refusal, dead sink, no descriptor left behind',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-bridge-'));
 try {
  const bin=join(dir,'test');
  execFileSync('cc',[...flags,'-I',host,join(host,'native-bridge-test.c'),'-o',bin],{encoding:'utf8',timeout:60_000,env});
  const out=execFileSync(bin,[],{encoding:'utf8',timeout:120_000,env});
  assert.match(out,/native-bridge: backpressure, partial I\/O, EINTR, half-close, cancel, no-progress deadline, non-socket refusal, dead sink, fd audit passed/);
  assert.match(out,/case 1: 25165824 \+ 12582912 bytes exact both ways/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('native bridge observes cancellation and idle deadlines during repeated read/send interruptions',()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-bridge-interrupt-'));
 try {
  const bin=join(dir,'test');
  execFileSync('cc',[...flags,'-I',host,join(host,'native-bridge-interrupt-test.c'),'-o',bin],{encoding:'utf8',timeout:60_000,env});
  const out=execFileSync(bin,[],{encoding:'utf8',timeout:5_000,env});
  for (const call of ['read','send']) for (const reason of ['cancel','idle deadline'])
   assert.ok(out.includes(`${call} EINTR: ${reason} observed`),out);
  assert.match(out,/native-bridge: interrupted read\/send preserve deadline and cancellation PASS/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
