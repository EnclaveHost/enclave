// REAL composition, no synthetic identity (offline, `unshare -r -n`): the real patched Helios with the REAL Base unsafe
// signer adopts the REAL signed head 52965080, the head source moves to the REAL signed head 52965106, and a cold
// witness gateway that never saw 80 recovers 80's state root by authenticated ancestry (26 real canonical headers,
// test/fixtures/base-headers-52965055-52965106.json) when Helios asks it for witnesses pinned to 80, refusing a forged
// header source tried first.
// State proofs at 80: the bounded read-only recording (test/fixtures/record-real-history.mjs, root-authorized: 2 public
// sources, <=30 requests/20 MiB/120 s) obtained NONE (base-real-history-52965080/recording.json + attempt-1.json: one
// source rate-limited, the other timed out). The proof-verification test below runs only if a recording with verified
// entries is supplied (otherwise it is skipped, with the recorded reason).
// What the real Helios does for a block it has moved past (observed here, a16z/helios core historical/eip2935.rs): it
// fetches the block WITH ALL TRANSACTIONS from its execution source (get_untrusted_block(id, true)) and proves its hash
// with an EIP-2935 history-contract storage proof at its LATEST head - before it asks for any state proof at the old
// block. So replaying real calls at 80 through Helios needs: block 80's full body, the history-contract proof at 106 and
// the state proofs at 80. The gateway verifies the history proof against the signed head 106 and refuses it here.
//   env: HELIOS_BASE_BIN, WITNESS_CHECK_BIN, BASE_HEADS_DIR, TEST_TMP
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { pad } from 'viem';
import { createWitnessGateway, dirWitnessCache, witnessKey, WITNESS_METHODS, VERIFIED_METHODS } from '../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';
import { BASE_MAINNET } from '../network/op-head-relay.mjs';

const { HELIOS_BASE_BIN, WITNESS_CHECK_BIN, BASE_HEADS_DIR } = process.env;
const TARGET = 52965080, HEAD = 52965106;
const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/base-headers-52965055-52965106.json', import.meta.url)));
const BY_HASH = new Map(FIX.headers.map((h) => [h.hash, h])), N = Object.fromEntries(FIX.headers.map((h) => [h.number, h]));
const REC_DIR = new URL('./fixtures/base-real-history-52965080/', import.meta.url).pathname;
const REC = JSON.parse(fs.readFileSync(path.join(REC_DIR, 'recording.json'), 'utf8'));
const RECORDED = fs.existsSync(path.join(REC_DIR, 'cache')) ? dirWitnessCache(path.join(REC_DIR, 'cache')) : null;
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'real-history-'));
const NO_HINT = WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const servers = [], children = new Set();
async function serve(handler) {
  const s = http.createServer((q, res) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', async () => res.end(JSON.stringify(await handler(b ? JSON.parse(b) : null, q)))); });
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${s.address().port}/`;
}
async function rpc(url, method, params = []) {
  const j = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(90000) })).json();
  if (j.error) throw Object.assign(new Error(j.error.message), { rpc: j.error });
  return j.result;
}
let checker, heads = {}, consensus, current;
const FULL = new Map();                                  // hash -> real full-transaction block (witness-check exportBlock)
test.before(async () => {
  checker = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: BASE_MAINNET.unsafeSigner });
  for (const f of fs.readdirSync(path.join(BASE_HEADS_DIR, 'objects'))) {
    const r = await checker.check({ op: 'exportHeader', object: '0x' + fs.readFileSync(path.join(BASE_HEADS_DIR, 'objects', f)).toString('hex') });
    if (r.ok && (r.head.number === TARGET || r.head.number === HEAD)) heads[r.head.number] = r;
    // the gateway verifies eth_getBlockByHash bodies (witness-blocks): the honest source answers Helios's full-body
    // request with the real block derived from the signed gossip object, not a bare header
    if (r.ok && r.head.number === TARGET) FULL.set(r.header.hash, (await checker.check({ op: 'exportBlock', object: '0x' + fs.readFileSync(path.join(BASE_HEADS_DIR, 'objects', f)).toString('hex') })).block);
  }
  current = heads[TARGET].commitment;
  consensus = await serve((_, q) => (q.url === '/chain_id' ? 8453 : current));
});
test.after(() => { for (const p of children) p.kill('SIGKILL'); checker?.close(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } fs.rmSync(TMP, { recursive: true, force: true }); });

async function helios(gatewayUrl, tag) {
  const home = path.join(TMP, 'home-' + tag); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${BASE_MAINNET.unsafeSigner}"\n`);   // the REAL Base signer
  const port = await freePort();
  const p = spawn(HELIOS_BASE_BIN, ['opstack', '--network', 'base', '--consensus-rpc', consensus, '--execution-rpc', gatewayUrl, '--rpc-port', String(port)], { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  children.add(p); p.on('exit', () => children.delete(p));
  return { p, url: `http://127.0.0.1:${port}/` };
}
async function until(f, ms, what) { const end = Date.now() + ms; for (;;) { try { if (await f()) return; } catch {} if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(250); } }
const atNumber = (url, n) => rpc(url, 'eth_getBlockByNumber', ['0x' + n.toString(16), false]).then((b) => b?.hash);

// sources: a liar first (forged headers, malformed witnesses), then an honest one (real headers + recorded proofs, if any)
const seen = [];
async function sources() {
  const liar = await serve((j) => (seen.push({ who: 'liar', method: j.method, params: j.params }), { jsonrpc: '2.0', id: j.id, ...(j.method === 'eth_getBlockByHash' && BY_HASH.get(j.params[0])
    ? { result: { ...BY_HASH.get(j.params[0]).header, stateRoot: pad('0x66', { size: 32 }) } }
    : VERIFIED_METHODS.includes(j.method) ? { result: { accountProof: 'not-an-array' } } : { error: { code: -32000, message: 'x' } }) }));
  const honest = await serve(async (j) => {
    seen.push({ who: 'honest', method: j.method, params: j.params });
    if (j.method === 'eth_getBlockByHash') return { jsonrpc: '2.0', id: j.id, result: (j.params[1] === true ? FULL.get(j.params[0]) : null) ?? BY_HASH.get(j.params[0])?.header ?? null };
    const w = witnessKey(j.method, j.params), got = w && RECORDED ? await RECORDED.candidates(w) : [];
    return got.length ? { jsonrpc: '2.0', id: j.id, result: got[0] } : { jsonrpc: '2.0', id: j.id, error: { code: -32000, message: 'not recorded' } };
  });
  return [liar, honest];
}

const T = { timeout: 300000 };
test('real heads: the real Base signature verifies in the helper and in Helios, and each canonical hash equals its signed hash', T, async (t) => {
  for (const n of [TARGET, HEAD]) {
    assert.equal(heads[n].header.hash, N[n].hash, `block ${n}: strict exportHeader = real signer + canonical hash == signed block hash`);
    assert.equal(heads[n].head.stateRoot, N[n].stateRoot);
  }
  const wrong = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: '0x' + '11'.repeat(20) });
  try { assert.equal((await wrong.check({ op: 'head', commitment: heads[TARGET].commitment })).ok, false, 'not under another signer'); } finally { wrong.close(); }
});

test('cold gateway, real block Helios has moved past: Helios takes its EIP-2935 path (proof at the signed head 106, verified and refused here); the gateway recovers 80 by authenticated ancestry from real head 106', T, async (t) => {
  current = heads[TARGET].commitment;
  const [liar, honest] = await sources();
  const roots = createRootStore({ checker, consensusUrl: consensus });        // cold; polls only when asked
  const g = createWitnessGateway({ upstreams: [liar, honest], cache: dirWitnessCache(path.join(TMP, 'cache')), proofs: { checker, roots }, methods: NO_HINT });
  const url = await g.listen(0);
  const h = await helios(url, 'cold');
  t.after(async () => { h.p.kill('SIGKILL'); await g.close(); });
  await until(async () => (await atNumber(h.url, TARGET)) === N[TARGET].hash, 60000, 'Helios to adopt the real signed head 80');
  current = heads[HEAD].commitment;                                           // the head moves on before the gateway looks
  await until(async () => (await atNumber(h.url, HEAD)) === N[HEAD].hash, 60000, 'Helios to adopt the real signed head 106');
  const call = { to: '0xab214342d5a490150a4a977063a2f88e21f80907', data: '0x3b3b57de' + Buffer.from('registry').toString('hex').padEnd(64, '0') };
  seen.length = 0;
  const run = rpc(h.url, 'eth_call', [call, { blockHash: N[TARGET].hash }]);
  if (RECORDED) { t.diagnostic(`recorded proofs present: ${await run}`); } else await assert.rejects(run, 'no proof source: refused, never guessed');
  const st = g.stats(), rs = roots.stats();
  t.diagnostic(`gateway: ${JSON.stringify(st)}; roots: ${JSON.stringify(rs)}; requests: ${JSON.stringify(seen.map((x) => [x.who, x.method, JSON.stringify(x.params).slice(0, 160)]))}`);
  // Helios's actual path: the full block 80, then the EIP-2935 history slot for 80 proven at the latest signed head 106
  assert.ok(seen.some((x) => x.method === 'eth_getBlockByHash' && x.params[0] === N[TARGET].hash && x.params[1] === true), 'Helios asked for block 80 WITH transactions');
  const slot = '0x' + (TARGET % 8191).toString(16).padStart(64, '0');
  const history = seen.filter((x) => x.method === 'eth_getProof' && x.params[0].toLowerCase() === '0x0000f90827f1c53a10cb7a02335b175320002935');
  assert.ok(history.length && history.every((x) => BigInt(x.params[1][0]) === BigInt(slot) && JSON.stringify(x.params[2]).toLowerCase().includes(N[HEAD].hash.slice(2))),
    'the history-contract proof is pinned to the signed head 106 at slot 80 % 8191');
  assert.equal(rs.verified, 1, 'the gateway saw only the real head 106');
  assert.equal(rs.ancestors, 0, 'Helios never asked for state at 80 (it stopped at the unproven history slot)');
  const [l, o] = Object.values(st.upstream);
  assert.ok(l.invalid >= 1 && st.cachePuts === 0 && st.unavailable >= 1, 'the liar\'s history proof was refused against root 106; nothing unverified served or cached');
  // the gateway's own recovery of 80 from the real head 106, as it runs when state at 80 is requested
  const r = await g.root(N[TARGET].hash);
  assert.deepEqual([r.via, r.boundTo, r.stateRoot], ['ancestor', N[TARGET + 1].hash, N[TARGET].stateRoot]);
  const [l2, o2] = Object.values(g.stats().upstream);
  assert.deepEqual([l2.headerInvalid, l2.headerOk, o2.headerOk, o2.headerInvalid], [26, 0, 26, 0], 'every forged header refused, every real one verified');
  assert.equal(roots.stats().ancestors, 26, 'blocks 105..80 bound by recomputed hashes');
});

test('real proofs at the recovered real root (needs a recording with verified entries)', { ...T, skip: !RECORDED && `no real proofs recorded: ${REC.error} (${REC.requests.map((r) => `${r.source}: ${r.outcome}`).join('; ')})` }, async (t) => {
  current = heads[TARGET].commitment;
  const [liar, honest] = await sources();
  const roots = createRootStore({ checker, consensusUrl: consensus });
  const g = createWitnessGateway({ upstreams: [liar, honest], cache: dirWitnessCache(path.join(TMP, 'cache-2')), proofs: { checker, roots }, methods: NO_HINT });
  const url = await g.listen(0);
  const h = await helios(url, 'proofs');
  t.after(async () => { h.p.kill('SIGKILL'); await g.close(); });
  await until(async () => (await atNumber(h.url, TARGET)) === N[TARGET].hash, 60000, 'head 80');
  current = heads[HEAD].commitment;
  await until(async () => (await atNumber(h.url, HEAD)) === N[HEAD].hash, 60000, 'head 106');
  for (const c of REC.calls.filter((x) => x.provider !== undefined && x.agree)) {
    assert.equal(await rpc(h.url, 'eth_call', [c.tx, { blockHash: N[TARGET].hash }]), c.provider, c.name);
  }
  assert.equal(Object.values(g.stats().upstream)[0].ok, 0);
  assert.equal((await g.root(N[TARGET].hash)).via, 'ancestor');
});
