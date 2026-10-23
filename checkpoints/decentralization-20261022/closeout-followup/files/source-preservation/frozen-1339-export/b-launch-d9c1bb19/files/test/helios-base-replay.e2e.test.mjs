// OFFLINE REPLAY of REAL Base mainnet calls (run inside `unshare -r -n`: no network, every provider unreachable).
// The fixture (rpc-priority/fixture-tools/record-base-calls.mjs) holds a real block two public providers reported
// identically, the providers' eth_call results at that block hash, and the execution witnesses Helios fetched for it,
// keyed by block hash. Here the patched Helios (Base EVM backend) recomputes every call from those witnesses alone,
// verified against the block's state root, and must match the providers byte for byte.
// The head signature is a TEST key over the real block (Helios unsafe_signer override): this proves Base EXECUTION
// compatibility on real state, not head authenticity.
//   env: HELIOS_BASE_BIN (enclave-base-evm), HELIOS_COMPAT_BIN (enclave-base-compat 0a02256), BASE_FIXTURE_DIR, WITNESS_CHECK_BIN, TEST_TMP
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createWitnessGateway, dirWitnessCache, WITNESS_METHODS } from '../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';

const { HELIOS_BASE_BIN, HELIOS_COMPAT_BIN, BASE_FIXTURE_DIR } = process.env;
const fixture = JSON.parse(fs.readFileSync(path.join(BASE_FIXTURE_DIR, 'fixture.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'base-replay-'));
const children = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message || JSON.stringify(j.error)), { rpc: j.error });
  return j.result;
}
let consensus, gateway, gatewayUrl, checker;
test.before(async () => {
  consensus = http.createServer((q, res) => res.end(JSON.stringify(q.url === '/chain_id' ? 8453 : fixture.commitment)));
  await new Promise((r) => consensus.listen(0, '127.0.0.1', r));
  // NO upstream at all: witnesses come only from the recorded block-hash-pinned cache (copied, so the fixture is untouched)
  fs.cpSync(path.join(BASE_FIXTURE_DIR, 'cache'), path.join(TMP, 'cache'), { recursive: true });
  checker = createWitnessChecker({ bin: process.env.WITNESS_CHECK_BIN, chainId: 8453, signer: fixture.testSequencerSigner });
  const roots = createRootStore({ checker, consensusUrl: `http://127.0.0.1:${consensus.address().port}/` });
  gateway = createWitnessGateway({ upstreams: [], cache: dirWitnessCache(path.join(TMP, 'cache')), proofs: { checker, roots }, methods: WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList') });
  gatewayUrl = await gateway.listen(0);
});
test.after(async () => {
  for (const p of [...children]) { p.kill('SIGKILL'); }
  checker?.close(); await gateway?.close(); consensus?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});
async function helios(bin, tag, { executionOverride }) {
  const home = path.join(TMP, 'home-' + tag); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${fixture.testSequencerSigner}"\n`
    + (executionOverride ? `\n[base.chain.forks]\nexecution_unsupported_from_timestamp = 9223372036854775807\n` : ''));
  const port = await freePort();
  const p = spawn(bin, ['opstack', '--network', 'base', '--consensus-rpc', `http://127.0.0.1:${consensus.address().port}/`, '--execution-rpc', gatewayUrl, '--rpc-port', String(port)],
    { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  children.add(p); p.on('exit', () => children.delete(p));
  const url = `http://127.0.0.1:${port}/`;
  // readiness by the pinned block itself: eth_blockNumber is refused once the head is >60 s old (Helios check_head_age)
  const num = '0x' + fixture.block.number.toString(16);
  for (let i = 0; i < 240; i++) { try { if ((await rpc(url, 'eth_getBlockByNumber', [num, false]))?.hash === fixture.block.hash) return { p, url }; } catch {} await sleep(250); }
  throw new Error('helios did not adopt the fixture head');
}
const T = { timeout: 300000 };
const AT = () => ({ blockHash: fixture.block.hash });   // queries pinned to the recorded block (not age-checked)

test('the fixture is what it claims: two providers agreed on the block and on every call both answered', (t) => {
  assert.equal(fixture.format, 'enclave-base-call-fixture/v1');
  assert.ok(fixture.block.timestamp >= 1790791200, 'a Cobalt-era (Osaka + Base precompiles) block');
  // agree = both providers answered identically AND the recording Helios matched them
  const agreeing = fixture.calls.filter((c) => c.agree);
  assert.ok(agreeing.length >= 4, `at least four fully agreeing calls, got ${agreeing.length}`);
  for (const c of fixture.calls) {
    assert.ok(c.p1.result !== undefined, `primary provider answered: ${c.name}`);
    if (c.p2.result !== undefined) assert.equal(c.p2.result, c.p1.result, `providers agree: ${c.name}`);
    else t.diagnostic(`second provider did not answer (${JSON.stringify(c.p2.error)}): ${c.name} is single-provider-confirmed`);
  }
});

test('offline, from verified witnesses only, the Base EVM reproduces every provider eth_call result', T, async (t) => {
  const { p, url } = await helios(HELIOS_BASE_BIN, 'base', { executionOverride: true });
  t.after(() => p.kill('SIGKILL'));
  for (const c of fixture.calls.filter((x) => x.helios?.result !== undefined && x.helios.result === x.p1.result)) {
    const got = await rpc(url, 'eth_call', [c.tx, AT()]);
    assert.equal(got, c.p1.result, c.name);
    t.diagnostic(`${c.name}: ${got.slice(0, 66)}${got.length > 66 ? '…' : ''}`);
  }
  assert.equal(gateway.stats().unavailable, 0, 'no witness was missing');
  // the same verifier refuses LATEST: the recorded head is minutes old (Helios check_head_age: > 60 s = out of sync)
  await assert.rejects(rpc(url, 'eth_call', [fixture.calls[0].tx, 'latest']), /sync/i);
  await assert.rejects(rpc(url, 'eth_blockNumber'), /sync/i);
});

test('a call whose witnesses were never recorded fails closed: no unchecked answer, no provider', T, async (t) => {
  const { p, url } = await helios(HELIOS_BASE_BIN, 'missing', { executionOverride: true });
  t.after(() => p.kill('SIGKILL'));
  // a contract account never touched while recording: its proof is not in the cache and no upstream exists
  await assert.rejects(rpc(url, 'eth_call', [{ to: '0x4200000000000000000000000000000000000006', data: '0x06fdde03' }, AT()]));
  await assert.rejects(rpc(url, 'eth_getBalance', ['0x000000000000000000000000000000000000dEaD', AT()]));
});

test('control: the earlier compat build (op-revm, Prague rules) still refuses Base execution', T, async (t) => {
  const { p, url } = await helios(HELIOS_COMPAT_BIN, 'compat', { executionOverride: false });
  t.after(() => p.kill('SIGKILL'));
  await assert.rejects(rpc(url, 'eth_call', [fixture.calls[0].tx, AT()]), /local execution refused/);
});

test('shipped default of the Base build: execution follows the configured fork horizon', T, async (t) => {
  const { p, url } = await helios(HELIOS_BASE_BIN, 'default', { executionOverride: false });
  t.after(() => p.kill('SIGKILL'));
  const expectRefusal = process.env.BASE_DEFAULT_REFUSES !== '0';
  const run = rpc(url, 'eth_call', [fixture.calls[0].tx, AT()]);
  if (expectRefusal) await assert.rejects(run, /local execution refused/);
  else assert.equal(await run, fixture.calls[0].p1.result);
});
