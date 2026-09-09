import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('receive credit window restores exact size/max and closes uncertain sockets',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wire-rcvbuf-'));
  try {
    const bin=join(dir,'test');
    execFileSync('cc',['-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-fno-omit-frame-pointer','-ffunction-sections','-fdata-sections',fileURLToPath(new URL('./fixtures/shielded-wire-rcvbuf.c',import.meta.url)),'-pthread','-Wl,--gc-sections','-o',bin],{timeout:30000});
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('SHIELDED_')));
    assert.match(execFileSync(bin,[],{env,encoding:'utf8',timeout:10000}),/receive buffer: PASS/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
