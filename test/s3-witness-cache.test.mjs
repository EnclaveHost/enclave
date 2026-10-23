// network/s3-witness-cache.mjs, offline (run inside `unshare -r -n`): the maintained signer against AWS's published
// SigV4 vectors; a REAL S3 server (MinIO, MINIO_BIN) for interoperability, create-only and conflicts; a fault-injecting
// fake S3 for tampering, oversize, truncation, stalls, stuck uploads and cancellation; and the witness gateway with it.
//   env: MINIO_BIN (optional; MinIO tests skip without it), TEST_TMP (disk scratch dir)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { s3WitnessCache, s3Request, canonicalJson } from '../network/s3-witness-cache.mjs';
import { createWitnessGateway, witnessKey } from '../network/witness-gateway.mjs';

const { MINIO_BIN } = process.env;
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 's3-cache-'));
// test-only MinIO root, fresh per run (no credential literal in source)
const CREDS = { accessKeyId: 'enclavetest' + randomBytes(4).toString('hex'), secretAccessKey: randomBytes(18).toString('base64url').replace(/[-_]/g, 'A') };
const BLOCK = '0x' + 'ab'.repeat(32);
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pinned = (addr, slot = '0x0', hash = BLOCK) => witnessKey('eth_getProof', [addr, [slot], { blockHash: hash }]);
const children = [];
test.after(async () => { for (const p of children) p.kill('SIGKILL'); fs.rmSync(TMP, { recursive: true, force: true }); });

// ---- the signer: curl --aws-sigv4 reproduces the published vectors -------------------------------------------------
function vector(name) {
  const dir = new URL(`./fixtures/aws-sigv4/${name}/`, import.meta.url);
  const ctx = JSON.parse(fs.readFileSync(new URL('context.json', dir), 'utf8'));
  const req = fs.readFileSync(new URL('request.txt', dir), 'utf8').split('\n');
  const auth = fs.readFileSync(new URL('header-signed-request.txt', dir), 'utf8').split('\n').find((l) => l.startsWith('Authorization:')).slice(14);
  const [method, target] = req[0].split(' ');
  const headers = req.slice(1).filter((l) => l.includes(':') && !/^host:/i.test(l));
  return { ctx, method, target, headers, auth };
}
for (const name of ['get-vanilla', 'get-header-value-trim']) {
  test(`curl's SigV4 signer reproduces the published vector ${name}`, async () => {
    const v = vector(name);
    let seen;
    const s = http.createServer((q, r) => { seen = q.headers; r.end('ok'); });
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const amzDate = v.ctx.timestamp.replace(/[-:]/g, '');
    const args = ['-q', '-s', '-K', '-', '--aws-sigv4', `aws:amz:${v.ctx.region}:${v.ctx.service}`, '-H', `X-Amz-Date: ${amzDate}`,
      ...v.headers.flatMap((h) => ['-H', h]), '--connect-to', `example.amazonaws.com:80:127.0.0.1:${s.address().port}`,
      '-X', v.method, `http://example.amazonaws.com${v.target}`, '-o', '/dev/null'];
    await new Promise((resolve, reject) => {  // async: a synchronous child would block this process's capture server
      const p = execFile('curl', ['--max-time', '10', ...args], (e) => (e ? reject(e) : resolve()));
      p.stdin.end(`user = "${v.ctx.credentials.access_key_id}:${v.ctx.credentials.secret_access_key}"\n`);
    });
    s.close();
    assert.equal(seen.authorization, v.auth);
  });
}

test('only block-hash-pinned requests have a cache key: a cache can never answer for "latest" or a block number', () => {
  assert.ok(pinned('0x' + '11'.repeat(20)));
  for (const at of ['latest', 'pending', '0x10', { blockNumber: '0x10' }, { blockHash: BLOCK, extra: 1 }])
    assert.equal(witnessKey('eth_getProof', ['0x' + '11'.repeat(20), [], at]), null, JSON.stringify(at));
  assert.equal(witnessKey('eth_call', [{}, { blockHash: BLOCK }]), null);
});

test('construction refuses unsafe or ambiguous configuration without echoing secrets', () => {
  const ok = { endpoint: 'http://127.0.0.1:9', bucket: 'witness', chainId: 8453, credentials: CREDS };
  for (const [bad, why] of [[{ endpoint: 'http://example.com' }, /HTTPS/], [{ endpoint: 'https://u:p@example.com' }, /credentials/],
    [{ chainId: undefined }, /chainId/], [{ bucket: 'A_B' }, /bucket/], [{ credentials: { accessKeyId: 'k"x', secretAccessKey: 'abcdefgh1' } }, /credentials/],
    [{ credentials: { accessKeyId: 'key', secretAccessKey: 'has\nnewline1' } }, /credentials/], [{ archive: 'yes' }, /archive/]]) {
    assert.throws(() => s3WitnessCache({ ...ok, ...bad }), why);
  }
  try { s3WitnessCache({ ...ok, endpoint: 'http://example.com/key-' + CREDS.secretAccessKey }); } catch (e) { assert.ok(!String(e.message).includes(CREDS.secretAccessKey)); }
  assert.match(s3WitnessCache(ok).privacy, /read-only/);
  assert.match(s3WitnessCache({ ...ok, archive: true }).privacy, /ARCHIVE ON/);
});

// ---- a real S3 server ----------------------------------------------------------------------------------------------
let minio = null;
function startMinio() { return (minio ??= bootMinio()); }
async function bootMinio() {
  const port = await freePort(), cport = await freePort(), dir = path.join(TMP, 'minio');
  fs.mkdirSync(dir);
  const p = spawn(MINIO_BIN, ['server', '--quiet', '--address', `127.0.0.1:${port}`, '--console-address', `127.0.0.1:${cport}`, dir],
    { env: { PATH: process.env.PATH, HOME: TMP, MINIO_ROOT_USER: CREDS.accessKeyId, MINIO_ROOT_PASSWORD: CREDS.secretAccessKey, MINIO_BROWSER: 'off' }, stdio: 'ignore' });
  children.push(p);
  const endpoint = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(endpoint + '/minio/health/ready')).ok) break; } catch {} await sleep(250); }
  const mk = await s3Request({ method: 'PUT', url: `${endpoint}/witness`, region: 'us-east-1', credentials: CREDS, timeoutMs: 5000, maxBytes: 65536 });
  assert.equal(mk.status, 200, 'bucket created with a signed request');
  return { endpoint, p };
}
const T = { skip: !MINIO_BIN && 'MINIO_BIN not set', timeout: 60000 };

test('MinIO: read-only by default, then create-only writes, exact replay, conflict detection and chain namespaces', T, async () => {
  const { endpoint } = await startMinio();
  const cfg = { endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS };
  const w = pinned('0x' + '22'.repeat(20)), result = { address: '0x' + '22'.repeat(20), balance: '0x1', storageProof: [{ key: '0x0', value: '0x7', proof: ['0xaa'] }] };
  const ro = s3WitnessCache(cfg);
  await ro.put(w, result);
  assert.equal(ro.stats().putsSkipped, 1, 'archive is opt-in: nothing written');
  assert.equal(await ro.get(w), undefined);
  assert.equal(ro.stats().misses, 1);
  const c = s3WitnessCache({ ...cfg, archive: true });
  await c.put(w, result);
  assert.equal(c.stats().puts, 1);
  assert.deepEqual(await c.get(w), result);
  await c.put(w, JSON.parse(JSON.stringify(result)));                // same entry again: idempotent
  assert.equal(c.stats().putsExisting, 1);
  await c.put(w, { ...result, balance: '0x2' });                     // a disagreeing source: never overwrites
  assert.equal(c.stats().conflicts, 1);
  assert.deepEqual(await c.get(w), result, 'the first entry stays');
  assert.equal(await s3WitnessCache({ ...cfg, chainId: 84532 }).get(w), undefined, 'another chain never sees it');
  const stored = await s3Request({ method: 'GET', url: `${endpoint}/witness/enclave-witness/8453/${w.blockHash}/${w.key}.json`, region: 'us-east-1', credentials: CREDS, timeoutMs: 5000, maxBytes: 1 << 20 });
  assert.equal(stored.body.toString(), canonicalJson({ format: 'enclave-witness-s3/v1', chainId: 8453, blockHash: w.blockHash, request: w.norm, result }));
});

test('MinIO: wrong credentials and tampered envelopes are misses, never errors or answers', T, async () => {
  const { endpoint } = await startMinio();
  const cfg = { endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS };
  const w = pinned('0x' + '33'.repeat(20)), good = s3WitnessCache({ ...cfg, archive: true });
  await good.put(w, { v: 1 });
  const bad = s3WitnessCache({ ...cfg, archive: true, credentials: { accessKeyId: CREDS.accessKeyId, secretAccessKey: randomBytes(18).toString('base64url').replace(/[-_]/g, 'B') } });
  assert.equal(await bad.get(w), undefined);
  await bad.put(pinned('0x' + '34'.repeat(20)), { v: 1 });
  assert.ok(bad.stats().errors.http403 >= 1 && bad.stats().putsFailed === 1, JSON.stringify(bad.stats()));
  // an attacker with bucket write access overwrites the object (no If-None-Match)
  const url = `${endpoint}/witness/enclave-witness/8453/${w.blockHash}/${w.key}.json`;
  const env = (o) => canonicalJson({ format: 'enclave-witness-s3/v1', chainId: 8453, blockHash: w.blockHash, request: w.norm, result: { v: 1 }, ...o });
  for (const [body, why] of [[env({ request: '["eth_getProof",[]]' }), 'request'], [env({ chainId: 1 }), 'chain'], [env({ blockHash: '0x' + '00'.repeat(32) }), 'block'],
    [env({ format: 'other' }), 'format'], [env({ extra: 1 }), 'fields'], ['{"truncated', 'malformed']]) {
    const r = await s3Request({ method: 'PUT', url, region: 'us-east-1', credentials: CREDS, timeoutMs: 5000, maxBytes: 65536, body, headers: ['Content-Type: application/json'] });
    assert.equal(r.status, 200);
    const c = s3WitnessCache(cfg);
    assert.equal(await c.get(w), undefined, why);
    assert.equal(c.stats().rejected[why], 1, `${why}: ${JSON.stringify(c.stats())}`);
  }
});

test('MinIO: the secret never reaches curl argv or environment, stats or stored entries', T, async (t) => {
  const { endpoint } = await startMinio();
  const rec = path.join(TMP, 'curl-recorder.sh'), log = path.join(TMP, 'curl-argv.log');
  fs.writeFileSync(rec, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${log}\nenv >> ${log}\nexec curl "$@"\n`, { mode: 0o700 });
  const upstreamKey = 'apikey-' + 'f'.repeat(24);
  const c = s3WitnessCache({ endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, archive: true, curl: rec });
  const w = pinned('0x' + '44'.repeat(20));
  await c.put(w, { proof: ['0x01'] });
  assert.deepEqual(await c.get(w), { proof: ['0x01'] });
  const seen = fs.readFileSync(log, 'utf8');
  assert.ok(seen.includes('--aws-sigv4') && !seen.includes(CREDS.secretAccessKey), 'secret absent from argv and env');
  assert.ok(!JSON.stringify(c.stats()).includes(CREDS.secretAccessKey));
  // the gateway stores only request and result: an upstream's API key (in its URL) is never archived
  const up = http.createServer((q, r) => { let b = ''; q.on('data', (d) => b += d); q.on('end', () => r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: 1 } }))); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => { up.close(); c.close(); });
  const gw = createWitnessGateway({ upstreams: [`http://127.0.0.1:${up.address().port}/v2/${upstreamKey}`], cache: c });
  const req = { jsonrpc: '2.0', id: 1, method: 'eth_getProof', params: ['0x' + '45'.repeat(20), [], { blockHash: BLOCK }] };
  assert.deepEqual((await gw.handle(req)).result, { ok: 1 });
  for (let i = 0; i < 40 && c.stats().puts < 2; i++) await sleep(100);
  const w2 = witnessKey(req.method, req.params);
  const body = (await s3Request({ method: 'GET', url: `${endpoint}/witness/enclave-witness/8453/${w2.blockHash}/${w2.key}.json`, region: 'us-east-1', credentials: CREDS, timeoutMs: 5000, maxBytes: 1 << 20 })).body.toString();
  assert.ok(body.includes('eth_getProof') && !body.includes(upstreamKey), body);
  up.close();
});

// ---- a fault-injecting fake S3 -------------------------------------------------------------------------------------
async function fakeS3(handler) {
  const s = http.createServer(handler);
  const sockets = new Set();
  s.on('connection', (k) => { sockets.add(k); k.on('close', () => sockets.delete(k)); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { endpoint: `http://127.0.0.1:${s.address().port}`, close: () => { for (const k of sockets) k.destroy(); s.close(); } };
}

test('fake S3: oversize, truncated, stalled and failing responses are bounded misses', async (t) => {
  const w = pinned('0x' + '55'.repeat(20));
  const valid = canonicalJson({ format: 'enclave-witness-s3/v1', chainId: 8453, blockHash: w.blockHash, request: w.norm, result: 1 });
  let mode;
  const f = await fakeS3((q, r) => {
    if (mode === 'big') return r.end('x'.repeat(5000));                                         // Content-Length above the bound
    if (mode === 'big-chunked') { r.writeHead(200); r.write('x'.repeat(3000)); return r.end('y'.repeat(3000)); }  // no length
    if (mode === 'truncated') { r.writeHead(200, { 'content-length': 1000 }); r.write(valid.slice(0, 10)); return setTimeout(() => r.socket.destroy(), 50); }
    if (mode === 'stall') return;                                                               // never answers
    if (mode === 'error') { r.writeHead(500); return r.end('no'); }
    r.end(valid);
  });
  t.after(() => f.close());
  const c = s3WitnessCache({ endpoint: f.endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, timeoutMs: 1000, maxObjectBytes: 4096 });
  mode = 'ok'; assert.equal(await c.get(w), 1);
  for (const [m, key] of [['big', 'oversize'], ['big-chunked', 'oversize'], ['truncated', 'curl'], ['stall', 'timeout'], ['error', 'http500']]) {
    mode = m;
    const t0 = Date.now();
    assert.equal(await c.get(w), undefined, m);
    assert.ok(Date.now() - t0 < 3500, `${m} bounded in time (${Date.now() - t0} ms)`);
    assert.ok(c.stats().errors[key] >= 1, `${m}: ${JSON.stringify(c.stats().errors)}`);
  }
  assert.equal(c.stats().inflight.children, 0, 'no curl left running');
  f.close();
});

test('fake S3: stuck uploads never delay a fresh read; the write queue is bounded; close() cancels everything', async (t) => {
  const f = await fakeS3(() => {});                                                             // accepts, never answers
  const c = s3WitnessCache({ endpoint: f.endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, archive: true,
    timeoutMs: 1000, putTimeoutMs: 30000, maxInflightPuts: 1, maxQueuedPuts: 2 });
  const up = http.createServer((q, r) => { q.resume(); q.on('end', () => r.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { fresh: true } }))); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  t.after(() => { c.close(); up.close(); f.close(); });
  const gw = createWitnessGateway({ upstreams: [`http://127.0.0.1:${up.address().port}/`], cache: c });
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    const out = await gw.handle({ jsonrpc: '2.0', id: i, method: 'eth_getProof', params: ['0x' + String(60 + i).repeat(20), [], { blockHash: BLOCK }] });
    assert.deepEqual(out.result, { fresh: true });
    assert.ok(Date.now() - t0 < 500, `fresh read ${i} not held by the stuck upload (${Date.now() - t0} ms)`);
  }
  await sleep(300);
  const s = c.stats();
  assert.equal(s.inflight.puts, 1); assert.equal(s.inflight.queued, 2); assert.equal(s.putsDropped, 3, JSON.stringify(s));
  // reads share a bounded pool too: with one slot held by a stalled read, a second read gives up after its budget
  const c2 = s3WitnessCache({ endpoint: f.endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, timeoutMs: 800, maxInflightGets: 1 });
  const [a, b] = await Promise.all([c2.get(pinned('0x' + '77'.repeat(20))), c2.get(pinned('0x' + '78'.repeat(20)))]);
  assert.equal(a, undefined); assert.equal(b, undefined);
  assert.equal(c2.stats().errors.busy, 1);
  await c.close();
  assert.equal(c.stats().inflight.children, 0, 'close() killed the stuck curl');
  assert.equal(c.stats().inflight.queued, 0);
  assert.equal(await c.get(pinned('0x' + '79'.repeat(20))), undefined, 'a closed cache only misses');
  up.close(); f.close();
});

test('gateway + MinIO: a cache hit only when every upstream fails, and never for an unpinned (fresh) request', T, async () => {
  const { endpoint } = await startMinio();
  const c = s3WitnessCache({ endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, archive: true });
  const params = ['0x' + '88'.repeat(20), ['0x1'], { blockHash: BLOCK }];
  await c.put(witnessKey('eth_getProof', params), { cached: true });
  const dead = `http://127.0.0.1:${await freePort()}/`;                                          // nothing listens
  const gw = createWitnessGateway({ upstreams: [dead], cache: c, timeoutMs: 500 });
  assert.deepEqual((await gw.handle({ jsonrpc: '2.0', id: 1, method: 'eth_getProof', params })).result, { cached: true });
  const fresh = await gw.handle({ jsonrpc: '2.0', id: 2, method: 'eth_getProof', params: [params[0], params[1], 'latest'] });
  assert.ok(fresh.error && !fresh.result, 'no witness for "latest" when every upstream fails');
  assert.equal(gw.stats().cacheHits, 1);
});

test('a hung transport process is killed by the outer bound, not only by curl --max-time', async () => {
  const hung = path.join(TMP, 'hung-curl.sh');
  fs.writeFileSync(hung, '#!/bin/sh\nexec sleep 60\n', { mode: 0o700 });              // ignores every curl option
  const c = s3WitnessCache({ endpoint: 'http://127.0.0.1:9', bucket: 'witness', chainId: 8453, credentials: CREDS, timeoutMs: 500, curl: hung });
  const t0 = Date.now();
  assert.equal(await c.get(pinned('0x' + '99'.repeat(20))), undefined);
  assert.ok(Date.now() - t0 < 3000, `bounded (${Date.now() - t0} ms)`);
  assert.equal(c.stats().errors.timeout, 1);
  assert.equal(c.stats().inflight.children, 0);
  await c.close();
});
