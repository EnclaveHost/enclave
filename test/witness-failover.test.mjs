// Proof-aware failover and cache-poisoning resistance of network/witness-gateway.mjs, checked with the REAL native
// verifier (witness-check, built from the patched Helios fork: Helios's own commitment and proof code) against REAL
// recorded Base mainnet witnesses (block 52965249, rpc-priority fixture base-calls-20261023T014412Z). No injected
// validator: every accept/refuse below is the helper's verdict against the state root of a signed head.
// The head is signed by the fixture's TEST key (as in the replay E2E): this checks witness verification, not head
// authenticity. Upstreams are local stubs. Run offline (`unshare -r -n`).
//   env: WITNESS_CHECK_BIN, BASE_FIXTURE_DIR, TEST_TMP
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWitnessGateway, dirWitnessCache, witnessKey, WITNESS_METHODS } from '../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';

const { WITNESS_CHECK_BIN, BASE_FIXTURE_DIR } = process.env;
const fixture = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'fixture.json'), 'utf8'));
const HASH = fixture.block.hash;
const RECORDED = new Map();                     // witnessKey -> recorded real answer (from mainnet.base.org)
for (const f of fs.readdirSync(path.join(BASE_FIXTURE_DIR, 'cache', HASH))) {
  const e = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'cache', HASH, f), 'utf8'));
  const [method, params] = JSON.parse(e.request);
  RECORDED.set(witnessKey(method, params).key, { method, params, result: e.result });
}
const pick = (method, addr, nkeys) => [...RECORDED.values()].find((r) => r.method === method && r.params[0] === addr && (nkeys === undefined || r.params[1].length === nkeys));
const BOOK = '0xab214342d5a490150a4a977063a2f88e21f80907';
const PROOF = pick('eth_getProof', BOOK, 1), PROOF0 = pick('eth_getProof', BOOK, 0), CODE = pick('eth_getCode', BOOK);
const req = (r, id = 1) => ({ jsonrpc: '2.0', id, method: r.method, params: r.params });
const tmp = () => fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'wf-'));
const flipLast = (hex) => hex.slice(0, -1) + (hex.endsWith('0') ? '1' : '0');
const NO_HINT = WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList');

// Upstream stubs: `answer(j)` -> a JSON-RPC body object, or a function (req, res) taking over the response.
const servers = [];
function upstream(answer) {
  const seen = []; let active = 0, maxActive = 0;
  const s = http.createServer((q, res) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', async () => {
    const j = JSON.parse(b); seen.push(j.method); active++; maxActive = Math.max(maxActive, active);
    res.on('close', () => { active--; });
    const out = await answer(j);
    if (typeof out === 'function') return out(q, res);
    res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, ...out }));
  }); });
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ s, seen, url: `http://127.0.0.1:${s.address().port}/`, maxActive: () => maxActive })));
}
const good = () => upstream((j) => { const r = RECORDED.get(witnessKey(j.method, j.params)?.key); return r ? { result: r.result } : { error: { code: -32000, message: 'not recorded' } }; });
// a lying source: `mutate` rewrites its answers to `method` (default: every witness method); other answers stay recorded
const bad = (mutate, method) => upstream((j) => { const r = RECORDED.get(witnessKey(j.method, j.params)?.key); return r ? { result: !method || j.method === method ? mutate(structuredClone(r.result), j) : r.result } : { error: { code: -32000, message: 'not recorded' } }; });

let consensus, checker;
test.before(async () => {
  consensus = http.createServer((q, res) => res.end(JSON.stringify(q.url === '/chain_id' ? 8453 : fixture.commitment)));
  await new Promise((r) => consensus.listen(0, '127.0.0.1', r));
  checker = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: fixture.testSequencerSigner });
});
test.after(() => { checker?.close(); consensus?.close(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } });
const consensusUrl = () => `http://127.0.0.1:${consensus.address().port}/`;
function gw(upstreams, opts = {}) {
  const roots = createRootStore({ checker, consensusUrl: consensusUrl() });
  return createWitnessGateway({ upstreams: upstreams.map((u) => u.url), methods: NO_HINT, proofs: { checker, roots }, ...opts });
}

test('roots come only from a signed head verified by the native helper; a wrong signer yields no root and a refusal', async () => {
  const roots = createRootStore({ checker, consensusUrl: consensusUrl() });
  const r = await roots.rootFor(HASH);
  assert.equal(r.blockHash, HASH.toLowerCase());
  assert.equal(r.stateRoot, fixture.block.stateRoot.toLowerCase());
  assert.equal(r.number, fixture.block.number);
  const other = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: '0x' + '11'.repeat(20) });
  try {
    const wrong = createRootStore({ checker: other, consensusUrl: consensusUrl() });
    assert.equal(await wrong.rootFor(HASH), null);
    assert.equal(wrong.stats().refused, 1);
    const g0 = await good();
    const g = createWitnessGateway({ upstreams: [g0.url], methods: NO_HINT, proofs: { checker: other, roots: wrong } });
    const out = await g.handle(req(PROOF));
    assert.match(out.error.message, /no authenticated state root/);
    assert.deepEqual(g0.seen, [], 'no upstream is asked for a block without an authenticated root');
  } finally { other.close(); }
});

test("root's probe: a malformed first answer costs only that try; the second source's valid proof is served and cached", async (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = await bad(() => ({ accountProof: 'not-an-array' })), second = await good();
  const cache = dirWitnessCache(dir);
  const g = gw([first, second], { cache });
  const out = await g.handle(req(PROOF));
  assert.deepEqual(out.result, PROOF.result);
  assert.deepEqual([first.seen, second.seen], [['eth_getProof'], ['eth_getProof']]);
  await g.settled();                                       // verified answers are written in the background
  const st = g.stats();
  assert.deepEqual(Object.values(st.upstream).map((x) => [x.ok, x.invalid]), [[0, 1], [1, 0]]);
  const w = witnessKey(PROOF.method, PROOF.params);
  assert.deepEqual(await cache.candidates(w), [PROOF.result], 'only the verified answer was stored');
});

test('cryptographically invalid but well-formed answers are refused, each in favour of the next source', async (t) => {
  const g1 = await good();
  const cases = [
    ['tampered account proof node', PROOF, (r) => { r.accountProof[r.accountProof.length - 1] = flipLast(r.accountProof[r.accountProof.length - 1]); return r; }],
    ['tampered storage value', PROOF, (r) => { r.storageProof[0].value = '0x1234'; return r; }],
    ['forged balance', PROOF, (r) => { r.balance = '0xde0b6b3a7640000'; return r; }],
    ['proof for another account', PROOF0, () => pick('eth_getProof', '0x4200000000000000000000000000000000000015', 0).result],
    ['an extra, unrequested storage proof', PROOF0, (r) => { r.storageProof = PROOF.result.storageProof; return r; }],
    ['a requested storage proof missing', PROOF, (r) => { r.storageProof = []; return r; }],
    ['code that does not hash to the proven code hash', CODE, (r) => flipLast(r)],
    ['empty code for an account with code', CODE, () => '0x'],
    ['null', PROOF, () => null],
  ];
  for (const [name, rec, mutate] of cases) {
    const b = await bad(mutate, rec.method);
    const g = gw([b, g1]);
    const out = await g.handle(req(rec));
    assert.deepEqual(out.result, rec.result, name);
    const [sb, sg] = Object.values(g.stats().upstream);
    assert.equal(sb.invalid, 1, `${name}: the bad source was judged invalid`);
    assert.equal(sg.invalid, 0, name);
    // and with ONLY the bad source, nothing is returned
    const alone = gw([b]);
    const refused = await alone.handle(req(rec));
    assert.equal(refused.result, undefined, name);
    assert.match(refused.error.message, /no verifiable witness/, name);
  }
});

test('valid proofs need not be byte-identical: a differently encoded valid answer is accepted on its merits', async () => {
  // same proof, other spellings: upper-case hex digits in the address and in every proof node
  const b = await bad((r) => ({ ...r, address: '0x' + r.address.slice(2).toUpperCase(),
    accountProof: r.accountProof.map((n) => '0x' + n.slice(2).toUpperCase()) }));
  const g = gw([b]);
  const out = await g.handle(req(PROOF));
  assert.ok(out.result, out.error?.message);
  assert.notDeepEqual(out.result, PROOF.result);
  assert.equal(Object.values(g.stats().upstream)[0].ok, 1);
});

test('the cache: a bad first write never shadows a verified entry; cache-only later serves verified data and quarantines the rest', async (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = witnessKey(PROOF.method, PROOF.params), wc = witnessKey(CODE.method, CODE.params);
  // root's probe exactly: the earlier gateway's single-slot create-only file holds the malformed first answer ...
  fs.mkdirSync(path.join(dir, w.blockHash), { recursive: true });
  fs.writeFileSync(path.join(dir, w.blockHash, w.key + '.json'), JSON.stringify({ format: 'enclave-witness-rpc/v1', request: w.norm, result: { accountProof: 'not-an-array' } }));
  // ... and a tampered store adds a well-formed forgery under its own (correct) content address
  const cache = dirWitnessCache(dir);
  await cache.put(wc, flipLast(CODE.result));
  const forgedProof = structuredClone(PROOF.result); forgedProof.balance = '0x1';
  await cache.put(w, forgedProof);
  // a gateway with a bad and a good source verifies, serves and stores the good answers
  const b = await bad(() => ({ accountProof: 'not-an-array' })), g1 = await good();
  const g = gw([b, g1], { cache });
  for (const r of [PROOF, CODE]) assert.deepEqual((await g.handle(req(r))).result, r.result);
  assert.equal(g.stats().cacheInvalid, 3, 'the legacy malformed entry and both forgeries were checked and quarantined');
  // later, every source is gone: a fresh cache-only gateway serves exactly the verified answers
  await g.settled();
  const later = gw([], { cache: dirWitnessCache(dir) });
  for (const r of [PROOF, CODE]) assert.deepEqual((await later.handle(req(r))).result, r.result, r.method);
  const st = later.stats();
  assert.equal(st.unavailable, 0);
  assert.equal(st.cacheHits, 2, JSON.stringify(st));
  // nothing was ever overwritten: the malformed legacy file and the forgeries are still there, just never served
  assert.match(fs.readFileSync(path.join(dir, w.blockHash, w.key + '.json'), 'utf8'), /not-an-array/);
  assert.equal((await dirWitnessCache(dir).candidates(w)).length, 3);
  // a cache holding only bad entries refuses
  const onlyBad = tmp(); t.after(() => fs.rmSync(onlyBad, { recursive: true, force: true }));
  await dirWitnessCache(onlyBad).put(w, forgedProof);
  const refused = await gw([], { cache: dirWitnessCache(onlyBad) }).handle(req(PROOF));
  assert.equal(refused.result, undefined);
  assert.match(refused.error.message, /no verifiable witness/);
});

test('cache entries are content-addressed, create-only and bound to their request', async (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cache = dirWitnessCache(dir), w = witnessKey(PROOF.method, PROOF.params);
  await cache.put(w, PROOF.result); await cache.put(w, PROOF.result);
  const files = fs.readdirSync(path.join(dir, w.blockHash, w.key));
  assert.deepEqual(files, [createHash('sha256').update(JSON.stringify(PROOF.result)).digest('hex') + '.json'], 'one immutable entry, no temp files');
  // a file whose name is not the hash of its content, or whose request differs, is not a candidate
  fs.writeFileSync(path.join(dir, w.blockHash, w.key, '0'.repeat(64) + '.json'), JSON.stringify({ format: 'enclave-witness-rpc/v1', request: w.norm, result: { x: 1 } }));
  const other = { x: 2 };
  fs.writeFileSync(path.join(dir, w.blockHash, w.key, createHash('sha256').update(JSON.stringify(other)).digest('hex') + '.json'),
    JSON.stringify({ format: 'enclave-witness-rpc/v1', request: '["eth_getProof",[]]', result: other }));
  assert.deepEqual(await cache.candidates(w), [PROOF.result]);
});

test('requests not pinned by block hash are refused; every refusal is an error, never an unchecked answer', async () => {
  const g1 = await good();
  const g = gw([g1]);
  const out = await g.handle({ jsonrpc: '2.0', id: 1, method: 'eth_getProof', params: [BOOK, [], 'latest'] });
  assert.equal(out.error.code, -32602);
  assert.deepEqual(g1.seen, []);
  assert.throws(() => createWitnessGateway({ upstreams: [g1.url] }), /need proofs/);
  assert.throws(() => createWitnessGateway({ upstreams: [g1.url], methods: ['eth_chainId'], cache: dirWitnessCache(tmp()) }), /need proofs/);
});

test('bounds: oversized bodies are cut off while reading, hung sources cost one timeout, the request deadline holds', async (t) => {
  let sentBytes = 0, closedEarly = false;
  const huge = await upstream(() => (q, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const pump = () => { while (sentBytes < 256 << 20) { sentBytes += chunk.length; if (!res.write(chunk)) { res.once('drain', pump); return; } } res.end(); };
    res.on('close', () => { if (sentBytes < 256 << 20) closedEarly = true; });
    res.write('{"jsonrpc":"2.0","id":1,"result":"'); pump();
  });
  const declared = await upstream(() => (q, res) => { res.writeHead(200, { 'content-length': String(64 << 20) }); res.write('{'); });
  const hung = await upstream(() => () => {});
  const g1 = await good();
  const g = gw([huge, declared, hung, g1], { maxResponseBytes: 1 << 20, timeoutMs: 400, deadlineMs: 5000 });
  const t0 = Date.now();
  assert.deepEqual((await g.handle(req(PROOF))).result, PROOF.result);
  assert.ok(Date.now() - t0 < 4000);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(closedEarly && sentBytes < 64 << 20, `the oversized stream was abandoned early (${sentBytes} bytes offered)`);
  const fails = Object.values(g.stats().upstream).map((x) => x.failed);
  assert.deepEqual(fails, [1, 1, 1, 0]);
  // with only hung sources the whole request ends at its deadline
  const g2 = gw([hung, (await upstream(() => () => {}))], { timeoutMs: 600, deadlineMs: 800 });
  const t1 = Date.now();
  assert.match((await g2.handle(req(PROOF))).error.message, /deadline exceeded/, 'refused as a deadline, not as a source verdict');
  assert.ok(Date.now() - t1 < 1000, `deadline held (${Date.now() - t1} ms)`);
});

test('bounds: upstream requests in flight are capped across a batch', async () => {
  const slow = await upstream(async (j) => { await new Promise((r) => setTimeout(r, 60)); const r = RECORDED.get(witnessKey(j.method, j.params)?.key); return r ? { result: r.result } : { error: { code: -32000, message: 'x' } }; });
  const g = gw([slow], { maxInFlight: 2 });
  const proofs = [...RECORDED.values()].filter((r) => r.method === 'eth_getProof').slice(0, 10);
  const out = await Promise.all(proofs.map((r, i) => g.handle(req(r, i))));
  assert.ok(out.every((o, i) => JSON.stringify(o.result) === JSON.stringify(proofs[i].result)));
  assert.ok(slow.maxActive() <= 2, `max in flight ${slow.maxActive()}`);
});

test('an unavailable or hung verifier fails closed: refusal, never the unverified answer', async (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hang = path.join(dir, 'hang.sh');
  fs.writeFileSync(hang, '#!/bin/sh\nexec cat >/dev/null\n', { mode: 0o755 });
  const g1 = await good();
  for (const bin of ['/bin/false', hang]) {
    const c = createWitnessChecker({ bin, chainId: 8453, signer: fixture.testSequencerSigner, timeoutMs: 500 });
    try {
      // the real checker still authenticates the root; only the proof verifier is broken
      const roots = createRootStore({ checker, consensusUrl: consensusUrl() });
      const g = createWitnessGateway({ upstreams: [g1.url], methods: NO_HINT, proofs: { checker: c, roots } });
      const out = await g.handle(req(PROOF));
      assert.equal(out.result, undefined, bin);
      assert.match(out.error.message, /verifier unavailable/, bin);
    } finally { c.close(); }
  }
});
