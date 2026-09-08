import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('runner reports decode failures after a real prefill and excludes their throughput',t=>{
  const model=process.env.SHIELDED_PREFIX_TEST_MODEL,headers=process.env.GGML_SRC,libs=process.env.GGML_LIB;
  if(!model||!headers||!libs) return t.skip('set SHIELDED_PREFIX_TEST_MODEL, GGML_SRC and GGML_LIB');
  const dir=mkdtempSync(join(tmpdir(),'shielded-run-status-'));
  const gg=fileURLToPath(new URL('../wasm/ggml-shielded/',import.meta.url));
  const env={...Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('SHIELDED_'))),
    LD_LIBRARY_PATH:libs,GGML_CPU_SO:join(libs,'libggml-cpu.so'),SHIELDED_RUN_THREADS:'2'};
  const build=(cmd,args)=>execFileSync(cmd,args,{env,encoding:'utf8',timeout:60000});
  try {
    const objects=[];
    for(const name of ['prefix-kv','shielded-pads','tweetnacl','poly1305-donna']) {
      const obj=join(dir,name+'.o');objects.push(obj);
      build('cc',['-O2','-D_POSIX_C_SOURCE=200809L','-ffunction-sections','-fdata-sections','-c',join(gg,name+'.c'),'-o',obj]);
    }
    const bin=join(dir,'run'),hook=join(dir,'fail.so');
    const includes=['-I'+join(headers,'include'),'-I'+join(headers,'ggml/include')];
    build('c++',['-O2','-std=c++17',...includes,join(gg,'shielded-run.cpp'),...objects,'-Wl,--gc-sections',
      '-L'+libs,'-Wl,-rpath,'+libs,'-lllama','-lggml','-lggml-base','-ldl','-pthread','-o',bin]);
    build('c++',['-O2','-std=c++17','-shared','-fPIC',...includes,
      fileURLToPath(new URL('./fixtures/shielded-run-fail.cpp',import.meta.url)),'-ldl','-o',hook]);
    for(const call of [0,1,2,3]) {
      const r=spawnSync(bin,[model,'The capital of France is', '4'],{env:{...env,LD_PRELOAD:hook,TEST_DECODE_FAIL_CALL:String(call)},
        encoding:'utf8',timeout:60000,maxBuffer:2**22});
      assert.ifError(r.error);
      assert.equal(r.status,call===0?0:call===1?2:1,r.stderr);
      if(call===0) {assert.match(r.stdout,/status\s+: budget/);assert.match(r.stdout,/decode\s+: 4 tokens/);}
      if(call>1) {assert.match(r.stdout,/status\s+: decode_failed/);assert.doesNotMatch(r.stdout,/^decode\s+:/m);}
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
