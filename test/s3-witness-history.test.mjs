// ANCESTRY + ARCHIVE, composed, offline (`unshare -r -n`): P's verifying gateway with authenticated ancestry
// (network/witness-gateway.mjs headers + network/witness-verify.mjs createRootStore) and the S3 archive tier
// (network/s3-witness-cache.mjs) on a REAL S3 server (MinIO), with the REAL native checker (witness-check, Helios
// aca81764). Upstreams are local stubs; "down" = a closed loopback port.
//   * REAL Base mainnet heads and headers (52 signed v4 gossip objects 52965055..52965106, real unsafe signer;
//     test/fixtures/base-headers-52965055-52965106.json): HEADER/ANCESTRY BINDING ONLY, these blocks have no proofs.
//   * Proofs at a recovered root: SYNTHETIC authority and block identity (P's labelled fixture
//     test/fixtures/base-header-52965249.synthetic.json: the real block's header fields and REAL state root under a
//     recomputed hash, child 250' signed by the TEST key), with the REAL recorded witnesses of block 52965249.
// Nothing here is a real-history proof recording; nothing proves freshness.
//   env: WITNESS_CHECK_BIN, BASE_HEADS_DIR, BASE_FIXTURE_DIR, MINIO_BIN, TEST_TMP
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { numberToHex, pad } from 'viem';
import { createWitnessGateway, witnessKey, WITNESS_METHODS } from '../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';
import { BASE_MAINNET } from '../network/op-head-relay.mjs';
import { s3WitnessCache, canonicalJson } from '../network/s3-witness-cache.mjs';
import { makeCommitment, blockFields } from './fixtures/op-commitment.mjs';
import { startMinio, raw, listAll, envelope, fakeS3, freePort, testCredentials } from './support/s3-test-env.mjs';

const { WITNESS_CHECK_BIN, BASE_HEADS_DIR, BASE_FIXTURE_DIR } = process.env;
const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/base-headers-52965055-52965106.json', import.meta.url)));
const BY_HASH = new Map(FIX.headers.map((h) => [h.hash, h]));
const N = (n) => FIX.headers.find((h) => h.number === 52965000 + n);
const SY = JSON.parse(fs.readFileSync(new URL('./fixtures/base-header-52965249.synthetic.json', import.meta.url))).headers[0];
const fixture = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'fixture.json'), 'utf8'));
const TEST_KEY = '0x' + '5e'.repeat(32);                   // record-base-calls.mjs's public test key (synthetic authority)
const NO_HINT = WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList');
const BOOK = '0xab214342d5a490150a4a977063a2f88e21f80907';
const RECORDED = new Map();
for (const f of fs.readdirSync(path.join(BASE_FIXTURE_DIR, 'cache', fixture.block.hash))) {
  const e = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'cache', fixture.block.hash, f), 'utf8'));
  const [method, params] = JSON.parse(e.request);
  RECORDED.set(witnessKey(method, params).key, { method, params, result: e.result });
}
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'history-'));
const CREDS = testCredentials();
const nameOf = (r) => createHash('sha256').update(canonicalJson(r)).digest('hex');
const headerW = (hash) => { const norm = JSON.stringify(['eth_getBlockByHash', [hash, false]]); return { key: createHash('sha256').update(norm).digest('hex'), blockHash: hash, norm }; };
const headerObject = (prefix, hash, h) => `${prefix}/8453/${hash}/${headerW(hash).key}/${nameOf(h)}.json`;
/** a tampered header (state root replaced, hash field kept) whose content name sorts BEFORE the genuine one */
function forgedHeaderFirst(h) {
  for (let i = 1; ; i++) { const f = { ...h, stateRoot: pad(numberToHex(i), { size: 32 }) }; if (nameOf(f) < nameOf(h)) return f; }
}
// witness params pinned to block 249' (SY.hash) <-> the recorded params pinned to the real block (same state root)
const pinTo = (params, hash) => params.map((x, i) => (i < params.length - 1 ? x : typeof x === 'string' ? hash : { ...x, blockHash: hash }));
const recordedFor = (j) => RECORDED.get(witnessKey(j.method, pinTo(j.params, fixture.block.hash))?.key);

const servers = [];
function upstream(answer) {
  const seen = [];
  const s = http.createServer((q, res) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
    const j = JSON.parse(b); seen.push(j.method);
    const out = answer(j); if (out === 'hang') return;
    res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, ...out }));
  }); });
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ seen, url: `http://127.0.0.1:${s.address().port}/` })));
}
/** honest Base headers, and for block 249' its synthetic header plus the recorded witnesses */
const honest = () => upstream((j) => {
  if (j.method === 'eth_getBlockByHash') return { result: j.params[0] === SY.hash ? SY.header : BY_HASH.get(j.params[0])?.header ?? null };
  const r = recordedFor(j);
  return r ? { result: r.result } : { error: { code: -32000, message: 'not recorded' } };
});
const down = async () => ({ url: `http://127.0.0.1:${await freePort()}/` });   // closed port: every request refused

let consensusUrl, current = null, real, synth, s3;
const commitments = new Map();
test.before(async () => {
  real = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: BASE_MAINNET.unsafeSigner });
  synth = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: fixture.testSequencerSigner });
  for (const f of fs.readdirSync(path.join(BASE_HEADS_DIR, 'objects'))) {
    const r = await real.check({ op: 'exportHeader', object: '0x' + fs.readFileSync(path.join(BASE_HEADS_DIR, 'objects', f)).toString('hex') });
    assert.ok(r.ok, r.error);
    commitments.set(r.head.number, r.commitment);
  }
  const c = http.createServer((q, res) => res.end(JSON.stringify(q.url === '/chain_id' ? 8453 : current)));
  servers.push(c);
  await new Promise((r) => c.listen(0, '127.0.0.1', r));
  consensusUrl = `http://127.0.0.1:${c.address().port}/`;
  s3 = await startMinio({ dir: path.join(TMP, 'minio'), creds: CREDS });
});
test.after(() => { real?.close(); synth?.close(); s3?.stop(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } fs.rmSync(TMP, { recursive: true, force: true }); });
const head = (n) => commitments.get(52965000 + n);
const archiveOf = (prefix, o = {}) => s3WitnessCache({ endpoint: s3.endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, prefix, ...o });
function gateway(sources, { checker = real, ...opts } = {}) {
  const roots = createRootStore({ checker, consensusUrl });                // cold: it sees only what it polls when asked
  const g = createWitnessGateway({ upstreams: sources.map((s) => s.url), methods: NO_HINT, proofs: { checker, roots }, ...opts });
  return { g, roots };
}
/** fill `prefix` through the verifying gateway from an honest upstream: the headers of the walk 106 -> 80 */
async function fillHeaders(prefix) {
  current = head(106);
  const writer = archiveOf(prefix, { archive: true });
  const { g } = gateway([await honest()], { archive: writer });
  assert.equal((await g.root(N(80).hash)).stateRoot, N(80).stateRoot);
  await writer.idle();
  const st = writer.stats();
  await writer.close();
  return st;
}
const T = { timeout: 120000 };

test('real Base ancestry with every upstream down: a missed block\'s root is recovered from verified archived headers, anchored on the current signed head', T, async () => {
  const filled = await fillHeaders('h1');
  assert.equal(filled.puts, 26, 'guide header for 80 + the walk 105..81, each verified before it was archived');
  assert.deepEqual(await listAll(s3, CREDS, `h1/8453/${N(80).hash}/${headerW(N(80).hash).key}/`), [headerObject('h1', N(80).hash, N(80).header)]);
  // "restart": new checker client state, root store, gateway and archive client; the only upstream is down
  current = head(106);
  const archive = archiveOf('h1');
  const { g, roots } = gateway([await down()], { archive });
  const r = await g.root(N(80).hash);
  assert.deepEqual([r.stateRoot, r.via, r.boundTo], [N(80).stateRoot, 'ancestor', N(81).hash]);
  const st = g.stats();
  assert.deepEqual([st.archiveHeaderHits, st.archiveHeaderInvalid, Object.values(st.upstream)[0].failed], [26, 0, 26]);
  assert.deepEqual([roots.stats().verified, roots.stats().ancestors], [1, 26], 'one signed head (106), 26 hash-linked ancestors');
  assert.ok(Object.isFrozen(r) && !('fresh' in r), 'history for that block, never freshness');
  await archive.close();
});

test('forged archived headers: first-sorting tampered headers are refused and never mask the valid ones; a missing link or a header for another hash is refused', T, async () => {
  await fillHeaders('h2');
  const walk = [80, ...Array.from({ length: 25 }, (_, i) => 105 - i)];   // guide 80, then 105..81
  for (const n of walk) {
    const f = forgedHeaderFirst(N(n).header);
    assert.equal((await raw(s3, CREDS, { method: 'PUT', key: headerObject('h2', N(n).hash, f), body: envelope(headerW(N(n).hash), f) })).status, 200);
  }
  current = head(106);
  const a = gateway([await down()], { archive: archiveOf('h2') });
  assert.equal((await a.g.root(N(80).hash)).stateRoot, N(80).stateRoot);
  assert.deepEqual([a.g.stats().archiveHeaderInvalid, a.g.stats().archiveHeaderHits], [26, 26], 'every forgery checked and quarantined, every genuine header used');
  // the genuine header of 95 deleted, its forgery left: the walk cannot pass 95
  assert.equal((await raw(s3, CREDS, { method: 'DELETE', key: headerObject('h2', N(95).hash, N(95).header) })).status, 204);
  const b = gateway([await down()], { archive: archiveOf('h2') });
  assert.equal(await b.g.root(N(80).hash), null);
  assert.equal(b.roots.stats().ancestryRefused.unavailable, 1);
  assert.equal(b.roots.stats().ancestors, 10, 'only 105..96 bound; nothing below the gap');
  // a genuine header filed under another block's hash (correct content name): refused by the hash check
  const other = N(70).header;
  await raw(s3, CREDS, { method: 'PUT', key: headerObject('h2x', N(100).hash, other), body: envelope(headerW(N(100).hash), other) });
  const c = gateway([await down()], { archive: archiveOf('h2x') });
  assert.equal(await c.g.root(N(100).hash), null);
  assert.equal(c.g.stats().archiveHeaderInvalid, 1);
  // and the witness path refuses with it: no root, no answer
  const out = await c.g.handle({ jsonrpc: '2.0', id: 1, method: 'eth_getProof', params: [BOOK, [], { blockHash: N(100).hash }] });
  assert.match(out.error.message, /no authenticated state root/);
});

test('no archived or stale root becomes authority: no signed head = nothing recovered; above the current head = refused; a wrong signer is refused', T, async () => {
  await fillHeaders('h3');
  // the consensus source has no head: the archive is not even asked
  current = null;
  const archive = archiveOf('h3');
  const a = gateway([await down()], { archive });
  assert.equal(await a.g.root(N(80).hash), null);
  assert.equal(a.roots.stats().ancestryRefused['no-bound-head'], 1);
  assert.equal(archive.stats().lists, 0, 'no S3 read without an anchor');
  // an OLDER head is current (80): block 100's header is archived, but nothing signed is above it
  current = head(80);
  const b = gateway([await down()], { archive: archiveOf('h3') });
  assert.equal(await b.g.root(N(100).hash), null);
  assert.equal(b.roots.stats().ancestryRefused['newer-than-every-bound-head'], 1);
  // a head signed by the wrong key (TEST key, real checker): refused, so archived headers anchor nothing
  current = await makeCommitment(blockFields(N(106).header), { chainId: 8453, privateKey: TEST_KEY });
  const c = gateway([await down()], { archive: archiveOf('h3') });
  assert.equal(await c.g.root(N(80).hash), null);
  assert.equal(c.roots.stats().refused, 1);
  assert.equal(c.roots.stats().verified, 0);
  await archive.close();
});

test('whole path, real proofs at a recovered root (SYNTHETIC authority): every upstream down, 249\' recovered from its archived header under TEST-signed 250\', all real witnesses served from the archive, first-sorting forgeries quarantined', T, async (t) => {
  const c249 = await makeCommitment(blockFields(SY.header), { chainId: 8453, privateKey: TEST_KEY });
  const c250 = await makeCommitment(blockFields({ ...SY.header, number: numberToHex(SY.number + 1), parentHash: SY.hash,
    timestamp: numberToHex(SY.timestamp + 2), hash: pad('0xc1', { size: 32 }) }), { chainId: 8453, privateKey: TEST_KEY });
  assert.equal((await synth.check({ op: 'exportHeader', commitment: c249 })).header.stateRoot, fixture.block.stateRoot, '249\' carries the real state root');
  const all = [...RECORDED.values()].sort((a, b) => (a.method === 'eth_getCode') - (b.method === 'eth_getCode'))
    .map((r) => ({ ...r, params: pinTo(r.params, SY.hash) }));
  // fill through the verifying gateway (root by ancestry from the honest upstream's header)
  current = c250;
  const writer = archiveOf('h4', { archive: true, maxQueuedPuts: 256 });
  const fill = gateway([await honest()], { checker: synth, archive: writer });
  for (const r of all) assert.deepEqual((await fill.g.handle({ jsonrpc: '2.0', id: 1, method: r.method, params: r.params })).result, r.result, r.method);
  await writer.idle();
  assert.equal(writer.stats().puts, RECORDED.size + 1, 'every verified witness + the verified header of 249\'');
  await writer.close();
  // an attacker with bucket write access plants a first-sorting forged header for 249' and a forged proof
  const fh = forgedHeaderFirst(SY.header);
  await raw(s3, CREDS, { method: 'PUT', key: headerObject('h4', SY.hash, fh), body: envelope(headerW(SY.hash), fh) });
  const P = all.find((r) => r.method === 'eth_getProof' && r.params[0] === BOOK && r.params[1].length === 1), pw = witnessKey(P.method, P.params);
  let fp; for (let i = 1n; ; i++) { fp = structuredClone(P.result); fp.balance = '0x' + (BigInt(P.result.balance) + i).toString(16); if (nameOf(fp) < nameOf(P.result)) break; }
  await raw(s3, CREDS, { method: 'PUT', key: `h4/8453/${pw.blockHash}/${pw.key}/${nameOf(fp)}.json`, body: envelope(pw, fp) });
  // cold: no upstream answers; head moved on to 250'
  const archive = archiveOf('h4');
  t.after(() => archive.close());
  const cold = gateway([await down()], { checker: synth, archive });
  for (const r of all) assert.deepEqual((await cold.g.handle({ jsonrpc: '2.0', id: 1, method: r.method, params: r.params })).result, r.result, r.method);
  const st = cold.g.stats(), rs = cold.roots.stats();
  t.diagnostic(`gateway: ${JSON.stringify({ archiveHits: st.archiveHits, archiveInvalid: st.archiveInvalid, archiveHeaderHits: st.archiveHeaderHits, archiveHeaderInvalid: st.archiveHeaderInvalid })}; roots: ${JSON.stringify(rs)}`);
  assert.deepEqual([st.archiveHits, st.archiveInvalid, st.archiveHeaderHits, st.archiveHeaderInvalid, st.unavailable], [RECORDED.size, 1, 1, 1, 0]);
  assert.deepEqual([rs.verified, rs.ancestors], [1, 1]);
  const r = await cold.g.root(SY.hash);
  assert.deepEqual([r.via, r.boundTo, r.stateRoot], ['ancestor', pad('0xc1', { size: 32 }), fixture.block.stateRoot]);
  // the archive never answers for a block it has no bound descendant for: 249' as the CURRENT head is not needed,
  // but an unrelated hash is refused, not answered
  const absent = await cold.g.handle({ jsonrpc: '2.0', id: 1, method: 'eth_getProof', params: [BOOK, [], { blockHash: pad('0xee', { size: 32 }) }] });
  assert.equal(absent.result, undefined);
});

test('slow, hung or unavailable S3 during ancestry: archived-header writes never delay a recovery from live upstreams; with every upstream down the refusal is bounded; close() reaps every S3 child', T, async (t) => {
  current = head(106);
  const h = await honest();
  const base = gateway([h]);
  let t0 = Date.now();
  assert.equal((await base.g.root(N(80).hash)).stateRoot, N(80).stateRoot);
  const plain = Date.now() - t0;
  const hung = await fakeS3(() => {});                                       // accepts, never answers
  t.after(() => hung.close());
  const deadPort = await freePort();
  for (const [name, endpoint] of [['hung', hung.endpoint], ['unavailable', `http://127.0.0.1:${deadPort}`]]) {
    const archive = s3WitnessCache({ endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, archive: true, timeoutMs: 1000, readBudgetMs: 1500, putTimeoutMs: 30000 });
    const live = gateway([h], { archive, timeoutMs: 1000, deadlineMs: 10000 });
    t0 = Date.now();
    assert.equal((await live.g.root(N(80).hash)).stateRoot, N(80).stateRoot, name);
    const took = Date.now() - t0;
    assert.ok(took < plain + 1000, `${name}: recovery not held by archive writes (${took} ms vs ${plain} ms without an archive)`);
    assert.equal(live.g.stats().archiveQueued, 26);
    // every upstream down and the store hung/unavailable: the deadline bounds the whole walk
    const cold = gateway([await down()], { archive, timeoutMs: 1000, deadlineMs: 3000 });
    t0 = Date.now();
    assert.equal(await cold.g.root(N(80).hash), null, name);
    assert.ok(Date.now() - t0 < 4500, `${name}: refusal within the deadline (${Date.now() - t0} ms)`);
    if (name === 'hung') assert.ok(archive.stats().inflight.children > 0, 'hung uploads still in flight before close');
    await archive.close();
    assert.equal(archive.stats().inflight.children, 0, `${name}: every S3 request reaped on close`);
    t.diagnostic(`${name}: recovery ${took} ms (no archive ${plain} ms); stats ${JSON.stringify(archive.stats().errors)}`);
  }
});
