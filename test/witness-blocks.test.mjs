// Verified eth_getBlockByHash failover (network/witness-gateway.mjs blockByHash) with the REAL helper and REAL data:
// full-transaction RPC blocks derived offline from the 52 real signed Base gossip objects (witness-check exportBlock:
// Helios payload_to_block + canonical header, self-validated by Helios's OpStack::validate_block) are what an honest
// source answers. A wrong first source must cost only its try; nothing it says may be served, cached or used as a root.
// Boundary (asserted below, not hidden): a hash-only answer (fullTx=false) is HEADER-verified only.
//   env: WITNESS_CHECK_BIN, BASE_HEADS_DIR, TEST_TMP
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pad } from 'viem';
import { createWitnessGateway, dirWitnessCache, WITNESS_METHODS, VERIFIED_METHODS } from '../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';
import { BASE_MAINNET } from '../network/op-head-relay.mjs';

const { WITNESS_CHECK_BIN, BASE_HEADS_DIR } = process.env;
const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/base-headers-52965055-52965106.json', import.meta.url)));
const N = Object.fromEntries(FIX.headers.map((h) => [h.number, h]));
const BLOCKS = new Map();                                   // hash -> derived full-transaction RPC block
const NO_HINT = WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList');
const servers = [];
let checker;
test.before(async () => {
  checker = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: BASE_MAINNET.unsafeSigner });
  for (const f of fs.readdirSync(path.join(BASE_HEADS_DIR, 'objects'))) {
    const r = await checker.check({ op: 'exportBlock', object: '0x' + fs.readFileSync(path.join(BASE_HEADS_DIR, 'objects', f)).toString('hex') });
    assert.ok(r.ok, r.error);
    BLOCKS.set(r.block.hash, r.block);
  }
});
test.after(() => { checker?.close(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } });
function source(answer) {
  const seen = [];
  const s = http.createServer((q, res) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', async () => {
    const j = JSON.parse(b); seen.push(j.method);
    const out = await answer(j, res);
    if (out !== 'handled') res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, ...out }));
  }); });
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${s.address().port}/`, seen })));
}
const hashesOnly = (b) => ({ ...b, transactions: b.transactions.map((t) => t.hash) });
const honest = () => source((j) => { const b = BLOCKS.get(j.params[0]); return { result: b ? (j.params[1] ? b : hashesOnly(b)) : null }; });
const liar = (mutate) => source((j) => { const b = BLOCKS.get(j.params[0]); return { result: b ? mutate(structuredClone(j.params[1] ? b : hashesOnly(b)), j) : null }; });
function gateway(sources, opts = {}) {
  const roots = createRootStore({ checker });              // no head source: blocks must never create or need roots
  const dir = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'wb-'));
  const g = createWitnessGateway({ upstreams: sources.map((s) => s.url), methods: NO_HINT, cache: dirWitnessCache(dir), proofs: { checker, roots }, ...opts });
  return { g, roots, dir, st: () => Object.values(g.stats().upstream) };
}
const req = (hash, full = true, id = 1) => ({ jsonrpc: '2.0', id, method: 'eth_getBlockByHash', params: [hash, full] });
const H80 = N[52965080].hash;

test('real full blocks derived from the 52 signed gossip objects verify under Helios validate_block and hash to their canonical hashes', async () => {
  assert.equal(BLOCKS.size, 52);
  for (const h of FIX.headers) {
    const b = BLOCKS.get(h.hash);
    assert.ok(b, `block ${h.number}`);
    assert.deepEqual([b.stateRoot, b.parentHash, b.transactionsRoot], [h.stateRoot, h.parentHash, h.header.transactionsRoot]);
    const v = await checker.check({ op: 'block', block: b, expectHash: h.hash, fullTx: true });
    assert.ok(v.ok && v.body === 'full' && v.transactions === b.transactions.length, `${h.number}: ${v.error}`);
  }
  const txs = [...BLOCKS.values()].reduce((a, b) => a + b.transactions.length, 0);
  assert.ok(txs > 52, `${txs} real transactions across the 52 blocks`);
});

test('a wrong first source costs only its try: forged, mutated and wrong-body blocks are refused, the real block is served', async () => {
  const cases = [
    ['self-claimed hash over a mutated header', (b) => ({ ...b, gasUsed: '0x1' })],
    ['tampered state root', (b) => ({ ...b, stateRoot: pad('0x66', { size: 32 }) })],
    ['another real block (self-consistent) for the requested hash', () => BLOCKS.get(N[52965081].hash)],
    ['a dropped transaction', (b) => ({ ...b, transactions: b.transactions.slice(0, -1) })],
    ['swapped transactions', (b) => ({ ...b, transactions: [b.transactions[1], b.transactions[0], ...b.transactions.slice(2)] })],
    ['a tampered transaction input', (b) => { b.transactions.at(-1).input = '0x00'; return b; }],
    ['a transaction bound to another block', (b) => { b.transactions[0].blockHash = pad('0x77', { size: 32 }); return b; }],
    ['an uncle', (b) => ({ ...b, uncles: [pad('0x88', { size: 32 })] })],
    ['hashes instead of the full body', (b) => hashesOnly(b)],
    ['malformed', () => ({ hash: H80 })],
  ];
  for (const [name, mutate] of cases) {
    const l = await liar(mutate), o = await honest();
    const { g, roots, dir, st } = gateway([l, o]);
    const out = await g.handle(req(H80));
    assert.deepEqual(out.result, BLOCKS.get(H80), name);
    const [sl, so] = st();
    assert.deepEqual([sl.blockInvalid, sl.blockOk, so.blockOk], [1, 0, 1], name);
    // with ONLY the wrong source: refused, never served
    const alone = gateway([l]);
    const r = await alone.g.handle(req(H80));
    assert.equal(r.result, undefined, name);
    assert.match(r.error.message, /no verifiable block/, name);
    // nothing cached, nothing bound as a root
    assert.deepEqual([fs.readdirSync(dir).length, roots.stats().roots, roots.stats().ancestors], [0, 0, 0], name);
  }
});

test('FAILED CONTROL: without verification (no proofs: plain first-answer failover) the forged block IS served', async () => {
  const l = await liar((b) => ({ ...b, stateRoot: pad('0x66', { size: 32 }) })), o = await honest();
  const plain = createWitnessGateway({ upstreams: [l.url, o.url], methods: WITNESS_METHODS.filter((m) => !VERIFIED_METHODS.includes(m)) });
  const out = await plain.handle(req(H80));
  assert.equal(out.result.stateRoot, pad('0x66', { size: 32 }), 'the plain path returns the liar\'s forged block');
  assert.deepEqual(o.seen, [], 'and never asks the honest source');
  const verified = gateway([l, o]);
  assert.equal((await verified.g.handle(req(H80))).result.stateRoot, N[52965080].stateRoot);
});

test('null, oversize, hung and unavailable-verifier answers are bounded and fail closed', async (t) => {
  const nul = await source(() => ({ result: null })), o = await honest();
  const a = gateway([nul, o]);
  assert.deepEqual((await a.g.handle(req(H80))).result, BLOCKS.get(H80), 'null first, real second');
  assert.equal(a.st()[0].blockNull, 1);
  assert.equal((await gateway([nul]).g.handle(req(H80))).result, null, 'every source says null: null');
  const forged = await liar((b) => ({ ...b, gasUsed: '0x1' }));
  assert.match((await gateway([nul, forged]).g.handle(req(H80))).error.message, /no verifiable block/, 'null + forged: refused, not null');
  const huge = await source((j, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { ...BLOCKS.get(H80), pad: 'x'.repeat(3 << 20) } })); return 'handled'; });
  const hung = await source(() => new Promise(() => {}));
  const b = gateway([huge, hung, o], { maxResponseBytes: 2 << 20, timeoutMs: 300, deadlineMs: 10000 });
  assert.deepEqual((await b.g.handle(req(H80))).result, BLOCKS.get(H80));
  assert.deepEqual(b.st().map((x) => x.failed), [1, 1, 0]);
  const c = gateway([hung], { timeoutMs: 400, deadlineMs: 900 });
  const t0 = Date.now();
  assert.match((await c.g.handle(req(H80))).error.message, /no verifiable block/);
  assert.ok(Date.now() - t0 < 2000);
  const dead = createWitnessChecker({ bin: '/bin/false', chainId: 8453, signer: BASE_MAINNET.unsafeSigner });
  try {
    const d = createWitnessGateway({ upstreams: [o.url], methods: NO_HINT, proofs: { checker: dead, roots: createRootStore({ checker }) } });
    const r = await d.handle(req(H80));
    assert.equal(r.result, undefined);
    assert.match(r.error.message, /verifier unavailable/);
  } finally { dead.close(); }
  assert.equal((await a.g.handle({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByHash', params: [H80] })).error.code, -32602);
});

test('BOUNDARY: a hash-only answer (fullTx=false) is header-verified only; a wrong transaction-hash list is NOT detected', async () => {
  const mutated = await liar((b) => ({ ...b, gasUsed: '0x1' })), o = await honest();
  const { g, st } = gateway([mutated, o]);
  const out = await g.handle(req(H80, false));
  assert.deepEqual(out.result, hashesOnly(BLOCKS.get(H80)), 'a mutated header is still refused');
  assert.deepEqual(st().map((x) => x.blockInvalid), [1, 0]);
  assert.deepEqual([g.stats().blocksHeaderOnly, g.stats().blocksFull], [1, 0]);
  const wrongList = await liar((b) => ({ ...b, transactions: [pad('0x99', { size: 32 })] }));
  const w = gateway([wrongList, o]);
  assert.deepEqual((await w.g.handle(req(H80, false))).result.transactions, [pad('0x99', { size: 32 })],
    'header-only verification cannot check a hash list: this answer is accepted (Helios itself asks for full bodies)');
});
