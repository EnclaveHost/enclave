import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
test('the dealer loop forwards explicit MTP mode and rejects invalid modes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dealer-mtp-option-'));
  try {
    const fake = join(dir, 'dealer'), seen = join(dir, 'seen');
    writeFileSync(fake, '#!/usr/bin/env python3\nimport sys,json\nopen(' + JSON.stringify(seen) + ',"w").write(json.dumps(sys.argv[2::]))\n', {mode: 0o700});
    const args = [join(root, 'shielded/dealer/dealer-loop.py'), '--once', '--out', dir,
      '--model', 'fixture.gguf', '--calib', 'fixture.calib', '--seed', '11'.repeat(32),
      '--seed-id', '22'.repeat(16), '--pk', '09' + '00'.repeat(31), '--mark', '0', '--ahead', '1', '--chunk', '1'];
    const run = more => execFileSync('python3', [...args, ...more], {encoding: 'utf8', timeout: 10000, env: {...process.env, DEALER: fake}});
    run([]); assert(!JSON.parse(readFileSync(seen)).includes('--mtp'));
    run(['--mtp', '1']); const passed = JSON.parse(readFileSync(seen));
    assert.equal(passed[passed.indexOf('--mtp') + 1], '1');
    assert.throws(() => run(['--mtp', '2']));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

// Real context reservation regression. Explicitly supply an MTP model and CPU
// dealer backend; this test never loads CUDA or contacts an operator's worker.
test('an MTP dealer includes head groups without changing target group geometry', t => {
  const {GGML_SRC: src, GGML_LIB: lib, DEALER_TEST_SO: so,
    DEALER_TEST_MODEL: model, DEALER_TEST_CALIB: calib} = process.env;
  if (![src, lib, so, model, calib].every(x => x && existsSync(x)))
    return t.skip('needs GGML_SRC, GGML_LIB, DEALER_TEST_SO, DEALER_TEST_MODEL and DEALER_TEST_CALIB');
  const dir = mkdtempSync(join(tmpdir(), 'dealer-mtp-model-'));
  const env = {...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SHIELDED_'))),
    SHIELDED_SO: so, SHIELDED_CALIB: calib, GGML_CPU_SO: join(lib, 'libggml-cpu.so'),
    LD_LIBRARY_PATH: lib, SHIELDED_MINT_THREADS: '2'};
  try {
    const bin = join(dir, 'dealer');
    execFileSync('c++', ['-O2', '-std=c++17', '-I' + join(src, 'include'), '-I' + join(src, 'ggml/include'),
      join(root, 'wasm/ggml-shielded/shielded-dealer.cpp'), '-L' + lib, '-lllama', '-lggml', '-lggml-base', so,
      '-ldl', '-lpthread', '-lm', '-Wl,-rpath,' + lib, '-Wl,-rpath,' + dirname(so), '-o', bin], {timeout: 30000});
    const tables = [];
    for (const mtp of [0, 1]) {
      const path = join(dir, mtp + '.pads'), jobs = join(dir, mtp + '.jobs');
      writeFileSync(jobs, `${randomBytes(32).toString('hex')} ${randomBytes(16).toString('hex')} ${'09' + '00'.repeat(31)} ${path} 0:1\n`, {mode: 0o600});
      execFileSync(bin, [model, '--jobs', jobs, '--mtp', String(mtp)], {env, timeout: 60000, stdio: 'pipe'});
      const data = readFileSync(path), count = data.readUInt32LE(12), table = new Map();
      assert.equal(data.subarray(0, 8).toString(), 'ENCLPAD1');
      assert(count > 0 && count < 1024);
      for (let i = 0; i < count; i++) {
        const at = 256 + i * 80, name = data.subarray(at + 16, at + 80).toString().split('\0')[0];
        assert(!table.has(name));
        table.set(name, [data.readUInt32LE(at + 4), data.readBigUInt64LE(at + 8)]);
      }
      tables.push(table);
    }
    assert(tables[1].size > tables[0].size, 'MTP context must discover additional calibrated groups');
    for (const [name, shape] of tables[0]) assert.deepEqual(tables[1].get(name), shape, name);
    const added = [...tables[1].keys()].filter(n => !tables[0].has(n));
    assert(added.some(n => n.endsWith('nextn.eh_proj.weight')), 'head input projection must be present');
    assert(added.some(n => n.endsWith('ffn_gate.weight')), 'head transformer projections must be present');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
