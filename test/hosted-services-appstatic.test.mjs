// APP_STATIC parity for the route-dns host role (work/hosted-services-activation): the fleet DNS front answers fixed A
// records for platform services sharing the app zone (relay/dns-relay.js APP_STATIC). The role now carries ONLY validated
// explicit public label -> IPv4 mappings through its configuration into the sanitized environment, and:
//   - a static label answers exactly its address over real DNS (from the PINNED route-dns package, started by the real
//     runner with its real child environment); AAAA is NODATA;
//   - deployment names keep their authority: a route-map deployment label answers from the route map, an unknown
//     deployment-shaped (hex) label is SERVFAIL, an unconfigured static-style label is NODATA;
//   - malformed, deployment-shaped (hex, dep-/dep_/0x, legacy [a-z0-9]+), uppercase, non-public or oversized mappings are
//     REFUSED before anything starts (the relay itself would silently drop them);
//   - gen-config carries captured mappings (and Windows paths for a win32 target); stage-1 health checks every static label.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import { spawn as realSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runHostServices, validateHostServicesConfig } from '../network/host-services/runner.mjs';
import { ROLES } from '../network/host-services/roles.mjs';
import { genConfig, health, captureAppStatic } from '../network/host-services/stage-tool.mjs';
import { freePort } from './helpers/cli-independent-rig.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(REPO, 'network/host-services/packages');
const pin = (role) => 'sha256:' + createHash('sha256').update(fs.readFileSync(path.join(PKG, `${role}.package.json`))).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'appstatic-'));
const STATIC = { 'custody-us-west': '134.199.235.187', 'custody-eu-central': '134.209.248.172' };
const wait = async (f, ms, what) => { const end = Date.now() + ms; for (;;) { try { const v = await f(); if (v) return v; } catch {} if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 200)); } };
function query(port, name, qtype) {
  const id = Math.floor(Math.random() * 65535);
  const q = Buffer.concat([Buffer.from([id >> 8, id & 255, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0, 0, qtype, 0, 1])]);
  return new Promise((ok) => {
    const s = dgram.createSocket('udp4'); const t = setTimeout(() => { s.close(); ok(null); }, 1500);
    s.on('message', (m) => { if (m.readUInt16BE(0) !== id) return; clearTimeout(t); s.close();
      const ans = m.readUInt16BE(6), addrs = [];
      let o = 12; while (m[o]) o += m[o] + 1; o += 5;
      for (let i = 0; i < ans; i++) { if ((m[o] & 0xc0) === 0xc0) o += 2; else { while (m[o]) o += m[o] + 1; o++; }
        const type = m.readUInt16BE(o), len = m.readUInt16BE(o + 8); if (type === 1 && len === 4) addrs.push([...m.subarray(o + 10, o + 14)].join('.')); o += 10 + len; }
      ok({ rcode: m[3] & 0x0f, aa: !!(m[2] & 0x04), answers: ans, addrs }); });
    s.send(q, port, '127.0.0.1');
  });
}
const base = (ports) => ({ dnsPort: ports.dns, bind: '127.0.0.1', apiPort: ports.api, zone: 'app.enclave.host', ipZone: 'ip.enclave.host',
  nsName: 'ns-metal0.enclave.host', nsNames: ['ns-us-west.enclave.host', 'ns-metal0.enclave.host'], routeMapUrl: `http://127.0.0.1:${ports.map}/v1/network/routes` });
const cfgOf = (dns) => ({ format: 'enclave-host-services/v1', host: { publicEndpoints: {} }, platformHostPolicy: 'off', packagesDir: PKG, stateRoot: path.join(tmp, 'state'),
  services: [{ role: 'route-dns', package: pin('route-dns'), heapMiB: 128, config: dns }] });

let running = null, mapServer = null;
after(async () => { await running?.stop().catch(() => {}); mapServer?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('malformed, deployment-shaped, non-public and oversized static mappings are refused before anything starts', () => {
  const b = base({ dns: 1, api: 2, map: 3 });
  for (const [m, re] of [
    [{ deadbeef: '8.8.8.8' }, /could name a deployment/],                   // on-chain label shape
    [{ abc123: '8.8.8.8' }, /could name a deployment/],                     // legacy dep_<label> shape (no hyphen)
    [{ 'dep-abc12345': '8.8.8.8' }, /could name a deployment/], [{ 'dep_x-y': '8.8.8.8' }, /not a lowercase DNS label/],
    [{ '0xab-cd': '8.8.8.8' }, /could name a deployment/], [{ 'xn--bcher-kva': '8.8.8.8' }, /could name a deployment/],
    [{ 'Custody-us-west': '8.8.8.8' }, /not a lowercase DNS label/], [{ 'a.b-c': '8.8.8.8' }, /not a lowercase DNS label/],
    [{ '-ab': '8.8.8.8' }, /not a lowercase DNS label/], [{ ['a-' + 'b'.repeat(62)]: '8.8.8.8' }, /not a lowercase DNS label/],
    [{ 'custody-x': '10.0.0.5' }, /public IPv4/], [{ 'custody-x': '127.0.0.1' }, /public IPv4/], [{ 'custody-x': '::1' }, /public IPv4/],
    [{ 'custody-x': '1.2.3.4,evil-x=5.6.7.8' }, /public IPv4/], [{ 'custody-x': 5 }, /public IPv4/],
    [Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`svc-${i}`, '8.8.8.8'])), /at most 32/], [['custody-x=8.8.8.8'], /must map labels/],
  ]) assert.throws(() => validateHostServicesConfig(cfgOf({ ...b, appStatic: m })), re, JSON.stringify(m).slice(0, 80));
  // the sanitized environment: exactly the relay's names, APP_STATIC sorted and joined
  const env = ROLES['route-dns'].launch(ROLES['route-dns'].validate({ ...b, appStatic: { 'custody-us-west': '134.199.235.187', 'alpha-svc': '8.8.8.8' } })).env;
  assert.equal(env.APP_STATIC, 'alpha-svc=8.8.8.8,custody-us-west=134.199.235.187');
  assert.deepEqual(Object.keys(env).sort(), ['APP_STATIC', 'APP_ZONE', 'DNS_API_BIND', 'DNS_API_PORT', 'DNS_BIND', 'DNS_PORT', 'DNS_READ_ONLY', 'IP_ZONE', 'NS_NAME', 'NS_NAMES', 'ROUTE_MAP_URL']);
  assert.equal('APP_STATIC' in ROLES['route-dns'].launch(ROLES['route-dns'].validate(b)).env, false, 'no mapping: no APP_STATIC at all');
});

test('real DNS from the pinned route-dns package: static labels answer, deployment names keep their authority', async () => {
  const ports = { dns: await freePort(), api: await freePort(), map: await freePort() };
  // the route map (a directory's /v1/network/routes): one current deployment label
  mapServer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ labels: { abcd1234: { addresses: ['203.0.114.9'], expiresAt: Date.now() + 3600e3 } } })); });
  await new Promise((ok) => mapServer.listen(ports.map, '127.0.0.1', ok));
  const envs = [];
  const spawn = (exe, argv, opts) => { envs.push(opts.env); return realSpawn(exe, argv, opts); };
  const logs = [];
  running = await runHostServices(cfgOf({ ...base(ports), appStatic: STATIC }), { spawn, log: (m) => logs.push(m), intervalMs: 200 });
  const zone = 'app.enclave.host';
  const a = await wait(() => query(ports.dns, `custody-us-west.${zone}`, 1), 20000, 'route-dns answers\n' + logs.join('\n'));
  assert.equal(a.rcode, 0); assert.equal(a.aa, true); assert.deepEqual(a.addrs, ['134.199.235.187']);
  assert.deepEqual((await query(ports.dns, `custody-eu-central.${zone}`, 1)).addrs, ['134.209.248.172']);
  assert.deepEqual((await query(ports.dns, `CUSTODY-US-WEST.${zone}`, 1)).addrs, ['134.199.235.187'], 'names are case-insensitive');
  const aaaa = await query(ports.dns, `custody-us-west.${zone}`, 28); assert.equal(aaaa.rcode, 0); assert.equal(aaaa.answers, 0, 'static is A only: AAAA NODATA');
  // deployment names keep their authority
  const dep = await wait(async () => { const r = await query(ports.dns, `abcd1234.${zone}`, 1); return r?.addrs.length ? r : null; }, 20000, 'route map label');
  assert.deepEqual(dep.addrs, ['203.0.114.9']);
  assert.equal((await query(ports.dns, `deadbeef.${zone}`, 1)).rcode, 2, 'an unknown deployment-shaped label is SERVFAIL, never a static answer');
  const none = await query(ports.dns, `custody-ca-east.${zone}`, 1); assert.equal(none.rcode, 0); assert.equal(none.answers, 0, 'an unconfigured static-style label is NODATA');
  // the child got the sanitized environment and nothing of this process's
  assert.equal(envs.length, 1);
  assert.equal(envs[0].APP_STATIC, 'custody-eu-central=134.209.248.172,custody-us-west=134.199.235.187');
  assert.deepEqual(Object.keys(envs[0]).filter((k) => !['PATH', 'SystemRoot', 'WINDIR'].includes(k)).sort(),
    ['APP_STATIC', 'APP_ZONE', 'DNS_API_BIND', 'DNS_API_PORT', 'DNS_BIND', 'DNS_PORT', 'DNS_READ_ONLY', 'IP_ZONE', 'NS_NAME', 'NS_NAMES', 'ROUTE_MAP_URL']);
  // stage-1 health checks every static label against the configured address (the gate line fails: policy is "off" here)
  const cfgFile = path.join(tmp, 'host-services.json'); fs.writeFileSync(cfgFile, JSON.stringify(cfgOf({ ...base(ports), appStatic: STATIC })));
  const h = await health({ config: cfgFile });
  assert.equal(h.checks.find((c) => /static platform label/.test(c.name))?.ok, true, JSON.stringify(h.checks));
  assert.equal(h.checks.find((c) => /^gate:/.test(c.name)).ok, false, 'policy off never passes stage-1 health');
  const wrong = path.join(tmp, 'wrong.json'); fs.writeFileSync(wrong, JSON.stringify(cfgOf({ ...base(ports), appStatic: { ...STATIC, 'custody-us-west': '8.8.8.8' } })));
  assert.equal((await health({ config: wrong })).checks.find((c) => /static platform label/.test(c.name)).ok, false, 'a served address that differs from the config fails');
  // the public-only capture, against this authoritative server: kept only what it answers authoritatively and uniquely
  const cap = await captureAppStatic({ zone, labels: ['custody-us-west', 'custody-ca-east', 'deadbeef', 'abcd1234'], servers: ['127.0.0.1'], port: ports.dns });
  assert.deepEqual(cap.labels, { 'custody-us-west': '134.199.235.187' });
  assert.deepEqual(cap.refused.map((r) => r.label).sort(), ['abcd1234', 'custody-ca-east', 'deadbeef']);
  assert.match(cap.refused.find((r) => r.label === 'abcd1234').reason, /could name a deployment/, 'a deployment label is never captured as static');
});

test('capture-app-static refuses disagreement, non-authoritative answers and multiple records; never chooses', async () => {
  const answer = (addresses, extra = {}) => ({ rcode: 0, authoritative: true, answers: addresses.length, address: addresses[0] ?? null, addresses, ...extra });
  const scripted = { 'ns1|custody-a': answer(['198.51.100.7']), 'ns2|custody-a': answer(['198.51.100.7']),
    'ns1|custody-b': answer(['198.51.100.7']), 'ns2|custody-b': answer(['198.51.100.8']),
    'ns1|custody-c': answer(['198.51.100.7']), 'ns2|custody-c': answer(['198.51.100.7'], { authoritative: false }),
    'ns1|custody-d': answer(['198.51.100.7', '198.51.100.9']), 'ns2|custody-d': answer(['198.51.100.9', '198.51.100.7']),
    'ns1|custody-e': answer(['192.168.1.1']), 'ns2|custody-e': answer(['192.168.1.1']),
    'ns1|custody-f': null, 'ns2|custody-f': answer(['198.51.100.7']) };
  const query = async (_port, server, name) => scripted[`${server}|${name.split('.')[0]}`];
  const r = await captureAppStatic({ zone: 'app.enclave.host', labels: ['custody-a', 'custody-b', 'custody-c', 'custody-d', 'custody-e', 'custody-f'], servers: ['ns1', 'ns2'], query });
  // 198.51.100.0/24 is documentation space: refused as non-public by the role's own rule, like a private address
  assert.deepEqual(r.labels, {});
  const why = Object.fromEntries(r.refused.map((x) => [x.label, x.reason]));
  assert.match(why['custody-a'], /public IPv4/); assert.match(why['custody-b'], /disagree/); assert.match(why['custody-c'], /authoritatively/);
  assert.match(why['custody-d'], /2 A records/); assert.match(why['custody-e'], /public IPv4/); assert.match(why['custody-f'], /authoritatively/);
  const ok = await captureAppStatic({ zone: 'app.enclave.host', labels: ['custody-a'], servers: ['ns1', 'ns2'],
    query: async () => answer(['134.199.235.187']) });
  assert.deepEqual(ok.labels, { 'custody-a': '134.199.235.187' });
});

test('gen-config carries captured mappings, and uses the TARGET platform\'s paths', () => {
  const spec = { endpoint: 'https://api.enclave.host/t/nucbox-k11', bind: '127.0.0.1', ports: { directory: 18188, bootstrap: 18189, dns: 18153, dnsApi: 18154, policy: 18190 },
    serviceIndex: { chainId: 8453, address: '0x54dEcb43DE6f9Cc953Ba582B190b56C5a60B5941', codeHash: '0x' + '11'.repeat(32) },
    pins: { 'directory-replica': 'sha256:' + 'a'.repeat(64), 'bootstrap-replica': 'sha256:' + 'b'.repeat(64), 'route-dns': 'sha256:' + 'c'.repeat(64), 'policy-mirror': 'sha256:' + 'd'.repeat(64) },
    directoryRpc: ['https://mainnet.base.org', 'https://base.drpc.org'], authorityPins: {}, checkers: [], directoryPeers: [],
    dns: { zone: 'app.enclave.host', ipZone: 'ip.enclave.host', nsName: 'ns-metal0.enclave.host', nsNames: ['ns-metal0.enclave.host'], appStatic: STATIC } };
  const lin = genConfig({ ...spec, stateRoot: '/var/lib/x/hs1', dataRoot: '/var/lib/x-data/hs1', packagesDir: '/opt/x/packages' }, 'tcp LISTEN 0 128 127.0.0.1:22 0.0.0.0:*');
  assert.deepEqual(lin.services.find((s) => s.role === 'route-dns').config.appStatic, STATIC);
  assert.equal(lin.services.find((s) => s.role === 'bootstrap-replica').config.directory, '/var/lib/x-data/hs1/artifacts');
  const win = genConfig({ ...spec, platform: 'win32', stateRoot: 'C:\\ProgramData\\Enclave\\host-services\\hs1\\state', dataRoot: 'C:\\ProgramData\\Enclave\\host-services\\hs1\\data',
    packagesDir: 'C:\\Program Files\\Enclave\\host-services\\hs1\\packages' }, 'tcp LISTEN 0 128 127.0.0.1:22 0.0.0.0:*');
  assert.equal(win.services.find((s) => s.role === 'bootstrap-replica').config.directory, 'C:\\ProgramData\\Enclave\\host-services\\hs1\\data\\artifacts');
  assert.equal(win.platformHostPolicyCarriers.importDir, 'C:\\ProgramData\\Enclave\\host-services\\hs1\\data\\policy-import');
  assert.equal(win.platformHostPolicy, 'production');
  const noStatic = genConfig({ ...spec, dns: { ...spec.dns, appStatic: undefined }, stateRoot: '/s', dataRoot: '/d', packagesDir: '/p' }, 'tcp LISTEN 0 128 127.0.0.1:22 0.0.0.0:*');
  assert.equal('appStatic' in noStatic.services.find((s) => s.role === 'route-dns').config, false, 'nothing captured: no static labels');
});
