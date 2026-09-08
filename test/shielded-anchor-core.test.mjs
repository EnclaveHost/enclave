import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('anchor core consumes each response once and rejects unsafe arithmetic before raw kernels', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-anchor-core-'));
  const source = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
  try {
    const bin = join(dir, 'probe');
    execFileSync('cc', ['-std=c11', '-O1', '-g', '-fsanitize=address,undefined',
      '-fno-omit-frame-pointer', '-ffunction-sections', '-fdata-sections',
      '-I', source('wasm/ggml-shielded'), source('test/fixtures/shielded-anchor-core.c'),
      source('shielded/anchor/core/anchor-core.c'), source('wasm/ggml-shielded/shielded-simd.c'),
      source('wasm/ggml-shielded/shielded-field.c'), '-Wl,--gc-sections',
      '-Wl,--wrap=sh_simd_generic_unmask_fv', '-lm', '-o', bin],
    { timeout: 30_000, stdio: 'pipe' });
    execFileSync(bin, { timeout: 10_000, env: { ...process.env,
      ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1',
      UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' }, stdio: 'pipe' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
