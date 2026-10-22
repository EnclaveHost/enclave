// How a host's derived service names RESOLVE (work/host-service-transport-20261021; root review 15:35Z): through the existing
// hosted authoritative DNS - the route-dns role's appStatic -> relay/dns-relay.js APP_STATIC - with EVERY provider address
// that carries the host's grant, generated from ONE exit list (stage-tool.mjs hostServicePublication) that also configures
// the host's service circuits. Existing single-address strings keep their exact form. Real DNS from the source relay.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../network/host-services/roles.mjs';
import { hostServicePublication, genConfig } from '../network/host-services/stage-tool.mjs';
import { hostServiceNames } from '../network/host-service-names.mjs';
import { hostIdOfEndpoint } from '../network/host-service-gate.mjs';
import { validateHostServicesTransport } from '../network/host-service-transport.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINT = 'https://api.enclave.host/t/nucbox-k11-4', ZONE = 'app.enclave.host';
const EXITS = [{ providerId: 'e1'.repeat(16), address: '134.199.235.187' }, { providerId: 'e2'.repeat(16), address: '134.209.248.172' }, { providerId: 'e3'.repeat(16), address: '159.89.1.10' }];
const kids = []; after(() => { for (const k of kids) k.kill(); });
const freePort = async () => { const s = (await import('node:net')).createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
function query(port, name, qtype) {
  const id = Math.floor(Math.random() * 65535);
  const q = Buffer.concat([Buffer.from([id >> 8, id & 255, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0, 0, qtype, 0, 1])]);
  return new Promise((ok) => {
    const s = dgram.createSocket('udp4'); const t = setTimeout(() => { s.close(); ok(null); }, 1500);
    s.on('message', (m) => { if (m.readUInt16BE(0) !== id) return; clearTimeout(t); s.close();
      const ans = m.readUInt16BE(6), addrs = []; let o = 12; while (m[o]) o += m[o] + 1; o += 5;
      for (let i = 0; i < ans; i++) { if ((m[o] & 0xc0) === 0xc0) o += 2; else { while (m[o]) o += m[o] + 1; o++; }
        const type = m.readUInt16BE(o), len = m.readUInt16BE(o + 8); if (type === 1 && len === 4) addrs.push([...m.subarray(o + 10, o + 14)].join('.')); o += 10 + len; }
      ok({ rcode: m[3] & 0x0f, aa: !!(m[2] & 0x04), answers: ans, addrs }); });
    s.send(q, port, '127.0.0.1');
  });
}
const wait = async (f, ms) => { const end = Date.now() + ms; for (;;) { const v = await f().catch(() => null); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 150)); } };

test('publication: this host\'s names, every exit\'s address per label, and the agent block - all from one exit list', () => {
  const p = hostServicePublication({ endpoint: ENDPOINT, zone: ZONE, exits: EXITS, dns: { tcp: 18153, udp: 18153 } });
  assert.equal(p.hostId, hostIdOfEndpoint(ENDPOINT));
  assert.deepEqual(p.names, hostServiceNames(p.hostId, ZONE));
  for (const role of ['directory-replica', 'bootstrap-replica', 'policy-mirror'])
    assert.deepEqual(p.appStatic[p.names[role].slice(0, -(ZONE.length + 1))], EXITS.map((x) => x.address), role);
  assert.deepEqual(p.agent.hostServices.exits, EXITS.map((x) => x.providerId), 'the circuits go to exactly the providers DNS names');
  assert.doesNotThrow(() => validateHostServicesTransport(p.agent.hostServices));
  assert.deepEqual(p.endpoints['directory-replica'], [`http://${p.names['directory-replica']}/`]);
  const tls = hostServicePublication({ endpoint: ENDPOINT, zone: ZONE, exits: EXITS, tls: { httpPort: 18280, tlsPorts: { 'directory-replica': 18288 } } });
  assert.deepEqual(tls.endpoints['directory-replica'], [`https://${tls.names['directory-replica']}/`]);
  for (const [o, re] of [[{ exits: [] }, /1 to 8 exits/], [{ exits: [EXITS[0], EXITS[0]] }, /each exit once/], [{ exits: [{ providerId: 'e1'.repeat(16), address: '10.0.0.1' }] }, /public IPv4/],
    [{ endpoint: 'http://x' }, /registry endpoint/], [{ exits: [{ providerId: 'nothex', address: '134.199.235.187' }] }, /exits/]])
    assert.throws(() => hostServicePublication({ endpoint: ENDPOINT, zone: ZONE, exits: EXITS, ...o }), re, JSON.stringify(o));
});

test('route-dns appStatic: a list is 1-8 distinct public IPv4s joined with "+"; existing single strings are byte-identical', () => {
  const base = { dnsPort: 1, bind: '127.0.0.1', apiPort: 2, zone: ZONE, ipZone: 'ip.enclave.host', nsName: 'ns-a.enclave.host', nsNames: ['ns-a.enclave.host'], routeMapUrl: 'http://127.0.0.1:3/v1/network/routes' };
  const env = (appStatic) => ROLES['route-dns'].launch(ROLES['route-dns'].validate({ ...base, appStatic })).env.APP_STATIC;
  assert.equal(env({ 'custody-us-west': '134.199.235.187', 'alpha-svc': '8.8.8.8' }), 'alpha-svc=8.8.8.8,custody-us-west=134.199.235.187', 'unchanged');
  assert.equal(env({ 'dir-x-svc': ['134.199.235.187', '134.209.248.172'], 'alpha-svc': '8.8.8.8' }), 'alpha-svc=8.8.8.8,dir-x-svc=134.199.235.187+134.209.248.172');
  for (const bad of [[], ['8.8.8.8', '8.8.8.8'], ['10.0.0.1'], Array.from({ length: 9 }, (_, i) => `8.8.8.${i + 1}`), ['8.8.8.8+9.9.9.9'], [5]])
    assert.throws(() => env({ 'dir-x-svc': bad }), /public IPv4 address, or a list/, JSON.stringify(bad));
});

test('real DNS from the source relay: every exit address for a host name; static strings, deployment authority and NODATA unchanged', async () => {
  const pub = hostServicePublication({ endpoint: ENDPOINT, zone: ZONE, exits: EXITS });
  const ports = { dns: await freePort(), api: await freePort(), map: await freePort() };
  const map = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify({ labels: { abcd1234: { addresses: ['203.0.114.9'], expiresAt: Date.now() + 3600e3 } } })); });
  await new Promise((r) => map.listen(ports.map, '127.0.0.1', r)); after(() => map.close());
  const cfg = ROLES['route-dns'].validate({ dnsPort: ports.dns, bind: '127.0.0.1', apiPort: ports.api, zone: ZONE, ipZone: 'ip.enclave.host', nsName: 'ns-metal0.enclave.host',
    nsNames: ['ns-metal0.enclave.host'], routeMapUrl: `http://127.0.0.1:${ports.map}/v1/network/routes`, appStatic: { 'custody-us-west': '134.199.235.187', ...pub.appStatic } });
  const child = spawn(process.execPath, [path.join(REPO, 'relay/dns-relay.js')], { env: { PATH: process.env.PATH, ...ROLES['route-dns'].launch(cfg).env }, stdio: ['ignore', 'ignore', 'pipe'] });
  kids.push(child); let err = ''; child.stderr.on('data', (b) => { err += b; });
  const dir = pub.names['directory-replica'];
  const a = await wait(() => query(ports.dns, dir, 1), 15000);
  assert.ok(a, 'route-dns answered: ' + err.slice(-400));
  assert.equal(a.rcode, 0); assert.equal(a.aa, true); assert.deepEqual([...a.addrs].sort(), EXITS.map((x) => x.address).sort(), 'every provider carrying the grant');
  assert.deepEqual((await query(ports.dns, pub.names['policy-mirror'].toUpperCase(), 1)).addrs.length, 3, 'case-insensitive');
  assert.equal((await query(ports.dns, dir, 28)).answers, 0, 'A only: AAAA NODATA');
  assert.deepEqual((await query(ports.dns, `custody-us-west.${ZONE}`, 1)).addrs, ['134.199.235.187'], 'a single static string answers as before');
  const other = hostServiceNames(hostIdOfEndpoint('https://api.enclave.host/t/someone-else'), ZONE)['directory-replica'];
  const none = await query(ports.dns, other, 1); assert.equal(none.rcode, 0); assert.equal(none.answers, 0, 'another host\'s (unpublished) name is NODATA');
  const dep = await wait(async () => { const r = await query(ports.dns, `abcd1234.${ZONE}`, 1); return r?.addrs.length ? r : null; }, 15000);
  assert.deepEqual(dep?.addrs, ['203.0.114.9'], 'deployment labels keep the route map\'s authority');
  assert.equal((await query(ports.dns, `deadbeef.${ZONE}`, 1)).rcode, 2, 'an unknown deployment label is still SERVFAIL');
});

test('gen-config carries this host\'s labels next to the captured ones, and refuses a label that is both', () => {
  const spec = { endpoint: ENDPOINT, bind: '127.0.0.1', ports: { directory: 18188, bootstrap: 18189, dns: 18153, dnsApi: 18154, policy: 18190 },
    serviceIndex: { chainId: 8453, address: '0x54dEcb43DE6f9Cc953Ba582B190b56C5a60B5941', codeHash: '0x' + '11'.repeat(32) },
    pins: { 'directory-replica': 'sha256:' + 'a'.repeat(64), 'bootstrap-replica': 'sha256:' + 'b'.repeat(64), 'route-dns': 'sha256:' + 'c'.repeat(64), 'policy-mirror': 'sha256:' + 'd'.repeat(64) },
    directoryRpc: ['https://mainnet.base.org', 'https://base.drpc.org'], authorityPins: {}, checkers: [], directoryPeers: [], stateRoot: '/s', dataRoot: '/d', packagesDir: '/p',
    dns: { zone: ZONE, ipZone: 'ip.enclave.host', nsName: 'ns-metal0.enclave.host', nsNames: ['ns-metal0.enclave.host'], appStatic: { 'custody-us-west': '134.199.235.187' } } };
  const L = 'tcp LISTEN 0 128 127.0.0.1:22 0.0.0.0:*';
  const plain = genConfig(spec, L);
  assert.deepEqual(plain.services.find((s) => s.role === 'route-dns').config.appStatic, { 'custody-us-west': '134.199.235.187' }, 'without spec.hostServices: as before');
  const withHs = genConfig({ ...spec, hostServices: { exits: EXITS } }, L);
  const pub = hostServicePublication({ endpoint: ENDPOINT, zone: ZONE, exits: EXITS });
  assert.deepEqual(withHs.services.find((s) => s.role === 'route-dns').config.appStatic, { 'custody-us-west': '134.199.235.187', ...pub.appStatic });
  assert.deepEqual(withHs.host.publicEndpoints, {}, 'stage 1 still advertises nothing');
  const label = Object.keys(pub.appStatic)[0];
  assert.throws(() => genConfig({ ...spec, dns: { ...spec.dns, appStatic: { [label]: '8.8.8.8' } }, hostServices: { exits: EXITS } }, L), /both captured and this host's service name/);
});
