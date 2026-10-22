// End to end against the BUILT component under `wasmtime serve`: the sign-in gates as a browser and an API client meet
// them. Direct wallet sign-in (no issuer, no account API), its refusals (another site, another deployment, expired,
// another wallet's signature), identity separation from Sign in with Enclave, old EST1 tokens unchanged, derived keys,
// and the attestation routes with no platform API configured. Signatures come from Foundry's `cast wallet sign` with
// throwaway keys - offline, no chain, the same EIP-191 personal_sign a browser wallet produces.
//
//   cargo build --release --target wasm32-wasip2 && node --test tests/sign-in.e2e.test.mjs
//
// Skips (does not fail) when the wasm, wasmtime or cast is missing.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import vm from 'node:vm';

import { WASM, skip, AUD, OTHER, KEY_A, KEY_B, ADDR_A, SEED, sign, addrOf, b64u, ews1, est1, now, serve, walletSignIn, gated } from './helpers/component.mjs';


test('direct wallet sign-in end to end, with no issuer configured', { skip }, async () => {
  const s = await serve((host) => ({ wallet: { audience: AUD, domains: [host] }, api_key_seed: SEED, attestation: { sources: [] } }));
  try {
    const m = await s.call('/models');
    assert.deepEqual(m.json.auth.wallet, { aud: AUD, chain_id: 8453, ttl_secs: 86400, contract_wallets: false, link: true });
    assert.equal(m.json.auth.sso, false);
    assert.equal(m.json.auth.required, true);

    const none = await gated(s);
    assert.equal(none.status, 401);
    assert.equal(none.json.error.code, 'sso_required');

    const { msg, token } = await walletSignIn(s, KEY_A);
    // through the gate by either header spelling the playground sends
    for (const header of ['authorization', 'x-api-key']) {
      const r = await gated(s, token, header);
      assert.notEqual(r.status, 401, `${header}: ${r.text}`);
    }
    // a derived API key for the WALLET identity, deterministic, and itself accepted on /v1
    const k1 = await s.call('/v1/keys', { method: 'POST', token });
    assert.equal(k1.status, 200, k1.text);
    assert.equal(k1.json.sub, `wallet_${ADDR_A}`);
    const k2 = await s.call('/v1/keys', { method: 'POST', token, header: 'x-api-key' });
    assert.equal(k2.json.key, k1.json.key);
    assert.notEqual((await s.call('/v1/models', { token: k1.json.key, header: 'x-api-key' })).status, 401);

    // REFUSALS, each a message a wallet really signed:
    const resign = (key, m) => ews1(m, sign(key, m));
    // signed for another site (what a phishing page would get a wallet to sign)
    const evil = msg.replaceAll(s.host, 'evil.example').replace('URI: http://evil.example/', 'URI: https://evil.example/');
    assert.equal((await gated(s, resign(KEY_A, evil))).status, 401);
    // signed for another deployment
    assert.equal((await gated(s, resign(KEY_A, msg.replace(AUD, OTHER)))).status, 401);
    // expired (a window that closed an hour ago)
    const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    const stale = msg.replace(/Issued At: .*/, `Issued At: ${iso(now() - 7200)}`).replace(/Expiration Time: .*/, `Expiration Time: ${iso(now() - 3600)}`);
    const r = await gated(s, resign(KEY_A, stale));
    assert.equal(r.status, 401);
    assert.match(r.json.error.message, /expired/);
    // wallet B's signature over a message naming wallet A
    assert.equal((await gated(s, resign(KEY_B, msg))).status, 401);
    // a session longer than the owner allows
    assert.equal((await gated(s, resign(KEY_A, msg.replace(/Expiration Time: .*/, `Expiration Time: ${iso(now() + 30 * 86400)}`)))).status, 401);
    // an Enclave sign-in token where no signer is pinned
    assert.equal((await gated(s, est1({ aud: AUD, exp: now() + 600, iat: now(), sub: 'acct_ab12', v: 1 }))).status, 401);
    // the challenge refuses to compose a message for a Host this deployment does not list
    // (node:http, because fetch will not send a Host of the caller's choosing)
    const foreign = await new Promise((ok, no) => http.get({ host: '127.0.0.1', port: Number(s.host.split(':')[1]),
      path: `/auth/wallet/challenge?address=${ADDR_A}&nonce=0123456789abcdef0`, headers: { host: 'evil.example' } },
      (res) => { res.resume(); ok(res.statusCode); }).on('error', no));
    assert.equal(foreign, 400);
  } finally { s.stop(); }
});

test('Sign in with Enclave keeps working beside the wallet, as a separate identity', { skip }, async () => {
  const s = await serve((host) => ({ sso: { signer: ADDR_A, audience: AUD }, wallet: { audience: AUD, domains: [host] }, api_key_seed: SEED }));
  try {
    const m = await s.call('/models');
    assert.equal(m.json.auth.sso, true);
    assert.equal(m.json.auth.aud, AUD);
    assert.equal(m.json.auth.authorize_url, 'https://enclave.host/sso/authorize');
    // a platform token (EST1, sub = the relay account) opens the gate exactly as before
    const acct = est1({ aud: AUD, exp: now() + 600, iat: now(), sub: 'acct_0e64d1897f10b32d3a1bc84e', v: 1 });
    assert.notEqual((await gated(s, acct)).status, 401);
    assert.equal((await s.call('/v1/keys', { method: 'POST', token: acct })).json.sub, 'acct_0e64d1897f10b32d3a1bc84e');
    // the same wallet address, once vouched for by the platform signer and once signing for itself: two identities
    const viaPlatform = est1({ aud: AUD, exp: now() + 600, iat: now(), sub: ADDR_A, v: 1 });
    const kp = await s.call('/v1/keys', { method: 'POST', token: viaPlatform });
    const { token } = await walletSignIn(s, KEY_A);
    const kw = await s.call('/v1/keys', { method: 'POST', token });
    assert.equal(kp.json.sub, ADDR_A);
    assert.equal(kw.json.sub, `wallet_${ADDR_A}`);
    assert.notEqual(kp.json.key, kw.json.key);
    // and a platform token can never claim the wallet namespace
    const forged = est1({ aud: AUD, exp: now() + 600, iat: now(), sub: `wallet_${ADDR_A}`, v: 1 });
    assert.equal((await gated(s, forged)).status, 401);
    // a platform token for another deployment stays refused
    assert.equal((await gated(s, est1({ aud: OTHER, exp: now() + 600, iat: now(), sub: 'acct_x', v: 1 }))).status, 401);
  } finally { s.stop(); }
});

test('attestation routes need no platform API', { skip }, async () => {
  const s = await serve(() => ({ attestation: { sources: [] } }));
  try {
    const a = await s.call('/attestation');
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.self.path, '/.well-known/enclave-attestation');
    assert.equal(a.json.self.kds, 'https://kdsintf.amd.com');
    assert.equal(a.json.source.api, null);
    assert.equal(a.headers.get('access-control-allow-origin'), '*');
    // the VCEK relay builds only KDS-shaped URLs from validated fields
    assert.equal((await s.call('/attestation/vcek?product=Turin&hwid=../../etc&bl=1&tee=1&snp=1&ucode=1&fmc=1')).status, 400);
    assert.equal((await s.call('/attestation/vcek?url=https://evil.example/')).status, 400);
    // the dialog's verifier is served, and on a runtime with no measured front the self-served path yields nothing
    const js = await fetch(`${s.base}/attest-verify.js`);
    assert.equal(js.status, 200);
    const ctx = vm.createContext({ crypto, TextEncoder, TextDecoder, URL, atob, fetch });
    vm.runInContext(await js.text(), ctx);
    assert.equal(await ctx.EnclaveAttest.selfServed({ origin: `${s.base}/` }), null);
    // a malformed attestation block is a loud configuration error, not a silent default
    const bad = await serve(() => ({ attestation: { sources: ['http://plain.example'] } }));
    try { assert.equal((await bad.call('/attestation')).status, 500); } finally { bad.stop(); }
  } finally { s.stop(); }
});

// The playground's own wallet flow (chat.html walletStart), run against the live component with a stub EIP-1193 wallet:
// what the page builds is what the enclave accepts, and a challenge that names another site never reaches the wallet.
test('the playground page signs in against the component, and refuses a foreign challenge', { skip }, async () => {
  const html = (await import('node:fs')).readFileSync(new URL('../src/chat.html', import.meta.url), 'utf8');
  const begin = html.indexOf('const b64url = ');
  const slice = html.slice(begin, html.indexOf('\n// Chats persist to IndexedDB', begin));
  const s = await serve((host) => ({ wallet: { audience: AUD, domains: [host] } }));
  try {
    const run = async (fetchImpl) => {
      const asked = [];
      const el = () => ({ hidden: true, disabled: false, textContent: '', innerHTML: '' });
      const els = { walletGo: el(), walletNote: el() };
      const ethereum = { request: async ({ method, params }) => {
        asked.push(method);
        if (method === 'eth_requestAccounts') return [ADDR_A];
        if (method === 'personal_sign') return sign(KEY_A, params[0]);   // cast signs 0x-hex as the raw bytes
        throw new Error(method);
      } };
      const store = new Map();
      const ctx = vm.createContext({
        $: (id) => els[id], state: { auth: { wallet: { aud: AUD } } }, window: { ethereum }, fetch: fetchImpl, URL,
        document: { baseURI: `${s.base}/` }, location: { host: s.host }, crypto, TextEncoder, btoa,
        sessionStorage: { setItem: (k, v) => store.set(k, v) }, localStorage: { setItem: (k, v) => store.set(k, v) },
        SSO_KEY: 'llmchat-sso', renderSsoUI: () => {}, closeSso: () => {}, apiOverlay: { classList: { contains: () => false } },
        apiKey: null, revealApiKey: () => {},
      });
      vm.runInContext(`${slice}\nthis.walletStart = walletStart;`, ctx);
      await ctx.walletStart();
      return { ctx, asked, note: els.walletNote.textContent, stored: store.get('llmchat-sso') };
    };
    const ok = await run(fetch);
    assert.deepEqual(ok.asked, ['eth_requestAccounts', 'personal_sign'], ok.note);
    assert.ok(ok.ctx.ssoToken.startsWith('EWS1.'));
    assert.equal(ok.stored, ok.ctx.ssoToken);
    assert.notEqual((await gated(s, ok.ctx.ssoToken, 'x-api-key')).status, 401);
    // a challenge rewritten to name another site (a compromised hop): refused before the wallet is asked to sign
    const evil = await run(async (url, opt) => {
      const r = await fetch(url, opt);
      const j = await r.json();
      j.message = j.message.replaceAll(s.host, 'evil.example');
      return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    assert.deepEqual(evil.asked, ['eth_requestAccounts']);
    assert.equal(evil.ctx.ssoToken, undefined);
    assert.match(evil.note, /does not name this site/);
  } finally { s.stop(); }
});
