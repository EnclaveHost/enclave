import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('worker diagnostic phase clocks and counters stay isolated between connections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-profile-'));
  try {
    const bin = join(dir, 'test');
    execFileSync('c++', ['-std=c++17', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      fileURLToPath(new URL('./fixtures/shielded-worker-profile.cpp', import.meta.url)), '-o', bin], {timeout: 30_000});
    execFileSync(bin, {timeout: 10_000});
  } finally {rmSync(dir, {recursive: true, force: true});}
});
