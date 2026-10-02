import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('refill scratch covers native nodes while providers keep their own storage', { skip: !['x64', 'arm64'].includes(process.arch) }, t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const gg = join(root, 'wasm/ggml-shielded');
  const dir = mkdtempSync(join(tmpdir(), 'refill-scratch-'));
  const flags = ['-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-ffunction-sections', '-fdata-sections',
    '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-ffp-contract=off'];
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SHIELDED_'))),
    ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' };
  const run = (cmd, args) => execFileSync(cmd, args, { env, encoding: 'utf8', timeout: 60_000 });
  try {
    const generic = join(dir, 'generic.o'), fast = join(dir, 'fast.o'), binary = join(dir, 'fixture');
    run('cc', [...flags, '-c', join(gg, 'shielded-simd.c'), '-o', generic]);
    const arch = process.arch === 'arm64' ? ['-march=armv8.2-a+dotprod', '-DSH_SIMD_NEON'] :
      ['-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512'];
    run('cc', [...flags, ...arch, '-c', join(gg, 'shielded-simd.c'), '-o', fast]);
    run('cc', [...flags, join(root, 'test/fixtures/shielded-refill-scratch.c'), generic, fast,
      join(gg, 'shielded-field.c'), join(gg, 'shielded-parwork.c'),
      '-Wl,--wrap=malloc', '-Wl,--gc-sections', '-pthread', '-lm', '-o', binary]);
    const output = run(binary, []);
    assert.match(output, /refill-scratch: 64 exact native\/provider\/mixed cases; allocation failures and provider-error wipes passed/);
    t.diagnostic(output.trim());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
