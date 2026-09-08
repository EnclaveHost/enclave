import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('standalone sparse v3 files authenticate exact cells and preserve publication/nonce boundaries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shielded-v3-'));
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const flags = ['-std=c11', '-O1', '-Wall', '-Wextra', '-ffunction-sections', '-fdata-sections'];
  if (process.env.SHIELDED_TEST_SANITIZE === '1') flags.push('-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer');
  try {
    const binary = join(dir, 'fixture');
    execFileSync('cc', [...flags, join(repo, 'test/fixtures/shielded-pads-v3.c'),
      join(repo, 'wasm/ggml-shielded/shielded-field.c'),
      join(repo, 'wasm/ggml-shielded/tweetnacl.c'), join(repo, 'wasm/ggml-shielded/poly1305-donna.c'),
      '-Wl,--gc-sections', '-lpthread', '-lm', '-o', binary], { timeout: 60_000 });
    execFileSync(binary, [dir], { timeout: 60_000 });
    // Independent byte-level encoding, rather than only C writer/reader
    // agreement: bind each clear header field and the full sparse descriptor.
    const file = readFileSync(join(dir, 'retained.pads3'));
    assert.equal(file.length, 4245);
    assert.equal(file.subarray(0, 8).toString(), 'ENCLPAD3');
    assert.equal(file.readUInt32LE(8), 3);
    assert.equal(file.readUInt32LE(12), 3);
    assert.equal(file.readBigUInt64LE(64), 4245n);
    assert.equal(file.readBigUInt64LE(72), 4096n);
    assert.equal(file.readBigUInt64LE(80), 149n);
    assert.deepEqual(file.subarray(88, 96), Buffer.alloc(8));
    const seed = Buffer.alloc(16); seed[0] = 4;
    assert.deepEqual(file.subarray(48, 64), seed);
    const groups = [
      { name: 'a', K: 32, N: 5, start: 7, count: 3, members: [['a', 3], ['b', 2]] },
      { name: 'c', K: 64, N: 4, start: 8, count: 2, members: [['c', 4]] },
      { name: 'd', K: 32, N: 2, start: 0, count: 0, members: [['d', 2]] },
    ];
    const name = (value) => { const b = Buffer.alloc(64); b.write(value); return b; };
    const le64 = (value) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b; };
    const transcript = [Buffer.from('enclave-pads-manifest-v3\n')];
    for (const first of [1, 2, 3]) { const b = Buffer.alloc(32); b[0] = first; transcript.push(b); }
    transcript.push(le64(3), le64(4));
    const table = Buffer.alloc(3 * 96);
    for (const [i, g] of groups.entries()) {
      const at = i * 96;
      table.writeUInt32LE(i, at); table.writeUInt32LE(g.K, at + 4);
      table.writeBigUInt64LE(BigInt(g.N), at + 8); name(g.name).copy(table, at + 16);
      table.writeBigUInt64LE(BigInt(g.start), at + 80); table.writeBigUInt64LE(BigInt(g.count), at + 88);
      transcript.push(le64(i), le64(g.K), le64(g.N), le64(g.members.length), name(g.name));
      for (const [member, N] of g.members) transcript.push(name(member), le64(N));
    }
    assert.deepEqual(file.subarray(16, 48), createHash('sha256').update(Buffer.concat(transcript)).digest());
    assert.deepEqual(file.subarray(256, 256 + table.length), table);
    assert.deepEqual(file.subarray(256 + table.length, 4096), Buffer.alloc(4096 - 256 - table.length));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
