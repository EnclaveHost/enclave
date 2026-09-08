import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const source = (name) => fileURLToPath(new URL(`../wasm/ggml-shielded/${name}`, import.meta.url));
const flags = ['-std=c11', '-O1', '-Wall', '-Wextra', '-ffunction-sections', '-fdata-sections'];
if (process.env.SHIELDED_TEST_SANITIZE === '1') flags.push('-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer');
const testEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SHIELDED_')));

test('socket work runs once on the caller after the full write, before reading, including reply failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-overlap-wire-'));
  try {
    const bin = join(dir, 'wire');
    execFileSync('cc', [...flags, fixture('shielded-overlap-wire.c'), '-Wl,--gc-sections', '-lpthread', '-o', bin], { timeout: 30_000 });
    execFileSync(bin, { timeout: 10_000, env: testEnv });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('overlapped verification preserves exact grouped products and rejects corrupt, wrapped and malformed replies without pad reuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-overlap-verify-'));
  try {
    const simd = join(dir, 'simd.o');
    const fast = join(dir, 'fast.o');
    execFileSync('cc', [...flags, '-c', source('shielded-simd.c'), '-o', simd], { timeout: 30_000 });
    const arm = process.arch === 'arm64';
    execFileSync('cc', [...flags, ...(arm ? ['-march=armv8.2-a+dotprod', '-DSH_SIMD_NEON'] :
      ['-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512']),
      '-c', source('shielded-simd.c'), '-o', fast], { timeout: 30_000 });
    const core = ['shielded-field.c', 'shielded-pads.c', 'shielded-bank.c', 'shielded-http.c', 'tweetnacl.c', 'poly1305-donna.c'];
    const bin = join(dir, 'verify');
    execFileSync('cc', [...flags, '-ffp-contract=off', fixture('shielded-overlap-verify.c'), ...core.map(source), simd, fast,
      '-Wl,--gc-sections', '-lpthread', '-lm', '-o', bin], { timeout: 60_000 });
    execFileSync(bin, { timeout: 30_000, env: { ...testEnv, SHIELDED_NO_SIMD: '1' } });
    execFileSync(bin, { timeout: 30_000, env: { ...testEnv, SHIELDED_NO_SIMD: '0' } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
