// Account continuity and contract wallets, end to end against the BUILT component under `wasmtime serve`.
//
// CONTINUITY. A person with an Enclave account (EST1 `sub` acct_…) can make a wallet act as that account here, and
// only by an explicit act proven with BOTH credentials at once: a fresh platform sign-in (or this deployment's own API
// key for the account, which needs no platform) and a wallet signature over a message naming that account, that exact
// credential, this deployment and ten minutes. The result (ELK1) works only beside that wallet's own sign-in. Everything
// short of that - an old session token, a routine wallet sign-in, a link for another wallet, account, credential or
// deployment, an expired signature - is refused, and a wallet that never linked stays its own identity.
//
// CONTRACT WALLETS. EIP-1271 through owner-pinned JSON-RPC readers, here three local stand-ins: two honest, one that
// approves everything. The honest ones run the wallet contract's rule for real (the signature blob over the EIP-191
// hash `cast hash-message` computes), so the component's quorum logic is what decides.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import vm from 'node:vm';

import { skip, AUD, OTHER, KEY_A, KEY_B, SEED, sign, addrOf, b64u, ews1, est1, now, serve, walletSignIn, gated } from './helpers/component.mjs';

const KEY_C = '0x' + '44'.repeat(32);
const ACCT = 'acct_0e64d1897f10b32d3a1bc84e';
const ACCT2 = 'acct_99aa11bb22cc33dd44ee55ff';
const signer = addrOf(KEY_A).toLowerCase();          // the pinned platform SSO signer in these configs
const fresh = (sub, aud = AUD) => est1({ aud, exp: now() + 3600, iat: now(), sub, v: 1 });
const cfgFull = (host) => ({ sso: { signer, audience: AUD }, wallet: { audience: AUD, domains: [host] }, api_key_seed: SEED });

async function linkChallenge(s, key, cred) {
  const nonce = 'lnk' + Math.random().toString(36).slice(2, 18).padEnd(16, '0');
  return s.call('/auth/link/challenge', { method: 'POST', body: { address: addrOf(key), nonce, account: cred } });
}
async function makeLink(s, key, cred) {
  const c = await linkChallenge(s, key, cred);
  assert.equal(c.status, 200, c.text);
  const msg = c.json.message;
  return { msg, res: await s.call('/auth/link', { method: 'POST', body: { account: cred, wallet: ews1(msg, sign(key, msg)) } }) };
}
const keysAs = (s, token, link) => s.call('/v1/keys', { method: 'POST', token, extra: link ? { 'x-enclave-link': link } : {} });

test('an explicit link lets a wallet keep an Enclave account, and nothing else links', { skip }, async () => {
  const s = await serve(cfgFull);
  try {
    const est = fresh(ACCT);
    const accountKey = (await keysAs(s, est)).json.key;           // what the account had before
    assert.match(accountKey, /^EAK1\./);

    const { msg, res } = await makeLink(s, KEY_B, est);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.account, ACCT);
    assert.equal(res.json.wallet, `wallet_${addrOf(KEY_B).toLowerCase()}`);
    const link = res.json.link;
    assert.ok(msg.includes(`\n- urn:enclave:link:account:${ACCT}\n`), msg);
    assert.ok(msg.includes(`Link the Enclave account ${ACCT} to this wallet`), msg);

    // the wallet's own later sign-in: itself without the link, the account with it - the SAME key as before
    const { token: sessB } = await walletSignIn(s, KEY_B);
    assert.equal((await keysAs(s, sessB)).json.sub, `wallet_${addrOf(KEY_B).toLowerCase()}`);
    const asAcct = await keysAs(s, sessB, link);
    assert.equal(asAcct.status, 200, asAcct.text);
    assert.equal(asAcct.json.sub, ACCT);
    assert.equal(asAcct.json.key, accountKey, 'the account keeps its existing API key');
    // replaying the same proofs inside their ten minutes yields the identical link, nothing more
    assert.equal((await s.call('/auth/link', { method: 'POST', body: { account: est, wallet: ews1(msg, sign(KEY_B, msg)) } })).json.link, link);

    // REFUSALS
    // an old session token still sitting in a tab: valid for sign-in, not for linking
    const stale = est1({ aud: AUD, exp: now() + 3600, iat: now() - 3600, sub: ACCT, v: 1 });
    assert.notEqual((await gated(s, stale)).status, 401);
    const st = await linkChallenge(s, KEY_B, stale);
    assert.equal(st.status, 401);
    assert.match(st.json.error.message, /fresh/);
    // a routine wallet sign-in offered as the link signature
    assert.equal((await s.call('/auth/link', { method: 'POST', body: { account: est, wallet: sessB } })).status, 401);
    // the wallet's link signature, presented with another account's credential
    const est2 = fresh(ACCT2);
    assert.equal((await s.call('/auth/link', { method: 'POST', body: { account: est2, wallet: ews1(msg, sign(KEY_B, msg)) } })).status, 401);
    // the same account, but a different credential than the one the wallet signed for
    const estAgain = est1({ aud: AUD, exp: now() + 3000, iat: now(), sub: ACCT, v: 1 });
    assert.equal((await s.call('/auth/link', { method: 'POST', body: { account: estAgain, wallet: ews1(msg, sign(KEY_B, msg)) } })).status, 401);
    // a message edited to name another account, then signed
    const edited = msg.replaceAll(ACCT, ACCT2);
    assert.equal((await s.call('/auth/link', { method: 'POST', body: { account: est, wallet: ews1(edited, sign(KEY_B, edited)) } })).status, 401);
    // an expired link signature
    const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    const old = msg.replace(/Issued At: .*/, `Issued At: ${iso(now() - 1200)}`).replace(/Expiration Time: .*/, `Expiration Time: ${iso(now() - 600)}`);
    assert.equal((await s.call('/auth/link', { method: 'POST', body: { account: est, wallet: ews1(old, sign(KEY_B, old)) } })).status, 401);
    // a platform sign-in for another deployment
    assert.equal((await linkChallenge(s, KEY_B, fresh(ACCT, OTHER))).status, 401);
    // the link is wallet B's: wallet C's session presenting it acts as nobody's account
    const { token: sessC } = await walletSignIn(s, KEY_C);
    const wrong = await keysAs(s, sessC, link);
    assert.equal(wrong.status, 401);
    assert.match(wrong.json.error.message, /another wallet/);
    // a link is not a session and not a key
    assert.equal((await gated(s, link)).status, 401);
    // a forged link (another seed) is refused
    assert.equal((await keysAs(s, sessB, link.slice(0, -4) + 'AAAA')).status, 401);
  } finally { s.stop(); }

  // another deployment (its own audience and seed) honours neither the link nor the wallet's link signature
  const t = await serve((host) => ({ sso: { signer, audience: OTHER }, wallet: { audience: OTHER, domains: [host] }, api_key_seed: SEED + '-other' }));
  try {
    const { token: sessB } = await walletSignIn(t, KEY_B, OTHER);
    const s2 = await serve(cfgFull);
    let link;
    try { link = (await makeLink(s2, KEY_B, fresh(ACCT))).res.json.link; } finally { s2.stop(); }
    assert.equal((await keysAs(t, sessB, link)).status, 401);
  } finally { t.stop(); }
});

test('issuer-free continuity: the account\'s own API key proves it with no Sign in with Enclave configured', { skip }, async () => {
  let accountKey;
  const before = await serve(cfgFull);
  try { accountKey = (await keysAs(before, fresh(ACCT))).json.key; } finally { before.stop(); }
  // the platform issuer is gone: the deployment keeps its seed, drops the sso block
  const s = await serve((host) => ({ wallet: { audience: AUD, domains: [host] }, api_key_seed: SEED }));
  try {
    const { res } = await makeLink(s, KEY_B, accountKey);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.account, ACCT);
    const { token } = await walletSignIn(s, KEY_B);
    const k = await keysAs(s, token, res.json.link);
    assert.equal(k.json.sub, ACCT);
    assert.equal(k.json.key, accountKey);
    // a WALLET's own derived key is not an account to link
    const walletKey = (await keysAs(s, token)).json.key;
    assert.equal((await linkChallenge(s, KEY_C, walletKey)).status, 401);
    // and an EST1 token is meaningless here: no signer is pinned
    assert.equal((await linkChallenge(s, KEY_B, fresh(ACCT))).status, 401);
  } finally { s.stop(); }
});

test('the playground\'s own link flow, and its link header only beside that wallet', { skip }, async () => {
  const html = readFileSync(new URL('../src/chat.html', import.meta.url), 'utf8');
  const cut = (from, to) => { const a = html.indexOf(from); return html.slice(a, html.indexOf(to, a)); };
  const code = [
    cut('function ssoClaims(t) {', '\nlet ssoToken = null;'),
    cut('function ssoHeaders() {', '\n// display only'),
    cut('const b64url = ', '\nfunction walletNote('),
    cut('function linkNote(text)', '\n$("linkGo").addEventListener'),
  ].join('\n');
  const s = await serve(cfgFull);
  try {
    const store = new Map();
    const el = () => ({ hidden: true, disabled: false, textContent: '', innerHTML: '' });
    const els = { linkNote: el(), linkSec: el(), linkForget: el(), linkGo: el() };
    const asked = [];
    const ctx = vm.createContext({
      $: (id) => els[id], state: { auth: { sso: true, wallet: { aud: AUD, link: true } } }, fetch, URL, atob, btoa, TextEncoder, TextDecoder,
      document: { baseURI: `${s.base}/` }, location: { host: s.host }, crypto, Uint8Array, JSON, Date, Math,
      localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
      window: { ethereum: { request: async ({ method, params }) => {
        asked.push(method);
        if (method === 'eth_requestAccounts') return [addrOf(KEY_B)];
        return sign(KEY_B, params[0]);
      } } },
      ssoStart: () => { throw new Error('should not need a new sign-in'); }, prompt: () => '', apiKey: null,
    });
    vm.runInContext(`${code}\nvar ssoToken = ${JSON.stringify(fresh(ACCT))};\nthis.linkStart = linkStart; this.ssoHeaders = ssoHeaders; this.setTok = (t) => { ssoToken = t; };`, ctx);
    await ctx.linkStart();
    assert.deepEqual(asked, ['eth_requestAccounts', 'personal_sign'], els.linkNote.textContent);
    const stored = JSON.parse(store.get('llmchat-link'));
    assert.equal(stored.account, ACCT);
    // beside the platform session no link header is sent
    assert.equal(ctx.ssoHeaders()['x-enclave-link'], undefined);
    // beside wallet B's own sign-in it is, and the component acts as the account
    const { token: sessB } = await walletSignIn(s, KEY_B);
    ctx.setTok(sessB);
    const h = ctx.ssoHeaders();
    assert.equal(h['x-enclave-link'], stored.link);
    const r = await fetch(`${s.base}/v1/keys`, { method: 'POST', headers: h });
    assert.equal((await r.json()).sub, ACCT);
    // beside another wallet's sign-in it is not sent at all
    const { token: sessC } = await walletSignIn(s, KEY_C);
    ctx.setTok(sessC);
    assert.equal(ctx.ssoHeaders()['x-enclave-link'], undefined);
  } finally { s.stop(); }
});

// ---- EIP-1271 through pinned readers ---------------------------------------------------------------------------

const CONTRACT = '0x00000000000000000000000000000000000c0de1';
const GOOD_SIG = '0x' + 'ab'.repeat(130);

/** A JSON-RPC reader stand-in. `mode`: honest (runs the contract's rule), approve (always approves), stale, down. */
function reader(mode, expect) {
  const head = 50_000;
  // block times are chain facts: fixed for the life of the test, the same for every honest reader
  const t0 = expect.t0 ?? (expect.t0 = now());
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (mode.value === 'down') { res.writeHead(503); return res.end('{}'); }
      const q = JSON.parse(body);
      const ts = mode.value === 'stale' ? t0 - 7200 : t0 - 4;
      const hashOf = (n) => '0x' + n.toString(16).padStart(64, '0');
      const block = (n) => (n > head ? null : { number: '0x' + n.toString(16), hash: hashOf(n), timestamp: '0x' + ts.toString(16) });
      const answer = (it) => {
        if (it.method === 'eth_chainId') return { jsonrpc: '2.0', id: it.id, result: '0x2105' };
        if (it.method === 'eth_getBlockByNumber') return { jsonrpc: '2.0', id: it.id, result: block(it.params[0] === 'latest' ? head : parseInt(it.params[0], 16)) };
        // eth_call, at a block named by hash (EIP-1898, the current wallet.rs) or by number (older builds)
        const at = it.params[1];
        const known = typeof at === 'string' ? parseInt(at, 16) <= head
          : at && typeof at.blockHash === 'string' && [...Array(8)].some((_, i) => hashOf(head - i) === at.blockHash);
        if (!known) return { jsonrpc: '2.0', id: it.id, error: { code: -32000, message: 'header not found' } };
        const { to, data } = it.params[0];
        const raw = Buffer.from(data.slice(2), 'hex');
        const sigLen = Number(BigInt('0x' + raw.subarray(68, 100).toString('hex')));
        const sig = '0x' + raw.subarray(100, 100 + sigLen).toString('hex');
        const honest = to === CONTRACT && raw.subarray(0, 4).toString('hex') === '1626ba7e'
          && expect.hashes.has('0x' + raw.subarray(4, 36).toString('hex')) && sig === GOOD_SIG;
        const ok = mode.value === 'approve' ? true : mode.value === 'revoked' ? false : honest;
        return { jsonrpc: '2.0', id: it.id, result: ok ? '0x1626ba7e' + '0'.repeat(56) : '0x' + '0'.repeat(64) };
      };
      const out = Array.isArray(q) ? q.map(answer) : answer(q);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

test('a contract wallet signs in only when an agreeing fresh quorum of pinned readers says so', { skip }, async () => {
  const expect = { hashes: new Set() };
  const modes = [{ value: 'honest' }, { value: 'honest' }, { value: 'approve' }];
  const readers = await Promise.all(modes.map((m) => reader(m, expect)));
  const s = await serve((host) => ({ wallet: { audience: AUD, domains: [host],
    contract_wallets: { rpcs: readers.map((r) => r.url), quorum: 2, confirmations: 2, max_age_secs: 120, timeout_secs: 3 } } }));
  try {
    assert.equal((await s.call('/models')).json.auth.wallet.contract_wallets, true);
    const c = await s.call(`/auth/wallet/challenge?address=${CONTRACT}&nonce=contract0123456789`);
    const msg = c.json.message;
    expect.hashes.add(execFileSync('cast', ['hash-message', msg], { encoding: 'utf8' }).trim());
    const tok = (sig) => ews1(msg, sig);

    // the wallet contract's valid signature: approved by the agreeing honest readers
    const r = await gated(s, tok(GOOD_SIG));
    assert.notEqual(r.status, 401, r.text);
    // a wrong signature: the approve-everything reader cannot carry it alone
    const bad = await gated(s, tok('0x' + 'cd'.repeat(130)));
    assert.equal(bad.status, 401);
    // honest readers gone: one reader is never a quorum
    modes[0].value = 'down'; modes[1].value = 'down';
    assert.equal((await gated(s, tok(GOOD_SIG))).status, 401);
    assert.equal((await gated(s, tok('0x' + 'cd'.repeat(130)))).status, 401);
    // stale chain views deny
    modes[0].value = 'stale'; modes[1].value = 'stale'; modes[2].value = 'stale';
    const st = await gated(s, tok(GOOD_SIG));
    assert.equal(st.status, 401);
    assert.match(st.json.error.message, /stale/);
    // and an EOA never needed any of them: readers down, ordinary wallet still signs in
    modes.forEach((m) => { m.value = 'down'; });
    const { token } = await walletSignIn(s, KEY_A);
    assert.notEqual((await gated(s, token)).status, 401);
  } finally { s.stop(); readers.forEach((r) => r.srv.close()); }
});

test('a link made with the issuer keeps working where no Enclave signer is pinned at all', { skip }, async () => {
  let link, accountKey;
  const before = await serve(cfgFull);
  try {
    const est = fresh(ACCT);
    accountKey = (await keysAs(before, est)).json.key;
    link = (await makeLink(before, KEY_B, est)).res.json.link;
  } finally { before.stop(); }
  // the same deployment after the issuer is gone: no sso block, so no EST1 is even verifiable here
  const s = await serve((host) => ({ wallet: { audience: AUD, domains: [host] }, api_key_seed: SEED }));
  try {
    assert.equal((await s.call('/models')).json.auth.sso, false);
    const { token } = await walletSignIn(s, KEY_B);
    const k = await keysAs(s, token, link);
    assert.equal(k.status, 200, k.text);
    assert.equal(k.json.sub, ACCT);
    assert.equal(k.json.key, accountKey, 'the account\'s existing key, with no Enclave service involved');
    assert.equal((await gated(s, fresh(ACCT))).status, 401, 'and nothing here honours the issuer any more');
  } finally { s.stop(); }
});

test('a contract wallet can link, and a revoked contract signature stops the link on the next request', { skip }, async () => {
  const expect = { hashes: new Set() };
  const modes = [{ value: 'honest' }, { value: 'honest' }, { value: 'honest' }];
  const readers = await Promise.all(modes.map((m) => reader(m, expect)));
  const s = await serve((host) => ({ ...cfgFull(host), wallet: { audience: AUD, domains: [host],
    contract_wallets: { rpcs: readers.map((r) => r.url), quorum: 2, timeout_secs: 3 } } }));
  try {
    const est = fresh(ACCT);
    const ch = await s.call('/auth/link/challenge', { method: 'POST', body: { address: CONTRACT, nonce: 'contractlink012345', account: est } });
    assert.equal(ch.status, 200, ch.text);
    expect.hashes.add(execFileSync('cast', ['hash-message', ch.json.message], { encoding: 'utf8' }).trim());
    const made = await s.call('/auth/link', { method: 'POST', body: { account: est, wallet: ews1(ch.json.message, GOOD_SIG) } });
    assert.equal(made.status, 200, made.text);
    const c = await s.call(`/auth/wallet/challenge?address=${CONTRACT}&nonce=contractsess012345`);
    expect.hashes.add(execFileSync('cast', ['hash-message', c.json.message], { encoding: 'utf8' }).trim());
    const sess = ews1(c.json.message, GOOD_SIG);
    assert.equal((await keysAs(s, sess, made.json.link)).json.sub, ACCT);
    // the wallet's owners revoke that signature in the contract: the next request is refused
    modes.forEach((m) => { m.value = 'revoked'; });
    assert.equal((await keysAs(s, sess, made.json.link)).status, 401);
    assert.equal((await gated(s, sess)).status, 401);
  } finally { s.stop(); readers.forEach((r) => r.srv.close()); }
});
