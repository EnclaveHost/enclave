import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
test('a sealed shipment streams from its HTTP body into the PADS receiver with no file, and only K or H accept it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pad-direct-'));
  try {
    const app = join(root, 'shielded/anchor/avf/host/app');
    const cc = spawnSync('javac', ['--release', '17', '-Xlint:all', '-Werror', '-d', dir, join(app, 'PadDelivery.java'), join(app, 'PadAckQueue.java'),
      join(app, 'PadDirectStream.java'), join(root, 'test/fixtures/PadDirectStreamTest.java')], {encoding:'utf8', timeout:60_000});
    assert.equal(cc.status, 0, cc.stdout + cc.stderr);
    const run = spawnSync('java', ['-cp', dir, 'host.enclave.anchor.avf.PadDirectStreamTest'], {encoding:'utf8', timeout:60_000});
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').pop()), {status:'PASS', executed_checks:62});
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
