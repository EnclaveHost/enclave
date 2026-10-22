// A5 authority: a READ-ONLY route replica (hs2 route-dns) that a provider's whole DNS port is pinned to keeps answering the
// platform's relay-issued dns-01 challenges by merging TXT from the writable challenge source (CHALLENGE_TXT_UPSTREAM), and
// answers the ip zone exactly as today (apex; every label NXDOMAIN: no route map carries an address). Loopback only.
//   A5_TREE=<tree root holding relay/dns-relay.js and network/host-services/roles.mjs> node --test this file
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const TREE = process.env.A5_TREE;
const BIN = path.join(TREE, 'relay/dns-relay.js');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const VALUE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';   // dns-01 shape: 43 base64url chars
const T = { A: 1, NS: 2, SOA: 6, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 };
const kids = [], servers = [];
test.after(() => { for (const k of kids) k.kill(); for (const s of servers) s.close(); });

function query(name, type, id = 0x4242) {
  const h = Buffer.alloc(12); h.writeUInt16BE(id, 0); h.writeUInt16BE(0x0100, 2); h.writeUInt16BE(1, 4);
  return Buffer.concat([h, ...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0, type >> 8, type & 255, 0, 1])]);
}
function skipName(m, o) { for (;;) { const l = m[o]; if (l === 0) return o + 1; if ((l & 0xc0) === 0xc0) return o + 2; o += 1 + l; } }
// -> { rcode, aa, answers: [{ type, data }] } (TXT data decoded)
function parse(m) {
  const rcode = m.readUInt16BE(2) & 15, aa = !!(m[2] & 4), qd = m.readUInt16BE(4), an = m.readUInt16BE(6);
  let o = 12; for (let i = 0; i < qd; i++) o = skipName(m, o) + 4;
  const answers = [];
  for (let i = 0; i < an; i++) {
    o = skipName(m, o); const type = m.readUInt16BE(o), len = m.readUInt16BE(o + 8); const rd = m.subarray(o + 10, o + 10 + len); o += 10 + len;
    if (type === T.TXT) { let v = '', p = 0; while (p < rd.length) { v += rd.subarray(p + 1, p + 1 + rd[p]).toString(); p += 1 + rd[p]; } answers.push({ type, data: v }); }
    else answers.push({ type, data: rd });
  }
  return { rcode, aa, answers };
}
async function ask(port, name, type, tcp) {
  const q = query(name, type);
  if (!tcp) {
    const s = dgram.createSocket('udp4');
    try { const got = once(s, 'message'); s.send(q, port, '127.0.0.1'); return parse((await Promise.race([got, delay(4000).then(() => { throw Error('udp timeout ' + name); })]))[0]); }
    finally { s.close(); }
  }
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => { const n = Buffer.alloc(2); n.writeUInt16BE(q.length); s.write(Buffer.concat([n, q])); });
    let b = Buffer.alloc(0); const t = setTimeout(() => { s.destroy(); reject(Error('tcp timeout ' + name)); }, 4000);
    s.on('data', (d) => { b = Buffer.concat([b, d]); if (b.length >= 2 && b.length >= 2 + b.readUInt16BE(0)) { clearTimeout(t); s.destroy(); resolve(parse(b.subarray(2, 2 + b.readUInt16BE(0)))); } });
    s.on('error', reject);
  });
}
// the writable challenge source as dns-relay sees it: TCP DNS; TXT for exactly one name
async function upstream() {
  const st = { queries: [] };
  const srv = net.createServer((s) => {
    let b = Buffer.alloc(0);
    s.on('data', (d) => {
      b = Buffer.concat([b, d]); if (b.length < 2 || b.length < 2 + b.readUInt16BE(0)) return;
      const q = b.subarray(2, 2 + b.readUInt16BE(0)); let o = 12; const labels = [];
      for (;;) { const l = q[o]; if (!l) break; labels.push(q.subarray(o + 1, o + 1 + l).toString()); o += 1 + l; }
      const name = labels.join('.'); st.queries.push(name);
      const hit = name === '_acme-challenge.abcd.app.test';
      const head = Buffer.from(q.subarray(0, 12)); head.writeUInt16BE(0x8400, 2); head.writeUInt16BE(hit ? 1 : 0, 6);
      const qsec = q.subarray(12, o + 5);
      const rr = hit ? Buffer.concat([Buffer.from([0xc0, 12, 0, 16, 0, 1, 0, 0, 0, 60, 0, VALUE.length + 1, VALUE.length]), Buffer.from(VALUE)]) : Buffer.alloc(0);
      const out = Buffer.concat([head, qsec, rr]); const n = Buffer.alloc(2); n.writeUInt16BE(out.length); s.end(Buffer.concat([n, out]));
    });
  });
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); servers.push(srv); st.srv = srv; st.port = srv.address().port; return st;
}
async function replica(extra) {
  const origin = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify({ labels: { abcd: { addresses: ['198.51.100.7'], expiresAt: Date.now() + 600000 } },
      deployments: { ['0x' + 'abcd'.padEnd(64, '0')]: { transport: 'enclave-network', expiresAt: Date.now() + 600000, httpsRoutes: [], version: 2 } } })); });
  origin.listen(0, '127.0.0.1'); await once(origin, 'listening'); servers.push(origin);
  const dnsPort = await freePort(), apiPort = await freePort();
  const env = { PATH: process.env.PATH, DNS_READ_ONLY: '1', DNS_BIND: '127.0.0.1', DNS_PORT: String(dnsPort), DNS_API_BIND: '127.0.0.1', DNS_API_PORT: String(apiPort),
    IP_ZONE: 'ip.test', APP_ZONE: 'app.test', NS_NAME: 'ns-a.test', NS_NAMES: 'ns-a.test,ns-b.test', NET_POLL_SEC: '1',
    ROUTE_MAP_URL: `http://127.0.0.1:${origin.address().port}/v1/network/routes`, ...extra };
  const child = spawn(process.execPath, [BIN], { env, stdio: ['ignore', 'pipe', 'pipe'] }); kids.push(child);
  let log = ''; child.stdout.on('data', (c) => (log += c)); child.stderr.on('data', (c) => (log += c));
  let health = null;
  for (let i = 0; i < 80 && child.exitCode === null; i++) { health = await fetch(`http://127.0.0.1:${apiPort}/health`).then((r) => r.json()).catch(() => null); if (health?.routeLabels === 1) break; await delay(100); }
  return { dnsPort, apiPort, health, child, log: () => log };
}

test('a pinned read-only replica answers relay-issued dns-01 TXT from CHALLENGE_TXT_UPSTREAM, and nothing else changes', async () => {
  const up = await upstream();
  const r = await replica({ CHALLENGE_TXT_UPSTREAM: `127.0.0.1:${up.port}` });
  assert.equal(r.health?.readOnly, true, r.log()); assert.equal(r.health?.challengeTxtUpstream, true, r.log());
  for (const tcp of [false, true]) {
    for (const type of [T.TXT, T.ANY]) {
      const a = await ask(r.dnsPort, '_acme-challenge.abcd.app.test', type, tcp);
      assert.equal(a.rcode, 0); assert.equal(a.aa, true);
      assert.deepEqual(a.answers.map((x) => x.data), [VALUE], `the upstream's challenge value (${tcp ? 'tcp' : 'udp'} type ${type})`);
    }
    const none = await ask(r.dnsPort, '_acme-challenge.beef.app.test', T.TXT, tcp);
    assert.equal(none.rcode, 0); assert.equal(none.answers.length, 0, 'no value upstream: NODATA, as today');
    const addr = await ask(r.dnsPort, 'abcd.app.test', T.A, tcp);
    assert.deepEqual([...addr.answers[0].data], [198, 51, 100, 7], 'app routes unchanged');
    // the ip zone exactly as the control pool answers it today: apex, and NXDOMAIN for every label (no address in any map)
    assert.equal((await ask(r.dnsPort, 'abcd0000.ip.test', T.A, tcp)).rcode, 3);
    assert.equal((await ask(r.dnsPort, '_minecraft._tcp.abcd0000.ip.test', T.SRV, tcp)).rcode, 3);
    const ns = await ask(r.dnsPort, 'ip.test', T.NS, tcp); assert.equal(ns.rcode, 0); assert.equal(ns.answers.length, 2);
  }
  assert.ok(up.queries.every((q) => q.startsWith('_acme-challenge.') && q.endsWith('.app.test')), 'only app-zone challenge names go upstream: ' + up.queries);
  for (const method of ['POST', 'DELETE']) assert.equal((await fetch(`http://127.0.0.1:${r.apiPort}/v1/txt`, { method, body: '{}' })).status, 405, 'still read-only: no writes');
  // an unreachable source contributes nothing (NODATA after its 1.5 s bound), never an error or a stale value
  up.srv.close(); await delay(3200);
  const down = await ask(r.dnsPort, '_acme-challenge.abcd.app.test', T.TXT, true);
  assert.equal(down.rcode, 0); assert.equal(down.answers.length, 0);
  assert.equal(r.child.exitCode, null, 'the replica keeps running');
});

test('without CHALLENGE_TXT_UPSTREAM the replica is unchanged: no challenge TXT, no upstream query', async () => {
  const up = await upstream();
  const r = await replica({});
  assert.equal(r.health?.readOnly, true, r.log()); assert.equal(r.health?.challengeTxtUpstream, undefined);
  const a = await ask(r.dnsPort, '_acme-challenge.abcd.app.test', T.TXT, false);
  assert.equal(a.rcode, 0); assert.equal(a.answers.length, 0);
  assert.equal(up.queries.length, 0);
});

test('CHALLENGE_TXT_UPSTREAM must be an IP literal and port', async () => {
  for (const bad of ['ns.example:53', '127.0.0.1', '127.0.0.1:0', '127.0.0.1:99999']) {
    const r = await replica({ CHALLENGE_TXT_UPSTREAM: bad });
    if (r.child.exitCode === null) await Promise.race([once(r.child, 'exit'), delay(2000)]);
    assert.notEqual(r.child.exitCode, null, 'invalid config did not refuse within 2 s: ' + bad);
    assert.notEqual(r.child.exitCode, 0, bad); assert.match(r.log(), /CHALLENGE_TXT_UPSTREAM must be ip:port/, bad);
  }
});

test('route-dns role: challengeTxtUpstream is optional, validated, and becomes CHALLENGE_TXT_UPSTREAM', async () => {
  const { ROLES } = await import(path.join(TREE, 'network/host-services/roles.mjs'));
  const base = { dnsPort: 18153, bind: '127.0.0.1', apiPort: 18154, zone: 'app.enclave.host', ipZone: 'ip.enclave.host', nsName: 'ns-us-west.enclave.host',
    nsNames: ['ns-us-west.enclave.host', 'ns-ca-east.enclave.host'], routeMapUrl: 'http://127.0.0.1:18188/v1/network/routes' };
  const rd = ROLES['route-dns'];
  assert.ok(!('CHALLENGE_TXT_UPSTREAM' in rd.launch(rd.validate(base)).env), 'absent: the launch environment is unchanged');
  for (const ok of ['134.199.235.187:53', '[2001:db8::1]:53', '127.0.0.1:31053'])
    assert.equal(rd.launch(rd.validate({ ...base, challengeTxtUpstream: ok })).env.CHALLENGE_TXT_UPSTREAM, ok);
  for (const bad of ['ns-us-west.enclave.host:53', '134.199.235.187', '134.199.235.187:0', 53, '127.0.0.1:18153'])
    assert.throws(() => rd.validate({ ...base, challengeTxtUpstream: bad }), /challengeTxtUpstream/, String(bad));
});
