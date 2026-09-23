import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The local (phone-only) engine's chat grammar end to end: the app's request builder (LocalChat.java, pure helpers) emits the exact
// line, the VM's parser (engine_local_proto.h) accepts exactly that and refuses everything else, and streamed UTF-8 pieces reassemble.
test('local engine chat grammar: the app request builder and the VM parser agree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-local-'));
  function run(program, args) {
    const r = spawnSync(program, args, {encoding:'utf8', timeout:60_000});
    assert.equal(r.status, 0, String(r.error ?? '') + r.stdout + r.stderr);
    return r.stdout;
  }
  try {
    const payload = join(root, 'shielded/anchor/avf/payload'), app = join(root, 'shielded/anchor/avf/host/app');
    const binary = join(dir, 'local-proto-test');
    run('cc', ['-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-fno-sanitize-recover=all', '-I'+payload, join(root, 'test/fixtures/anchor-local-proto.c'), '-o', binary]);
    assert.deepEqual(JSON.parse(run(binary, [])), {status:'PASS', executed_checks:84});
    run('javac', ['--release', '17', '-Xlint:all', '-Werror', '-d', dir, join(app, 'LocalChat.java'), join(root, 'test/fixtures/LocalChatTest.java')]);
    const j = JSON.parse(run('java', ['-cp', dir, 'host.enclave.anchor.avf.LocalChatTest']));
    assert.equal(j.status, 'PASS'); assert.equal(j.executed_checks, 13);
    const lines = s => s.split('\n').filter(Boolean);
    assert.deepEqual(lines(run(binary, ['--wire', j.request, j.request_utf8, j.request + ' ', 'RESET'])), ['GEN 256 700 10', 'GEN 64 0 ' + (j.request_utf8.split(' ')[3].length), 'REFUSED', 'REFUSED']);
    assert.deepEqual(lines(run(binary, ['--local', j.plan, j.plan + ' x=1', j.plan_tpu, j.plan_draft])), ['LOCAL 3360161216 6 4096 0 0 0 0', 'REFUSED', 'LOCAL 3360161216 6 4096 1842000000 64 0 0', 'LOCAL 3360161216 6 4096 1842000000 64 170194016 4']);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
