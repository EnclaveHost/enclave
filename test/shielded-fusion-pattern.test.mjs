import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const source = (name) => fileURLToPath(new URL(`../wasm/ggml-shielded/${name}`, import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SHIELDED_')));
const sanitize = process.env.SHIELDED_TEST_SANITIZE === '1' ?
  ['-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer'] : [];

test('residual projection fusion recognizes complete safe islands and rejects unsupported shapes or ordering', (t) => {
  const headers = process.env.GGML_SRC || join(homedir(), 'Projects/llama.cpp');
  const libs = process.env.GGML_LIB || join(homedir(), 'Projects/llamacpp-lib');
  if (!existsSync(join(headers, 'ggml/include/ggml.h')) || !existsSync(join(libs, 'libggml-cpu.so'))) {
    return t.skip('needs GGML_SRC and GGML_LIB for the engine graph API');
  }
  const dir = mkdtempSync(join(tmpdir(), 'shielded-fusion-pattern-'));
  try {
    const bin = join(dir, 'pattern');
    const fixture = fileURLToPath(new URL('./fixtures/shielded-fusion-pattern.cpp', import.meta.url));
    execFileSync('c++', ['-std=c++17', '-O1', ...sanitize, '-Wall', '-Wextra', `-I${join(headers, 'ggml/include')}`,
      fixture, `-L${libs}`, '-lggml-cpu', '-lggml-base', `-Wl,-rpath,${libs}`, '-o', bin], { timeout: 30_000, stdio: 'pipe' });
    execFileSync(bin, { timeout: 10_000, stdio: 'pipe', env: { ...cleanEnv, OMP_NUM_THREADS: '1' } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the real scheduler admits only opted-in calibrated islands and preserves both outputs across graph reuse', async (t) => {
  const headers = process.env.GGML_SRC || join(homedir(), 'Projects/llama.cpp');
  const libs = process.env.GGML_LIB || join(homedir(), 'Projects/llamacpp-lib');
  if (!existsSync(join(headers, 'ggml/include/ggml.h')) || !existsSync(join(libs, 'libggml-cpu.so'))) {
    return t.skip('needs GGML_SRC and GGML_LIB for the engine graph API');
  }
  const dir = mkdtempSync(join(tmpdir(), 'shielded-fusion-scheduler-'));
  // Reserve and close an ephemeral loopback port, independently of any configured
  // deployment endpoint. The test never discovers or connects to a CUDA worker.
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  try {
    const cflags = ['-O1', ...sanitize, '-ffunction-sections', '-fdata-sections'];
    const objects = [];
    for (const name of ['shielded-field', 'shielded-wire', 'shielded-tee', 'shielded-pads', 'shielded-bank',
      'shielded-http', 'tweetnacl', 'poly1305-donna', 'shielded-simd']) {
      const obj = join(dir, `${name}.o`); objects.push(obj);
      execFileSync('cc', ['-std=c11', ...cflags, '-ffp-contract=off', '-c', source(`${name}.c`), '-o', obj],
        { timeout: 30_000, stdio: 'pipe' });
    }
    const fast = join(dir, 'fast.o'); objects.push(fast);
    execFileSync('cc', [...cflags, ...(process.arch === 'arm64' ? ['-march=armv8.2-a+dotprod', '-DSH_SIMD_NEON'] :
      ['-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512']),
      '-c', source('shielded-simd.c'), '-o', fast], { timeout: 30_000, stdio: 'pipe' });
    const bin = join(dir, 'scheduler');
    execFileSync('c++', ['-std=c++17', ...cflags, `-I${join(headers, 'ggml/include')}`, `-I${join(headers, 'ggml/src')}`,
      source('ggml-shielded.cpp'), fixture('shielded-fusion-scheduler.cpp'), ...objects, '-Wl,--gc-sections',
      `-L${libs}`, '-lggml', '-lggml-cpu', '-lggml-base', '-lpthread', '-lm', `-Wl,-rpath,${libs}`, '-o', bin],
      { timeout: 60_000, stdio: 'pipe' });
    for (const scenario of ['attn', 'ssm', 'outliers', 'bad-exponent', 'bad-negative', 'bad-delta', 'bad-inverse',
      'first-local', 'next-local', 'next-uncalibrated', 'invalid-pool']) {
      const calib = join(dir, `${scenario}.calib`);
      const names = ['attn_output', 'ssm_out', ...(scenario === 'next-uncalibrated' ? [] : ['ffn_gate', 'ffn_up'])];
      const af = scenario === 'bad-exponent' ? 2147483647 : scenario === 'bad-negative' ? -2147483648 :
        scenario === 'bad-inverse' ? -130 : 8;
      writeFileSync(calib, '# shielded-calib 1\n' + names.map(n => `site blk.3.${n}.weight ${af} ${scenario === 'outliers' ? '1 0' : '0'}\n`).join(''));
      for (const m of (scenario === 'attn' || scenario === 'ssm' ? [1, 3, 8, 16, 32] : [3])) {
        const env = { ...cleanEnv, SHIELDED_CALIB: calib, SHIELDED_HOST: '127.0.0.1', SHIELDED_PORT: String(port),
          SHIELDED_MIN_MACS: '0', SHIELDED_MAX_M: '16', SHIELDED_LOCAL_EXACT: '1', SHIELDED_NO_SIMD: '1',
          SHIELDED_LOCAL_THREADS: '1', SHIELDED_REFILL_THREADS: '1', OMP_NUM_THREADS: '1' };
        if (scenario === 'first-local') env.SHIELDED_LOCAL_SITES = 'blk.3.attn_output.weight';
        if (scenario === 'next-local') env.SHIELDED_LOCAL_SITES = 'blk.3.ffn_gate.weight,blk.3.ffn_up.weight';
        if (scenario === 'invalid-pool') env.SHIELDED_WORKERS = '';
        if (scenario === 'bad-delta') env.SHIELDED_AF_DELTA = '2147483647';
        const invalidCases = m === 3 && (scenario === 'attn' || scenario === 'outliers') ? ['invalid'] : [];
        const run = (knob) => JSON.parse(execFileSync(bin, [String(m), scenario, ...invalidCases], {
          timeout: 15_000, encoding: 'utf8', stdio: 'pipe',
          env: knob === undefined ? env : { ...env, SHIELDED_FUSE_LOCAL: knob },
        }).trim().split('\n').at(-1));
        const baseline = run(undefined), off = run('0'), on = run('1');
        assert.deepEqual(off, baseline, `${scenario} m=${m}: default differs from explicit off`);
        assert.deepEqual(on.output, baseline.output, `${scenario} m=${m}: final FFN result changed`);
        assert.deepEqual(on.residual, baseline.residual, `${scenario} m=${m}: residual lifetime changed`);
        assert.equal(on.island_nodes, (scenario === 'attn' || scenario === 'ssm' || scenario === 'outliers' || scenario.startsWith('bad-')) && m <= 16 ? 3 : 0);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
