// The admin's tool (scripts/platform-api-admin.mjs) through its OWN command-line code, against REAL platform API roles behind
// REAL control fronts (createControlFront, local TLS, statements from mintControlKeys / controlStatement):
//   * in process, main(argv, fixtures): the verifier is the CLI's own productionVerifier with the CLI's own cachedCollateral;
//     only the cache's UPSTREAM (a SYNTHETIC AMD-shaped chain instead of KDS), the ARK it chains to and the registry reader
//     (the real quorum reader over in-process JSON-RPC: a bound config allows only https RPCs) are fixtures;
//   * as a child process, the real entry (`node scripts/platform-api-admin.mjs …`) with nothing injected: it pins the AMD roots,
//     so a cache holding the synthetic chain verifies nothing. Nothing here proves AMD hardware.
// Proves: genesis, credentials and recovery (direct and prepare/sign/submit) reach exactly the verified boot; the verifier
// refuses no collateral, a wrong measurement and an inactive registry row before anything is written or sent; a prepared
// package for another boot is refused locally; a submission whose endpoint swapped to another key sends it no byte and
// reports no success. Every key is disposable; nothing leaves 127.0.0.1.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as viem from 'viem';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { synthChain, synthReport } from './helpers/snp-synth.mjs';
import { memoryCollateral } from '../verifier/collateral.mjs';
import { cachedCollateral } from '../verifier/collateral-cache.mjs';
import { TCB_FLOORS } from '../verifier/metal-box.mjs';
import { hostABI } from '../network/registry-abi.mjs';
import * as MC from '../metal/guest/measured-control.mjs';
import { registryIdOf } from '../metal/measured-control-verify.mjs';
import * as hpke from '../custody/hpke.mjs';
import { startRole, groupIdOf, openRecovery, HANDOFF_INFO } from '../metal/guest/platform-api-role.mjs';
import { productionVerifier, quorumRegistry } from '../metal/guest/platform-api-verify.mjs';
import * as ADMIN_CLI from '../scripts/platform-api-admin.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-admin-cli-'));
const servers = [], sockets = new Set();
const roles = new Set();
const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); return s; };
const keep = (srv) => { servers.push(srv); srv.on('connection', track); return srv; };
after(async () => {
  for (const r of roles) { try { await r.stop(); } catch {} }
  for (const s of sockets) s.destroy();
  for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch {} }
  fs.rmSync(tmp, { recursive: true, force: true });
});
const T = (ms = 120000) => ({ timeout: ms });
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (what, fn, ms = 45000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(150); } throw new Error(`timed out waiting for ${what} (last: ${last})`); };
const HOSTNAME = 'api.platform.test';
const ZA = '0x' + '00'.repeat(20), Z32 = '0x' + '00'.repeat(32);
const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const REGISTRY = '0x' + 'e0'.repeat(20);
const file = (name, data, mode = 0o600) => { const f = path.join(tmp, name); fs.writeFileSync(f, data, { mode }); return f; };

// ---- synthetic AMD as the cache's UPSTREAM only ----------------------------------------------------------------------------
const S = synthChain();
const MEM = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } });
const UPSTREAM = { kind: 'synthetic-kds', chain: (p) => MEM.chain(p), vcek: (...x) => MEM.vcek(...x), crl: (p) => MEM.crl(p) };
const NO_UPSTREAM = { kind: 'kds-down', chain: () => { throw new Error('KDS unreachable (test)'); }, vcek: () => null, crl: () => null };
const ROOTS = new Map([['Genoa', S.arkFp]]);
const MEAS = '77'.repeat(48);                             // what synthReport measures

// ---- the original registry over three loopback JSON-RPC servers -----------------------------------------------------------
const HOSTS = {};
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
let REG = null;

// ---- the group (three members) and one guest of ANOTHER group pinning another measurement ---------------------------------
const ADMIN_KEY = generatePrivateKey(), ADMIN = privateKeyToAccount(ADMIN_KEY);
const REC = hpke.generateKeyPair();
const N = 3, OPS = [...Array(N + 1)].map(() => privateKeyToAccount(generatePrivateKey()).address.toLowerCase());
const FRONT_PORTS = [], ROLE_PORTS = [], SINKS = [];
let PA = null, PA_OTHER = null;
const archive = new Map();                              // `${sink}|${path}` -> bytes
const paMember = ({ measurements = [MEAS] } = {}) => ({ apiPort: 8098, peerPort: 8099, hostname: HOSTNAME,
  members: OPS.slice(0, N).map((op, i) => ({ operator: op, publicUrl: `https://host-${i}.example.org`, controlUrl: `https://127.0.0.1:${FRONT_PORTS[i]}` })),
  measurements, minTcb: TCB_FLOORS, admins: [ADMIN.address], recovery: [Buffer.from(REC.publicKey).toString('hex')],
  archives: SINKS, archiveMs: 5000,
  relayEnv: { ENCLAVES: 'http://127.0.0.1:1', OFAC_SDN_URLS: 'http://127.0.0.1:1/x', RPC_FALLBACKS: '0', SIWE_DOMAIN: 'enclave.host', SIWE_URI: 'https://enclave.host', BASE_RPC: 'http://127.0.0.1:1/rpc' },
  leaseMs: 2000 });
const rawFor = (i, pa) => ({ format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: REGISTRY, deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ['https://rpc-a.example/v1', 'https://rpc-b.example'], quorum: 2, releaseId: 'ab'.repeat(32),
  replicas: { gateways: ['http://192.0.2.10:8189'], storagePlan: null },
  identity: { publicUrl: `https://host-${i}.example.org`, repo: 'owner/enclave', operator: OPS[i] },
  selling: { cpuPrice6: null, payout: null }, isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096' },
  hostAdmissionSha256: null, controlPort: 8444, platformApi: pa });

const logs = [];
/** a guest: its REAL control front (synthetic SNP reports), its supervisor, its statement, its role file, its target-config file */
async function bootGuest(i, pa) {
  const d = fs.mkdtempSync(path.join(tmp, `g${i}-`));
  const P = { ...MC.GUEST_PATHS, runDir: d, sessionDir: path.join(d, 'session'), statement: path.join(d, 'statement.json'), tlsKey: path.join(d, 'tls-key.pem'), tlsCert: path.join(d, 'tls-cert.pem'),
              platformApiConfig: path.join(d, 'platform-api.json'), platformApiHandoffKey: path.join(d, 'handoff.key'), platformApiDir: path.join(d, 'pa'), nativeCertificate: path.join(d, 'native.pem') };
  const config = MC.canonicalDirectConfig(rawFor(i, pa)), digest = MC.configDigest(config), hostData = MC.hostDataHex(digest);
  const keys = MC.mintControlKeys({ paths: P }); keys.platformApi = { publicKey: MC.mintPlatformApiKey({ paths: P }) };
  const st = MC.controlStatement({ config, digest, hostData, mode: 'snp', keys, runtime: { platformApiSha256: '00'.repeat(32) } });
  fs.writeFileSync(P.statement, st.text);
  const proofKey = MC.addressOfPublicKey(keys.proof.publicKey, viem.keccak256), registryId = registryIdOf(config.identity.publicUrl).toLowerCase();
  HOSTS[registryId] = { operator: OPS[i], active: true, endpoint: config.identity.publicUrl, proofKey };
  const sup = keep(http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ proofKey: { address: proofKey }, sessionKey: { kid: MC.jwkThumbprint(keys.session.jwk) } })); }));
  await new Promise((r) => sup.listen(0, '127.0.0.1', r));
  const port = FRONT_PORTS[i] ?? await freePort(), rp = ROLE_PORTS[i] ?? { api: await freePort(), peer: await freePort() };
  const launch = MC.directPlatformApiLaunch(config, { paths: P }), roleFile = JSON.parse(launch.files[P.platformApiConfig]);
  const roleCfg = { ...roleFile, listen: { ...rp, control: port }, askMs: 300 };
  const front = keep(MC.createControlFront({ statementText: st.text, keyPem: fs.readFileSync(P.tlsKey, 'utf8'), certPem: keys.controlTls.certPem, mode: 'snp',
    reporter: async (rd) => ({ report: synthReport(S, { reportData: rd, hostData: Buffer.from(hostData, 'hex') }), certs: null }),
    upstream: { host: '127.0.0.1', port: sup.address().port },
    hostRoutes: [{ host: HOSTNAME, upstream: { host: '127.0.0.1', port: rp.api } }],
    prefixRoutes: [{ prefix: MC.PLATFORM_API_PREFIX, upstream: { host: '127.0.0.1', port: rp.peer } }] }));
  await new Promise((r) => front.listen(port, '127.0.0.1', r));
  return { i, P, config, st, roleCfg, registryId, port, url: `https://127.0.0.1:${port}`, spki: keys.controlTls.spkiSha256,
    configFile: file(`target-config-${i}-${path.basename(d)}.json`, JSON.stringify(config)),
    handoffPriv: Buffer.from(fs.readFileSync(P.platformApiHandoffKey, 'utf8').trim(), 'hex') };
}
/** a member role (NOT under test: its handoff verifier is the production verifier given the same collateral fixtures) */
async function startRoleFor(g) {
  const collateral = cachedCollateral({ dir: path.join(g.roleCfg.dirs.root, 'collateral'), upstream: UPSTREAM, roots: ROOTS });
  const role = await startRole({ cfg: g.roleCfg, recoverMessageAddress: viem.recoverMessageAddress, log: (m) => logs.push(`[g${g.i}] ${m}`),
    verifyPeer: productionVerifier(g.roleCfg, { registry: REG, collateral, roots: ROOTS }),
    archivePut: async (url, blob) => { const u = new URL(url); archive.set(`${u.origin}|${u.pathname}`, Buffer.from(blob)); } });
  roles.add(role); return role;
}
async function stopRole(role) { await role.stop(); roles.delete(role); }
const ROLE = [];
const leader = () => ROLE.findIndex((r) => r && r.status().role === 'leader');

/** the CLI in process: its own wiring; fixtures only for the collateral upstream, its ARK, and the registry reader */
async function admin(args, { upstream = UPSTREAM, ...more } = {}) {
  const out = [], err = [];
  let code = null, error = null;
  try { code = await ADMIN_CLI.main(['node', 'platform-api-admin.mjs', ...args], { upstream, roots: ROOTS, registry: REG, io: { out: (s) => out.push(s), err: (s) => err.push(s) }, ...more }); }
  catch (e) { error = e; }
  return { code, error, out: out.join(''), err: err.join('\n') };
}
const cdir = () => fs.mkdtempSync(path.join(tmp, 'collateral-'));
/** the real CLI entry as the admin runs it (nothing injected) -> { code, stdout, stderr } */
const cliChild = (args, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(REPO, 'scripts/platform-api-admin.mjs'), ...args], { cwd: tmp, timeout: 60000, env: { ...process.env, ...env } },
    (e, stdout, stderr) => resolve({ code: e ? (e.code ?? 1) : 0, stdout, stderr }));
});
const success = (r) => { try { const j = JSON.parse(r.out.trim().split('\n').pop()); return j.status === 200 && j.ok === true; } catch { return false; } };

let G = [], X = null, ENVELOPE = null;
const ADMIN_KEY_FILE = () => file('admin.key', ADMIN_KEY);
test('setup: three member guests of one group, and one guest of a group pinning another measurement', T(150000), async () => {
  const rpcs = [];
  for (let i = 0; i < 3; i++) {
    rpcs.push(`http://127.0.0.1:${await new Promise((r) => { const s = keep(http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
      const one = (q) => { try { return { jsonrpc: '2.0', id: q.id, result: rpcAnswer(q) }; } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; } };
      const b = JSON.parse(Buffer.concat(c)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(b) ? b.map(one) : one(b))); }); }));
      s.listen(0, '127.0.0.1', () => r(s.address().port)); })}`);
  }
  REG = quorumRegistry({ rpcs, quorum: 3, registry: REGISTRY });
  for (let i = 0; i < N; i++) { FRONT_PORTS.push(await freePort()); ROLE_PORTS.push({ api: await freePort(), peer: await freePort() }); }
  SINKS.push(`http://127.0.0.1:${await freePort()}`, `http://127.0.0.1:${await freePort()}`);
  PA = MC.canonicalDirectConfig(rawFor(0, paMember())).platformApi;
  PA_OTHER = MC.canonicalDirectConfig(rawFor(0, paMember({ measurements: ['88'.repeat(48)] }))).platformApi;
  for (let i = 0; i < N; i++) G.push(await bootGuest(i, PA));
  X = await bootGuest(N, PA_OTHER);                       // its config pins 88…, its report measures 77…
  ROLE[0] = await startRoleFor(G[0]);
  assert.equal(ROLE[0].status().haveKey, false);
});

test('baseline shape: the REAL CLI entry (nothing injected) pins the AMD roots: a cache seeded with the synthetic chain verifies nothing, and nothing is sent', T(), async () => {
  const dir = cdir(), seed = cachedCollateral({ dir, upstream: UPSTREAM, roots: ROOTS });
  await seed.chain('Genoa'); await seed.crl('Genoa');
  assert.ok(fs.existsSync(path.join(dir, 'Genoa', 'chain.pem')), 'the cache holds the synthetic chain');
  const env = path.join(tmp, 'child-envelope.json');
  const r = await cliChild(['genesis', '--target', G[0].url, '--target-config', G[0].configFile, '--admin-key', ADMIN_KEY_FILE(), '--collateral-dir', dir, '--envelope-out', env]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /the target did not verify: unknown: .*AMD collateral could not be obtained/);
  assert.equal(r.stdout, '', 'no success (no output at all)');
  assert.ok(!fs.existsSync(env), 'no recovery envelope was written');
  assert.equal(ROLE[0].status().haveKey, false, 'nothing reached the target');
});

test('no collateral (KDS down, empty cache): refused before anything is written or sent', T(), async () => {
  const env = path.join(tmp, 'nocol-envelope.json');
  const r = await admin(['genesis', '--target', G[0].url, '--target-config', G[0].configFile, '--admin-key', ADMIN_KEY_FILE(), '--collateral-dir', cdir(), '--envelope-out', env], { upstream: NO_UPSTREAM });
  assert.ok(r.error, 'refused'); assert.match(r.error.message, /did not verify: unknown: .*AMD collateral could not be obtained/);
  assert.equal(r.out, ''); assert.ok(!fs.existsSync(env)); assert.equal(ROLE[0].status().haveKey, false);
});

test('a wrong measurement and an inactive registry row are refused before anything is written or sent', T(), async () => {
  const env = path.join(tmp, 'bad-envelope.json');
  const m = await admin(['genesis', '--target', X.url, '--target-config', X.configFile, '--admin-key', ADMIN_KEY_FILE(), '--collateral-dir', cdir(), '--envelope-out', env]);
  assert.ok(m.error, 'refused'); assert.match(m.error.message, /did not verify: rejected: .*measurement/i);
  HOSTS[G[0].registryId].active = false;
  let r; try { r = await admin(['genesis', '--target', G[0].url, '--target-config', G[0].configFile, '--admin-key', ADMIN_KEY_FILE(), '--collateral-dir', cdir(), '--envelope-out', env]); }
  finally { HOSTS[G[0].registryId].active = true; }
  assert.ok(r.error, 'refused'); assert.match(r.error.message, /did not verify: .*registry/i);
  for (const x of [m, r]) assert.equal(x.out, '');
  assert.ok(!fs.existsSync(env)); assert.equal(ROLE[0].status().haveKey, false);
});

test('genesis, prepare / sign / submit: nothing is sent before the signature; the package goes only to the boot it was prepared for', T(), async () => {
  const dir = cdir(), pkgFile = path.join(tmp, 'genesis-package.json'), env = path.join(tmp, 'envelope.json');
  const prep = await admin(['genesis', '--target', G[0].url, '--target-config', G[0].configFile, '--print-message', '--package-out', pkgFile, '--envelope-out', env, '--collateral-dir', dir]);
  assert.equal(prep.error, null, prep.error?.message); assert.equal(prep.code, 0);
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  assert.equal(prep.out, (await import('../metal/guest/platform-api-role.mjs')).packageMessage(pkg), 'stdout is exactly the message to sign');
  assert.ok(!success(prep) && !('signature' in pkg), 'prepared, unsigned: no success, no signature');
  assert.equal(ROLE[0].status().haveKey, false, 'nothing was sent by the prepare step');
  assert.ok(fs.existsSync(path.join(dir, 'Genoa', 'chain.pem')), 'the CLI cached the AMD chain');
  const signature = await ADMIN.signMessage({ message: prep.out });     // the admin's wallet, outside the tool
  // the same package to ANOTHER verified member boot: refused locally, nothing sent
  ROLE[1] = await startRoleFor(G[1]);
  const wrong = await admin(['genesis', '--target', G[1].url, '--target-config', G[1].configFile, '--package', pkgFile, '--signature', signature, '--collateral-dir', dir]);
  assert.ok(wrong.error); assert.match(wrong.error.message, /not a genesis package for this group and the boot just verified.*nothing sent/);
  assert.equal(wrong.out, '');
  // as the wrong command: refused locally too
  const asCreds = await admin(['credentials', '--target', G[0].url, '--target-config', G[0].configFile, '--package', pkgFile, '--signature', signature, '--collateral-dir', dir]);
  assert.ok(asCreds.error); assert.match(asCreds.error.message, /not a credentials package/);
  const sub = await admin(['genesis', '--target', G[0].url, '--target-config', G[0].configFile, '--package', pkgFile, '--signature', signature, '--collateral-dir', dir]);
  assert.equal(sub.error, null, sub.error?.message); assert.equal(sub.code, 0, sub.out); assert.ok(success(sub));
  assert.equal(JSON.parse(sub.out).groupId, groupIdOf(PA));
  await waitFor('the target holds K', () => ROLE[0].status().haveKey);
  // the envelope written at prepare escrows exactly the K sealed to that boot
  ENVELOPE = JSON.parse(fs.readFileSync(env, 'utf8'));
  const k = openRecovery(ENVELOPE, { groupId: groupIdOf(PA), privateKey: Buffer.from(REC.privateKey) });
  const sealed = Buffer.from(hpke.open(G[0].handoffPriv, HANDOFF_INFO, Buffer.from(MC.sha256Hex(G[0].st.text)), Buffer.from(pkg.sealedKey, 'base64')));
  assert.ok(k.equals(sealed), 'the escrowed key is the key sealed to the verified boot');
  await waitFor('member 1 holds K (handed over)', () => ROLE[1].status().haveKey);
  ROLE[2] = await startRoleFor(G[2]);
  await waitFor('every member holds K', () => ROLE.every((r) => r.status().haveKey));
  await waitFor('a primary', () => leader() >= 0, 60000);
});

test('credentials: to the verified primary (signed with --admin-key) succeeds; a non-primary answers 409 and the tool reports failure', T(), async () => {
  const L = await waitFor('a primary', () => (leader() >= 0 ? G[leader()] : null), 60000), other = G.find((g) => g !== L);
  const creds = file('creds.json', JSON.stringify({ STRIPE_WEBHOOK_SECRET: 'whsec_test_' + Date.now() }));
  const no = await admin(['credentials', '--target', other.url, '--target-config', other.configFile, '--credentials', creds, '--admin-key', ADMIN_KEY_FILE(), '--collateral-dir', cdir()]);
  assert.equal(no.error, null, no.error?.message); assert.equal(no.code, 1); assert.ok(!success(no)); assert.equal(JSON.parse(no.out).status, 409);
  const r = await admin(['credentials', '--target', L.url, '--target-config', L.configFile, '--credentials', creds, '--admin-key', ADMIN_KEY_FILE(), '--collateral-dir', cdir()]);
  assert.equal(r.error, null, r.error?.message); assert.equal(r.code, 0, r.out); assert.ok(success(r));
  assert.deepEqual(JSON.parse(r.out).names, ['STRIPE_WEBHOOK_SECRET']);
  assert.ok(!r.out.includes('whsec_test_') && !r.err.includes('whsec_test_'), 'the credential value is never printed');
  await waitFor('an archive pair', () => archive.has(`${SINKS[0]}|/platform-api/${groupIdOf(PA)}/latest`), 20000);
});

test('an endpoint that swapped to ANOTHER key after the verification gets no byte; the tool reports no success', T(), async () => {
  const L = await waitFor('a primary', () => (leader() >= 0 ? G[leader()] : null), 60000);
  // an impostor TLS server with its own key, counting every byte it decrypts
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'imp.key', '-out', 'imp.pem', '-days', '1', '-subj', '/CN=impostor'], { cwd: tmp, stdio: 'ignore' });
  const seen = { tls: 0, bytes: 0 };
  const imp = keep(tls.createServer({ key: fs.readFileSync(path.join(tmp, 'imp.key')), cert: fs.readFileSync(path.join(tmp, 'imp.pem')) }, (s) => { seen.tls++; s.on('data', (d) => { seen.bytes += d.length; }); s.on('error', () => {}); }));
  await new Promise((r) => imp.listen(0, '127.0.0.1', r));
  // the target address the admin uses: a TCP switch in front of the primary's front, flipped right after the verification
  const sw = { to: L.port };
  const proxy = keep(net.createServer((c) => { const up = track(net.connect(sw.to, '127.0.0.1')); c.pipe(up); up.pipe(c); c.on('error', () => up.destroy()); up.on('error', () => c.destroy()); }));
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const creds = file('creds2.json', JSON.stringify({ STRIPE_WEBHOOK_SECRET: 'whsec_swap' }));
  const r = await admin(['credentials', '--target', `https://127.0.0.1:${proxy.address().port}`, '--target-config', L.configFile, '--credentials', creds, '--admin-key', ADMIN_KEY_FILE(), '--collateral-dir', cdir()],
    { afterVerify: async () => { sw.to = imp.address().port; } });
  assert.ok(r.error, 'refused'); assert.match(r.error.message, /not the attested key/);
  assert.equal(r.out, '', 'no success, no answer printed');
  assert.ok(seen.tls >= 1, 'the impostor completed a handshake');
  assert.equal(seen.bytes, 0, 'not one byte (no request line, no package) reached the impostor');
});

test('total loss: recover through the CLI seals K and the latest archive to a fresh verified boot', T(150000), async () => {
  const blob = archive.get(`${SINKS[0]}|/platform-api/${groupIdOf(PA)}/latest`);
  assert.ok(blob, 'an archive');
  for (const r of ROLE) await stopRole(r);
  for (const g of G) for (const d of [g.roleCfg.dirs.root, g.roleCfg.dirs.data]) fs.rmSync(d, { recursive: true, force: true });
  ROLE[0] = await startRoleFor(G[0]);
  assert.equal(ROLE[0].status().haveKey, false, 'a fresh boot: no K');
  const arch = file('archive.bin', blob), env = file('recovery-envelope.json', JSON.stringify(ENVELOPE)), rk = file('recovery.key', Buffer.from(REC.privateKey).toString('hex'));
  const r = await admin(['recover', '--target', G[0].url, '--target-config', G[0].configFile, '--recovery-key', rk, '--envelope', env, '--archive', arch, '--admin-key', ADMIN_KEY_FILE(), '--collateral-dir', cdir()]);
  assert.equal(r.error, null, r.error?.message); assert.equal(r.code, 0, r.out); assert.ok(success(r));
  await waitFor('the recovered member holds K', () => ROLE[0].status().haveKey);
  assert.ok(logs.some((l) => l.startsWith('[g0] ') && /recover package from admin .* accepted/i.test(l)), 'the role accepted the admin\'s recover package');
});
