import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..'), gg = join(root, 'wasm/ggml-shielded');
test('parallel pad-check preparation matches the int128 reference and actually dispatches threads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-pad-parallel-'));
  const env = {...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SHIELDED_'))),
    ASAN_OPTIONS: 'detect_leaks=1', UBSAN_OPTIONS: 'halt_on_error=1'};
  const run = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8', timeout: 120_000, env});
  const src = join(root, 'test/fixtures/shielded-pad-parallel.c');
  try {
    // Plain build: the fixture's own checks, at the optimisation the engine uses.
    const plain = join(dir, 'plain');
    run('cc', ['-O2', '-std=c11', '-Wall', '-Wextra', '-pthread', '-I', gg, src, '-o', plain]);
    assert.match(run(plain, []), /all pad-parallel checks passed/);
    // Sanitized build. The fixture forks a child that is REQUIRED to abort, so
    // abort_on_error is left off and the child's SIGABRT is the expected result.
    const san = join(dir, 'san');
    run('cc', ['-O1', '-g', '-std=c11', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      '-pthread', '-I', gg, src, '-o', san]);
    assert.match(run(san, []), /all pad-parallel checks passed/);
    // Thread sanitizer corroborates the disjoint-range claim on the interleavings
    // it happens to execute; it is not a proof that no race exists.
    if (process.env.SHIELDED_TEST_TSAN === '1') {
      const tsan = join(dir, 'tsan');
      run('cc', ['-O1', '-g', '-std=c11', '-fsanitize=thread', '-pthread', '-I', gg, src, '-o', tsan]);
      assert.match(run(tsan, []), /all pad-parallel checks passed/);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
