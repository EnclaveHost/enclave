// P3 (reviewer 9d / root 17:0xZ): every public DNS query a host answers through the Enclave-network transport reaches its
// route-dns from the LOOPBACK relay (network/wg/udpforward.go frames UDP onto TCP from 127.0.0.1), so route-dns's
// per-source limit (relay/dns-relay.js, 50/s, burst 200) would make them ONE client. The route-dns role's
// transportRateLimitPerSec/Cap give exactly the loopback relay sources one bounded aggregate bucket; every other source
// keeps its per-source limit. Real DNS against the source relay, loopback only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROLES } from '../network/host-services/roles.mjs';
import { genConfig } from '../network/host-services/stage-tool.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kids = [], servers = []; after(() => { for (const k of kids) k.kill(); for (const s of servers) s.close(); });
const freePort = async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
const ZONE = 'app.enclave.host', LABEL = 'dir-transport-test';
function question(id) {
  return Buffer.concat([Buffer.from([id >> 8, id & 255, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...`${LABEL}.${ZONE}`.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0, 0, 1, 0, 1])]);
}
async function routeDns(extra) {
  const map = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.end('{"labels":{}}'); });
  await new Promise((r) => map.listen(0, '127.0.0.1', r)); servers.push(map);
  const port = await freePort();
  const cfg = ROLES['route-dns'].validate({ dnsPort: port, bind: '127.0.0.1', apiPort: await freePort(), zone: ZONE, ipZone: 'ip.enclave.host', nsName: 'ns-a.enclave.host',
    nsNames: ['ns-a.enclave.host'], routeMapUrl: `http://127.0.0.1:${map.address().port}/v1/network/routes`, appStatic: { [LABEL]: '134.199.235.187' }, ...extra });
  const child = spawn(process.execPath, [path.join(REPO, 'relay/dns-relay.js')], { env: { PATH: process.env.PATH, ...ROLES['route-dns'].launch(cfg).env }, stdio: ['ignore', 'ignore', 'pipe'] });
  kids.push(child);
  for (let i = 0; i < 100; i++) { if (await tcpBurst(port, 1, '127.0.0.1', 300).catch(() => 0)) break; await new Promise((r) => setTimeout(r, 100)); }
  return { port, child };
}
// n framed queries on ONE TCP connection from `from` (as the relay sends them), -> answers within waitMs
function tcpBurst(port, n, from, waitMs = 3000) {
  return new Promise((resolve, reject) => {
    const c = net.connect({ host: '127.0.0.1', port, localAddress: from }); let got = 0, buf = Buffer.alloc(0);
    const t = setTimeout(() => { c.destroy(); resolve(got); }, waitMs);
    c.on('error', (e) => { clearTimeout(t); reject(e); });
    c.on('data', (d) => { buf = Buffer.concat([buf, d]); while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) { buf = buf.subarray(2 + buf.readUInt16BE(0)); got++; } if (got >= n) { clearTimeout(t); c.destroy(); resolve(got); } });
    c.on('connect', () => { const all = []; for (let i = 0; i < n; i++) { const q = question(i & 0xffff); const l = Buffer.alloc(2); l.writeUInt16BE(q.length); all.push(l, q); } c.write(Buffer.concat(all)); });
  });
}

test('the loopback transport gets ONE bounded aggregate (> 50 qps); other sources keep their per-source limit', async () => {
  const withT = await routeDns({ transportRateLimitPerSec: 400, transportRateLimitCap: 800 });
  // a non-relay source FIRST, while the aggregate bucket is full: it must still get only its per-source 200 (+refill).
  // Over TCP, like the relay (a local UDP burst loses datagrams at ~220 by itself, which would hide the difference).
  const other = await tcpBurst(withT.port, 300, '127.0.0.2', 1500);
  assert.ok(other <= 260 && other >= 150, `a non-relay source (127.0.0.2) keeps the per-source limit: ${other} of 300 answered`);
  const relayed = await tcpBurst(withT.port, 600, '127.0.0.1');
  assert.ok(relayed >= 590, `600 relayed queries in one burst: ${relayed} answered (aggregate bucket 800)`);
  // the aggregate is BOUNDED: past its cap (800 + refill) the relay is limited too
  const more = await tcpBurst(withT.port, 900, '127.0.0.1', 1500);
  assert.ok(more < 900, `the aggregate is bounded: ${more} of 900 answered right after`);
  // without the transport limits, the relay is one per-source client (the reviewer's P3 finding)
  const without = await routeDns({});
  const capped = await tcpBurst(without.port, 600, '127.0.0.1', 1500);
  assert.ok(capped <= 260, `without the aggregate the relay shares one per-source bucket: ${capped} of 600 answered`);
});

test('route-dns transport limits: both or neither, cap >= rate, bounded; gen-config sets them for a DNS host from its exits', () => {
  const base = { dnsPort: 1, bind: '127.0.0.1', apiPort: 2, zone: ZONE, ipZone: 'ip.enclave.host', nsName: 'ns-a.enclave.host', nsNames: ['ns-a.enclave.host'], routeMapUrl: 'http://127.0.0.1:3/v1/network/routes' };
  for (const bad of [{ transportRateLimitPerSec: 100 }, { transportRateLimitCap: 100 }, { transportRateLimitPerSec: 100, transportRateLimitCap: 50 }, { transportRateLimitPerSec: 2e6, transportRateLimitCap: 3e6 }, { transportRateLimitPerSec: 0, transportRateLimitCap: 10 }])
    assert.throws(() => ROLES['route-dns'].validate({ ...base, ...bad }), /transportRateLimit/, JSON.stringify(bad));
  const env = ROLES['route-dns'].launch(ROLES['route-dns'].validate({ ...base, transportRateLimitPerSec: 8000, transportRateLimitCap: 16000 })).env;
  assert.equal(env.DNS_RL_TRANSPORT_PER_SEC, '8000'); assert.equal(env.DNS_RL_TRANSPORT_CAP, '16000');
  assert.ok(!('DNS_RL_TRANSPORT_PER_SEC' in ROLES['route-dns'].launch(ROLES['route-dns'].validate(base)).env), 'unset: unchanged');
  const spec = { endpoint: 'https://api.enclave.host/t/nucbox-k11-4', bind: '127.0.0.1', ports: { directory: 18188, bootstrap: 18189, dns: 18153, dnsApi: 18154, policy: 18190 },
    serviceIndex: { chainId: 8453, address: '0x54dEcb43DE6f9Cc953Ba582B190b56C5a60B5941', codeHash: '0x' + '11'.repeat(32) },
    pins: { 'directory-replica': 'sha256:' + 'a'.repeat(64), 'bootstrap-replica': 'sha256:' + 'b'.repeat(64), 'route-dns': 'sha256:' + 'c'.repeat(64), 'policy-mirror': 'sha256:' + 'd'.repeat(64) },
    directoryRpc: ['https://mainnet.base.org', 'https://base.drpc.org'], authorityPins: {}, checkers: [], directoryPeers: [], stateRoot: '/s', dataRoot: '/d', packagesDir: '/p',
    dns: { zone: ZONE, ipZone: 'ip.enclave.host', nsName: 'ns-a.enclave.host', nsNames: ['ns-a.enclave.host'] } };
  const exits = [{ providerId: 'e1'.repeat(16), address: '134.199.235.187' }, { providerId: 'e2'.repeat(16), address: '134.209.248.172' }];
  const L = 'tcp LISTEN 0 128 127.0.0.1:22 0.0.0.0:*';
  const dnsHost = genConfig({ ...spec, hostServices: { exits, dns: { tcp: 18153, udp: 18153 } } }, L).services.find((x) => x.role === 'route-dns').config;
  assert.equal(dnsHost.transportRateLimitPerSec, 4000, 'the providers\' global allowance (2000/s each) times the exits'); assert.equal(dnsHost.transportRateLimitCap, 8000);
  const noDns = genConfig({ ...spec, hostServices: { exits } }, L).services.find((x) => x.role === 'route-dns').config;
  assert.ok(!('transportRateLimitPerSec' in noDns), 'a host that does not answer DNS for the exits: unchanged');
});
