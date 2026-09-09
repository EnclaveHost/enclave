import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('pad receiver preserves ACK digests and rejects failed delivery with streaming opt-in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pad-ack-receiver-'));
  const run = (program, args, timeout = 30_000) => {
    const r = spawnSync(program, args, {encoding: 'utf8', timeout});
    assert.equal(r.status, 0, String(r.error ?? '') + r.stdout + r.stderr);
    return r.stdout;
  };
  try {
    const source = join(dir, 'receiver.c'), binary = join(dir, 'receiver');
    run('python3', [join(root, 'test/fixtures/pad-ack-receiver-generate.py'),
      join(root, 'shielded/anchor/avf/payload/anchor_payload.c'), source]);
    run('cc', ['-O2', '-pthread', '-I', join(root, 'wasm/ggml-shielded'), source, '-o', binary]);
    const output = run('python3', [join(root, 'test/fixtures/pad-ack-receiver-check.py'), binary], 45_000);
    assert.match(output, /RESULT PASS/);
    assert.equal(output.split('\n').filter(line => line.startsWith('PASS ')).length, 35);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
