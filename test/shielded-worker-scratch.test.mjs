import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('worker scratch growth preserves cleanup ownership on allocation and synchronization failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-scratch-'));
  try {
    const bin = join(dir, 'test');
    execFileSync('c++', ['-std=c++17', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      fileURLToPath(new URL('./fixtures/shielded-worker-scratch.cpp', import.meta.url)), '-o', bin], {timeout: 30_000});
    execFileSync(bin, {timeout: 10_000});
  } finally {rmSync(dir, {recursive: true, force: true});}
});
