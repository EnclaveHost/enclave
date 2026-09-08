import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

test('persistent dealer rejects malformed or replayed requests and acknowledges each completed job over pipes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-dealer-stream-'));
  try {
    const bin = join(dir, 'stream');
    const flags = ['-std=c++17', '-O1', '-Wall', '-Wextra', '-Werror'];
    if (process.env.SHIELDED_TEST_SANITIZE === '1') flags.push('-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer');
    execFileSync('c++', [...flags, fileURLToPath(new URL('./fixtures/shielded-dealer-stream.cpp', import.meta.url)), '-o', bin], {timeout: 30_000});
    execFileSync(bin, {timeout: 5_000});
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('real MTP stream preserves opened pad cells across jobs and refuses a changed calibration', t => {
  const {GGML_SRC: src, GGML_LIB: lib, DEALER_TEST_SO: so,
    DEALER_TEST_MODEL: model, DEALER_TEST_CALIB: calib} = process.env;
  if (![src, lib, so, model, calib].every(x => x && existsSync(x)))
    return t.skip('requires explicit real CPU dealer, model, calibration and GGML paths');
  const dir = mkdtempSync(join(tmpdir(), 'dealer-stream-model-'));
  const root = fileURLToPath(new URL('../', import.meta.url)), gg = join(root, 'wasm/ggml-shielded');
  try {
    const bin = join(dir, 'dealer'), compare = join(dir, 'compare');
    const link = ['-L' + lib, '-lllama', '-lggml', '-lggml-base', so,
      '-ldl', '-lpthread', '-lm', '-Wl,-rpath,' + lib, '-Wl,-rpath,' + dirname(so)];
    execFileSync('c++', ['-O2', '-std=c++17', '-I' + join(src, 'include'), '-I' + join(src, 'ggml/include'),
      join(gg, 'shielded-dealer.cpp'), ...link, '-o', bin], {timeout: 30_000});
    execFileSync('cc', ['-O2', join(root, 'test/fixtures/shielded-dealer-compare.c'), ...link, '-o', compare], {timeout: 30_000});
    const output = execFileSync('python3', [join(root, 'test/fixtures/shielded-dealer-stream-model.py'),
      bin, model, calib, so, join(lib, 'libggml-cpu.so'), dir, compare],
      {timeout: 150_000, encoding: 'utf8', env: {...process.env, LD_LIBRARY_PATH: lib}});
    t.diagnostic(output.trim());
  } finally {
    if (process.env.DEALER_TEST_KEEP_ARTIFACTS === '1') t.diagnostic('artifacts: ' + dir);
    else rmSync(dir, {recursive: true, force: true});
  }
});
