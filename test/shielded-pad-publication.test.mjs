import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..'), gg = join(root, 'wasm/ggml-shielded');
test('pad writer publishes complete durable files, rejects nonce reuse and survives write failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-pad-publication-'));
  try {
    const binary = join(dir, 'test');
    execFileSync('cc', ['-std=c11', '-O1', '-g', '-Wall', '-Wextra',
      '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      '-ffunction-sections', '-fdata-sections', join(root, 'test/fixtures/shielded-pad-publication.c'),
      join(gg, 'tweetnacl.c'), join(gg, 'poly1305-donna.c'), '-Wl,--gc-sections', '-pthread', '-o', binary], {timeout: 20_000});
    const output = execFileSync(binary, [dir], {encoding: 'utf8', timeout: 10_000,
      env: {...process.env, ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1'}});
    assert.match(output, /pad-publication: PASS/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
