import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('verified GGUF header is served only from private memory without a backing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-header-file-'));
  try {
    const bin = join(dir, 'test');
    execFileSync('cc', ['-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-fsanitize=address,undefined',
      '-fno-omit-frame-pointer', fileURLToPath(new URL('./fixtures/anchor-header-file.c', import.meta.url)), '-o', bin]);
    assert.match(execFileSync(bin, {encoding: 'utf8', timeout: 10000,
      env: {...process.env, ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1'}}),
      /anchor-header-file: private reads/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
