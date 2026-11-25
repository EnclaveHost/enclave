// The circuit runtime's folders (network/wg-circuit-runtime.mjs): what a sweep removes and what it leaves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WgCircuitRuntime } from '../network/wg-circuit-runtime.mjs';

const hex = (c) => c.repeat(32);
function world(platform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wgfolders-')), directory = path.join(root, 'network-circuits');
  fs.mkdirSync(directory);
  // a stand-in for enclave-circuit-firewall: records what it was asked, and refuses a manifest that says so
  const fw = path.join(root, 'fw.sh'), asked = path.join(root, 'asked');
  fs.writeFileSync(fw, `#!/bin/sh\necho "$1 $2" >> "${asked}"\ngrep -q refuse "$2" && exit 3\nexit 0\n`, { mode: 0o755 });
  const logs = [];
  const runtime = new WgCircuitRuntime({ directory, wgBinary: '/bin/true', nodeBinary: process.execPath, workerModule: path.join(root, 'w.mjs'),
    firewallBinary: fw, platform, authorize: () => true, forward: () => {}, log: (m) => logs.push(m) });
  const folder = (c, files = {}) => { const d = path.join(directory, 'enclave-circuit-' + hex(c)); fs.mkdirSync(d);
    for (const [n, v] of Object.entries(files)) fs.writeFileSync(path.join(d, n), v); return d; };
  return { root, directory, runtime, folder, logs, asked: () => (fs.existsSync(asked) ? fs.readFileSync(asked, 'utf8').trim().split('\n') : []) };
}

test('a sweep removes the folders no circuit holds, and only circuit folders', async () => {
  const w = world('plain');
  const a = w.folder('a', { 'worker.exe': 'x'.repeat(1000), 'worker.json': '{}' }), b = w.folder('b', { 'enclave-wg.exe': 'y' });
  const held = w.folder('c', { 'worker.json': '{}' }); w.runtime.folders.add(held);
  const other = path.join(w.directory, 'something-else'); fs.mkdirSync(other);
  const short = path.join(w.directory, 'enclave-circuit-abc'); fs.mkdirSync(short);
  fs.writeFileSync(path.join(w.directory, 'enclave-circuit-' + hex('d')), 'a file, not a folder');
  assert.equal(await w.runtime.sweep(), 2);
  assert.deepEqual([a, b].map((d) => fs.existsSync(d)), [false, false]);
  for (const d of [held, other, short, path.join(w.directory, 'enclave-circuit-' + hex('d'))]) assert.ok(fs.existsSync(d), d);
  assert.equal(await w.runtime.sweep(), 0);
});

test('a missing directory is nothing to sweep', async () => {
  const w = world('plain'); fs.rmSync(w.directory, { recursive: true });
  assert.equal(await w.runtime.sweep(), 0);
});

test('on Windows a folder goes only after its firewall rule did; a rule that will not go keeps its manifest', async () => {
  const w = world('windows');
  const clean = w.folder('a', { 'worker.exe': 'x', 'firewall.json': '{"rules":1}' });
  const noRule = w.folder('b', { 'enclave-wg.exe': 'x', 'firewall-removed-1.json': '{}' });
  const stuck = w.folder('c', { 'worker.exe': 'x', 'firewall.json': '{"refuse":true}' });
  assert.equal(await w.runtime.sweep(), 2);
  assert.deepEqual([clean, noRule, stuck].map((d) => fs.existsSync(d)), [false, false, true]);
  assert.ok(fs.existsSync(path.join(stuck, 'firewall.json')), 'the manifest of a rule that was not removed stays');
  assert.deepEqual(w.asked().sort(), ['remove ' + path.join(clean, 'firewall.json'), 'remove ' + path.join(stuck, 'firewall.json')].sort());
  assert.ok(w.logs.some((m) => m.includes('circuit cleanup') && m.includes(stuck)));
});

test('on Windows a folder whose program cannot be deleted (still running) is left whole and its rule is not touched', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root deletes anything');
  const w = world('windows');
  const busy = w.folder('a', { 'worker.exe': 'x', 'firewall.json': '{"rules":1}' });
  fs.chmodSync(busy, 0o555);   // unlink in it fails, as deleting a running image does on Windows
  try {
    assert.equal(await w.runtime.sweep(), 0);
    assert.ok(fs.existsSync(path.join(busy, 'worker.exe')) && fs.existsSync(path.join(busy, 'firewall.json')));
    assert.deepEqual(w.asked(), []);
  } finally { fs.chmodSync(busy, 0o755); }
});
