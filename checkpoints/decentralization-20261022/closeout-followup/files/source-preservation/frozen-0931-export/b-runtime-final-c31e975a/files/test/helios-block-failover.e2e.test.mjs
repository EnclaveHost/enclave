// Helios's ACTUAL historical path through the verifying gateway (offline, `unshare -r -n`), real data only: the real
// patched Helios (real Base signer) adopts the REAL signed head 52965080, then 52965106, then is asked for a call pinned
// to 80. Helios fetches block 80 WITH transactions (eth_getBlockByHash(h, true)) and then proves its hash with an
// EIP-2935 history proof at 106. The FIRST source answers block 80 with a forged block (self-claimed hash over a mutated
// header); the second answers the real full block derived from the signed gossip object (witness-check exportBlock).
// The gateway must refuse the forgery and serve the real block. No state/history proofs exist for these blocks (see
// RESULT-REAL-HISTORY.md), so the call still ends refused at the unproven history slot: this proves block failover only.
//   env: HELIOS_BASE_BIN, WITNESS_CHECK_BIN, BASE_HEADS_DIR, TEST_TMP
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { pad } from 'viem';
import { createWitnessGateway, dirWitnessCache, WITNESS_METHODS, VERIFIED_METHODS } from '../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';
import { BASE_MAINNET } from '../network/op-head-relay.mjs';

const { HELIOS_BASE_BIN, WITNESS_CHECK_BIN, BASE_HEADS_DIR } = process.env;
const TARGET = 52965080, HEAD = 52965106;
const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/base-headers-52965055-52965106.json', import.meta.url)));
const N = Object.fromEntries(FIX.headers.map((h) => [h.number, h]));
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'block-failover-'));
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
async function until(f, ms, what) { const end = Date.now() + ms; for (;;) { try { if (await f()) return; } catch {} if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(250); } }
let checker, heads = {}, real80, consensus, current;
test.before(async () => {
  checker = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: BASE_MAINNET.unsafeSigner });
  for (const f of fs.readdirSync(path.join(BASE_HEADS_DIR, 'objects'))) {
    const object = '0x' + fs.readFileSync(path.join(BASE_HEADS_DIR, 'objects', f)).toString('hex');
    const r = await checker.check({ op: 'exportHeader', object });
    if (!r.ok || (r.head.number !== TARGET && r.head.number !== HEAD)) continue;
    heads[r.head.number] = r;
    if (r.head.number === TARGET) real80 = (await checker.check({ op: 'exportBlock', object })).block;
  }
  current = heads[TARGET].commitment;
  consensus = await serve((_, q) => (q.url === '/chain_id' ? 8453 : current));
});
test.after(() => { for (const p of children) p.kill('SIGKILL'); checker?.close(); for (const s of servers) { s.closeAllConnections?.(); s.close(); } fs.rmSync(TMP, { recursive: true, force: true }); });

const forged = () => ({ ...real80, stateRoot: pad('0x66', { size: 32 }) });   // keeps the real `hash` field
async function run(t, { verifying }) {
  const seen = [];
  const liar = await serve((j) => (seen.push(['liar', j.method, j.params]), { jsonrpc: '2.0', id: j.id,
    ...(j.method === 'eth_getBlockByHash' && j.params[0] === N[TARGET].hash ? { result: forged() } : { error: { code: -32000, message: 'x' } }) }));
  const honest = await serve((j) => (seen.push(['honest', j.method, j.params]), { jsonrpc: '2.0', id: j.id,
    ...(j.method === 'eth_getBlockByHash' && j.params[0] === N[TARGET].hash ? { result: real80 } : { error: { code: -32000, message: 'not recorded' } }) }));
  const roots = createRootStore({ checker, consensusUrl: consensus });
  const g = verifying
    ? createWitnessGateway({ upstreams: [liar, honest], cache: dirWitnessCache(path.join(TMP, 'cache')), proofs: { checker, roots }, methods: WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList') })
    : createWitnessGateway({ upstreams: [liar, honest], methods: WITNESS_METHODS.filter((m) => !VERIFIED_METHODS.includes(m)) });   // control: plain first answer
  const url = await g.listen(0);
  const home = path.join(TMP, 'home-' + verifying); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${BASE_MAINNET.unsafeSigner}"\n`);
  const port = await freePort();
  const p = spawn(HELIOS_BASE_BIN, ['opstack', '--network', 'base', '--consensus-rpc', consensus, '--execution-rpc', url, '--rpc-port', String(port)], { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  children.add(p);
  t.after(async () => { p.kill('SIGKILL'); await g.close(); });
  const h = `http://127.0.0.1:${port}/`, at = (n) => rpc(h, 'eth_getBlockByNumber', ['0x' + n.toString(16), false]).then((b) => b?.hash);
  current = heads[TARGET].commitment;
  await until(async () => (await at(TARGET)) === N[TARGET].hash, 60000, 'real head 80');
  current = heads[HEAD].commitment;
  await until(async () => (await at(HEAD)) === N[HEAD].hash, 60000, 'real head 106');
  const call = { to: '0xab214342d5a490150a4a977063a2f88e21f80907', data: '0x3b3b57de' + Buffer.from('registry').toString('hex').padEnd(64, '0') };
  await assert.rejects(rpc(h, 'eth_call', [call, { blockHash: N[TARGET].hash }]), 'no history/state proofs exist: refused');
  t.diagnostic(`${verifying ? 'verifying' : 'CONTROL'} gateway: ${JSON.stringify(g.stats())}; requests: ${JSON.stringify(seen.map(([w, m, ps]) => [w, m, JSON.stringify(ps).slice(0, 100)]))}`);
  return { g, roots, seen };
}

const T = { timeout: 300000 };
test('Helios historical path: a forged first block (self-claimed hash) is refused and the real full block is served', T, async (t) => {
  const { g, roots, seen } = await run(t, { verifying: true });
  assert.ok(seen.some(([w, m, ps]) => w === 'liar' && m === 'eth_getBlockByHash' && ps[1] === true), 'Helios asked for block 80 with transactions');
  const [l, o] = Object.values(g.stats().upstream);
  assert.ok(l.blockInvalid >= 1 && l.blockOk === 0, 'the forged block was refused every time');
  assert.ok(o.blockOk >= 1 && g.stats().blocksFull >= 1, 'the real full block was verified and served');
  assert.equal(g.stats().blocksHeaderOnly, 0);
  // Helios then went on to its EIP-2935 history proof at the signed head 106 (no proof exists: refused)
  assert.ok(seen.some(([, m, ps]) => m === 'eth_getProof' && ps[0].toLowerCase() === '0x0000f90827f1c53a10cb7a02335b175320002935'), 'the history proof followed');
  assert.deepEqual([roots.stats().ancestors], [0], 'blocks never create roots');
  assert.equal(fs.existsSync(path.join(TMP, 'cache')) ? fs.readdirSync(path.join(TMP, 'cache'), { recursive: true }).filter((n) => n.endsWith('.json')).length : 0, 0, 'nothing cached');
});

test('FAILED CONTROL: with plain first-answer failover the forged block is what Helios receives', T, async (t) => {
  const { g, seen } = await run(t, { verifying: false });
  const asked = seen.filter(([, m, ps]) => m === 'eth_getBlockByHash' && ps[0] === N[TARGET].hash);
  assert.ok(asked.length >= 1 && asked.every(([w]) => w === 'liar'), 'only the liar was asked for block 80: its forged block was served');
  assert.ok(Object.values(g.stats().upstream)[0].ok >= 1);
});
