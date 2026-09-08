import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('sparse missing-delivery planning preserves exact set difference and refuses atomically at limits', () => {
  const dir=mkdtempSync(join(tmpdir(),'shielded-sparse-plan-'));
  try {
    const bin=join(dir,'plan'), flags=['-std=c11','-O1','-Wall','-Wextra','-Werror'];
    if (process.env.SHIELDED_TEST_SANITIZE==='1') flags.push('-g','-fsanitize=address,undefined','-fno-omit-frame-pointer');
    execFileSync('cc',[...flags,fileURLToPath(new URL('./fixtures/shielded-pad-sparse-plan.c',import.meta.url)),'-o',bin],{timeout:30_000});
    execFileSync(bin,{timeout:10_000});
  } finally {rmSync(dir,{recursive:true,force:true});}
});
