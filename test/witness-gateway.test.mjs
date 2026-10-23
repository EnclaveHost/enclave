// network/witness-gateway.mjs: allowlist, ordered failover for the methods Helios verifies itself, broadcast fan-out and
// refusal when every upstream is down. Upstreams are local stubs. Verified witnesses (eth_getProof/eth_getCode) and the
// cache need the real verifier: test/witness-failover.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWitnessGateway, witnessKey, WITNESS_METHODS, VERIFIED_METHODS } from '../network/witness-gateway.mjs';

const PLAIN = WITNESS_METHODS.filter((m) => !VERIFIED_METHODS.includes(m));

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

test('only block-hash-pinned proof and code requests are cache keys', () => {
  assert.ok(witnessKey('eth_getProof', ['0x' + '01'.repeat(20), [], { blockHash: H }]));
  assert.ok(witnessKey('eth_getCode', ['0x' + '01'.repeat(20), { blockHash: H, requireCanonical: false }]));
  assert.equal(witnessKey('eth_getProof', ['0x' + '01'.repeat(20), [], H]).blockHash, H, 'bare hash (alloy without requireCanonical)');
  assert.equal(witnessKey('eth_getProof', ['0x' + '01'.repeat(20), [], H]).key, witnessKey('eth_getProof', ['0x' + '01'.repeat(20), [], H]).key);
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
  const g = createWitnessGateway({ upstreams: [up.url], methods: PLAIN });
  for (const m of ['eth_accounts', 'eth_sign', 'debug_traceTransaction', 'admin_peers', 'eth_call', 'personal_unlockAccount'])
    assert.equal((await g.handle(req(m, []))).error.code, -32601, m);
  assert.deepEqual(up.seen, []);
  assert.equal((await g.handle({ id: 1, method: 'eth_chainId' })).error.code, -32600);
});

test('upstreams are tried in order; a failed or erroring one costs a try, not the answer', async (t) => {
  const a = await stub(() => 500), b = await stub(() => ({ error: { code: -32000, message: 'missing trie node' } })), c = await stub(() => ({ result: '0x2105' }));
  t.after(() => { a.s.close(); b.s.close(); c.s.close(); });
  const g = createWitnessGateway({ upstreams: [a.url, b.url, c.url], methods: PLAIN });
  assert.equal((await g.handle(req('eth_chainId', []))).result, '0x2105');
  const st = g.stats();
  assert.deepEqual(Object.values(st.upstream).map((x) => [x.ok, x.failed]), [[0, 1], [0, 1], [1, 0]]);
});

test('witness methods and a cache are refused without a verifier: there is no unverified witness mode', () => {
  assert.throws(() => createWitnessGateway({ upstreams: [] }), /need proofs/);
  assert.throws(() => createWitnessGateway({ upstreams: [], methods: ['eth_getCode'] }), /need proofs/);
  assert.throws(() => createWitnessGateway({ upstreams: [], methods: PLAIN, cache: { get: async () => undefined, put: async () => {} } }), /need proofs/);
  assert.ok(createWitnessGateway({ upstreams: [], methods: PLAIN }));
});

test('a transaction goes to every upstream; with every upstream down nothing is sent and the caller is told', async (t) => {
  const a = await stub(() => ({ result: '0x' + 'cd'.repeat(32) })), b = await stub(() => ({ result: '0x' + 'cd'.repeat(32) }));
  const g = createWitnessGateway({ upstreams: [a.url, b.url], methods: PLAIN });
  assert.equal((await g.handle(req('eth_sendRawTransaction', ['0x02']))).result, '0x' + 'cd'.repeat(32));
  assert.deepEqual([a.seen, b.seen], [['eth_sendRawTransaction'], ['eth_sendRawTransaction']]);
  a.s.close(); b.s.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.match((await g.handle(req('eth_sendRawTransaction', ['0x02']))).error.message, /nothing was sent/);
});

test('the HTTP endpoint is loopback-only, bounds bodies and answers batches', async (t) => {
  const up = await stub(() => ({ result: '0x2105' }));
  const g = createWitnessGateway({ upstreams: [up.url], methods: PLAIN });
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
