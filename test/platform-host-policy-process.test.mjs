// The platform host policy in REAL processes:
//   1. the PACKAGED relay: a flat directory built exactly from relay/deploy.sh's api-relay file list plus the network runtime
//      bundle it builds (the deployment closure), started with the policy off and on; token attach refused for a banned
//      host, admitted after the admin's unban, and the attached tunnel HOT-BANNED when the admin bans again; an outage
//      never admits a banned host and never detaches an admitted one;
//   2. the ACTUAL supervisor.js (test/helpers/management-supervisor.mjs): admitted -> serving; explicit ban -> app traffic
//      refused; an RPC outage after the ban keeps it refused; the admin's unban restores; a transient outage while admitted
//      is covered by the grace, and the grace is bounded.
// Chain and mirror are local (test/helpers/platform-policy-world.mjs); no real chain, key or Enclave service is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { keccak256, toBytes } from 'viem';
import { platformPolicyWorld } from './helpers/platform-policy-world.mjs';
import { startActualSupervisor } from './helpers/management-supervisor.mjs';
import { bootDaemon } from './helpers/daemon.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const idOf = (e) => keccak256(toBytes(e)).toLowerCase();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, every = 250) { const end = Date.now() + ms; let last; while (Date.now() < end) { last = await fn(); if (last) return last; await wait(every); } return last; }

// the flat directory relay/deploy.sh ships: its api-relay scp list + the bundle + vendor/ + fixtures/ (+ npm ci's node_modules)
function packagedRelay() {
  const deploy = fs.readFileSync(path.join(ROOT, 'relay/deploy.sh'), 'utf8');
  const line = deploy.split('\n').find((l) => l.startsWith('scp api-relay.js '));
  const files = line.replace(/^scp /, '').replace(/ nan:\/opt\/nan-relay\/$/, '').split(/\s+/).filter(Boolean);
  assert.ok(deploy.includes('scp network-runtime.bundle.mjs network-runtime.bundle.mjs.manifest.json nan:/opt/nan-relay/'), 'deploy ships the bundle');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-relay-'));
  for (const f of [...files, 'network-runtime.bundle.mjs', 'network-runtime.bundle.mjs.manifest.json']) fs.copyFileSync(path.join(ROOT, 'relay', f), path.join(dir, f));
  for (const d of ['vendor', 'fixtures']) fs.cpSync(path.join(ROOT, 'relay', d), path.join(dir, d), { recursive: true });
  fs.symlinkSync(fs.realpathSync(path.join(ROOT, 'relay/node_modules')), path.join(dir, 'node_modules'));
  return { dir, files };
}
async function startRelay(t, dir, env = {}) {
  const { child, port } = await bootDaemon({
    start: (port) => spawn(process.execPath, [path.join(dir, 'api-relay.js')], { cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, ENCLAVES: 'http://127.0.0.1:1', API_RELAY_PORT: String(port), API_RELAY_BIND: '127.0.0.1', RPC_FALLBACKS: '0',
             FEATURED_VIEWS_FILE: path.join(dir, `views-${port}.json`), ...env }, stdio: ['ignore', 'pipe', 'pipe'] }),
    claimed: (log, port) => log.includes(`[api-relay] :${port}`),
    ready: async (port) => (await fetch(`http://127.0.0.1:${port}/health`)).ok, timeoutMs: 30000,
  });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  t.after(() => child.kill('SIGKILL'));
  return { origin: `http://127.0.0.1:${port}`, port, log: () => out };
}
const dial = (url, headers) => new Promise((resolve) => {
  const ws = new WebSocket(url, { headers }); let closed = false; ws.on('close', () => { closed = true; });
  ws.on('open', () => resolve({ state: 'open', ws, closed: () => closed }));
  ws.on('unexpected-response', (_q, res) => { try { ws.terminate(); } catch {} resolve({ state: res.statusCode }); });
  ws.on('error', () => resolve({ state: 'error' }));
});

test('PACKAGED relay: starts from the deploy closure with the policy off and on; attach refused, admitted, hot-banned', { timeout: 180_000 }, async (t) => {
  const pkg = packagedRelay(); t.after(() => fs.rmSync(pkg.dir, { recursive: true, force: true }));
  // off: no policy configuration, no address book -> unchanged behavior, and the flat directory starts
  const off = await startRelay(t, pkg.dir);
  const s0 = await (await fetch(`${off.origin}/v1/platform-host-policy`)).json();
  assert.equal(s0.platformHostPolicy, 'off'); assert.match(s0.reason, /not the production chain\/book/);
  // on
  const box = 'box1', boxId = idOf(`https://api.enclave.host/t/${box}`), op = '0x' + '22'.repeat(20);
  const w = await platformPolicyWorld(t, { hosts: { [boxId]: { endpoint: `https://api.enclave.host/t/${box}`, operator: op, owner: '0x' + '33'.repeat(20), active: true } } });
  await w.publish({ deny: [{ kind: 'operator', value: op, reason: 'abuse' }] });
  const on = await startRelay(t, pkg.dir, w.env({ METAL_TUNNEL_TOKENS: `${box}:tok-${box}`, HOST_POLICY_RECHECK_SEC: '1' }));
  const s1 = await (await fetch(`${on.origin}/v1/platform-host-policy`)).json();
  assert.equal(s1.platformHostPolicy, 'on'); assert.equal(s1.activation, 'anchor');
  const decision = async () => (await (await fetch(`${on.origin}/v1/platform-host-policy?host=${boxId}`)).json()).decision;
  const d0 = await until(async () => { const d = await decision(); return d?.status === 'current' ? d : null; });
  assert.equal(d0.admit, false); assert.match(d0.reason, /banned by platform policy #1 \(operator\): abuse/);
  const url = `ws://127.0.0.1:${on.port}/v1/fleet-tunnel`, hdr = { 'x-metal-name': box, 'x-metal-token': `tok-${box}` };
  assert.equal((await dial(url, hdr)).state, 403, 'a banned host cannot attach (token path)');
  await w.publish({ deny: [] });                                 // the admin unbans (new anchored policy)
  assert.ok(await until(async () => (await decision())?.admit === true), 'the unban reaches the relay');
  const att = await dial(url, hdr);
  assert.equal(att.state, 'open', 'the unbanned host attaches');
  w.setDown(true);                                               // outage: an attached, admitted box is never detached for it
  await wait(2500); assert.equal(att.closed(), false, 'an RPC outage does not detach');
  const other = idOf('https://api.enclave.host/t/box2');      // not in the (30 s, admit-only) hot-path cache
  const od = (await (await fetch(`${on.origin}/v1/platform-host-policy?host=${other}`)).json()).decision;
  assert.deepEqual([od.admit, od.status], [false, 'unreadable'], 'nothing new is admitted while the policy is unreadable');
  w.setDown(false);
  await w.publish({ deny: [{ kind: 'registryId', value: boxId, reason: 'malware' }] });   // the admin bans again
  assert.ok(await until(() => att.closed(), 20000), 'HOT BAN: the attached tunnel is cut off');
  assert.match(on.log(), /DETACHED by the platform host policy: banned by platform policy #3 \(registryId\): malware/);
  assert.equal((await dial(url, hdr)).state, 403);
});

test('ACTUAL supervisor: explicit ban stops app service; outage keeps it stopped; the admin unban restores; grace is bounded', { timeout: 180_000 }, async (t) => {
  const publicUrl = 'https://host.policy.example', hostId = idOf(publicUrl), op = '0x' + '44'.repeat(20);
  const w = await platformPolicyWorld(t, { hosts: { [hostId]: { endpoint: publicUrl, operator: op, owner: '0x' + '55'.repeat(20), active: true } } });
  await w.publish({ deny: [] });
  const id = '0x' + 'ab'.repeat(32), owner = '0x' + '66'.repeat(20);
  const pins = { registry: '0x' + '06'.repeat(20), deployments: '0x' + '05'.repeat(20), appCatalog: '0x' + '08'.repeat(20), proofOfTime: '0x' + '09'.repeat(20),
                 enclavePay: '0x' + '00'.repeat(20), verificationFees: '0x' + '00'.repeat(20), sessionVaultFactory: '0x' + '07'.repeat(20), secretVaultV2: '0x' + '00'.repeat(20) };
  const sup = await startActualSupervisor(t, { chain: { factory: pins.sessionVaultFactory, vaults: {} }, deployment: { id, owner }, pins, publicUrl,
    env: w.env({ ENCLAVE_PLATFORM_HOST_POLICY_INTERVAL_SEC: '1', ENCLAVE_PLATFORM_HOST_POLICY_GRACE_SEC: '6' }) });
  const base = `http://127.0.0.1:${sup.port}`;
  const health = async () => (await (await fetch(`${base}/v1/health`)).json()).platformHostPolicy;
  const app = async () => { const r = await fetch(`${base}/x/${id}/`); const b = await r.text(); let j = null; try { j = JSON.parse(b); } catch {} return { status: r.status, error: j?.code || j?.error || null }; };
  assert.ok(await until(async () => (await health())?.serving === true), 'admitted at the agreed block: serving');
  const served = await app(); assert.notEqual(served.error, 'host_policy_refused', 'app traffic reaches the owner gate as before');
  await w.publish({ deny: [{ kind: 'operator', value: op, reason: 'abuse' }] });             // explicit ban
  assert.ok(await until(async () => (await health())?.banned === true), 'the ban is seen');
  assert.deepEqual(await app(), { status: 403, error: 'host_policy_refused' }, 'app service stops');
  w.setDown(true); await wait(3000);
  assert.deepEqual(await app(), { status: 403, error: 'host_policy_refused' }, 'an outage after a known ban never resurrects service');
  assert.equal((await health()).serving, false);
  w.setDown(false); await w.publish({ deny: [] });                                           // the admin unbans
  assert.ok(await until(async () => (await health())?.serving === true), 'unban restores');
  assert.notEqual((await app()).error, 'host_policy_refused');
  w.setDown(true); await wait(2500);
  assert.notEqual((await app()).error, 'host_policy_refused', 'transient outage after an admit: grace keeps serving');
  assert.ok(await until(async () => (await app()).error === 'host_policy_refused', 15000), 'the grace is bounded');
  w.setDown(false);
  assert.ok(await until(async () => (await health())?.serving === true), 'service resumes with the next authenticated admit');
  assert.match(sup.stdout(), /\[host-policy\] this host is NOT serving: banned by platform policy #2 \(operator\): abuse/);
});
