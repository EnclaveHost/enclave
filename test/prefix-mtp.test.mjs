import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('compound MTP prefix binds both sequence states and pending row in one private snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prefix-mtp-'));
  const gg = fileURLToPath(new URL('../wasm/ggml-shielded/', import.meta.url));
  const flags = ['-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-ffunction-sections', '-fdata-sections'];
  const run = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8', timeout: 60_000,
    env: {...process.env, ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1'}});
  try {
    const objects = [];
    for (const name of ['prefix-kv', 'shielded-pads', 'tweetnacl', 'poly1305-donna']) {
      const obj = join(dir, name + '.o'); objects.push(obj);
      run('cc', [...flags, '-D_POSIX_C_SOURCE=200809L', '-c', join(gg, name + '.c'), '-o', obj]);
    }
    const bin = join(dir, 'test');
    run('c++', [...flags, '-std=c++17', '-I' + gg,
      fileURLToPath(new URL('./fixtures/prefix-mtp.cpp', import.meta.url)), ...objects, '-Wl,--gc-sections', '-o', bin]);
    assert.match(run(bin, [dir]), /prefix-mtp: whole-container binding, private views and malformed lengths PASS/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
