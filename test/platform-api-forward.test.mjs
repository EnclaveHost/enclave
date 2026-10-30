// A standby's forwarding to the primary (metal/guest/platform-api-role.mjs): the primary's attested control key is checked on
// the secure socket BEFORE any request byte is written, then the original method, path, headers, body and streamed response
// pass through. What runs here:
//   * three REAL roles (startRole) of one group, each behind a REAL control front (createControlFront with the platform API
//     host and prefix routes) whose SNI map also holds the group's WebPKI key for the API hostname - so a forward that sent
//     that hostname as SNI would meet the WebPKI key, not the attested one;
//   * the members replicate and elect over the REAL peer protocol through the fronts; the primary's relay child is a small
//     recording stand-in (relayArgv), because what is tested is the role's forwarding, not the relay;
//   * the state key K is written to each member's RAM-fs key file before start (the role's own restart path), instead of
//     the admin genesis and verified handoff, which test/platform-api-hosted.test.mjs covers;
//   * real TLS throughout: an impostor with a self-signed WRONG key on the primary's control address, and a silent peer.
// Nothing leaves 127.0.0.1; every key is disposable.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import * as MC from '../metal/guest/measured-control.mjs';
import { startRole } from '../metal/guest/platform-api-role.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-api-forward-'));
const servers = new Set(), sockets = new Set();
let roles = [];
const track = (s) => { servers.add(s); s.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)); }); return s; };
after(async () => { for (const r of roles) { try { await r.stop(); } catch {} } for (const c of sockets) c.destroy(); for (const s of servers) { try { s.close(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true }); });
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (what, fn, ms = 30000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(100); } throw new Error(`timed out waiting for ${what} (${String(last).slice(0, 200)})`); };
const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const HOSTNAME = 'api.forward.test', N = 3, K = randomBytes(32).toString('hex');
const STUB_LOG = path.join(tmp, 'stub.log');
const AUTH = 'Bearer canary-auth-' + randomBytes(6).toString('hex'), BODY = 'canary-body-' + randomBytes(6).toString('hex');
// the primary's relay child stand-in: records each request it receives (one JSON line), answers, streams, or holds
const STUB = path.join(tmp, 'stub-relay.mjs');
fs.writeFileSync(STUB, `import http from 'node:http'; import fs from 'node:fs';
const log = (o) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ pid: process.pid, ...o }) + '\\n');
const s = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d));
  if (req.url.startsWith('/hang')) { log({ t: 'request', url: req.url }); req.on('close', () => log({ t: 'closed', url: req.url })); return; }
  req.on('end', () => {
    log({ t: 'request', method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(c).toString() });
    if (req.url.startsWith('/stream')) { res.writeHead(207, { 'content-type': 'text/plain', 'x-stub': 'stream' }); let i = 0;
      const tick = () => { res.write('chunk' + i + '\\n'); if (++i < 3) setTimeout(tick, 300); else res.end('end\\n'); }; tick(); return; }
    res.writeHead(201, { 'content-type': 'application/json', 'x-stub': 'echo' }); res.end(JSON.stringify({ pid: process.pid }));
  });
});
s.listen(0, '127.0.0.1', () => process.send({ t: 'listening', port: s.address().port }));
`);
const stubLines = () => { try { return fs.readFileSync(STUB_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

const OPS = [...Array(N)].map(() => privateKeyToAccount(generatePrivateKey()).address.toLowerCase());
const FRONT_PORTS = [], ROLE_PORTS = [];
const PA = () => ({ apiPort: 8098, peerPort: 8099, hostname: HOSTNAME,
  members: OPS.map((op, i) => ({ operator: op, publicUrl: `https://host-${i}.example.org`, controlUrl: `https://127.0.0.1:${FRONT_PORTS[i]}` })),
  measurements: ['77'.repeat(48)], minTcb: null, admins: [a(0xad)], recovery: ['11'.repeat(32)], archives: [], archiveMs: 30000,
  relayEnv: { STUB_LOG }, leaseMs: 2000 });
const rawFor = (i) => ({ format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ['https://rpc-a.example/v1', 'https://rpc-b.example'], quorum: 2, releaseId: 'ab'.repeat(32), replicas: { gateways: ['https://replica.example'], storagePlan: null },
  identity: { publicUrl: `https://host-${i}.example.org`, repo: 'owner/enclave', operator: OPS[i] }, selling: { cpuPrice6: null, payout: null },
  isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096' }, hostAdmissionSha256: null, controlPort: 8444, platformApi: PA() });
const webKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });   // the group's shared WebPKI key for HOSTNAME (not attested)
fs.writeFileSync(path.join(tmp, 'web-key.pem'), webKey.privateKey.export({ type: 'pkcs8', format: 'pem' }));
fs.writeFileSync(path.join(tmp, 'web-cert.pem'), MC.selfSignedCert(webKey.privateKey, webKey.publicKey, { cn: HOSTNAME }));

const M = [];
async function frontFor(m) {
  const f = track(MC.createControlFront({ statementText: m.st.text, keyPem: fs.readFileSync(m.P.tlsKey, 'utf8'), certPem: m.keys.controlTls.certPem, mode: 'dev', reporter: null,
    upstream: { host: '127.0.0.1', port: 1 }, hostRoutes: [{ host: HOSTNAME, upstream: { host: '127.0.0.1', port: ROLE_PORTS[m.i].api } }],
    prefixRoutes: [{ prefix: MC.PLATFORM_API_PREFIX, upstream: { host: '127.0.0.1', port: ROLE_PORTS[m.i].peer } }],
    sni: { [HOSTNAME]: { certFile: path.join(tmp, 'web-cert.pem'), keyFile: path.join(tmp, 'web-key.pem') } } }));
  await new Promise((r) => f.listen(FRONT_PORTS[m.i], '127.0.0.1', r));
  return f;
}
async function bootMember(i) {
  const d = fs.mkdtempSync(path.join(tmp, `m${i}-`));
  const P = { ...MC.GUEST_PATHS, runDir: d, sessionDir: path.join(d, 'session'), statement: path.join(d, 'statement.json'), tlsKey: path.join(d, 'tls-key.pem'),
              tlsCert: path.join(d, 'tls-cert.pem'), platformApiConfig: path.join(d, 'platform-api.json'), platformApiHandoffKey: path.join(d, 'handoff.key'), platformApiDir: path.join(d, 'pa') };
  const config = MC.canonicalDirectConfig(rawFor(i)), digest = MC.configDigest(config), hostData = MC.hostDataHex(digest);
  const keys = MC.mintControlKeys({ paths: P }); keys.platformApi = { publicKey: MC.mintPlatformApiKey({ paths: P }) };
  const st = MC.controlStatement({ config, digest, hostData, mode: 'dev', keys });
  fs.writeFileSync(P.statement, st.text);
  const launch = MC.directPlatformApiLaunch(config, { paths: P });
  const roleCfg = { ...JSON.parse(launch.files[P.platformApiConfig]), listen: ROLE_PORTS[i], askMs: 300 };
  fs.mkdirSync(roleCfg.dirs.root, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(roleCfg.dirs.root, 'k'), K, { mode: 0o600 });
  const m = { i, P, st, keys, roleCfg };
  m.front = await frontFor(m);
  m.role = await startRole({ cfg: roleCfg, recoverMessageAddress: async () => '0x', verifyPeer: async () => ({ ok: false, reason: 'not in this test' }), log: () => {},
    relayArgv: [process.execPath, STUB], forwardConnectMs: 1500 });
  roles.push(m.role);
  return m;
}
/** a client request through member m's front with the platform API host (as a browser would send it) */
function call(m, method, p, { body = null, headers = {}, onChunk = null, signal = null } = {}) {
  return new Promise((ok, no) => {
    const r = https.request({ host: '127.0.0.1', port: FRONT_PORTS[m.i], method, path: p, rejectUnauthorized: false, servername: HOSTNAME, agent: false, signal,
      headers: { host: HOSTNAME, ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const c = []; res.on('data', (x) => { c.push(x); onChunk?.(x, Date.now()); }); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, text: Buffer.concat(c).toString() }));
      res.on('error', no);
    });
    r.on('error', no); r.end(body || undefined);
  });
}
/** what the front does for the platform API host: an HTTP request to the role's API port with the client address it saw */
function callRole(m, method, p, { signal = null } = {}) {
  return new Promise((ok, no) => {
    const r = http.request({ host: '127.0.0.1', port: ROLE_PORTS[m.i].api, method, path: p, agent: false, signal, headers: { host: HOSTNAME, 'x-enclave-client-ip': '127.0.0.1' } }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => ok({ status: res.statusCode, text: Buffer.concat(c).toString() })); res.on('error', no);
    });
    r.on('error', no); r.end();
  });
}
const leader = () => M.find((m) => m.role && m.role.status().role === 'leader' && m.role.status().relay);
const standbyOf = (l) => M.find((m) => m !== l && m.role && m.role.node()?.leaderInfo?.spki === l.keys.controlTls.spkiSha256);
async function closeFront(m) {                  // whatever listens on m's control address goes away (open connections too)
  for (const c of sockets) if (c.localPort === FRONT_PORTS[m.i]) c.destroy();
  await new Promise((r) => m.front.close(() => r())); servers.delete(m.front);
}
async function swapFront(m, server) { await closeFront(m); track(server); await new Promise((r) => server.listen(FRONT_PORTS[m.i], '127.0.0.1', r)); m.front = server; }
async function restoreFront(m) { await closeFront(m); m.front = await frontFor(m); }

test('setup: three members replicate and elect a primary through their real fronts; the primary runs its relay child', { timeout: 60000 }, async () => {
  for (let i = 0; i < N; i++) { FRONT_PORTS.push(await freePort()); ROLE_PORTS.push({ api: await freePort(), peer: await freePort() }); }
  for (let i = 0; i < N; i++) M.push(await bootMember(i));
  const l = await waitFor('a primary with its relay', () => leader());
  await waitFor('standbys that know the primary', () => M.filter((m) => m !== l && standbyOf(l) && m.role.node()?.leaderInfo).length === 2);
});

test('a standby forwards the original method, path, headers, credentials and body, and streams the response, to the ATTESTED primary only', { timeout: 30000 }, async () => {
  const l = leader(), s = standbyOf(l);
  const r = await call(s, 'POST', '/echo?x=1', { body: BODY, headers: { authorization: AUTH, 'content-type': 'text/plain', 'x-enclave-client-ip': '6.6.6.6' } });
  assert.equal(r.status, 201, r.text); assert.equal(r.headers['x-stub'], 'echo');
  const seen = stubLines().filter((x) => x.url === '/echo?x=1').at(-1);
  assert.equal(seen.method, 'POST'); assert.equal(seen.body, BODY); assert.equal(seen.headers.authorization, AUTH);
  assert.equal(seen.headers['x-forwarded-for'], '127.0.0.1', 'the client address the standby saw, carried by the hop proof (a client-written header is dropped)');
  assert.equal(seen.headers['x-forwarded-host'], HOSTNAME);
  // a streamed answer arrives as it is produced, not after the end
  const times = [];
  const st = await call(s, 'GET', '/stream', { onChunk: (_c, t) => times.push(t) });
  assert.equal(st.status, 207); assert.equal(st.headers['x-stub'], 'stream'); assert.equal(st.text, 'chunk0\nchunk1\nchunk2\nend\n');
  assert.ok(times.length >= 2 && times.at(-1) - times[0] >= 400, `chunks streamed (${times.map((t) => t - times[0]).join(',')} ms)`);
});

test('a WRONG-KEY self-signed peer on the primary\'s address receives the TLS handshake and ZERO request bytes: no credential, no body', { timeout: 30000 }, async () => {
  const l = leader(), s = standbyOf(l), saved = l.front;
  const k = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const conns = [], sni = []; let tcp = 0;
  const impostor = tls.createServer({ key: k.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: MC.selfSignedCert(k.privateKey, k.publicKey, { cn: HOSTNAME }),
    SNICallback: (name, cb) => { sni.push(name); cb(null, null); } }, (sock) => {
    const rec = { bytes: Buffer.alloc(0) }; conns.push(rec);
    sock.on('data', (d) => { rec.bytes = Buffer.concat([rec.bytes, d]); }); sock.on('error', () => {});
  });
  impostor.on('connection', () => { tcp++; }); impostor.on('tlsClientError', () => {});
  await swapFront(l, impostor);
  try {
    const before = stubLines().length;
    // the impostor never answers: wait at most 5 s for the standby's own answer, then judge what the impostor received
    const r = await Promise.race([call(s, 'POST', '/v1/account/secret', { body: BODY, headers: { authorization: AUTH, 'content-type': 'text/plain' } }).catch((e) => e), sleep(5000).then(() => null)]);
    await sleep(200);
    const all = Buffer.concat(conns.map((c) => c.bytes)).toString('latin1');
    assert.ok(tcp >= 1, 'the standby did reach the impostor');
    assert.ok(!all.includes(AUTH) && !all.includes(BODY) && !all.includes('/v1/account/secret') && !/x-enclave-platform-api-hop/i.test(all), 'no request byte reached the impostor');
    // every connection that carried bytes at all is the replica's AEAD-sealed peer protocol (not a TLS-trusted channel)
    for (const c of conns.filter((x) => x.bytes.length)) assert.match(c.bytes.toString('latin1'), /^POST \/platform-api\/peer /);
    assert.deepEqual(sni, [], 'no SNI: the forward asks for the attested control certificate, not the WebPKI name');
    assert.equal(stubLines().length, before, 'nothing reached the primary either');
    assert.equal(r?.status, 503, 'the client is told the primary is unreachable'); assert.equal(JSON.parse(r.text).error, 'platform_api_unreachable');
  } finally { await restoreFront(l); }
});

// (the control front does not propagate a client's disconnect to its upstream - a pre-existing front behaviour reported
// separately - so these cases address the standby role's API port directly, exactly as the front does)
test('the client goes away: the standby role drops its pinned connection to the primary (mid-request, and mid-handshake with a silent peer)', { timeout: 30000 }, async () => {
  const l = leader(), s = standbyOf(l);
  const fromStandby = () => [...sockets].filter((c) => c.localPort === FRONT_PORTS[l.i] && !c.destroyed).length;
  // mid-request: the primary holds the answer; the client aborts; the standby's upstream connection to the primary closes
  const ac = new AbortController();
  const p = callRole(s, 'GET', '/hang/1', { signal: ac.signal }).catch((e) => e);
  await waitFor('the held request at the primary', () => stubLines().some((x) => x.url === '/hang/1'));
  assert.ok(fromStandby() >= 1);
  ac.abort(); await p;
  await waitFor('the standby closing its connection to the primary', () => fromStandby() === 0, 3000);
  // a silent peer (accepts TCP, never answers the TLS handshake): bounded by the handshake timeout, then 503
  // the silent peer also holds the replica's own peer posts (they wait for their 15 s timeout); a connection that closes
  // well before the 1.5 s handshake timeout can only be a forward the standby cancelled
  const life = [];
  // (it reads and discards - an unread socket stays paused and would never notice the peer's close - but never answers)
  const silent = net.createServer((c) => { const e = { opened: Date.now(), closed: null }; life.push(e); c.resume(); c.on('close', () => { e.closed = Date.now(); }); c.on('error', () => {}); });
  await swapFront(l, silent);
  try {
    const t0 = Date.now();
    const r = await callRole(s, 'GET', '/v1/health');
    assert.equal(r.status, 503); assert.ok(Date.now() - t0 < 5000, 'bounded by the handshake timeout');
    // and a client that leaves during the handshake: the pending connection is cancelled at once
    const t2 = Date.now(), ac2 = new AbortController();
    const p2 = callRole(s, 'GET', '/v1/health', { signal: ac2.signal }).catch((e) => e);
    await sleep(300);                         // the forward is now waiting on the silent handshake (timeout 1500 ms)
    ac2.abort(); await p2;
    await sleep(700);
    const mine = life.filter((e) => e.opened >= t2 && e.opened < t2 + 300);
    assert.ok(mine.length >= 1, 'the forward opened its connection');
    assert.ok(mine.some((e) => e.closed !== null && e.closed - t2 < 1100), `cancelled at the client's abort, not at the 1500 ms timeout (${JSON.stringify(mine.map((e) => [e.opened - t2, e.closed && e.closed - t2]))})`);
  } finally { await restoreFront(l); }
});

test('upgrades on a standby keep their scope: refused (503), never forwarded', { timeout: 15000 }, async () => {
  const l = leader(), s = standbyOf(l);
  const status = await new Promise((ok, no) => {
    const r = https.request({ host: '127.0.0.1', port: FRONT_PORTS[s.i], path: '/ws', rejectUnauthorized: false, servername: HOSTNAME, agent: false,
      headers: { host: HOSTNAME, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') } });
    r.on('response', (res) => { res.resume(); ok(res.statusCode); }); r.on('upgrade', () => ok(101)); r.on('error', no); r.end();
  });
  assert.equal(status, 503);
});

test('the primary changes: standbys pin the NEW primary\'s attested key from its sealed heartbeat and forward there', { timeout: 60000 }, async () => {
  const old = leader(), oldPid = stubLines().filter((x) => x.url === '/echo?x=1').at(-1).pid;
  await old.role.stop(); roles = roles.filter((r) => r !== old.role); old.role = null; await closeFront(old);
  const l = await waitFor('a successor with its relay', () => leader(), 45000);
  assert.notEqual(l, old);
  const s = await waitFor('a standby that knows the successor', () => standbyOf(l));
  const r = await call(s, 'POST', '/echo?x=2', { body: BODY, headers: { authorization: AUTH } });
  assert.equal(r.status, 201, r.text);
  const seen = stubLines().filter((x) => x.url === '/echo?x=2').at(-1);
  assert.notEqual(seen.pid, oldPid, 'served by the successor\'s relay'); assert.equal(seen.headers.authorization, AUTH); assert.equal(seen.body, BODY);
});
