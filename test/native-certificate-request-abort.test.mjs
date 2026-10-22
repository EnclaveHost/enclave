// The pinned HTTP-over-TLS request of metal/guest/native-certificate.mjs (pinnedRequest / untrustedRead / installNativeCertificate)
// against REAL local TLS servers (disposable test keys made here; loopback only) that misbehave at each point of the exchange.
// Every case must SETTLE its promise within a bound, and the client's socket must actually close (observed on the server).
//   * partial Content-Length then the peer disconnects -> rejects
//   * an answer larger than maxBytes -> rejects
//   * a trickling answer (never idle long enough for a socket idle timeout) -> rejects within the total deadline
//   * an abort that lands between the TLS handshake and the HTTP request -> rejects and NO request byte reaches the peer
//   * an abort during the answer -> rejects, socket closed
//   * a complete answer is preserved exactly; the pin still refuses a wrong key before any byte
//   * a cancellation after the promise settled raises nothing (no unhandled rejection, no uncaught exception)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash } from 'node:crypto';
import { pinnedRequest, untrustedRead, installNativeCertificate } from '../metal/guest/native-certificate.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-req-abort-'));
const servers = [];
after(() => { for (const s of servers) { for (const c of s.conns) c.destroy(); s.server.close(); } fs.rmSync(tmp, { recursive: true, force: true }); });
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e?.message || e)));
process.on('uncaughtException', (e) => unhandled.push('uncaught: ' + String(e?.message || e)));

// a disposable P-256 key + self-signed certificate (test only)
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '1',
  '-subj', '/CN=native-request-abort test'], { cwd: tmp, stdio: 'ignore' });
const KEY = fs.readFileSync(path.join(tmp, 'k.pem')), CERT = fs.readFileSync(path.join(tmp, 'c.pem'));
const SPKI = createHash('sha256').update(new X509Certificate(CERT).publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A TLS server whose `behave(sock, firstData)` decides the answer. Records every connection: bytes after the handshake, close time. */
function server(behave) {
  const conns = [], rec = [], tcp = [];
  const s = tls.createServer({ key: KEY, cert: CERT, minVersion: 'TLSv1.2' }, (sock) => {
    const r = { bytes: 0, closedAt: null, opened: Date.now() }; rec.push(r); conns.push(sock);
    sock.on('close', () => { r.closedAt = Date.now(); }); sock.on('error', () => {});
    let started = false;
    sock.on('data', (d) => { r.bytes += d.length; if (!started && d.includes('\r\n\r\n')) { started = true; behave(sock, r); } });
  });
  // every TCP connection (also one dropped before the TLS handshake finished on this side): its actual close
  s.on('connection', (raw) => { const r = { closedAt: null }; tcp.push(r); conns.push(raw); raw.on('close', () => { r.closedAt = Date.now(); }); });
  const o = { server: s, conns, rec, tcp };
  servers.push(o);
  return new Promise((res) => s.listen(0, '127.0.0.1', () => { o.url = `https://127.0.0.1:${s.address().port}`; res(o); }));
}
/** settles within ms, or reports it is still pending (the bug) */
async function settleWithin(p, ms) {
  let t; const pending = new Promise((r) => { t = setTimeout(() => r({ pending: true }), ms); });
  const out = await Promise.race([p.then((v) => ({ value: v }), (e) => ({ error: e })), pending]); clearTimeout(t); return out;
}
async function closedWithin(o, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (o.tcp.length && o.tcp.every((r) => r.closedAt)) return true; await wait(20); } return false; }
/** HTTP bytes the peer received on established TLS connections (none established = none received) */
const httpBytes = (o) => o.rec.reduce((n, r) => n + r.bytes, 0);

test('partial Content-Length, then the peer disconnects: the request rejects and the socket is closed', { timeout: 15000 }, async () => {
  const o = await server((sock) => { sock.write('HTTP/1.1 200 OK\r\ncontent-length: 1000\r\n\r\n' + 'x'.repeat(10)); setTimeout(() => sock.destroy(), 50); });
  const r = await settleWithin(pinnedRequest(o.url, { path: '/x', spkiSha256: SPKI, timeoutMs: 5000 }), 3000);
  assert.ok(!r.pending, 'the promise settled (it was left pending)');
  assert.ok(r.error, 'a cut-off answer is an error, never a value');
  assert.ok(await closedWithin(o, 2000), 'the connection is closed');
});

test('an answer larger than maxBytes rejects and the socket is closed', { timeout: 15000 }, async () => {
  const o = await server((sock) => { sock.write('HTTP/1.1 200 OK\r\ncontent-length: 200000\r\n\r\n'); sock.write(Buffer.alloc(200000, 0x61)); });
  const r = await settleWithin(pinnedRequest(o.url, { path: '/big', spkiSha256: SPKI, timeoutMs: 5000, maxBytes: 4096 }), 3000);
  assert.ok(!r.pending, 'the promise settled'); assert.ok(r.error, 'rejected'); assert.match(String(r.error.message), /too large/);
  assert.ok(await closedWithin(o, 2000), 'the connection is closed');
});

test('a trickling answer is bounded by ONE total deadline (no socket idle timeout ever fires)', { timeout: 15000 }, async () => {
  let t;
  const o = await server((sock) => { sock.write('HTTP/1.1 200 OK\r\ncontent-length: 100000\r\n\r\n'); t = setInterval(() => { if (!sock.destroyed) sock.write('y'); }, 100); sock.on('close', () => clearInterval(t)); });
  const t0 = Date.now();
  const r = await settleWithin(pinnedRequest(o.url, { path: '/slow', spkiSha256: SPKI, timeoutMs: 800 }), 4000);
  clearInterval(t);
  assert.ok(!r.pending, 'the promise settled within 4 s although the peer never went idle'); assert.ok(r.error, 'rejected');
  assert.ok(Date.now() - t0 < 2500, `settled near the 800 ms deadline (${Date.now() - t0} ms)`);
  assert.ok(await closedWithin(o, 2000), 'the connection is closed');
});

test('an abort between the handshake and the HTTP request: rejects, and NO request byte (no install body) reaches the peer', { timeout: 15000 }, async () => {
  const o = await server((sock) => { sock.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'); });
  const ac = new AbortController(), sig = ac.signal, rm = sig.removeEventListener.bind(sig);
  // the moment the TLS step releases its abort listener (secureConnect, pin checked) the caller aborts: nobody is listening
  let fired = false;
  sig.removeEventListener = (type, fn, opts) => { rm(type, fn, opts); if (type === 'abort' && !fired) { fired = true; ac.abort(); } };
  const r = await settleWithin(installNativeCertificate({ controlUrl: o.url, chainPem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n', spkiSha256: SPKI, timeoutMs: 3000, signal: sig }), 3000);
  assert.ok(fired, 'the abort was injected in the window');
  assert.ok(!r.pending, 'the promise settled'); assert.ok(r.error, 'an aborted install is an error'); assert.match(String(r.error.message), /abort/i);
  assert.ok(await closedWithin(o, 2000), 'the connection is closed');
  assert.equal(httpBytes(o), 0, 'no HTTP byte (method, path, body) reached the peer after the abort');
});

test('an abort during the answer rejects promptly and closes the socket', { timeout: 15000 }, async () => {
  const o = await server((sock) => { sock.write('HTTP/1.1 200 OK\r\ncontent-length: 50\r\n\r\npart'); });
  const ac = new AbortController();
  const p = pinnedRequest(o.url, { path: '/stall', spkiSha256: SPKI, timeoutMs: 5000, signal: ac.signal });
  setTimeout(() => ac.abort(), 300);
  const r = await settleWithin(p, 2500);
  assert.ok(!r.pending, 'the promise settled'); assert.ok(r.error, 'rejected');
  assert.ok(await closedWithin(o, 2000), 'the connection is closed');
});

test('a complete answer is preserved exactly (pinned and untrusted reads), and the socket is released', { timeout: 15000 }, async () => {
  const body = 'native ' + 'z'.repeat(3000) + ' end';
  const o = await server((sock) => { sock.write(`HTTP/1.1 201 Created\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n`); sock.write(body.slice(0, 100)); setTimeout(() => sock.end(body.slice(100)), 100); });
  const v = await pinnedRequest(o.url, { path: '/ok', spkiSha256: SPKI, timeoutMs: 3000 });
  assert.deepEqual({ status: v.status, body: v.body, peer: v.peerSpkiSha256 }, { status: 201, body, peer: SPKI });
  const u = await untrustedRead(o.url, '/ok', { timeoutMs: 3000 });
  assert.equal(u.body, body); assert.equal(u.peerSpkiSha256, SPKI);
  assert.ok(await closedWithin(o, 2000), 'both connections are closed');
});

test('the pin still refuses a wrong key before any byte', { timeout: 15000 }, async () => {
  const o = await server((sock) => { sock.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'); });
  await assert.rejects(installNativeCertificate({ controlUrl: o.url, chainPem: 'x', spkiSha256: 'ab'.repeat(32), timeoutMs: 3000 }), /not the attested key/);
  assert.ok(await closedWithin(o, 2000), 'the connection is closed'); assert.equal(httpBytes(o), 0, 'nothing was sent to the wrong key');
});

test('a cancellation after the promise settled raises nothing (no unhandled rejection or uncaught exception)', { timeout: 15000 }, async () => {
  const ok = await server((sock) => { sock.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'); });
  const cut = await server((sock) => { sock.write('HTTP/1.1 200 OK\r\ncontent-length: 9\r\n\r\nab'); setTimeout(() => sock.destroy(), 30); });
  const a1 = new AbortController(), a2 = new AbortController();
  const v = await pinnedRequest(ok.url, { path: '/', spkiSha256: SPKI, timeoutMs: 3000, signal: a1.signal });
  assert.equal(v.body, 'ok');
  const r = await settleWithin(pinnedRequest(cut.url, { path: '/', spkiSha256: SPKI, timeoutMs: 3000, signal: a2.signal }), 3000);
  assert.ok(!r.pending && r.error, 'the cut answer rejected');
  a1.abort(); a2.abort();
  await wait(300);
  assert.deepEqual(unhandled, [], 'no unhandled rejection or uncaught exception anywhere in this file');
});
