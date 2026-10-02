import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('production compact provider preserves field arithmetic and fails closed',{timeout:240000,skip:process.arch!=='x64'||!process.env.SHIELDED_COMPACT_TEST_ROOT},t=>{
 const root=fileURLToPath(new URL('../',import.meta.url)),dn=process.env.SHIELDED_COMPACT_TEST_ROOT;
 const d=mkdtempSync(join(tmpdir(),'compact-runtime-'));
 const flags=['-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-ffp-contract=off'];
 const simd=['-mavx512f','-mavx512bw','-mavx512dq','-mavx512vl','-mavx512vnni'];
 try{
  execFileSync('cc',[...flags,...simd,'-DSH_SIMD_AVX512','-c',join(root,'wasm/ggml-shielded/shielded-simd.c'),'-o',join(d,'simd.o')]);
  execFileSync('cc',[...flags,'-c',join(root,'wasm/ggml-shielded/shielded-field.c'),'-o',join(d,'field.o')]);
  execFileSync('c++',[...flags,...simd,'-std=c++17','-pthread','-I'+join(dn,'usr/include'),join(root,'test/fixtures/shielded-compact-runtime.cpp'),join(d,'simd.o'),join(d,'field.o'),'-Wl,--wrap=aligned_alloc','-L'+join(dn,'usr/lib'),'-ldnnl','-lgomp','-Wl,-rpath,'+join(dn,'usr/lib'),'-o',join(d,'test')]);
  const r=spawnSync(join(d,'test'),[],{encoding:'utf8',timeout:120000,env:{...process.env,OMP_NUM_THREADS:'1',OMP_DYNAMIC:'FALSE',ASAN_OPTIONS:'detect_leaks=1:abort_on_error=1',UBSAN_OPTIONS:'halt_on_error=1'}});
  if(r.status===77)return t.skip('requires AVX512 VNNI');
  assert.equal(r.status,0,r.stderr||String(r.error));assert.match(r.stdout,/76 exact cases/);
  assert.match(r.stdout,/guarded read windows, all bit widths, malformed tails and shared-store readers passed/);
  assert.match(r.stdout,/42 bounded scratch shapes, native OOM fallback and invalid-mask wipes passed/);
  assert.match(r.stdout,/72 direct admission comparisons, source mismatches and malformed frames passed/);
 }finally{rmSync(d,{recursive:true,force:true});}
});
