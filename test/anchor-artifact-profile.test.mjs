import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
test('artifact profiling preserves bytes and failure errno while separating receiver phases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-profile-'));
  function run(program, args) {
    const r = spawnSync(program, args, {encoding:'utf8', timeout:30_000});
    assert.equal(r.status, 0, String(r.error ?? '') + r.stdout + r.stderr);
    return r.stdout;
  }
  try {
    const payload = join(root, 'shielded/anchor/avf/payload');
    const binary = join(dir, 'profile-test');
    run('cc', ['-std=c11', '-O1', '-g', '-D_DEFAULT_SOURCE', '-Wall', '-Wextra', '-Werror',
      '-Wno-unused-function', '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
      '-I'+payload, '-I'+join(root,'test/fixtures/anchor-catalog'), '-I'+join(root,'wasm/ggml-shielded'),
      join(root,'test/fixtures/anchor-artifact-profile.c'), join(payload,'anchor_artifacts.c'),
      join(payload,'anchor_names.c'), '-o',binary]);
    assert.deepEqual(JSON.parse(run(binary,[])), {status:'PASS', executed_checks:23});
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
