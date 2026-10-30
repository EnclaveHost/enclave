// The native CA issuer on the platform API primary (metal/guest/native-issuer.mjs) in the REAL role wiring
// (metal/guest/platform-api-role.mjs): admin-signed credentials sealed to the primary, replicated state, leadership, archive
// pairs and total-loss recovery. What runs here, and what it cannot show:
//   * three member "guests", each with the REAL control front (createControlFront: native names, platform API host and
//     prefix routes), a statement from the REAL mintControlKeys / controlStatement, and the REAL role (with its relay child,
//     the unchanged relay/api-relay.js);
//   * issuance through the REAL issuerDeps: verifyMeasuredControl (unchanged) fed a SYNTHETIC AMD-shaped chain whose ARK this
//     test pins (two chips), the ORIGINAL-registry quorum reader over in-process JSON-RPC, and the REAL platform host policy
//     gate over test/helpers/platform-policy-world.mjs (admin-signed, anchored policies). Nothing proves AMD hardware;
//   * a throwaway native CA shaped like the live one (openssl per run); the live CA is never used;
//   * transitions are real: credential packages through the role's endpoint, a leadership loss through the role's own
//     replica transport (its peers become unreachable), member reboots, a total loss and the admin's recovery.
// The issuer only ever holds the CA key and the members' PUBLIC keys: the members' fronts hold their own keys.
// Every key is disposable; nothing leaves 127.0.0.1.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import * as viem from 'viem';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { synthChain, synthReport } from './helpers/snp-synth.mjs';
import { platformPolicyWorld, REGISTRY } from './helpers/platform-policy-world.mjs';
import { memoryCollateral } from '../verifier/collateral.mjs';
import { TCB_FLOORS } from '../verifier/metal-box.mjs';
import { hostABI } from '../network/registry-abi.mjs';
import * as MC from '../metal/guest/measured-control.mjs';
import { registryIdOf } from '../metal/measured-control-verify.mjs';
import * as hpke from '../custody/hpke.mjs';
import { startRole, groupIdOf, CREDENTIALS_FILE, BOOTSTRAP_PATH, CREDENTIALS_PATH } from '../metal/guest/platform-api-role.mjs';
import { productionVerifier, quorumRegistry } from '../metal/guest/platform-api-verify.mjs';
import { issuerDeps, servedLeaf, CONFIG_PATH } from '../metal/guest/native-issuer.mjs';
import { genesis, recover, buildPackage, signPackage } from '../scripts/platform-api-admin.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-native-issuer-'));
const servers = [], sockets = new Set(), deferred = [];
let roles = [];
const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); return s; };
const keep = (srv) => { servers.push(srv); srv.on('connection', track); return srv; };
after(async () => {
  for (const r of roles) { try { await r.stop(); } catch {} }
  for (const s of sockets) s.destroy();
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch {} }
  for (const f of deferred) { try { await f(); } catch {} }
  fs.rmSync(tmp, { recursive: true, force: true });
});
const T = (ms = 120000) => ({ timeout: ms });
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (what, fn, ms = 45000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(150); } throw new Error(`timed out waiting for ${what} (${JSON.stringify(last)?.slice(0, 400)})`); };
const API = 'api.enclavehost.eth', MCP = 'mcp.enclavehost.eth', HOSTNAME = 'api.platform.test';
const ZA = '0x' + '00'.repeat(20), Z32 = '0x' + '00'.repeat(32);
const a = (n) => '0x' + n.toString(16).padStart(40, '0');

// ---- throwaway native CAs, shaped like the live one --------------------------------------------------------------------------
const o = (args) => execFileSync('openssl', args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
function mintCa(name, subj) {
  o(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.pem`, '-subj', subj, '-days', '30',
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', 'nameConstraints=critical,permitted;DNS:enclavehost.eth']);
  const pem = fs.readFileSync(path.join(tmp, `${name}.pem`), 'utf8'), keyPem = fs.readFileSync(path.join(tmp, `${name}.key`), 'utf8');
  return { pem, keyPem, x: new X509Certificate(pem), sha256: MC.sha256Hex(new X509Certificate(pem).raw), keyLine: keyPem.split('\n')[1] };
}
const NCA = mintCa('native-ca', '/O=Enclave Test/OU=Native/CN=Enclave ENS Service CA'), ROGUE = mintCa('rogue-ca', '/CN=Rogue CA');

// ---- synthetic AMD (two chips), the original registry over JSON-RPC, the admin's policy world ---------------------------------
const S = synthChain({ extraVceks: 1 });
const CHIPS = { a: S, b: { ...S, chip: S.otherVceks[0].chip, vcekKey: S.otherVceks[0].key, vcekDer: S.otherVceks[0].der } };
const VCEK_BY_CHIP = Object.fromEntries(Object.values(CHIPS).map((c) => [c.chip.toString('hex'), c.vcekDer]));
const BASE_COL = memoryCollateral({ chains: { Genoa: S.chainPem }, crls: { Genoa: S.crlDer } });
const COL = { ...BASE_COL, vcek: (product, chipHex) => (VCEK_BY_CHIP[chipHex] ? { der: VCEK_BY_CHIP[chipHex], source: 'memory' } : null) };
const ROOTS = new Map([['Genoa', S.arkFp]]);
const H = (chip) => '0x' + createHash('sha256').update(chip).digest('hex');
const MEAS = '77'.repeat(48);
const HOSTS = {};                                       // registryId -> { operator, active, endpoint, owner, proofKey } (registry + policy facts)
const t0 = Date.now(), head = () => 1000 + Math.floor((Date.now() - t0) / 1000);
const blockAt = (n) => ({ number: toHex(n), hash: keccak256(toHex(n, { size: 32 })), parentHash: keccak256(toHex(n - 1, { size: 32 })), timestamp: toHex(Math.floor(t0 / 1000) + (n - 1000)),
  transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x1', difficulty: '0x0', logsBloom: '0x' + '00'.repeat(256), miner: ZA, nonce: '0x0000000000000000',
  sha3Uncles: Z32, stateRoot: Z32, receiptsRoot: Z32, transactionsRoot: Z32, extraData: '0x', size: '0x1', uncles: [], mixHash: Z32, totalDifficulty: '0x0' });
function rpcAnswer({ method, params }) {
  if (method === 'eth_chainId') return '0x2105';
  if (method === 'eth_blockNumber') return toHex(head());
  if (method === 'eth_getBlockByNumber') return blockAt(params[0] === 'latest' ? head() : Number(params[0]));
  if (method === 'eth_call' && String(params[0].to).toLowerCase() === REGISTRY) {
    const { args } = decodeFunctionData({ abi: hostABI, data: params[0].data }), h = HOSTS[String(args[0]).toLowerCase()];
    return encodeFunctionResult({ abi: hostABI, functionName: 'get', result: { endpoint: h?.endpoint || '', repo: '', measurement: Z32, operator: h?.operator || ZA, registeredAt: 1n, lastSeen: 1n,
      active: !!h?.active, cpuPricePerSec6: 0n, gpuPricePerSec6: 0n, proofKey: h?.proofKey || ZA, payoutWallet: ZA } });
  }
  throw new Error(`unsupported ${method}`);
}
const RPCS = [];
let REG = null, W = null, caFetch = null;

// ---- the group ---------------------------------------------------------------------------------------------------------------
const ADMIN = privateKeyToAccount(generatePrivateKey());
const REC = hpke.generateKeyPair();
const N = 3, OPS = [...Array(N)].map(() => privateKeyToAccount(generatePrivateKey()).address.toLowerCase());
const FRONT_PORTS = [], ROLE_PORTS = [], SINKS = [];
let PA = null;
const archive = new Map();                              // `${sink}|${path}` -> bytes
const archiveFault = { mode: 'ok' };                    // ok | crossed | half
async function archivePut(url, blob) {
  const u = new URL(url), sink = u.origin, which = u.pathname.endsWith('/latest') ? 'snapshot' : 'recovery';
  const m = archiveFault.mode;
  if (m === 'crossed' && ((sink === SINKS[0] && which === 'snapshot') || (sink === SINKS[1] && which === 'recovery'))) throw new Error(`sink ${sink} ${which} refused (test fault)`);
  if (m === 'half' && sink === SINKS[0] && which === 'recovery') throw new Error('sink recovery refused (test fault)');
  archive.set(`${sink}|${u.pathname}`, Buffer.from(blob));
}
const platformApiMember = () => ({ apiPort: 8098, peerPort: 8099, hostname: HOSTNAME,
  members: OPS.map((op, i) => ({ operator: op, publicUrl: `https://host-${i}.example.org`, controlUrl: `https://127.0.0.1:${FRONT_PORTS[i]}` })),
  measurements: [MEAS], minTcb: TCB_FLOORS, admins: [ADMIN.address], recovery: [Buffer.from(REC.publicKey).toString('hex')],
  archives: SINKS, archiveMs: 5000,
  relayEnv: { ENCLAVES: 'http://127.0.0.1:1', OFAC_SDN_URLS: 'http://127.0.0.1:1/x', RPC_FALLBACKS: '0', SIWE_DOMAIN: 'enclave.host', SIWE_URI: 'https://enclave.host',
              BASE_RPC: 'http://127.0.0.1:1/rpc', NATIVE_CA_CERT: 'bound-relayenv-canary' },   // a bound relayEnv name the final filter must drop
  leaseMs: 2000 });
const rawFor = (i, { pa = PA, native = [API, MCP], caSha256 = NCA.sha256 } = {}) => ({ format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: REGISTRY, deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ['https://rpc-a.example/v1', 'https://rpc-b.example'], quorum: 2, releaseId: 'ab'.repeat(32),
  replicas: { gateways: ['http://192.0.2.10:8189'], storagePlan: null },
  identity: { publicUrl: `https://host-${i}.example.org`, repo: 'owner/enclave', operator: OPS[i] },
  selling: { cpuPrice6: null, payout: null }, isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096' },
  hostAdmissionSha256: null, controlPort: 8444, platformApi: pa, ...(native ? { nativeControl: { names: native, caSha256 } } : {}) });

const logs = [];                                         // every role log line (leak checks)
const partitioned = new Set();                           // member indexes whose replica transport is down (a real leadership loss)
const issuerGate = { member: null, reached: null, hit: null, release: null };
function armGate(member) { let hit, release; const reached = new Promise((r) => { hit = r; }), wait = new Promise((r) => { release = r; });
  Object.assign(issuerGate, { member, reached, hit, wait, release: () => { issuerGate.member = null; release(); } }); return issuerGate; }
const hooks = { beforeBarrier: async ({ member }) => { if (issuerGate.member === member) { issuerGate.hit(); await issuerGate.wait; } } };
const verifyMode = { dropChip: false };                  // TEST-ONLY: the verifier's chip withheld (the "unproven chip" case)

async function bootMember(i, { native = [API, MCP], caSha256 = NCA.sha256, chip = 'a', register = true } = {}) {
  const d = fs.mkdtempSync(path.join(tmp, `m${i}-`));
  const P = { ...MC.GUEST_PATHS, runDir: d, sessionDir: path.join(d, 'session'), statement: path.join(d, 'statement.json'), tlsKey: path.join(d, 'tls-key.pem'), tlsCert: path.join(d, 'tls-cert.pem'),
              platformApiConfig: path.join(d, 'platform-api.json'), platformApiHandoffKey: path.join(d, 'handoff.key'), platformApiDir: path.join(d, 'pa'), nativeCertificate: path.join(d, 'native.pem') };
  const config = MC.canonicalDirectConfig(rawFor(i, { native, caSha256 })), digest = MC.configDigest(config), hostData = MC.hostDataHex(digest);
  const keys = MC.mintControlKeys({ paths: P }); keys.platformApi = { publicKey: MC.mintPlatformApiKey({ paths: P }) };
  const st = MC.controlStatement({ config, digest, hostData, mode: 'snp', keys, runtime: { platformApiSha256: '00'.repeat(32) } });
  fs.writeFileSync(P.statement, st.text);
  const proofKey = MC.addressOfPublicKey(keys.proof.publicKey, viem.keccak256), registryId = registryIdOf(config.identity.publicUrl).toLowerCase();
  if (register) HOSTS[registryId] = { operator: OPS[i], active: true, endpoint: config.identity.publicUrl, owner: ZA, proofKey };
  const sup = keep(http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ proofKey: { address: proofKey }, sessionKey: { kid: MC.jwkThumbprint(keys.session.jwk) } })); }));
  await new Promise((r) => sup.listen(0, '127.0.0.1', r));
  const launch = MC.directPlatformApiLaunch(config, { paths: P });
  const roleCfg = { ...JSON.parse(launch.files[P.platformApiConfig]), listen: { ...ROLE_PORTS[i], control: FRONT_PORTS[i] }, askMs: 300,
    relayEnvBase: { ...JSON.parse(launch.files[P.platformApiConfig]).relayEnvBase, NATIVE_CA_KEY: 'base-env-canary' } };   // an injected base name the final filter must drop
  const nat = MC.directNativeLaunch(config, { paths: P });
  const front = keep(MC.createControlFront({ statementText: st.text, keyPem: fs.readFileSync(P.tlsKey, 'utf8'), certPem: keys.controlTls.certPem, mode: 'snp',
    reporter: async (rd) => ({ report: synthReport(CHIPS[chip], { reportData: rd, hostData: Buffer.from(hostData, 'hex') }), certs: null }),
    upstream: { host: '127.0.0.1', port: sup.address().port },
    hostRoutes: [{ host: HOSTNAME, upstream: { host: '127.0.0.1', port: ROLE_PORTS[i].api } }],
    prefixRoutes: [{ prefix: MC.PLATFORM_API_PREFIX, upstream: { host: '127.0.0.1', port: ROLE_PORTS[i].peer } }],
    ...(nat ? { native: { ...nat, upstream: { host: '127.0.0.1', port: ROLE_PORTS[i].api } } } : {}) }));
  await new Promise((r) => front.listen(FRONT_PORTS[i], '127.0.0.1', r));
  const realPost = (url, body, opts) => defaultPostLike(url, body, opts);
  const role = await startRole({ cfg: roleCfg, recoverMessageAddress: viem.recoverMessageAddress, log: (m) => logs.push(`[m${i}] ${m}`),
    verifyPeer: productionVerifier(roleCfg, { registry: REG, collateral: COL, roots: ROOTS }), archivePut,
    postImpl: async (url, body, opts) => { if (partitioned.has(i)) throw new Error('partitioned (test)'); return realPost(url, body, opts); },
    nativeIssuer: { roundMs: 1000, memberTimeoutMs: 20000, requestTimeoutMs: 8000, maxBackoffMs: 3000, hooks,
      deps: async () => {
        const real = await issuerDeps({ platformApi: PA, ownConfig: config, policyEnv: W.env(), collateral: COL, registry: REG, roots: ROOTS, fetch: caFetch, timeoutMs: 8000 });
        return { ...real, verify: async (x) => { const v = await real.verify(x); if (verifyMode.dropChip && v.identity) v.identity.chipId = null; return v; } };
      } } });
  return { i, P, config, st, keys, front, sup, role, chip, registryId, url: `https://127.0.0.1:${FRONT_PORTS[i]}`, dataDir: roleCfg.dirs.data, rootDir: roleCfg.dirs.root,
    spki: keys.controlTls.spkiSha256,
    async kill() { await role.stop(); for (const s of [front, sup]) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); } } };
}
/** the role's own transport, as defaultPost does it (POST JSON or bytes; the peer TLS key is not WebPKI) */
function defaultPostLike(url, body, { binary = false } = {}) {
  const u = new URL(url), data = binary ? body : Buffer.from(JSON.stringify(body));
  return new Promise((ok, no) => {
    const r = https.request({ host: u.hostname, port: u.port, method: 'POST', path: u.pathname, rejectUnauthorized: false, agent: false, timeout: 15000,
      headers: { 'content-type': binary ? 'application/octet-stream' : 'application/json', 'content-length': data.length } }, (res) => {
      const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => { const b = Buffer.concat(c);
        if (res.statusCode !== 200) return no(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
        if (binary) return ok(b); try { ok(JSON.parse(b.toString('utf8'))); } catch { no(new Error('not JSON')); } });
    });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', no); r.end(data);
  });
}
const peerPost = (m, p, body) => new Promise((ok, no) => {
  const data = Buffer.from(JSON.stringify(body));
  const r = https.request({ host: '127.0.0.1', port: FRONT_PORTS[m.i], method: 'POST', path: p, rejectUnauthorized: false, agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
    const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch {} ok({ status: res.statusCode, body: j }); });
  });
  r.on('error', no); r.end(data);
});
/** what a member's front serves at the install path (404 = no leaf) */
const servedChain = (m) => new Promise((ok, no) => {
  const r = https.request({ host: '127.0.0.1', port: FRONT_PORTS[m.i], method: 'GET', path: MC.NATIVE_CERT_PATH, rejectUnauthorized: false, agent: false }, (res) => {
    const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => ok({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
  });
  r.on('error', no); r.end();
});
/** a native client: SNI `name`, the native CA only, the hostname check -> { authorized, spki } */
const nativeHandshake = (m, name, ca = NCA.pem) => new Promise((resolve) => {
  const s = track(tls.connect({ host: '127.0.0.1', port: FRONT_PORTS[m.i], servername: name, ca, rejectUnauthorized: false }, () => {
    const spki = MC.sha256Hex(new X509Certificate(s.getPeerCertificate().raw).publicKey.export({ type: 'spki', format: 'der' }));
    const ok = s.authorized && !tls.checkServerIdentity(name, s.getPeerCertificate());
    s.destroy(); resolve({ authorized: ok, spki });
  }));
  s.on('error', (e) => resolve({ authorized: false, error: e.message }));
});
const leaderOf = (ms) => ms.find((m) => m.role.status().role === 'leader' && m.role.status().relay);
const credentialsPkg = async (lead, credentials) => { await sleep(5); return signPackage(buildPackage({ kind: 'credentials', platformApi: PA, targetStatementText: lead.st.text, credentials }), ADMIN); };
const STRIPE = 'whsec_canary_' + randomBytes(8).toString('hex');
const withCa = (ca = NCA, extra = {}) => ({ STRIPE_WEBHOOK_SECRET: STRIPE, NATIVE_CA_KEY: ca.keyPem, NATIVE_CA_CERT: ca.pem, ...extra });
const issuerOf = (m) => m.role.status().nativeIssuer;
const memberState = (lead, i) => issuerOf(lead).members[i];
const bothNames = async (m, names) => { for (const n of names) { const h = await nativeHandshake(m, n); if (!h.authorized || h.spki !== m.spki) return false; } return true; };

let M = [];
test('setup: three members, an anchored admin policy, genesis by the admin; one primary', T(150000), async (t) => {
  for (let i = 0; i < 3; i++) {
    RPCS.push(`http://127.0.0.1:${await new Promise((r) => { const s = keep(http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
      const one = (q) => { try { return { jsonrpc: '2.0', id: q.id, result: rpcAnswer(q) }; } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; } };
      const b = JSON.parse(Buffer.concat(c)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(b) ? b.map(one) : one(b))); }); }));
      s.listen(0, '127.0.0.1', () => r(s.address().port)); })}`);
  }
  REG = quorumRegistry({ rpcs: RPCS, quorum: 3, registry: REGISTRY });
  W = await platformPolicyWorld({ after: (fn) => deferred.push(fn) }, { hosts: HOSTS });
  caFetch = (url, init = {}) => new Promise((resolve, reject) => {
    const q = https.request(url, { method: init.method || 'GET', ca: fs.readFileSync(W.ca), headers: init.headers, agent: false }, (res) => { const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => resolve(new Response(Buffer.concat(c), { status: res.statusCode }))); }); q.on('error', reject); q.end(); });
  await W.publish({ deny: [] });                         // the admin's policy is anchored (no "not activated" admit)
  for (let i = 0; i < N; i++) { FRONT_PORTS.push(await freePort()); ROLE_PORTS.push({ api: await freePort(), peer: await freePort() }); }
  SINKS.push(`http://127.0.0.1:${await freePort()}`, `http://127.0.0.1:${await freePort()}`);
  PA = MC.canonicalDirectConfig(rawFor(0, { pa: platformApiMember() })).platformApi;
  M.push(await bootMember(0, { chip: 'a' }), await bootMember(1, { chip: 'b' }), await bootMember(2, { chip: 'a', native: [API] }));
  roles = M.map((m) => m.role);
  const g = await genesis({ platformApi: PA, targetStatementText: M[0].st.text, account: ADMIN });
  assert.equal((await peerPost(M[0], BOOTSTRAP_PATH, g.package)).status, 200);
  await waitFor('every member holds the key', () => M.every((m) => m.role.status().haveKey));
  assert.ok(await waitFor('a primary running the relay', () => leaderOf(M), 60000));
  for (const m of M) assert.equal(issuerOf(m).state, 'inactive', 'no native CA credentials yet: the issuer is inert everywhere');
  for (const m of M) assert.equal((await servedChain(m)).status, 404);
});

test('admin credentials with the native CA: the primary issues every bound member (itself over loopback); nothing leaks to the relay, files, logs or archives', T(150000), async () => {
  const lead = await waitFor('a primary', () => leaderOf(M), 60000);
  const r = await peerPost(lead, CREDENTIALS_PATH, await credentialsPkg(lead, withCa(NCA, { RELEASE_SEED_FILE: 'seed-file-canary' })));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.names, ['NATIVE_CA_CERT', 'NATIVE_CA_KEY', 'RELEASE_SEED_FILE', 'STRIPE_WEBHOOK_SECRET']);
  await waitFor('every member serves a native leaf over its OWN attested key', async () => (await Promise.all(M.map((m) => bothNames(m, m.config.nativeControl.names)))).every(Boolean), 60000);
  for (const m of M) {
    const chain = (await servedChain(m)).body.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    const leaf = new X509Certificate(chain[0]);
    assert.ok(leaf.checkIssued(NCA.x) && leaf.verify(NCA.x.publicKey), 'issued by the native CA');
    assert.equal(leaf.subjectAltName, m.config.nativeControl.names.map((n) => `DNS:${n}`).join(', '), 'exactly the bound names');
    assert.equal(Date.parse(leaf.validTo) - Date.parse(leaf.validFrom), 7 * 86400e3);
  }
  assert.equal((await nativeHandshake(M[2], MCP)).authorized, false, 'member 2 is bound to api only');
  assert.ok(M.every((m, i) => ['issued', 'current'].includes(memberState(lead, i).state)), JSON.stringify(issuerOf(lead)));
  assert.ok(logs.some((l) => l.startsWith(`[m${lead.i}]`) && /native leaf issued to member \d/.test(l)));
  // the next round finds each served leaf AUTHENTIC (signed by the held CA over the presented key) and issues nothing new
  await waitFor('every member current', () => issuerOf(lead).members.every((s) => s.state === 'current'), 20000);
  // the relay child: the other credentials, but no NATIVE_CA_* (sealed, base-injected or bound relayEnv) and no key text
  const pid = await waitFor('the relay restarted with the credentials', () => lead.role.status().relay && lead.role.status().childPid);
  const environ = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
  assert.ok(environ.split('\0').includes(`STRIPE_WEBHOOK_SECRET=${STRIPE}`), 'the relay still gets its credentials');
  for (const bad of ['NATIVE_CA_', NCA.keyLine, 'base-env-canary', 'bound-relayenv-canary']) assert.ok(!environ.includes(bad), `the relay environment has no ${bad.slice(0, 20)}`);
  const credsDir = path.join(lead.rootDir, 'creds');
  assert.deepEqual(fs.readdirSync(credsDir), ['RELEASE_SEED_FILE']);
  // logs, status, archives: no key text anywhere
  assert.ok(!logs.join('\n').includes(NCA.keyLine) && !logs.join('\n').includes('PRIVATE KEY'));
  assert.ok(!JSON.stringify(M.map((m) => m.role.status())).includes(NCA.keyLine));
  const blob = await waitFor('an archive written after the credentials', () => archive.get(`${SINKS[0]}|/platform-api/${groupIdOf(PA)}/latest`));
  for (const [k, v] of archive) for (const plain of [NCA.keyLine, STRIPE, 'NATIVE_CA_KEY']) assert.ok(!v.includes(plain), `no plaintext ${plain.slice(0, 12)} in ${k}`);
  assert.ok(blob.length > 0);
  // a replacement without the _FILE credential leaves no stale file behind
  const r2 = await peerPost(lead, CREDENTIALS_PATH, await credentialsPkg(lead, withCa(NCA)));
  assert.equal(r2.status, 200);
  await waitFor('the relay restarted again', () => lead.role.status().childPid && lead.role.status().childPid !== pid);
  assert.deepEqual(fs.existsSync(credsDir) ? fs.readdirSync(credsDir) : [], [], 'the replaced _FILE credential is gone from the RAM fs');
  assert.equal(issuerOf(lead).state, 'active', 'the same native CA credentials: the issuer keeps running');
});

test('servedLeaf: only a leaf the held CA signed over the presented key makes renewal unnecessary (forged, copied-CA, expired, wrong-key and CA leaves do not)', T(), async () => {
  const k = generateKeyPairSync('ec', { namedCurve: 'P-256' }), keyPem = k.privateKey.export({ type: 'pkcs8', format: 'pem' });
  const spkiPem = k.publicKey.export({ type: 'spki', format: 'pem' });
  const leafBy = (ca, { names = [API, MCP], days = 7, isCa = false, pub = spkiPem, before = null, extra = '' } = {}) => {
    const n = randomBytes(4).toString('hex'); fs.writeFileSync(path.join(tmp, `p${n}.pem`), pub);
    fs.writeFileSync(path.join(tmp, `e${n}`), `basicConstraints=critical,CA:${isCa ? 'TRUE' : 'FALSE'}\nkeyUsage=critical,digitalSignature${isCa ? ',keyCertSign' : ''}\nextendedKeyUsage=serverAuth\nsubjectAltName=${names.map((x) => 'DNS:' + x).join(',')}${extra}\n`);
    const time = before ? ['-not_before', before[0], '-not_after', before[1]] : ['-days', String(days)];
    o(['x509', '-new', '-force_pubkey', `p${n}.pem`, '-subj', `/CN=${names[0]}`, '-CA', path.join(tmp, `${ca}.pem`), '-CAkey', path.join(tmp, `${ca}.key`), '-set_serial', '0x1' + n, ...time, '-sha256', '-extfile', `e${n}`, '-out', `l${n}.pem`]);
    return fs.readFileSync(path.join(tmp, `l${n}.pem`), 'utf8');
  };
  const selfSigned = MC.selfSignedCert(k.privateKey, k.publicKey, { cn: API, days: 7 });
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  const cases = {
    genuine: leafBy('native-ca') + NCA.pem,
    'self-signed leaf next to the copied CA certificate': selfSigned + NCA.pem,
    'another CA': leafBy('rogue-ca') + NCA.pem,
    'another key than the one presented': leafBy('native-ca', { pub: other.publicKey.export({ type: 'spki', format: 'pem' }) }) + NCA.pem,
    'a CA certificate as the leaf': leafBy('native-ca', { isCa: true }) + NCA.pem,
    'a name outside the native names': leafBy('native-ca', { names: [API, 'get.enclavehost.eth'] }) + NCA.pem,
    'not valid yet': leafBy('native-ca', { before: [stamp(Date.now() + 3600e3), stamp(Date.now() + 5 * 86400e3)] }) + NCA.pem,
    'three certificates': leafBy('native-ca') + NCA.pem + NCA.pem,
  };
  const results = {};
  for (const [name, chain] of Object.entries(cases)) {
    const leafPem = chain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----\n?/)[0];
    const srv = keep(https.createServer({ key: name === 'another key than the one presented' ? keyPem : keyPem, cert: name === 'another key than the one presented' ? selfSigned : leafPem },
      (req, res) => { res.writeHead(200); res.end(chain); }));
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    results[name] = await servedLeaf(`https://127.0.0.1:${srv.address().port}`, NCA.x, { timeoutMs: 5000 });
    srv.closeAllConnections(); srv.close();
  }
  assert.ok(results.genuine.validTo > Date.now() + 6 * 86400e3, 'the genuine leaf is current');
  for (const [name, r] of Object.entries(results)) if (name !== 'genuine') assert.equal(r.validTo, null, `${name}: not current, so the issuer verifies and issues`);
});

test('the admin\'s policy at issuance: operator ban, chip ban, unproven chip and an unregistered boot get no leaf; lifting them issues', T(180000), async () => {
  const lead = await waitFor('a primary', () => leaderOf(M), 60000), target = M.find((m) => m !== lead && m.config.nativeControl.names.length === 2) || M.find((m) => m !== lead);
  const idx = target.i;
  await W.publish({ deny: [{ kind: 'operator', value: OPS[idx], reason: 'abuse' }] });
  await target.kill();
  const b = await bootMember(idx, { chip: target.chip, native: target.config.nativeControl.names });
  M = M.map((m) => (m === target ? b : m)); roles = M.map((m) => m.role);
  await waitFor('the reboot holds the key', () => b.role.status().haveKey, 60000);
  const st = () => memberState(leaderOf(M), idx);
  await waitFor('refused by the operator ban', () => st().state === 'refused' && /banned by platform policy #\d+ \(operator\)/.test(st().reason), 30000);
  assert.equal((await servedChain(b)).status, 404, 'no leaf for a banned host');
  // a chip ban on THIS boot's chip (the verifier's sha256 CHIP_ID), operator unbanned
  await W.publish({ deny: [{ kind: 'chipId', value: H(CHIPS[b.chip].chip), reason: 'chip ban' }] });
  await waitFor('refused by the chip ban', () => st().state === 'refused' && /\(chipId\)/.test(st().reason), 30000);
  // a chip ban on ANOTHER chip, while this boot's chip is not proven (test-only: the verifier's chip withheld)
  await W.publish({ deny: [{ kind: 'chipId', value: H(randomBytes(64)), reason: 'other chip' }] });
  verifyMode.dropChip = true;
  await waitFor('refused: chip unproven under a chip denial', () => st().state === 'refused' && /chip is not proven/.test(st().reason), 30000);
  verifyMode.dropChip = false;
  // the original registry no longer names this host: the verifier stays pending, nothing is issued
  const row = HOSTS[b.registryId]; delete HOSTS[b.registryId];
  await waitFor('refused while unregistered', () => st().state === 'refused' && /attestation pending/.test(st().reason), 30000);
  assert.equal((await servedChain(b)).status, 404);
  HOSTS[b.registryId] = row;
  await W.publish({ deny: [] });
  await waitFor('issued once admitted', async () => bothNames(b, b.config.nativeControl.names), 40000);
});

test('a ban published AFTER the leaf was signed and BEFORE its install stops the install (the admission is decided again at the barrier)', T(150000), async () => {
  const lead = await waitFor('a primary', () => leaderOf(M), 60000), target = M.find((m) => m !== lead), idx = target.i, st = () => memberState(leaderOf(M), idx);
  await target.kill();
  const b = await bootMember(idx, { chip: target.chip, native: target.config.nativeControl.names });
  M = M.map((m) => (m === target ? b : m)); roles = M.map((m) => m.role);
  const gate = armGate(idx);
  await gate.reached;                                    // verified, admitted, signed: waiting right before the barrier
  await W.publish({ deny: [{ kind: 'operator', value: OPS[idx], reason: 'late ban' }] });
  gate.release();
  await waitFor('refused at install', () => st().state === 'refused' && /at install: .*late ban/.test(st().reason), 20000);
  assert.equal((await servedChain(b)).status, 404, 'the leaf signed before the ban was never installed');
  await W.publish({ deny: [] });
  await waitFor('issued once the ban is lifted', async () => bothNames(b, b.config.nativeControl.names), 40000);
});

test('bound to another CA, another group, or lying about its config: no leaf', T(180000), async () => {
  const lead = await waitFor('a primary', () => leaderOf(M), 60000), target = M.find((m) => m !== lead);
  const idx = target.i, st = () => memberState(leaderOf(M), idx);
  await target.kill();
  const rogueCa = await bootMember(idx, { chip: target.chip, caSha256: ROGUE.sha256, native: target.config.nativeControl.names });
  M = M.map((m) => (m === target ? rogueCa : m)); roles = M.map((m) => m.role);
  await waitFor('refused: another native CA', () => st().state === 'refused' && /another native CA/.test(st().reason), 40000);
  assert.equal((await servedChain(rogueCa)).status, 404);
  await rogueCa.kill();
  M = M.filter((m) => m !== rogueCa); roles = M.map((m) => m.role);
  // a front at that control URL that is NOT a member of this group: truthful (another platformApi) or lying (serves ours)
  async function impostor({ servedConfig, boundConfig }) {
    const d = fs.mkdtempSync(path.join(tmp, 'imp-'));
    const P = { ...MC.GUEST_PATHS, runDir: d, sessionDir: path.join(d, 'session'), tlsKey: path.join(d, 'k.pem'), tlsCert: path.join(d, 'c.pem'), platformApiHandoffKey: path.join(d, 'h.key'), nativeCertificate: path.join(d, 'n.pem') };
    const cfg = MC.canonicalDirectConfig(boundConfig), digest = MC.configDigest(cfg), hostData = MC.hostDataHex(digest);
    const keys = MC.mintControlKeys({ paths: P }); keys.platformApi = { publicKey: MC.mintPlatformApiKey({ paths: P }) };
    const stt = MC.controlStatement({ config: cfg, digest, hostData, mode: 'snp', keys });
    const peer = keep(http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ config: servedConfig })); }));
    await new Promise((r) => peer.listen(0, '127.0.0.1', r));
    const front = keep(MC.createControlFront({ statementText: stt.text, keyPem: fs.readFileSync(P.tlsKey, 'utf8'), certPem: keys.controlTls.certPem, mode: 'snp',
      reporter: async (rd) => ({ report: synthReport(S, { reportData: rd, hostData: Buffer.from(hostData, 'hex') }), certs: null }), upstream: { host: '127.0.0.1', port: peer.address().port },
      prefixRoutes: [{ prefix: MC.PLATFORM_API_PREFIX, upstream: { host: '127.0.0.1', port: peer.address().port } }],
      native: { ...MC.directNativeLaunch(cfg, { paths: P }), upstream: { host: '127.0.0.1', port: peer.address().port } } }));
    await new Promise((r) => front.listen(FRONT_PORTS[idx], '127.0.0.1', r));
    return { close: async () => { if (!front.listening) return; front.closeAllConnections?.(); await new Promise((r) => front.close(() => r())); } };
  }
  const otherGroup = { ...rawFor(idx), platformApi: { ...PA, hostname: 'api.other-group.test', admins: [a(0xee)] } };
  let imp = null;
  try {
    imp = await impostor({ servedConfig: MC.canonicalDirectConfig(otherGroup), boundConfig: otherGroup });
    await waitFor('refused: another group', () => st().state === 'refused' && /does not carry this group/.test(st().reason), 40000);
    await imp.close();
    imp = await impostor({ servedConfig: MC.canonicalDirectConfig(rawFor(idx, { native: target.config.nativeControl.names })), boundConfig: otherGroup });
    await waitFor('refused: the hardware binds another config than the one it serves', () => st().state === 'refused' && /attestation rejected/.test(st().reason), 40000);
  } finally { await imp?.close(); }
  const honest = await bootMember(idx, { chip: target.chip, native: target.config.nativeControl.names });
  M = [...M, honest].sort((x, y) => x.i - y.i); roles = M.map((m) => m.role);
  await waitFor('the honest reboot is issued', async () => honest.role.status().haveKey && bothNames(honest, honest.config.nativeControl.names), 60000);
});

test('credential REPLACEMENT and REMOVAL stop the old run before its install; the new run uses only the new credentials', T(180000), async () => {
  let lead = await waitFor('a primary', () => leaderOf(M), 60000);
  const target = M.find((m) => m !== lead), idx = target.i, st = () => memberState(leaderOf(M), idx);
  await target.kill();
  const b = await bootMember(idx, { chip: target.chip, native: target.config.nativeControl.names });
  M = M.map((m) => (m === target ? b : m)); roles = M.map((m) => m.role);
  const gate = armGate(idx);
  await gate.reached;                                    // the old run signed a leaf for b and waits right before its barrier
  lead = await waitFor('a primary', () => leaderOf(M), 60000);
  const r = await peerPost(lead, CREDENTIALS_PATH, await credentialsPkg(lead, withCa(ROGUE)));   // the admin REPLACES the CA
  assert.equal(r.status, 200);
  gate.release();
  await waitFor('the old run is aborted', () => st().state === 'aborted' || /another native CA/.test(String(st().reason)), 20000);
  assert.ok(logs.some((l) => /native CA issuer stopped \(native CA credentials changed\)/.test(l)));
  await sleep(1500);
  assert.equal((await servedChain(b)).status, 404, 'the old run installed nothing after the replacement');
  await waitFor('the new run refuses members bound to the old CA', () => st().state === 'refused' && /another native CA/.test(st().reason), 30000);
  // REMOVAL: a newer package without the native CA (the other credentials kept) stops issuance entirely
  const r2 = await peerPost(lead, CREDENTIALS_PATH, await credentialsPkg(lead, { STRIPE_WEBHOOK_SECRET: STRIPE }));
  assert.equal(r2.status, 200);
  await waitFor('the issuer is inactive', () => issuerOf(leaderOf(M)).state === 'inactive', 10000);
  assert.equal((await servedChain(b)).status, 404);
  // the original CA back: b is issued
  const r3 = await peerPost(lead, CREDENTIALS_PATH, await credentialsPkg(lead, withCa(NCA)));
  assert.equal(r3.status, 200);
  await waitFor('b issued under the restored credentials', async () => bothNames(b, b.config.nativeControl.names), 40000);
});

test('a stopped run releases its connections at once (a member front that never answers)', T(120000), async () => {
  const lead = await waitFor('a primary', () => leaderOf(M), 60000), target = M.find((m) => m !== lead), idx = target.i;
  await target.kill();
  const k = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const st = { open: 0, closed: 0 };
  // a front that never answers the native certificate read (the issuer's); any other request (replica traffic) is refused at once
  const hang = keep(https.createServer({ key: k.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: MC.selfSignedCert(k.privateKey, k.publicKey) }, (req, res) => {
    if (req.method === 'GET' && req.url === MC.NATIVE_CERT_PATH) { st.open++; req.socket.on('close', () => { st.closed++; }); return; }
    res.writeHead(503, { connection: 'close' }); res.end();
  }));
  await new Promise((r) => hang.listen(FRONT_PORTS[idx], '127.0.0.1', r));
  try {
  await waitFor('the issuer holds a connection to the silent front', () => st.open > st.closed, 20000);
  const t0 = Date.now();
  const r = await peerPost(lead, CREDENTIALS_PATH, await credentialsPkg(lead, { STRIPE_WEBHOOK_SECRET: STRIPE }));
  assert.equal(r.status, 200);
  await waitFor('the held connection is closed by the stop', () => st.open === st.closed, 3000);
  assert.ok(Date.now() - t0 < 3000, 'released at once, not at the 8 s request timeout');
  await sleep(1500); const opened = st.open;
  await sleep(2500);
  assert.equal(st.open, opened, 'an inactive issuer opens no new connection');
  } finally { hang.closeAllConnections(); await new Promise((r) => hang.close(() => r())); }
  await new Promise((r) => setTimeout(r, 200));
  const back = await bootMember(idx, { chip: target.chip, native: target.config.nativeControl.names });
  M = M.map((m) => (m.i === idx ? back : m)); roles = M.map((m) => m.role);
  assert.equal((await peerPost(lead, CREDENTIALS_PATH, await credentialsPkg(lead, withCa(NCA)))).status, 200);
  await waitFor('the returning member is issued', async () => back.role.status().haveKey && bothNames(back, back.config.nativeControl.names), 60000);
});

test('LEADERSHIP LOSS between signing and install: the primary loses its majority (its replica transport fails), steps down, installs nothing; the next primary issues', T(180000), async () => {
  const lead = await waitFor('a primary', () => leaderOf(M), 60000), target = M.find((m) => m !== lead), idx = target.i;
  await target.kill();
  const b = await bootMember(idx, { chip: target.chip, native: target.config.nativeControl.names });
  M = M.map((m) => (m === target ? b : m)); roles = M.map((m) => m.role);
  const gate = armGate(idx);
  await gate.reached;
  for (const m of M) partitioned.add(m.i);               // no member reaches another: no majority anywhere, so no successor issues meanwhile
  await waitFor('the primary steps down', () => lead.role.status().role !== 'leader', 20000);
  assert.equal(issuerOf(lead).state, 'inactive', 'its issuer stopped with the leadership');
  gate.release();
  await sleep(1000);
  assert.equal((await servedChain(b)).status, 404, 'the deposed primary installed nothing');
  assert.ok(['aborted'].includes(memberState(lead, idx).state), JSON.stringify(memberState(lead, idx)));
  assert.ok(M.every((m) => m.role.status().role !== 'leader'), 'no primary while partitioned');
  partitioned.clear();
  const next = await waitFor('a primary again', () => leaderOf(M), 60000);
  await waitFor('the target issued by the current primary', async () => bothNames(b, b.config.nativeControl.names), 60000);
  assert.ok(next);
});

test('archives: only a sink holding BOTH the snapshot and the recovery envelope counts; crossed half-writes are not an archive', T(120000), async () => {
  const lead = await waitFor('a primary', () => leaderOf(M), 60000);
  archiveFault.mode = 'crossed';
  const before = lead.role.status().archive;
  logs.length = 0;
  assert.equal((await peerPost(lead, CREDENTIALS_PATH, await credentialsPkg(lead, withCa(NCA, { MARK: 'crossed' })))).status, 200);
  await waitFor('the crossed archive attempt fails', () => logs.some((l) => /archive failed: no archive sink took both the snapshot and the recovery envelope/.test(l)), 20000);
  assert.deepEqual(lead.role.status().archive?.head, before?.head, 'no archive is recorded from crossed half-writes');
  archiveFault.mode = 'half';
  assert.equal((await peerPost(lead, CREDENTIALS_PATH, await credentialsPkg(lead, withCa(NCA, { MARK: 'half' })))).status, 200);
  await waitFor('one complete pair', () => lead.role.status().archive?.sinks === 1 && lead.role.status().archive?.of === 2, 20000);
  archiveFault.mode = 'ok';
  assert.equal((await peerPost(lead, CREDENTIALS_PATH, await credentialsPkg(lead, withCa(NCA, { MARK: 'ok' })))).status, 200);
  await waitFor('both pairs', () => lead.role.status().archive?.sinks === 2, 20000);
});

test('total loss: the admin recovers the group from one sink\'s pair; the restored native CA credentials issue leaves to the fresh boots', T(200000), async () => {
  const sink = SINKS[1], blob = archive.get(`${sink}|/platform-api/${groupIdOf(PA)}/latest`), envelope = JSON.parse(archive.get(`${sink}|/platform-api/${groupIdOf(PA)}/recovery.json`).toString('utf8'));
  for (const m of M) await m.kill();
  const fresh = [];
  for (let i = 0; i < N; i++) fresh.push(await bootMember(i, { chip: M[i].chip, native: M[i].config.nativeControl.names }));
  M = fresh; roles = M.map((m) => m.role);
  for (const m of M) assert.equal((await servedChain(m)).status, 404, 'fresh boots: no leaf');
  const { package: pkg } = await recover({ platformApi: PA, targetStatementText: M[0].st.text, account: ADMIN, envelope, recoveryPrivateKey: Buffer.from(REC.privateKey), archive: blob });
  assert.equal((await peerPost(M[0], BOOTSTRAP_PATH, pkg)).status, 200);
  await waitFor('every fresh member holds the key', () => M.every((m) => m.role.status().haveKey), 60000);
  const lead = await waitFor('a primary', () => leaderOf(M), 60000);
  await waitFor('the restored credentials started the issuer', () => issuerOf(lead).state === 'active', 30000);
  await waitFor('every fresh boot issued from the recovered CA credentials', async () => (await Promise.all(M.map((m) => bothNames(m, m.config.nativeControl.names)))).every(Boolean), 90000);
  assert.ok(!logs.join('\n').includes(NCA.keyLine));
});
