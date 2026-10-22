// Contract-wallet sign-in against a REAL EVM, end to end: the BUILT component under `wasmtime serve`, pinned to three
// JSON-RPC readers in front of a local anvil chain (helpers/evm.mjs). Two readers forward to anvil untouched, so every
// verdict - a deployed wallet's EIP-1271 isValidSignature, and the ERC-6492 validator simulating a wallet that is NOT
// deployed yet - is executed by the EVM; the third lies, errs or is down. Nothing about a signature is decided by the
// test. The wallets are fixtures/contract-wallet/TestWallets.sol (an ERC-1271 owner wallet with revocation and its
// CREATE2 factory), not a production wallet: what is proven is the protocol the app speaks and its route glue.
//
// No Enclave issuer anywhere: the deployments below pin no SSO signer unless a test is about an existing account, and
// that one then drops the SSO block to show the result outlives the issuer.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { skip as noComponent, AUD, OTHER, KEY_A, KEY_B, SEED, sign, addrOf, ews1, est1, now, serve } from './helpers/component.mjs';
import { haveEvm, startChain, readers, personalSign, hashMessage } from './helpers/evm.mjs';

const skip = noComponent || (!haveEvm && 'anvil/cast missing');
const KEY_C = '0x' + '44'.repeat(32);
const ACCT = 'acct_0e64d1897f10b32d3a1bc84e';
const signer = addrOf(KEY_A).toLowerCase();             // the pinned platform SSO signer, where one is pinned

// what the page does for any signer: ask the deployment for the challenge for `address`, check it, have it signed
async function challenge(s, address) {
  const nonce = 'evm' + Math.random().toString(36).slice(2, 18).padEnd(16, '0');
  const c = await s.call(`/auth/wallet/challenge?address=${address}&nonce=${nonce}`);
  assert.equal(c.status, 200, c.text);
  return c.json.message;
}
const who = (s, token, link) => s.call('/v1/keys', { method: 'POST', token, extra: link ? { 'x-enclave-link': link } : {} });

let chain, deployed, counterfactual;
test.before(async () => {
  if (skip) return;
  chain = await startChain();
  deployed = await chain.deployWallet(KEY_A, 1);          // owner KEY_A, on chain
  counterfactual = await chain.predict(KEY_B, 2);         // owner KEY_B, NOT deployed
  assert.equal(await chain.code(counterfactual), '0x');
  await settle();
});
// the readers judge `confirmations` (2) blocks behind the head, one block a second: a wallet deployed or a revocation
// made just now is not there yet. Waiting past that is the chain's own finality rule, not a test leniency.
const settle = () => new Promise((r) => setTimeout(r, 4000));
test.after(() => chain?.stop());

test('deployed (EIP-1271) and counterfactual (EIP-6492) wallets sign in; one lying or absent reader changes nothing', { skip, timeout: 240_000 }, async () => {
  const rd = await readers(chain);
  const s = await serve((host) => ({ wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, api_key_seed: SEED }));
  try {
    const m1 = await challenge(s, deployed), m2 = await challenge(s, counterfactual);
    const t1 = ews1(m1, personalSign(KEY_A, m1));                          // the owner's signature, judged by the wallet
    const t2 = ews1(m2, chain.wrap6492(KEY_B, 2, personalSign(KEY_B, m2)));   // factory call + owner signature + magic
    const forged1 = ews1(m1, personalSign(KEY_C, m1));
    const forged2 = ews1(m2, chain.wrap6492(KEY_B, 2, personalSign(KEY_C, m2)));
    for (const mode of ['honest', 'denies', 'reverts', 'garbage', 'approves', 'down']) {
      rd.rs[2].setMode(mode);
      const a = await who(s, t1), b = await who(s, t2);
      assert.equal(a.status, 200, `${mode}: ${a.text}`);
      assert.equal(a.json.sub, `wallet_${deployed}`);
      assert.equal(b.status, 200, `${mode}: ${b.text}`);
      assert.equal(b.json.sub, `wallet_${counterfactual}`);
      // a signature by someone else: refused even with the third reader approving everything
      for (const f of [forged1, forged2]) {
        const r = await who(s, f);
        assert.equal(r.status, 401, `${mode}: a forged contract signature passed`);
      }
    }
    // the simulation deployed nothing
    assert.equal(await chain.code(counterfactual), '0x');
  } finally { s.stop(); rd.stop(); }
});

test('the readers decide by agreement: two honest ones are needed, two colluding ones are the configured trust', { skip, timeout: 240_000 }, async () => {
  const rd = await readers(chain);
  const s = await serve((host) => ({ wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, api_key_seed: SEED }));
  try {
    const m = await challenge(s, deployed);
    const good = ews1(m, personalSign(KEY_A, m));
    // one honest reader against two that deny: the carried answer is "not valid"
    rd.rs[1].setMode('denies'); rd.rs[2].setMode('denies');
    assert.equal((await who(s, good)).status, 401);
    // one honest against one that denies and one down: nothing reaches quorum
    rd.rs[2].setMode('down');
    const r = await who(s, good);
    assert.equal(r.status, 401);
    assert.match(r.json.error.message, /did not agree|too few/);
  } finally { s.stop(); rd.stop(); }
  // two colluding approvers DO pass a forgery: `quorum` readers are trusted, which is why the owner chooses them
  const rd2 = await readers(chain, 'approves');
  rd2.rs[1].setMode('approves');
  const t = await serve((host) => ({ wallet: { audience: AUD, domains: [host], contract_wallets: rd2.contract_wallets }, api_key_seed: SEED }));
  try {
    const mt = await challenge(t, deployed);
    assert.equal((await who(t, ews1(mt, personalSign(KEY_C, mt)))).status, 200, 'the stated trust boundary');
  } finally { t.stop(); rd2.stop(); }
});

test('revocation on chain is seen on the next request, deployed or deployed after signing', { skip, timeout: 240_000 }, async () => {
  const rd = await readers(chain);
  const s = await serve((host) => ({ wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, api_key_seed: SEED }));
  try {
    // a deployed wallet's owner revokes the exact message hash
    const m1 = await challenge(s, deployed);
    const t1 = ews1(m1, personalSign(KEY_A, m1));
    assert.equal((await who(s, t1)).status, 200);
    await chain.revoke(KEY_A, deployed, hashMessage(m1));
    await settle();
    assert.equal((await who(s, t1)).status, 401, 'a revoked signature still opened the app');
    // a counterfactual wallet's signature, then the wallet is deployed and its owner revokes: the 6492 token dies too
    const w = await chain.predict(KEY_C, 3);
    const m2 = await challenge(s, w);
    const t2 = ews1(m2, chain.wrap6492(KEY_C, 3, personalSign(KEY_C, m2)));
    assert.equal((await who(s, t2)).status, 200);
    assert.equal(await chain.deployWallet(KEY_C, 3), w);
    await settle();
    assert.equal((await who(s, t2)).status, 200, 'deployment alone changes nothing');
    await chain.revoke(KEY_C, w, hashMessage(m2));
    await settle();
    assert.equal((await who(s, t2)).status, 401);
  } finally { s.stop(); rd.stop(); }
});

test('context binding: another site, deployment or act is refused before any reader is asked', { skip, timeout: 240_000 }, async () => {
  const rd = await readers(chain);
  const s = await serve((host) => ({ wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, api_key_seed: SEED }));
  const o = await serve((host) => ({ wallet: { audience: OTHER, domains: [host], contract_wallets: rd.contract_wallets }, api_key_seed: SEED }));
  try {
    const mo = await challenge(o, counterfactual);
    const forOther = ews1(mo, chain.wrap6492(KEY_B, 2, personalSign(KEY_B, mo)));
    assert.equal((await who(o, forOther)).status, 200);
    const before = rd.calls();
    // the other deployment's valid sign-in, replayed here
    const r = await who(s, forOther);
    assert.equal(r.status, 401);
    assert.match(r.json.error.message, /different (site|deployment)/);
    // the same message edited to name this site (and re-signed by the owner): still the other deployment's audience
    const edited = mo.replaceAll(o.host, s.host);
    const re = await who(s, ews1(edited, chain.wrap6492(KEY_B, 2, personalSign(KEY_B, edited))));
    assert.equal(re.status, 401);
    assert.match(re.json.error.message, /different deployment/);
    // a sign-in offered where an account-link signature is required (another act)
    const link = await s.call('/auth/link', { method: 'POST', body: { account: 'EAK1.x', wallet: forOther } });
    assert.equal(link.status, 401);
    assert.equal(rd.calls(), before, 'a foreign-context token reached the readers');
  } finally { s.stop(); o.stop(); rd.stop(); }
});

test('an existing account moves to a counterfactual wallet once, then needs no issuer; revocation ends it', { skip, timeout: 300_000 }, async () => {
  const rd = await readers(chain);
  const w = await chain.predict(KEY_B, 4);
  const base = (host) => ({ wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, api_key_seed: SEED });
  let link, accountKey, linkMsg;
  // 1. while the issuer still exists: the account's API key, then the one-time link (fresh EST1 + the wallet's link signature)
  const before = await serve((host) => ({ ...base(host), sso: { signer, audience: AUD } }));
  try {
    const est = est1({ aud: AUD, exp: now() + 3600, iat: now(), sub: ACCT, v: 1 });
    accountKey = (await who(before, est)).json.key;
    assert.match(accountKey, /^EAK1\./);
    const nonce = 'lnk' + Math.random().toString(36).slice(2, 18).padEnd(16, '0');
    const c = await before.call('/auth/link/challenge', { method: 'POST', body: { address: w, nonce, account: est } });
    assert.equal(c.status, 200, c.text);
    linkMsg = c.json.message;
    const res = await before.call('/auth/link', { method: 'POST', body: { account: est, wallet: ews1(linkMsg, chain.wrap6492(KEY_B, 4, personalSign(KEY_B, linkMsg))) } });
    assert.equal(res.status, 200, res.text);
    link = res.json.link;
    assert.equal(res.json.wallet, `wallet_${w}`);
  } finally { before.stop(); }
  // 2. the issuer is gone: no sso block at all. The wallet signs in (EIP-6492, still not deployed) and acts as the account
  const after = await serve(base);
  try {
    const m = await challenge(after, w);
    const sess = ews1(m, chain.wrap6492(KEY_B, 4, personalSign(KEY_B, m)));
    const asAcct = await who(after, sess, link);
    assert.equal(asAcct.status, 200, asAcct.text);
    assert.equal(asAcct.json.sub, ACCT);
    assert.equal(asAcct.json.key, accountKey, 'the account keeps its API key');
    assert.equal((await who(after, est1({ aud: AUD, exp: now() + 3600, iat: now(), sub: ACCT, v: 1 }))).status, 401, 'no issuer pinned: EST1 opens nothing');
    // 3. the wallet is deployed; its owner revokes this session's message: the link no longer opens the account
    await chain.deployWallet(KEY_B, 4);
    await chain.revoke(KEY_B, w, hashMessage(m));
    await settle();
    assert.equal((await who(after, sess, link)).status, 401);
  } finally { after.stop(); rd.stop(); }
});

test('the page\'s own hand-signed path: a signer outside the browser (here a counterfactual wallet) signs in', { skip, timeout: 240_000 }, async () => {
  const rd = await readers(chain);
  const s = await serve((host) => ({ wallet: { audience: AUD, domains: [host], contract_wallets: rd.contract_wallets }, api_key_seed: SEED }));
  try {
    const html = readFileSync(new URL('../src/chat.html', import.meta.url), 'utf8');
    const begin = html.indexOf('const b64url = ');
    const slice = html.slice(begin, html.indexOf('\n// Chats persist to IndexedDB', begin));
    const shown = [];
    // the person: types the account's address, signs the text the page shows (on another device), pastes the result
    const handSigner = () => ({
      address: async () => counterfactual,
      sign: async (_bytes, _address, text) => { shown.push(text); return chain.wrap6492(KEY_B, 2, personalSign(KEY_B, text)); },
    });
    const el = () => ({ hidden: true, disabled: false, textContent: '', innerHTML: '' });
    const els = { walletGo: el(), walletNote: el() };
    const store = new Map();
    const ctx = vm.createContext({
      $: (id) => els[id], state: { auth: { wallet: { aud: AUD } } }, window: {}, fetch, URL, handSigner,
      document: { baseURI: `${s.base}/` }, location: { host: s.host }, crypto, TextEncoder, btoa,
      sessionStorage: { setItem: (k, v) => store.set(k, v) }, localStorage: { setItem: (k, v) => store.set(k, v) },
      SSO_KEY: 'llmchat-sso', renderSsoUI: () => {}, closeSso: () => {}, apiOverlay: { classList: { contains: () => false } },
      apiKey: null, revealApiKey: () => {},
    });
    vm.runInContext(`${slice}\nthis.walletStart = walletStart;`, ctx);
    await ctx.walletStart('hand');
    assert.equal(els.walletNote.textContent, '', els.walletNote.textContent);
    assert.equal(shown.length, 1);
    assert.ok(shown[0].toLowerCase().startsWith(`${s.host} wants you to sign in with your ethereum account:\n${counterfactual}`), shown[0]);
    assert.ok(ctx.ssoToken.startsWith('EWS1.'));
    const r = await who(s, ctx.ssoToken);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.sub, `wallet_${counterfactual}`);
    // with no browser wallet the injected path says so and asks nothing
    els.walletNote.textContent = '';
    await ctx.walletStart();
    assert.match(els.walletNote.textContent, /No browser wallet/);
  } finally { s.stop(); rd.stop(); }
});
