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
test('protected C client negotiates safely, refuses malformed replies and skips authenticated reads on actual CPU-worker hits',()=>{
 const dir=mkdtempSync(join(tmpdir(),'shielded-public-client-')),gg=join(root,'wasm/ggml-shielded');
 const flags=['-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer',
   '-ffunction-sections','-fdata-sections','-ffp-contract=off'];
 try {
  const simd=join(dir,'simd.o'),fast=join(dir,'fast.o'),bin=join(dir,'client');
  run('cc',[...flags,'-c',join(gg,'shielded-simd.c'),'-o',simd]);
  run('cc',[...flags,...(process.arch==='arm64'?['-march=armv8.2-a+dotprod','-DSH_SIMD_NEON']:
   ['-mavx512f','-mavx512bw','-mavx512dq','-mavx512vl','-mavx512vnni','-DSH_SIMD_AVX512']),
   '-c',join(gg,'shielded-simd.c'),'-o',fast]);
  const core=['shielded-field.c','shielded-pads.c','shielded-bank.c','shielded-http.c','tweetnacl.c','poly1305-donna.c'];
  run('cc',[...flags,'-std=c11',join(root,'test/fixtures/shielded-public-cache-client.c'),
   ...core.map(x=>join(gg,x)),simd,fast,'-Wl,--gc-sections','-pthread','-lm','-o',bin]);
  assert.match(run(bin,[]),/public-cache-client:.*PASS/);
  assert.match(run('python3',[join(root,'test/fixtures/shielded-public-cache-socket.py'),bin]),/public-cache-socket:.*PASS/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
