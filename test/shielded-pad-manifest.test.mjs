import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('canonical manifest binds full members and maps refused/reordered subsets without domain changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-pad-manifest-'));
  try {
    const binary = join(dir, 'manifest');
    execFileSync('cc', ['-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
      '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
      fileURLToPath(new URL('./fixtures/shielded-pad-manifest.c', import.meta.url)), '-o', binary], {timeout: 10_000});
    const output = execFileSync(binary, {encoding: 'utf8', timeout: 10_000, env: {...process.env,
      ASAN_OPTIONS: 'detect_leaks=1:abort_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1'}});
    assert.match(output, /pad-manifest: PASS/);
    // Independent encoder and crypto implementation verify the byte transcript.
    const h = createHash('sha256');
    const u64 = n => {const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); h.update(b);};
    const name = n => {const b = Buffer.alloc(64); b.write(n); h.update(b);};
    h.update('enclave-pads-manifest-v3\n');
    for (const value of [1, 2, 3]) h.update(Buffer.alloc(32, value));
    u64(3); u64(5);
    const groups = [
      {K: 2, members: [['a.weight', 3], ['a.aux', 5]]},
      {K: 3, members: [['b.weight', 7]]},
      {K: 4, members: [['c.weight', 11], ['c.aux', 13]]},
    ];
    groups.forEach((g, i) => {
      u64(i); u64(g.K); u64(g.members.reduce((n, [, N]) => n + N, 0)); u64(g.members.length);
      name(g.members[0][0]);
      for (const [n, N] of g.members) {name(n); u64(N);}
    });
    assert.equal(output.match(/digest ([0-9a-f]{64})/)[1], h.digest('hex'));
  } finally {rmSync(dir, {recursive: true, force: true});}
});
