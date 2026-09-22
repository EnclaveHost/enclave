import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..'), gg = join(root, 'wasm/ggml-shielded');
const flags = ['-O1','-g','-fsanitize=address,undefined','-fno-omit-frame-pointer','-Wall','-Wextra','-std=c11'];
const env = {...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SHIELDED_'))),
  ASAN_OPTIONS:'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS:'halt_on_error=1'};

// The pipe restarts its counters on reconnect; the link total must not.
test('idle accumulator folds per-pipe counters across reconnects without losing or double counting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-idle-acc-'));
  try {
    const bin = join(dir, 'idle');
    execFileSync('cc', [...flags, '-I' + gg, join(root, 'test/fixtures/shielded-idle-acc.c'), '-o', bin],
      {timeout: 60_000, env});
    const out = execFileSync(bin, {encoding: 'utf8', timeout: 30_000, env});
    process.stderr.write(out);
    assert.match(out, /idle-acc: ok/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
