import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(root, 'shielded/anchor/avf/host/app');
const fixtures = join(root, 'test/fixtures');

// The opt-in quiet-pads control worker. The controller under test is EXTRACTED from the current
// Main.java by balanced-brace scanning, so this module tracks whatever Main.java says today: the
// expected hash is computed from the source we just read, never hardcoded, and is printed for
// provenance. Nothing is stubbed except say(); the real VmSendGate and PadDelivery.Session are used.
//
// LIMIT: this proves the control worker and its gate/session interaction. It does not prove the
// PadsClient send-path branches, which need a live vsock.
test('quiet pads control: extracted worker against the real gate and session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quiet-pads-'));
  try {
    const mainPath = join(app, 'Main.java');
    const sha = createHash('sha256').update(readFileSync(mainPath)).digest('hex');
    console.log(`quiet-pads: extracting from Main.java sha256 ${sha}`);

    const host = join(dir, 'host');
    const ex = spawnSync('python3', [join(fixtures, 'extract_quiet_control.py'),
      '--main', mainPath, '--expect-sha256', sha, '--out', host],
      {encoding: 'utf8', timeout: 15_000});
    assert.equal(ex.status, 0, ex.stdout + ex.stderr);
    console.log(ex.stdout.trim());

    const cc = spawnSync('javac', ['--release', '17', '-d', dir,
      join(host, 'Main.java'),
      join(app, 'VmSendGate.java'),
      join(app, 'PadDelivery.java'),
      join(app, 'PadAckQueue.java'),
      join(fixtures, 'QuietPadsControlTest.java')], {encoding: 'utf8', timeout: 30_000});
    assert.equal(cc.status, 0, cc.stdout + cc.stderr);

    const run = spawnSync('java', ['-cp', dir, 'host.enclave.anchor.avf.QuietPadsControlTest'],
      {encoding: 'utf8', timeout: 15_000});
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /quiet pads control verified/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
