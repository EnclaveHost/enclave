// Whole-operation deadlines and lifecycle of network/witness-gateway.mjs + network/witness-verify.mjs, over REAL loopback
// HTTP upstreams (fake JSON-RPC servers; nothing touches a chain), with the REAL witness-check helper and real recorded
// Base witnesses where verification is involved. Explicit stand-ins (labelled SEAM) are used only to force a hang that
// the real helper/cache cannot produce on demand. Includes root's repro (root-witness-deadline-review/probe.mjs) and
// its NEGATIVE CONTROL on the exact 7b4e8c68 gateway source.
//   env: WITNESS_CHECK_BIN, BASE_FIXTURE_DIR, BASE_HEADS_DIR, TEST_TMP
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createWitnessGateway, dirWitnessCache, witnessKey, WITNESS_METHODS } from '../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';
import { BASE_MAINNET } from '../network/op-head-relay.mjs';

const { WITNESS_CHECK_BIN, BASE_FIXTURE_DIR, BASE_HEADS_DIR } = process.env;
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'deadline-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
let checker;
test.before(() => { checker = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'fixture.json'))).testSequencerSigner }); });
test.after(() => { checker?.close(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } fs.rmSync(TMP, { recursive: true, force: true }); });
/** A loopback JSON-RPC server: answer(j) -> {result|error} after `delay(j)` ms; records start times and aborted requests. */
function upstream(answer, delay = () => 0) {
  const log = { started: [], aborted: 0, methods: [] };
  const s = http.createServer((q, res) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => {
    const j = JSON.parse(b); log.started.push(performance.now()); log.methods.push(j.method);
    let done = false;
    res.on('close', () => { if (!done) log.aborted++; });
    setTimeout(() => { done = true; if (!res.destroyed) res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, ...answer(j) })); }, delay(j));
  }); });
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${s.address().port}/`, log })));
}
const rpc = (method, params = [], id = 1) => ({ jsonrpc: '2.0', id, method, params });

// ---- root's repro, with the negative control on the exact reviewed source
async function repro(createGateway) {
  const up = await upstream(() => ({ result: '0x2105' }), () => 100);
  const g = createGateway({ upstreams: [up.url], methods: ['eth_chainId'], maxInFlight: 1, deadlineMs: 150, timeoutMs: 150 });
  const began = performance.now();
  const replies = await Promise.all([1, 2, 3].map(async (id) => ({ id, response: await g.handle(rpc('eth_chainId', [], id)), completedMs: Math.round(performance.now() - began) })));
  await g.close();
  const events = up.log.started.map((t) => Math.round(t - began));
  return { events, replies, violation: events.some((e) => e > 150) && replies.some((r) => r.response.result && r.completedMs > 200) };
}
test('ROOT REPRO: 3 concurrent reads, maxInFlight 1, deadline 150 ms: nothing starts after its deadline, no success after it', async (t) => {
  const r = await repro(createWitnessGateway);
  t.diagnostic(JSON.stringify(r));
  assert.equal(r.violation, false);
  assert.ok(r.events.every((e) => e <= 160), `upstream starts ${r.events}`);
  assert.equal(r.events.length, 2, 'the third read expired in the queue and never reached the upstream');
  assert.ok(r.replies[0].response.result === '0x2105' && r.replies[0].completedMs < 150);
  for (const x of r.replies.slice(1)) {
    assert.match(x.response.error?.message ?? '', /deadline/, `reply ${x.id}`);
    assert.ok(x.completedMs <= 200, `reply ${x.id} answered at its deadline (${x.completedMs} ms)`);
  }
});
test('NEGATIVE CONTROL: the exact 7b4e8c68 gateway reproduces root\'s violation', async (t) => {
  const old = path.join(TMP, 'old', 'network'); fs.mkdirSync(old, { recursive: true });
  for (const f of ['witness-gateway.mjs', 'witness-verify.mjs', 'rpc-identity.mjs'])
    fs.writeFileSync(path.join(old, f), execFileSync('git', ['show', `7b4e8c68a91f24cdfd844f623ed4047beb17e79c:network/${f}`], { cwd: new URL('..', import.meta.url).pathname }));
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(old, 'witness-gateway.mjs'))).digest('hex'), 'e33d8a4bbe3b2f1e81dd632074c0b6fd9e0890ce15697f3821e10ccf37b9668c');
  const { createWitnessGateway: oldGateway } = await import(pathToFileURL(path.join(old, 'witness-gateway.mjs')));
  const r = await repro(oldGateway);
  t.diagnostic(JSON.stringify(r));
  assert.equal(r.violation, true, 'the third read starts after its deadline and still succeeds');
});

test('a request that expired in the queue never reaches the upstream; a running one returns no late success and its fetch is aborted', async () => {
  const up = await upstream(() => ({ result: '0x1' }), () => 400);
  const g = createWitnessGateway({ upstreams: [up.url], methods: ['eth_chainId'], maxInFlight: 1, deadlineMs: 200, timeoutMs: 200 });
  const t0 = performance.now();
  const [a, b] = await Promise.all([g.handle(rpc('eth_chainId', [], 1)), g.handle(rpc('eth_chainId', [], 2))]);
  const took = performance.now() - t0;
  assert.match(a.error.message, /deadline/); assert.match(b.error.message, /deadline/);
  assert.ok(took < 320, `both answered at the deadline (${Math.round(took)} ms)`);
  await sleep(50);
  assert.equal(up.log.started.length, 1, 'the queued request never reached the upstream');
  assert.equal(up.log.aborted, 1, 'the running request was aborted, not left to finish');
  assert.deepEqual([g.stats().active, g.stats().queued, g.stats().deadlineExceeded], [0, 0, 2]);
  await g.close();
});

test('SEAM: a custom fetch that ignores abort keeps its slot until it settles, but its late answer is never served', async () => {
  let release;
  const stuck = new Promise((r) => { release = r; });
  const fakeFetch = async () => { await stuck; return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xlate' })); };   // ignores the signal
  const g = createWitnessGateway({ upstreams: ['http://127.0.0.1:9/'], methods: ['eth_chainId'], maxInFlight: 1, deadlineMs: 150, timeoutMs: 150, fetch: fakeFetch });
  const t0 = performance.now();
  const r = await g.handle(rpc('eth_chainId'));
  assert.match(r.error.message, /deadline/);
  assert.ok(performance.now() - t0 < 260);
  assert.equal(g.stats().active, 1, 'the slot stays taken while the ignoring source has not settled (bounded by maxInFlight)');
  const second = await g.handle(rpc('eth_chainId', [], 2));
  assert.match(second.error.message, /deadline/, 'a waiter behind it expires in the queue');
  release(); await sleep(20);
  assert.deepEqual([g.stats().active, g.stats().queued, Object.values(g.stats().upstream)[0].ok], [0, 0, 0], 'the late answer changed nothing');
  await g.close();
});

test('a transaction is never sent to another upstream after the deadline, and no late result is returned (fake HTTP only)', async () => {
  const slow = await upstream(() => ({ result: '0x' + 'aa'.repeat(32) }), () => 400), next = await upstream(() => ({ result: '0x' + 'aa'.repeat(32) }));
  const g = createWitnessGateway({ upstreams: [slow.url, next.url], methods: ['eth_sendRawTransaction'], deadlineMs: 200, timeoutMs: 200 });
  const r = await g.handle(rpc('eth_sendRawTransaction', ['0x02']));
  assert.match(r.error.message, /deadline/);
  await sleep(50);
  assert.deepEqual([slow.log.started.length, next.log.started.length], [1, 0], 'nothing was sent after the deadline');
  await g.close();
});

// ---- verification paths with the real helper and real recorded witnesses (block 52965249, test-signed head)
const fixture = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'fixture.json'), 'utf8'));
const RECORDED = new Map();
for (const f of fs.readdirSync(path.join(BASE_FIXTURE_DIR, 'cache', fixture.block.hash))) {
  const e = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'cache', fixture.block.hash, f), 'utf8'));
  const [method, params] = JSON.parse(e.request);
  RECORDED.set(witnessKey(method, params).key, { method, params, result: e.result });
}
const proofReq = (addr, id = 1) => { const r = [...RECORDED.values()].find((x) => x.method === 'eth_getProof' && x.params[0] === addr && x.params[1].length === 0); return { r, req: rpc(r.method, r.params, id) }; };
async function verifyingGateway(opts = {}, chk = checker) {
  const roots = createRootStore({ checker: chk });
  assert.ok(await roots.offer(fixture.commitment));
  const good = await upstream((j) => { const r = RECORDED.get(witnessKey(j.method, j.params)?.key); return r ? { result: r.result } : { error: { code: -32000, message: 'x' } }; }, opts.delay ?? (() => 0));
  const g = createWitnessGateway({ upstreams: [good.url], methods: WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList'), proofs: { checker: chk, roots }, ...opts.gateway });
  return { g, roots, good };
}

test('SEAM: a hanging cache read is skipped after cacheTimeoutMs and a hanging cache write never delays a verified read', async () => {
  const hang = () => new Promise(() => {});
  const cache = { candidates: hang, put: hang };            // SEAM: a cache that never answers (e.g. a hung archive tier)
  const { g, good } = await verifyingGateway({ gateway: { cache, cacheTimeoutMs: 100, deadlineMs: 3000, timeoutMs: 1000 } });
  const { r, req } = proofReq('0xab214342d5a490150a4a977063a2f88e21f80907');
  const t0 = performance.now();
  const out = await g.handle(req);
  assert.deepEqual(out.result, r.result, 'served from the upstream, verified by the real helper');
  assert.ok(performance.now() - t0 < 1000, 'the hung cache cost one cacheTimeoutMs, not the deadline');
  assert.deepEqual([g.stats().cacheTimeouts, g.stats().cacheWrites, good.log.started.length], [1, 1, 1]);
  const t1 = performance.now();
  await g.close();                                          // bounded wait for the abandoned write
  assert.ok(performance.now() - t1 < 1500);
});

test('real shared helper: one caller\'s abort drops only its check; a concurrent read is verified; close() is terminal', async () => {
  const { r, req } = proofReq('0xab214342d5a490150a4a977063a2f88e21f80907');
  const root = { blockHash: fixture.block.hash, stateRoot: fixture.block.stateRoot };
  const ac = new AbortController(); ac.abort(new Error('caller gone'));
  await assert.rejects(checker.check({ op: 'getProof', ...root, params: r.params, result: r.result }, { signal: ac.signal }), /caller gone/);
  const ac2 = new AbortController();
  const a = checker.check({ op: 'getProof', ...root, params: r.params, result: r.result }, { signal: ac2.signal });
  const b = checker.check({ op: 'getProof', ...root, params: r.params, result: r.result });
  ac2.abort(new Error('caller A expired'));
  await assert.rejects(a, /caller A expired/);
  assert.equal((await b).ok, true, 'the other caller\'s check was answered by the same helper');
  assert.equal(checker.stats().pending, 0);
  const own = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: fixture.testSequencerSigner });
  assert.equal((await own.check({ op: 'version' })).ok, true);
  own.close();
  await assert.rejects(own.check({ op: 'version' }), /closed/);
  await sleep(100);
  assert.deepEqual([own.stats().running, own.stats().closed], [false, true], 'no restart after a terminal close, even after the old child exits');
});

test('SEAM: a helper check that hangs for one request is cut at that request\'s deadline; a concurrent read is unaffected', async () => {
  // SEAM: a checker that hangs (until aborted) for one address and delegates everything else to the REAL helper
  const HANG = '0x4200000000000000000000000000000000000015';
  const seam = { check: (req, o) => (req.params?.[0] === HANG ? new Promise((_, rej) => o?.signal?.addEventListener('abort', () => rej(o.signal.reason), { once: true })) : checker.check(req, o)) };
  const { g } = await verifyingGateway({ gateway: { deadlineMs: 400, timeoutMs: 300 } }, seam);
  const hung = proofReq(HANG, 1), fine = proofReq('0xab214342d5a490150a4a977063a2f88e21f80907', 2);
  const t0 = performance.now();
  const [x, y] = await Promise.all([g.handle(hung.req), g.handle(fine.req)]);
  assert.match(x.error.message, /deadline/);
  assert.ok(performance.now() - t0 < 600);
  assert.deepEqual(y.result, fine.r.result, 'the concurrent read was verified by the real helper');
  await g.close();
});

test('gateway close(): queued and running requests end promptly, queued ones never reach an upstream, new work is refused', async () => {
  const up = await upstream(() => ({ result: '0x1' }), () => 1000);
  const g = createWitnessGateway({ upstreams: [up.url], methods: ['eth_chainId'], maxInFlight: 1, deadlineMs: 5000, timeoutMs: 5000 });
  const all = Promise.all([1, 2, 3].map((id) => g.handle(rpc('eth_chainId', [], id))));
  await sleep(50);
  const t0 = performance.now();
  await g.close();
  const out = await all;
  assert.ok(performance.now() - t0 < 1300);
  assert.ok(out.every((o) => /closed/.test(o.error?.message)), JSON.stringify(out));
  assert.equal(up.log.started.length, 1);
  assert.match((await g.handle(rpc('eth_chainId'))).error.message, /closed/);
  assert.deepEqual([g.stats().active, g.stats().queued], [0, 0]);
});

// ---- root store: close, late polls, shared walks (real helper, real headers and heads)
const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/base-headers-52965055-52965106.json', import.meta.url)));
const BY_HASH = new Map(FIX.headers.map((h) => [h.hash, h])), N = Object.fromEntries(FIX.headers.map((h) => [h.number, h]));
let real, head106;
async function realHead() {
  real ??= createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: BASE_MAINNET.unsafeSigner });
  if (!head106) for (const f of fs.readdirSync(path.join(BASE_HEADS_DIR, 'objects'))) {
    const r = await real.check({ op: 'exportHeader', object: '0x' + fs.readFileSync(path.join(BASE_HEADS_DIR, 'objects', f)).toString('hex') });
    if (r.ok && r.head.number === 52965106) head106 = r.commitment;
  }
  return { real, head106 };
}
test.after(() => real?.close());

test('root store close(): an in-flight poll is aborted, a late answer binds nothing, and no new poll or check is made', async () => {
  const { real, head106 } = await realHead();
  // a consensus head API (GET /latest) that answers too late
  const consensus = { log: { started: [], aborted: 0 } };
  const cs = http.createServer((q, res) => { consensus.log.started.push(performance.now()); let done = false;
    res.on('close', () => { if (!done) consensus.log.aborted++; });
    setTimeout(() => { done = true; if (!res.destroyed) res.end(JSON.stringify(head106)); }, 500); });
  servers.push(cs);
  await new Promise((r) => cs.listen(0, '127.0.0.1', r));
  const roots = createRootStore({ checker: real, consensusUrl: `http://127.0.0.1:${cs.address().port}/` });
  const p = roots.refresh();
  await sleep(50);
  roots.close();
  assert.equal(await p, null);
  await sleep(600);
  assert.deepEqual([roots.stats().roots, roots.stats().closed], [0, true]);
  assert.equal(await roots.rootFor(N[52965106].hash), null);
  assert.equal(await roots.offer(head106), null);
  assert.equal(await roots.refresh(), null);
  roots.start(10); await sleep(60);
  assert.equal(consensus.log.started.length, 1, 'no poll after close');
  assert.equal(consensus.log.aborted, 1, 'the in-flight poll was aborted');
});

/** The root store's `headers` interface over a real HTTP source and the REAL helper (as the gateway's own path does). */
const headerSource = (url, chk) => async (hash, child, { signal }) => {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(rpc('eth_getBlockByHash', [hash, false])), signal });
  const j = await res.json();
  if (!j.result) return null;
  const v = await chk.check({ op: 'header', header: j.result, expectHash: hash, child }, { signal });
  return v.ok ? { head: v, header: j.result } : null;
};
test('shared ancestry walk: one caller giving up does not cancel it for another; when the last caller goes, the walk stops', async () => {
  const { real, head106 } = await realHead();
  const src = await upstream((j) => ({ result: BY_HASH.get(j.params[0])?.header ?? null }), () => 15);
  const roots = createRootStore({ checker: real });
  assert.ok(await roots.offer(head106));
  const headers = headerSource(src.url, real);
  const quitter = new AbortController();
  const a = roots.rootFor(N[52965080].hash, { headers, deadline: Date.now() + 10000, signal: quitter.signal });
  const b = roots.rootFor(N[52965080].hash, { headers, deadline: Date.now() + 10000 });
  await sleep(60);
  quitter.abort(new Error('caller A gave up'));
  await assert.rejects(a, /caller A gave up/);
  assert.equal((await b)?.stateRoot, N[52965080].stateRoot, 'caller B got the authenticated root from the same walk');
  assert.equal(src.log.started.length, 26, 'one walk: guide + 25 parents');
  // the only caller leaves: the walk is aborted and stops fetching
  const roots2 = createRootStore({ checker: real });
  assert.ok(await roots2.offer(head106));
  const only = new AbortController();
  const c = roots2.rootFor(N[52965060].hash, { headers, deadline: Date.now() + 10000, signal: only.signal });
  await sleep(120);
  only.abort(new Error('last caller gone'));
  await assert.rejects(c, /last caller gone/);
  await sleep(60);
  const stopped = src.log.started.length;
  await sleep(250);
  assert.equal(src.log.started.length, stopped, 'no header request after the last caller left');
  assert.ok(stopped - 26 < 46, `the abandoned walk stopped early (${stopped - 26} of 46 requests)`);
  assert.equal(roots2.stats().recovering, 0);
});
