import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
test('paired parking preserves registration, excludes the draft caller, resumes controls and unregisters its hook',()=>{
 const dir=mkdtempSync(join(tmpdir(),'anchor-idle-'));
 try {
  const exe=join(dir,'check');
  const cc=spawnSync('c++',['-std=c++17','-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-pthread','-Wall','-Wextra','-Werror',
   '-I'+join(root,'shielded/anchor/avf/payload'),join(root,'test/fixtures/anchor-idle-pool.cpp'),'-o',exe],{encoding:'utf8',timeout:60000});
  assert.equal(cc.status,0,cc.stdout+cc.stderr);
  const r=spawnSync(exe,[],{encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stdout+r.stderr);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
