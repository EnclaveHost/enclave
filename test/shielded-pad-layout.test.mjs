import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
test('sparse layout refuses domain changes and out-of-window or oversized spans without partial outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-pad-layout-'));
  try {
    const binary = join(dir, 'layout');
    execFileSync('cc', ['-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      fileURLToPath(new URL('./fixtures/shielded-pad-layout.c', import.meta.url)), '-o', binary], {timeout: 10_000});
    assert.match(execFileSync(binary, {encoding: 'utf8', timeout: 10_000, env: {...process.env,
      ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1'}}), /sparse-layout: .* PASS/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
