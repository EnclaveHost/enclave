import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('guest scheduler counters distinguish blocked real replies and report bounded trace loss',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wire-sched-'));
  try {
    const clean=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('SHIELDED_')));
    for (const cap of [16384,4]) {
      const bin=join(dir,'test-'+cap);
      execFileSync('cc',['-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-fno-omit-frame-pointer','-ffunction-sections','-fdata-sections',
        '-DSH_WS_CAP='+cap,fileURLToPath(new URL('./fixtures/shielded-wire-sched.c',import.meta.url)),'-pthread','-Wl,--gc-sections','-o',bin],{timeout:30000});
      for (const flag of ['0','1']) {
        const out=spawnSync(bin,[flag],{timeout:5000,encoding:'utf8',env:{...clean,SHIELDED_PROFILE:'1',SHIELDED_WIRE_SCHED:flag}});
        assert.equal(out.status,0,out.stderr);
        assert.match(out.stdout,/wire scheduling profile: PASS/);
        const rows=out.stderr.split('\n').filter(l=>l.startsWith('WS '));
        assert.equal(rows.length,flag==='1'?Math.min(cap,6):0);
        if(flag==='1') assert.equal(out.stderr.split('\n').filter(l=>l===`WS_COUNT recorded=${Math.min(cap,6)} dumped=${Math.min(cap,6)} dropped=${6-Math.min(cap,6)}`).length,2);
        else assert.equal(out.stderr,'');
      }
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
