import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
test('weight registration fails closed on allocation/entropy errors and joins noncontiguous successful threads',()=>{
  const dir=mkdtempSync(join(tmpdir(),'shielded-register-'));
  try {
    const bin=join(dir,'test');
    const simd=join(dir,'simd.o'),fast=join(dir,'fast.o');
    for(const [out,extra] of [[simd,[]],[fast,process.arch==='arm64'?['-march=armv8.2-a+dotprod','-DSH_SIMD_NEON']:
      ['-mavx512f','-mavx512bw','-mavx512dq','-mavx512vl','-mavx512vnni','-DSH_SIMD_AVX512']]]) {
      const cc=spawnSync('cc',['-O1','-g','-fsanitize=address,undefined',...extra,'-c',join(root,'wasm/ggml-shielded/shielded-simd.c'),'-o',out],{encoding:'utf8',timeout:30_000});
      assert.equal(cc.status,0,cc.stdout+cc.stderr);
    }
    const core=['shielded-field.c','shielded-pads.c','shielded-bank.c','shielded-http.c','tweetnacl.c','poly1305-donna.c'];
    const cc=spawnSync('cc',['-std=c11','-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer',
      '-ffunction-sections','-fdata-sections','-ffp-contract=off',join(root,'test/fixtures/shielded-register.c'),
      ...core.map(x=>join(root,'wasm/ggml-shielded',x)),simd,fast,'-Wl,--gc-sections','-lpthread','-lm','-o',bin],{encoding:'utf8',timeout:60_000});
    assert.equal(cc.status,0,cc.stdout+cc.stderr);
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('SHIELDED_')));
    const r=spawnSync(bin,[],{encoding:'utf8',timeout:30_000,env:{...env,ASAN_OPTIONS:'detect_leaks=1:abort_on_error=1',UBSAN_OPTIONS:'halt_on_error=1'}});
    assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/shielded-register: ok/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
