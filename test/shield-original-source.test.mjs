import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('private GGUF originals release real pages without trusting backing-store rereads',()=>{
  const dir=mkdtempSync(join(tmpdir(),'shield-source-'));
  try {
    const bin=join(dir,'test');
    execFileSync('c++',['-std=c++17','-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer',
      '-Wno-deprecated-declarations','test/fixtures/shield-original-source.cpp','-lcrypto','-pthread','-o',bin]);
    const out=execFileSync(bin,[dir],{encoding:'utf8',env:{...process.env,ASAN_OPTIONS:'detect_leaks=1:abort_on_error=1',UBSAN_OPTIONS:'halt_on_error=1'}});
    assert.match(out,/real blocks freed, boundaries intact, rereads authenticated/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
