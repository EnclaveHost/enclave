// The pvm-cpu payload's APP line (shielded/anchor/avf/payload/anchor_app.h): the portable component's size, identity (sha256)
// and arguments, parsed strictly -- canonical forms accepted, every malformed, oversized or trailing form refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
test('anchor APP line: strict grammar, 1 GiB and 8 KiB bounds, the graph name, serve=http|https, no trailing bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-app-'));
  try {
    const bin = join(dir, 'anchor-app');
    const cc = spawnSync('cc', ['-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
      '-I', join(root, 'shielded/anchor/avf/payload'), join(root, 'test/fixtures/anchor-app.c'), '-o', bin], {encoding: 'utf8'});
    assert.equal(cc.status, 0, cc.stderr);
    const r = spawnSync(bin, [], {encoding: 'utf8'});
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(JSON.parse(r.stdout), {status: 'PASS', executed_checks: 47});
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
