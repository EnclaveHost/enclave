import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('blocked CPU refill remains exact when its temporary allocation fails', { skip: process.arch !== 'x64' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'refill-oom-'));
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const gg = join(repo, 'wasm/ggml-shielded');
  const flags = ['-std=c11', process.env.SHIELDED_TEST_SANITIZE === '1' ? '-O1' : '-O3', '-ffp-contract=off', '-Wall', '-Wextra', '-ffunction-sections', '-fdata-sections'];
  if (process.env.SHIELDED_TEST_SANITIZE === '1') flags.push('-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer');
  const env = { ...process.env, ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' };
  try {
    const fast = join(dir, 'fast.o'), binary = join(dir, 'fixture');
    execFileSync('cc', [...flags, '-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512',
      '-c', join(gg, 'shielded-simd.c'), '-o', fast], { env, timeout: 60_000 });
    execFileSync('cc', [...flags, join(repo, 'test/fixtures/shielded-refill-oom.c'), join(gg, 'shielded-field.c'), fast,
      '-Wl,--wrap=malloc', '-Wl,--wrap=aligned_alloc', '-Wl,--gc-sections', '-lm', '-o', binary], { env, timeout: 60_000 });
    for (const args of [[], ['vector-crt']]) {
      const result = spawnSync(binary, args, { env, encoding: 'utf8', timeout: 60_000 });
      if (result.status === 77) { t.skip('AVX-512 VNNI unavailable'); return; }
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      assert.match(result.stdout, /refill-oom: 320 normal and forced-OOM shape pairs PASS/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
