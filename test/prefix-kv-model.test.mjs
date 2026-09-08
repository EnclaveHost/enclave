import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('private prefix restore matches every resumed logit after the signed source is truncated', t => {
  const model = process.env.SHIELDED_PREFIX_TEST_MODEL;
  const headers = process.env.GGML_SRC, libs = process.env.GGML_LIB;
  if (!model || !headers || !libs) return t.skip('set SHIELDED_PREFIX_TEST_MODEL, GGML_SRC and GGML_LIB for the pinned llama model test');
  const dir = mkdtempSync(join(tmpdir(), 'prefix-model-'));
  const gg = fileURLToPath(new URL('../wasm/ggml-shielded/', import.meta.url));
  const flags = ['-O1', '-g', '-ffunction-sections', '-fdata-sections'];
  const run = (cmd, args) => execFileSync(cmd, args, {encoding: 'utf8', timeout: 120_000,
    env: {...process.env, LD_LIBRARY_PATH: libs}});
  try {
    const objs = [];
    for (const name of ['prefix-kv', 'shielded-pads', 'tweetnacl', 'poly1305-donna']) {
      const obj = join(dir, name + '.o'); objs.push(obj);
      run('cc', [...flags, '-D_POSIX_C_SOURCE=200809L', '-c', join(gg, name + '.c'), '-o', obj]);
    }
    const bin = join(dir, 'test');
    run('c++', [...flags, '-std=c++17', '-I' + join(headers, 'include'), '-I' + join(headers, 'ggml/include'),
      '-I' + gg, fileURLToPath(new URL('./fixtures/prefix-kv-model.cpp', import.meta.url)), ...objs,
      '-Wl,--gc-sections', '-L' + libs, '-Wl,-rpath,' + libs, '-lllama', '-lggml', '-lggml-base', '-ldl', '-o', bin]);
    const output = run(bin, [model, join(libs, 'libggml-cpu.so'), dir]);
    assert.match(output, /PREFIX_TOKEN_BOUNDARIES_OK/);
    assert.match(output, /PREFIX_SNAPSHOT_EQUIVALENT steps=8 logits=\d+ snapshot_bytes=\d+ source_truncated_before_load=1/);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
