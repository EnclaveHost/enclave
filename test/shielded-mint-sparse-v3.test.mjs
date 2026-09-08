import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('CPU sparse mint preserves canonical pad domains through reordered registration and thread failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sparse-mint-v3-'));
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const gg = join(repo, 'wasm/ggml-shielded');
  const flags = ['-std=c11', '-O1', '-Wall', '-Wextra', '-ffunction-sections', '-fdata-sections'];
  if (process.env.SHIELDED_TEST_SANITIZE === '1') flags.push('-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SHIELDED_')));
  Object.assign(env, { ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' });
  const run = (command, args, more = {}) => execFileSync(command, args, { env, timeout: 60_000, ...more });
  try {
    const binary = join(dir, 'fixture'), simd = join(dir, 'simd.o'), fast = join(dir, 'fast.o');
    run('cc', [...flags, '-c', join(gg, 'shielded-simd.c'), '-o', simd]);
    run('cc', [...flags, ...(process.arch === 'arm64' ? ['-march=armv8.2-a+dotprod', '-DSH_SIMD_NEON'] :
      ['-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512']),
      '-c', join(gg, 'shielded-simd.c'), '-o', fast]);
    run('cc', [...flags, join(repo, 'test/fixtures/shielded-mint-sparse-v3.c'),
      ...['shielded-field.c', 'shielded-wire.c', 'shielded-pads.c', 'shielded-bank.c', 'shielded-http.c',
        'tweetnacl.c', 'poly1305-donna.c'].map(f => join(gg, f)), simd, fast,
      '-Wl,--wrap=pthread_create', '-Wl,--wrap=malloc', '-Wl,--wrap=calloc', '-Wl,--wrap=pwrite',
      '-Wl,--gc-sections', '-pthread', '-lm', '-o', binary]);
    for (const mode of ['generic', 'detected']) {
      const bank = join(dir, mode); mkdirSync(bank);
      const output = run(binary, [bank], { env: { ...env, ...(mode === 'generic' ? { SHIELDED_NO_SIMD: '1' } : {}) }, encoding: 'utf8' });
      assert.match(output, /sparse-mint:.*PASS/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
