import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const flags=['-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-pthread','-Wall','-Wextra'];
const env={...process.env,ASAN_OPTIONS:'detect_leaks=1:abort_on_error=1',UBSAN_OPTIONS:'halt_on_error=1'};
test('framed diagnostic loop: bounded-buffer success, timeouts bound both directions, corruption and partial-header caught, no fd leak',()=>{
 const dir=mkdtempSync(join(tmpdir(),'frame-loop-'));
 try{
  const bin=join(dir,'t');
  execFileSync('cc',[...flags,join(root,'test/fixtures/shielded-frame-loop.c'),'-o',bin],{encoding:'utf8',timeout:60_000,env});
  const out=execFileSync(bin,[],{encoding:'utf8',timeout:120_000,env});
  assert.match(out,/frame-loop: 3MiB success, size 1, dead reader\/writer timeout, corruption, partial header, fd audit passed/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
