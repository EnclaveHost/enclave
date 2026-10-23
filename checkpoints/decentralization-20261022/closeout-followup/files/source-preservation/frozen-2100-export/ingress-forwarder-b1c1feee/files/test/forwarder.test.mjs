// Real HTTP: a raw-socket client -> the forwarder -> a guest-like custodian upstream that dispatches with WHATWG URL
// resolution (as custody/v2/http.mjs), so any target that would resolve to a private route is caught by the upstream's
// hit log, not just by a status code.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { F, PREFIX, fakeCustodian, forwarder, raw, request, headersOf } from './helpers.mjs';

const ROUTES = [...F.ROUTES];
let up, fw;
test.beforeEach(async () => { up = await fakeCustodian(); fw = await forwarder(up.port); });
test.afterEach(async () => { await fw.close(); await up.close(); });

test('every allowlisted route is forwarded with its own method, exact path, the body, and no client headers', async () => {
  for (const [route, method] of ROUTES) {
    up.hits.length = 0;
    const body = method === 'POST' ? JSON.stringify({ nonce: 'ab'.repeat(16) }) : null;
    const r = await request(fw.port, method, PREFIX + route, body, {
      'x-forwarded-for': '6.6.6.6', forwarded: 'for=6.6.6.6', 'x-real-ip': '6.6.6.6', cookie: 'sid=1', authorization: 'Bearer z',
      'x-forwarded-host': 'evil', 'x-custom': '1', 'content-type': 'text/plain' });
    assert.equal(r.status, 200, `${method} ${route}: ${r.text}`);
    assert.equal(up.hits.length, 1);
    const h = up.hits[0];
    assert.equal(h.method, method); assert.equal(h.raw, route); assert.equal(h.pathname, route);
    assert.equal(h.body, body ?? '');
    assert.deepEqual(Object.keys(h.headers).sort(), (method === 'POST' ? ['accept', 'connection', 'content-length', 'content-type', 'host'] : ['accept', 'connection', 'host']));
    assert.equal(h.headers.host, `127.0.0.1:${up.port}`);
    if (method === 'POST') assert.equal(h.headers['content-type'], 'application/json');
    const rh = headersOf(r.head);
    assert.deepEqual(Object.keys(rh).sort(), ['cache-control', 'connection', 'content-length', 'content-type', 'x-content-type-options']);
    assert.equal(JSON.parse(r.body).route, route);
  }
});

// every way to spell a private route, or a public one ambiguously, under or around the prefix
function adversarialTargets() {
  const out = new Set();
  const P = PREFIX;
  for (const priv of ['/v2/custody/host-binding', '/health', '/', '', '/state', '/submit', '/v2/custody/host-binding/']) {
    out.add(P + priv); out.add(priv || '/');
  }
  const hb = 'host-binding';
  const encodings = [
    '/v2/custody/challenge/../host-binding', '/v2/custody/challenge/%2e%2e/host-binding', '/v2/custody/challenge/%2E%2E/host-binding',
    '/v2/custody/challenge/.%2e/host-binding', '/v2/custody/challenge/%2e./host-binding', '/v2/custody/./host-binding',
    '/v2/custody/%2e/host-binding', '/v2/custody%2fhost-binding', '/v2/custody%2Fhost-binding', '/v2/custody/%68ost-binding',
    '/v2/custody/host%2dbinding', '/v2/custody/%252e%252e/host-binding', '/v2/custody/info/..%2fhost-binding',
    '/v2/custody/info/..\\host-binding', '/v2\\custody\\host-binding', '/v2/custody/info\\..\\host-binding',
    '/v2/custody//host-binding', '//v2/custody/host-binding', '/v2/custody/host-binding;x', '/v2/custody/host-binding?x',
    '/v2/custody/host-binding#x', '/v2/custody/HOST-BINDING', '/V2/custody/host-binding', '/v2/custody/host-binding%00',
    '/v2/custody/host-binding.', '/v2/custody/host-binding%20', '/v2/custody/info/../../health', '/v2/custody/info/%2e%2e/%2e%2e/health',
    '/v2/custody/%E2%80%AEhost-binding', '/v2/custody/ｈost-binding'.replace('ｈ', '%EF%BD%88'),
  ];
  for (const e of encodings) { out.add(P + e); out.add(e); }
  for (const [route] of ROUTES) {
    out.add(route);                                   // without the prefix
    out.add(P + route + '/'); out.add(P + route + '?a=1'); out.add(P + route + ';a'); out.add(P + route + '%2f');
    out.add(P + route.toUpperCase()); out.add(P.toUpperCase() + route); out.add(P + '/' + route); out.add(P + route.replace(/\//g, '%2F'));
    out.add(P + route.replace('/custody/', '/custody/./')); out.add(P + route.replace('/custody/', '/x/../custody/'));
    out.add(P + 'x' + route); out.add(P + '/..' + P + route); out.add('/custody-v2-canary/./metal0' + route); out.add(P + route + '/..');
    out.add(`http://127.0.0.1:1${P}${route}`);       // absolute-form
    out.add(P + route.slice(0, -1));                  // a truncated route
    // percent-encoded spellings of the PUBLIC route itself (a decoding forwarder would accept them): fail closed
    out.add(P + route.replace(/\/(?=[^/]*$)/, '%2F')); out.add(P + route.replace(/\/(?=[^/]*$)/, '%2f'));
    out.add(P + route.replace(/[a-z]$/, (ch) => '%' + ch.charCodeAt(0).toString(16)));
    out.add(P + route.replace(/[a-z]$/, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase()));
    out.add(P + route.replace('/v2/', '/%76%32/')); out.add(P.replace('metal0', 'metal%30') + route);
  }
  out.add(P); out.add(P + '/'); out.add('*'); out.add(P + '/v2/custody'); out.add(P + '/v2/custody/');
  return [...out];
}

test('private routes, every encoding and every ambiguous spelling fail closed and never reach the upstream', async () => {
  const targets = adversarialTargets();
  assert.ok(targets.length > 250, String(targets.length));
  // the hazard this guards against is real: the guest would resolve these to the private route
  assert.equal(new URL('/v2/custody/challenge/%2e%2e/host-binding', 'http://x').pathname, '/v2/custody/host-binding');
  assert.equal(new URL('/v2/custody/info/..\\host-binding', 'http://x').pathname, '/v2/custody/host-binding');
  for (const t of targets) for (const m of ['GET', 'POST']) {
    const r = await request(fw.port, m, t, m === 'POST' ? '{}' : null);
    assert.ok([400, 404].includes(r.status), `${m} ${JSON.stringify(t)} -> ${r.status} ${r.text.slice(0, 120)}`);
  }
  assert.deepEqual(up.hits, []);
});

test('unknown or wrong methods, CONNECT and Upgrade never reach the upstream', async () => {
  const info = PREFIX + '/v2/custody/info', ch = PREFIX + '/v2/custody/challenge';
  for (const m of ['HEAD', 'OPTIONS', 'PUT', 'DELETE', 'PATCH', 'TRACE', 'PROPFIND', 'MKCOL', 'PURGE']) for (const t of [info, ch]) {
    const r = await request(fw.port, m, t, m === 'PUT' || m === 'PATCH' ? '{}' : null);
    assert.ok([400, 404].includes(r.status) || (m === 'HEAD' && r.status === 404), `${m} ${t} -> ${r.status}`);
  }
  assert.equal((await request(fw.port, 'POST', info, '{}')).status, 404);
  assert.equal((await request(fw.port, 'GET', ch)).status, 404);
  assert.ok([0, 400].includes((await raw(fw.port, `post ${ch} HTTP/1.1\r\nhost: x\r\ncontent-length: 2\r\n\r\n{}`)).status));
  const c = await raw(fw.port, `CONNECT 127.0.0.1:${up.port} HTTP/1.1\r\nhost: 127.0.0.1:${up.port}\r\n\r\n`);
  assert.ok(c.closed && c.status !== 200, c.text);
  const u = await raw(fw.port, `GET ${info} HTTP/1.1\r\nhost: x\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n`);
  assert.ok(u.closed && u.status !== 200, u.text);
  assert.deepEqual(up.hits, []);
});

test('request limits: declared and streamed size, GET bodies, conflicting framing, slow bodies and slow headers', async () => {
  const ch = PREFIX + '/v2/custody/challenge';
  assert.equal((await raw(fw.port, `POST ${ch} HTTP/1.1\r\nhost: x\r\ncontent-length: 4097\r\n\r\n`)).status, 413);
  assert.equal((await raw(fw.port, `POST ${ch} HTTP/1.1\r\nhost: x\r\ncontent-length: 99999999999999999\r\n\r\n`)).status, 413);
  const big = 'a'.repeat(5000);
  assert.equal((await raw(fw.port, `POST ${ch} HTTP/1.1\r\nhost: x\r\ntransfer-encoding: chunked\r\n\r\n${big.length.toString(16)}\r\n${big}\r\n0\r\n\r\n`)).status, 413);
  assert.equal((await request(fw.port, 'GET', PREFIX + '/v2/custody/info', '{}')).status, 400);
  assert.equal((await raw(fw.port, `GET ${PREFIX}/v2/custody/info HTTP/1.1\r\nhost: x\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n`)).status, 400);
  assert.equal((await raw(fw.port, `POST ${ch} HTTP/1.1\r\nhost: x\r\ncontent-length: 2\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n`)).status, 400);
  assert.equal((await raw(fw.port, `POST ${ch} HTTP/1.1\r\nhost: x\r\ncontent-length: 2\r\ncontent-length: 3\r\n\r\n{}`)).status, 400);
  assert.equal((await raw(fw.port, `GET ${PREFIX}/v2/custody/info HTTP/1.1\r\nhost: x\r\nx-big: ${'b'.repeat(9000)}\r\n\r\n`)).status, 431);
  // a body that completes only after bodyTimeoutMs (400 ms) but well before Node's requestTimeout (1500 ms): only the
  // forwarder's own body deadline can refuse it, and it must do so near 400 ms, not when the body finally arrives
  const s0 = Date.now();
  const slow = await raw(fw.port, null, { writes: [[0, `POST ${ch} HTTP/1.1\r\nhost: x\r\ncontent-length: 2\r\n\r\n{`], [900, '}']], ms: 2500 });
  assert.equal(slow.status, 408, slow.text);
  assert.ok(Date.now() - s0 < 1400);
  assert.match(slow.text, /"error":"timeout"/);
  // headers that never finish: the server's headersTimeout (400 ms) closes the connection
  const t0 = Date.now();
  const hs = await raw(fw.port, null, { writes: [[0, `GET ${PREFIX}/v2/custody/info HTTP/1.1\r\nhost: x\r\n`]], ms: 3000 });
  assert.ok(hs.closed && [0, 408].includes(hs.status) && Date.now() - t0 < 2500, `${hs.status} ${Date.now() - t0}`);
  assert.deepEqual(up.hits, []);
  // exactly the cap passes, and Expect: 100-continue is answered only for an acceptable request
  const ok = JSON.stringify({ pad: 'x'.repeat(4096 - 10) });
  assert.equal(Buffer.byteLength(ok), 4096);
  assert.equal((await request(fw.port, 'POST', ch, ok)).status, 200);
  assert.equal(up.hits.length, 1);
  const e1 = await raw(fw.port, `POST ${ch} HTTP/1.1\r\nhost: x\r\nexpect: 100-continue\r\ncontent-length: 5000\r\n\r\n`);
  assert.equal(e1.status, 413);
  assert.doesNotMatch(e1.text, /100 Continue/);
  const e2 = await raw(fw.port, null, { writes: [[0, `POST ${ch} HTTP/1.1\r\nhost: x\r\nexpect: 100-continue\r\ncontent-length: 2\r\n\r\n`], [150, '{}']] });
  assert.match(e2.text, /^HTTP\/1\.1 100 Continue/);
  assert.match(e2.text, /HTTP\/1\.1 200/);
  assert.equal(up.hits.length, 2);
});

test('upstream failures: refused, hung, redirect, non-JSON, oversize, slow and truncated responses', async () => {
  const info = PREFIX + '/v2/custody/info';
  const cases = [
    ['redirect', (q, s) => { s.writeHead(302, { location: 'http://evil/', 'content-type': 'application/json', 'content-length': 2 }); s.end('{}'); }, 502],
    ['html', (q, s) => { s.writeHead(200, { 'content-type': 'text/html', 'content-length': 2 }); s.end('<>'); }, 502],
    ['no type', (q, s) => { s.writeHead(200, { 'content-length': 2 }); s.end('{}'); }, 502],
    ['declared big', (q, s) => { s.writeHead(200, { 'content-type': 'application/json', 'content-length': 9000 }); s.end('x'.repeat(9000)); }, 502],
    ['streamed big', (q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.write('x'.repeat(5000)); s.end('x'.repeat(5000)); }, 502],
    ['hang', () => {}, 504],
    ['slow body', (q, s) => { s.writeHead(200, { 'content-type': 'application/json' }); s.write('{'); setTimeout(() => s.end('}'), 1500); }, 504],
    ['truncated', (q, s) => { s.writeHead(200, { 'content-type': 'application/json', 'content-length': 100 }); s.write('{"a":'); setTimeout(() => s.destroy(), 50); }, 502],
    ['reset', (q, s) => { s.socket.destroy(); }, 502],
    ['1xx then 200', (q, s) => { s.writeProcessing?.(); s.writeHead(200, { 'content-type': 'application/json', 'content-length': 2 }); s.end('{}'); }, 200],
    ['429 passthrough', (q, s) => { s.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7', 'content-length': 2 }); s.end('{}'); }, 429],
    ['422 passthrough', (q, s) => { s.writeHead(422, { 'content-type': 'application/json; charset=utf-8', 'content-length': 2 }); s.end('{}'); }, 422],
  ];
  for (const [name, b, want] of cases) {
    up.behavior = b;
    const t0 = Date.now();
    const r = await request(fw.port, 'GET', info);
    assert.equal(r.status, want, `${name}: ${r.text.slice(0, 200)}`);
    assert.ok(Date.now() - t0 < 1400, `${name} took ${Date.now() - t0} ms (deadline 600)`);
    const h = headersOf(r.head);
    assert.equal(h.location, undefined); assert.equal(h['set-cookie'], undefined);
    if (name === '429 passthrough') assert.equal(h['retry-after'], '7');
  }
  // nothing listening on the upstream port
  const port = up.port; await up.close();
  const fw2 = await forwarder(port);
  try { assert.equal((await request(fw2.port, 'GET', info)).status, 502); } finally { await fw2.close(); }
  up = await fakeCustodian();
});

test('a client that goes away aborts the upstream request', async () => {
  up.behavior = () => {};   // hang
  await raw(fw.port, `POST ${PREFIX}/v2/custody/release HTTP/1.1\r\nhost: x\r\ncontent-length: 2\r\n\r\n{}`, { ms: 150 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(up.hits.length, 1);
  assert.equal(up.closed, 1, 'upstream request was not aborted after the client left');
  assert.equal(fw.f.stats.inFlight, 0);
});

test('a client gone after its body completed but before upstream creation never starts upstream work (ROOT-FOLLOWUP)', async () => {
  // afterBody (a test seam) runs in exactly that window and makes the client go away. res.destroy() emits 'close' on a later
  // tick, so the abort controller is NOT yet aborted when the forwarder continues: only a check of the state itself catches
  // it. The upstream must see no request AND no TCP connection.
  for (const [route, method] of [['/v2/custody/release', 'POST'], ['/v2/custody/info', 'GET']]) {
    await fw.close();
    const gone = [];
    fw = await forwarder(up.port, {}, { afterBody: (req, res) => { res.destroy(); req.socket.destroy(); }, log: (e) => gone.push(e.reason) });
    up.hits.length = 0; up.connections = 0;
    const r = await request(fw.port, method, PREFIX + route, method === 'POST' ? '{}' : null);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(r.status, 0, r.text);
    assert.deepEqual(up.hits, []);
    assert.equal(up.connections, 0, `${method} ${route}: an upstream connection was opened for a client that had gone`);
    assert.deepEqual(gone, ['client_gone']);
    assert.equal(fw.f.stats.inFlight, 0);
    assert.equal(fw.f.stats.forwarded, 0);
  }
  // control: the same forwarder without the seam forwards normally (the seam, not the route, made the client go away)
  await fw.close(); fw = await forwarder(up.port);
  assert.equal((await request(fw.port, 'POST', PREFIX + '/v2/custody/release', '{}')).status, 200);
  assert.equal(up.connections, 1);
});

test('in-flight limit: excess requests get 503 without reaching the upstream', async () => {
  await fw.close();
  fw = await forwarder(up.port, { maxInFlight: 2, upstreamTimeoutMs: 1500 });
  up.behavior = (q, s) => setTimeout(() => { s.writeHead(200, { 'content-type': 'application/json', 'content-length': 2 }); s.end('{}'); }, 500);
  const info = PREFIX + '/v2/custody/info';
  const first = [request(fw.port, 'GET', info), request(fw.port, 'GET', info)];
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await request(fw.port, 'GET', info)).status, 503);
  assert.deepEqual((await Promise.all(first)).map((r) => r.status), [200, 200]);
  assert.equal(up.hits.length, 2);
});

test('the module never opens a listener outside loopback and only ever connects to the fixed upstream port', async () => {
  const seen = [];
  const orig = http.request;
  http.request = function (opts, ...rest) { seen.push(`${opts.host}:${opts.port}`); return orig.call(this, opts, ...rest); };
  try { await request(fw.port, 'GET', `${PREFIX}/v2/custody/info`, null, { host: 'evil.example:1' }); } finally { http.request = orig; }
  assert.deepEqual(seen, [`127.0.0.1:${up.port}`]);
  assert.equal(fw.f.server.address().address, '127.0.0.1');
});
