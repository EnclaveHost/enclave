import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..'),gg=join(root,'wasm/ggml-shielded');
test('shipments reject authenticated overflow/truncation layouts and failed header hashes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pad-layout-'));
  try {
    const bin=join(dir,'test');
    const cc=spawnSync('cc',['-O1','-g','-fsanitize=address,undefined','-ffunction-sections','-fdata-sections',
      '-Wall','-Wextra','-I',gg,join(root,'test/fixtures/pad-layout.c'),join(gg,'tweetnacl.c'),join(gg,'poly1305-donna.c'),
      '-Wl,--gc-sections','-pthread','-lm','-o',bin],{encoding:'utf8',timeout:60_000});
    assert.equal(cc.status,0,cc.stdout+cc.stderr);
    const r=spawnSync(bin,[dir],{encoding:'utf8',timeout:30_000});
    assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/pad-layout: ok/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
