// END-TO-END (offline, `unshare -r -n`): REAL Base mainnet witnesses served to the REAL patched Helios (Base EVM) from
// a REAL S3 server (MinIO) through network/s3-witness-cache.mjs, with NO live upstream at all. The fixture is worker A's
// recorded block (rpc-priority/fixtures/base-calls-20261023T014412Z: providers' eth_call results at that block hash plus
// the 49 witnesses Helios fetched). Its witnesses are archived into S3 by the backend (create-only), then:
//   1. every recorded call is recomputed by Helios from S3-served witnesses and matches the providers byte for byte;
//   2. a forged entry (valid envelope, the address book's storage value replaced by another address) is REFUSED by
//      Helios, never returned: S3 is availability, Helios's proof check is the authority;
//   3. a missing entry fails closed.
// As in A's replay test, the head is the real block signed by a TEST key (Helios unsafe_signer override): this proves
// the cache path and Base execution on real state, not head authenticity or freshness.
//   env: HELIOS_BASE_BIN, BASE_FIXTURE_DIR (read only), MINIO_BIN, TEST_TMP
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { createWitnessGateway, WITNESS_METHODS } from '../network/witness-gateway.mjs';
import { s3WitnessCache, s3Request, canonicalJson } from '../network/s3-witness-cache.mjs';

const { HELIOS_BASE_BIN, BASE_FIXTURE_DIR, MINIO_BIN } = process.env;
const fixture = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'fixture.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'helios-s3-'));
// test-only MinIO root, fresh per run (no credential literal in source)
const CREDS = { accessKeyId: 'enclavetest' + randomBytes(4).toString('hex'), secretAccessKey: randomBytes(18).toString('base64url').replace(/[-_]/g, 'A') };
const BOOK = '0xab214342d5a490150a4a977063a2f88e21f80907';
const children = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message || JSON.stringify(j.error)), { rpc: j.error });
  return j.result;
}
let endpoint, consensus, witnesses = [];
const objectUrl = (w) => `${endpoint}/witness/enclave-witness/8453/${w.blockHash}/${w.key}.json`;
const s3 = (o) => s3Request({ region: 'us-east-1', credentials: CREDS, timeoutMs: 10000, maxBytes: 8 << 20, ...o });

test.before(async () => {
  const port = await freePort(), cport = await freePort();
  fs.mkdirSync(path.join(TMP, 'minio'));
  const m = spawn(MINIO_BIN, ['server', '--quiet', '--address', `127.0.0.1:${port}`, '--console-address', `127.0.0.1:${cport}`, path.join(TMP, 'minio')],
    { env: { PATH: process.env.PATH, HOME: TMP, MINIO_ROOT_USER: CREDS.accessKeyId, MINIO_ROOT_PASSWORD: CREDS.secretAccessKey, MINIO_BROWSER: 'off' }, stdio: 'ignore' });
  children.add(m);
  endpoint = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(endpoint + '/minio/health/ready')).ok) break; } catch {} await sleep(250); }
  assert.equal((await s3({ method: 'PUT', url: `${endpoint}/witness` })).status, 200);
  // archive A's recorded witnesses through the backend (create-only): the fixture directory itself is only read
  const writer = s3WitnessCache({ endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS, archive: true, maxQueuedPuts: 4096 });
  const root = path.join(BASE_FIXTURE_DIR, 'cache');
  for (const blockHash of fs.readdirSync(root)) for (const f of fs.readdirSync(path.join(root, blockHash))) {
    const e = JSON.parse(fs.readFileSync(path.join(root, blockHash, f), 'utf8'));
    assert.equal(e.format, 'enclave-witness-rpc/v1');
    const w = { key: f.slice(0, -5), blockHash: blockHash.toLowerCase(), norm: e.request };
    assert.equal(createHash('sha256').update(w.norm).digest('hex'), w.key, 'fixture key = sha256(request)');
    witnesses.push({ w, result: e.result, method: JSON.parse(e.request)[0], params: JSON.parse(e.request)[1] });
  }
  await Promise.all(witnesses.map(({ w, result }) => writer.put(w, result)));
  assert.equal(writer.stats().puts, witnesses.length, JSON.stringify(writer.stats()));
  await writer.close();
  consensus = http.createServer((q, res) => res.end(JSON.stringify(q.url === '/chain_id' ? 8453 : fixture.commitment)));
  await new Promise((r) => consensus.listen(0, '127.0.0.1', r));
});
test.after(async () => {
  for (const p of [...children]) p.kill('SIGKILL');
  consensus?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// a fresh Helios each time (no in-process witness reuse), reading ONLY a read-only S3-backed gateway with no upstream
async function helios(tag) {
  const cache = s3WitnessCache({ endpoint, bucket: 'witness', chainId: 8453, credentials: CREDS });   // read-only
  const gateway = createWitnessGateway({ upstreams: [], cache, methods: WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList') });
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
  const stop = async () => { p.kill('SIGKILL'); await gateway.close(); await cache.close(); };
  return { url, gateway, cache, stop };
}
const T = { timeout: 300000 };
const AT = () => ({ blockHash: fixture.block.hash });
const replayable = () => fixture.calls.filter((c) => c.helios?.result !== undefined && c.helios.result === c.p1.result);

test('real Base calls recomputed by Helios from S3-served witnesses match the providers byte for byte', T, async (t) => {
  const h = await helios('ok');
  t.after(h.stop);
  const calls = replayable();
  assert.ok(calls.length >= 4, `replayable calls: ${calls.length}`);
  for (const c of calls) {
    assert.equal(await rpc(h.url, 'eth_call', [c.tx, AT()]), c.p1.result, c.name);
    t.diagnostic(`${c.name}: ok`);
  }
  const s = h.cache.stats();
  assert.ok(s.hits > 0 && Object.keys(s.rejected).length === 0, JSON.stringify(s));
  assert.equal(h.gateway.stats().cacheHits, s.hits);
});

test('a forged S3 entry (the address book names another registry) is refused by Helios, never returned', T, async (t) => {
  const target = witnesses.find((x) => x.method === 'eth_getProof' && x.params[0].toLowerCase() === BOOK && x.params[1].length > 0);
  assert.ok(target, 'the address book storage witness is in the fixture');
  const forged = structuredClone(target.result);
  const real = forged.storageProof[0].value;
  forged.storageProof[0].value = '0x' + '1234'.repeat(10);                                        // another 20-byte address
  // the attacker has bucket write access: an unconditional overwrite with a perfectly valid envelope
  const body = canonicalJson({ format: 'enclave-witness-s3/v1', chainId: 8453, blockHash: target.w.blockHash, request: target.w.norm, result: forged });
  assert.equal((await s3({ method: 'PUT', url: objectUrl(target.w), body, headers: ['Content-Type: application/json'] })).status, 200);
  t.after(async () => {   // restore the true entry for later tests
    const ok = canonicalJson({ format: 'enclave-witness-s3/v1', chainId: 8453, blockHash: target.w.blockHash, request: target.w.norm, result: target.result });
    await s3({ method: 'PUT', url: objectUrl(target.w), body: ok, headers: ['Content-Type: application/json'] });
  });
  const h = await helios('forged');
  t.after(h.stop);
  const book = fixture.calls.find((c) => c.name.startsWith('EnclaveAddressBook.addr'));
  await assert.rejects(rpc(h.url, 'eth_call', [book.tx, AT()]), (e) => { t.diagnostic(`refused: ${e.message.slice(0, 160)}`); return true; });
  // and nothing else Helios answers is a wrong answer: every call either matches the providers or is refused
  for (const c of replayable()) {
    try { assert.equal(await rpc(h.url, 'eth_call', [c.tx, AT()]), c.p1.result, c.name); } catch (e) { if (e.code === 'ERR_ASSERTION') throw e; }
  }
  assert.ok(h.cache.stats().hits > 0);
  assert.notEqual(real, forged.storageProof[0].value);
});

test('a missing S3 entry fails closed: refused, never answered', T, async (t) => {
  const target = witnesses.find((x) => x.method === 'eth_getProof' && x.params[0].toLowerCase() === BOOK && x.params[1].length > 0);
  assert.equal((await s3({ method: 'DELETE', url: objectUrl(target.w) })).status, 204);
  const h = await helios('missing');
  t.after(h.stop);
  const book = fixture.calls.find((c) => c.name.startsWith('EnclaveAddressBook.addr'));
  await assert.rejects(rpc(h.url, 'eth_call', [book.tx, AT()]));
  assert.ok(h.cache.stats().misses >= 1, JSON.stringify(h.cache.stats()));
});
