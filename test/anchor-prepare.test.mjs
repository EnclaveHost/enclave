import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The preparation run's control grammar end to end: the app's preamble builder (ArtifactProfile.java, pure) emits the exact lines,
// the VM's parser (anchor_prepare.c) accepts exactly those and refuses everything else, and the receive-time decision rule is pinned.
test('preparation control: ARTIFACT_PROFILE 0|1 and PREPARE [1..600] agree between the app and the VM parser', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-prepare-'));
  function run(program, args) {
    const r = spawnSync(program, args, {encoding:'utf8', timeout:60_000});
    assert.equal(r.status, 0, String(r.error ?? '') + r.stdout + r.stderr);
    return r.stdout;
  }
  try {
    const payload = join(root, 'shielded/anchor/avf/payload'), app = join(root, 'shielded/anchor/avf/host/app');
    const binary = join(dir, 'prepare-test');
    run('cc', ['-std=c11', '-O1', '-g', '-D_DEFAULT_SOURCE', '-D_POSIX_C_SOURCE=200809L', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
      '-I'+payload, join(root, 'test/fixtures/anchor-prepare.c'), join(payload, 'anchor_prepare.c'), '-o', binary]);
    assert.deepEqual(JSON.parse(run(binary, [])), {status:'PASS', executed_checks:47});
    run('javac', ['--release', '17', '-Xlint:all', '-Werror', '-d', dir, join(app, 'ArtifactProfile.java'), join(root, 'test/fixtures/ArtifactProfileTest.java')]);
    const j = JSON.parse(run('java', ['-cp', dir, 'host.enclave.anchor.avf.ArtifactProfileTest']));
    assert.equal(j.status, 'PASS'); assert.equal(j.executed_checks, 18);
    assert.equal(j.preamble_profile, 'ARTIFACT_PROFILE 1\nPREPARE 300\n'); assert.equal(j.preamble_plain, 'PREPARE 300\n');
    // cross-feed: every line the app emits is parsed by the VM's grammar as intended, and a profile request is never mistaken for PREPARE
    const lines = s => s.split('\n').filter(Boolean);
    assert.deepEqual(lines(run(binary, ['--wire', ...lines(j.preamble_profile)])), ['ARTIFACT_PROFILE on', 'PREPARE 300']);
    assert.deepEqual(lines(run(binary, ['--wire', ...lines(j.preamble_plain)])), ['PREPARE 300']);
    assert.deepEqual(lines(run(binary, ['--wire', 'ARTIFACT_PROFILE 0', 'ARTIFACT_PROFILE 2', 'ARTIFACT_PROFILE 1 ', 'ANCHOR_ARTIFACT_PROFILE=1', 'PREPARE 601'])), ['ARTIFACT_PROFILE off', 'REFUSED', 'REFUSED', 'REFUSED', 'REFUSED']);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
