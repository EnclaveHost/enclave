// The host's ingress worker for its OWN service roles (network/host-service-ingress.mjs, work/host-service-transport-20261021):
// each derived name to its loopback role port, raw; everything else closed; no redirect, no TLS termination.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHostServiceIngress, serviceTable } from '../network/host-service-ingress.mjs';
import { hostServiceNames } from '../network/host-service-names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = '0x' + 'a1'.repeat(32), other = '0x' + 'b2'.repeat(32), ZONE = 'svc.example';
const names = hostServiceNames(host, ZONE), others = hostServiceNames(other, ZONE);
// a loopback "role": answers every connection with its tag and the first bytes it received (proves raw pass-through)
async function role(tag) {
  const seen = [];
  const s = net.createServer((c) => { c.once('data', (b) => { seen.push(b); c.end(`${tag}:${b.subarray(0, 512).toString('latin1')}`); }); c.on('error', () => {}); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, seen, close: () => s.close() };
}
const httpGet = (port, hostHeader) => new Promise((resolve) => {
  const c = net.connect({ host: '127.0.0.1', port }, () => c.write(`GET /v1/network/records HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`));
  let out = ''; c.on('data', (b) => { out += b; }); c.on('close', () => resolve(out)); c.on('error', () => resolve(out)); c.setTimeout(5000, () => c.destroy());
});
// a real ClientHello for `servername` (captured from node's TLS client), then sent on a plain socket: the answer bytes are raw
async function clientHello(servername) {
  let got;
  const cap = net.createServer((c) => c.once('data', (b) => { got(b); c.destroy(); }));
  await new Promise((r) => cap.listen(0, '127.0.0.1', r));
  const hello = new Promise((r) => { got = r; });
  const t = tls.connect({ host: '127.0.0.1', port: cap.address().port, servername, rejectUnauthorized: false }); t.on('error', () => {});
  const b = await hello; cap.close(); t.destroy(); return b;
}
const rawHello = async (port, servername) => {
  const hello = await clientHello(servername);
  return new Promise((resolve) => {
    const raw = net.connect({ host: '127.0.0.1', port }, () => raw.write(hello)); let out = Buffer.alloc(0);
    raw.on('data', (b) => { out = Buffer.concat([out, b]); }); raw.on('error', () => {}); raw.on('close', () => resolve(out.toString('latin1')));
    raw.setTimeout(5000, () => raw.destroy());
  });
};

test('each derived name reaches its loopback role, raw: HTTP by Host (no redirect), TLS by SNI only where a TLS port exists', async () => {
  const dir = await role('directory'), boot = await role('bootstrap'), dirTls = await role('directory-tls');
  const ing = await createHostServiceIngress({ names: { [names['directory-replica']]: { http: dir.port, tls: dirTls.port }, [names['bootstrap-replica']]: { http: boot.port, tls: null } } });
  try {
    const a = await httpGet(ing.httpPort, names['directory-replica']);
    assert.match(a, /^directory:GET \/v1\/network\/records HTTP\/1\.1\r\nHost: dir-/, 'the request reached the role byte for byte');
    assert.ok(!/301|302|Location:/i.test(a), 'no redirect');
    assert.match(await httpGet(ing.httpPort, `${names['bootstrap-replica']}:80`), /^bootstrap:GET/);
    assert.match(await httpGet(ing.httpPort, names['bootstrap-replica'].toUpperCase()), /^bootstrap:GET/, 'Host is case-insensitive');
    for (const n of [others['directory-replica'], names['policy-mirror'], 'abababab.app.example', 'unknown.example', ''])
      assert.equal(await httpGet(ing.httpPort, n), '', `${n || '(no host)'} is closed`);
    // 443: SNI of a role with a TLS port -> its TLS port, the ClientHello untouched (no termination here)
    const t = await rawHello(ing.tlsPort, names['directory-replica']);
    assert.match(t, /^directory-tls:\x16\x03/, 'the role got the raw ClientHello');
    assert.ok(dirTls.seen[0].includes(Buffer.from(names['directory-replica'])), 'with the SNI inside');
    assert.equal(await rawHello(ing.tlsPort, names['bootstrap-replica']), '', 'a role without a TLS port is closed on 443');
    assert.equal(await rawHello(ing.tlsPort, others['directory-replica']), '', 'another host\'s name is closed on 443');
    assert.equal(dir.seen.length, 1); assert.equal(boot.seen.length, 2);
  } finally { ing.close(); dir.close(); boot.close(); dirTls.close(); }
});

test('the table takes only host-service names to loopback ports', () => {
  assert.throws(() => serviceTable({ 'abababab.app.example': { http: 1 } }), /not a host service name/);
  assert.throws(() => serviceTable({ 'www.example.org': { http: 1 } }), /not a host service name/);
  assert.throws(() => serviceTable({ [names['directory-replica'].toUpperCase()]: { http: 1 } }), /not a host service name/);
  assert.throws(() => serviceTable({ [names['directory-replica']]: { http: 0 } }), /port/);
  assert.throws(() => serviceTable({ [names['directory-replica']]: { http: 80, host: '10.0.0.1' } }), /\{http, tls\?\}/, 'no target host can be configured');
  assert.throws(() => serviceTable({}), /1 to 8/);
  assert.equal(serviceTable({ [names['policy-mirror']]: { http: 18190 } }).get(names['policy-mirror']).host, '127.0.0.1');
});

test('as the circuit worker: prints the ready line the runtime waits for, and stops on {"type":"stop"}', async () => {
  const dir = await role('directory'), d = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-ingress-'));
  const free = async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
  const tlsPort = await free(), httpPort = await free();
  fs.writeFileSync(path.join(d, 'worker.json'), JSON.stringify({ names: { [names['directory-replica']]: { http: dir.port, tls: null } }, tlsPort, httpPort }));
  const child = spawn(process.execPath, [path.join(ROOT, 'network/host-service-ingress.mjs'), path.join(d, 'worker.json')], { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const ready = await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('no ready line')), 10000);
      createInterface({ input: child.stdout }).once('line', (l) => { clearTimeout(t); resolve(JSON.parse(l)); }); });
    assert.deepEqual(ready, { type: 'ready', ingress: tlsPort, redirect: httpPort });
    assert.match(await httpGet(httpPort, names['directory-replica']), /^directory:GET/);
    child.stdin.write(JSON.stringify({ type: 'admission', expiresAt: Date.now() + 60000 }) + '\n');   // the runtime's admit(): ignored
    assert.match(await httpGet(httpPort, names['directory-replica']), /^directory:GET/);
    const exited = new Promise((r) => child.once('exit', r));
    child.stdin.write('{"type":"stop"}\n');
    assert.equal(await exited, 0);
  } finally { child.kill(); dir.close(); fs.rmSync(d, { recursive: true, force: true }); }
});
