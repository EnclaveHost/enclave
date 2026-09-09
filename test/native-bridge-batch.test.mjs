import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('framed native reply batching preserves fragmented streams, tails, backpressure, cancellation and EOF',()=>{
 const d=mkdtempSync(join(tmpdir(),'native-batch-'));
 try {
  const exe=join(d,'test');
  execFileSync('cc',['-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-fno-omit-frame-pointer',fileURLToPath(new URL('../shielded/anchor/avf/host/native-bridge-batch-test.c',import.meta.url)),'-pthread','-o',exe],{timeout:30000});
  assert.match(execFileSync(exe,[],{timeout:10000,encoding:'utf8'}),/framed reply batching: PASS/);
 } finally {rmSync(d,{recursive:true,force:true});}
});
