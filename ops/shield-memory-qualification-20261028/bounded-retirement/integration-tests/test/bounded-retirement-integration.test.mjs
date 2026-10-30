import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
// Exact backend source and engine paths come from the byte-identical rebuild.
const root = join(dirname(fileURLToPath(import.meta.url)), '..'), prior = join(root, '..', 'backend-rebuild-r1');
const result = JSON.parse(readFileSync(join(prior, 'RESULT.json'), 'utf8'));
const fromArgv = k => (result.argv.find(a => a.startsWith(k + '=')) || '').slice(k.length + 1);
const gg = join(prior, 'src'), candidate = join(root, '..', 'candidate');
const sha256 = f => createHash('sha256').update(readFileSync(f)).digest('hex');
test('candidate bounded retirement with the exact backend: mid-batch retirement, authenticated rereads, exact local products', t => {
  assert.equal(result.byteIdentical, true);
  for (const [name, digest] of Object.entries(result.sourceHashes))
    assert.equal(sha256(join(gg, name)), digest, `backend source ${name} differs from RESULT.json`);
  assert.equal(sha256(join(candidate, 'shield-original-source.hpp')), 'd6dee052f3674fd856d6eb9eaf980c1b82322744d97cdd6751c6c4a602edcbff', 'candidate hash changed');
  const headers = fromArgv('GGML_SRC');
  const libs = fromArgv('GGML_LIB');
  if (!existsSync(join(headers, 'ggml/include/ggml.h')) || !existsSync(join(libs, 'libggml-cpu.so')))
    assert.fail('needs the pinned deployed engine GGML_SRC and GGML_LIB');
  const dir = mkdtempSync(join(tmpdir(), 'bounded-retirement-integration-'));
  const flags = ['-O0', '-g0', '-DGGML_MAX_NAME=128', '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-ffunction-sections', '-fdata-sections', '-ffp-contract=off'];
  const env = {...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SHIELDED_') && !k.startsWith('ENCLAVE_'))),
    ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1'};
  const run = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8', timeout: cmd === 'c++' ? 180_000 : 120_000, env});
  try {
    const objects = [];
    for (const name of ['shielded-field', 'shielded-wire', 'shielded-tee', 'shielded-parwork', 'shielded-pads', 'shielded-bank',
      'shielded-http', 'tweetnacl', 'poly1305-donna', 'shielded-simd']) {
      const obj = join(dir, name + '.o'); objects.push(obj);
      run('cc', [...flags, '-std=c11', '-c', join(gg, name + '.c'), '-o', obj]);
    }
    const fast = join(dir, 'fast.o'); objects.push(fast);
    run('cc', [...flags, ...(process.arch === 'arm64' ? ['-march=armv8.2-a+dotprod', '-DSH_SIMD_NEON'] :
      ['-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni', '-DSH_SIMD_AVX512']),
      '-c', join(gg, 'shielded-simd.c'), '-o', fast]);
    // SHIELDED_COMPACT_TEST_ROOT='' disables the compact scenarios explicitly.
    const compactRoot = fromArgv('SHIELDED_COMPACT_ROOT');
    const compact = !!compactRoot && existsSync(join(compactRoot, 'usr/include'));
    const compactFlags = [];
    if (compact) {
      const co = join(dir, 'compact.o'); objects.push(co);
      run('c++', [...flags, '-std=c++17', '-I' + join(compactRoot, 'usr/include'),
        '-mavx512f', '-mavx512bw', '-mavx512dq', '-mavx512vl', '-mavx512vnni',
        '-c', join(gg, 'shielded-compact.cpp'), '-o', co]);
      compactFlags.push('-DSHIELDED_COMPACT', '-L' + join(compactRoot, 'usr/lib'), '-ldnnl', '-lgomp', '-Wl,-rpath,' + join(compactRoot, 'usr/lib'));
    } else assert.fail('required compact root is absent; no partial qualification');
    const bin = join(dir, 'test');
    run('c++', [...flags, '-std=c++17', '-Wno-deprecated-declarations', '-I' + gg, '-I' + candidate,
      '-I' + join(headers, 'ggml/include'), '-I' + join(headers, 'ggml/src'),
      join(root, 'test/fixtures/bounded-retirement-integration.cpp'), ...objects, ...compactFlags, '-Wl,--gc-sections',
      '-L' + libs, '-lggml', '-lggml-cpu', '-lggml-base', '-lcrypto', '-lpthread', '-lm', '-Wl,-rpath,' + libs, '-o', bin]);
    for (const scenario of ['bounded_local', 'bounded_split_local', 'tiny_local', 'default_local', 'default_split_local',
      ...(compact ? ['bounded_compact', 'bounded_compact_split'] : [])])
      { t.diagnostic('scenario ' + scenario); assert.match(run(bin, [dir, scenario]), /mid-batch retirement, authenticated rereads and exact local products passed/); }
    for (const scenario of ['private_tamper', 'punch_fail'])
      { t.diagnostic('scenario ' + scenario); assert.match(run(bin, [dir, scenario]), /registration failure failed closed/); }
    for (const scenario of ['backing_tamper_reread', 'backing_truncate_reread']) {
      t.diagnostic('scenario ' + scenario);
      const refused = spawnSync(bin, [dir, scenario], {env, encoding: 'utf8', timeout: 120_000});
      assert.equal(refused.signal, 'SIGABRT', scenario);
      assert.match(refused.stdout, /pre-abort checks passed/);
      assert.match(refused.stderr, /authenticated weight source read failed/);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
