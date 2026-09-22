import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const flags = ['-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-Wall','-Wextra','-std=c++17'];
const env = {...process.env, ASAN_OPTIONS:'detect_leaks=0:abort_on_error=1', UBSAN_OPTIONS:'halt_on_error=1'};

// The buffer outlives its flush handler on a NORMAL exit, and truncation is reported.
test('buffered phase trace flushes cleanly at normal exit and reports dropped records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-trace-exit-'));
  try {
    const bin = join(dir, 'trace');
    execFileSync('c++', [...flags, join(root, 'test/fixtures/shielded-trace-exit.cpp'), '-o', bin],
      {timeout: 120_000, env});
    const out = execFileSync(bin, {encoding: 'utf8', timeout: 30_000, env});
    process.stderr.write(out);
    assert.match(out, /flushed 64 records, dropped 36/);   // truncation is visible, not silent
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
