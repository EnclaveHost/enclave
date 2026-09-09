// Private metadata admission and block-verified encoded artifacts. Python only
// constructs independent tiny fixtures with hashlib/struct; runtime code is C/C++.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const payload = join(root, 'shielded/anchor/avf/payload');
const backend = join(root, 'wasm/ggml-shielded');
const fixtures = join(here, 'fixtures/anchor-catalog');

test('catalog admission binds private headers and encoded artifacts to measured expectations', { timeout: 60000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-catalog-'));
  function run(program, args, env = process.env) {
    const r = spawnSync(program, args, { encoding: 'utf8', timeout: 30000, env, maxBuffer: 4 << 20 });
    assert.equal(r.status, 0, `${program}: ${r.error || ''}\n${r.stdout}\n${r.stderr}`);
    return r;
  }
  try {
    const flags = ['-O1', '-g', '-fno-omit-frame-pointer', '-fsanitize=address,undefined',
      '-fno-sanitize-recover=all', '-D_POSIX_C_SOURCE=200809L', '-I', payload, '-I', backend, '-I', fixtures];
    const objects = [];
    for (const name of ['anchor_gguf', 'anchor_catalog', 'anchor_encoded_catalog']) {
      const object = join(dir, `${name}.o`);
      run('cc', ['-std=c11', ...flags, '-c', join(payload, `${name}.c`), '-o', object]);
      objects.push(object);
    }
    run('cc', ['-std=c11', ...flags, '-no-pie', join(fixtures, 'check.c'),
      ...objects, '-o', join(dir, 'check')]);
    const nacl = join(dir, 'nacl.o');
    run('cc', ['-std=c11', ...flags, '-c', join(backend, 'tweetnacl.c'), '-o', nacl]);
    run('c++', ['-std=c++17', ...flags, '-no-pie', join(fixtures, 'check_encoded.cpp'),
      ...objects, nacl, '-o', join(dir, 'check-encoded')]);
    const result = run('python3', ['-m', 'unittest', 'discover', '-s', fixtures, '-p', 'test_*.py', '-v'],
      { ...process.env, CATALOG_TEST_BIN: dir, PYTHONDONTWRITEBYTECODE: '1' });
    assert.match(result.stderr, /Ran 9 tests/);
    assert.match(result.stderr, /\bOK\b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
