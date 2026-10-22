// Negative controls for the host-software closure: an incomplete tree, or metal0's CURRENT host checkout
// (/home/steven/Projects/enclave 04a27e8d, read-only), must never yield an admission verdict; the complete tree against
// unreachable (closed loopback) RPCs must report UNKNOWN, never ADMISSIBLE. No network beyond 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const SC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const closedPort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const pre = (hs, rpcs) => spawnSync(process.execPath, [path.join(SC, 'activation/gate-preflight.mjs'), '--host-software', hs, '--endpoint', 'https://api.enclave.host/t/metal0',
  '--policy', JSON.stringify({ book: '0x' + 'b0'.repeat(20), hostOwnership: '0x' + 'c0'.repeat(20), mirrors: ['https://127.0.0.1:1/policy'] }), '--rpcs', rpcs.join(','), '--timeout-ms', '4000'],
  { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 60000 });
const verdictOf = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').pop()).verdict; } catch { return null; } };

test('closure negative controls', { timeout: 300_000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-neg-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const rpcs = [`http://127.0.0.1:${await closedPort()}`, `http://127.0.0.1:${await closedPort()}`, `http://127.0.0.1:${await closedPort()}`];
  const copy = (name) => { const d = path.join(tmp, name, 'tree'); fs.cpSync(path.join(SC, 'host-software/tree'), d, { recursive: true }); return d; };
  // positive control: the complete closure loads everything and, with no reachable RPC, answers UNKNOWN (exit 3)
  const full = pre(copy('full'), rpcs);
  assert.equal(verdictOf(full), 'UNKNOWN', full.stdout + full.stderr.slice(-300)); assert.equal(full.status, 3);
  for (const [name, rel] of [['no-runtime', 'network/host-policy-runtime.mjs'], ['no-viem-package-json', 'node_modules/viem/package.json'], ['no-gate', 'network/host-service-gate.mjs']]) {
    const d = copy(name); fs.rmSync(path.join(d, rel));
    const r = pre(d, rpcs);
    assert.notEqual(r.status, 0, name); assert.notEqual(verdictOf(r), 'ADMISSIBLE', name); assert.notEqual(verdictOf(r), 'UNKNOWN', `${name}: a missing file is a hard failure, not a transient`);
  }
  // metal0's current host checkout: the role and the gate are absent there
  const live = '/home/steven/Projects/enclave';
  if (fs.existsSync(live)) { const r = pre(live, rpcs); assert.notEqual(r.status, 0); assert.match(r.stderr, /Cannot find module|ERR_MODULE_NOT_FOUND/); }
});
