// END-TO-END on the COMPOSED path (offline, `unshare -r -n`): the REAL patched Helios (Base EVM, eeffcc9) recomputes
// REAL Base mainnet calls (fixture base-calls-20261023T014412Z, block 52965249) through P's VERIFYING gateway (witness-
// check helper from Helios 1ec2c1a + root store) whose only witness source is the S3 ARCHIVE tier on a REAL S3 server
// (MinIO), no upstream at all. The archive is filled ONLY through the gateway (an honest stub upstream, verified answers).
//   1. cold replay: every recorded call matches the providers byte for byte;
//   2. an attacker with bucket write access plants, for EVERY eth_getProof, a forgery whose content name sorts before
//      the valid answer: the gateway checks and quarantines each, Helios still gets every witness and every answer;
//   3. the address book's valid object is deleted, its forgery left: the call is refused, never answered.
// The head is the real block signed by the fixture's TEST key (Helios unsafe_signer override): this proves the
// archive path and Base execution on real state, not head authenticity or freshness.
//   env: HELIOS_BASE_BIN, WITNESS_CHECK_BIN, BASE_FIXTURE_DIR (read only), MINIO_BIN, TEST_TMP
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createWitnessGateway, witnessKey, WITNESS_METHODS } from '../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';
import { s3WitnessCache, canonicalJson } from '../network/s3-witness-cache.mjs';
import { startMinio, raw, envelope, freePort, sleep, testCredentials } from './support/s3-test-env.mjs';

const { HELIOS_BASE_BIN, WITNESS_CHECK_BIN, BASE_FIXTURE_DIR } = process.env;
const fixture = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'fixture.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'helios-s3-'));
const CREDS = testCredentials();
const BOOK = '0xab214342d5a490150a4a977063a2f88e21f80907';
const NO_HINT = WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList');
const nameOf = (r) => createHash('sha256').update(canonicalJson(r)).digest('hex');
const RECORDED = [];
for (const f of fs.readdirSync(path.join(BASE_FIXTURE_DIR, 'cache', fixture.block.hash))) {
  const e = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'cache', fixture.block.hash, f), 'utf8'));
  const [method, params] = JSON.parse(e.request);
  RECORDED.push({ method, params, result: e.result, w: witnessKey(method, params) });
}
const byKey = new Map(RECORDED.map((r) => [r.w.key, r]));
const children = new Set();
async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(90000) });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message || JSON.stringify(j.error)), { rpc: j.error });
  return j.result;
}
let s3, consensus, checker;
const objectKey = (w, r) => `enclave-witness/8453/${w.blockHash}/${w.key}/${nameOf(r)}.json`;
const proofs = () => ({ checker, roots: createRootStore({ checker, consensusUrl: `http://127.0.0.1:${consensus.address().port}/` }) });
const archiveOf = (o = {}) => s3WitnessCache({ endpoint: s3.endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, ...o });

test.before(async () => {
  s3 = await startMinio({ dir: path.join(TMP, 'minio'), creds: CREDS });
  consensus = http.createServer((q, res) => res.end(JSON.stringify(q.url === '/chain_id' ? 8453 : fixture.commitment)));
  await new Promise((r) => consensus.listen(0, '127.0.0.1', r));
  checker = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: fixture.testSequencerSigner });
  // fill the archive ONLY through the verifying gateway, from an honest stub upstream
  const up = http.createServer((q, res) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { const j = JSON.parse(b); const r = byKey.get(witnessKey(j.method, j.params)?.key); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, ...(r ? { result: r.result } : { error: { code: -32000, message: 'x' } }) })); }); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const writer = archiveOf({ archive: true, maxQueuedPuts: 256 });
  const g = createWitnessGateway({ upstreams: [`http://127.0.0.1:${up.address().port}/`], methods: NO_HINT, proofs: proofs(), archive: writer });
  for (const r of [...RECORDED].sort((a, b) => (a.method === 'eth_getCode') - (b.method === 'eth_getCode'))) {
    const out = await g.handle({ jsonrpc: '2.0', id: 1, method: r.method, params: r.params });
    assert.deepEqual(out.result, r.result, r.method);
  }
  await writer.idle();
  assert.equal(writer.stats().puts, RECORDED.length, JSON.stringify(writer.stats()));
  await writer.close(); up.close();
});
test.after(async () => {
  for (const p of [...children]) p.kill('SIGKILL');
  checker?.close(); consensus?.close(); s3?.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// a fresh Helios each time, whose execution endpoint is a fresh composed gateway with NO upstream and a read-only archive
async function helios(tag) {
  const archive = archiveOf();
  const gateway = createWitnessGateway({ upstreams: [], methods: NO_HINT, proofs: proofs(), archive });
  const gatewayUrl = await gateway.listen(0);
  const home = path.join(TMP, 'home-' + tag); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${fixture.testSequencerSigner}"\n`
    + `\n[base.chain.forks]\nexecution_unsupported_from_timestamp = 9223372036854775807\n`);
  const port = await freePort();
  const p = spawn(HELIOS_BASE_BIN, ['opstack', '--network', 'base', '--consensus-rpc', `http://127.0.0.1:${consensus.address().port}/`, '--execution-rpc', gatewayUrl, '--rpc-port', String(port)],
    { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  children.add(p); p.on('exit', () => children.delete(p));
  const url = `http://127.0.0.1:${port}/`;
  const num = '0x' + fixture.block.number.toString(16);
  for (let i = 0; i < 240; i++) { try { if ((await rpc(url, 'eth_getBlockByNumber', [num, false]))?.hash === fixture.block.hash) break; } catch {} await sleep(250); }
  const stop = async () => { p.kill('SIGKILL'); await gateway.close(); await archive.close(); };
  return { url, gateway, archive, stop };
}
const T = { timeout: 300000 };
const AT = () => ({ blockHash: fixture.block.hash });
const replayable = () => fixture.calls.filter((c) => c.helios?.result !== undefined && c.helios.result === c.p1.result);

test('cold replay: real Base calls recomputed by Helios from verified S3-archived witnesses match the providers', T, async (t) => {
  const h = await helios('cold');
  t.after(h.stop);
  const calls = replayable();
  assert.ok(calls.length >= 4, `replayable calls: ${calls.length}`);
  for (const c of calls) { assert.equal(await rpc(h.url, 'eth_call', [c.tx, AT()]), c.p1.result, c.name); t.diagnostic(`${c.name}: ok`); }
  const s = h.gateway.stats();
  assert.ok(s.archiveHits > 0 && s.archiveInvalid === 0 && s.unavailable === 0, JSON.stringify(s));
});

test('bad first, valid second: a forgery that sorts first for EVERY eth_getProof is quarantined; every call still matches', T, async (t) => {
  let planted = 0;
  for (const r of RECORDED.filter((x) => x.method === 'eth_getProof')) {
    let f;
    for (let i = 1n; ; i++) { f = structuredClone(r.result); f.balance = '0x' + (BigInt(r.result.balance) + i).toString(16); if (nameOf(f) < nameOf(r.result)) break; }
    assert.equal((await raw(s3, CREDS, { method: 'PUT', key: objectKey(r.w, f), body: envelope(r.w, f) })).status, 200);
    planted++;
  }
  const h = await helios('forged');
  t.after(h.stop);
  for (const c of replayable()) assert.equal(await rpc(h.url, 'eth_call', [c.tx, AT()]), c.p1.result, c.name);
  const s = h.gateway.stats();
  assert.ok(s.archiveInvalid >= 1 && s.archiveHits > 0 && s.unavailable === 0, JSON.stringify(s));
  t.diagnostic(`planted ${planted} first-sorting forgeries; quarantined ${s.archiveInvalid}, verified hits ${s.archiveHits}`);
});

test('the valid object deleted, its forgery left: the address-book call is refused, never answered', T, async (t) => {
  const r = RECORDED.find((x) => x.method === 'eth_getProof' && x.params[0].toLowerCase() === BOOK && x.params[1].length > 0);
  assert.equal((await raw(s3, CREDS, { method: 'DELETE', key: objectKey(r.w, r.result) })).status, 204);
  const h = await helios('missing');
  t.after(h.stop);
  const book = fixture.calls.find((c) => c.name.startsWith('EnclaveAddressBook.addr'));
  await assert.rejects(rpc(h.url, 'eth_call', [book.tx, AT()]), (e) => { t.diagnostic(`refused: ${e.message.slice(0, 140)}`); return true; });
  assert.ok(h.gateway.stats().archiveInvalid >= 1);
});
