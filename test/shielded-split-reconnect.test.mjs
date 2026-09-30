import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
const root=join(import.meta.dirname,'..'),gg=join(root,'wasm/ggml-shielded');
test('column-split graph recovers both idle and mid-product disconnects with verified, identical outputs',t=>{
 const headers=process.env.GGML_SRC||join(homedir(),'Projects/llama.cpp');
 const libs=process.env.GGML_LIB||join(homedir(),'Projects/llamacpp-lib');
 if(!existsSync(join(headers,'ggml/include/ggml.h'))||!existsSync(join(libs,'libggml-cpu.so')))
  return t.skip('needs GGML_SRC and GGML_LIB for the actual backend');
 const d=mkdtempSync(join(tmpdir(),'shielded-reconnect-'));
 const run=(c,a)=>execFileSync(c,a,{encoding:'utf8',timeout:120000,env:{...process.env,CUDA_VISIBLE_DEVICES:'',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}});
 try {
  const objs=[];
  for(const n of ['shielded-field','shielded-wire','shielded-tee','shielded-parwork','shielded-pads','shielded-bank','shielded-http','tweetnacl','poly1305-donna','shielded-simd']){
   const o=join(d,n+'.o');objs.push(o);run('cc',['-O1','-ffp-contract=off','-c',join(gg,n+'.c'),'-o',o]);
  }
  const fast=join(d,'fast.o');objs.push(fast);
  run('cc',['-O1','-mavx512f','-mavx512bw','-mavx512dq','-mavx512vl','-mavx512vnni','-DSH_SIMD_AVX512','-c',join(gg,'shielded-simd.c'),'-o',fast]);
  const bin=join(d,'test');
  const compactRoot=process.env.SHIELDED_COMPACT_TEST_ROOT, extra=[];
  if(compactRoot){
   const co=join(d,'compact.o');objs.push(co);
   run('c++',['-O2','-std=c++17','-I'+join(compactRoot,'usr/include'),'-mavx512f','-mavx512bw','-mavx512dq','-mavx512vl','-mavx512vnni','-c',join(gg,'shielded-compact.cpp'),'-o',co]);
   extra.push('-DSHIELDED_COMPACT','-L'+join(compactRoot,'usr/lib'),'-ldnnl','-lgomp','-Wl,-rpath,'+join(compactRoot,'usr/lib'));
  }
  run('c++',['-O1','-std=c++17','-DGGML_MAX_NAME=128','-I'+join(headers,'ggml/include'),'-I'+join(headers,'ggml/src'),join(root,'test/fixtures/shielded-split-reconnect.cpp'),...objs,...extra,'-L'+libs,'-lggml-base','-lggml','-lggml-cpu','-lpthread','-lm','-Wl,-rpath,'+libs,'-o',bin]);
  assert.match(run('python3',[join(root,'test/fixtures/shielded-split-reconnect.py'),bin]),/both split connections recovered/);
  if(compactRoot) assert.match(run('env',['TEST_COMPACT=1','python3',join(root,'test/fixtures/shielded-split-reconnect.py'),bin]),/both split connections recovered/);
 } finally {rmSync(d,{recursive:true,force:true});}
});
