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
#if defined(__aarch64__)
    const int supported = (getauxval(AT_HWCAP) & HWCAP_ASIMDDP) != 0;
    const char *off = getenv("SHIELDED_NO_SIMD"), *tuned = getenv("SHIELDED_ARM_TUNED");
    const sh_simd *expected = !supported || (off && *off && strcmp(off, "0")) ? &simd_generic :
        tuned && !strcmp(tuned, "1") ? &simd_neon_tuned : &simd_neon;
#else
    __builtin_cpu_init();
    const int supported = __builtin_cpu_supports("avx512f") && __builtin_cpu_supports("avx512bw") &&
        __builtin_cpu_supports("avx512dq") && __builtin_cpu_supports("avx512vl") && __builtin_cpu_supports("avx512vnni");
    const char *off = getenv("SHIELDED_NO_SIMD"), *crt = getenv("SHIELDED_REFILL_VECTOR_CRT");
    const sh_simd *expected = !supported || (off && *off && strcmp(off, "0")) ? &simd_generic :
        crt && !strcmp(crt, "1") ? &simd_avx512_crt : &simd_avx512;
#endif
    assert(sh_simd_get() == expected);
    /* Changing an environment knob after admission cannot replace a link's
     * process-wide table while refill threads are running. */
    assert(setenv("SHIELDED_REFILL_VECTOR_CRT", "changed-after-admission", 1) == 0);
    assert(setenv("SHIELDED_ARM_TUNED", "changed-after-admission", 1) == 0);
    assert(sh_simd_get() == expected);
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
    const extra = [];
    execFileSync('cc', [...flags, ...(process.arch === 'arm64' ? ['-march=armv8.2-a+dotprod', '-DSH_SIMD_NEON'] :
      ['-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512']),
      '-c', source('shielded-simd.c'), '-o', fast], { timeout: 30_000, stdio: 'pipe' });
    if (process.arch === 'arm64') {
      const tuned = join(dir, 'tuned.o');
      execFileSync('cc', [...flags, '-march=armv8.2-a+dotprod', '-DSH_SIMD_NEON', '-DSH_SIMD_NEON_TUNED',
        '-c', source('shielded-simd.c'), '-o', tuned], { timeout: 30_000, stdio: 'pipe' });
      extra.push('-DSH_HAVE_NEON_TUNED', tuned);
    }
    execFileSync('cc', [...flags, ...extra, join(dir, 'probe.c'), fast,
      source('shielded-simd.c'), source('shielded-field.c'), '-Wl,--gc-sections', '-lm', '-lpthread', '-o', bin],
    { timeout: 30_000, stdio: 'pipe' });
    for (const [crt, noSimd] of [[undefined, '0'], ['', '0'], ['0', '0'], ['1', '0'], ['true', '0'], ['2', '0'], ['1', '1']]) {
      const env = { ...process.env, SHIELDED_NO_SIMD: noSimd,
        ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' };
      delete env.SHIELDED_REFILL_VECTOR_CRT;
      delete env.SHIELDED_ARM_TUNED;
      if (crt !== undefined) {
        env.SHIELDED_REFILL_VECTOR_CRT = crt;
        env.SHIELDED_ARM_TUNED = crt;
      }
      execFileSync(bin, { timeout: 10_000, env, stdio: 'pipe' });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
