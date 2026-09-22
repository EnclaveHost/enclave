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

// The range check on the untrusted reply decides whether any kernel may touch
// it. It was moved into the SIMD table to be built with the arch flags; that
// is only safe if it is the same predicate, so hold every table's version to
// the portable reference over the field edges, INT32_MIN/MAX, and a bad value
// at every position including the last.
test('the reply range check is identical in every SIMD table and at every boundary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-reply-balanced-'));
  try {
    const simd = join(dir, 'simd.o'), fast = join(dir, 'fast.o');
    execFileSync('cc', [...flags, '-c', source('shielded-simd.c'), '-o', simd], { timeout: 60_000 });
    const arm = process.arch === 'arm64';
    execFileSync('cc', [...flags, ...(arm ? ['-march=armv8.2-a+dotprod', '-DSH_SIMD_NEON'] :
      ['-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512']),
      '-c', source('shielded-simd.c'), '-o', fast], { timeout: 60_000 });
    const bin = join(dir, 'reply');
    execFileSync('cc', [...flags, '-ffp-contract=off', fixture('shielded-reply-balanced.c'), simd, fast,
      '-lpthread', '-lm', '-o', bin], { timeout: 60_000 });
    execFileSync(bin, { timeout: 180_000, env: testEnv });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
