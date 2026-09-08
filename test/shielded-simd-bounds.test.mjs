import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('SIMD startup agreement probe has valid bounds for the packed long-row verification vector', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-simd-bounds-'));
  const source = (name) => fileURLToPath(new URL(`../wasm/ggml-shielded/${name}`, import.meta.url));
  try {
    writeFileSync(join(dir, 'probe.c'), `
#include ${JSON.stringify(source('shielded-tee.c'))}
#include <assert.h>
int main(void) {
    // Scalar kernels suffice: the old probe read 185 check-vector elements
    // from a 74-element array in BOTH the scalar and SIMD implementations.
    assert(simd_agree(sh_simd_generic(), sh_simd_generic()));
    assert(simd_agree(sh_simd_get(), sh_simd_generic()));
}
`);
    const bin = join(dir, 'probe');
    const flags = ['-std=c11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      '-ffunction-sections', '-fdata-sections', '-ffp-contract=off'];
    const fast = join(dir, 'fast.o');
    execFileSync('cc', [...flags, ...(process.arch === 'arm64' ? ['-march=armv8.2-a+dotprod', '-DSH_SIMD_NEON'] :
      ['-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512']),
      '-c', source('shielded-simd.c'), '-o', fast], { timeout: 30_000, stdio: 'pipe' });
    execFileSync('cc', [...flags, join(dir, 'probe.c'), fast,
      source('shielded-simd.c'), source('shielded-field.c'), '-Wl,--gc-sections', '-lm', '-lpthread', '-o', bin],
    { timeout: 30_000, stdio: 'pipe' });
    execFileSync(bin, { timeout: 10_000, env: { ...process.env,
      SHIELDED_NO_SIMD: '0', ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1',
      UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' }, stdio: 'pipe' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
