import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const env={...process.env,CUDA_VISIBLE_DEVICES:'',ASAN_OPTIONS:'detect_leaks=1:abort_on_error=1',
  UBSAN_OPTIONS:'halt_on_error=1',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'};
function run(cmd,args){return execFileSync(cmd,args,{encoding:'utf8',timeout:60000,env});}
test('public worker RAM cache: immutable bytes, exact identity, bounded concurrent eviction and wire parser',()=>{
 const dir=mkdtempSync(join(tmpdir(),'shielded-public-cache-'));
 try {
  const bin=join(dir,'test');
  run('c++',['-O1','-g','-std=c++17','-fsanitize=address,undefined','-fno-omit-frame-pointer',
   '-I'+join(root,'wasm/ggml-shielded'),'-I'+join(root,'shielded/worker-cuda'),
   join(root,'test/fixtures/shielded-public-cache.cpp'),'-pthread','-o',bin]);
  assert.match(run(bin,[]),/public-cache:.*PASS/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('protocol admission and real CPU worker reconnect retain full reservation charges and exact field products',()=>{
 run('python3',[join(root,'test/fixtures/shielded-public-cache.py')]);
});
