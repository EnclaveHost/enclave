import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('mint scheduling preserves all original groups with bounded deterministic cost accounting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mint-balance-'));
  try {
    const bin = join(dir, 'balance');
    execFileSync('cc', ['-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      fileURLToPath(new URL('./fixtures/shielded-mint-balance.c', import.meta.url)), '-o', bin], {timeout: 20_000});
    execFileSync(bin, {timeout: 10_000});
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('balanced mint files retain original PRF groups and scalar products when thread creation fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mint-balanced-files-'));
  const root = fileURLToPath(new URL('../', import.meta.url)), gg = join(root, 'wasm/ggml-shielded');
  try {
    const bin = join(dir, 'files'), simd = join(dir, 'simd.o'), fast = join(dir, 'fast.o');
    const flags = ['-std=c11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      '-ffunction-sections', '-fdata-sections'];
    execFileSync('cc', [...flags, '-c', join(gg, 'shielded-simd.c'), '-o', simd], {timeout: 20_000});
    execFileSync('cc', [...flags, ...(process.arch === 'arm64' ? ['-march=armv8.2-a+dotprod', '-DSH_SIMD_NEON'] :
      ['-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512']),
      '-c', join(gg, 'shielded-simd.c'), '-o', fast], {timeout: 20_000});
    execFileSync('cc', [...flags, join(root, 'test/fixtures/shielded-mint-balanced-files.c'),
      ...['shielded-tee.c', 'shielded-field.c', 'shielded-wire.c', 'shielded-pads.c', 'shielded-bank.c',
        'shielded-http.c', 'tweetnacl.c', 'poly1305-donna.c'].map(f => join(gg, f)), simd, fast,
      '-Wl,--wrap=pthread_create', '-Wl,--gc-sections', '-pthread', '-lm', '-o', bin], {timeout: 30_000});
    execFileSync(bin, [dir], {timeout: 10_000,
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SHIELDED_')))});
  } finally {rmSync(dir, {recursive: true, force: true});}
});
