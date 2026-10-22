// B8 (> 10 min with ALL of this host's circuits down): the cycle is "fresh checker verdicts reach this host's replica only
// through its own service circuits". The existing directory-replica breaks it by CONFIGURATION: its `peers` are pulled
// every 10 s by the replica process itself over the host's own uplink (network/directory-server.mjs runDirectory sync),
// never through this host's circuits. So a host whose replica peers with ANOTHER host's replica (where checkers and
// providers also publish) keeps fresh, signed, checker-bounded verdicts while every one of its own circuits is down.
// Freshness is unchanged: a qualification still expires in 10 minutes and a newer negative verdict still wins.
// Real replicas (runDirectory, PublicDirectory, HTTP), signed records and verdicts; a stub chain reader (no chain needed for
// enclave-kind providers).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { runDirectory } from '../network/directory-server.mjs';
import { DirectoryClient } from '../network/directory-client.mjs';
import { eligibleProviders, signProviderRecord, signQualification, providerIdFor, CHECKS } from '../network/provider-directory.mjs';
import { HostServiceTransport } from '../network/host-service-transport.mjs';

const HOST = '0x' + 'a1'.repeat(32), checker = privateKeyToAccount(generatePrivateKey());
const wg = () => randomBytes(32).toString('base64');
const stubReader = { refresh: async () => [], registryEntries: async () => [], bookAddress: async () => null, authorityPins: null };
const dirs = [], running = [];
after(() => { for (const r of running) r.close(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const freePort = async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
async function replica(peers = []) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-')); dirs.push(stateDir);
  const port = await freePort();
  const r = await runDirectory({ stateDir, port, bind: '127.0.0.1', checkers: [checker.address.toLowerCase()], peers, rpc: [], addressBook: '0x' + '44'.repeat(20) }, { reader: stubReader });
  running.push(r); return `http://127.0.0.1:${port}/`;
}
async function provider(address, roles) {
  const op = privateKeyToAccount(generatePrivateKey()), now = Date.now();
  const r = { version: 1, providerId: providerIdFor(op.address.toLowerCase(), address), operator: op.address.toLowerCase(), address, wgExitKey: wg(), wgGuardKey: wg(),
    ports: { exit: 51820, guard: 51821, control: 51822 }, roles, pricePerGiB6: 0, region: 'r' + address.split('.')[3], kind: 'enclave', hostId: null, issuedAt: now, expiresAt: now + 3600e3 };
  return { r, env: await signProviderRecord(op, r) };
}
const verdict = (p, { at = Date.now(), pass = true } = {}) => signQualification(checker, { version: 1, providerId: p.r.providerId, operator: p.r.operator, address: p.r.address,
  wgExitKey: p.r.wgExitKey, wgGuardKey: p.r.wgGuardKey, roles: p.r.roles, checks: Object.fromEntries(CHECKS.map((c) => [c, pass || c !== 'blocksPrivateDestinations'])), issuedAt: at, expiresAt: at + 10 * 60000 });
const deadOrigin = async () => `http://127.0.0.1:${await freePort()}/`;
function fakeRuntime() {
  const started = [];
  return { started, async start(o) { const c = new EventEmitter(); Object.assign(c, { closed: false, providers: { guard: o.guard, exit: o.exit }, service: { names: o.service.granted, exitKey: 'K', control: '127.0.0.1:1' }, close: async () => { c.closed = true; } }); started.push(c); return c; } };
}

test('B8: verdicts published ONLY to another host\'s replica reach this host\'s replica by its own pull; a rebuild needs none of this host\'s circuits', async () => {
  const X = await provider('134.199.235.187', ['ingress', 'egress']), G = await provider('134.209.248.172', ['guard']);
  const other = await replica();                                        // ANOTHER host's replica: where checkers/providers publish
  const pub = new DirectoryClient({ origins: [other], timeoutMs: 3000 });
  for (const p of [X, G]) { await pub.publish('/v1/network/providers', p.env); await pub.publish('/v1/network/qualifications', await verdict(p)); }
  const mine = await replica([other]);                                  // THIS host's replica: peers = [the other one], nothing posted to it
  const client = new DirectoryClient({ origins: [await deadOrigin(), mine], timeoutMs: 2000 });   // every DO directory dead
  const providers = async (now = Date.now()) => eligibleProviders((await client.providers({ now })).providers, { checkers: [checker.address], now });
  let list = [];
  for (let i = 0; i < 60 && list.length < 2; i++) { list = await providers().catch(() => []); if (list.length < 2) await new Promise((r) => setTimeout(r, 250)); }
  assert.deepEqual(list.map((p) => p.providerId).sort(), [X.r.providerId, G.r.providerId].sort(), 'this host\'s replica pulled the signed records and verdicts');
  // every circuit of this host is down: the rebuild reads only its own replica
  const rt = fakeRuntime();
  const t = new HostServiceTransport({ runtime: rt, providers: () => providers(), grants: { revoke: async () => ({ revoked: true }) }, hostId: HOST,
    config: { zone: 'app.enclave.host', exits: [X.r.providerId], ports: { 'directory-replica': 18188 } } });
  await t.reconcile(); assert.equal(rt.started.length, 1, 'rebuilt from the pulled verdicts');
  // freshness is NOT weakened: past the verdict's 10 minutes nothing is eligible (no last-verified grace)
  assert.deepEqual(await providers(Date.now() + 11 * 60000), []);
});

test('B8: a newer signed NEGATIVE verdict published to the other replica reaches this host\'s replica and wins', async () => {
  const X = await provider('134.199.235.187', ['ingress', 'egress']);
  const other = await replica();
  const pub = new DirectoryClient({ origins: [other], timeoutMs: 3000 });
  await pub.publish('/v1/network/providers', X.env); await pub.publish('/v1/network/qualifications', await verdict(X, { at: Date.now() - 5000 }));
  await pub.publish('/v1/network/qualifications', await verdict(X, { at: Date.now(), pass: false }));
  const mine = await replica([other]);
  const client = new DirectoryClient({ origins: [mine], timeoutMs: 2000 });
  let entries = [];
  for (let i = 0; i < 60 && !entries.length; i++) { entries = (await client.providers().catch(() => ({ providers: [] }))).providers; if (!entries.length) await new Promise((r) => setTimeout(r, 250)); }
  assert.equal(entries.length, 1, 'pulled');
  assert.deepEqual(await eligibleProviders(entries, { checkers: [checker.address], now: Date.now() }), [], 'the security failure is not hidden by the older pass');
});
