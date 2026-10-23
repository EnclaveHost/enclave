import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { takeRuntimeLock } from '../network/runtime-lock.mjs';

const helper = fileURLToPath(new URL('./lock-child.mjs', import.meta.url));
function area(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enclave-kernel-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'runtime.lock');
}
function contender(file, t) {
  const child = fork(helper, [file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const done = new Promise(resolve => child.once('exit', resolve));
  const result = new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  return { child, result, done };
}

test('real flock child exits, but the parent retains exclusive ownership of an empty file', async t => {
  const file = area(t), release = await takeRuntimeLock(file); t.after(release);
  const ino = fs.statSync(file).ino;
  assert.equal(fs.statSync(file).size, 0);
  await assert.rejects(takeRuntimeLock(file), /stateDir is in use/);
  const other = contender(file, t);
  assert.deepEqual(await other.result, { acquired: false, error: 'stateDir is in use by a running runtime' });
  release(); release();
  assert.equal(fs.statSync(file).ino, ino, 'release must not unlink the shared lock inode');
  const next = contender(file, t); assert.equal((await next.result).acquired, true);
  next.child.send('release'); await next.done;
});

test('four real contenders have exactly one owner; owner SIGKILL releases the kernel lock', async t => {
  const file = area(t), children = Array.from({ length: 4 }, () => contender(file, t));
  const results = await Promise.all(children.map(c => c.result));
  assert.equal(results.filter(r => r.acquired).length, 1);
  const owner = children[results.findIndex(r => r.acquired)];
  owner.child.kill('SIGKILL'); await owner.done;
  const next = contender(file, t); assert.equal((await next.result).acquired, true);
  next.child.send('release'); await next.done;
});

test('malformed legacy metadata and symlink are refused without changing either target', async t => {
  const file = area(t);
  fs.writeFileSync(file, '{');
  await assert.rejects(takeRuntimeLock(file), /legacy runtime lock/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
  const link = file + '.link'; fs.symlinkSync(file, link);
  await assert.rejects(takeRuntimeLock(link), /ELOOP/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
});

test('missing lock utility releases its parent descriptor; a subsequent real acquisition succeeds', async t => {
  const file = area(t);
  await assert.rejects(takeRuntimeLock(file, { flockPath: '/nonexistent/enclave-flock' }), /ENOENT/);
  const release = await takeRuntimeLock(file); release();
});

test('pre-aborted acquisition creates no file, and different state directories do not conflict', async t => {
  const file = area(t);
  await assert.rejects(takeRuntimeLock(file, { signal: AbortSignal.abort(new Error('cancelled')) }), /cancelled/);
  assert.equal(fs.existsSync(file), false);
  const release = await takeRuntimeLock(file), otherRelease = await takeRuntimeLock(file + '.other');
  release(); otherRelease();
});

test('a stuck utility is killed on deadline and on cancellation before a retry', async t => {
  const file = area(t), utility = file + '.utility';
  // Explicit process-lifecycle seam: this executable delays, it does not emulate
  // flock. Exclusion itself is tested above using the real installed utility.
  fs.writeFileSync(utility, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
  await assert.rejects(takeRuntimeLock(file, { flockPath: utility, timeoutMs: 100 }), /deadline exceeded/);
  const controller = new AbortController();
  const pending = takeRuntimeLock(file, { flockPath: utility, signal: controller.signal });
  const timer = setTimeout(() => controller.abort(new Error('cancel during acquisition')), 100);
  try { await assert.rejects(pending, /cancel during acquisition/); } finally { clearTimeout(timer); }
  const release = await takeRuntimeLock(file); release();
});
