// PRIVATE-APP BROWSER ACCESS FROM AN OWNER-SELECTED FRONTEND (work/private-browser-access-interface.txt).
//
// Three layers, each through real code:
//   1. the supervisor's envelope rules (parseDepOptions / envelopeEditVerdict) through its existing WAF_SELFTEST and
//      CFG_EDIT_SELFTEST seams;
//   2. the frontend module (site/js/core/app-access.js) with REAL P-256 signing (WebCrypto) and the REAL signature check
//      the browser bundle ships (network/management-browser.mjs checkAuthorizationWeb); its chain reads are injected;
//   3. the ACTUAL supervisor.js as a child process (test/helpers/private-app-supervisor.mjs): its real /x/:id data path,
//      sign-in bounce, /__enclave/session hand-off, sessionApi verification and record judgement, against a local chain
//      fixture; and, for the platform ban, the real host-policy gate fed by a local policy world.
// Synthetic keys and local fixtures only. No Enclave service, real chain, wallet or user session is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { getAddress, keccak256, toBytes, toFunctionSelector } from 'viem';
import { sessionRequestSigner } from '../network/management-client.mjs';
import { checkAuthorizationWeb } from '../network/management-browser.mjs';
import { sessionKeyHash, delegateSlot } from '../windows/node/session-api-auth.mjs';
import { startPrivateAppSupervisor } from './helpers/private-app-supervisor.mjs';
import { platformPolicyWorld } from './helpers/platform-policy-world.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pexec = promisify(execFile);

// ---------------------------------------------------------------------------------------------------------------- 1
async function seam(env) {
  const { stdout } = await pexec(process.execPath, [path.join(ROOT, 'supervisor.js')], {
    env: { PATH: process.env.PATH, SECRET: 'test-secret', SESSION_KEY_DIR: mkdtempSync(path.join(tmpdir(), 'enc-access-')),
           ADDRESS_BOOK_ADDRESS: '', REGISTRY_ENABLED: '', CLAIM_ENABLED: '', APP_CERT_DOMAIN: '', DNS_API: '', ...env } });
  return JSON.parse(stdout.trim().split('\n').filter(Boolean).at(-1));
}
// one vector list shared by the supervisor and the site mirror
const GOOD = [['https://dash.example.org'], ['https://dash.example.org:8443', 'https://alt.example.net'], ['http://127.0.0.1:5173'],
  ['http://[::1]:9000'], ['http://localhost:3000'], ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example']];
const BAD = [[], ['https://dash.example.org/'], ['https://dash.example.org/authorize'], ['https://Dash.example.org'], ['http://dash.example.org'],
  ['https://127.0.0.1'], ['http://127.0.0.1'], ['https://user@dash.example.org'], ['https://dash.example.org?x=1'], ['https://dash.example.org#f'],
  ['https://localhost:3000'], ['https://dash'], ['https://a.example', 'https://a.example'], ['javascript:alert(1)'], ['https://dash.example.org:99999'],
  ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example', 'https://e.example']];

test('the envelope `access` namespace: exact owner origins only, fail-closed, and applied live (no restart)', async () => {
  const env = (a) => JSON.stringify({ access: a });
  const r = await seam({ WAF_SELFTEST: JSON.stringify({ parse: [
    ...GOOD.map((f) => env({ frontends: f })), ...BAD.map((f) => env({ frontends: f })),
    env({ frontends: ['https://dash.example.org'], extra: 1 }), env(['https://dash.example.org']), env('https://dash.example.org'),
    JSON.stringify({ access: { frontends: ['https://dash.example.org'] }, waf: { rps: 5 }, config: { k: 1 } }),
  ] }) });
  GOOD.forEach((f, i) => assert.deepEqual(r.parse[i].ok.access, { frontends: f }, JSON.stringify(f)));
  BAD.forEach((f, i) => assert.ok(r.parse[GOOD.length + i].err, 'refused: ' + JSON.stringify(f)));
  const tail = r.parse.slice(GOOD.length + BAD.length);
  assert.match(tail[0].err, /unknown access option "extra"/);
  assert.ok(tail[1].err && tail[2].err);
  assert.deepEqual(tail[3].ok.access, { frontends: ['https://dash.example.org'] }, 'access rides beside waf and config');
  assert.equal(tail[3].ok.waf.rps, 5);

  const running = (envelope) => ({ rec: { _onchain: true, status: 'running', _envelope: envelope } });
  const v = await seam({ CFG_EDIT_SELFTEST: JSON.stringify({ apply: true, records: [
    { ...running('{}'), chainCid: env({ frontends: ['https://dash.example.org'] }) },                                  // owner chooses
    { ...running(env({ frontends: ['https://dash.example.org'] })), chainCid: env({ frontends: ['https://alt.example.net'] }) },   // owner changes
    { ...running(env({ frontends: ['https://dash.example.org'] })), chainCid: '{}' },                                   // owner returns to default
    { ...running('{}'), chainCid: env({ frontends: ['https://dash.example.org/path'] }) },                              // malformed: kept serving, surfaced
    { ...running(env({ frontends: ['https://dash.example.org'] })), chainCid: JSON.stringify({ access: { frontends: ['https://dash.example.org'] }, config: { k: 2 } }) },
  ] }) });
  assert.deepEqual(v.map((x) => x.verdict), ['waf', 'waf', 'waf', 'error', 'restart']);
  // what each applied edit leaves live on the serving record (the claim/resume record uses the same function)
  assert.deepEqual(v.map((x) => x.live && x.live.access), [{ frontends: ['https://dash.example.org'] }, { frontends: ['https://alt.example.net'] }, null, undefined,
    { frontends: ['https://dash.example.org'] }]);
});

test('an older-namespace refusal is fail-closed: an unknown access option never parses to "no options"', async () => {
  const r = await seam({ WAF_SELFTEST: JSON.stringify({ parse: [JSON.stringify({ access: { frontend: 'https://dash.example.org' } })] }) });
  assert.match(r.parse[0].err, /unknown access option "frontend"/);
});

// ---------------------------------------------------------------------------------------------------------------- 2
globalThis.localStorage ||= (() => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
globalThis.sessionStorage ||= globalThis.localStorage;
globalThis.location ||= { hostname: 'dash.example.org', origin: 'https://dash.example.org', href: 'https://dash.example.org/authorize' };
const A = await import(pathToFileURL(path.join(ROOT, 'site/js/core/app-access.js')).href);

test('the site mirror agrees with the supervisor on every origin vector, and edits keep every other namespace', () => {
  for (const f of GOOD) assert.ok(f.every(A.validFrontend), JSON.stringify(f));
  for (const f of BAD.filter((x) => x.length === 1)) assert.equal(A.validFrontend(f[0]), false, f[0]);
  const raw = JSON.stringify({ waf: { rps: 5 }, placement: { hostId: '0x' + '12'.repeat(32) }, config: { k: 1 } });
  const set = A.withAccessFrontends(raw, ['https://dash.example.org', 'http://127.0.0.1:5173']);
  assert.deepEqual(JSON.parse(set), { waf: { rps: 5 }, placement: { hostId: '0x' + '12'.repeat(32) }, config: { k: 1 },
    access: { frontends: ['https://dash.example.org', 'http://127.0.0.1:5173'] } });
  assert.deepEqual(A.accessFrontends(set), ['https://dash.example.org', 'http://127.0.0.1:5173']);
  assert.deepEqual(JSON.parse(A.withAccessFrontends(set, [])), JSON.parse(raw), 'empty = back to the host default; nothing else changes');
  assert.throws(() => A.withAccessFrontends(raw, ['https://dash.example.org/authorize']), /not an exact origin/);
  assert.throws(() => A.withAccessFrontends(raw, ['https://a.example', 'https://a.example']), /twice/);
  assert.throws(() => A.withAccessFrontends(JSON.stringify({ access: { frontends: 'x' } }), []), /Invalid sign-in frontends/, 'a malformed namespace is never overwritten');
  assert.throws(() => A.withAccessFrontends(JSON.stringify({ waf: { pathBlock: ['/' + 'x'.repeat(4100)] } }), ['https://a.example']), /4096-byte/);
});

test('the hand-off target is the runner\'s registered origin, exactly, and never an Enclave dashboard or API name', () => {
  const id = '0x' + 'ab'.repeat(32);
  assert.deepEqual(A.handoffTarget('https://box.example:8443', id), { origin: 'https://box.example:8443', root: '/x/' + id,
    hostPath: 'box.example:8443/x/' + id + '/__enclave/session?d=' + id, sessionUrl: 'https://box.example:8443/x/' + id + '/__enclave/session?d=' + id });
  assert.equal(A.handoffTarget('https://box.example/t/metal0/', id).hostPath, 'box.example/t/metal0/x/' + id + '/__enclave/session?d=' + id);
  for (const bad of ['http://box.example', 'https://u:p@box.example', 'https://box.example?x=1', 'https://box.example#x', 'not a url',
                     'https://api.enclave.host/t/metal0', 'https://enclave.host', 'https://box1.enclave.host', 'https://api.nan.host'])
    assert.throws(() => A.handoffTarget(bad, id), A.AppAccessError, bad);
  assert.equal(A.wantedPath('/\\evil.com/x', 'https://box.example'), '/', 'the backslash trick resolves off-origin and is dropped');
  assert.equal(A.wantedPath('/a/b?c=1', 'https://box.example'), '/a/b?c=1');
});

// a REAL session key in WebCrypto, and the vault/sid the chain fixture says it belongs to
async function webSession({ vault, sid, owner, actions = 1n << 132n, live = true, expiresAt = Math.floor(Date.now() / 1000) + 3600 }) {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const apiAuthorization = async (method, url, body) => {
    const u = new URL(url), hostPath = u.host + u.pathname + u.search, ts = Math.floor(Date.now() / 1000);
    const n = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url');
    const bh = hex(await crypto.subtle.digest('SHA-256', body));
    const msg = `enclave-api-v1\n${method}\n${hostPath}\n${bh}\n${ts}\n${n}\n${vault.toLowerCase()}\n${sid.toLowerCase()}`;
    const sig = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(msg))).toString('base64url');
    return `EnclaveSession v1 vault=${vault},sid=${sid},ts=${ts},n=${n},x=${jwk.x},y=${jwk.y},sig=${sig}`;
  };
  return { owner, session: { handle: { vault, sid }, status: async () => ({ live, expiresAt, actions: String(actions) }), apiAuthorization },
           keyHash: sessionKeyHash(Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')) };
}

test('openPrivateApp: owner, lease, registry and the platform policy decide BEFORE anything is signed; the result is the exact signed hand-off', async () => {
  const id = '0x' + 'cd'.repeat(32), wallet = '0x' + '77'.repeat(20), vault = '0x' + '88'.repeat(20), sid = '0x' + '99'.repeat(32);
  const s = await webSession({ vault, sid, owner: wallet });
  let signed = 0;
  const sess = { ...s, session: { ...s.session, apiAuthorization: async (...a) => { signed++; return s.session.apiAuthorization(...a); } } };
  const lease = (o = {}) => ({ id, owner: vault, runner: '0x' + 'ee'.repeat(32), runnerOperator: '0x' + '44'.repeat(20), chainId: 8453, active: true, isPublic: false,
    leaseUntil: Date.now() + 600000, validUntil: Date.now() + 60000, blockNumber: '1000', ...o });
  const world = { lr: { current: true, host: { endpoint: 'https://box.example:8443' }, lease: lease() }, pol: { admit: true }, session: sess };
  A._useForTests({ agreedLease: async () => world.lr, leaseHostPolicy: async () => world.pol, session: async () => world.session,
    actions: async () => ({ 'api.appAccess': 132 }), wallet: () => wallet, owner: () => wallet, checkAuthorization: checkAuthorizationWeb });
  const out = await A.openPrivateApp(id, { path: '/inbox?q=1' });
  const [base, frag] = out.url.split('#');
  assert.equal(base, 'https://box.example:8443/x/' + id + '/__enclave/session?d=' + id);
  const h = new URLSearchParams(frag);
  assert.equal(h.get('p'), '/inbox?q=1');
  await checkAuthorizationWeb(h.get('a'), { method: 'POST', hostPath: 'box.example:8443/x/' + id + '/__enclave/session?d=' + id, body: new Uint8Array(0) });
  assert.equal(signed, 1);
  const refusals = [
    [() => { world.lr = { ...world.lr, lease: lease({ active: false }) }; }, 'stopped'],
    [() => { world.lr = { ...world.lr, lease: lease({ runner: '0x' + '00'.repeat(32) }) }; }, 'no-host'],
    [() => { world.lr = { ...world.lr, current: false }; }, 'registry'],
    [() => { world.pol = { admit: false, reason: 'banned by platform policy #3 (operator): abuse' }; }, 'policy'],
    [() => { world.lr = { ...world.lr, lease: lease({ owner: '0x' + '55'.repeat(20) }) }; }, 'owner'],          // an unrelated wallet's app
    [() => { world.session = { ...sess, owner: '0x' + '66'.repeat(20) }; }, 'session'],
    [() => { world.session = null; }, 'session'],
    [() => { world.session = { ...sess, session: { ...sess.session, status: async () => ({ live: false, expiresAt: 0, actions: '0' }) } }; }, 'session'],
    [() => { world.session = { ...sess, session: { ...sess.session, status: async () => ({ live: true, expiresAt: Math.floor(Date.now() / 1000) + 99, actions: String(1n << 128n) }) } }; }, 'scope'],
    [() => { world.lr = { ...world.lr, host: { endpoint: 'https://api.enclave.host/t/metal0' } }; }, 'endpoint'],
  ];
  for (const [mutate, kind] of refusals) {
    const keep = { ...world };
    mutate(); signed = 0;
    await assert.rejects(A.openPrivateApp(id), (e) => e instanceof A.AppAccessError && e.kind === kind, kind);
    assert.equal(signed, 0, 'nothing is signed for a refused open: ' + kind);
    Object.assign(world, keep);
  }
  // a signer that signs something OTHER than the exact hand-off (buggy or hostile): refused, nothing navigates
  const keep = world.session;
  world.session = { ...sess, session: { ...sess.session, apiAuthorization: (m, u, b) => s.session.apiAuthorization(m, u.replace('box.example', 'evil.example'), b) } };
  await assert.rejects(A.openPrivateApp(id), (e) => e instanceof A.AppAccessError && e.kind === 'session' && /did not sign exactly this hand-off/.test(e.message));
  world.session = keep;
  world.lr = { ...world.lr, lease: lease({ isPublic: true }) };
  assert.deepEqual(await A.openPrivateApp(id, { path: '/' }), { url: 'https://box.example:8443/x/' + id + '/', public: true, origin: 'https://box.example:8443', runner: '0x' + 'ee'.repeat(32), block: '1000' });
  A._useForTests(null);
});

// ---------------------------------------------------------------------------------------------------------------- 3
const PUBLIC_URL = 'https://host.private.example';
const HOST = 'host.private.example';
const pins = { registry: '0x' + '06'.repeat(20), deployments: '0x' + '05'.repeat(20), appCatalog: '0x' + '08'.repeat(20), proofOfTime: '0x' + '09'.repeat(20),
  enclavePay: '0x' + '00'.repeat(20), verificationFees: '0x' + '00'.repeat(20), sessionVaultFactory: '0x' + '07'.repeat(20), secretVaultV2: '0x' + '00'.repeat(20) };
const ID_VAULT = '0x' + 'a1'.repeat(32), ID_SAFE = '0x' + 'a2'.repeat(32), ID_DEFAULT = '0x' + 'a3'.repeat(32);
const VAULT = getAddress('0x' + '88'.repeat(20)), SID = '0x' + '99'.repeat(32), SAFE = getAddress('0x' + '5a'.repeat(20));
const OTHER_VAULT = getAddress('0x' + '33'.repeat(20)), OTHER_SID = '0x' + '34'.repeat(32), OTHER_WALLET = getAddress('0x' + '35'.repeat(20));
const FRONTENDS = ['https://dash.owner.example', 'https://backup.owner.example'];
const P256 = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const keyHashOf = (k) => { const j = createPublicKey(k.privateKey).export({ format: 'jwk' }); return sessionKeyHash(Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')); };
const APP = 1n << 132n;

function world() {
  const owner = P256(), stranger = P256();
  const chain = { factory: pins.sessionVaultFactory, ledger: pins.deployments, ledgerCode: '0x', delegated: new Set(), vaults: {
    // the owner's session vault: a SAFE owns it (a contract wallet; the vault does not care what kind of address)
    [VAULT.toLowerCase()]: { owner: SAFE, held: { [ID_VAULT]: 2, [ID_DEFAULT]: 2 }, sessions: { [SID]: { keyHash: keyHashOf(owner), actions: String(APP), envs: 2, expiresAt: Math.floor(Date.now() / 1000) + 3600, live: true } } },
    // an unrelated wallet's vault and live session, with every scope
    [OTHER_VAULT.toLowerCase()]: { owner: OTHER_WALLET, held: {}, sessions: { [OTHER_SID]: { keyHash: keyHashOf(stranger), actions: String((1n << 200n) - 1n), envs: 3, expiresAt: Math.floor(Date.now() / 1000) + 3600, live: true } } },
  } };
  return { chain, owner, stranger,
    sign: (k, v, s, now) => sessionRequestSigner({ vault: v, sid: s, privateKey: k.privateKey, ...(now ? { now } : {}) }) };
}
const deployments = [{ id: ID_VAULT, owner: VAULT, access: { frontends: FRONTENDS } },   // vault-held, owner chose frontends
                     { id: ID_SAFE, owner: SAFE, access: { frontends: FRONTENDS } },     // held by the Safe wallet itself
                     { id: ID_DEFAULT, owner: VAULT }];                                   // no choice: the host default
const target = (id) => `/x/${id}/__enclave/session?d=${id}`;
async function post(port, pathq, header, extra = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathq}`, { method: 'POST', headers: { authorization: header, ...extra } });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, cookie: r.headers.get('set-cookie'), code: j && (j.code || j.error), message: j && j.message };
}
const cookieOf = (sc) => sc && sc.split(';')[0];

test('ACTUAL supervisor: the bounce names only the owner\'s frontends; the session hand-off opens the app; the default flow is unchanged', { timeout: 120000 }, async (t) => {
  const w = world();
  const sup = await startPrivateAppSupervisor(t, { chain: w.chain, deployments, pins, publicUrl: PUBLIC_URL });
  const base = `http://127.0.0.1:${sup.port}`;
  const nav = (id, cookie) => fetch(`${base}/x/${id}/inbox?q=1`, { headers: { 'sec-fetch-dest': 'document', ...(cookie ? { cookie } : {}) }, redirect: 'manual' });

  // the bounce for an owner-chosen app: only the owner's origins, never enclave.host
  const b = await nav(ID_VAULT);
  const page = await b.text();
  assert.equal(b.status, 401);
  for (const f of FRONTENDS) assert.ok(page.includes(`href="${f}/authorize?d=${ID_VAULT}"`), f);
  assert.ok(!/enclave\.host/.test(page), 'no enclave.host link or redirect on the owner-chosen bounce');
  assert.match(b.headers.get('content-security-policy'), /default-src 'none'/);
  // the default app keeps the host's sign-in (SIWE_URI, enclave.host by default): the normal-origin flow is unchanged
  const d = await (await nav(ID_DEFAULT)).text();
  assert.ok(d.includes(`https://enclave.host/authorize?d=${ID_DEFAULT}`) && d.includes('Continue to enclave.host'));

  // the owner's hand-off: one session signature for exactly this host + path + deployment
  const sign = w.sign(w.owner, VAULT, SID);
  const ok = await post(sup.port, target(ID_VAULT), sign({ method: 'POST', hostPath: HOST + target(ID_VAULT), body: Buffer.alloc(0) }));
  assert.equal(ok.status, 204, JSON.stringify(ok));
  assert.match(ok.cookie, /^enclave_app=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=43200$/);
  const opened = await nav(ID_VAULT, cookieOf(ok.cookie));
  assert.equal(opened.status, 200);
  assert.match(await opened.text(), new RegExp('PRIVATE-APP ' + ID_VAULT));
  const seen = sup.tenants[ID_VAULT].at(-1);
  assert.equal(seen.cookie, null, 'the app never sees the owner\'s cookie');
  assert.equal(seen.authorization, null);
  // the cookie is audience-bound: it opens no sibling deployment on this host, and is no control-plane session
  assert.equal((await nav(ID_DEFAULT, cookieOf(ok.cookie))).status, 401);
  assert.equal((await fetch(`${base}/v1/deployments`, { headers: { authorization: 'Bearer ' + cookieOf(ok.cookie).slice('enclave_app='.length) } })).status, 401);

  // the normal-origin token flow still works: an app token minted on the control plane, redeemed at the app origin
  const tokenPath = `/v1/deployments/${ID_DEFAULT}/app-token`;
  const mint = await fetch(base + tokenPath, { method: 'POST', headers: { authorization: sign({ method: 'POST', hostPath: HOST + tokenPath, body: Buffer.alloc(0) }) } });
  assert.equal(mint.status, 200);
  const { token } = await mint.json();
  const redeem = await post(sup.port, `/x/${ID_DEFAULT}/__enclave/session`, 'Bearer ' + token);
  assert.equal(redeem.status, 204);
  assert.equal((await nav(ID_DEFAULT, cookieOf(redeem.cookie))).status, 200);
});

test('ACTUAL supervisor: forged, replayed, wrong-deployment, wrong-host, wrong-path, expired, unrelated and unscoped hand-offs open nothing', { timeout: 120000 }, async (t) => {
  const w = world();
  const sup = await startPrivateAppSupervisor(t, { chain: w.chain, deployments, pins, publicUrl: PUBLIC_URL });
  const sign = w.sign(w.owner, VAULT, SID);
  const hp = (id, host = HOST) => host + target(id);
  const empty = Buffer.alloc(0);
  // replay: the second use of one signature is refused (single-use nonce on this host)
  const h = sign({ method: 'POST', hostPath: hp(ID_VAULT), body: empty });
  assert.equal((await post(sup.port, target(ID_VAULT), h)).status, 204);
  const replay = await post(sup.port, target(ID_VAULT), h);
  assert.deepEqual([replay.status, replay.cookie], [401, null]);
  assert.match(replay.message, /replayed/);
  const cases = {
    // signed for ANOTHER host (a frontend tricked into aiming at an attacker's origin): never verifies here
    wrongHost: [target(ID_VAULT), sign({ method: 'POST', hostPath: hp(ID_VAULT, 'evil.example'), body: empty }), 401],
    // signed for one deployment, presented for another (both on this host, same owner vault)
    wrongDeployment: [target(ID_DEFAULT), sign({ method: 'POST', hostPath: hp(ID_VAULT), body: empty }), 401],
    // a query that does not name exactly this deployment
    wrongQuery: [`/x/${ID_VAULT}/__enclave/session?d=${ID_DEFAULT}`, sign({ method: 'POST', hostPath: HOST + `/x/${ID_VAULT}/__enclave/session?d=${ID_DEFAULT}`, body: empty }), 400],
    missingQuery: [`/x/${ID_VAULT}/__enclave/session`, sign({ method: 'POST', hostPath: HOST + `/x/${ID_VAULT}/__enclave/session`, body: empty }), 400],
    // the control-plane app-token signature is not a hand-off (a different path)
    wrongPath: [target(ID_VAULT), sign({ method: 'POST', hostPath: HOST + `/v1/deployments/${ID_VAULT}/app-token`, body: empty }), 401],
    // two minutes old
    expired: [target(ID_VAULT), w.sign(w.owner, VAULT, SID, () => Date.now() - 120000)({ method: 'POST', hostPath: hp(ID_VAULT), body: empty }), 401],
    // a key that is not the session's
    forged: [target(ID_VAULT), w.sign(P256(), VAULT, SID)({ method: 'POST', hostPath: hp(ID_VAULT), body: empty }), 401],
    // an unrelated wallet's own valid, fully-scoped session
    unrelated: [target(ID_VAULT), w.sign(w.stranger, OTHER_VAULT, OTHER_SID)({ method: 'POST', hostPath: hp(ID_VAULT), body: empty }), 403],
  };
  for (const [name, [pathq, header, status]] of Object.entries(cases)) {
    const r = await post(sup.port, pathq, header);
    assert.deepEqual([r.status, r.cookie], [status, null], name + ' ' + JSON.stringify(r));
  }
  // a body is refused (the signature covers none)
  const withBody = await fetch(`http://127.0.0.1:${sup.port}${target(ID_VAULT)}`, { method: 'POST', body: 'x',
    headers: { authorization: sign({ method: 'POST', hostPath: hp(ID_VAULT), body: empty }) } });
  assert.equal(withBody.status, 400);
  // a session without api.appAccess
  w.chain.vaults[VAULT.toLowerCase()].sessions[SID].actions = String(1n << 128n);
  const unscoped = await post(sup.port, target(ID_VAULT), sign({ method: 'POST', hostPath: hp(ID_VAULT), body: empty }));
  assert.deepEqual([unscoped.status, unscoped.cookie], [403, null]);
  assert.match(unscoped.message, /lacks api.appAccess/);
  assert.equal(sup.tenants[ID_VAULT].length, 0, 'no refused hand-off ever reached the app');
});

test('ACTUAL supervisor: revocation, owner rotation and the Safe\'s ledger delegation are read from the chain at hand-off time', { timeout: 120000 }, async (t) => {
  const w = world();
  const sup = await startPrivateAppSupervisor(t, { chain: w.chain, deployments, pins, publicUrl: PUBLIC_URL });
  const sign = w.sign(w.owner, VAULT, SID), empty = Buffer.alloc(0);
  const go = (id) => post(sup.port, target(id), sign({ method: 'POST', hostPath: HOST + target(id), body: empty }));
  // the Safe holds ID_SAFE directly: a session opens it only once the Safe let its vault act for it on the ledger
  assert.equal((await go(ID_SAFE)).status, 403, 'a ledger without delegation support');
  w.chain.ledgerCode = '0x63' + toFunctionSelector('setDelegate(address,bool)').slice(2);
  const ungranted = await go(ID_SAFE);
  assert.equal(ungranted.status, 403);
  assert.match(ungranted.message, /setDelegate/);
  w.chain.delegated.add(delegateSlot(SAFE, VAULT).toLowerCase());                 // the Safe's own setDelegate transaction
  assert.equal((await go(ID_SAFE)).status, 204, 'Safe-delegated session opens the Safe-held app');
  // owner rotation: the vault's owner changes away from the Safe; the Safe's delegation no longer speaks for this vault
  w.chain.vaults[VAULT.toLowerCase()].owner = OTHER_WALLET;
  assert.equal((await go(ID_SAFE)).status, 403, 'rotated: the vault no longer belongs to the deployment\'s holder');
  w.chain.vaults[VAULT.toLowerCase()].owner = SAFE;
  // the deployment leaves the session's environments (adopted to staging only)
  w.chain.vaults[VAULT.toLowerCase()].held[ID_VAULT] = 1;
  assert.equal((await go(ID_VAULT)).status, 403);
  w.chain.vaults[VAULT.toLowerCase()].held[ID_VAULT] = 2;
  assert.equal((await go(ID_VAULT)).status, 204);
  // revocation: the owner ends the session
  w.chain.vaults[VAULT.toLowerCase()].sessions[SID].live = false;
  const ended = await go(ID_VAULT);
  assert.deepEqual([ended.status, ended.code], [401, 'session_ended']);
});

test('ACTUAL supervisor: the platform administrator\'s host ban refuses the app and its hand-off before any owner check', { timeout: 180000 }, async (t) => {
  const hostId = keccak256(toBytes(PUBLIC_URL)).toLowerCase(), op = '0x' + '44'.repeat(20);
  const pw = await platformPolicyWorld(t, { hosts: { [hostId]: { endpoint: PUBLIC_URL, operator: op, owner: '0x' + '55'.repeat(20), active: true } } });
  await pw.publish({ deny: [] });
  const w = world();
  const sup = await startPrivateAppSupervisor(t, { chain: w.chain, deployments, pins, publicUrl: PUBLIC_URL,
    env: pw.env({ ENCLAVE_PLATFORM_HOST_POLICY_INTERVAL_SEC: '1', ENCLAVE_PLATFORM_HOST_POLICY_GRACE_SEC: '6' }) });
  const base = `http://127.0.0.1:${sup.port}`;
  const serving = async () => (await (await fetch(`${base}/v1/health`)).json()).platformHostPolicy;
  const until = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
  assert.ok(await until(async () => (await serving())?.serving === true));
  const sign = w.sign(w.owner, VAULT, SID), empty = Buffer.alloc(0);
  assert.equal((await post(sup.port, target(ID_VAULT), sign({ method: 'POST', hostPath: HOST + target(ID_VAULT), body: empty }))).status, 204, 'admitted: the owner opens it');
  await pw.publish({ deny: [{ kind: 'operator', value: op, reason: 'abuse' }] });
  assert.ok(await until(async () => (await serving())?.banned === true));
  const banned = await post(sup.port, target(ID_VAULT), sign({ method: 'POST', hostPath: HOST + target(ID_VAULT), body: empty }));
  assert.deepEqual([banned.status, banned.code, banned.cookie], [403, 'host_policy_refused', null]);
  const nav = await fetch(`${base}/x/${ID_VAULT}/`, { headers: { 'sec-fetch-dest': 'document' } });
  assert.equal(nav.status, 403);
});
