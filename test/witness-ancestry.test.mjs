// Authenticated ancestry recovery of state roots the gateway missed (network/witness-verify.mjs createRootStore +
// network/witness-gateway.mjs headers), with the REAL native helper and REAL Base mainnet data:
//   * 52 real signed v4 gossip objects (blocks 52965055..52965106, rpc-peer-audit head listener run
//     live-20261023T013719Z; real Base unsafe signer) feed the consensus head source;
//   * their canonical headers (test/fixtures/base-headers-52965055-52965106.json, derived from those exact signed
//     payloads by derive-base-headers.mjs and re-derived below) are what an honest execution source answers.
// These blocks have no recorded state proofs: this file proves HEADER/ANCESTRY BINDING ONLY (state roots bound by
// recomputed hash to a signed head). Proofs at a recovered root are exercised in helios-witness-failover.e2e.
// Fork/number-mismatch cases use TEST-key heads (synthetic authority, labelled). Run offline (`unshare -r -n`).
//   env: WITNESS_CHECK_BIN, BASE_HEADS_DIR, BASE_FIXTURE_DIR, B_LISTENER_FIXTURES, TEST_TMP
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { numberToHex, pad } from 'viem';
import { createWitnessGateway, WITNESS_METHODS } from '../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';
import { BASE_MAINNET } from '../network/op-head-relay.mjs';
import { makeCommitment, blockFields } from './fixtures/op-commitment.mjs';

const { WITNESS_CHECK_BIN, BASE_HEADS_DIR, BASE_FIXTURE_DIR, B_LISTENER_FIXTURES } = process.env;
const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/base-headers-52965055-52965106.json', import.meta.url)));
const BY_NUM = new Map(FIX.headers.map((h) => [h.number, h])), BY_HASH = new Map(FIX.headers.map((h) => [h.hash, h]));
const N = (n) => BY_NUM.get(52965000 + n);                 // N(80) = block 52965080
const callFixture = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'fixture.json'), 'utf8'));
const TEST_KEY = '0x' + '5e'.repeat(32);                   // the public test key of record-base-calls.mjs (synthetic authority)
const NO_PROOF_METHODS = WITNESS_METHODS.filter((m) => !['eth_createAccessList'].includes(m));

const servers = [];
function serve(handler) {
  const s = http.createServer((q, res) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', async () => {
    const out = await handler(b ? JSON.parse(b) : null, q, res);
    if (out !== undefined) res.end(JSON.stringify(out));
  }); });
  servers.push(s);
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}/`)));
}
/** An execution source answering eth_getBlockByHash from `lookup(hash)` (null = unknown block). */
async function headerSource(lookup) {
  const seen = [];
  const url = await serve(async (j, q, res) => {
    if (j.method !== 'eth_getBlockByHash') return { jsonrpc: '2.0', id: j.id, error: { code: -32601, message: 'x' } };
    seen.push(j.params[0]);
    const h = await lookup(j.params[0], res);
    if (h === 'handled') return undefined;
    return { jsonrpc: '2.0', id: j.id, result: h ?? null };
  });
  return { url, seen };
}
const honest = () => headerSource((h) => BY_HASH.get(h)?.header);
const forger = () => headerSource((h) => { const r = BY_HASH.get(h); return r && { ...r.header, stateRoot: pad('0x66', { size: 32 }) }; });   // tampered root, original hash field
let consensusUrl, current = null, real, synth;
const commitments = new Map();                            // block number -> real signed commitment
test.before(async () => {
  real = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: BASE_MAINNET.unsafeSigner });
  synth = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: callFixture.testSequencerSigner });
  for (const f of fs.readdirSync(path.join(BASE_HEADS_DIR, 'objects'))) {
    const r = await real.check({ op: 'exportHeader', object: '0x' + fs.readFileSync(path.join(BASE_HEADS_DIR, 'objects', f)).toString('hex') });
    assert.ok(r.ok, r.error);
    commitments.set(r.head.number, { commitment: r.commitment, header: r.header, head: r.head });
  }
  consensusUrl = await serve((_, q) => (q.url === '/chain_id' ? 8453 : current));
});
test.after(() => { real?.close(); synth?.close(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } });
const head = (n) => commitments.get(52965000 + n).commitment;
function gateway(sources, { checker = real, maxAncestry = 256, push = false, ...opts } = {}) {
  const roots = createRootStore({ checker, consensusUrl: push ? undefined : consensusUrl, maxAncestry });
  const g = createWitnessGateway({ upstreams: sources.map((s) => s.url), methods: NO_PROOF_METHODS, proofs: { checker, roots }, ...opts });
  return { g, roots, st: () => Object.values(g.stats().upstream) };
}

test('fixture: the 52 canonical headers re-derive from the exact signed gossip objects, hash to their signed block hashes and link', async () => {
  assert.equal(FIX.headers.length, 52);
  for (const h of FIX.headers) {
    const c = commitments.get(h.number);
    assert.deepEqual(c.header, h.header, `block ${h.number}`);
    assert.equal(c.head.blockHash, h.hash);
  }
  // each real header is an authenticated ancestor of its real child (51 links, checked by the helper)
  for (let n = 56; n <= 106; n++) {
    const p = N(n - 1), c = N(n);
    const r = await real.check({ op: 'header', header: p.header, expectHash: p.hash, child: { number: c.number, timestamp: c.timestamp, parentHash: c.parentHash } });
    assert.ok(r.ok && r.stateRoot === p.stateRoot, `${p.number}: ${r.error}`);
  }
  // the listener's own fixtures for 52965074..76 (accepted by Base's BlockHandler::block_valid) agree
  for (const n of [74, 75, 76]) {
    const rec = JSON.parse(fs.readFileSync(path.join(B_LISTENER_FIXTURES, `base-mainnet-529650${n}.head.json`), 'utf8'));
    assert.deepEqual([rec.hash, rec.parentHash, rec.stateRoot, rec.timestamp], [N(n).hash, N(n).parentHash, N(n).stateRoot, N(n).timestamp]);
  }
});

test('cold start: only the latest head was seen; a missed confirmed block is recovered by authenticated ancestry and a forged first header costs only that try', async () => {
  current = head(106);
  const f = await forger(), h = await honest();
  const { g, roots, st } = gateway([f, h]);
  const r = await g.root(N(80).hash);
  assert.equal(r.stateRoot, N(80).stateRoot);
  assert.equal(r.via, 'ancestor');
  assert.equal(r.boundTo, N(81).hash, 'bound to its verified child');
  const [sf, sh] = st();
  // guide header for 80 + the walk 105..81: 26 headers, each forged first and refused, then verified from the honest source
  assert.deepEqual([sf.headerInvalid, sf.headerOk, sh.headerOk, sh.headerInvalid], [26, 0, 26, 0]);
  assert.deepEqual([roots.stats().verified, roots.stats().ancestors], [1, 26]);
  // cached: the whole walked segment is bound now, nothing is fetched again
  assert.equal((await g.root(N(90).hash)).stateRoot, N(90).stateRoot);
  assert.equal((await g.root(N(80).hash)).blockHash, N(80).hash);
  assert.equal(h.seen.length, 26);
  assert.ok(Object.isFrozen(r) && !('fresh' in r), 'a recovered root is history for that block, never freshness');
});

test('skipped polls: a gap between two seen heads is filled from the nearer one, within maxAncestry; deeper history is refused', async () => {
  const h = await honest();
  const shallow = gateway([h], { maxAncestry: 20 });
  current = head(60); await shallow.roots.refresh();
  current = head(106); await shallow.roots.refresh();
  assert.equal(shallow.roots.stats().verified, 2);
  assert.equal(await shallow.g.root(N(70).hash), null, '36 links from block 106 > maxAncestry 20: refused');
  assert.equal(shallow.roots.stats().ancestryRefused['too-deep'], 1);
  assert.equal((await shallow.g.root(N(59).hash)).stateRoot, N(59).stateRoot, 'one link below the earlier seen head');
  const deep = gateway([h], { maxAncestry: 64 });
  current = head(60); await deep.roots.refresh();
  current = head(106); await deep.roots.refresh();
  assert.equal((await deep.g.root(N(70).hash)).stateRoot, N(70).stateRoot);
  assert.equal(deep.roots.stats().ancestors, 36);
  // a block newer than every seen head has no bound descendant: refused (it is not guessed from the source's claim)
  const cold = gateway([h]);
  current = head(80); await cold.roots.refresh();
  assert.equal(await cold.g.root(N(100).hash), null);
  assert.equal(cold.roots.stats().ancestryRefused['newer-than-every-bound-head'], 1);
});

test('missing history and hostile or hung sources fail closed: refusal, never a guess', async () => {
  current = head(106);
  // the honest source lacks block 95: the walk cannot pass it
  const holey = await headerSource((x) => (x === N(95).hash ? null : BY_HASH.get(x)?.header));
  const a = gateway([holey]);
  assert.equal(await a.g.root(N(90).hash), null);
  assert.equal(a.roots.stats().ancestryRefused.unavailable, 1);
  // only forged headers: nothing is bound
  const b = gateway([await forger()]);
  assert.equal(await b.g.root(N(100).hash), null);
  assert.equal(b.roots.stats().ancestors, 0);
  // a header that is the right block but answered for another hash
  const swap = await headerSource((x) => BY_HASH.get(x) && N(70).header);
  const c = gateway([swap]);
  assert.equal(await c.g.root(N(100).hash), null);
  assert.equal(c.st()[0].headerInvalid, 1);
  // a hung source and an oversized answer: one bounded try each, then the honest source; alone, the deadline holds
  const hung = await headerSource(() => 'handled');
  const huge = await headerSource((x, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ...BY_HASH.get(x)?.header, pad: 'x'.repeat(200000) } })); return 'handled'; });
  const d = gateway([hung, huge, await honest()], { timeoutMs: 300, deadlineMs: 20000, maxHeaderBytes: 65536 });
  assert.equal((await d.g.root(N(104).hash)).stateRoot, N(104).stateRoot);
  assert.deepEqual(d.st().map((x) => x.failed), [2, 2, 0]);
  const e = gateway([hung], { timeoutMs: 400, deadlineMs: 900 });
  const t0 = Date.now();
  assert.equal(await e.g.root(N(90).hash), null);
  assert.ok(Date.now() - t0 < 2000, `deadline held (${Date.now() - t0} ms)`);
});

test('a fork, a number gap or a later parent never binds (TEST-key heads: synthetic authority)', async () => {
  const h = await honest();
  const synthetic = async (base, patch) => makeCommitment(blockFields({ ...base.header, ...patch }), { chainId: 8453, privateKey: TEST_KEY });
  // fork: a signed block 81' whose parent is NOT the real block 80
  current = await synthetic(N(81), { parentHash: pad('0xab', { size: 32 }), hash: pad('0xcd', { size: 32 }) });
  const fork = gateway([h], { checker: synth });
  assert.equal(await fork.g.root(N(80).hash), null);
  assert.equal(fork.roots.stats().ancestryRefused['not-an-ancestor'], 1);
  // number gap: a signed block numbered 82 claiming real block 80 as its parent
  current = await synthetic(N(81), { number: numberToHex(52965082), parentHash: N(80).hash, hash: pad('0xce', { size: 32 }) });
  const gap = gateway([h], { checker: synth });
  assert.equal(await gap.g.root(N(80).hash), null);
  assert.ok(gap.st()[0].headerInvalid >= 1, 'the helper refuses the link');
  // a child older than its parent
  current = await synthetic(N(81), { parentHash: N(80).hash, timestamp: numberToHex(N(80).timestamp - 1), hash: pad('0xcf', { size: 32 }) });
  const early = gateway([h], { checker: synth });
  assert.equal(await early.g.root(N(80).hash), null);
});

test('concurrent requests for one missed block share one walk', async () => {
  current = head(106);
  const h = await honest();
  const { g } = gateway([h]);
  const out = await Promise.all(Array.from({ length: 8 }, () => g.root(N(85).hash)));
  assert.ok(out.every((r) => r?.stateRoot === N(85).stateRoot));
  assert.equal(h.seen.length, 21, 'guide + 105..86, once');
});

test('push interface: heads offered by a head source (e.g. the gossip bridge) are verified independently, then anchor recovery', async () => {
  const h = await honest();
  const { g, roots } = gateway([h], { push: true });
  assert.equal(await roots.offer(await makeCommitment(blockFields(N(106).header), { chainId: 8453, privateKey: TEST_KEY })), null, 'wrong signer refused');
  assert.equal(roots.stats().refused, 1);
  assert.equal((await roots.offer(head(106))).via, 'signed-head');
  assert.equal(roots.stats().polls, 0, 'no polling configured');
  assert.equal((await g.root(N(100).hash)).stateRoot, N(100).stateRoot);
});
