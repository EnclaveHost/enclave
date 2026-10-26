// The shared verified-chain module carries A's CLI/MCP additions (rpc-priority 40f2b0a95: allowCall, verifierRequest,
// verifierClient). They are OPT-IN per caller. This pins the boundary for the Windows node and the hosted roles, which
// share the module through the admission and privacy-agent bundles:
//   - a pinned client or snapshot created WITHOUT allowCall has no raw `call` (refused by name, nothing sent);
//   - WITH allowCall, `call` is the same proof-backed eth_call pinned to the snapshot's block hash;
//   - verifierRequest serves only pinned state, headers by number and the chain id/head (everything else refused, unsent);
//   - no Windows, network, relay or metal source opts in: the additions are used only by A's CLI/MCP callers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinnedClient, createVerifiedSnapshot, verifierRequest } from '../network/verified-chain.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HASH = '0x' + 'ab'.repeat(32), TO = '0x' + '11'.repeat(20);

function fakeVerifier() {
  const calls = [], now = Math.floor(Date.now() / 1000);
  const block = (n) => ({ number: '0x' + n.toString(16), hash: n === 100 ? HASH : '0x' + n.toString(16).padStart(64, '0'),
    stateRoot: '0x' + 'cd'.repeat(32), timestamp: '0x' + (now - (102 - n)).toString(16) });
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return '0x2105';
    if (method === 'eth_blockNumber') return '0x66';                         // 102: two confirmations put the read at 100
    if (method === 'eth_getBlockByNumber') return block(Number(BigInt(params[0])));
    if (method === 'eth_call') return '0x' + '00'.repeat(31) + '2a';
    throw new Error('unexpected ' + method);
  };
  return { calls, request };
}

test('without allowCall a pinned client has no raw call: refused by name, nothing sent', async () => {
  const sent = [];
  const c = pinnedClient({ b: 100n, hash: HASH, chainId: 8453, request: async (m, p) => { sent.push(m); return '0x'; } });
  await assert.rejects(async () => c.call({ to: TO, data: '0x' }), /client\.call is not available under the verifier authority/);
  assert.deepEqual(sent, []);
});

test('with allowCall, call is the proof-backed eth_call pinned to the block hash (no tags)', async () => {
  const sent = [];
  const c = pinnedClient({ b: 100n, hash: HASH, chainId: 8453, allowCall: true, request: async (m, p) => { sent.push([m, p]); return '0x2a'; } });
  assert.deepEqual(await c.call({ account: TO, to: TO, data: '0x1234' }), { data: '0x2a' });
  assert.equal(sent[0][0], 'eth_call');
  assert.deepEqual(sent[0][1][1], { blockHash: HASH });
  await assert.rejects(async () => c.call({ to: TO, data: '0x', blockTag: 'latest' }), /pinned to block/);
});

test('a snapshot created the default way (as every Windows and hosted caller does) refuses call; opted in, it reads at its block', async () => {
  for (const allowCall of [undefined, true]) {
    const v = fakeVerifier();
    const snap = createVerifiedSnapshot({ verifier: { request: v.request }, chainId: 8453, ...(allowCall ? { allowCall } : {}) });
    const r = await snap(async (c) => { try { return await c.call({ to: TO, data: '0x' }); } catch (e) { return e.message; } });
    const value = r.value ?? r;
    if (allowCall) assert.deepEqual(value, { data: '0x' + '00'.repeat(31) + '2a' });
    else { assert.match(String(value), /client\.call is not available/); assert.equal(v.calls.filter((x) => x.method === 'eth_call').length, 0); }
  }
});

test('verifierRequest: pinned state, headers by number and the head only; anything else refused before sending', async () => {
  const v = fakeVerifier(), req = verifierRequest({ request: v.request });
  assert.equal(await req('eth_chainId'), '0x2105');
  await req('eth_call', [{ to: TO, data: '0x' }, { blockHash: HASH }]);
  for (const [m, p] of [['eth_call', [{ to: TO }, 'latest']], ['eth_sendRawTransaction', ['0x00']], ['eth_getLogs', [{}]], ['eth_getBlockByNumber', ['latest', false]]])
    await assert.rejects(req(m, p), /verified|not served|block number/);
  assert.deepEqual(v.calls.map((x) => x.method), ['eth_chainId', 'eth_call']);
});

test('no Windows, network, relay or metal source opts in (the CLI/MCP additions stay caller-specific)', () => {
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(path.join(REPO, d), { withFileTypes: true })) {
    const rel = path.join(d, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'packages', 'dist', 'evidence'].includes(e.name)) walk(rel); continue; }
    if (!/\.(mjs|js)$/.test(e.name) || /\.bundle\.mjs$/.test(e.name) || rel === path.join('network', 'verified-chain.mjs')) continue;
    const s = fs.readFileSync(path.join(REPO, rel), 'utf8');
    if (/allowCall|verifierRequest|verifierClient/.test(s)) hits.push(rel);
  } };
  for (const d of ['windows', 'network', 'relay', 'metal']) walk(d);
  assert.deepEqual(hits, []);
});
