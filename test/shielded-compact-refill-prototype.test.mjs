import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('compact refill preserves every field value, tails, bounds and output strides',{
 skip:process.arch!=='x64',timeout:240_000,
},t=>{
 const root=fileURLToPath(new URL('../',import.meta.url));
 if(!existsSync(join(homedir(),'Projects/llama.cpp/ggml/include/gguf.h')))
   return t.skip('needs local compatible GGML development files');
 const dir=mkdtempSync(join(tmpdir(),'compact-refill-test-'));
 try{
   const extra=process.env.COMPACT_DNNL_ROOT?['--onednn-root',process.env.COMPACT_DNNL_ROOT]:[];
   execFileSync('python3',[join(root,'shielded/bench/build-compact-refill.py'),dir,'--sanitize',...extra],{timeout:180_000,stdio:'pipe'});
   const r=spawnSync(join(dir,'compact'),['--test'],{encoding:'utf8',timeout:60_000,
     env:{...process.env,OMP_NUM_THREADS:'1',OMP_DYNAMIC:'FALSE',ASAN_OPTIONS:'detect_leaks=1:abort_on_error=1',UBSAN_OPTIONS:'halt_on_error=1'}});
   if(r.status===77)return t.skip('requires AVX512 VNNI');
   assert.equal(r.status,0,r.stderr||String(r.error));
   const data=JSON.parse(r.stdout);assert.equal(data.compact_oracle_cases,448);
   assert.equal(data.bit_roundtrip_and_truncation,true);assert.equal(data.radix_extremes,true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
