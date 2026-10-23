// The COMPOSED path, offline (`unshare -r -n`): P's verifying gateway (network/witness-gateway.mjs) with its REAL
// native checker (witness-check, built from Helios 1ec2c1a) and root store, plus the S3 archive tier
// (network/s3-witness-cache.mjs) on a REAL S3 server (MinIO), against REAL recorded Base mainnet witnesses
// (block 52965249, fixture base-calls-20261023T014412Z). Upstream witness sources are local stubs, as in P's tests.
// The head is signed by the fixture's TEST key (Helios unsafe_signer override in the fixture): this checks witness
// verification and the archive's availability semantics, not head authenticity or freshness.
//   env: WITNESS_CHECK_BIN, BASE_FIXTURE_DIR, MINIO_BIN, TEST_TMP
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWitnessGateway, dirWitnessCache, witnessKey, WITNESS_METHODS } from '../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';
import { s3WitnessCache, canonicalJson } from '../network/s3-witness-cache.mjs';
import { startMinio, raw, listAll, envelope, fakeS3, freePort, sleep, testCredentials } from './support/s3-test-env.mjs';

const { WITNESS_CHECK_BIN, BASE_FIXTURE_DIR } = process.env;
const fixture = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'fixture.json'), 'utf8'));
const HASH = fixture.block.hash;
const RECORDED = new Map();
for (const f of fs.readdirSync(path.join(BASE_FIXTURE_DIR, 'cache', HASH))) {
  const e = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'cache', HASH, f), 'utf8'));
  const [method, params] = JSON.parse(e.request);
  RECORDED.set(witnessKey(method, params).key, { method, params, result: e.result });
}
const BOOK = '0xab214342d5a490150a4a977063a2f88e21f80907';
const pick = (method, addr, nkeys) => [...RECORDED.values()].find((r) => r.method === method && r.params[0] === addr && (nkeys === undefined || r.params[1].length === nkeys));
const PROOF = pick('eth_getProof', BOOK, 1), CODE = pick('eth_getCode', BOOK);
const req = (r, id = 1) => ({ jsonrpc: '2.0', id, method: r.method, params: r.params });
const NO_HINT = WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList');
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'archive-'));
const CREDS = testCredentials();
const nameOf = (r) => createHash('sha256').update(canonicalJson(r)).digest('hex');
const folder = (w) => `enclave-witness/8453/${w.blockHash}/${w.key}/`;

const servers = [];
function upstream(answer) {
  const seen = [];
  const s = http.createServer((q, res) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
    const j = JSON.parse(b); seen.push(j.method);
    const out = answer(j); if (typeof out === 'function') return out(q, res);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, ...out }));
  }); });
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ seen, url: `http://127.0.0.1:${s.address().port}/` })));
}
const honest = () => upstream((j) => { const r = RECORDED.get(witnessKey(j.method, j.params)?.key); return r ? { result: r.result } : { error: { code: -32000, message: 'not recorded' } }; });
const forgedBalance = (r) => { const v = structuredClone(r); v.balance = '0x' + (BigInt(v.balance) + 1n).toString(16); return v; };
const liar = () => upstream((j) => { const r = RECORDED.get(witnessKey(j.method, j.params)?.key); return r ? { result: j.method === 'eth_getProof' ? forgedBalance(r.result) : r.result + '00' } : { error: { code: -32000, message: 'x' } }; });
/** a forged eth_getProof answer whose content name sorts BEFORE the valid one (ground by varying the forged balance) */
function forgedFirst(valid) {
  for (let i = 1n; ; i++) { const v = structuredClone(valid); v.balance = '0x' + (BigInt(valid.balance) + i).toString(16); if (nameOf(v) < nameOf(valid)) return v; }
}

let consensus, checker, s3;
test.before(async () => {
  consensus = http.createServer((q, res) => res.end(JSON.stringify(q.url === '/chain_id' ? 8453 : fixture.commitment)));
  await new Promise((r) => consensus.listen(0, '127.0.0.1', r));
  checker = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: fixture.testSequencerSigner });
  s3 = await startMinio({ dir: path.join(TMP, 'minio'), creds: CREDS });
});
test.after(() => { checker?.close(); consensus?.close(); s3?.stop(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } fs.rmSync(TMP, { recursive: true, force: true }); });
const proofs = () => ({ checker, roots: createRootStore({ checker, consensusUrl: `http://127.0.0.1:${consensus.address().port}/` }) });
const archiveOf = (o = {}) => s3WitnessCache({ endpoint: s3.endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, ...o });
const gw = (ups, o = {}) => createWitnessGateway({ upstreams: ups.map((u) => u.url), methods: NO_HINT, proofs: proofs(), ...o });
const T = { timeout: 120000 };

test('upstream forged-first, honest-second: the honest answer is served and ONLY it is archived', T, async () => {
  const [l, h] = [await liar(), await honest()];
  const archive = archiveOf({ archive: true, prefix: 'a1' });
  const g = gw([l, h], { archive });
  for (const r of [PROOF, CODE]) assert.deepEqual((await g.handle(req(r))).result, r.result, r.method);
  await archive.idle();
  for (const r of [PROOF, CODE]) {
    const w = witnessKey(r.method, r.params);
    const keys = await listAll(s3, CREDS, `a1/8453/${w.blockHash}/${w.key}/`);
    assert.deepEqual(keys, [`a1/8453/${w.blockHash}/${w.key}/${nameOf(r.result)}.json`], `${r.method}: exactly the verified answer`);
  }
  assert.equal(g.stats().archiveQueued, 2);
  assert.ok(Object.values(g.stats().upstream)[0].invalid >= 2, 'the liar was judged invalid');
});

test('bad-first valid-second in S3: a forged candidate that sorts first is checked, quarantined and never masks the valid one', T, async () => {
  const w = witnessKey(PROOF.method, PROOF.params);
  const forged = forgedFirst(PROOF.result);
  const pfx = `a2/8453/${w.blockHash}/${w.key}/`;
  for (const v of [forged, PROOF.result]) assert.equal((await raw(s3, CREDS, { method: 'PUT', key: pfx + nameOf(v) + '.json', body: envelope(w, v) })).status, 200);
  assert.ok(nameOf(forged) < nameOf(PROOF.result));
  const g = gw([], { archive: archiveOf({ prefix: 'a2' }) });           // restart/cache-only: no upstream at all
  assert.deepEqual((await g.handle(req(PROOF))).result, PROOF.result);
  const st = g.stats();
  assert.deepEqual([st.archiveInvalid, st.archiveHits], [1, 1], JSON.stringify(st));
  // only the forgery: refused, never returned
  const only = `a3/8453/${w.blockHash}/${w.key}/`;
  await raw(s3, CREDS, { method: 'PUT', key: only + nameOf(forged) + '.json', body: envelope(w, forged) });
  const refused = await gw([], { archive: archiveOf({ prefix: 'a3' }) }).handle(req(PROOF));
  assert.equal(refused.result, undefined);
  assert.match(refused.error.message, /no verifiable witness/);
});

test('a poisoned version-1 legacy object plus a valid new object: the valid one is served; legacy-only poison is refused', T, async () => {
  const w = witnessKey(PROOF.method, PROOF.params);
  // the first S3 backend's single-slot object holds a forged answer (an older, unverifying writer kept the first answer)
  await raw(s3, CREDS, { method: 'PUT', key: `a4/8453/${w.blockHash}/${w.key}.json`, body: envelope(w, forgedBalance(PROOF.result)) });
  const g0 = gw([], { archive: archiveOf({ prefix: 'a4' }) });
  const out0 = await g0.handle(req(PROOF));
  assert.equal(out0.result, undefined, 'legacy poison alone: refused');
  assert.equal(g0.stats().archiveInvalid, 1);
  // a verified writer adds the valid answer under its content name; the legacy slot no longer matters
  const h = await honest();
  const writer = archiveOf({ archive: true, prefix: 'a4' });
  assert.deepEqual((await gw([h], { archive: writer }).handle(req(PROOF))).result, PROOF.result);
  await writer.idle();
  const g1 = gw([], { archive: archiveOf({ prefix: 'a4' }) });
  assert.deepEqual((await g1.handle(req(PROOF))).result, PROOF.result);
  assert.deepEqual([g1.stats().archiveHits, g1.stats().archiveInvalid], [1, 0], 'the content-addressed object is tried before the legacy slot');
  assert.match((await raw(s3, CREDS, { method: 'GET', key: `a4/8453/${w.blockHash}/${w.key}.json` })).body.toString(), /balance/, 'the poisoned object was not overwritten or deleted');
});

test('restart replay: a cold gateway with no upstream serves every witness of the real block from S3, all verified', T, async () => {
  const h = await honest();
  const writer = archiveOf({ archive: true, prefix: 'a5', maxQueuedPuts: 256 });
  const g = gw([h], { archive: writer });
  const all = [...RECORDED.values()].sort((a, b) => (a.method === 'eth_getCode') - (b.method === 'eth_getCode'));   // proofs first
  for (const r of all) assert.deepEqual((await g.handle(req(r))).result, r.result, r.method);
  await writer.idle();
  assert.equal(writer.stats().puts, RECORDED.size, JSON.stringify(writer.stats()));
  // "restart": new checker client, new root store, new gateway, new archive client, no upstream
  const cold = gw([], { archive: archiveOf({ prefix: 'a5' }) });
  for (const r of all) assert.deepEqual((await cold.handle(req(r))).result, r.result, r.method);
  assert.equal(cold.stats().archiveHits, RECORDED.size);
  assert.equal(cold.stats().unavailable, 0);
  // a request the archive never saw is refused, not answered
  const absent = await cold.handle(req({ method: 'eth_getProof', params: [BOOK, ['0x' + '00'.repeat(31) + '07'], { blockHash: HASH }] }));
  assert.match(absent.error.message, /no verifiable witness/);
});

test('slow, hung or unavailable S3 never delays or fails a fresh read; with no upstream it is a bounded refusal', T, async (t) => {
  const h = await honest();
  const hung = await fakeS3(() => {});                                       // accepts, never answers (list, get or put)
  t.after(() => hung.close());
  const deadPort = await freePort();
  for (const [name, endpoint] of [['hung', hung.endpoint], ['unavailable', `http://127.0.0.1:${deadPort}`]]) {
    const archive = s3WitnessCache({ endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, archive: true, timeoutMs: 1000, readBudgetMs: 1500, putTimeoutMs: 30000 });
    const g = gw([h], { archive, timeoutMs: 1000, deadlineMs: 5000 });
    for (const r of [PROOF, CODE]) {
      const t0 = Date.now();
      assert.deepEqual((await g.handle(req(r))).result, r.result, `${name} ${r.method}`);
      assert.ok(Date.now() - t0 < 1500, `${name}: fresh read not held by the archive (${Date.now() - t0} ms)`);
    }
    const cold = gw([], { archive, deadlineMs: 2500, timeoutMs: 1000 });
    const t1 = Date.now();
    const out = await cold.handle(req(PROOF));
    assert.equal(out.result, undefined, name);
    assert.match(out.error.message, /no verifiable witness/, name);
    assert.ok(Date.now() - t1 < 3500, `${name}: refusal within the deadline (${Date.now() - t1} ms)`);
    await archive.close();
    assert.equal(archive.stats().inflight.children, 0, `${name}: every S3 request reaped on close`);
  }
});

test('audit with the REAL backend on a hung S3: in the CACHE slot (read before upstreams) it delays every fresh read; in the ARCHIVE slot it does not', T, async (t) => {
  const hung = await fakeS3(() => {});                                       // accepts, never answers
  t.after(() => hung.close());
  const h = await honest();
  const mk = () => s3WitnessCache({ endpoint: hung.endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, archive: true, timeoutMs: 1000, readBudgetMs: 1500 });
  const asCache = mk(), asArchive = mk();
  t.after(() => Promise.all([asCache.close(), asArchive.close()]));
  const slow = gw([h], { cache: asCache, timeoutMs: 1000, deadlineMs: 10000 });
  const t0 = Date.now();
  assert.deepEqual((await slow.handle(req(PROOF))).result, PROOF.result);
  const held = Date.now() - t0;
  assert.ok(held >= 900, `cache slot: the remote read held the fresh answer ${held} ms`);
  const fast = gw([h], { archive: asArchive, timeoutMs: 1000, deadlineMs: 10000 });
  const t1 = Date.now();
  assert.deepEqual((await fast.handle(req(PROOF))).result, PROOF.result);
  const quick = Date.now() - t1;
  assert.ok(quick < 500, `archive slot: not held (${quick} ms)`);
  t.diagnostic(`cache slot ${held} ms; archive slot ${quick} ms (the awaited-put audit of the first backend: jobs/audit-b71c8261.sh)`);
});

test('the archive is only a last resort: a local cache hit or a healthy upstream never queries S3', T, async () => {
  const dir = path.join(TMP, 'local'); fs.mkdirSync(dir);
  const archive = archiveOf({ archive: true, prefix: 'a6' });
  const h = await honest();
  const g = gw([h], { cache: dirWitnessCache(dir), archive });
  assert.deepEqual((await g.handle(req(PROOF))).result, PROOF.result);          // upstream answer (archived, not read)
  assert.deepEqual((await g.handle(req(PROOF))).result, PROOF.result);          // local cache hit
  await archive.idle();
  assert.deepEqual([archive.stats().lists, archive.stats().puts], [0, 1], 'S3 read metadata only leaves the node during an upstream outage');
});

test('the archive requires the verifier: no proofs, no archive', () => {
  assert.throws(() => createWitnessGateway({ upstreams: [], methods: ['eth_chainId'], archive: { candidates() {}, put() {} } }), /need proofs/);
  assert.throws(() => createWitnessGateway({ upstreams: [], methods: ['eth_chainId'], archive: { get() {} } }), /candidates/);
});
