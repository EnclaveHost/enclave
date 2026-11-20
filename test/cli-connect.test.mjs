// cli/connect.mjs against a fake guest front: the attested key is pinned, a changed key is re-attested before any
// request rides it, a refused verdict sends nothing, and the local origin refuses foreign Host/Origin headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startConnect, guestVerifier, shieldVerifier, composeVerifier, SHIELD_FORMAT } from '../cli/connect.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
async function keypair(dir, name) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${dir}/${name}.key`,
    '-out', `${dir}/${name}.crt`, '-days', '1', '-subj', '/CN=app.test'], { stdio: 'ignore' });
  const cert = await fs.readFile(`${dir}/${name}.crt`), key = await fs.readFile(`${dir}/${name}.key`);
  return { cert, key, spki: new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }) };
}
// The fake front: a document that states its own key and echoes the nonce, an echo app, a raw upgrade echo, and the
// enclave-port/1 tunnel (frames echoed back verbatim, so a TCP stream comes back as itself, FIN included).
async function fakeGuest(t, k) {
  const seen = { app: 0, last: null };
  const server = https.createServer({ key: k.key, cert: k.cert }, (req, res) => {
    const u = new URL(req.url, 'https://app.test');
    if (u.pathname === '/.well-known/enclave-attestation') {
      const spki = req.socket.getCertificate() && new X509Certificate(server.current.cert).publicKey.export({ type: 'spki', format: 'der' });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ format: 'fake', key: spki.toString('base64'), nonce: u.searchParams.get('nonce') }));
    }
    seen.app++; seen.last = { method: req.method, url: req.url, headers: req.headers };
    if (u.pathname === '/redirect') {
      res.writeHead(302, { location: u.searchParams.get('to') || `https://app.test:${server.address().port}/next`, 'set-cookie': ['s=1; Domain=app.test; Path=/; HttpOnly'], 'strict-transport-security': 'max-age=1' });
      return res.end();
    }
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ...seen.last, body })); });
  });
  server.current = k;
  server.on('upgrade', (req, socket, head) => {
    seen.app++;
    const tunnel = req.url.startsWith('/.well-known/enclave-tunnel/');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${tunnel ? 'enclave-port/1' : req.headers.upgrade}\r\n\r\n`);
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  server.rekey = (n) => { server.current = n; server.setSecureContext({ key: n.key, cert: n.cert }); };
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { server, seen, port: server.address().port };
}
// The test's notion of "verified": the document names the handshake key and our nonce, and the key is one we trust.
const trusting = (trusted) => async (doc, spki, nonce) => {
  if (doc.nonce !== nonce.toString('hex')) return { ok: false, reason: 'stale nonce' };
  if (!Buffer.from(doc.key, 'base64').equals(spki)) return { ok: false, reason: 'document key is not the handshake key' };
  return trusted.has(sha(spki)) ? { ok: true, format: 'fake', measurement: 'ab'.repeat(48) } : { ok: false, reason: 'untrusted key' };
};
function get(url, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-connect-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, a: await keypair(dir, 'a'), b: await keypair(dir, 'b') };
}

test('serves the guest only after a passing verdict, through the pinned key, with its own origin rewritten', async (t) => {
  const { dir, a } = await setup(t), g = await fakeGuest(t, a), state = path.join(dir, 'state', 'connect.json');
  const c = await startConnect({ host: '127.0.0.1', port: g.port, servername: 'app.test', verify: trusting(new Set([sha(a.spki)])),
    authorization: 'Bearer owner', stateFile: state });
  t.after(c.stop);
  assert.equal(g.seen.app, 0, 'attestation alone sends no application request');
  const r = await get(c.url + '/echo?x=1', { method: 'POST', body: 'hi', headers: { origin: c.url, referer: c.url + '/page', 'x-forwarded-for': '6.6.6.6' } });
  assert.equal(r.status, 200);
  const echoed = JSON.parse(r.body);
  assert.equal(echoed.url, '/echo?x=1'); assert.equal(echoed.body, 'hi');
  assert.equal(echoed.headers.host, 'app.test', 'the front routes on the app name');
  assert.equal(echoed.headers.authorization, 'Bearer owner');
  assert.equal(echoed.headers.origin, `https://app.test:${g.port}`);
  assert.equal(echoed.headers.referer, `https://app.test:${g.port}/page`);
  assert.equal(echoed.headers['x-forwarded-for'], undefined);
  const s = JSON.parse(await fs.readFile(state, 'utf8'));
  assert.equal(s.url, c.url); assert.equal(s.spkiSha256, sha(a.spki)); assert.equal(s.measurement, 'ab'.repeat(48));
});

test('rewrites redirects and cookies scoped to the app name back to the loopback origin', async (t) => {
  const { a } = await setup(t), g = await fakeGuest(t, a);
  const c = await startConnect({ host: '127.0.0.1', port: g.port, servername: 'app.test', verify: trusting(new Set([sha(a.spki)])) });
  t.after(c.stop);
  const r = await get(c.url + '/redirect');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, c.url + '/next');
  // a redirect to anywhere else (here the app name on another port) is passed through untouched
  assert.equal((await get(c.url + '/redirect?to=' + encodeURIComponent('https://app.test/elsewhere'))).headers.location, 'https://app.test/elsewhere');
  assert.deepEqual(r.headers['set-cookie'], ['s=1; Path=/; HttpOnly']);
  assert.equal(r.headers['strict-transport-security'], undefined);
});

test('a refused verdict opens no local port and sends no application request', async (t) => {
  const { a } = await setup(t), g = await fakeGuest(t, a);
  await assert.rejects(startConnect({ host: '127.0.0.1', port: g.port, servername: 'app.test', verify: trusting(new Set()) }), /attestation refused: untrusted key/);
  assert.equal(g.seen.app, 0);
});

test('refuses foreign Host and Origin headers (DNS rebinding, cross-site requests)', async (t) => {
  const { a } = await setup(t), g = await fakeGuest(t, a);
  const c = await startConnect({ host: '127.0.0.1', port: g.port, servername: 'app.test', verify: trusting(new Set([sha(a.spki)])) });
  t.after(c.stop);
  assert.equal((await get(c.url + '/echo', { headers: { host: 'evil.test' } })).status, 403);
  assert.equal((await get(c.url + '/echo', { headers: { origin: 'http://evil.test' } })).status, 403);
  assert.equal(g.seen.app, 0);
});

test('a guest restart: a new key is attested before use; an unverifiable one gets nothing', async (t) => {
  const { a, b } = await setup(t), g = await fakeGuest(t, a), trusted = new Set([sha(a.spki)]);
  const c = await startConnect({ host: '127.0.0.1', port: g.port, servername: 'app.test', verify: trusting(trusted) });
  t.after(c.stop);
  assert.equal((await get(c.url + '/one')).status, 200);
  // the guest comes back on key B, which does not verify: 503, and the app sees nothing more
  g.server.rekey(b); g.server.closeAllConnections();
  const before = g.seen.app, refused = await get(c.url + '/two');
  assert.equal(refused.status, 503); assert.match(refused.body, /attestation refused/);
  assert.equal(g.seen.app, before);
  assert.ok(c.attestation() === null || c.attestation().pin.equals(a.spki), 'the pin never moved to an unverified key');
  // once key B verifies (a genuine restart), the pin moves and traffic flows again
  trusted.add(sha(b.spki));
  assert.equal((await get(c.url + '/three')).status, 200);
  assert.ok(c.attestation().pin.equals(b.spki));
});

test('WebSocket-style upgrades and TCP ports ride the pinned key', async (t) => {
  const { a } = await setup(t), g = await fakeGuest(t, a);
  const free = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const c = await startConnect({ host: '127.0.0.1', port: g.port, servername: 'app.test', verify: trusting(new Set([sha(a.spki)])), ports: `tcp:7000=${free}` });
  t.after(c.stop);
  // upgrade
  const u = new URL(c.url);
  const up = net.connect(+u.port, u.hostname);
  up.write(`GET /ws HTTP/1.1\r\nHost: ${u.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nping`);
  let got = '';
  await new Promise((resolve, reject) => { up.on('data', (d) => { got += d; if (got.endsWith('ping')) resolve(); }); up.on('error', reject); });
  assert.match(got, /^HTTP\/1\.1 101/); up.destroy();
  // tcp port through enclave-port/1
  const s = net.connect(free, '127.0.0.1');
  let back = '';
  s.on('data', (d) => { back += d; });
  s.end('hello tunnel');
  await new Promise((resolve, reject) => { s.on('end', resolve); s.on('error', reject); });
  assert.equal(back, 'hello tunnel');
});

test('guestVerifier refuses incomplete expectations up front', async () => {
  await assert.rejects(guestVerifier({ measurements: ['ab'.repeat(48)] }), /--unbound/);
  await assert.rejects(guestVerifier({ hostData: '0x' + '00'.repeat(32), measurements: ['ab'.repeat(48)] }), /all-zero/);
  await assert.rejects(guestVerifier({ hostData: '0x' + '11'.repeat(32), measurements: [] }), /measurement/);
  const v = await guestVerifier({ hostData: '0x' + '11'.repeat(32), measurements: ['ab'.repeat(48)] });
  assert.match((await v({ format: 'other' }, Buffer.alloc(1), Buffer.alloc(32))).reason, /AppID/);
  const vm = await guestVerifier({ unbound: true, measurements: ['ab'.repeat(48)] });
  assert.match((await vm({ format: 'sev-snp-vm-v1' }, Buffer.alloc(1), Buffer.alloc(32))).reason, /named deployment/);
});

test('composeVerifier: a Shield guest is refused unless --shield was asked for, and each format goes to its own verifier', async () => {
  const calls = [];
  const snp = async (doc) => { calls.push(['snp', doc.format]); return { ok: true }; };
  const shield = async (doc) => { calls.push(['shield', doc.format]); return { ok: true, limited: true }; };
  const refusesShield = composeVerifier({ snp });
  const r = await refusesShield({ format: SHIELD_FORMAT }, Buffer.alloc(1), Buffer.alloc(32));
  assert.equal(r.ok, false); assert.match(r.reason, /--shield/);
  const refusesSnp = composeVerifier({ shield });
  const s = await refusesSnp({ format: 'sev-snp-vm-v1' }, Buffer.alloc(1), Buffer.alloc(32));
  assert.equal(s.ok, false); assert.match(s.reason, /--expect/);
  const both = composeVerifier({ snp, shield });
  assert.equal((await both({ format: SHIELD_FORMAT }, Buffer.alloc(1), Buffer.alloc(32))).limited, true);
  await both({ format: 'sev-snp-guest-domain-v1' }, Buffer.alloc(1), Buffer.alloc(32));
  assert.deepEqual(calls, [['shield', SHIELD_FORMAT], ['snp', 'sev-snp-guest-domain-v1']], 'the refusals above called neither verifier');
});

test('shieldVerifier needs a host name and a full deployment id, and a host that does not verify opens nothing', async () => {
  const id = '0x' + 'f9'.repeat(32);
  assert.throws(() => shieldVerifier({ deployment: id }), /host name/);
  assert.throws(() => shieldVerifier({ name: 'nucbox-k11-4', deployment: '0xf9bb979a' }), /deployment id/);
  // the relay answers nothing usable for the host session: refused before any expectation is read or document judged
  const seen = [];
  const fetchImpl = async (url) => { seen.push(String(url)); return new Response(JSON.stringify({ error: 'nope' }), { status: 500, headers: { 'content-type': 'application/json' } }); };
  const v = shieldVerifier({ apiBase: 'https://api.invalid', name: 'nucbox-k11-4', deployment: id, fetchImpl });
  await assert.rejects(v({ format: SHIELD_FORMAT }, Buffer.alloc(1), Buffer.alloc(32)), /attestation refused: Shield host nucbox-k11-4/);
  assert.ok(seen.length > 0 && seen.every((u) => !u.includes('/apps/')), 'no app attestation is requested before the host verified');
});
