import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
test('native echo preserves bytes through partial socket I/O, deadlines and half-close without taking fd ownership',()=>{
  const dir=mkdtempSync(join(tmpdir(),'native-echo-'));
  try {
    const bin=join(dir,'test');
    const cc=spawnSync('cc',['-O1','-g','-fsanitize=address,undefined','-Wall','-Wextra',
      join(root,'test/fixtures/native-echo.c'),'-pthread','-o',bin],{encoding:'utf8',timeout:30_000});
    assert.equal(cc.status,0,cc.stdout+cc.stderr);
    const r=spawnSync(bin,[],{encoding:'utf8',timeout:15_000});
    assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/native-echo: ok/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
