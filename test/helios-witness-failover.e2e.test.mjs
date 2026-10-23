// END-TO-END (offline, `unshare -r -n`): the REAL patched Helios (enclave-base-evm) recomputes REAL Base mainnet calls
// (fixture base-calls-20261023T014412Z, block 52965249) through the witness gateway while the FIRST witness source lies
// on every answer and the second answers from the recorded real witnesses. The gateway verifies each answer with the
// native witness-check helper (Helios's proof code) against the root of the signed fixture head (from the consensus
// API, never from a witness source), so the liar costs one try per witness and Helios still gets every witness.
// Then every source is gone and a fresh gateway serves Helios from the cache alone, although that cache also holds
// the malformed single-slot entries the earlier gateway would have kept forever and forged content-addressed entries.
// The head signature is the fixture's TEST key: this proves witness failover and cache integrity on real state, not
// head authenticity or fresh-source availability.
//   env: HELIOS_BASE_BIN, WITNESS_CHECK_BIN, BASE_FIXTURE_DIR, TEST_TMP
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createWitnessGateway, dirWitnessCache, witnessKey, WITNESS_METHODS } from '../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';
import { numberToHex, pad } from 'viem';
import { makeCommitment, blockFields } from './fixtures/op-commitment.mjs';

const { HELIOS_BASE_BIN, WITNESS_CHECK_BIN, BASE_FIXTURE_DIR } = process.env;
const fixture = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'fixture.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'witness-failover-'));
const NO_HINT = WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList');
const CALLS = fixture.calls.filter((c) => c.helios?.result !== undefined && c.helios.result === c.p1.result);
const RECORDED = new Map();
for (const f of fs.readdirSync(path.join(BASE_FIXTURE_DIR, 'cache', fixture.block.hash))) {
  const e = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'cache', fixture.block.hash, f), 'utf8'));
  const [method, params] = JSON.parse(e.request);
  RECORDED.set(witnessKey(method, params).key, e.result);
}
const children = new Set(), servers = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(90000) });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message || JSON.stringify(j.error)), { rpc: j.error });
  return j.result;
}
async function serve(handler) {
  const s = http.createServer((q, res) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => res.end(JSON.stringify(handler(b ? JSON.parse(b) : null, q)))); });
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}/`;
}
// the liar rotates through malformed, cryptographically invalid and unbound answers
let lies = 0;
function lie(j, r) {
  const v = structuredClone(r);
  switch (lies++ % 4) {
    case 0: return { accountProof: 'not-an-array' };
    case 1: if (typeof v === 'string') return v.slice(0, -2) + (v.endsWith('00') ? '01' : '00');
      v.balance = '0x' + (BigInt(v.balance) + 1n).toString(16); return v;
    case 2: if (typeof v === 'string') return '0x';
      v.accountProof[v.accountProof.length - 1] = v.accountProof.at(-1).slice(0, -2) + (v.accountProof.at(-1).endsWith('00') ? '01' : '00'); return v;
    default: if (typeof v === 'string') return v + '00';
      v.storageProof = v.storageProof.slice(1); v.nonce = '0x' + (BigInt(v.nonce) + 1n).toString(16); return v;
  }
}
let consensusUrl, goodUrl, liarUrl, checker;
const lied = [];
test.before(async () => {
  consensusUrl = await serve((_, q) => (q.url === '/chain_id' ? 8453 : fixture.commitment));
  goodUrl = await serve((j) => { const r = RECORDED.get(witnessKey(j.method, j.params)?.key); return r === undefined ? { jsonrpc: '2.0', id: j.id, error: { code: -32000, message: 'not recorded' } } : { jsonrpc: '2.0', id: j.id, result: r }; });
  liarUrl = await serve((j) => { const r = RECORDED.get(witnessKey(j.method, j.params)?.key); if (r === undefined) return { jsonrpc: '2.0', id: j.id, error: { code: -32000, message: 'x' } }; lied.push(j.method); return { jsonrpc: '2.0', id: j.id, result: lie(j, r) }; });
  checker = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: fixture.testSequencerSigner });
});
test.after(async () => {
  for (const p of [...children]) p.kill('SIGKILL');
  checker?.close();
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
  fs.rmSync(TMP, { recursive: true, force: true });
});
async function helios(gatewayUrl, tag, { consensus = consensusUrl, blockHash = fixture.block.hash } = {}) {
  const home = path.join(TMP, 'home-' + tag); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${fixture.testSequencerSigner}"\n`);
  const port = await freePort();
  const p = spawn(HELIOS_BASE_BIN, ['opstack', '--network', 'base', '--consensus-rpc', consensus, '--execution-rpc', gatewayUrl, '--rpc-port', String(port)],
    { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  children.add(p); p.on('exit', () => children.delete(p));
  const url = `http://127.0.0.1:${port}/`, num = '0x' + fixture.block.number.toString(16);
  for (let i = 0; i < 240; i++) { try { if ((await rpc(url, 'eth_getBlockByNumber', [num, false]))?.hash === blockHash) return { p, url }; } catch {} await sleep(250); }
  throw new Error('helios did not adopt the fixture head');
}
async function gateway(upstreams, cacheDir) {
  const roots = createRootStore({ checker, consensusUrl });
  const g = createWitnessGateway({ upstreams, cache: cacheDir && dirWitnessCache(cacheDir), proofs: { checker, roots }, methods: NO_HINT });
  return { g, url: await g.listen(0) };
}
const AT = () => ({ blockHash: fixture.block.hash });
const T = { timeout: 600000 };
const CACHE = () => path.join(TMP, 'cache');

test('a lying first source cannot deny service: every real call still matches the providers, and only verified witnesses are cached', T, async (t) => {
  // pre-poison the cache the way the earlier gateway would have kept it: a malformed single-slot (legacy) entry for
  // EVERY recorded request, under the recorded request's own key
  const { g, url } = await gateway([liarUrl, goodUrl], CACHE());
  for (const f of fs.readdirSync(path.join(BASE_FIXTURE_DIR, 'cache', fixture.block.hash))) {
    const e = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'cache', fixture.block.hash, f), 'utf8'));
    fs.mkdirSync(path.join(CACHE(), fixture.block.hash), { recursive: true });
    fs.writeFileSync(path.join(CACHE(), fixture.block.hash, f), JSON.stringify({ ...e, result: { accountProof: 'not-an-array' } }));
  }
  const h = await helios(url, 'liar-first');
  t.after(async () => { h.p.kill('SIGKILL'); await g.close(); });
  for (const c of CALLS) {
    assert.equal(await rpc(h.url, 'eth_call', [c.tx, AT()]), c.p1.result, c.name);
    t.diagnostic(`${c.name}: ok`);
  }
  const st = g.stats();
  t.diagnostic(`gateway stats: ${JSON.stringify(st)}`);
  const [liar, good] = Object.values(st.upstream);
  assert.equal(liar.ok, 0, 'no lie was ever accepted');
  assert.ok(liar.invalid >= CALLS.length && liar.invalid === lied.length, `every lie was judged invalid (${liar.invalid}/${lied.length})`);
  assert.equal(good.invalid, 0);
  assert.equal(st.unavailable, 0, 'no witness was denied');
  assert.ok(st.cacheInvalid >= good.ok, 'each poisoned legacy entry was checked and quarantined before a source was asked');
  assert.equal(st.cachePuts, good.ok, 'exactly the verified answers were stored');
});

test('every source gone: a fresh cache-only gateway serves the verified witnesses and refuses everything else', T, async (t) => {
  const { g, url } = await gateway([], CACHE());
  const h = await helios(url, 'cache-only');
  t.after(async () => { h.p.kill('SIGKILL'); await g.close(); });
  for (const c of CALLS) assert.equal(await rpc(h.url, 'eth_call', [c.tx, AT()]), c.p1.result, c.name);
  const st = g.stats();
  t.diagnostic(`gateway stats: ${JSON.stringify(st)}`);
  assert.equal(st.unavailable, 0);
  assert.ok(st.cacheHits > 0);
  // a witness never verified (an account the calls never touched) has no source: refused, not guessed
  await assert.rejects(rpc(h.url, 'eth_getBalance', ['0x000000000000000000000000000000000000dEaD', AT()]));
});

test('with only the lying source, Helios gets refusals and nothing is cached', T, async (t) => {
  const dir = path.join(TMP, 'cache-liar-only');
  const { g, url } = await gateway([liarUrl], dir);
  const h = await helios(url, 'liar-only');
  t.after(async () => { h.p.kill('SIGKILL'); await g.close(); });
  await assert.rejects(rpc(h.url, 'eth_call', [CALLS[0].tx, AT()]));
  const st = g.stats();
  assert.equal(Object.values(st.upstream)[0].ok, 0);
  assert.ok(Object.values(st.upstream)[0].invalid >= 1);
  assert.equal(st.cachePuts, 0);
  assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir, { recursive: true }).every((n) => !n.endsWith('.json')), 'no entry written');
});

// COLD ANCESTRY with real proofs. Authority and block identity are SYNTHETIC here: the call fixture's TEST-signed
// commitment lacks the block's transactions and parent beacon root, so its real hash cannot be rebuilt offline
// (test/fixtures/base-header-52965249.synthetic.json). Block 249' = the real block's header fields and REAL state root
// under its recomputed hash; 250' = a TEST-signed child. Real-hash ancestry binding is proven on 52 real mainnet
// headers in witness-ancestry.test.mjs; here the point is the whole path: Helios pinned to a block the cold gateway
// never saw, the root recovered by ancestry past a forged first header, then REAL recorded proofs verified against it.
test('cold gateway, missed confirmed block: the root is recovered by authenticated ancestry and real proofs verify (synthetic authority)', T, async (t) => {
  const SY = JSON.parse(fs.readFileSync(new URL('./fixtures/base-header-52965249.synthetic.json', import.meta.url))).headers[0];
  const KEY = '0x' + '5e'.repeat(32);                     // record-base-calls.mjs's public test key
  const c249 = await makeCommitment(blockFields(SY.header), { chainId: 8453, privateKey: KEY });
  const strict = await checker.check({ op: 'exportHeader', commitment: c249 });
  assert.ok(strict.ok && strict.header.hash === SY.hash && strict.header.stateRoot === fixture.block.stateRoot, 'block 249\' is canonical for its own hash');
  const c250 = await makeCommitment(blockFields({ ...SY.header, number: numberToHex(SY.number + 1), parentHash: SY.hash,
    timestamp: numberToHex(SY.timestamp + 2), hash: pad('0xc1', { size: 32 }) }), { chainId: 8453, privateKey: KEY });
  let cur = c249;
  const consensus = await serve((_, q) => (q.url === '/chain_id' ? 8453 : cur));
  // witness requests pinned to 249' are answered with the recorded proofs for the real block (same state root)
  const real = (params) => params.map((x, i) => (i < params.length - 1 ? x : typeof x === 'string' ? (x.toLowerCase() === SY.hash ? fixture.block.hash : x)
    : x?.blockHash?.toLowerCase() === SY.hash ? { ...x, blockHash: fixture.block.hash } : x));
  const recorded = (j) => RECORDED.get(witnessKey(j.method, real(j.params))?.key);
  const good = await serve((j) => (j.method === 'eth_getBlockByHash'
    ? { jsonrpc: '2.0', id: j.id, result: j.params[0] === SY.hash ? SY.header : null }
    : recorded(j) === undefined ? { jsonrpc: '2.0', id: j.id, error: { code: -32000, message: 'not recorded' } } : { jsonrpc: '2.0', id: j.id, result: recorded(j) }));
  const liar = await serve((j) => (j.method === 'eth_getBlockByHash'
    ? { jsonrpc: '2.0', id: j.id, result: j.params[0] === SY.hash ? { ...SY.header, stateRoot: pad('0x66', { size: 32 }) } : null }
    : recorded(j) === undefined ? { jsonrpc: '2.0', id: j.id, error: { code: -32000, message: 'x' } } : { jsonrpc: '2.0', id: j.id, result: lie(j, recorded(j)) }));
  const roots = createRootStore({ checker, consensusUrl: consensus });      // cold, no polling: it sees only what it asks for
  const g = createWitnessGateway({ upstreams: [liar, good], cache: dirWitnessCache(path.join(TMP, 'cache-cold')), proofs: { checker, roots }, methods: NO_HINT });
  const url = await g.listen(0);
  const h = await helios(url, 'cold-ancestry', { consensus, blockHash: SY.hash });
  t.after(async () => { h.p.kill('SIGKILL'); await g.close(); });
  cur = c250;                                               // the head moved on before the gateway looked
  for (const c of CALLS) assert.equal(await rpc(h.url, 'eth_call', [c.tx, { blockHash: SY.hash }]), c.p1.result, c.name);
  const st = g.stats(), rs = roots.stats();
  t.diagnostic(`gateway stats: ${JSON.stringify(st)}; roots: ${JSON.stringify(rs)}`);
  assert.deepEqual([rs.verified, rs.ancestors], [1, 1], 'one signed head seen (250\'), 249\' bound by ancestry');
  const r = await g.root(SY.hash);
  assert.deepEqual([r.via, r.boundTo, r.stateRoot], ['ancestor', pad('0xc1', { size: 32 }), fixture.block.stateRoot]);
  const [l, gd] = Object.values(st.upstream);
  assert.deepEqual([l.headerInvalid, l.headerOk, gd.headerOk], [1, 0, 1], 'the forged first header cost only that try');
  assert.equal(l.ok, 0, 'no lie accepted');
  assert.ok(l.invalid >= CALLS.length && gd.ok > 0 && st.unavailable === 0);
});
