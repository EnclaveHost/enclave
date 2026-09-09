import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('wire-only source spans retain exact real-frame identities without enabling other units',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wire-source-profile-'));
  try {
    const bin=join(dir,'test');
    execFileSync('cc',['-std=c11','-O1','-g','-Wall','-Wextra','-Werror','-fsanitize=address,undefined','-fno-omit-frame-pointer','-ffunction-sections','-fdata-sections',
      ...['shielded-wire-source-profile.c','shielded-wire-source-other.c'].map(f=>fileURLToPath(new URL('./fixtures/'+f,import.meta.url))),'-pthread','-Wl,--gc-sections','-o',bin],{timeout:30000});
    const clean=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('SHIELDED_')));
    for (const [wire,global,expectedWire,expectedOther] of [['0','0',0,0],['1','0',1,0],['0','1',1,1],['1','1',1,1]]) {
      const stdout=execFileSync(bin,[String(expectedWire),String(expectedOther)],{timeout:5000,encoding:'utf8',env:{...clean,SHIELDED_PROFILE:'1',SHIELDED_WIRE_PROFILE:wire,SHIELDED_SOURCE_PROFILE:global}});
      assert.match(stdout,/wire source profile: PASS/);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
