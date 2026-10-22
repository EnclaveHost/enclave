// B8 (hs-transport review): can a host REBUILD its service circuits while every DigitalOcean directory is down? With the
// EXISTING merge in network/directory-client.mjs (every origin read in parallel, signed records and checker verdicts merged,
// negative verdicts kept) the host's own directory-replica as one more origin is a fresh, distributed source. Its records
// and qualifications are the providers' and checkers' own signatures, never trusted for the replica's sake. Bounded: a
// qualification lasts at most 10 minutes, so an expired pass (or ban) is never used, and nothing stale is kept indefinitely.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { DirectoryClient } from '../network/directory-client.mjs';
import { eligibleProviders, signProviderRecord, signQualification, providerIdFor, CHECKS } from '../network/provider-directory.mjs';
import { HostServiceTransport } from '../network/host-service-transport.mjs';

const HOST = '0x' + 'a1'.repeat(32), checker = privateKeyToAccount(generatePrivateKey());
const wg = () => randomBytes(32).toString('base64');
const T0 = Date.now();
async function provider(address, roles) {
  const op = privateKeyToAccount(generatePrivateKey());
  const r = { version: 1, providerId: providerIdFor(op.address.toLowerCase(), address), operator: op.address.toLowerCase(), address, wgExitKey: wg(), wgGuardKey: wg(),
    ports: { exit: 51820, guard: 51821, control: 51822 }, roles, pricePerGiB6: 0, region: 'r' + address.split('.')[3], kind: 'enclave', hostId: null, issuedAt: T0, expiresAt: T0 + 3600e3 };
  return { op, r, env: await signProviderRecord(op, r) };
}
const verdict = (p, { at = T0, pass = true } = {}) => signQualification(checker, { version: 1, providerId: p.r.providerId, operator: p.r.operator, address: p.r.address, wgExitKey: p.r.wgExitKey,
  wgGuardKey: p.r.wgGuardKey, roles: p.r.roles, checks: Object.fromEntries(CHECKS.map((c) => [c, pass || !['blocksPrivateDestinations'].includes(c)])), issuedAt: at, expiresAt: at + 10 * 60000 });
// a directory origin serving exactly `entries` (the host's own replica, or the fleet's)
const servers = []; after(() => { for (const s of servers) s.close(); });
async function origin(entries) {
  const s = http.createServer((q, res) => { if (q.url !== '/v1/network/providers') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ providers: entries() })); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r)); servers.push(s); return `http://127.0.0.1:${s.address().port}/`;
}
async function deadOrigin() { const s = http.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const u = `http://127.0.0.1:${s.address().port}/`; await new Promise((r) => s.close(r)); return u; }
function fakeRuntime() {
  const started = [];
  return { started, async start(o) { const c = new EventEmitter(); Object.assign(c, { closed: false, providers: { guard: o.guard, exit: o.exit }, service: { names: o.service.granted, exitKey: 'K', control: '127.0.0.1:1' }, close: async () => { c.closed = true; } }); started.push(c); return c; } };
}
const CFG = (exit) => ({ zone: 'app.enclave.host', exits: [exit], ports: { 'directory-replica': 18188 } });

test('every DO directory down: a dropped service circuit is rebuilt from the host\'s own replica (signed records + fresh verdicts)', async () => {
  const X = await provider('134.199.235.187', ['ingress', 'egress']), G = await provider('134.209.248.172', ['guard']);
  const replicaEntries = [{ record: X.env, qualifications: [await verdict(X)] }, { record: G.env, qualifications: [await verdict(G)] }];
  const client = new DirectoryClient({ origins: [await deadOrigin(), await origin(() => replicaEntries)], timeoutMs: 1000 });
  let now = T0 + 60000;
  const providers = async () => eligibleProviders((await client.providers({ now })).providers, { checkers: [checker.address], now });
  const rt = fakeRuntime();
  const t = new HostServiceTransport({ runtime: rt, providers, grants: { revoke: async () => ({ revoked: true }) }, hostId: HOST, config: CFG(X.r.providerId), now: () => now });
  await t.reconcile(); assert.equal(rt.started.length, 1, 'up with the fleet directory dead');
  rt.started[0].emit('down', 'tunnel process exited');
  await t.reconcile(); assert.equal(rt.started.length, 2, 'rebuilt from the host\'s own replica');
  assert.equal(rt.started[1].providers.exit.providerId, X.r.providerId); assert.equal(rt.started[1].providers.guard.providerId, G.r.providerId);
  // the bound: past the verdicts' 10 minutes nothing is eligible, so nothing is rebuilt from a stale pass
  now = T0 + 11 * 60000; rt.started[1].emit('down', 'x'); await t.reconcile();
  assert.equal(rt.started.length, 2, 'an expired qualification is never used');
});

test('a newer signed NEGATIVE verdict on the replica beats an older pass on a reachable fleet mirror, and expires in turn', async () => {
  const X = await provider('134.199.235.187', ['ingress', 'egress']), G = await provider('134.209.248.172', ['guard']);
  let replica = [{ record: X.env, qualifications: [await verdict(X, { at: T0 + 1000, pass: false })] }, { record: G.env, qualifications: [await verdict(G)] }];
  const fleet = [{ record: X.env, qualifications: [await verdict(X, { at: T0 })] }, { record: G.env, qualifications: [await verdict(G)] }];
  const client = new DirectoryClient({ origins: [await origin(() => fleet), await origin(() => replica)], timeoutMs: 1000 });
  let now = T0 + 60000;
  const providers = async () => eligibleProviders((await client.providers({ now })).providers, { checkers: [checker.address], now });
  assert.deepEqual((await providers()).map((p) => p.providerId), [G.r.providerId], 'the exit failed a security check: not eligible');
  // the negative verdict is not kept forever: once it expires and a fresh pass arrives, the exit is eligible again
  now = T0 + 12 * 60000;
  replica = [{ record: X.env, qualifications: [await verdict(X, { at: now - 1000 })] }, { record: G.env, qualifications: [await verdict(G, { at: now - 1000 })] }];
  assert.deepEqual((await providers()).map((p) => p.providerId).sort(), [X.r.providerId, G.r.providerId].sort());
});
