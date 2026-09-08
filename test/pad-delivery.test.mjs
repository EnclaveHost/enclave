import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('phone pad delivery: reserved-but-undelivered files, exact downloads, and canceled VM generations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pad-delivery-java-'));
  try {
    const cc = spawnSync('javac', ['--release', '17', '-d', dir,
      join(root, 'shielded/anchor/avf/host/app/PadDelivery.java'),
      join(root, 'shielded/anchor/avf/host/app/PadAckQueue.java'),
      join(root, 'test/fixtures/PadDeliveryTest.java')], {encoding:'utf8', timeout:60_000});
    assert.equal(cc.status, 0, cc.stdout + cc.stderr);
    const run = spawnSync('java', ['-cp', dir, 'host.enclave.anchor.avf.PadDeliveryTest'], {encoding:'utf8', timeout:30_000});
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /pad-delivery: ok/);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
