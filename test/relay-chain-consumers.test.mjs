// The relay's remaining chain consumers on the ONE verifier authority (relay/relay-chain-authority.mjs), beyond chain() and
// the store pool (test/relay-chain-authority.test.mjs): the measured guest's relay child environment (bound own backend,
// conflicting inherited provider settings refused by name), the custody state reader behind POST /v1/secrets/exists, the
// SessionVault factory/vault reads behind /v1/sessions, the sessions relayer's start, the host-registration sponsor's
// verifier-mode submission (EIP-7702 as a checked state override, never vacuous, sent only to the bound own backend) and the
// MCP reads. Real modules and real relay processes from a flat relay directory built from this source; scripted loopback
// verifier/backend/provider stand-ins record every request; a preload blocks AND records any non-loopback fetch.
// What the verifier proves on real chain data is test/relay-smart-wallet-verifier.e2e.test.mjs and chain-authority's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, sign as cryptoSign, randomBytes } from 'node:crypto';
import { keccak256, toFunctionSelector, parseTransaction, encodeFunctionData, parseAbi, concat, numberToHex, pad, getAddress } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { flatRelay } from './helpers/relay-flat.mjs';
import * as MC from '../metal/guest/measured-control.mjs';
import { relayChildEnv, CHAIN_AUTHORITY_ENV } from '../metal/guest/platform-api-role.mjs';
import { RELAY_VERIFIER_CONFLICTS, RELAY_CHAIN_ENV } from '../relay/relay-chain-env.mjs';
import { checkOwnBackend, createChainAuthority } from '../network/chain-authority.mjs';
import { hostSponsor, sponsorMessage, ENTRYPOINT_08, SIMPLE_7702 } from '../relay/host-sponsor.mjs';

const tmp = fs.mkdtempSync(path.join(process.env.TEST_TMP || os.tmpdir(), 'relay-chain-consumers-'));
const servers = new Set(), children = new Set();
test.after(() => { for (const c of children) try { c.kill('SIGKILL'); } catch {} for (const s of servers) try { s.closeAllConnections?.(); s.close(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });
const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const word = (hex) => String(hex).replace(/^0x/, '').padStart(64, '0');
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

let FLAT = null;
const flat = () => (FLAT ||= flatRelay(tmp));
const PRELOAD = path.join(tmp, 'no-public.mjs');
fs.writeFileSync(PRELOAD, `import fs from 'node:fs';
const orig = globalThis.fetch, log = process.env.PUBLIC_LOG;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    fs.appendFileSync(log, JSON.stringify({ host: u.host, rpc: /jsonrpc/.test(typeof init.body === 'string' ? init.body : '') }) + '\\n');
    throw new TypeError('fetch failed (test: the public network is blocked)');
  }
  return orig(input, init);
};
`);
const publicLog = (name) => path.join(tmp, `public-${name}.jsonl`);
const publicRpc = (name) => (fs.existsSync(publicLog(name)) ? fs.readFileSync(publicLog(name), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((x) => x.rpc);

const HEAD = 100, HEAD_HASH = '0x' + 'ab'.repeat(32);
const blockAt = (n, { hash = n === HEAD ? HEAD_HASH : '0x' + n.toString(16).padStart(64, 'c'), age = 2 } = {}) => ({ number: '0x' + n.toString(16), hash,
  timestamp: '0x' + Math.floor(Date.now() / 1000 - age).toString(16), baseFeePerGas: '0x3b9aca00', parentHash: '0x' + '0'.repeat(64), gasLimit: '0x1c9c380',
  gasUsed: '0x0', miner: a(0), extraData: '0x', logsBloom: '0x' + '0'.repeat(512), difficulty: '0x0', nonce: '0x0000000000000000', stateRoot: '0x' + '5'.repeat(64),
  receiptsRoot: '0x' + '6'.repeat(64), sha3Uncles: '0x' + '7'.repeat(64), size: '0x1', transactionsRoot: '0x' + '8'.repeat(64), transactions: [], uncles: [] });
async function scripted(answer) {
  const calls = [];
  const s = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    let q; try { q = JSON.parse(b); } catch { q = null; }
    const one = (m) => { calls.push({ method: m?.method, params: m?.params || [] }); return { jsonrpc: '2.0', id: m?.id ?? null, ...(answer(m?.method, m?.params || []) ?? { error: { code: -32601, message: 'not scripted' } }) }; };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
  }); });
  servers.add(s); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${s.address().port}/`, methods: () => calls.map((c) => c.method) };
}
const SEL = Object.fromEntries(Object.entries({ addr: 'addr(bytes32)', policyOf: 'policyOf(bytes32)', bundleOf: 'bundleOf(bytes32)', isVault: 'isVault(address)',
  entryPoint: 'entryPoint()', hardwareSponsored: 'hardwareSponsored(bytes32)', operatorSponsored: 'operatorSponsored(address)' }).map(([k, v]) => [k, toFunctionSelector(v)]));
const dataOf = (c) => String(c.params[0]?.data || c.params[0]?.input || '');
const toOf = (c) => String(c.params[0]?.to || '').toLowerCase();
const FACTORY = a(0xf1);
// a verifier that answers the reads these consumers make; `age` ages its head; over(method, params) overrides
const verifierScript = ({ age = 2, over = () => null } = {}) => (method, params) => {
  const o = over(method, params); if (o) return o;
  switch (method) {
    case 'eth_chainId': return { result: '0x2105' };
    case 'eth_blockNumber': return { result: '0x' + HEAD.toString(16) };
    case 'eth_getBlockByNumber': return { result: blockAt(Number(BigInt(params[0])), { age }) };
    case 'eth_getBalance': return { result: '0xde0b6b3a7640000' };
    case 'eth_getCode': return { result: '0x60' };
    case 'eth_call': {
      const d = String(params[0]?.data || params[0]?.input || '');
      if (d.startsWith(SEL.addr)) return { result: '0x' + word(FACTORY) };          // book entries -> the factory
      if (d.startsWith(SEL.policyOf) || d.startsWith(SEL.bundleOf)) return { result: '0x' + '0'.repeat(64 * 6) };   // no custody policy
      if (d.startsWith(SEL.isVault)) return { result: '0x' + word('1') };
      return { result: '0x' + word('7') };
    }
    default: return null;
  }
};
const backendScript = () => (method, params) => {
  switch (method) {
    case 'eth_chainId': return { result: '0x2105' };
    case 'eth_getBlockByNumber': return { result: blockAt(Number(BigInt(params[0]))) };
    default: return null;
  }
};
const STATE = ['eth_call', 'eth_getLogs', 'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionReceipt'];

function child(argv, { env, cwd, until = null, ms = 60000 }) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--import', PRELOAD, ...argv], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(c);
    let out = '', done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ out, code, child: c }); };
    const t = setTimeout(() => finish(null), ms);
    const on = (d) => { out += d; if (until && until.test(out)) finish(null); };
    c.stdout.on('data', on); c.stderr.on('data', on); c.on('exit', (code) => finish(code ?? -1));
  });
}
const auth = (v, b) => ({ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: v.url, ...(b ? { ENCLAVE_CHAIN_TX_BACKEND: b.url } : {}) });
async function apiRelay(name, env) {
  const port = await freePort(), data = fs.mkdtempSync(path.join(tmp, `data-${name}-`));
  const r = await child([path.join(flat(), 'api-relay.js')], { cwd: flat(), until: /\[api-relay\] :\d+/, ms: 60000,
    env: { PATH: process.env.PATH, HOME: flat(), ENCLAVES: 'http://127.0.0.1:1', API_RELAY_PORT: String(port), API_RELAY_BIND: '127.0.0.1',
      ADDRESS_BOOK_ADDRESS: a(0xb00c), DEPLOYMENTS_ADDRESS: a(0x12), FEATURED_VIEWS_FILE: path.join(tmp, `views-${port}.json`), AUTH_DATA_DIR: data,
      SECRETS_KEY: randomBytes(32).toString('hex'), PUBLIC_LOG: publicLog(name), ...env } });
  return { ...r, port };
}
const post = (port, p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.text() }), (e) => ({ status: 0, body: e.message }));
const get = (port, p) => fetch(`http://127.0.0.1:${port}${p}`).then(async (r) => ({ status: r.status, body: await r.text() }), (e) => ({ status: 0, body: e.message }));
const ID = '0x' + '42'.repeat(32);

// ---- the measured guest's relay child -------------------------------------------------------------------------------
const OPS = [...Array(3)].map(() => privateKeyToAccount(generatePrivateKey()).address.toLowerCase());
const rawConfig = (relayEnv) => ({ format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ['https://rpc-a.example/v1', 'https://rpc-b.example'], quorum: 2, releaseId: 'ab'.repeat(32), replicas: { gateways: ['https://replica.example'], storagePlan: null },
  identity: { publicUrl: 'https://host-0.example.org', repo: 'owner/enclave', operator: OPS[0] }, selling: { cpuPrice6: null, payout: null },
  isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096' }, hostAdmissionSha256: null, controlPort: 8444,
  platformApi: { apiPort: 8098, peerPort: 8099, hostname: 'api.chain.test',
    members: OPS.map((op, i) => ({ operator: op, publicUrl: `https://host-${i}.example.org`, controlUrl: `https://127.0.0.1:${9440 + i}` })),
    measurements: ['77'.repeat(48)], minTcb: null, admins: [a(0xad)], recovery: ['11'.repeat(32)], archives: [], archiveMs: 30000, relayEnv, leaseMs: 2000 } });
const V_ENV = { ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:8545/', ENCLAVE_CHAIN_TX_BACKEND: 'http://10.0.2.2:28545/' };

test('guest relay child: the bound own backend is forwarded; the derived BASE_RPC default is not; provider names are refused BY NAME, never deleted', () => {
  assert.deepEqual([...CHAIN_AUTHORITY_ENV], [...RELAY_CHAIN_ENV]);
  const cfg = (relayEnv) => ({ relayEnvBase: { BASE_RPC: 'https://rpc-a.example/v1' }, platformApi: { relayEnv } });
  const env = relayChildEnv({ cfg: cfg(V_ENV), credEnv: { SECRETS_KEY: 'k', ENCLAVE_CHAIN_TX_BACKEND: 'http://10.9.9.9:1/' }, dataDir: '/d' });
  assert.equal(env.BASE_RPC, undefined, 'the role derives no provider default under the verifier');
  assert.equal(env.ENCLAVE_CHAIN_TX_BACKEND, 'http://10.0.2.2:28545/', 'the BOUND backend, a credential cannot change it');
  assert.equal(env.ENCLAVE_CHAIN_VERIFIER, 'http://127.0.0.1:8545/'); assert.equal(env.SECRETS_KEY, 'k');
  for (const [credEnv, relayEnv, named] of [[{ BASE_RPC: 'https://keyed.example/v1/SECRET-TOKEN' }, V_ENV, /credential BASE_RPC/],
    [{ CUSTODY_RPCS: 'https://a.example,https://b.example', SESSIONS_RPC: 'https://s.example' }, V_ENV, /credential CUSTODY_RPCS, credential SESSIONS_RPC/],
    [{}, { ...V_ENV, SECRETS_RELEASE_CATALOG_RPCS: 'https://a.example,https://b.example' }, /bound relayEnv SECRETS_RELEASE_CATALOG_RPCS/]]) {
    assert.throws(() => relayChildEnv({ cfg: cfg(relayEnv), credEnv, dataDir: '/d' }), (e) => e.code === 'relay_chain_conflict' && named.test(e.message)
      && /the relay is not started/.test(e.message) && !/SECRET-TOKEN|https:\/\/(keyed|a|b|s)\.example/.test(e.message));
    assert.ok(credEnv.BASE_RPC === undefined || credEnv.BASE_RPC.endsWith('SECRET-TOKEN'), 'the credential itself is untouched');
  }
  // legacy (quorum / unset): exactly as before, the derived default and a credential override included
  const legacy = relayChildEnv({ cfg: cfg({}), credEnv: {}, dataDir: '/d' });
  assert.equal(legacy.BASE_RPC, 'https://rpc-a.example/v1'); assert.equal(legacy.ENCLAVE_CHAIN_TX_BACKEND, undefined);
  assert.equal(relayChildEnv({ cfg: cfg({}), credEnv: { BASE_RPC: 'https://keyed.example/' }, dataDir: '/d' }).BASE_RPC, 'https://keyed.example/');
});

test('guest relay child start: the bound backend only with the bound verifier and only as checkOwnBackend accepts it; refused by name, child not started', () => {
  // (bind-time refusal belongs in measured-control.mjs, owned elsewhere: logs/claude-relay-consumer-measured-control.proposal.patch)
  const cfg = (relayEnv) => ({ relayEnvBase: {}, platformApi: { relayEnv } });
  for (const [relayEnv, why] of [[{ ENCLAVE_CHAIN_TX_BACKEND: 'http://10.0.2.2:28545/' }, /the bound chain authority is not the verifier/],
    [{ ...V_ENV, ENCLAVE_CHAIN_TX_BACKEND: 'https://base.example/' }, /loopback or private IPv4/],
    [{ ...V_ENV, ENCLAVE_CHAIN_TX_BACKEND: 'http://8.8.8.8:8545/' }, /public address/],
    [{ ...V_ENV, ENCLAVE_CHAIN_TX_BACKEND: 'http://u:p@10.0.0.1/' }, /no credentials/]])
    assert.throws(() => relayChildEnv({ cfg: cfg(relayEnv), credEnv: {}, dataDir: '/d' }), (e) => e.code === 'relay_chain_conflict' && why.test(e.message) && /the relay is not started/.test(e.message));
  for (const u of ['http://10.0.2.2:28545/', 'http://127.0.0.1:8545/', 'http://[::1]:8545/', 'http://192.168.1.2:1/'])
    assert.equal(relayChildEnv({ cfg: cfg({ ...V_ENV, ENCLAVE_CHAIN_TX_BACKEND: u }), credEnv: {}, dataDir: '/d' }).ENCLAVE_CHAIN_TX_BACKEND, u);
});

test('measured config binds the relay child backend only with the verifier, as a private/loopback literal, and refuses provider names beside it', () => {
  assert.deepEqual([...MC.RELAY_VERIFIER_CONFLICTS], [...RELAY_VERIFIER_CONFLICTS], 'the unbundled copy equals the relay\'s list');
  for (const u of ['http://10.0.2.2:28545/', 'https://127.0.0.1/', 'http://[::1]:8545/', 'http://172.16.0.1/', 'http://192.168.1.2:1/', 'http://172.32.0.1/',
    'http://8.8.8.8/', 'https://base.example/', 'http://u:p@10.0.0.1/', 'http://10.0.0.1/?a=1', 'ftp://10.0.0.1/', 'http://10.0.0.256/', 'http://10.0.0.1/#f']) {
    let ok; try { checkOwnBackend(u); ok = true; } catch { ok = false; }
    assert.equal(MC.ownBackendLiteral(u), ok, `${u}: the copy agrees with network/chain-authority.mjs checkOwnBackend`);
  }
  assert.equal(MC.canonicalDirectConfig(rawConfig(V_ENV)).platformApi.relayEnv.ENCLAVE_CHAIN_TX_BACKEND, 'http://10.0.2.2:28545/');
  MC.canonicalDirectConfig(rawConfig({ BASE_RPC: 'https://rpc-a.example/v1' }));                 // legacy: unchanged
  for (const [relayEnv, why] of [[{ ENCLAVE_CHAIN_TX_BACKEND: 'http://10.0.2.2:28545/' }, /TX_BACKEND is set but ENCLAVE_CHAIN_AUTHORITY is not verifier/],
    [{ ...V_ENV, ENCLAVE_CHAIN_TX_BACKEND: 'https://base.example/' }, /loopback or private IPv4/],
    [{ ...V_ENV, BASE_RPC: 'https://rpc-a.example/v1' }, /BASE_RPC cannot be set with ENCLAVE_CHAIN_AUTHORITY=verifier/],
    [{ ...V_ENV, SESSIONS_RPC: 'https://s.example' }, /SESSIONS_RPC cannot be set/]])
    assert.throws(() => MC.canonicalDirectConfig(rawConfig(relayEnv)), why);
});

// ---- custody state (POST /v1/secrets/exists) ------------------------------------------------------------------------
const VAULT2 = a(0xc2);
const custodyRead = (srv) => srv.calls.filter((c) => c.method === 'eth_call' && toOf(c) === VAULT2 && dataOf(c).startsWith(SEL.policyOf));

test('custody route on the verifier: every vault field at ONE numbered block of its head, its age checked; 200 only on a proven answer; stale/outage 503', { timeout: 240000 }, async () => {
  const v = await scripted(verifierScript()), b = await scripted(backendScript());
  const r = await apiRelay('custody-v', { ...auth(v, b), CUSTODY_VAULT_V2: VAULT2 });
  assert.match(r.out, /\[custody\] .* the local verifier \(one proven authority\)/, r.out.slice(-1500));
  const ok = await post(r.port, '/v1/secrets/exists', { id: ID });
  assert.equal(ok.status, 200, ok.body); assert.equal(JSON.parse(ok.body).exists, false);
  const reads = custodyRead(v); assert.ok(reads.length >= 1, v.methods().join());
  const at = reads[0].params[1];
  assert.match(String(at), /^0x[0-9a-f]+$/, 'a numbered block, never "latest"');
  assert.ok(v.calls.some((c) => c.method === 'eth_call' && toOf(c) === VAULT2 && dataOf(c).startsWith(SEL.bundleOf) && c.params[1] === at), 'the same block for every field');
  assert.ok(v.calls.some((c) => c.method === 'eth_getBlockByNumber' && c.params[0] === at), 'the age of that block is checked');
  assert.ok(!b.methods().some((m) => STATE.includes(m)), 'the own backend is never asked for state');
  assert.deepEqual(publicRpc('custody-v'), []);
  r.child.kill('SIGKILL');
  // a stale head (older than CUSTODY_MAX_AGE_SEC 120) and an outage: unconfirmed is 503, never a false "no secrets"
  for (const [name, srv] of [['custody-stale', await scripted(verifierScript({ age: 600 }))], ['custody-down', { url: `http://127.0.0.1:${await freePort()}/`, calls: [], methods: () => [] }]]) {
    const s = await apiRelay(name, { ...auth(srv, b), CUSTODY_VAULT_V2: VAULT2 });
    const res = await post(s.port, '/v1/secrets/exists', { id: ID });
    assert.equal(res.status, 503, `${name}: ${res.body}\n${s.out.slice(-800)}`);
    assert.deepEqual(publicRpc(name), [], name);
    s.child.kill('SIGKILL');
  }
});

test('custody route, legacy: CUSTODY_RPCS (two must agree) exactly as before; the verifier is never asked', { timeout: 240000 }, async () => {
  const p1 = await scripted(verifierScript()), p2 = await scripted(verifierScript()), v = await scripted(verifierScript());
  const r = await apiRelay('custody-legacy', { ADDRESS_BOOK_ADDRESS: undefined, BASE_RPC: p1.url, RPC_FALLBACKS: '0', CUSTODY_VAULT_V2: VAULT2, CUSTODY_RPCS: `${p1.url},${p2.url}` });
  assert.match(r.out, /\[custody\] .* 2 RPCs, 2 must agree/, r.out.slice(-1200));
  const ok = await post(r.port, '/v1/secrets/exists', { id: ID });
  assert.equal(ok.status, 200, ok.body);
  assert.ok(custodyRead(p1).length && custodyRead(p2).length, 'both providers read'); assert.equal(v.calls.length, 0);
  r.child.kill('SIGKILL');
});

// ---- SessionVault factory/vault reads (/v1/sessions) and the relayer's start ------------------------------------------
const BOOK = '0xab214342d5A490150A4A977063A2f88E21F80907'.toLowerCase();   // relay/sessions.mjs NETS.base.book: the admin's book
test('sessions on the verifier: the relayer starts from proven reads; the factory comes from the admin book; isVault through the verifier; nothing public', { timeout: 240000 }, async () => {
  const v = await scripted(verifierScript()), b = await scripted(backendScript());
  const relayer = privateKeyToAccount(generatePrivateKey());
  const r = await apiRelay('sessions-v', { ...auth(v, b), SESSIONS_RELAYER_KEY: generatePrivateKey() });
  assert.ok(await waitFor(() => /\[sessions\] relayer 0x[0-9a-fA-F]{40} \(\d+ wei\) on base, factory 0x[0-9a-fA-F]{40}/.test(r.out)), r.out.slice(-1500));
  assert.ok(v.calls.some((c) => c.method === 'eth_call' && toOf(c) === BOOK && dataOf(c).startsWith(SEL.addr)), 'the factory from the admin\'s book, via the verifier');
  assert.ok(v.methods().includes('eth_getBalance'), 'the relayer\'s gas check is a proven balance');
  const cfg = await get(r.port, '/v1/sessions/config');
  assert.equal(cfg.status, 200, cfg.body); assert.equal(getAddress(JSON.parse(cfg.body).factory), getAddress(FACTORY));
  const vault = relayer.address;
  const q = await post(r.port, '/v1/sessions/quote', { vault });
  assert.ok(await waitFor(() => v.calls.some((c) => c.method === 'eth_call' && toOf(c) === FACTORY && dataOf(c).startsWith(SEL.isVault))), `quote ${q.status} ${q.body}; ${v.methods().join()}`);
  assert.ok(!b.methods().some((m) => STATE.includes(m)), b.methods().join());
  assert.deepEqual(publicRpc('sessions-v'), []);
  r.child.kill('SIGKILL');
  // a provider list beside the verifier stops the relay at startup (before the relayer key is used)
  const mixed = await apiRelay('sessions-mixed', { ...auth(v, b), SESSIONS_RELAYER_KEY: generatePrivateKey(), SESSIONS_RPC: 'http://127.0.0.1:3/' });
  await waitFor(() => mixed.child.exitCode !== null);
  assert.equal(mixed.child.exitCode, 1, mixed.out.slice(-800)); assert.match(mixed.out, /fatal: relay chain authority: .*SESSIONS_RPC must be unset/);
});

test('sessions on the verifier, outage: the relayer reports why and every chain-backed answer fails; no public default is tried', { timeout: 240000 }, async () => {
  const dead = { url: `http://127.0.0.1:${await freePort()}/` }, b = await scripted(backendScript());
  const r = await apiRelay('sessions-down', { ...auth(dead, b), SESSIONS_RELAYER_KEY: generatePrivateKey() });
  assert.ok(await waitFor(() => /\[sessions\] init: /.test(r.out)), r.out.slice(-1200));
  const cfg = await get(r.port, '/v1/sessions/config');
  assert.notEqual(cfg.status, 200, cfg.body);
  assert.deepEqual(publicRpc('sessions-down'), []);
  r.child.kill('SIGKILL');
});

// ---- the host-registration sponsor on the verifier ------------------------------------------------------------------
const REGISTRY = a(0x868e), PAYMASTER = a(0x9a7);
const ACCOUNT_ABI = parseAbi(['function execute(address target, uint256 value, bytes data)']);
const REGISTER_ABI = parseAbi(['function register(string endpoint, string repo, bytes32 measurement, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6, address proofKey) returns (bytes32)']);
const USEROP_EVENT = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f';
const DESIGNATOR = concat(['0xef0100', SIMPLE_7702]).toLowerCase();
async function sponsorWorld({ honorsOverride = true, reverts = false, accountNonce = 0, codeless = null } = {}) {
  const sent = new Map();
  const { privateKey: transportKey, publicKey } = generateKeyPairSync('ed25519');
  const operator = privateKeyToAccount(generatePrivateKey()), name = 'box-' + randomBytes(4).toString('hex');
  const hub = { info: (n) => (n === name ? { name, mode: 'hv-node', spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    hvNode: { boot: { ekCertSha256: 'ee'.repeat(32) } }, claimant: operator.address } : null) };
  const overridden = (params) => String(params[2]?.[operator.address]?.code || params[2]?.[operator.address.toLowerCase()]?.code || '').toLowerCase() === DESIGNATOR;
  const v = await scripted(verifierScript({ over: (method, params) => {
    if (method === 'eth_getTransactionCount') return { result: numberToHex(accountNonce) };
    if (method === 'eth_getCode' && codeless && String(params[0]).toLowerCase() === codeless.toLowerCase()) return { result: '0x' };
    if (method === 'eth_estimateGas') return { result: '0x30d40' };
    if (method === 'eth_getTransactionReceipt') return sent.has(params[0]) ? { result: { blockHash: HEAD_HASH, blockNumber: '0x64', contractAddress: null, cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1',
      from: a(1), gasUsed: '0x1', logsBloom: '0x' + '0'.repeat(512), status: '0x1', to: ENTRYPOINT_08, transactionHash: params[0], transactionIndex: '0x0', type: '0x4',
      logs: [{ address: ENTRYPOINT_08, topics: [USEROP_EVENT, '0x' + '0'.repeat(64), pad(operator.address), pad(PAYMASTER)], data: '0x' + word('0') + word('1') + word('2') + word('3'),
        blockHash: HEAD_HASH, blockNumber: '0x64', logIndex: '0x0', transactionHash: params[0], transactionIndex: '0x0', removed: false }] } } : { error: { code: -32000, message: 'receipt not found' } };
    if (method !== 'eth_call') return null;
    const to = String(params[0]?.to || '').toLowerCase(), d = String(params[0]?.data || params[0]?.input || '');
    if (to === operator.address.toLowerCase() && d === SEL.entryPoint) return { result: honorsOverride && overridden(params) ? '0x' + word(ENTRYPOINT_08) : '0x' };
    if (to === PAYMASTER.toLowerCase()) return { result: '0x' + '0'.repeat(64) };
    if (to === ENTRYPOINT_08.toLowerCase()) return reverts ? { error: { code: 3, message: 'execution reverted: 0xdeadbeef' } } : { result: '0x' };
    return null;
  } }));
  const b = await scripted((method, params) => {
    switch (method) {
      case 'eth_chainId': return { result: '0x2105' };
      case 'eth_getBlockByNumber': return { result: blockAt(Number(BigInt(params[0]))) };
      case 'eth_getTransactionCount': return { result: '0x3' };
      case 'eth_maxPriorityFeePerGas': return { result: '0x5' };
      case 'eth_sendRawTransaction': { const h = keccak256(params[0]); sent.set(h, params[0]); return { result: h }; }
      default: return null;
    }
  });
  const authority = createChainAuthority({ verifier: v.url, backend: b.url, chain: base });
  const sponsor = hostSponsor({ hub, endpointOf: (n) => `https://api.enclave.host/t/${n}`, ownerOf: async () => '', verifierKey: generatePrivateKey(), bundlerKey: generatePrivateKey(),
    paymaster: PAYMASTER, registry: REGISTRY, rpc: 'https://never-used.example', authority });
  const inner = encodeFunctionData({ abi: REGISTER_ABI, functionName: 'register', args: [`https://api.enclave.host/t/${name}`, 'EnclaveHost/enclave', '0x' + '00'.repeat(32), 12n, 0n, a(0)] });
  const op = { sender: operator.address, nonce: '0', callData: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'execute', args: [REGISTRY, 0n, inner] }),
    accountGasLimits: '0x' + word(((100_000n << 128n) | 300_000n).toString(16)), gasFees: '0x' + word(((1_000_000n << 128n) | 100_000_000n).toString(16)),
    preVerificationGas: '50000', paymasterGasLimits: '0x' + '00'.repeat(32), paymasterAndData: concat([PAYMASTER, '0x' + 'ab'.repeat(40)]), signature: '0x1234' };
  const au = await operator.signAuthorization({ address: SIMPLE_7702, contractAddress: SIMPLE_7702, chainId: 8453, nonce: 0 });
  const nonce = randomBytes(16).toString('hex');
  const body = { name, nonce, op, authorization: { address: SIMPLE_7702, chainId: 8453, nonce: 0, r: au.r, s: au.s, yParity: au.yParity },
    sig: cryptoSign(null, Buffer.from(sponsorMessage('submit', name, op, nonce)), transportKey).toString('hex') };
  return { v, b, sponsor, body, operator, sent };
}

test('sponsor on the verifier: proven nonce, override-only delegation (never vacuous), estimate under it; a type-4 handleOps sent ONLY to the bound backend', async () => {
  const w = await sponsorWorld();
  const r = await w.sponsor.submit(w.body);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.success, true);
  const raws = w.b.calls.filter((c) => c.method === 'eth_sendRawTransaction').map((c) => parseTransaction(c.params[0]));
  assert.equal(raws.length, 1); const tx = raws[0];
  assert.equal(tx.type, 'eip7702'); assert.equal(getAddress(tx.to), getAddress(ENTRYPOINT_08)); assert.equal(tx.chainId, 8453);
  assert.equal(getAddress(tx.authorizationList[0].address), getAddress(SIMPLE_7702), 'the operator\'s own signed authorization rides the transaction');
  assert.equal(tx.nonce, 3, 'the bundler\'s pending nonce from the own backend'); assert.equal(tx.maxPriorityFeePerGas, 5n, 'the own backend\'s fee hint');
  assert.ok(tx.gas >= (0x30d40n + 25_000n) * 12n / 10n, `gas ${tx.gas} covers the estimate, the authorization's intrinsic cost and a margin`);
  const ep = w.v.calls.filter((c) => c.method === 'eth_call' && toOf(c) === ENTRYPOINT_08.toLowerCase());
  assert.ok(ep.length > 0 && ep.every((c) => String(c.params[2]?.[w.operator.address]?.code).toLowerCase() === DESIGNATOR
    && c.params[2][w.operator.address].nonce === '0x1'), 'every handleOps execution ran under the delegation override (code = designator, nonce + 1)');
  assert.ok(w.v.calls.some((c) => c.method === 'eth_getTransactionCount' && String(c.params[0]).toLowerCase() === w.operator.address.toLowerCase() && c.params[1] !== 'pending'), 'the proven account nonce');
  assert.ok(!w.v.methods().includes('eth_sendRawTransaction')); assert.ok(!w.b.methods().some((m) => STATE.includes(m)), w.b.methods().join());
});

test('sponsor on the verifier refuses honestly and sends nothing: wrong authorization nonce, a verifier that ignores the override (vacuous), a reverting op, a codeless EntryPoint or delegate', async () => {
  for (const [label, opts, status, why] of [['nonce', { accountNonce: 7 }, 409, /proven nonce is 7/], ['vacuous', { honorsOverride: false }, 503, /did not run Simple7702Account's code/],
    ['revert', { reverts: true }, 422, /would fail/],
    ['no EntryPoint code', { codeless: ENTRYPOINT_08 }, 503, /the EntryPoint .* has no code on the verified chain/],
    ['no Simple7702 code', { codeless: SIMPLE_7702 }, 503, /Simple7702Account .* has no code on the verified chain/]]) {
    const w = await sponsorWorld(opts);
    const r = await w.sponsor.submit(w.body);
    assert.equal(r.status, status, `${label}: ${JSON.stringify(r.body)}`); assert.match(JSON.stringify(r.body), why, label);
    assert.ok(!w.b.methods().includes('eth_sendRawTransaction') && !w.v.methods().includes('eth_sendRawTransaction'), `${label}: nothing sent`);
  }
});

// ---- MCP reads -------------------------------------------------------------------------------------------------------
test('MCP: with the relay authority handed in, its reads are that client\'s and the public list is never contacted; without it, the list as before', { timeout: 120000 }, async () => {
  const script = `const M = await import(process.env.FLAT + '/mcp.js'); const calls = [];
if (process.env.INJECT) M.useMcpChainClient({ readContract: async (q) => { calls.push(q.functionName); throw new Error('recorded'); } });
let err = null, fee = null; try { fee = String(await M.publisherFee6('catalog://0x${'11'.repeat(32)}/0')); } catch (e) { err = String(e.message).slice(0, 200); }
console.log('RESULT ' + JSON.stringify({ calls, err, fee }));`;
  fs.writeFileSync(path.join(flat(), 'mcp-scenario.mjs'), script);
  const run = async (name, extra) => { const r = await child([path.join(flat(), 'mcp-scenario.mjs')], { cwd: flat(), env: { PATH: process.env.PATH, HOME: flat(), FLAT: flat(), PUBLIC_LOG: publicLog(name), ...extra } });
    const m = /RESULT (.*)/.exec(r.out); assert.ok(m, r.out.slice(-1200)); return JSON.parse(m[1]); };
  const inj = await run('mcp-inject', { INJECT: '1' });
  assert.ok(inj.calls.length > 0 && inj.calls[0] === 'addr', JSON.stringify(inj)); assert.deepEqual(publicRpc('mcp-inject'), []);
  const legacy = await run('mcp-legacy', {});
  assert.ok(publicRpc('mcp-legacy').length > 0, 'legacy: the public list is what MCP reads (blocked here)');
  assert.equal(legacy.calls.length, 0);
  // publisherFee6 answers a failed read with its own default in BOTH modes (pre-existing MCP semantics, reported, not changed)
  assert.equal(inj.fee, legacy.fee, JSON.stringify({ inj, legacy }));
});
