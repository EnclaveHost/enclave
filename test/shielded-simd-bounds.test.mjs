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
#include <fenv.h>
#include <math.h>
static void checked_encode(const sh_simd *s) {
    float src[66]; int64_t old[66], got[66];
    const int modes[] = {FE_TONEAREST, FE_DOWNWARD, FE_UPWARD, FE_TOWARDZERO};
    for (size_t mode = 0; mode < sizeof modes / sizeof modes[0]; mode++) {
        assert(fesetround(modes[mode]) == 0);
        for (size_t n = 0; n <= 64; n++) {
            for (size_t i = 0; i < n; i++) src[i] = ((int)(i * 13 % 31) - 15) / 8.0f;
            got[0] = got[n + 1] = 1234567;
            s->encode(src, n, 4.0f, old);
            assert(s->encode_checked(src, n, 4.0f, (float)SH_FV_X_LIMIT, got + 1));
            assert(!memcmp(old, got + 1, n * sizeof(int64_t)));
            assert(got[0] == 1234567 && got[n + 1] == 1234567);
        }
    }
    assert(fesetround(FE_TONEAREST) == 0);
    for (size_t n = 1; n <= 64; n++) {
        for (size_t i = 0; i < n; i++) src[i] = (i % 2 ? -1 : 1) * 0x1p49f;
        s->encode(src, n, 1.0f, old);
        assert(s->encode_checked(src, n, 1.0f, 0x1p50f, got));
        assert(!memcmp(old, got, n * sizeof(int64_t)));
        const float bad[] = {NAN, INFINITY, -INFINITY, (float)SH_FV_X_LIMIT, -(float)SH_FV_X_LIMIT, 0x1p63f, -0x1p63f};
        for (size_t b = 0; b < sizeof bad / sizeof bad[0]; b++) for (size_t at = 0; at < n; at++) {
            for (size_t i = 0; i < n; i++) src[i] = 1.0f;
            src[at] = bad[b];
            got[0] = got[n + 1] = 1234567;
            assert(!s->encode_checked(src, n, 1.0f, (float)SH_FV_X_LIMIT, got + 1));
            assert(got[0] == 1234567 && got[n + 1] == 1234567);
        }
    }
    const float bad_scales[] = {0.0f, -1.0f, NAN, INFINITY};
    for (size_t i = 0; i < sizeof bad_scales / sizeof bad_scales[0]; i++) {
        assert(!s->encode_checked(src, 64, bad_scales[i], (float)SH_FV_X_LIMIT, got));
        assert(!s->encode_checked(src, 64, 1.0f, bad_scales[i], got));
    }
    assert(!s->encode_checked(src, 64, 1.0f, 0x1p63f, got));
    assert(!s->encode_checked(src, 64, 1.0f, 0x1p20f, got));
    assert(!s->encode_checked(src, 64, 1.0f, 0x1.4p27f, got));
}
int main(void) {
    // Scalar kernels suffice: the old probe read 185 check-vector elements
    // from a 74-element array in BOTH the scalar and SIMD implementations.
    assert(simd_agree(sh_simd_generic(), sh_simd_generic()));
    assert(simd_agree(sh_simd_get(), sh_simd_generic()));
    checked_encode(sh_simd_generic());
    checked_encode(sh_simd_get());
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
