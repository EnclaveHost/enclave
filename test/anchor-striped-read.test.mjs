import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
test('striped source read is byte-identical to the serial read, bounded, and falls back only after every thread joined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-striped-read-'));
  function run(program, args, env) {
    const r = spawnSync(program, args, {encoding:'utf8', timeout:120_000, env: {...process.env, ...env}});
    assert.equal(r.status, 0, String(r.error ?? '') + r.stdout + r.stderr);
    return r.stdout;
  }
  try {
    const payload = join(root, 'shielded/anchor/avf/payload');
    const binary = join(dir, 'striped-test');
    run('cc', ['-std=c11', '-O1', '-g', '-D_DEFAULT_SOURCE', '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
      '-pthread', '-I'+payload, join(root, 'test/fixtures/anchor-striped-read.c'), '-o', binary]);
    assert.deepEqual(JSON.parse(run(binary, [], {TMPDIR: dir})), {status:'PASS', executed_checks:27});
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
