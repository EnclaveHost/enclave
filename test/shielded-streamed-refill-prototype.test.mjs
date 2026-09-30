import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('offline streamed refill matches the exact oracle and rejects damaged storage', {
  skip: process.arch !== 'x64', timeout: 180_000,
}, t => {
  const root=fileURLToPath(new URL('../',import.meta.url));
  const src=process.env.GGML_SRC || join(homedir(),'Projects/llama.cpp');
  const lib=process.env.GGML_LIB || join(homedir(),'Projects/llamacpp-lib');
  if(!existsSync(join(src,'ggml/include/gguf.h')) || !existsSync(join(lib,'libggml-base.so')))
    return t.skip('needs GGML headers/library and OpenSSL development library');
  const dir=mkdtempSync(join(tmpdir(),'streamed-refill-test-'));
  try {
    execFileSync('python3',[join(root,'shielded/bench/build-streamed-refill.py'),dir,
      '--sanitize','--ggml-src',src,'--ggml-lib',lib],{timeout:120_000,stdio:'pipe'});
    const run=spawnSync(join(dir,'bench'),['--test',dir],{encoding:'utf8',timeout:60_000,
      env:{...process.env,ASAN_OPTIONS:'detect_leaks=1:abort_on_error=1',UBSAN_OPTIONS:'halt_on_error=1'}});
    if(run.status===77)return t.skip('requires AVX512 VNNI');
    assert.equal(run.status,0,run.stderr||String(run.error));
    const result=JSON.parse(run.stdout);
    assert.equal(result.oracle_cases,384);
    assert.equal(result.tamper_truncation_exception,'passed');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
