// The COMPOSED gateway (P's whole-operation deadlines d0775541 + E's S3 archive tier afc443e0) with the REAL S3 backend
// transport (curl --aws-sigv4) against loopback fake S3 servers that hang or answer selectively, the REAL witness-check
// helper and REAL recorded Base witnesses (block 52965249; its head is signed by the fixture's TEST key: witness
// verification, not head authenticity). A NEGATIVE CONTROL runs the same hung-archive case on E's exact afc443e0
// gateway. Nothing here writes to a real S3/Sia store or a chain. Run offline (`unshare -r -n`).
//   env: WITNESS_CHECK_BIN, BASE_FIXTURE_DIR, TEST_TMP
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createWitnessGateway, dirWitnessCache, witnessKey, WITNESS_METHODS } from '../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';
import { s3WitnessCache, canonicalJson } from '../network/s3-witness-cache.mjs';
import { envelope, fakeS3, sleep, testCredentials } from './support/s3-test-env.mjs';

const { WITNESS_CHECK_BIN, BASE_FIXTURE_DIR } = process.env;
const fixture = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'fixture.json'), 'utf8'));
const RECORDED = new Map();
for (const f of fs.readdirSync(path.join(BASE_FIXTURE_DIR, 'cache', fixture.block.hash))) {
  const e = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'cache', fixture.block.hash, f), 'utf8'));
  const [method, params] = JSON.parse(e.request);
  RECORDED.set(witnessKey(method, params).key, { method, params, result: e.result });
}
const proof0 = (addr) => [...RECORDED.values()].find((r) => r.method === 'eth_getProof' && r.params[0] === addr && r.params[1].length === 0);
const A = proof0('0x4200000000000000000000000000000000000015'), B = proof0('0xab214342d5a490150a4a977063a2f88e21f80907');
const req = (r, id = 1) => ({ jsonrpc: '2.0', id, method: r.method, params: r.params });
const NO_HINT = WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList');
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'archive-deadline-'));
const CREDS = testCredentials();
const DOWN = 'http://127.0.0.1:9/';                       // a closed loopback port: an upstream that is down
const servers = [], closers = [];
let checker;
test.before(() => { checker = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: fixture.testSequencerSigner }); });
test.after(async () => { for (const c of closers.reverse()) await c(); checker?.close(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } fs.rmSync(TMP, { recursive: true, force: true }); });
async function roots() { const r = createRootStore({ checker }); assert.ok(await r.offer(fixture.commitment)); closers.push(async () => r.close()); return r; }
function upstream(answer, delay = 0) {
  const log = { n: 0 };
  const s = http.createServer((q, res) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
    const j = JSON.parse(b); log.n++;
    setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, ...answer(j) })); }, delay);
  }); });
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${s.address().port}/`, log })));
}
const honest = (delay) => upstream((j) => { const r = RECORDED.get(witnessKey(j.method, j.params)?.key); return r ? { result: r.result } : { error: { code: -32000, message: 'x' } }; }, delay);
const liar = () => upstream((j) => { const r = RECORDED.get(witnessKey(j.method, j.params)?.key); if (!r) return { error: { code: -32000, message: 'x' } }; const v = structuredClone(r.result); v.balance = '0x1'; return { result: v }; });
/** A fake S3: hangs for requests matching `hang`, serves `objects` (key -> body) with an optional per-GET delay. */
async function s3Stub({ hang = () => false, objects = new Map(), getDelay = 0, status = 200 } = {}) {
  const log = { requests: 0, open: 0, puts: 0 };
  const s3 = await fakeS3((q, res) => {
    log.requests++; log.open++; res.on('close', () => { log.open--; });
    const u = new URL(q.url, 'http://x');
    if (q.method === 'PUT') { log.puts++; return; }        // writes hang (never answered)
    if (hang(u)) return;                                   // never answered
    if (status !== 200) { res.writeHead(status).end(); return; }
    const parts = u.pathname.split('/').slice(2).join('/');
    if (u.searchParams.get('list-type') === '2') {
      const pfx = u.searchParams.get('prefix');
      const keys = [...objects.keys()].filter((k) => k.startsWith(pfx));
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<ListBucketResult>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      return;
    }
    const body = objects.get(decodeURIComponent(parts));
    if (!body) { res.writeHead(404).end(); return; }       // misses (e.g. the legacy single-slot probe) answer at once
    setTimeout(() => { if (!res.destroyed) res.writeHead(200).end(body); }, getDelay);
  });
  closers.push(async () => s3.close());
  return { ...s3, log };
}
const objectKey = (w, result) => `enclave-witness/8453/${w.blockHash}/${w.key}/${createHash('sha256').update(canonicalJson(result)).digest('hex')}.json`;
const archiveOn = (endpoint, o = {}) => { const a = s3WitnessCache({ endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, timeoutMs: 4000, readBudgetMs: 8000, ...o }); closers.push(() => a.close()); return a; };

async function hungArchiveCase(createGateway, s3Cache) {
  const s3 = await s3Stub({ hang: () => true });
  const archive = s3Cache({ endpoint: s3.endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, timeoutMs: 4000, readBudgetMs: 8000 });
  const g = createGateway({ upstreams: [DOWN], methods: NO_HINT, archive, proofs: { checker, roots: await roots() }, deadlineMs: 600, timeoutMs: 300 });
  const t0 = performance.now();
  const out = await g.handle(req(A));
  const took = performance.now() - t0;
  await sleep(150);
  const children = archive.stats().inflight.children, open = s3.log.open;
  await g.close(); await archive.close();
  return { out, took, children, open };
}
test('hung S3 archive through the REAL composed gateway: refused at the deadline and its curl transfers are killed at once', async () => {
  const r = await hungArchiveCase(createWitnessGateway, s3WitnessCache);
  assert.equal(r.out.result, undefined);
  assert.match(r.out.error.message, /deadline/);
  assert.ok(r.took < 900, `answered at its deadline (${Math.round(r.took)} ms)`);
  assert.deepEqual([r.children, r.open], [0, 0], 'no curl process and no S3 connection left behind');
});
test('NEGATIVE CONTROL: E\'s exact afc443e0 gateway leaves the abandoned S3 transfer running after the request ended', async () => {
  const dir = path.join(TMP, 'e-afc443e0', 'network'); fs.mkdirSync(dir, { recursive: true });
  for (const f of ['witness-gateway.mjs', 'witness-verify.mjs', 'rpc-identity.mjs', 's3-witness-cache.mjs'])
    fs.writeFileSync(path.join(dir, f), execFileSync('git', ['show', `afc443e032647c2d8ea31535f5ff0f6609d99ba6:network/${f}`], { cwd: new URL('..', import.meta.url).pathname }));
  const { createWitnessGateway: eGateway } = await import(pathToFileURL(path.join(dir, 'witness-gateway.mjs')));
  const { s3WitnessCache: eCache } = await import(pathToFileURL(path.join(dir, 's3-witness-cache.mjs')));
  const r = await hungArchiveCase(eGateway, eCache);
  assert.equal(r.out.result, undefined, 'no late success there either');
  assert.ok(r.children >= 1 && r.open >= 1, `the abandoned curl transfer was still running (${r.children} process, ${r.open} connection)`);
});

test('a healthy concurrent caller keeps its in-flight archive read when another caller times out', async (t) => {
  const wa = witnessKey(A.method, A.params), wb = witnessKey(B.method, B.params);
  const objects = new Map([[objectKey(wb, B.result), envelope(wb, B.result)]]);
  const s3 = await s3Stub({ hang: (u) => (u.searchParams.get('prefix') || '').includes(wa.key), objects, getDelay: 350 });
  const archive = archiveOn(s3.endpoint);
  const g = createWitnessGateway({ upstreams: [DOWN], methods: NO_HINT, archive, proofs: { checker, roots: await roots() }, deadlineMs: 600, timeoutMs: 300 });
  closers.push(() => g.close());
  const t0 = performance.now();
  const pa = g.handle(req(A, 1)).then((o) => ({ o, at: performance.now() - t0 }));
  await sleep(300);
  const pb = g.handle(req(B, 2)).then((o) => ({ o, at: performance.now() - t0 }));
  const [ra, rb] = await Promise.all([pa, pb]);
  t.diagnostic(JSON.stringify({ a: ra, b: { at: rb.at, error: rb.o.error }, archive: archive.stats(), gateway: g.stats() }));
  assert.match(ra.o.error.message, /deadline/, 'A timed out on its hung archive read');
  assert.ok(ra.at < rb.at, 'A ended first, while B\'s S3 object transfer was in flight');
  assert.deepEqual(rb.o.result, B.result, 'B was served from the archive and verified by the real helper');
  assert.equal(g.stats().archiveHits, 1);
});

test('a call that expired in the gateway queue starts no upstream request and no S3 transfer', async () => {
  const s3 = await s3Stub({});
  const archive = archiveOn(s3.endpoint);
  const up = await honest(500);
  const g = createWitnessGateway({ upstreams: [up.url], methods: NO_HINT, archive, proofs: { checker, roots: await roots() }, maxInFlight: 1, deadlineMs: 300, timeoutMs: 300 });
  closers.push(() => g.close());
  const [x, y] = await Promise.all([g.handle(req(A, 1)), g.handle(req(B, 2))]);
  assert.match(x.error.message, /deadline/); assert.match(y.error.message, /deadline/);
  await sleep(50);
  assert.deepEqual([up.log.n, s3.log.requests], [1, 0], 'one upstream try (the running call), the queued call reached nothing');
});

test('failed optional caches (hung local cache, erroring archive) fall back to the upstreams; proofs are still checked', async () => {
  const s3 = await s3Stub({ status: 500 });
  const archive = archiveOn(s3.endpoint);
  const hungCache = { candidates: () => new Promise(() => {}), put: () => new Promise(() => {}) };   // SEAM: a cache that never answers
  const l = await liar(), h = await honest();
  const g = createWitnessGateway({ upstreams: [l.url, h.url], methods: NO_HINT, cache: hungCache, archive, proofs: { checker, roots: await roots() }, deadlineMs: 3000, timeoutMs: 1000, cacheTimeoutMs: 100 });
  closers.push(() => g.close());
  assert.deepEqual((await g.handle(req(B))).result, B.result);
  const [sl, sh] = Object.values(g.stats().upstream);
  assert.deepEqual([sl.invalid, sh.ok, g.stats().cacheTimeouts], [1, 1, 1]);
  const only = createWitnessGateway({ upstreams: [l.url], methods: NO_HINT, cache: hungCache, archive, proofs: { checker, roots: await roots() }, deadlineMs: 3000, timeoutMs: 1000, cacheTimeoutMs: 100 });
  closers.push(() => only.close());
  const r = await only.handle(req(B));
  assert.equal(r.result, undefined, 'the liar alone is refused even with every cache failing');
  assert.match(r.error.message, /no verifiable witness/);
});

test('terminal close: a request in an archive read ends at once, the archive and roots refuse later work, a late S3 answer changes nothing', async () => {
  const s3 = await s3Stub({ hang: () => true });
  const archive = s3WitnessCache({ endpoint: s3.endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, archive: true, timeoutMs: 4000, readBudgetMs: 8000 });
  const rs = await roots();
  const g = createWitnessGateway({ upstreams: [DOWN], methods: NO_HINT, archive, proofs: { checker, roots: rs }, deadlineMs: 5000, timeoutMs: 1000 });
  const p = g.handle(req(A));
  await sleep(200);
  assert.ok(archive.stats().inflight.children >= 1, 'the archive read is in flight');
  const t0 = performance.now();
  await g.close();
  const out = await p;
  assert.match(out.error.message, /closed/);
  assert.ok(performance.now() - t0 < 1500);
  await sleep(50);
  assert.equal(archive.stats().inflight.children, 0, 'closing the gateway killed its archive transfer');
  await archive.close(); rs.close();
  const before = s3.log.requests;
  assert.deepEqual(await archive.candidates(witnessKey(A.method, A.params)), []);
  await archive.put(witnessKey(A.method, A.params), A.result);
  assert.ok(archive.stats().putsSkipped >= 1);
  assert.match((await g.handle(req(A))).error.message, /closed/);
  assert.equal(await rs.rootFor(fixture.block.hash), null);
  assert.equal(s3.log.requests, before, 'no S3 request after close');
});

test('background archive writes stay bounded and never advance the root authority', async () => {
  const s3 = await s3Stub({});                             // PUTs hang
  const archive = archiveOn(s3.endpoint, { archive: true, maxInflightPuts: 1, maxQueuedPuts: 2, putTimeoutMs: 1000 });
  const h = await honest(), rs = await roots();
  const g = createWitnessGateway({ upstreams: [h.url], methods: NO_HINT, archive, proofs: { checker, roots: rs }, deadlineMs: 3000, timeoutMs: 1000 });
  closers.push(() => g.close());
  const reads = [...RECORDED.values()].filter((r) => r.method === 'eth_getProof').slice(0, 6);
  const t0 = performance.now();
  for (const r of reads) assert.deepEqual((await g.handle(req(r))).result, r.result);
  assert.ok(performance.now() - t0 < 2500, 'hung archive writes never delayed a verified read');
  const st = archive.stats();
  assert.ok(st.inflight.puts <= 1 && st.inflight.queued <= 2 && st.putsDropped >= 3, JSON.stringify(st));
  assert.deepEqual([rs.stats().verified, rs.stats().ancestors], [1, 0], 'writes bound no root and advanced nothing');
});

test('the local cache keeps to its configured byte budget: over it, writes are skipped and reads continue', async () => {
  assert.throws(() => dirWitnessCache(path.join(TMP, 'tiny'), { maxBytes: 1000 }), /maxBytes/);
  const dir = path.join(TMP, 'budget');
  const cache = dirWitnessCache(dir, { maxBytes: 1 << 20 });
  const body = A.result;
  for (let i = 0; i < 60; i++) await cache.put(witnessKey('eth_getProof', [`0x${String(i).padStart(40, '0')}`, [], fixture.block.hash]), body);
  const u = cache.usage();
  assert.ok(u.skippedOverBudget > 0 && u.usedBytes <= u.maxBytes, JSON.stringify(u));
  const fresh = dirWitnessCache(dir, { maxBytes: 1 << 20 }).usage();
  assert.ok(fresh.usedBytes <= 1 << 20, `measured on disk: ${fresh.usedBytes} bytes`);
  const w0 = witnessKey('eth_getProof', [`0x${'0'.repeat(40)}`, [], fixture.block.hash]);
  assert.deepEqual(await cache.candidates(w0), [body], 'reads continue');
});
