// Test-only rig for the REAL privacy agent daemon (node network/privacy-agent.mjs --config FILE) on a Linux host config with
// no Enclave authority: every *.enclave.host lookup and every connection to the four DigitalOcean fronts is REFUSED by a
// preload and logged (blocked.log), so a test proves which public infrastructure was (not) needed. SIGUSR2 prints the
// process's active resources (diagnostics for a stop that does not exit).
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generatePrivateKey } from 'viem/accounts';
import { keccak256, toBytes } from 'viem';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const ENDPOINT = 'https://host.policy.example', RUNNER = keccak256(toBytes(ENDPOINT)).toLowerCase();
export const DO_FRONTS = ['134.199.235.187', '134.209.248.172', '165.245.191.129', '146.190.246.39'];
export const HS = { zone: 'app.alice-net.org', exits: ['e1'.repeat(16)], ports: { 'directory-replica': 18188 } };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const freeTcp = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
export const count = (text, re) => (text.match(new RegExp(re.source, 'g')) || []).length;

const PRELOAD = `import net from 'node:net'; import dns from 'node:dns'; import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const DO = new Set(${JSON.stringify(DO_FRONTS)});
const enclave = (h) => /(^|\\.)enclave\\.host\\.?$/i.test(String(h || ''));
const refuse = (h) => { fs.appendFileSync(process.env.BLOCK_LOG, String(h) + '\\n'); return Object.assign(new Error('blocked ' + h), { code: 'ECONNREFUSED' }); };
const lookup = dns.lookup, plookup = dns.promises.lookup;
dns.lookup = function (h, ...a) { if (enclave(h)) return process.nextTick(a.at(-1), refuse(h)); return lookup.call(this, h, ...a); };
dns.promises.lookup = async function (h, ...a) { if (enclave(h)) throw refuse(h); return plookup.call(this, h, ...a); };
syncBuiltinESMExports();
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) { const o = Array.isArray(a[0]) ? a[0][0] : (a[0] && typeof a[0] === 'object' ? a[0] : null);
  if (o && (enclave(o.host) || DO.has(String(o.host)))) { const e = refuse(o.host); process.nextTick(() => this.destroy(e)); return this; } return connect.apply(this, a); };
process.on('SIGUSR2', () => console.error('ACTIVE RESOURCES ' + JSON.stringify(process.getActiveResourcesInfo())));`;

/** A Linux host's privacy agent config with the given app count and enclaveNetwork extras. */
export async function hostRig(t, { apps = 0, hostServices = HS, extra = {}, addressBook = '0x' + '00'.repeat(20) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-rig-')), f = (n) => path.join(dir, n);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(f('operator.key'), generatePrivateKey(), { mode: 0o600 });
  fs.writeFileSync(f('expected.json'), JSON.stringify({ appRef: 'catalog://0x' + '12'.repeat(32) + '/1', configCid: '' }));
  for (const n of ['runtime.json', 'min-tcb.json']) fs.writeFileSync(f(n), '{}');
  fs.writeFileSync(f('vcek.der'), 'not used before an app is probed'); fs.writeFileSync(f('preload.mjs'), PRELOAD); fs.writeFileSync(f('blocked.log'), '');
  fs.mkdirSync(f('state'));
  const app = { deploymentId: '0x' + 'ab'.repeat(32), names: ['app1.alice-net.org'], expectedFile: f('expected.json') };
  const cfg = { version: 2, directory: f('state'), operatorKeyFile: f('operator.key'), runner: RUNNER, endpoint: ENDPOINT,
    apps: apps ? [app] : [], dns: ['9.9.9.9'], upstream: `http://127.0.0.1:${await freeTcp()}`,
    chain: { rpc: ['https://127.0.0.2:1', 'https://127.0.0.3:1'], addressBook,
             authorityPins: { deployments: '0x' + '11'.repeat(20), registry: '0x' + '22'.repeat(20), connectivity: '0x' + '00'.repeat(20), sessionVaultFactory: '0x' + '00'.repeat(20) } },
    linux: { runtimeFile: f('runtime.json'), minTcbFile: f('min-tcb.json'), vcekFile: f('vcek.der') },
    enclaveNetwork: { directories: [`http://127.0.0.1:${await freeTcp()}/`], checkers: ['0x' + '45'.repeat(20)], apps: 'all', control: true,
      wgBinary: process.execPath, nodeBinary: process.execPath, workerModule: path.join(ROOT, 'network', 'windows-circuit-worker.mjs'),
      serviceWorkerModule: path.join(ROOT, 'network', 'host-service-ingress.mjs'), ...(hostServices ? { hostServices } : {}), ...extra } };
  const rig = { dir, f, cfg, app, file: f('privacy-config.json'), state: f('state') };
  rig.write = (c = cfg) => fs.writeFileSync(rig.file, JSON.stringify(c), { mode: 0o600 });
  rig.blocked = () => fs.readFileSync(f('blocked.log'), 'utf8').split('\n').filter(Boolean);
  rig.write();
  return rig;
}

/** Start the daemon; d.until(re, ms, n) waits for n log matches; d.stop() SIGTERMs (null when it did not exit in 20 s). */
export function daemon(t, rig, { env = {}, script = path.join(ROOT, 'network/privacy-agent.mjs') } = {}) {
  const child = spawn(process.execPath, ['--import', pathToFileURL(rig.f('preload.mjs')).href, script, '--config', rig.file],
    { env: { ...process.env, ENCLAVE_PLATFORM_HOST_POLICY: '', ENCLAVE_PLATFORM_HOST_POLICY_RPCS: '', ...env, BLOCK_LOG: rig.f('blocked.log') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const d = { child, out: '' };
  child.stdout.on('data', (b) => { d.out += b; }); child.stderr.on('data', (b) => { d.out += b; });
  d.exited = new Promise((ok) => child.once('exit', (code, signal) => ok({ code, signal })));
  d.until = async (re, ms = 20_000, n = 1) => { const end = Date.now() + ms; while (Date.now() < end && count(d.out, re) < n && child.exitCode === null) await sleep(100);
    assert.ok(count(d.out, re) >= n, `expected ${n}x ${re} in:\n${d.out.slice(-3000)}`); };
  d.stop = async () => { if (child.exitCode !== null || child.signalCode !== null) return d.exited; child.kill('SIGTERM');
    const r = await Promise.race([d.exited, sleep(20_000).then(() => null)]);
    if (!r) { child.kill('SIGUSR2'); await sleep(500); }
    return r; };
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await Promise.race([d.exited, sleep(5000)]); });
  return d;
}
