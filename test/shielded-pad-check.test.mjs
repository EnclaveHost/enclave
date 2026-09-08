import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
test('tiled pad-check preparation preserves the exact modular check across dimensions and integer extremes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'shielded-pad-check-'));
  const env={...process.env,ASAN_OPTIONS:'detect_leaks=1:abort_on_error=1',UBSAN_OPTIONS:'halt_on_error=1'};
  const run=(cmd,args)=>execFileSync(cmd,args,{env,encoding:'utf8',timeout:60000});
  try {
    const bin=join(dir,'check'),simd=join(dir,'simd.o'),fast=join(dir,'fast.o');
    const flags=['-std=c11','-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-ffunction-sections','-fdata-sections'];
    run('cc',[...flags,'-c',join(root,'wasm/ggml-shielded/shielded-simd.c'),'-o',simd]);
    run('cc',[...flags,...(process.arch==='arm64'?['-march=armv8.2-a+dotprod','-DSH_SIMD_NEON']:
      ['-mavx512f','-mavx512bw','-mavx512dq','-mavx512vl','-mavx512vnni','-DSH_SIMD_AVX512']),
      '-c',join(root,'wasm/ggml-shielded/shielded-simd.c'),'-o',fast]);
    run('cc',[...flags,join(root,'test/fixtures/shielded-pad-check.c'),simd,fast,
      '-Wl,--gc-sections','-pthread','-lm','-o',bin]);
    assert.match(run(bin,[]),/pad-check: tiled\/reference exact/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
