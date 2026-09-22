import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const source = (name) => fileURLToPath(new URL(`../wasm/ggml-shielded/${name}`, import.meta.url));
const flags = ['-std=c11', '-O1', '-Wall', '-Wextra'];
if (process.env.SHIELDED_TEST_SANITIZE === '1') flags.push('-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer');
const testEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SHIELDED_')));

// The column split adds only its own columns out of the primary card's
// full-width outlier table. That must be bit-identical to the whole-tensor
// call and to a plain integer reference, on both SIMD tables and on the
// non-exact fallback.
test('the outlier term over a column slice is bit-identical to the whole-tensor term', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-outlier-stride-'));
  try {
    const simd = join(dir, 'simd.o');
    const fast = join(dir, 'fast.o');
    execFileSync('cc', [...flags, '-c', source('shielded-simd.c'), '-o', simd], { timeout: 60_000 });
    const arm = process.arch === 'arm64';
    execFileSync('cc', [...flags, ...(arm ? ['-march=armv8.2-a+dotprod', '-DSH_SIMD_NEON'] :
      ['-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512']),
      '-c', source('shielded-simd.c'), '-o', fast], { timeout: 60_000 });
    const bin = join(dir, 'outlier');
    execFileSync('cc', [...flags, '-ffp-contract=off', fixture('shielded-outlier-stride.c'),
      simd, fast, '-lpthread', '-lm', '-o', bin], { timeout: 60_000 });
    execFileSync(bin, { timeout: 120_000, env: { ...testEnv, SHIELDED_NO_SIMD: '1' } });
    execFileSync(bin, { timeout: 120_000, env: { ...testEnv, SHIELDED_NO_SIMD: '0' } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
