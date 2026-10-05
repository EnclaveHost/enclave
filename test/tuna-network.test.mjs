import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { TunaHost, clientHelloName } from '../network/tuna-host.mjs';
const { createTunaRoutes, validatePublication, tunaMessage }=await import(process.env.ENCLAVE_TEST_RELAY_BUNDLE||'../relay/tuna-routes.mjs');
import { localUpstream } from '../network/agent.mjs';
import { checkMap } from '../network/preflight.mjs';

const id = '0x' + 'ab'.repeat(32), owner = '0x' + '12'.repeat(20), endpoint = 'https://api.enclave.host/t/host';
const publication = now => ({ version: 1, endpoint, expiresAt: now + 60000, web: { address: '1.1.1.1', port: 443 }, raw: [] });

test('only the registered operator publishes; leases, expiry, replay and ambiguous labels fail closed', async () => {
  let now = 1000000, eligible = true;
  const routes = createTunaRoutes({ now: () => now, operatorOf: async () => owner, endpointId: async () => 'runner', eligible: () => eligible, recover: async (_, signature) => signature });
  const p = publication(now), row = { id, runner: 'runner', leaseUntil: (now + 120000) / 1000 };
  await assert.rejects(routes.publish(p, 'wrong'), /operator/);
  await routes.publish(p, owner);
  await assert.rejects(routes.publish(p, owner), /stale/);
  assert.equal((await routes.map([row])).labels.abababab.a, '1.1.1.1');
  assert.equal((await routes.map([{ ...row, runner: 'another-host' }])).labels.abababab, undefined);
  assert.equal((await routes.map([row, { ...row, id: '0xabababab' + 'cd'.repeat(28) }])).labels.abababab, undefined);
  eligible = false; assert.deepEqual((await routes.map([row])).labels, {}); eligible = true;
  now += 61000; assert.deepEqual((await routes.map([row])).labels, {});
  assert.match(tunaMessage(p), /^enclave-tuna-route:v1\n/);
});

test('published allocations cannot target private networks or make up standard HTTPS ports', () => {
  const now = Date.now();
  for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.1', '::1', 'fe80::1']) assert.throws(() => validatePublication({ ...publication(now), web: { address, port: 443 } }, now));
  assert.throws(() => validatePublication({ ...publication(now), web: { address: '1.1.1.1', port: 4443 } }, now));
  assert.throws(() => validatePublication({ ...publication(now), raw: [{ id, address: '1.1.1.1', tcp: [{ port: 22, publicPort: 0 }], udp: [] }] }, now));
  assert.equal(localUpstream('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  for (const address of ['http://example.com', 'http://127.0.0.1/admin', 'http://user@localhost']) assert.throws(() => localUpstream(address));
});

function fakeProcess() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.emit('exit', 0); };
  return child;
}

test('native TCP and UDP reach only the configured tenant port; removed allocations close connections', async t => {
  const tcp = net.createServer(s => s.pipe(s)); tcp.listen(0, '127.0.0.1'); await once(tcp, 'listening');
  const udp = dgram.createSocket('udp4'); udp.on('message', (b, p) => udp.send(b, p.port, p.address)); udp.bind(0, '127.0.0.1'); await once(udp, 'listening');
  let allowed = true;
  let rows = [{ id, status: 'running', public: true, tcp: [22], udp: [27015] }];
  const child = fakeProcess();
  const h = new TunaHost({ config: 'test-only', webPort: 0, isAllowed: () => allowed, deployments: () => rows, resolveName: () => null, serveHttps: s => s.destroy(),
    resolvePort: async (got, protocol, port) => { assert.equal(got, id); assert.equal(port, protocol === 'tcp' ? 22 : 27015); return protocol === 'tcp' ? tcp.address().port : udp.address().port; },
    spawnProcess: () => child, log: () => {} });
  t.after(() => { h.close(); tcp.close(); udp.close(); });
  await h.start(); const r = h.routes.get(id);
  assert.equal(h.accept({ type: 'ready', id, address: '1.1.1.1', tcp: [12345], udp: [] }), false);
  assert.equal(h.accept({ type: 'ready', id, address: '1.1.1.1', tcp: [12345], udp: [23456] }), true);
  assert.deepEqual(h.network(id).tcp.mappings, [{ port: 22, publicPort: 12345 }]);
  const socket = net.connect(r.tcp[0], '127.0.0.1'); await once(socket, 'connect');
  const received = once(socket, 'data'); socket.write('tenant TCP'); assert.equal((await received)[0].toString(), 'tenant TCP');
  const client = dgram.createSocket('udp4'); t.after(() => client.close());
  const datagram = once(client, 'message'); client.send(Buffer.from('tenant UDP'), r.udp[0], '127.0.0.1'); assert.equal((await datagram)[0].toString(), 'tenant UDP');
  const closed = once(socket, 'close'); allowed = false; await h.reconcile(); await closed;
  assert.equal(h.network(id).tcp, undefined); assert.equal(h.routes.has(id), false);
});

test('adapter failure immediately withdraws public allocations', () => {
  const h = new TunaHost({ config: 'test-only', deployments: () => [], spawnProcess: fakeProcess, log: () => {} });
  h.routes.set('web', { id: 'web', tcp: [443], udp: [] }); h.launch();
  assert.equal(h.accept({ id: 'web', address: '1.1.1.1', tcp: [443] }), true);
  assert.equal(h.status().ready, true); h.child.kill(); assert.equal(h.status().ready, false); h.close();
});

test('ClientHello parser waits for fragmented input and rejects malformed TLS', () => {
  assert.equal(clientHelloName(Buffer.from([22, 3])), null);
  assert.equal(clientHelloName(Buffer.from('GET / HTTP/1.1')), false);
  const malformed = Buffer.from([22, 3, 3, 0, 4, 1, 0, 0, 99]);
  assert.equal(clientHelloName(malformed), false);
});

test('cutover refuses unpublished hosts and missing required applications', async () => {
  const now = Date.now();
  const routes = createTunaRoutes({now: () => now, operatorOf: async () => owner, endpointId: async () => 'runner', eligible: () => true, recover: async () => owner});
  const rows = [{id, runner: 'runner', leaseUntil: (now + 120000) / 1000}];
  assert.throws(() => checkMap({transport:'tuna', deployments:{}}, [id]), /incomplete/);
  assert.throws(() => checkMap({transport:'tuna', pending:[], deployments:{}}), /no admitted/);
  assert.throws(() => checkMap({transport:'tuna', pending:[], deployments:{}}, [id]), /not admitted/);
  let map = await routes.map(rows);
  assert.deepEqual(map.pending, [{id, reason:'host_unpublished'}]);
  assert.throws(() => checkMap(map), /not ready/);
  await routes.publish({...publication(now), web:null}, 'signature');
  map = await routes.map(rows);
  assert.deepEqual(map.pending, [{id, reason:'https_unavailable'}]);
  await routes.publish({...publication(now), expiresAt:now+61000}, 'signature');
  map = await routes.map(rows);
  assert.equal(checkMap(map, [id], now).length, 1);
  assert.throws(() => checkMap(map, [id], now+60000), /expired/);
});

test('real TLS ClientHello reaches its admitted tenant and revocation closes the held connection', async t => {
  let allowed = true, arrived;
  const connected = new Promise(resolve => {arrived = resolve;});
  const h = new TunaHost({config:'test-only', webPort:0, deployments:()=>[], isAllowed:()=>allowed,
    resolveName:name => name === 'abababab.app.enclave.host' ? id : null,
    serveHttps:(socket, got) => { assert.equal(got,id); arrived(); }, spawnProcess:fakeProcess, log:()=>{}});
  t.after(()=>h.close()); await h.start();
  const client = tls.connect({host:'127.0.0.1', port:h.webPort, servername:'abababab.app.enclave.host'});
  client.on('error',()=>{}); t.after(()=>client.destroy());
  await connected;
  const closed = new Promise(resolve=>client.once('close',resolve));
  allowed = false; await h.reconcile(); await closed;
  assert.equal(client.destroyed,true);
});

test('public connection cap refuses excess idle clients without closing an existing connection', async t => {
  const h = new TunaHost({config:'test-only', webPort:0, maxConnections:1, deployments:()=>[],
    resolveName:()=>null, serveHttps:s=>s.destroy(), spawnProcess:fakeProcess, log:()=>{}});
  t.after(()=>h.close()); await h.start();
  const first=net.connect(h.webPort,'127.0.0.1'); t.after(()=>first.destroy()); await once(first,'connect');
  const second=net.connect(h.webPort,'127.0.0.1'); second.on('error',()=>{}); t.after(()=>second.destroy());
  await once(second,'close'); assert.equal(first.destroyed,false); assert.equal(h.connections.size,1);
});
