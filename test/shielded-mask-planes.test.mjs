import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const source = (name) => fileURLToPath(new URL(`../wasm/ggml-shielded/${name}`, import.meta.url));
const flags = ['-std=c11', '-O2', '-Wall', '-Wextra'];
const testEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SHIELDED_')));

// mask_planes produces what crosses to the untrusted worker. Dropping its
// redundant mod-M reduction is only safe if the planes are bit-identical, so
// this exhausts every value of x+r the kernel's contract permits (~1.5e8) and
// then holds both SIMD tables' real kernels to the old formula.
test('the masked planes are identical after dropping the redundant mod-M reduction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-mask-planes-'));
  try {
    const simd = join(dir, 'simd.o'), fast = join(dir, 'fast.o');
    execFileSync('cc', [...flags, '-c', source('shielded-simd.c'), '-o', simd], { timeout: 60_000 });
    const arm = process.arch === 'arm64';
    execFileSync('cc', [...flags, ...(arm ? ['-march=armv8.2-a+dotprod', '-DSH_SIMD_NEON'] :
      ['-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512']),
      '-c', source('shielded-simd.c'), '-o', fast], { timeout: 60_000 });
    const bin = join(dir, 'mask');
    execFileSync('cc', [...flags, '-ffp-contract=off', fixture('shielded-mask-planes.c'), simd, fast,
      '-lpthread', '-lm', '-o', bin], { timeout: 60_000 });
    execFileSync(bin, { timeout: 600_000, env: testEnv, stdio: ['ignore', 'inherit', 'inherit'] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
