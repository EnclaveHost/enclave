// network/op-head-relay.mjs: signer/chain pinning, freshness, highest pick, equivocation, unsupported tx types, HTTP API.
// Commitments here are SYNTHETIC (test key, made-up blocks): they test the relay's rules, not live Base compatibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { pad, toHex } from 'viem';
import { createHeadRelay, verifyCommitment, payloadHead, payloadTransactions, unsupportedTxType, BASE_MAINNET } from '../network/op-head-relay.mjs';
import { makeCommitment } from './fixtures/op-commitment.mjs';

const KEY = '0x' + '11'.repeat(32), OTHER = '0x' + '22'.repeat(32);
const signer = privateKeyToAccount(KEY).address.toLowerCase();
const NOW = 1_800_000_000_000;
const h = (n, b) => pad(toHex(n * 256 + b), { size: 32 });
const fields = (number, ts, salt = 0) => ({ parentHash: h(number - 1, salt), miner: '0x' + '42'.repeat(20), stateRoot: h(number, 0xa0 + salt), receiptsRoot: h(number, 2),
  logsBloom: '0x' + '00'.repeat(256), mixHash: h(number, 3), number: BigInt(number), gasLimit: 30_000_000n, gasUsed: 21000n, timestamp: BigInt(ts),
  extraData: '0x', baseFeePerGas: 1000n, hash: h(number, 0xb0 + salt), withdrawalsRoot: h(number, 4) });
const legacy = '0xf86c808504a817c800825208940000000000000000000000000000000000000000880de0b6b3a76400008025a0' + '01'.repeat(32) + 'a0' + '02'.repeat(32);
const typed = (ty) => '0x' + ty.toString(16).padStart(2, '0') + 'c0';
const relayAt = (now = () => NOW, extra = {}) => createHeadRelay({ chainId: 8453, signer, maxAgeMs: 60000, now, ...extra });

test('a commitment verifies only for the pinned signer and chain, and its head fields decode', async () => {
  const f = fields(100, NOW / 1000 - 2);
  const c = await makeCommitment(f, { chainId: 8453, privateKey: KEY, txs: [legacy, typed(2), typed(0x7e)] });
  const v = await verifyCommitment(c, { chainId: 8453, signer });
  assert.deepEqual({ ...payloadHead(c.data) }, { number: 100n, timestamp: BigInt(NOW / 1000 - 2), hash: f.hash, stateRoot: f.stateRoot, parentHash: f.parentHash });
  assert.equal(v.head.hash, f.hash);
  assert.equal(payloadTransactions(c.data).length, 3);
  await assert.rejects(verifyCommitment(c, { chainId: 10, signer }), /not signed by the pinned unsafe signer/);
  await assert.rejects(verifyCommitment(await makeCommitment(f, { chainId: 8453, privateKey: OTHER }), { chainId: 8453, signer }), /not signed/);
  // one flipped payload byte (the state root) breaks the signature
  const bad = { ...c, data: c.data.slice(0, 2 + 2 * (32 + 52)) + (c.data[2 + 2 * (32 + 52)] === 'f' ? '0' : 'f') + c.data.slice(3 + 2 * (32 + 52)) };
  await assert.rejects(verifyCommitment(bad, { chainId: 8453, signer }), /not signed/);
  assert.equal(BASE_MAINNET.unsafeSigner, '0xaf6e19be0f9ce7f8afd49a1824851023a8249e8a');
});

test('transaction types the pinned verifier cannot decode are named; legacy, 0x01, 0x02, 0x04 and deposits pass', async () => {
  const mk = async (txs) => (await makeCommitment(fields(5, NOW / 1000), { chainId: 8453, privateKey: KEY, txs })).data;
  assert.equal(unsupportedTxType(await mk([legacy, typed(1), typed(2), typed(4), typed(0x7e)])), null);
  assert.equal(unsupportedTxType(await mk([typed(2), typed(0x79)])), 0x79);     // Base EIP-8130 (Everest, not scheduled at 5476069f)
  assert.equal(unsupportedTxType(await mk([typed(0x7d)])), 0x7d);              // OP post-exec: not a Base type
  assert.equal(unsupportedTxType(await mk([typed(3)])), 0x03);                 // blob txs do not exist on L2
  assert.equal(unsupportedTxType(await mk([])), null);
});

test('malformed payload offsets and sizes are refused, never read past', async () => {
  const c = await makeCommitment(fields(5, NOW / 1000), { chainId: 8453, privateKey: KEY, txs: [typed(2)] });
  assert.throws(() => payloadHead(c.data.slice(0, 2 + 2 * 100)), /wrong size/);
  const b = Buffer.from(c.data.slice(2), 'hex');
  b.writeUInt32LE(b.length + 10, 32 + 504);   // transactions offset past the end
  assert.throws(() => payloadTransactions('0x' + b.toString('hex')), /malformed/);
});

test('the relay serves the highest fresh signed block and nothing once it is stale', async () => {
  let now = NOW;
  const relay = relayAt(() => now);
  assert.equal(relay.latest(), null);
  const a = await makeCommitment(fields(100, NOW / 1000 - 4), { chainId: 8453, privateKey: KEY });
  const b = await makeCommitment(fields(101, NOW / 1000 - 2), { chainId: 8453, privateKey: KEY });
  assert.equal((await relay.offer(b)).accepted, true);
  assert.equal((await relay.offer(a)).accepted, true);             // accepted, but lower: b stays
  assert.equal(payloadHead(relay.latest().data).number, 101n);
  now = NOW + 61000;                                                // b is now older than maxAgeMs
  assert.equal(relay.latest(), null);
  assert.equal(relay.status().head, null);
  // a far-future block is not accepted either
  assert.equal((await relay.offer(await makeCommitment(fields(200, now / 1000 + 60), { chainId: 8453, privateKey: KEY }))).accepted, false);
});

test('a wrong-signer offer throws instead of being served', async () => {
  const relay = relayAt();
  await assert.rejects(relay.offer(await makeCommitment(fields(7, NOW / 1000), { chainId: 8453, privateKey: OTHER })), /not signed/);
  assert.equal(relay.latest(), null);
});

test('two signed blocks at one height stop the relay until a strictly higher block arrives', async () => {
  const relay = relayAt();
  await relay.offer(await makeCommitment(fields(50, NOW / 1000 - 1, 0), { chainId: 8453, privateKey: KEY }));
  const out = await relay.offer(await makeCommitment(fields(50, NOW / 1000 - 1, 1), { chainId: 8453, privateKey: KEY }));
  assert.equal(out.reason, 'equivocation');
  assert.equal(relay.latest(), null);
  assert.equal(relay.status().equivocations.length, 1);
  assert.equal((await relay.offer(await makeCommitment(fields(49, NOW / 1000 - 1), { chainId: 8453, privateKey: KEY }))).accepted, false);
  assert.equal((await relay.offer(await makeCommitment(fields(51, NOW / 1000), { chainId: 8453, privateKey: KEY }))).accepted, true);
  assert.equal(payloadHead(relay.latest().data).number, 51n);
});

test('a signed block carrying an unsupported transaction type is refused and recorded', async () => {
  const relay = relayAt();
  await relay.offer(await makeCommitment(fields(60, NOW / 1000 - 2), { chainId: 8453, privateKey: KEY, txs: [typed(2)] }));
  const out = await relay.offer(await makeCommitment(fields(61, NOW / 1000), { chainId: 8453, privateKey: KEY, txs: [typed(2), typed(0x79)] }));
  assert.equal(out.accepted, false);
  assert.match(out.reason, /unsupported transaction type 0x79/);
  assert.equal(payloadHead(relay.latest().data).number, 60n);
  assert.deepEqual(relay.status().unsupported.map((u) => u.type), ['0x79']);
});

test('the HTTP API polls untrusted sources, serves /latest and /chain_id, and ignores a lying source', async (t) => {
  const good = await makeCommitment(fields(300, Date.now() / 1000 - 1 | 0), { chainId: 8453, privateKey: KEY });
  const forged = await makeCommitment(fields(999, Date.now() / 1000 - 1 | 0), { chainId: 8453, privateKey: OTHER });
  const serve = (body) => new Promise((r) => { const s = http.createServer((q, res) => res.end(JSON.stringify(q.url === '/latest' ? body : 8453))); s.listen(0, '127.0.0.1', () => r(s)); });
  const s1 = await serve(forged), s2 = await serve(good), s3 = await serve(null);
  const relay = createHeadRelay({ sources: [s1, s2, s3].map((s) => `http://127.0.0.1:${s.address().port}/`), chainId: 8453, signer, maxAgeMs: 60000, pollMs: 60000 });
  t.after(async () => { await relay.close(); for (const s of [s1, s2, s3]) s.close(); });
  const url = await relay.listen(0);
  const latest = await (await fetch(url + 'latest')).json();
  assert.equal(payloadHead(latest.data).number, 300n);
  assert.equal(await (await fetch(url + 'chain_id')).json(), 8453);
  assert.equal((await fetch(url + 'other')).status, 404);
  const st = relay.status().sources;
  assert.equal(st[0].failed, 1);            // forged signature: an error, never served
  assert.equal(st[1].ok, 1);
  assert.equal(st[2].last, 'no commitment');
});

test('configuration refuses plain-http public sources, duplicates and a missing signer', () => {
  assert.throws(() => createHeadRelay({ sources: ['http://example.org/'], chainId: 8453, signer }), /./);
  assert.throws(() => createHeadRelay({ sources: ['https://a.example.org/', 'https://A.example.org./x'], chainId: 8453, signer }), /distinct/);
  assert.throws(() => createHeadRelay({ chainId: 8453, signer: '0x' + '00'.repeat(20) }), /signer/);
});
