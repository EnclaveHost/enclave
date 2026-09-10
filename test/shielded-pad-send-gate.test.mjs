import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'shielded/anchor/avf/host/app');
const fixtures = join(root, 'test/fixtures');

// The cooperative app -> pVM PADS_PORT send gate. Three real Java fixtures, each compiled and run
// in a temp directory that is always removed. Nothing here is stubbed: they drive the production
// VmSendGate and the production PadDelivery.Session.
//
// LIMIT: these prove the gate and the Session/gate contract. They do NOT prove the PadsClient
// streamBank / directStream finally-branch placement, which needs a live vsock, a
// ParcelFileDescriptor and Main.connect. That coverage is review plus an on-device run.
const CASES = [
  { name: 'concurrency',           cls: 'VmSendGateTest',            marker: /vm send gate verified/ },
  { name: 'drain deadline',        cls: 'VmSendGateDeadlineTest',    marker: /drain deadline verified/ },
  { name: 'session integration',   cls: 'SessionGateIntegrationTest', marker: /session\/gate integration verified/ },
];

for (const c of CASES) {
  test(`pad send gate: ${c.name}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'pad-send-gate-'));
    try {
      const sources = [join(app, 'VmSendGate.java')];
      if (c.cls === 'SessionGateIntegrationTest') sources.push(join(app, 'PadDelivery.java'), join(app, 'PadAckQueue.java'));
      sources.push(join(fixtures, `${c.cls}.java`));
      const cc = spawnSync('javac', ['--release', '17', '-d', dir, ...sources], {encoding:'utf8', timeout:30_000});
      assert.equal(cc.status, 0, cc.stdout + cc.stderr);
      // Each fixture bounds its own waits; this outer timeout is the backstop if a join hangs.
      const run = spawnSync('java', ['-cp', dir, `host.enclave.anchor.avf.${c.cls}`], {encoding:'utf8', timeout:30_000});
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.match(run.stdout, c.marker);
    } finally { rmSync(dir, {recursive:true, force:true}); }
  });
}
