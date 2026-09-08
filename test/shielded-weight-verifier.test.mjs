import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..'), gg = join(root, 'wasm/ggml-shielded');
test('weight authentication binds the private encoded source and prevents fallback to revoked source pages', t => {
  const headers = process.env.GGML_SRC || join(homedir(), 'Projects/llama.cpp');
  const libs = process.env.GGML_LIB || join(homedir(), 'Projects/llamacpp-lib');
  if (!existsSync(join(headers, 'ggml/include/ggml.h')) || !existsSync(join(libs, 'libggml-cpu.so')))
    return t.skip('needs GGML_SRC and GGML_LIB for the backend registration API');
  const dir = mkdtempSync(join(tmpdir(), 'shielded-weight-verifier-'));
  const flags = ['-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-ffunction-sections', '-fdata-sections', '-ffp-contract=off'];
  const env = {...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SHIELDED_'))),
    ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1'};
  const run = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8', timeout: 60_000, env});
  try {
    const objects = [];
    for (const name of ['shielded-field', 'shielded-wire', 'shielded-tee', 'shielded-pads', 'shielded-bank',
      'shielded-http', 'tweetnacl', 'poly1305-donna', 'shielded-simd']) {
      const obj = join(dir, name + '.o'); objects.push(obj);
      run('cc', [...flags, '-std=c11', '-c', join(gg, name + '.c'), '-o', obj]);
    }
    const fast = join(dir, 'fast.o'); objects.push(fast);
    run('cc', [...flags, ...(process.arch === 'arm64' ? ['-march=armv8.2-a+dotprod', '-DSH_SIMD_NEON'] :
      ['-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512']),
      '-c', join(gg, 'shielded-simd.c'), '-o', fast]);
    const bin = join(dir, 'test');
    run('c++', [...flags, '-std=c++17', '-I' + join(headers, 'ggml/include'), '-I' + join(headers, 'ggml/src'),
      join(root, 'test/fixtures/shielded-weight-verifier.cpp'), ...objects, '-Wl,--gc-sections',
      '-L' + libs, '-lggml', '-lggml-cpu', '-lggml-base', '-lpthread', '-lm', '-Wl,-rpath,' + libs, '-o', bin]);
    for (const scenario of ['honest', 'tamper', 'shape', 'source', 'source_tamper', 'source_readfail', 'source_cpu', 'background_integrity'])
      assert.match(run(bin, [dir, scenario]), /weight-verifier: private-copy encoding/);
    const refused = spawnSync(bin, [dir, 'source_cpu_tamper'], {env, encoding: 'utf8', timeout: 60_000});
    assert.equal(refused.signal, 'SIGABRT');
    assert.match(refused.stderr, /authenticated weight source read failed/);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
