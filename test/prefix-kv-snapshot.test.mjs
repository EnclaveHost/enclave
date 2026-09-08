import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('signed prefix snapshot survives source mutation and refuses corrupt or oversized reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prefix-snapshot-'));
  const gg = fileURLToPath(new URL('../wasm/ggml-shielded/', import.meta.url));
  const flags = ['-D_GNU_SOURCE', '-DSH_PREFIX_TEST_IO', '-std=c11', '-O1', '-g',
    '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-ffunction-sections', '-fdata-sections'];
  const run = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8', timeout: 60_000,
    env: {...process.env, ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1'}});
  try {
    const objs = [];
    for (const name of ['prefix-kv', 'prefix-kv-selftest', 'shielded-pads', 'tweetnacl', 'poly1305-donna']) {
      const obj = join(dir, name + '.o'); objs.push(obj);
      run('cc', [...flags, '-c', join(gg, name + '.c'), '-o', obj]);
    }
    const bin = join(dir, 'test');
    run('cc', [...flags, ...objs, '-Wl,--gc-sections', '-Wl,--wrap=pread', '-o', bin]);
    assert.match(run(bin, []), /prefix-kv-selftest: ok/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
