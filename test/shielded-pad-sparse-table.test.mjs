import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('sparse descriptors reject hostile metadata atomically and retain canonical mask domains', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-pad-sparse-table-'));
  try {
    const binary = join(dir, 'table');
    execFileSync('cc', ['-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      fileURLToPath(new URL('./fixtures/shielded-pad-sparse-table.c', import.meta.url)), '-o', binary], {timeout: 10_000});
    const output = execFileSync(binary, {encoding: 'utf8', timeout: 10_000, env: {...process.env,
      ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1'}});
    assert.match(output, /pad-sparse-table: PASS/);
    // Independent wire oracle: exact little-endian fields and canonical names.
    const expected = Buffer.alloc(288);
    const ranges = [[7, 2], [0, 0], [9, 3]];
    ranges.forEach(([start, count], i) => {
      const at = i * 96;
      expected.writeUInt32LE(i, at); expected.writeUInt32LE(16 + i, at + 4);
      expected.writeBigUInt64LE(BigInt(3 + i), at + 8);
      expected.write(`group.${i}`, at + 16);
      expected.writeBigUInt64LE(BigInt(start), at + 80);
      expected.writeBigUInt64LE(BigInt(count), at + 88);
    });
    assert.equal(output.match(/table ([0-9a-f]+)/)[1], expected.toString('hex'));
  } finally {rmSync(dir, {recursive: true, force: true});}
});
