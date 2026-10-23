// network/s3-witness-cache.mjs (backend only), offline (run inside `unshare -r -n`): the maintained signer against
// AWS's published SigV4 vectors; a REAL S3 server (MinIO, MINIO_BIN) for the content-addressed create-only layout,
// bounded ListObjectsV2 pagination, legacy reads and tampering; a fault-injecting fake S3 for oversize, truncation,
// stalls, stuck uploads and cancellation. The composed gateway is tested in s3-witness-archive.test.mjs.
//   env: MINIO_BIN (optional; MinIO tests skip without it), TEST_TMP (disk scratch dir)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { s3WitnessCache, s3Request, canonicalJson } from '../network/s3-witness-cache.mjs';
import { witnessKey } from '../network/witness-gateway.mjs';
import { startMinio as boot, raw, listAll, envelope, fakeS3 as fake, testCredentials } from './support/s3-test-env.mjs';

const { MINIO_BIN } = process.env;
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 's3-cache-'));
// test-only MinIO root, fresh per run (no credential literal in source)
const CREDS = testCredentials();
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
const startMinio = () => (minio ??= boot({ dir: path.join(TMP, 'minio'), creds: CREDS }).then((m) => { children.push({ kill: m.stop }); return m; }));
const T = { skip: !MINIO_BIN && 'MINIO_BIN not set', timeout: 60000 };
const cfg = (m, o = {}) => ({ endpoint: m.endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, ...o });
const nameOf = (result) => createHash('sha256').update(canonicalJson(result)).digest('hex');
const folder = (w) => `enclave-witness/8453/${w.blockHash}/${w.key}/`;

test('MinIO: read-only by default; opt-in writes are content-addressed and create-only; a second answer is a second candidate', T, async () => {
  const m = await startMinio();
  const w = pinned('0x' + '22'.repeat(20));
  const a = { address: '0x' + '22'.repeat(20), balance: '0x1', storageProof: [{ key: '0x0', value: '0x7', proof: ['0xaa'] }] }, b = { ...a, balance: '0x2' };
  const ro = s3WitnessCache(cfg(m));
  await ro.put(w, a); await ro.idle();
  assert.equal(ro.stats().putsSkipped, 1, 'archive is opt-in: nothing written');
  assert.deepEqual(await ro.candidates(w), []);
  const c = s3WitnessCache(cfg(m, { archive: true }));
  await c.put(w, a); await c.put(w, JSON.parse(JSON.stringify(a))); await c.put(w, b); await c.idle();
  assert.deepEqual([c.stats().puts, c.stats().putsExisting, c.stats().conflicts], [2, 1, 0], JSON.stringify(c.stats()));
  assert.deepEqual((await listAll(m, CREDS, folder(w))).sort(), [nameOf(a), nameOf(b)].sort().map((n) => folder(w) + n + '.json'));
  const got = await c.candidates(w);
  assert.deepEqual(got.map(canonicalJson).sort(), [a, b].map(canonicalJson).sort(), 'both answers are candidates; the gateway decides');
  assert.deepEqual((await raw(m, CREDS, { method: 'GET', key: folder(w) + nameOf(a) + '.json' })).body.toString(), envelope(w, a));
  assert.deepEqual(await s3WitnessCache(cfg(m, { chainId: 84532 })).candidates(w), [], 'another chain never sees them');
});

test('MinIO: misnamed, mis-bound and tampered objects are skipped; a squatter on a content name is a conflict, never overwritten', T, async () => {
  const m = await startMinio();
  const w = pinned('0x' + '33'.repeat(20)), good = { v: 1 };
  const c = s3WitnessCache(cfg(m, { archive: true }));
  const put = (key, body) => raw(m, CREDS, { method: 'PUT', key, body, headers: ['Content-Type: application/json'] });
  for (const [key, body] of [[folder(w) + '0'.repeat(64) + '.json', envelope(w, { v: 2 })],                 // name != hash of content
    [folder(w) + nameOf({ v: 3 }) + '.json', envelope(w, { v: 3 }, { request: '["eth_getProof",[]]' })],          // another request
    [folder(w) + nameOf({ v: 4 }) + '.json', envelope(w, { v: 4 }, { chainId: 1 })],                              // another chain
    [folder(w) + nameOf({ v: 5 }) + '.json', '{"truncated'], [folder(w) + 'not-a-hash.json', envelope(w, { v: 6 })]]) assert.equal((await put(key, body)).status, 200);
  assert.deepEqual(await c.candidates(w), []);
  assert.deepEqual(c.stats().rejected, { address: 1, request: 1, chain: 1, malformed: 1, 'listed-name': 1 }, JSON.stringify(c.stats()));
  // a squatter holds the content name of `good` with other bytes: our create-only write refuses to overwrite it
  await put(folder(w) + nameOf(good) + '.json', envelope(w, { v: 99 }));
  await c.put(w, good); await c.idle();
  assert.equal(c.stats().conflicts, 1);
  assert.match((await raw(m, CREDS, { method: 'GET', key: folder(w) + nameOf(good) + '.json' })).body.toString(), /99/, 'never overwritten');
  // wrong credentials are misses and failed writes, never throws
  const bad = s3WitnessCache(cfg(m, { archive: true, credentials: { accessKeyId: CREDS.accessKeyId, secretAccessKey: testCredentials().secretAccessKey } }));
  assert.deepEqual(await bad.candidates(w), []);
  await bad.put(pinned('0x' + '34'.repeat(20)), good); await bad.idle();
  assert.ok(bad.stats().errors.list403 >= 1 && bad.stats().putsFailed === 1, JSON.stringify(bad.stats()));
});

test('MinIO: the version-1 single-slot object is still read, last; listing is paginated and bounded', T, async () => {
  const m = await startMinio();
  const w = pinned('0x' + '35'.repeat(20)), legacy = { legacy: true };
  assert.equal((await raw(m, CREDS, { method: 'PUT', key: `enclave-witness/8453/${w.blockHash}/${w.key}.json`, body: envelope(w, legacy) })).status, 200);
  const c = s3WitnessCache(cfg(m, { archive: true, maxCandidates: 2, maxListPages: 3 }));
  assert.deepEqual(await c.candidates(w), [legacy]);
  const answers = [1, 2, 3, 4, 5].map((v) => ({ v }));
  for (const a of answers) await c.put(w, a);
  await c.idle();
  const got = await c.candidates(w);
  assert.equal(got.length, 2, 'at most maxCandidates, the legacy slot only when there is room');
  const sorted = answers.map((a) => [nameOf(a), a]).sort(([x], [y]) => (x < y ? -1 : 1)).slice(0, 2).map(([, a]) => a);
  assert.deepEqual(got, sorted, 'listing order (lexicographic content names)');
  assert.equal(c.stats().lists, 2, 'one list page per call');
  const wide = s3WitnessCache(cfg(m, { maxCandidates: 8, maxListPages: 3 }));
  assert.equal((await wide.candidates(w)).length, 6, 'five answers, then the legacy slot');
});

test('MinIO: the secret never reaches curl argv or environment, stats or stored objects', T, async () => {
  const m = await startMinio();
  const rec = path.join(TMP, 'curl-recorder.sh'), log = path.join(TMP, 'curl-argv.log');
  fs.writeFileSync(rec, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${log}\nenv >> ${log}\nexec curl "$@"\n`, { mode: 0o700 });
  const c = s3WitnessCache(cfg(m, { archive: true, curl: rec }));
  const w = pinned('0x' + '44'.repeat(20));
  await c.put(w, { proof: ['0x01'] }); await c.idle();
  assert.deepEqual(await c.candidates(w), [{ proof: ['0x01'] }]);
  const seen = fs.readFileSync(log, 'utf8');
  assert.ok(seen.includes('--aws-sigv4') && !seen.includes(CREDS.secretAccessKey), 'secret absent from argv and env');
  assert.ok(!JSON.stringify(c.stats()).includes(CREDS.secretAccessKey));
  for (const k of await listAll(m, CREDS, 'enclave-witness/')) assert.ok(!(await raw(m, CREDS, { method: 'GET', key: k })).body.toString().includes(CREDS.secretAccessKey));
});

// ---- a fault-injecting fake S3 -------------------------------------------------------------------------------------
test('fake S3: oversize, truncated, stalled and failing listings and objects are bounded empty results', async (t) => {
  const w = pinned('0x' + '55'.repeat(20)), result = 1;
  const key = `enclave-witness/8453/${w.blockHash}/${w.key}/${nameOf(result)}.json`;
  const listing = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${key}</Key></Contents></ListBucketResult>`;
  let mode;
  const f = await fake((q, r) => {
    const isList = q.url.includes('list-type=2'), isObject = q.url.endsWith(key);   // only the content-addressed object exists
    if (!isList && !isObject) { r.writeHead(404); return r.end(); }
    if (mode === 'ok') return r.end(isList ? listing : envelope(w, result));
    if (isList && mode !== 'object-big' && mode !== 'object-truncated') {
      if (mode === 'big') return r.end('x'.repeat(5000));
      if (mode === 'stall') return;
      if (mode === 'error') { r.writeHead(500); return r.end('no'); }
    }
    if (isList) return r.end(listing);
    if (mode === 'object-big') { r.writeHead(200); r.write('x'.repeat(3000)); return r.end('y'.repeat(3000)); }   // no length
    if (mode === 'object-truncated') { r.writeHead(200, { 'content-length': 1000 }); r.write('{"x'); return setTimeout(() => r.socket.destroy(), 50); }
    r.writeHead(404); r.end();
  });
  t.after(() => f.close());
  const c = s3WitnessCache({ endpoint: f.endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, timeoutMs: 1000, readBudgetMs: 2500, maxObjectBytes: 4096, maxListBytes: 4096 });
  mode = 'ok'; assert.deepEqual(await c.candidates(w), [1]);
  for (const [m, key2] of [['big', 'list-oversize'], ['stall', 'list-timeout'], ['error', 'list500'], ['object-big', 'oversize'], ['object-truncated', 'curl']]) {
    mode = m;
    const t0 = Date.now();
    assert.deepEqual(await c.candidates(w), [], m);
    assert.ok(Date.now() - t0 < 3500, `${m} bounded in time (${Date.now() - t0} ms)`);
    assert.ok(c.stats().errors[key2] >= 1, `${m}: ${JSON.stringify(c.stats().errors)}`);
  }
  assert.equal(c.stats().inflight.children, 0, 'no curl left running');
  await c.close();
});

test('fake S3: writes return at once even when uploads hang; the queue is bounded; close() cancels everything', async (t) => {
  const f = await fake(() => {});                                                               // accepts, never answers
  t.after(() => f.close());
  const c = s3WitnessCache({ endpoint: f.endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, archive: true,
    timeoutMs: 1000, readBudgetMs: 1500, putTimeoutMs: 30000, maxInflightPuts: 1, maxQueuedPuts: 2 });
  const t0 = Date.now();
  for (let i = 0; i < 6; i++) await c.put(pinned('0x' + String(60 + i).repeat(20)), { i });
  assert.ok(Date.now() - t0 < 200, `six puts returned at once (${Date.now() - t0} ms)`);
  await sleep(300);
  const s = c.stats();
  assert.deepEqual([s.inflight.puts, s.inflight.queued, s.putsDropped], [1, 2, 3], JSON.stringify(s));
  // reads share a bounded pool: with the one slot held by a stalled listing, a second read gives up within its budget
  const c2 = s3WitnessCache({ endpoint: f.endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, timeoutMs: 800, readBudgetMs: 800, maxInflightGets: 1 });
  const t1 = Date.now();
  const [a, b] = await Promise.all([c2.candidates(pinned('0x' + '77'.repeat(20))), c2.candidates(pinned('0x' + '78'.repeat(20)))]);
  assert.deepEqual([a, b], [[], []]);
  assert.ok(Date.now() - t1 < 3000, `bounded (${Date.now() - t1} ms)`);
  assert.equal(c2.stats().errors.busy, 1, JSON.stringify(c2.stats()));
  await c.close(); await c2.close();
  assert.equal(c.stats().inflight.children, 0, 'close() killed the stuck upload');
  assert.equal(c.stats().inflight.queued, 0);
  await c.idle();
  assert.deepEqual(await c.candidates(pinned('0x' + '79'.repeat(20))), [], 'a closed archive is empty');
});

test('a hung transport process is killed by the outer bound, not only by curl --max-time', async () => {
  const hung = path.join(TMP, 'hung-curl.sh');
  fs.writeFileSync(hung, '#!/bin/sh\nexec sleep 60\n', { mode: 0o700 });              // ignores every curl option
  const c = s3WitnessCache({ endpoint: 'http://127.0.0.1:9', bucket: 'witness', chainId: 8453, credentials: CREDS, timeoutMs: 500, readBudgetMs: 600, curl: hung });
  const t0 = Date.now();
  assert.deepEqual(await c.candidates(pinned('0x' + '99'.repeat(20))), []);
  assert.ok(Date.now() - t0 < 3500, `bounded (${Date.now() - t0} ms)`);
  assert.ok(c.stats().errors['list-timeout'] === 1, JSON.stringify(c.stats().errors));
  assert.equal(c.stats().inflight.children, 0);
  await c.close();
});
