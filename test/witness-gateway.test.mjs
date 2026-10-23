// network/witness-gateway.mjs: allowlist, ordered failover, block-hash-pinned cache (create-only, outage fallback only),
// broadcast fan-out and refusal when every upstream is down. Upstreams are local stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWitnessGateway, dirWitnessCache, witnessKey } from '../network/witness-gateway.mjs';

const H = '0x' + 'ab'.repeat(32);
function stub(answer) {
  const seen = [];
  const s = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const j = JSON.parse(b); seen.push(j.method);
    const out = answer(j);
    if (out === 500) { res.writeHead(500).end(); return; }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, ...out }));
  }); });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ s, seen, url: `http://127.0.0.1:${s.address().port}/` })));
}
const req = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const tmp = () => fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'wg-'));

test('only block-hash-pinned proof and code requests are cache keys', () => {
  assert.ok(witnessKey('eth_getProof', ['0x' + '01'.repeat(20), [], { blockHash: H }]));
  assert.ok(witnessKey('eth_getCode', ['0x' + '01'.repeat(20), { blockHash: H, requireCanonical: false }]));
  assert.equal(witnessKey('eth_getProof', ['0x' + '01'.repeat(20), [], 'latest']), null);
  assert.equal(witnessKey('eth_getProof', ['0x' + '01'.repeat(20), [], '0x10']), null);
  assert.equal(witnessKey('eth_getProof', ['0x' + '01'.repeat(20), [], { blockNumber: '0x10' }]), null);
  assert.equal(witnessKey('eth_call', [{}, { blockHash: H }]), null);
  // case does not split keys
  assert.equal(witnessKey('eth_getCode', ['0xAB' + '01'.repeat(19), { blockHash: H.toUpperCase().replace('0X', '0x') }]).key, witnessKey('eth_getCode', ['0xab' + '01'.repeat(19), { blockHash: H }]).key);
});

test('methods outside the witness allowlist are refused without touching an upstream', async (t) => {
  const up = await stub(() => ({ result: '0x1' }));
  t.after(() => up.s.close());
  const g = createWitnessGateway({ upstreams: [up.url] });
  for (const m of ['eth_accounts', 'eth_sign', 'debug_traceTransaction', 'admin_peers', 'eth_call', 'personal_unlockAccount'])
    assert.equal((await g.handle(req(m, []))).error.code, -32601, m);
  assert.deepEqual(up.seen, []);
  assert.equal((await g.handle({ id: 1, method: 'eth_chainId' })).error.code, -32600);
});

test('upstreams are tried in order; a failed or erroring one costs a try, not the answer', async (t) => {
  const a = await stub(() => 500), b = await stub(() => ({ error: { code: -32000, message: 'missing trie node' } })), c = await stub(() => ({ result: '0x2105' }));
  t.after(() => { a.s.close(); b.s.close(); c.s.close(); });
  const g = createWitnessGateway({ upstreams: [a.url, b.url, c.url] });
  assert.equal((await g.handle(req('eth_chainId', []))).result, '0x2105');
  const st = g.stats();
  assert.deepEqual(Object.values(st.upstream).map((x) => [x.ok, x.failed]), [[0, 1], [0, 1], [1, 0]]);
});

test('pinned witnesses are cached create-only and served from the cache only when every upstream fails', async (t) => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let value = '0xproof-1', up = await stub((j) => ({ result: j.method === 'eth_getProof' ? { v: value } : '0x1' }));
  const cache = dirWitnessCache(dir);
  const g = createWitnessGateway({ upstreams: [up.url], cache });
  const p = req('eth_getProof', ['0x' + '01'.repeat(20), ['0x0'], { blockHash: H }]);
  assert.deepEqual((await g.handle(p)).result, { v: '0xproof-1' });
  await new Promise((r) => setTimeout(r, 50));
  value = '0xproof-2';                                  // upstream answers differently: upstream wins while it is up
  assert.deepEqual((await g.handle(p)).result, { v: '0xproof-2' });
  await new Promise((r) => setTimeout(r, 50));
  up.s.close();                                         // every upstream down
  assert.deepEqual((await g.handle(p)).result, { v: '0xproof-1' }, 'create-only: the first entry stands');
  assert.equal(g.stats().cacheHits, 1);
  // a request at a block NUMBER is never cached, so it is simply unavailable now
  assert.match((await g.handle(req('eth_getProof', ['0x' + '01'.repeat(20), ['0x0'], 'latest']))).error.message, /no witness source answered/);
  // an entry whose recorded request differs (a misfiled or tampered file) is a miss
  const w = witnessKey(p.method, p.params);
  const f = path.join(dir, w.blockHash, w.key + '.json');
  fs.writeFileSync(f, JSON.stringify({ format: 'enclave-witness-rpc/v1', request: '["eth_getProof",[]]', result: { v: 'evil' } }));
  assert.match((await g.handle(p)).error.message, /no witness source answered/);
});

test('a transaction goes to every upstream; with every upstream down nothing is sent and the caller is told', async (t) => {
  const a = await stub(() => ({ result: '0x' + 'cd'.repeat(32) })), b = await stub(() => ({ result: '0x' + 'cd'.repeat(32) }));
  const g = createWitnessGateway({ upstreams: [a.url, b.url] });
  assert.equal((await g.handle(req('eth_sendRawTransaction', ['0x02']))).result, '0x' + 'cd'.repeat(32));
  assert.deepEqual([a.seen, b.seen], [['eth_sendRawTransaction'], ['eth_sendRawTransaction']]);
  a.s.close(); b.s.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.match((await g.handle(req('eth_sendRawTransaction', ['0x02']))).error.message, /nothing was sent/);
});

test('the HTTP endpoint is loopback-only, bounds bodies and answers batches', async (t) => {
  const up = await stub(() => ({ result: '0x2105' }));
  const g = createWitnessGateway({ upstreams: [up.url] });
  const url = await g.listen(0);
  t.after(async () => { await g.close(); up.s.close(); });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const r = await (await fetch(url, { method: 'POST', body: JSON.stringify([req('eth_chainId', [], 1), req('eth_accounts', [], 2)]) })).json();
  assert.equal(r[0].result, '0x2105'); assert.equal(r[1].error.code, -32601);
  assert.equal((await fetch(url, { method: 'POST', body: 'x'.repeat((1 << 20) + 10) }).catch(() => ({ status: 413 }))).status, 413);
  assert.equal((await fetch(url)).status, 405);
});

test('configuration refuses plain-http public upstreams and duplicates', () => {
  assert.throws(() => createWitnessGateway({ upstreams: ['http://rpc.example.org'] }), /./);
  assert.throws(() => createWitnessGateway({ upstreams: ['https://rpc.example.org/a', 'https://RPC.example.org/b'] }), /distinct/);
});
