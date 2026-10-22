// Final review N3, on the REAL daemon (node network/privacy-agent.mjs --config FILE): with control circuits on and a
// hostServices block, and EVERY directory unreachable, the agent must still start (its apps, admission and status) and
// keep retrying both circuit kinds - it must not exit because the first reconcile could not read a directory. Same
// harness shape as privacy-agent-lifecycle.test.mjs: no Enclave authority, every *.enclave.host lookup refused and logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generatePrivateKey } from 'viem/accounts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hs-start-')), f = (n) => path.join(dir, n);
const freeTcp = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRELOAD = `import net from 'node:net'; import dns from 'node:dns'; import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const enclave = (h) => /(^|\\.)enclave\\.host\\.?$/i.test(String(h || ''));
const refuse = (h) => { fs.appendFileSync(process.env.BLOCK_LOG, String(h) + '\\n'); return Object.assign(new Error('blocked ' + h), { code: 'ENOTFOUND' }); };
const lookup = dns.lookup, plookup = dns.promises.lookup;
dns.lookup = function (h, ...a) { if (enclave(h)) return process.nextTick(a.at(-1), refuse(h)); return lookup.call(this, h, ...a); };
dns.promises.lookup = async function (h, ...a) { if (enclave(h)) throw refuse(h); return plookup.call(this, h, ...a); };
syncBuiltinESMExports();
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) { const o = Array.isArray(a[0]) ? a[0][0] : (a[0] && typeof a[0] === 'object' ? a[0] : null);
  if (o && enclave(o.host)) { const e = refuse(o.host); process.nextTick(() => this.destroy(e)); return this; } return connect.apply(this, a); };`;

test('every directory unreachable: the daemon with control circuits AND host services starts its apps and keeps retrying', { timeout: 90_000 }, async () => {
  fs.writeFileSync(f('operator.key'), generatePrivateKey(), { mode: 0o600 });
  fs.writeFileSync(f('expected.json'), JSON.stringify({ appRef: 'catalog://0x' + '12'.repeat(32) + '/1', configCid: '' }));
  for (const n of ['runtime.json', 'min-tcb.json']) fs.writeFileSync(f(n), '{}');
  fs.writeFileSync(f('vcek.der'), 'not used before an app is probed'); fs.writeFileSync(f('preload.mjs'), PRELOAD); fs.writeFileSync(f('blocked.log'), '');
  const state = f('state'); fs.mkdirSync(state);
  const deadDirs = [`http://127.0.0.1:${await freeTcp()}/`, `http://127.0.0.1:${await freeTcp()}/`];
  const cfg = { version: 2, directory: state, operatorKeyFile: f('operator.key'), runner: '0x' + '42'.repeat(32),
    apps: [{ deploymentId: '0x' + 'ab'.repeat(32), names: ['app1.alice-net.org'], expectedFile: f('expected.json') }],
    dns: ['9.9.9.9'], upstream: `http://127.0.0.1:${await freeTcp()}`,
    chain: { rpc: ['https://127.0.0.2:1', 'https://127.0.0.3:1'], addressBook: '0x' + '00'.repeat(20),
             authorityPins: { deployments: '0x' + '11'.repeat(20), registry: '0x' + '22'.repeat(20), connectivity: '0x' + '00'.repeat(20), sessionVaultFactory: '0x' + '00'.repeat(20) } },
    linux: { runtimeFile: f('runtime.json'), minTcbFile: f('min-tcb.json'), vcekFile: f('vcek.der') },
    enclaveNetwork: { directories: deadDirs, checkers: ['0x' + '45'.repeat(20)], apps: 'all', control: true,
      wgBinary: process.execPath, nodeBinary: process.execPath, workerModule: path.join(ROOT, 'network', 'windows-circuit-worker.mjs'),
      serviceWorkerModule: path.join(ROOT, 'network', 'host-service-ingress.mjs'),
      hostServices: { zone: 'app.alice-net.org', exits: ['e1'.repeat(16)], ports: { 'directory-replica': 18188 } } } };
  fs.writeFileSync(f('privacy-config.json'), JSON.stringify(cfg), { mode: 0o600 });
  const child = spawn(process.execPath, ['--import', pathToFileURL(f('preload.mjs')).href, path.join(ROOT, 'network/privacy-agent.mjs'), '--config', f('privacy-config.json')],
    { env: { ...process.env, BLOCK_LOG: f('blocked.log') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((ok) => child.once('exit', (code, signal) => ok({ code, signal })));
  try {
    const t0 = Date.now();
    while (!fs.existsSync(path.join(state, 'status.json')) && child.exitCode === null && Date.now() - t0 < 45_000) await sleep(200);
    assert.equal(child.exitCode, null, `the daemon exited instead of starting:\n${out.slice(-2500)}`);
    assert.ok(fs.existsSync(path.join(state, 'status.json')), 'the agent started (its status is written)');
    await sleep(1500);
    assert.match(out, /control circuits: .*directories unavailable/, 'the control round failed and was logged, not thrown');
    assert.match(out, /host service circuits: .*directories unavailable/, 'the host-service round failed and was logged, not thrown');
    assert.equal(child.exitCode, null, 'still running (the timers retry)');
    child.kill('SIGTERM');
    const exit = await Promise.race([exited, sleep(20_000).then(() => null)]);
    assert.ok(exit && exit.code === 0, `clean exit after SIGTERM: ${JSON.stringify(exit)}\n${out.slice(-1500)}`);
    assert.equal(fs.readFileSync(f('blocked.log'), 'utf8'), '', 'no enclave.host name was looked up or connected to');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await Promise.race([exited, sleep(5000)]); fs.rmSync(dir, { recursive: true, force: true }); }
});
