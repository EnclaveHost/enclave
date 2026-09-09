import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
test('cache-only model admission never modifies a retained model; default admission unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-model-cache-'));
  function run(program, args) {
    const r = spawnSync(program, args, { encoding: 'utf8', timeout: 60_000, env: { ...process.env, TMPDIR: dir } });
    assert.equal(r.status, 0, String(r.error ?? '') + r.stdout + r.stderr);
    return r.stdout;
  }
  try {
    const payload = join(root, 'shielded/anchor/avf/payload');
    const binary = join(dir, 'model-cache-test');
    run('cc', ['-std=c11', '-O1', '-g', '-D_POSIX_C_SOURCE=200809L', '-D_DEFAULT_SOURCE', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-fno-sanitize-recover=all', '-I' + payload,
      join(root, 'test/fixtures/anchor-model-cache.c'), join(payload, 'anchor_model_cache.c'), join(payload, 'anchor_auth.c'), '-o', binary]);
    assert.deepEqual(JSON.parse(run(binary, [])), { status: 'PASS', executed_checks: 69 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
