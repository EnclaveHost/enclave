// api-mcp-adapter callers with contract wallets against a REAL EVM: the BUILT component under `wasmtime serve`, pinned
// to three JSON-RPC readers in front of a local anvil chain (eyesoff-ai/tests/helpers/evm.mjs, shared by every app that
// carries wallet.rs). Honest readers forward to anvil, so a deployed wallet's EIP-1271 answer and the ERC-6492 validator's
// simulation of a wallet that is not deployed yet are EXECUTED by the EVM; the third reader lies or is down.
// The wallets are test contracts (fixtures/contract-wallet/TestWallets.sol), not a production wallet.
//
//   MCP_WASM=target/wasm32-wasip2/release/api_mcp_adapter.wasm node --test scripts/contract-wallet-evm.e2e.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import test from 'node:test';

import { haveEvm, startChain, readers, personalSign, hashMessage, addressOf } from '../../eyesoff-ai/tests/helpers/evm.mjs';

const WASM = process.env.MCP_WASM || new URL('../target/wasm32-wasip2/release/api_mcp_adapter.wasm', import.meta.url).pathname;
const have = (c) => { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = !existsSync(WASM) ? `no component at ${WASM}` : !have('wasmtime') ? 'wasmtime missing' : !haveEvm ? 'anvil/cast missing' : false;

const AUD = '0xaaaa000000000000000000000000000000000000000000000000000000000001';
const OTHER = '0x2222222222222222222222222222222222222222222222222222222222222222';
const KEY_A = '0x' + '42'.repeat(32), KEY_B = '0x' + '43'.repeat(32), KEY_C = '0x' + '44'.repeat(32);
const now = () => Math.floor(Date.now() / 1000);
const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const b64u = (b) => Buffer.from(b).toString('base64url');
const ews1 = (msg, sig) => `EWS1.${b64u(msg)}.${b64u(Buffer.from(sig.slice(2), 'hex'))}`;
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const settle = () => new Promise((r) => setTimeout(r, 4000));   // past the readers' 2 confirmations at 1 block/s

// an EIP-4361 message as wallet.rs composes and parses it (this app has no challenge route: its callers bring tokens)
function siwe({ domain, address, aud = AUD, nonce = 'evm' + Math.random().toString(36).slice(2, 14).padEnd(12, '0') }) {
  return `${domain} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to this app with your wallet.\n\nURI: http://${domain}/\n` +
    `Version: 1\nChain ID: 8453\nNonce: ${nonce}\nIssued At: ${iso(now() - 5)}\nExpiration Time: ${iso(now() + 3600)}\n` +
    `Resources:\n- urn:enclave:deployment:${aud}`;
}

async function serve(cfg) {
  const port = await freePort();
  const host = `127.0.0.1:${port}`;
  const child = spawn('wasmtime', ['serve', '-Scommon', '--addr', host, '--env', `ENCLAVE_CONFIG=${JSON.stringify(cfg(host))}`, WASM], { stdio: 'ignore' });
  const base = `http://${host}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/ping`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  const you = async (tok) => { const r = await fetch(`${base}/api/status`, { headers: { 'x-sso-token': tok } }); return (await r.json()).you; };
  const tools = async (tok) => (await fetch(`${base}/api/tools`, { headers: { 'x-sso-token': tok } })).status;
  return { host, you, tools, stop: () => child.kill('SIGKILL') };
}

let chain, deployed, counterfactual;
test.before(async () => {
  if (skip) return;
  chain = await startChain();
  deployed = await chain.deployWallet(KEY_A, 11);
  counterfactual = await chain.predict(KEY_B, 12);
  await settle();
});
test.after(() => chain?.stop());

test('EOA, deployed (EIP-1271) and counterfactual (EIP-6492) callers on a real EVM; one liar or absent reader changes nothing', { skip, timeout: 240_000 }, async () => {
  const rd = await readers(chain);
  const s = await serve((host) => ({ http: [{ name: 'echo', url: 'https://example.invalid/x' }],
    wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets } }));
  try {
    const eoa = addressOf(KEY_C);
    const mE = siwe({ domain: s.host, address: eoa }), m1 = siwe({ domain: s.host, address: deployed }), m2 = siwe({ domain: s.host, address: counterfactual });
    const tE = ews1(mE, personalSign(KEY_C, mE));
    const t1 = ews1(m1, personalSign(KEY_A, m1));
    const t2 = ews1(m2, chain.wrap6492(KEY_B, 12, personalSign(KEY_B, m2)));
    // an EOA asks no reader at all
    const c0 = rd.calls();
    assert.deepEqual(await s.you(tE), { sub: `wallet_${eoa}`, via: 'wallet' });
    assert.equal(rd.calls(), c0, 'an EOA reached the readers');
    for (const mode of ['honest', 'denies', 'reverts', 'garbage', 'approves', 'down']) {
      rd.rs[2].setMode(mode);
      assert.deepEqual(await s.you(t1), { sub: `wallet_${deployed}`, via: 'wallet' }, `${mode}: deployed`);
      assert.deepEqual(await s.you(t2), { sub: `wallet_${counterfactual}`, via: 'wallet' }, `${mode}: counterfactual`);
      // the owner key of ANOTHER wallet signing for these: refused, whatever the third reader says
      assert.equal(await s.tools(ews1(m1, personalSign(KEY_B, m1))), 401, `${mode}: forged deployed`);
      assert.equal(await s.tools(ews1(m2, chain.wrap6492(KEY_B, 12, personalSign(KEY_C, m2)))), 401, `${mode}: forged counterfactual`);
    }
    assert.equal(await chain.code(counterfactual), '0x', 'the simulation deployed nothing');
  } finally { s.stop(); rd.stop(); }
});

test('revocation, two-reader agreement and foreign contexts on a real EVM', { skip, timeout: 240_000 }, async () => {
  const rd = await readers(chain);
  const s = await serve((host) => ({ http: [{ name: 'echo', url: 'https://example.invalid/x' }],
    wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets } }));
  try {
    const m1 = siwe({ domain: s.host, address: deployed });
    const t1 = ews1(m1, personalSign(KEY_A, m1));
    assert.equal(await s.tools(t1), 200);
    // one honest reader against two denying: refused
    rd.rs[1].setMode('denies'); rd.rs[2].setMode('denies');
    assert.equal(await s.tools(t1), 401);
    rd.rs[1].setMode('honest'); rd.rs[2].setMode('honest');
    // the owner revokes the message hash on chain: the next request is refused
    await chain.revoke(KEY_A, deployed, hashMessage(m1));
    await settle();
    assert.equal(await s.tools(t1), 401);
    // another audience, another site: refused before any reader is asked
    const crossAud = siwe({ domain: s.host, address: counterfactual, aud: OTHER });
    const crossSite = siwe({ domain: 'evil.example', address: counterfactual });
    const before = rd.calls();
    for (const m of [crossAud, crossSite]) assert.equal(await s.tools(ews1(m, chain.wrap6492(KEY_B, 12, personalSign(KEY_B, m)))), 401);
    assert.equal(rd.calls(), before, 'a foreign-context token reached the readers');
  } finally { s.stop(); rd.stop(); }
});
