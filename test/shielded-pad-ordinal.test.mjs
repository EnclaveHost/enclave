import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..'), gg = join(root, 'wasm/ggml-shielded');
test('dealt masks use the authenticated shipment ordinal after name-based reordered/subset binding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-pad-ordinal-'));
  const flags = ['-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-ffunction-sections', '-fdata-sections'];
  const env = {...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SHIELDED_'))),
    ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1'};
  const run = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8', timeout: 60_000, env});
  try {
    const simd = join(dir, 'simd.o'), fast = join(dir, 'fast.o'), bin = join(dir, 'test');
    run('cc', [...flags, '-c', join(gg, 'shielded-simd.c'), '-o', simd]);
    run('cc', [...flags, ...(process.arch === 'arm64' ? ['-march=armv8.2-a+dotprod', '-DSH_SIMD_NEON'] :
      ['-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512']),
      '-c', join(gg, 'shielded-simd.c'), '-o', fast]);
    const sources = ['shielded-field.c', 'shielded-wire.c', 'shielded-pads.c', 'shielded-bank.c', 'shielded-http.c', 'tweetnacl.c', 'poly1305-donna.c'];
    run('cc', [...flags, '-std=c11', join(root, 'test/fixtures/shielded-pad-ordinal.c'),
      ...sources.map(s => join(gg, s)), simd, fast, '-Wl,--gc-sections', '-pthread', '-lm', '-o', bin]);
    assert.match(run(bin, [dir]), /pad-ordinal: reordered\/subset\/shared groups/);
    for (const mode of ['0','1','2']) assert.match(execFileSync(bin, [dir], {
      encoding: 'utf8', timeout: 60_000, env: {...env, SHIELDED_PAD_CHECK_TILED: mode}
    }), /pad-ordinal: reordered\/subset\/shared groups/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
