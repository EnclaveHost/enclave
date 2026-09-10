import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'test/fixtures/shielded-quiet-control.c');
const payload = join(root, 'shielded/anchor/avf/payload');

// The quiet-pads control transaction over a real socketpair: the fixture includes the PRODUCTION
// anchor_ctl_txn.h, so every assertion runs the actual helper, and a transaction that stops
// bounding its deadline, splits a line, or accepts a late acknowledgement fails here rather than
// on the phone. No engine, no pVM, no pad, no ledger, no device.
test('quiet control transaction helper passes its whole fixture against the production header', () => {
  assert.ok(existsSync(fixture), `missing ${fixture}`);
  assert.ok(existsSync(join(payload, 'anchor_ctl_txn.h')), `missing ${payload}/anchor_ctl_txn.h`);

  // The packaged fixture differs from the authors' copy in its include line and nothing else:
  // it must resolve the header through -I, never through a path into a working folder.
  const src = readFileSync(fixture, 'utf8');
  assert.match(src, /^#include "anchor_ctl_txn\.h"$/m, 'fixture must include the production header');
  assert.doesNotMatch(src, /#include\s+"\.\..*anchor_ctl_txn\.h"/, 'fixture must not include a header by relative path');

  const dir = mkdtempSync(join(tmpdir(), 'shielded-quiet-control-'));
  try {
    const exe = join(dir, 'check');
    const cc = spawnSync('cc', ['-std=gnu11', '-O2', '-g', '-Wall', '-Wextra', '-pthread',
                                '-I', payload, fixture, '-o', exe],
                         {encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL'});
    assert.equal(cc.status, 0, `compile failed: ${cc.error ?? ''}\n${cc.stdout}${cc.stderr}`);

    const r = spawnSync(exe, [], {encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 4 << 20});
    const out = `${r.stdout}${r.stderr}`;
    assert.equal(r.status, 0, `fixture failed: ${r.error ?? ''}\n${out}`);
    assert.match(r.stdout, /^quiet-ctl-txn: all checks passed$/m, out);
    assert.doesNotMatch(out, /^FAIL /m, out);

    // A fixture that quietly stops asserting still prints its marker, so hold a floor on the
    // number of checks. Root observed 38 on 2026-09-09; the floor allows the header to gain or
    // lose a case without churn but not to fall silent.
    const checks = r.stdout.split('\n').filter(l => l.startsWith('ok   ')).length;
    assert.ok(checks >= 30, `only ${checks} checks ran\n${out}`);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
