import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('receive profiling preserves wire failures and records real retry/byte counts',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wire-recv-profile-'));
  try {
    const bin=join(dir,'test');
    execFileSync('cc',['-std=c11','-O1','-g','-Wall','-Wextra','-Werror',
      '-fsanitize=address,undefined','-fno-omit-frame-pointer','-ffunction-sections','-fdata-sections',
      fileURLToPath(new URL('./fixtures/shielded-wire-rcvlowat.c',import.meta.url)),
      '-pthread','-Wl,--gc-sections','-o',bin],{timeout:30000});
    const clean=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('SHIELDED_')));
    const run=(args,env)=>{
      const p=spawnSync(bin,args,{env,encoding:'utf8',timeout:15000,maxBuffer:4*1024*1024});
      assert.equal(p.status,0,p.stderr);assert.ifError(p.error);return p;
    };
    const off=run(['off-profile'],clean);assert.doesNotMatch(off.stderr,/^RP_/m);
    const on=run([],{...clean,SHIELDED_RECV_PROFILE:'1'});assert.match(on.stderr,/^RP_READ /m);
    const captured=run(['capture'],clean);
    const reads=captured.stderr.split('\n').filter(s=>s.startsWith('RP_READ ')).map(s=>s.split(' '));
    assert.equal(reads.length,2);
    assert.deepEqual(reads.map(r=>[r[1],Number(r[4]),Number(r[6]),Number(r[8])]),
      [['header',9,0,0],['body',262145,0,0]]);
    assert.match(captured.stderr,/^RP_COUNT recorded=2 dumped=2 dropped=0$/m);
    const op=name=>captured.stderr.split('\n').find(s=>s.startsWith('RP_OP header ') && s.split(' ')[4]===name).split(' ');
    assert.equal(Number(op('poll')[14]),1); // injected EINTR
    assert.equal(Number(op('recv')[14]),1);
    assert.equal(Number(op('recv')[15]),1); // injected EAGAIN
  } finally {rmSync(dir,{recursive:true,force:true});}
});
