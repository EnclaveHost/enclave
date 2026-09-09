import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'), gg = join(root, 'wasm/ggml-shielded'), payload = join(root, 'shielded/anchor/avf/payload');
test('MASKBENCH comparator mints, verifies, times and removes its public shipment; bad stores fail without timing lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-maskbench-'));
  function run(program, args, env) {
    const r = spawnSync(program, args, {encoding:'utf8', timeout:120_000, env: {...process.env, ...env}});
    assert.equal(r.status, 0, String(r.error ?? '') + r.stdout + r.stderr);
    return r.stdout;
  }
  try {
    const binary = join(dir, 'maskbench-test');
    // my units under -Werror; the repository's pads/crypto units as they are (their own tests own their warnings)
    const flags = ['-std=gnu11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-sanitize-recover=all', '-I'+gg, '-I'+payload];
    const objs = [];
    for (const [src, strict] of [[join(root, 'test/fixtures/anchor-maskbench.c'), true], [join(payload, 'anchor_maskbench.c'), true], [join(gg, 'shielded-pads.c'), false], [join(gg, 'shielded-field.c'), false], [join(payload, 'third_party/tweetnacl.c'), false], [join(gg, 'poly1305-donna.c'), false]]) {
      const obj = join(dir, src.split('/').pop() + '.o'); objs.push(obj);
      run('cc', [...flags, ...(strict ? ['-Wall', '-Wextra', '-Werror'] : ['-w']), '-c', src, '-o', obj]);
    }
    run('cc', [...flags, ...objs, '-lpthread', '-lm', '-o', binary]);
    assert.deepEqual(JSON.parse(run(binary, [], {TMPDIR: dir}).trim().split('\n').pop()), {status:'PASS', executed_checks:12});
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
