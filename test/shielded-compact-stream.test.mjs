import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('disk-backed compact runtime authenticates private reads and retains exact arithmetic',
 {timeout:240000,skip:process.arch!=='x64'||!process.env.SHIELDED_COMPACT_TEST_ROOT},()=>{
 const root=fileURLToPath(new URL('../',import.meta.url)),dn=process.env.SHIELDED_COMPACT_TEST_ROOT;
 // Use the checkout filesystem, not /tmp (which may be RAM-backed).
 const d=mkdtempSync(join(root,'.compact-stream-test-'));
 const flags=['-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-ffp-contract=off'];
 const simd=['-mavx512f','-mavx512bw','-mavx512dq','-mavx512vl','-mavx512vnni'];
 try {
  for(const name of ['shielded-simd','shielded-field'])execFileSync('cc',[...flags,...simd,'-DSH_SIMD_AVX512','-c',join(root,'wasm/ggml-shielded',name+'.c'),'-o',join(d,name+'.o')]);
  execFileSync('c++',[...flags,...simd,'-std=c++17','-pthread','-I'+join(dn,'usr/include'),join(root,'test/fixtures/shielded-compact-stream.cpp'),join(d,'shielded-simd.o'),join(d,'shielded-field.o'),'-L'+join(dn,'usr/lib'),'-ldnnl','-lgomp','-lcrypto','-Wl,-rpath,'+join(dn,'usr/lib'),'-o',join(d,'test')]);
  const out=execFileSync(join(d,'test'),[d],{encoding:'utf8',timeout:120000,env:{...process.env,OMP_NUM_THREADS:'1',ASAN_OPTIONS:'detect_leaks=1:abort_on_error=1',UBSAN_OPTIONS:'halt_on_error=1'}});
  assert.match(out,/streamed compact: exact batches/);
 } finally {rmSync(d,{recursive:true,force:true});}
});
