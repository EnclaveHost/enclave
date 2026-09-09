import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
test('pad receiver observer reports a stalled operation, coherent progress, and prompt joined shutdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-rx-profile-'));
  const run = (p, args) => {
    const r = spawnSync(p, args, {encoding:'utf8', timeout:5000});
    assert.equal(r.status, 0, String(r.error ?? '') + r.stdout + r.stderr);
    return r.stdout;
  };
  try {
    const exe = join(dir, 'check');
    run('cc', ['-std=c11','-D_DEFAULT_SOURCE','-O2','-g','-Wall','-Wextra','-Werror','-pthread',join(root,'test/fixtures/anchor-rx-profile.c'),'-o',exe]);
    assert.match(run(exe, []), /^PASS progress=\d+ write=\d+ read=\d+ stalled_stage_age_us=\d+ joined_promptly=1\n$/);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
