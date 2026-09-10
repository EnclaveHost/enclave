import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
test('PADACK queue retries without blocking control, prioritizes gaps, and cancels old sessions',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pad-ack-queue-'));
  try {
    const cc=spawnSync('javac',['--release','17','-d',dir,
      join(root,'shielded/anchor/avf/host/app/PadAckQueue.java'),
      join(root,'shielded/anchor/avf/host/app/PadDelivery.java'),
      join(root,'shielded/anchor/avf/host/app/VmSendGate.java'),
      join(root,'test/fixtures/PadAckQueueTest.java')],{encoding:'utf8',timeout:60_000});
    assert.equal(cc.status,0,cc.stdout+cc.stderr);
    const r=spawnSync('java',['-cp',dir,'host.enclave.anchor.avf.PadAckQueueTest'],{encoding:'utf8',timeout:30_000});
    assert.equal(r.status,0,r.stdout+r.stderr); assert.match(r.stdout,/pad-ack-queue: ok/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
