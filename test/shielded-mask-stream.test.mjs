import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('SIMD mask sampler preserves the ChaCha20 stream and bank uniqueness', { skip: process.arch !== 'x64' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-mask-stream-'));
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const gg = join(repo, 'wasm/ggml-shielded');
  const sanitize = process.env.SHIELDED_TEST_SANITIZE === '1';
  const flags = ['-std=c11', sanitize ? '-O1' : '-O3', '-ffp-contract=off', '-ffunction-sections', '-fdata-sections'];
  if (sanitize) flags.push('-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer');
  const env = { ...process.env, ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' };
  try {
    const fast = join(dir, 'fast.o'), binary = join(dir, 'fixture');
    execFileSync('cc', [...flags, '-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512',
      '-c', join(gg, 'shielded-simd.c'), '-o', fast], { timeout: 60_000 });
    execFileSync('cc', [...flags, join(repo, 'test/fixtures/shielded-mask-stream.c'), fast,
      join(gg, 'shielded-simd.c'), join(gg, 'shielded-field.c'), join(gg, 'shielded-pads.c'),
      '-Wl,--gc-sections', '-lm', '-pthread', '-o', binary], { timeout: 60_000 });
    for (const [opt, off] of [[undefined, '0'], ['', '0'], ['0', '0'], ['1', '0'], ['true', '0'], ['1', '1']]) {
      delete env.SHIELDED_MASK_CHACHA16;
      if (opt !== undefined) env.SHIELDED_MASK_CHACHA16 = opt;
      env.SHIELDED_NO_SIMD = off;
      const result = spawnSync(binary, [], { env, encoding: 'utf8', timeout: 60_000 });
      if (result.status === 77) { t.skip('AVX-512 unavailable'); return; }
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      assert.match(result.stdout, /one-use concurrency and exhaustion PASS/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
