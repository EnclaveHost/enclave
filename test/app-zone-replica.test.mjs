// The route replica's app-zone challenge write path (relay/dns-relay.js APP_CHALLENGE_AUTH=attested-lease) as SEPARATE
// processes (test/app-zone-fleet.mjs): HTTP push -> independent chain + judge verification -> DNS answer over UDP/TCP,
// peer forwarding re-verified by each peer, the upstream (previous challenge source) merge, bounds, and startup refusals.
// Synthetic reports, lab-unsigned judge, loopback JSON-RPC chain - run inside an unshared network namespace.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import path from 'node:path';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import * as F from './app-zone-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let fleet, info;
test.before(async () => {
  fleet = spawn(process.execPath, [path.join(ROOT, 'test', 'app-zone-fleet.mjs'), '3'], {stdio: ['pipe', 'pipe', 'inherit']});
  const rl = readline.createInterface({input: fleet.stdout});
  const [line] = await Promise.race([once(rl, 'line'), delay(60000).then(() => { throw Error('fleet did not start'); })]);
  info = JSON.parse(line);
  console.log('replica entry:', info.entry);
});
test.after(async () => { if (fleet) { fleet.stdin.end(); await once(fleet, 'exit'); } });

function query(name, type = 16) {
  const h = Buffer.alloc(12); h.writeUInt16BE(0x4242, 0); h.writeUInt16BE(0x0000, 2); h.writeUInt16BE(1, 4);
  return Buffer.concat([h, ...name.split('.').map((v) => Buffer.concat([Buffer.from([v.length]), Buffer.from(v)])), Buffer.from([0, 0, type, 0, 1])]);
}
async function ask(server, name, tcp = false) {
  const [host, port] = server.split(':'), q = query(name);
  if (!tcp) { const s = dgram.createSocket('udp4'); try { const a = once(s, 'message'); s.send(q, Number(port), host); return (await Promise.race([a, delay(2000).then(() => { throw Error('UDP timeout'); })]))[0]; } finally { s.close(); } }
  return new Promise((resolve, reject) => { const s = net.connect(Number(port), host, () => { const n = Buffer.alloc(2); n.writeUInt16BE(q.length); s.write(Buffer.concat([n, q])); });
    let d = Buffer.alloc(0); s.on('data', (c) => { d = Buffer.concat([d, c]); if (d.length >= 2 && d.length >= 2 + d.readUInt16BE(0)) { s.end(); resolve(d.subarray(2)); } }); s.on('error', reject); });
}
const answers = (msg) => msg.readUInt16BE(6);
const post = (i, p, method = 'POST') => fetch(`${info.replicas[i].api}/v1/app-challenge`, {method, body: p.body, headers: {'content-type': 'application/json', 'x-attested-sig': p.sig}})
  .then(async (r) => ({status: r.status, body: await r.json().catch(() => null)}));
const control = (p, b) => fetch(info.control + p, {method: 'POST', body: JSON.stringify(b)}).then((r) => r.json());

if (process.env.INJECT_FAILURE) test('INJECTED FAILURE (negative control: the suite must exit nonzero)', () => assert.fail('injected'));

test('replicas expose their app-zone authority on /health and answer an accepted push over UDP and TCP', async () => {
  for (const r of info.replicas) {
    const h = await (await fetch(`${r.api}/health`)).json();
    assert.equal(h.readOnly, true); assert.equal(h.appChallenge.mode, 'attested-lease'); assert.equal(h.appChallenge.judgeMode, 'lab-unsigned');
    assert.equal(h.appChallenge.ledgerIndex.complete, true); assert.equal(h.appChallenge.upstream, true);
  }
  const key = F.guestKey(), p = F.appPush(key);
  const v = await post(1, p); assert.equal(v.status, 200, JSON.stringify(v.body)); assert.ok(v.body.ttlSec <= 120);
  for (const tcp of [false, true]) { const a = await ask(info.replicas[1].dns, p.name, tcp); assert.equal(answers(a), 1); assert.ok(a.includes(Buffer.from(p.value))); }
  assert.equal(answers(await ask(info.replicas[2].dns, p.name)), 0, 'replica 1 forwards nothing (no peers configured)');
  const d = await post(1, F.appPush(key, {op: 'delete', value: p.value}), 'DELETE'); assert.equal(d.status, 200);
  assert.equal(answers(await ask(info.replicas[1].dns, p.name)), 0);
  const replay = await post(1, p); assert.equal(replay.status, 409, 'one-shot: the deleted value cannot be re-set by replaying the push');
});

test('a push accepted by replica 0 is forwarded once and each peer verifies it on its own', async () => {
  const p = F.appPush(F.guestKey());
  assert.equal((await post(0, p)).status, 200);
  let seen = false;
  for (let i = 0; i < 30 && !seen; i++) { seen = answers(await ask(info.replicas[2].dns, p.name)) === 1; if (!seen) await delay(100); }
  assert.ok(seen, 'peer replica 2 answers the forwarded push');
  // a forged push sent with the forwarded marker is still refused by the peer's own checks
  const forged = F.appPush(F.guestKey(), {reportOpts: {measurement: '66'.repeat(48)}});
  const r = await fetch(`${info.replicas[2].api}/v1/app-challenge`, {method: 'POST', body: forged.body, headers: {'content-type': 'application/json', 'x-attested-sig': forged.sig, 'x-app-challenge-forwarded': '1'}});
  assert.equal(r.status, 403);
});

test('platform moderation at the replicas: a banned host or delisted app gets no answer anywhere', async () => {
  for (const [op, undo] of [['ban-host', 'unban-host'], ['delist', 'relist'], ['release', 'restore']]) {
    await control('/chain', {op});
    const p = F.appPush(F.guestKey());
    for (let i = 0; i < 3; i++) {
      const v = await post(i, p); assert.equal(v.status, 403, `${op} at replica ${i}: ${JSON.stringify(v.body)}`);
      // the name may still carry an earlier test's (authorized) value within its 120 s life; THIS refused value never appears
      assert.ok(!(await ask(info.replicas[i].dns, p.name)).includes(Buffer.from(p.value)), `${op}: the refused value is answered at replica ${i}`);
    }
    await control('/chain', {op: undo});
  }
});

test('bounds and routes: oversize body 413, other methods 405, malformed 400, other names stay NODATA', async () => {
  const big = F.appPush(F.guestKey(), {extra: {pad: 'x'.repeat(40000)}});
  assert.equal((await post(0, big)).status, 413);
  assert.equal((await fetch(`${info.replicas[0].api}/v1/app-challenge`)).status, 405);
  assert.equal((await post(0, {body: Buffer.from('{not json'), sig: 'AA'})).status, 400);
  assert.equal((await fetch(`${info.replicas[0].api}/v1/txt`, {method: 'POST', body: '{}'})).status, 405, 'no unauthenticated TXT write path');
  const other = await ask(info.replicas[0].dns, `_acme-challenge.${F.OTHER_DEP.slice(2, 10)}.${F.ZONE}`);
  assert.equal(other.readUInt16BE(2) & 15, 0); assert.equal(answers(other), 0);
});

test('transition: the previous challenge source (upstream) still validates existing relay-issued names', async () => {
  for (let i = 0; i < 3; i++) {
    const a = await ask(info.replicas[i].dns, info.legacy.name, i === 2);
    assert.equal(answers(a), 1, `replica ${i}`); assert.ok(a.includes(Buffer.from(info.legacy.value)));
  }
});

test('the app-zone authority refuses to start outside a read-only route replica or without explicit pins', async () => {
  const base = {...process.env, IP_ZONE: 'ip.enclave.host', APP_ZONE: F.ZONE, NS_NAME: 'ns.enclave.host', DNS_BIND: '127.0.0.1', DNS_PORT: '0', DNS_API_PORT: '0',
    APP_CHALLENGE_AUTH: 'attested-lease', APP_CHALLENGE_MEASUREMENTS: F.MEAS, APP_CHALLENGE_RPCS: 'https://127.0.0.2:1,https://127.0.0.3:1', APP_CHALLENGE_PINS: JSON.stringify(F.PINS)};
  const cases = [
    {...base},                                                                                    // not read-only
    {...base, DNS_READ_ONLY: '1', ROUTE_MAP_URL: 'http://127.0.0.1:9/x', APP_CHALLENGE_PINS: JSON.stringify({deployments: F.PINS.deployments})},
    {...base, DNS_READ_ONLY: '1', ROUTE_MAP_URL: 'http://127.0.0.1:9/x', APP_CHALLENGE_MEASUREMENTS: ''},
    {...base, DNS_READ_ONLY: '1', ROUTE_MAP_URL: 'http://127.0.0.1:9/x', APP_CHALLENGE_RPCS: 'https://127.0.0.2:1'},
    {...base, DNS_READ_ONLY: '1', ROUTE_MAP_URL: 'http://127.0.0.1:9/x', APP_CHALLENGE_JUDGE_MODE: 't0-diagnostic'},
    {...base, DNS_READ_ONLY: '1', ROUTE_MAP_URL: 'http://127.0.0.1:9/x', APP_CHALLENGE_AUTH: 'hmac'},
  ];
  for (const env of cases) {
    const c = spawn(process.execPath, [path.join(ROOT, 'relay', 'dns-relay.js')], {cwd: path.join(ROOT, 'relay'), env, stdio: ['ignore', 'pipe', 'pipe']});
    let log = ''; c.stderr.on('data', (d) => { log += d; }); c.stdout.on('data', (d) => { log += d; });
    const [code] = await Promise.race([once(c, 'exit'), delay(15000).then(() => { c.kill('SIGKILL'); return ['timeout']; })]);
    assert.equal(code, 1, log); assert.match(log, /fatal/);
  }
});
