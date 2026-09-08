import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
test('anchor SHA256 agrees with Node, scalar, and fragmented hashing at padding and alignment boundaries',()=>{
  const dir=mkdtempSync(join(tmpdir(),'anchor-sha-'));
  try {
    const bin=join(dir,'test'),cc=spawnSync('cc',['-O2','-g','-fsanitize=address,undefined','-Wall','-Wextra',
      '-I',join(root,'shielded/anchor/avf/payload'),join(root,'test/fixtures/anchor-sha256.c'),'-o',bin],{encoding:'utf8',timeout:60_000});
    assert.equal(cc.status,0,cc.stdout+cc.stderr);
    const r=spawnSync(bin,[dir],{encoding:'utf8',timeout:30_000});
    assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/anchor-sha256: ok/);
    const data=Buffer.alloc((4<<20)+32);for(let i=0;i<data.length;i++)data[i]=(i*131+Math.floor(i/7))&255;
    const rows=r.stdout.split('\n').filter(l=>/^\d+ /.test(l));assert.equal(rows.length,180);
    for(const row of rows){const[n,off,digest]=row.split(' ');assert.equal(digest,createHash('sha256').update(data.subarray(+off,+off+(+n))).digest('hex'),row);}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
