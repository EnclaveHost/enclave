import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..'),gg=join(root,'wasm/ggml-shielded');
const flags=['-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-ffunction-sections','-fdata-sections','-ffp-contract=off'];
const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('SHIELDED_'))),
  ASAN_OPTIONS:'detect_leaks=1:abort_on_error=1',UBSAN_OPTIONS:'halt_on_error=1'};
function run(cmd,args){return execFileSync(cmd,args,{encoding:'utf8',timeout:60_000,env});}
test('public weight cache authenticates private read buffers and survives partial I/O, tampering and failure cleanup',()=>{
 const dir=mkdtempSync(join(tmpdir(),'shielded-weight-cache-'));
 try {
  const nacl=join(dir,'nacl.o'),bin=join(dir,'test');
  run('cc',[...flags,'-c',join(gg,'tweetnacl.c'),'-o',nacl]);
  run('c++',[...flags,'-std=c++17','-I',gg,join(root,'test/fixtures/shielded-weight-cache.cpp'),nacl,'-Wl,--gc-sections','-o',bin]);
  assert.match(run(bin,[dir]),/weight-cache: authenticated reads/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('dealt weight reader releases the original array, preserves exact local fallback and reuploads authenticated bytes on reconnect',()=>{
 const dir=mkdtempSync(join(tmpdir(),'shielded-weight-reader-'));
 try {
  const simd=join(dir,'simd.o'),fast=join(dir,'fast.o'),bin=join(dir,'test');
  run('cc',[...flags,'-c',join(gg,'shielded-simd.c'),'-o',simd]);
  run('cc',[...flags,...(process.arch==='arm64'?['-march=armv8.2-a+dotprod','-DSH_SIMD_NEON']:
    ['-mavx512f','-mavx512bw','-mavx512dq','-mavx512vl','-mavx512vnni','-DSH_SIMD_AVX512']),'-c',join(gg,'shielded-simd.c'),'-o',fast]);
  const core=['shielded-field.c','shielded-pads.c','shielded-bank.c','shielded-http.c','tweetnacl.c','poly1305-donna.c'];
  run('cc',[...flags,'-std=c11',join(root,'test/fixtures/shielded-weight-reader.c'),...core.map(x=>join(gg,x)),simd,fast,'-Wl,--gc-sections','-pthread','-lm','-o',bin]);
  assert.match(run(bin,[]),/weight-reader: released source/);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
