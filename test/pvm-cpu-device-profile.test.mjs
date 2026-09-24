// The pVM CPU tier sizes the VM from what the kernel reports, never from the device name (DeviceProfile.java, PVM-CPU.md):
// the Tensor G5 comes out at the measured 6 threads and 7,168 MiB, other layouts get their big cores, a phone without room
// for the model is refused with the numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
test('pvm-cpu device profile: threads from cpu_capacity, VM memory from RAM, no device names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devprof-'));
  const run = (p, a) => { const r = spawnSync(p, a, {encoding:'utf8', timeout:60_000}); assert.equal(r.status, 0, String(r.error ?? '') + r.stdout + r.stderr); return r.stdout; };
  try {
    const app = join(root, 'shielded/anchor/avf/host/app');
    run('javac', ['--release', '17', '-Xlint:all', '-Werror', '-d', dir, join(app, 'DeviceProfile.java'), join(root, 'test/fixtures/DeviceProfileTest.java')]);
    assert.deepEqual(JSON.parse(run('java', ['-cp', dir, 'host.enclave.anchor.avf.DeviceProfileTest'])), {status:'PASS', executed_checks:11});
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
