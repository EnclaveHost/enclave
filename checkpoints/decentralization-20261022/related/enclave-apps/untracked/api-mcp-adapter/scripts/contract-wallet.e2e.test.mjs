// Contract-wallet (EIP-1271) callers end to end: the BUILT api-mcp-adapter component under `wasmtime serve`, its
// pinned chain readers played by three local JSON-RPC servers. The honest ones run the wallet contract's real rule
// (approve exactly one signature over the EIP-191 hash `cast hash-message` computes); a reader may instead lie, sit on
// another chain, report another block, or be down. What decides is the component's own quorum logic (wallet.rs).
//
//   MCP_WASM=target/wasm32-wasip2/debug/api_mcp_adapter.wasm node --test scripts/contract-wallet.e2e.test.mjs
//
// Skips when the component, wasmtime or cast is missing.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

const WASM = process.env.MCP_WASM || new URL('../target/wasm32-wasip2/release/api_mcp_adapter.wasm', import.meta.url).pathname;
const have = (c) => { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !existsSync(WASM) ? `no component at ${WASM}` : !have('wasmtime') ? 'wasmtime missing' : !have('cast') ? 'cast missing' : false;

const AUD = '0xaaaa000000000000000000000000000000000000000000000000000000000001';
const OTHER = '0x2222222222222222222222222222222222222222222222222222222222222222';
const CONTRACT = '0x00000000000000000000000000000000000c0de1';
const GOOD = '0x' + 'ab'.repeat(130);
const now = () => Math.floor(Date.now() / 1000);
const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const b64u = (b) => Buffer.from(b).toString('base64url');
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const hashOf = (msg) => execFileSync('cast', ['hash-message', msg], { encoding: 'utf8' }).trim();

// an EIP-4361 message as wallet.rs composes and parses it
function siwe({ domain, aud = AUD, extra = [], statement = 'Sign in to this app with your wallet.' }) {
  return `${domain} wants you to sign in with your Ethereum account:\n${CONTRACT}\n\n${statement}\n\nURI: http://${domain}/\n` +
    `Version: 1\nChain ID: 8453\nNonce: e2econtract0123456\nIssued At: ${iso(now() - 5)}\nExpiration Time: ${iso(now() + 3600)}\n` +
    `Resources:\n- urn:enclave:deployment:${aud}${extra.map((r) => `\n- ${r}`).join('')}`;
}
const ews1 = (msg, sig) => `EWS1.${b64u(msg)}.${b64u(Buffer.from(sig.slice(2), 'hex'))}`;

/** mode.value: honest | approve (lies yes) | deny (lies no) | revert | garbage | lowhead | wrongchain | forked | down */
function reader(mode, contract) {
  const head = 70_000;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      contract.calls++;
      if (mode.value === 'down') { res.writeHead(503); return res.end('{}'); }
      const q = JSON.parse(body);
      const hashOf = (n) => '0x' + (mode.value === 'forked' || mode.value === 'wrongchain' ? (n * 13 + 5) : n).toString(16).padStart(64, '0');
      const block = (n) => (n > head ? null : { number: '0x' + n.toString(16), hash: hashOf(n), timestamp: '0x' + (contract.t0 - (head - n) * 2).toString(16) });
      const out = q.map((it) => {
        if (it.method === 'eth_chainId') return { jsonrpc: '2.0', id: it.id, result: mode.value === 'wrongchain' ? '0x1' : '0x2105' };
        if (it.method === 'eth_getBlockByNumber') {
          const n = it.params[0] === 'latest' ? (mode.value === 'lowhead' ? head - 400 : head) : parseInt(it.params[0], 16);
          return { jsonrpc: '2.0', id: it.id, result: block(n) };
        }
        // the call must name a block this reader has, by hash (EIP-1898)
        const at = it.params[1] && it.params[1].blockHash;
        const known = typeof at === 'string' && [...Array(5)].some((_, i) => hashOf(head - i) === at);
        if (!known) return { jsonrpc: '2.0', id: it.id, error: { code: -32000, message: 'header not found' } };
        if (mode.value === 'revert') return { jsonrpc: '2.0', id: it.id, error: { code: 3, message: 'execution reverted' } };
        if (mode.value === 'garbage') return { jsonrpc: '2.0', id: it.id, result: '0xnot-hex' };
        const raw = Buffer.from(it.params[0].data.slice(2), 'hex');
        const len = Number(BigInt('0x' + raw.subarray(68, 100).toString('hex')));
        const honest = it.params[0].to === CONTRACT && raw.subarray(0, 4).toString('hex') === '1626ba7e'
          && contract.hashes.has('0x' + raw.subarray(4, 36).toString('hex')) && '0x' + raw.subarray(100, 100 + len).toString('hex') === GOOD;
        const ok = mode.value === 'approve' ? true : mode.value === 'deny' ? false : honest;
        return { jsonrpc: '2.0', id: it.id, result: ok ? '0x1626ba7e' + '0'.repeat(56) : '0x' + '0'.repeat(64) };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

async function serve(cfg) {
  const port = await freePort();
  const host = `127.0.0.1:${port}`;
  const child = spawn('wasmtime', ['serve', '-Scommon', '--addr', host, '--env', `ENCLAVE_CONFIG=${JSON.stringify(cfg(host))}`, '--env', 'MCP_KEY=adapter-key-0123456789', WASM], { stdio: 'ignore' });
  const base = `http://${host}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/ping`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  const call = async (p, h = {}) => { const r = await fetch(base + p, { headers: h }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {} return { status: r.status, json: j, text: t }; };
  return { host, call, stop: () => child.kill('SIGKILL') };
}

test('contract-wallet callers: agreeing same-chain same-block quorum, revocation, liars, no quorum, cross-context', { skip, timeout: 120_000 }, async () => {
  const contract = { hashes: new Set(), calls: 0, t0: now() };
  const modes = [{ value: 'honest' }, { value: 'honest' }, { value: 'honest' }, { value: 'down' }];
  const readers = await Promise.all(modes.map((m) => reader(m, contract)));
  const s = await serve((host) => ({ http: [{ name: 'echo', url: 'https://example.invalid/x' }],
    wallet: { audience: AUD, domains: [host], contract_wallets: { rpcs: readers.map((r) => r.url), quorum: 2, timeout_secs: 3 } } }));
  const you = async (tok) => (await s.call('/api/status', { 'x-sso-token': tok })).json.you;
  const tools = async (tok) => (await s.call('/api/tools', { 'x-sso-token': tok })).status;
  try {
    const msg = siwe({ domain: s.host });
    contract.hashes.add(hashOf(msg));
    const tok = ews1(msg, GOOD);
    // honest quorum: a SIGNER-proven caller
    assert.deepEqual(await you(tok), { sub: `wallet_${CONTRACT}`, via: 'wallet' });
    // two honest + one liar, BOTH directions: the liar cannot approve a wrong signature...
    modes[2].value = 'approve';
    assert.equal(await you(ews1(msg, '0x' + 'cd'.repeat(130))), undefined);
    assert.equal(await tools(ews1(msg, '0x' + 'cd'.repeat(130))), 401);
    // ...and cannot veto a good one, however it says no
    for (const liar of ['deny', 'revert', 'garbage', 'lowhead']) {
      modes[2].value = liar;
      assert.deepEqual(await you(tok), { sub: `wallet_${CONTRACT}`, via: 'wallet' }, `${liar} vetoed two honest approvals`);
    }
    // a 2-vs-2 split decides nothing
    modes[2].value = 'deny'; modes[3].value = 'deny';
    assert.equal(await tools(tok), 401);
    modes[3].value = 'down';
    // an outvoted reader on another chain or another block changes nothing
    modes[2].value = 'wrongchain';
    assert.deepEqual(await you(tok), { sub: `wallet_${CONTRACT}`, via: 'wallet' });
    modes[2].value = 'forked';
    assert.deepEqual(await you(tok), { sub: `wallet_${CONTRACT}`, via: 'wallet' });
    // no quorum: the rest down, or on another chain
    modes[1].value = 'down'; modes[2].value = 'down';
    assert.equal(await tools(tok), 401);
    modes[1].value = 'wrongchain'; modes[2].value = 'wrongchain';
    assert.equal(await tools(tok), 401);
    modes[1].value = 'forked'; modes[2].value = 'down';
    assert.equal(await tools(tok), 401);
    // revocation: the contract stops accepting the signature
    modes.forEach((m) => { m.value = 'honest'; });
    assert.deepEqual(await you(tok), { sub: `wallet_${CONTRACT}`, via: 'wallet' });
    contract.hashes.clear();
    assert.equal(await tools(tok), 401);
    // another audience, another site, another act: refused before any reader is asked
    const crossAud = siwe({ domain: s.host, aud: OTHER });
    const crossSite = siwe({ domain: 'evil.example' });
    const crossAct = siwe({ domain: s.host, extra: ['urn:enclave:link:account:acct_ab12', `urn:enclave:link:proof:${'00'.repeat(32)}`],
      statement: 'Link the Enclave account acct_ab12 to this wallet on this app. Sign only if you started this yourself: from now on this wallet can act as that account here. This is not a transaction.' });
    for (const m of [crossAud, crossSite, crossAct]) contract.hashes.add(hashOf(m));
    const before = contract.calls;
    for (const m of [crossAud, crossSite, crossAct]) assert.equal(await tools(ews1(m, GOOD)), 401);
    assert.equal(contract.calls, before, 'no reader saw a message for another audience, site or act');
  } finally { s.stop(); readers.forEach((r) => r.srv.close()); }

  // X-User is the owner override: only with the API key, never a signer proof, and it never asks a reader
  const k = await serve((host) => ({ http: [{ name: 'echo', url: 'https://example.invalid/x' }], api_key: '$MCP_KEY',
    wallet: { audience: AUD, domains: [host], contract_wallets: { rpcs: ['http://127.0.0.1:9', 'http://127.0.0.1:10'], quorum: 2, timeout_secs: 1 } } }));
  try {
    const st = await k.call('/api/status', { 'x-api-key': 'adapter-key-0123456789', 'x-user': `wallet_${CONTRACT}` });
    assert.deepEqual(st.json.you, { sub: `wallet_${CONTRACT}`, via: 'key' });
    assert.equal((await k.call('/api/status', { 'x-user': `wallet_${CONTRACT}` })).json.you, undefined);
  } finally { k.stop(); }
});
