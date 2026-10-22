// The state-key handoff of the platform API role (metal/guest/platform-api-role.mjs) through main()'s OWN production
// wiring (productionWiring: the role's verifier and native issuer dependencies), not an injected verifier:
//   * the AMD collateral is the role's cachedCollateral on its root dir; only its UPSTREAM is a fixture (a SYNTHETIC AMD-shaped
//     chain whose ARK this test pins, two chips) instead of AMD KDS. Nothing here proves AMD hardware;
//   * the original registry is the real quorum reader over three in-process JSON-RPC servers (the bound config only allows
//     https RPCs, so the reader is handed in);
//   * the platform host policy is the real issuerDeps runtime over test/helpers/platform-policy-world.mjs (admin-signed,
//     anchored policies), resolved from the role file's relay environment exactly as main() resolves it;
//   * members are REAL control fronts (createControlFront) with statements from mintControlKeys / controlStatement; the holder
//     and the admitted newcomer are REAL roles; handoff requests go through the holder's front like a newcomer's own.
// Proves: the pre-fix main wiring verifies no newcomer (no AMD chain); an admitted newcomer obtains K; a host ban, an operator
// ban, a chip ban, an unreadable or explicitly-off policy, an inactive row (original registry or policy), a policy row of
// another operator and a non-member get no sealed key; a banned member that reboots stays without K until the admin lifts it.
// HANDOFF_WIRING=legacy runs the same cases against the pre-fix verifier given collateral (the base's handoff semantics).
// Every key is disposable; nothing leaves 127.0.0.1.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import * as viem from 'viem';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { synthChain, synthReport } from './helpers/snp-synth.mjs';
import { platformPolicyWorld, REGISTRY } from './helpers/platform-policy-world.mjs';
import { memoryCollateral } from '../verifier/collateral.mjs';
import { cachedCollateral } from '../verifier/collateral-cache.mjs';
import { TCB_FLOORS } from '../verifier/metal-box.mjs';
import { hostABI } from '../network/registry-abi.mjs';
import * as MC from '../metal/guest/measured-control.mjs';
import { registryIdOf } from '../metal/measured-control-verify.mjs';
import * as hpke from '../custody/hpke.mjs';
import * as ROLE from '../metal/guest/platform-api-role.mjs';
import { productionVerifier, quorumRegistry } from '../metal/guest/platform-api-verify.mjs';
import { genesis } from '../scripts/platform-api-admin.mjs';

const LEGACY = process.env.HANDOFF_WIRING === 'legacy';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-handoff-prod-'));
const servers = [], sockets = new Set(), deferred = [];
const roles = new Set();
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
const waitFor = async (what, fn, ms = 45000) => { const until = Date.now() + ms; let last; while (Date.now() < until) { try { last = await fn(); if (last) return last; } catch (e) { last = e.message; } await sleep(150); } throw new Error(`timed out waiting for ${what} (last: ${last})`); };
const HOSTNAME = 'api.platform.test';
const ZA = '0x' + '00'.repeat(20), Z32 = '0x' + '00'.repeat(32);
const a = (n) => '0x' + n.toString(16).padStart(40, '0');

// ---- synthetic AMD (two chips) as the cache's UPSTREAM only ---------------------------------------------------------------
const S = synthChain({ extraVceks: 1 });
const CHIPS = { a: S, b: { ...S, chip: S.otherVceks[0].chip, vcekKey: S.otherVceks[0].key, vcekDer: S.otherVceks[0].der } };
const VCEK_BY_CHIP = Object.fromEntries(Object.values(CHIPS).map((c) => [c.chip.toString('hex'), c.vcekDer]));
const upstreamCalls = { chain: 0, vcek: 0, crl: 0 };
const MEM = memoryCollateral({ chains: { Genoa: S.chainPem }, crls: { Genoa: S.crlDer } });
const UPSTREAM = { kind: 'synthetic-kds',
  chain: (p) => { upstreamCalls.chain++; return MEM.chain(p); },
  crl: (p) => { upstreamCalls.crl++; return MEM.crl(p); },
  vcek: (product, chipHex) => { upstreamCalls.vcek++; return VCEK_BY_CHIP[chipHex] ? { der: VCEK_BY_CHIP[chipHex], source: 'synthetic' } : null; } };
const ROOTS = new Map([['Genoa', S.arkFp]]);
const H = (chip) => '0x' + createHash('sha256').update(chip).digest('hex');
const MEAS = '77'.repeat(48);

// ---- the original registry (HOSTS) and the policy world's registry rows (POLICY_HOSTS), separately switchable -------------
const HOSTS = {}, POLICY_HOSTS = {};
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

// ---- the group: four members (two roles up never make a majority: no primary, no relay child) -------------------------------
const ADMIN = privateKeyToAccount(generatePrivateKey());
const REC = hpke.generateKeyPair();
const N = 4, OPS = [...Array(N)].map(() => privateKeyToAccount(generatePrivateKey()).address.toLowerCase());
const OTHER_OP = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
const FRONT_PORTS = [], ROLE_PORTS = [], SINKS = [];
let PA = null, K = null;
const platformApiMember = () => ({ apiPort: 8098, peerPort: 8099, hostname: HOSTNAME,
  members: OPS.map((op, i) => ({ operator: op, publicUrl: `https://host-${i}.example.org`, controlUrl: `https://127.0.0.1:${FRONT_PORTS[i]}` })),
  measurements: [MEAS], minTcb: TCB_FLOORS, admins: [ADMIN.address], recovery: [Buffer.from(REC.publicKey).toString('hex')],
  archives: SINKS, archiveMs: 5000,
  relayEnv: { ENCLAVES: 'http://127.0.0.1:1', OFAC_SDN_URLS: 'http://127.0.0.1:1/x', RPC_FALLBACKS: '0', SIWE_DOMAIN: 'enclave.host', SIWE_URI: 'https://enclave.host', BASE_RPC: 'http://127.0.0.1:1/rpc' },
  leaseMs: 2000 });
const rawFor = (i, { pa = PA } = {}) => ({ format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: REGISTRY, deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ['https://rpc-a.example/v1', 'https://rpc-b.example'], quorum: 2, releaseId: 'ab'.repeat(32),
  replicas: { gateways: ['http://192.0.2.10:8189'], storagePlan: null },
  identity: { publicUrl: `https://host-${i}.example.org`, repo: 'owner/enclave', operator: OPS[i] },
  selling: { cpuPrice6: null, payout: null }, isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096' },
  hostAdmissionSha256: null, controlPort: 8444, platformApi: pa });

const logs = [];
/** main()'s wiring for a role file (fixtures: the collateral upstream, the pinned synthetic ARK, the registry reader, the mirror fetch) */
async function wire(roleCfg) {
  if (!LEGACY) return ROLE.productionWiring(roleCfg, { upstream: UPSTREAM, roots: ROOTS, registry: REG, fetch: caFetch, log: (m) => logs.push(`[wiring] ${m}`) });
  // the base's handoff: productionVerifier given the same cached collateral, nothing else
  return { verifyPeer: productionVerifier(roleCfg, { collateral: cachedCollateral({ dir: path.join(roleCfg.dirs.root, 'collateral'), upstream: UPSTREAM, roots: ROOTS }), registry: REG, roots: ROOTS }) };
}

/** a member's guest: its REAL control front (synthetic SNP reports for `chip`), its supervisor, its statement and role file */
async function bootGuest(i, { chip }) {
  const d = fs.mkdtempSync(path.join(tmp, `m${i}-`));
  const P = { ...MC.GUEST_PATHS, runDir: d, sessionDir: path.join(d, 'session'), statement: path.join(d, 'statement.json'), tlsKey: path.join(d, 'tls-key.pem'), tlsCert: path.join(d, 'tls-cert.pem'),
              platformApiConfig: path.join(d, 'platform-api.json'), platformApiHandoffKey: path.join(d, 'handoff.key'), platformApiDir: path.join(d, 'pa'), nativeCertificate: path.join(d, 'native.pem') };
  const config = MC.canonicalDirectConfig(rawFor(i)), digest = MC.configDigest(config), hostData = MC.hostDataHex(digest);
  const keys = MC.mintControlKeys({ paths: P }); keys.platformApi = { publicKey: MC.mintPlatformApiKey({ paths: P }) };
  const st = MC.controlStatement({ config, digest, hostData, mode: 'snp', keys, runtime: { platformApiSha256: '00'.repeat(32) } });
  fs.writeFileSync(P.statement, st.text);
  const proofKey = MC.addressOfPublicKey(keys.proof.publicKey, viem.keccak256), registryId = registryIdOf(config.identity.publicUrl).toLowerCase();
  HOSTS[registryId] = { operator: OPS[i], active: true, endpoint: config.identity.publicUrl, owner: ZA, proofKey };
  POLICY_HOSTS[registryId] = { ...HOSTS[registryId] };
  const sup = keep(http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ proofKey: { address: proofKey }, sessionKey: { kid: MC.jwkThumbprint(keys.session.jwk) } })); }));
  await new Promise((r) => sup.listen(0, '127.0.0.1', r));
  const launch = MC.directPlatformApiLaunch(config, { paths: P }), file = JSON.parse(launch.files[P.platformApiConfig]);
  // the role file PID 1 writes, with the admin's policy world configured in the relay's non-credential environment
  const roleCfg = { ...file, listen: { ...ROLE_PORTS[i], control: FRONT_PORTS[i] }, askMs: 300, relayEnvBase: { ...file.relayEnvBase, ...W.env() } };
  const front = keep(MC.createControlFront({ statementText: st.text, keyPem: fs.readFileSync(P.tlsKey, 'utf8'), certPem: keys.controlTls.certPem, mode: 'snp',
    reporter: async (rd) => ({ report: synthReport(CHIPS[chip], { reportData: rd, hostData: Buffer.from(hostData, 'hex') }), certs: null }),
    upstream: { host: '127.0.0.1', port: sup.address().port },
    hostRoutes: [{ host: HOSTNAME, upstream: { host: '127.0.0.1', port: ROLE_PORTS[i].api } }],
    prefixRoutes: [{ prefix: MC.PLATFORM_API_PREFIX, upstream: { host: '127.0.0.1', port: ROLE_PORTS[i].peer } }] }));
  await new Promise((r) => front.listen(FRONT_PORTS[i], '127.0.0.1', r));
  return { i, P, chip, config, st, roleCfg, registryId, url: `https://127.0.0.1:${FRONT_PORTS[i]}`, chipId: H(CHIPS[chip].chip),
    handoffPriv: Buffer.from(fs.readFileSync(P.platformApiHandoffKey, 'utf8').trim(), 'hex') };
}
async function startRoleFor(g) {
  const role = await ROLE.startRole({ cfg: g.roleCfg, recoverMessageAddress: viem.recoverMessageAddress, log: (m) => logs.push(`[m${g.i}] ${m}`), archivePut: async () => {}, ...(await wire(g.roleCfg)) });
  roles.add(role); return role;
}
async function stopRole(role) { await role.stop(); roles.delete(role); }
const frontPost = (port, p, body) => new Promise((ok, no) => {
  const data = Buffer.from(JSON.stringify(body));
  const r = https.request({ host: '127.0.0.1', port, method: 'POST', path: p, rejectUnauthorized: false, agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
    const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => { const t = Buffer.concat(c).toString('utf8'); let j = null; try { j = JSON.parse(t); } catch {} ok({ status: res.statusCode, body: j, text: t }); });
  });
  r.on('error', no); r.end(data);
});
/** what a newcomer gets when it asks the holder (member 0) through the holder's control front */
const ask = (g, config = g.config) => frontPost(FRONT_PORTS[0], ROLE.HANDOFF_PATH, { config });
const opened = (g, r) => Buffer.from(hpke.open(g.handoffPriv, ROLE.HANDOFF_INFO, Buffer.from(MC.sha256Hex(g.st.text)), Buffer.from(r.body.sealed, 'base64')));
const handedTo = (i) => logs.filter((l) => l.startsWith('[m0] ') && l.includes(`state key handed to member ${i} `)).length;
function refused(r, g, why) {
  assert.equal(r.status, 403, `refused (HTTP ${r.status}: ${r.text.slice(0, 300)})`);
  assert.ok(!r.body || !('sealed' in r.body), 'no sealed key in the answer');
  for (const enc of ['hex', 'base64']) assert.ok(!r.text.includes(K.toString(enc)), `the group key (${enc}) is not in the answer`);
  if (why) assert.match(String(r.body?.message || r.body?.error), why);
}
async function admitted(g) {
  const r = await ask(g);
  assert.equal(r.status, 200, `admitted (HTTP ${r.status}: ${r.text.slice(0, 300)})`);
  assert.ok(opened(g, r).equals(K), 'the sealed answer opens, with the newcomer\'s attested handoff key, to the group key');
}

let G = [], HOLDER = null, NEWCOMER = null;
test('setup: the holder (a REAL role through the production wiring) receives K from the admin\'s genesis', T(150000), async () => {
  for (let i = 0; i < 3; i++) {
    RPCS.push(`http://127.0.0.1:${await new Promise((r) => { const s = keep(http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
      const one = (q) => { try { return { jsonrpc: '2.0', id: q.id, result: rpcAnswer(q) }; } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; } };
      const b = JSON.parse(Buffer.concat(c)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(b) ? b.map(one) : one(b))); }); }));
      s.listen(0, '127.0.0.1', () => r(s.address().port)); })}`);
  }
  REG = quorumRegistry({ rpcs: RPCS, quorum: 3, registry: REGISTRY });
  W = await platformPolicyWorld({ after: (fn) => deferred.push(fn) }, { hosts: POLICY_HOSTS });
  caFetch = (url, init = {}) => new Promise((resolve, reject) => {
    const q = https.request(url, { method: init.method || 'GET', ca: fs.readFileSync(W.ca), headers: init.headers, agent: false }, (res) => { const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => resolve(new Response(Buffer.concat(c), { status: res.statusCode }))); }); q.on('error', reject); q.end(); });
  await W.publish({ deny: [] });                         // anchored: the admin's policy decides (no "not activated" admit)
  for (let i = 0; i < N; i++) { FRONT_PORTS.push(await freePort()); ROLE_PORTS.push({ api: await freePort(), peer: await freePort() }); }
  SINKS.push(`http://127.0.0.1:${await freePort()}`, `http://127.0.0.1:${await freePort()}`);
  PA = MC.canonicalDirectConfig(rawFor(0, { pa: platformApiMember() })).platformApi;
  G = [await bootGuest(0, { chip: 'a' }), await bootGuest(1, { chip: 'b' }), await bootGuest(2, { chip: 'a' }), await bootGuest(3, { chip: 'b' })];
  HOLDER = await startRoleFor(G[0]);
  const g = await genesis({ platformApi: PA, targetStatementText: G[0].st.text, account: ADMIN });
  K = g.key;
  assert.equal((await frontPost(FRONT_PORTS[0], ROLE.BOOTSTRAP_PATH, g.package)).status, 200);
  await waitFor('the holder holds K', () => HOLDER.status().haveKey);
});

test('regression: the PRE-FIX main wiring (productionVerifier(cfg), no AMD collateral) verifies no newcomer; the production wiring does, over its cache', T(), async () => {
  const pre = await productionVerifier(G[0].roleCfg)({ url: G[1].url, config: G[1].config, measurements: PA.measurements, minTcb: PA.minTcb });
  assert.equal(pre.ok, false);
  assert.match(pre.reason, /AMD collateral could not be obtained/, pre.reason);
  if (LEGACY) return;
  const { verifyPeer } = await wire(G[0].roleCfg);
  const v = await verifyPeer({ url: G[1].url, config: G[1].config, measurements: PA.measurements, minTcb: PA.minTcb });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.identity.registryId, G[1].registryId);
  assert.equal(v.identity.chipId, G[1].chipId, 'the verifier proved chip b');
  assert.ok(fs.existsSync(path.join(G[0].roleCfg.dirs.root, 'collateral', 'Genoa', 'chain.pem')), 'the AMD chain is cached on the role\'s root dir');
  const calls = { ...upstreamCalls };
  assert.equal((await verifyPeer({ url: G[1].url, config: G[1].config, measurements: PA.measurements, minTcb: PA.minTcb })).ok, true);
  assert.equal(upstreamCalls.chain, calls.chain, 'a second verification is served by the cache (no upstream chain fetch)');
});

test('an admitted newcomer (a REAL role, chip b) obtains K through the production handoff', T(), async () => {
  NEWCOMER = await startRoleFor(G[1]);
  await waitFor('the newcomer holds K', () => NEWCOMER.status().haveKey, 30000);
  assert.ok(handedTo(1) >= 1, 'the holder logged the handoff');
  await admitted(G[1]);
});

test('a host ban (registryId) and an operator ban refuse the newcomer; another admitted member is unaffected', T(), async () => {
  await W.publish({ deny: [{ kind: 'registryId', value: G[2].registryId, reason: 'host ban' }] });
  const before = handedTo(2);
  refused(await ask(G[2]), G[2], /banned by platform policy/);
  await admitted(G[1]);
  await W.publish({ deny: [{ kind: 'operator', value: OPS[2], reason: 'operator ban' }] });
  refused(await ask(G[2]), G[2], /banned by platform policy/);
  assert.equal(handedTo(2), before, 'nothing was handed to the banned member');
  await W.publish({ deny: [] });
  await admitted(G[2]);
});

test('a chip ban refuses the member on that chip only (the chip the verifier proved)', T(), async () => {
  await W.publish({ deny: [{ kind: 'chipId', value: G[2].chipId, reason: 'chip ban' }] });   // chip a (members 0 and 2)
  refused(await ask(G[2]), G[2], /banned by platform policy/);
  await admitted(G[3]);                                                                       // chip b
  await W.publish({ deny: [{ kind: 'chipId', value: H(randomBytes(64)), reason: 'another chip' }] });
  await admitted(G[2]);
  await W.publish({ deny: [] });
});

test('an unreadable policy (RPC outage, a new anchor whose document no mirror serves) and an explicitly-off policy refuse', T(), async () => {
  W.setDown(true);
  try { refused(await ask(G[1]), G[1], /platform host policy/); } finally { W.setDown(false); }
  await admitted(G[1]);
  W.state.mirrorDown = true;
  try { await W.publish({ deny: [] }); refused(await ask(G[1]), G[1], /platform host policy/); } finally { W.state.mirrorDown = false; }
  await admitted(G[1]);
  if (LEGACY) return;
  const off = { ...G[0].roleCfg, relayEnvBase: { ...G[0].roleCfg.relayEnvBase, ENCLAVE_PLATFORM_HOST_POLICY: 'off' } };
  const v = await (await wire(off)).verifyPeer({ url: G[1].url, config: G[1].config, measurements: PA.measurements, minTcb: PA.minTcb });
  assert.equal(v.ok, false); assert.match(v.reason, /explicitly off/);
});

test('an inactive row refuses: in the original registry, and in the policy\'s registry facts', T(), async () => {
  HOSTS[G[2].registryId].active = false;
  try { refused(await ask(G[2]), G[2]); } finally { HOSTS[G[2].registryId].active = true; }
  POLICY_HOSTS[G[2].registryId].active = false;
  try { refused(await ask(G[2]), G[2], /platform host policy/); } finally { POLICY_HOSTS[G[2].registryId].active = true; }
  await admitted(G[2]);
});

test('a policy row of another operator than the attested one, and a non-member identity, refuse', T(), async () => {
  POLICY_HOSTS[G[2].registryId].operator = OTHER_OP;
  try { refused(await ask(G[2]), G[2], /another registry row/); } finally { POLICY_HOSTS[G[2].registryId].operator = OPS[2]; }
  const stranger = { ...G[2].config, identity: { ...G[2].config.identity, operator: OTHER_OP } };
  const r = await ask(G[2], stranger);
  refused(r, G[2]); assert.equal(r.body.error, 'not_a_member');
  await admitted(G[2]);
});

test('a banned member that reboots (its RAM state gone) stays without K; once the admin lifts the ban it obtains K', T(), async () => {
  await stopRole(NEWCOMER);
  for (const d of [G[1].roleCfg.dirs.root, G[1].roleCfg.dirs.data]) fs.rmSync(d, { recursive: true, force: true });
  await W.publish({ deny: [{ kind: 'registryId', value: G[1].registryId, reason: 'ban before reboot' }] });
  const before = handedTo(1);
  NEWCOMER = await startRoleFor(G[1]);
  await sleep(4000);                                     // ~13 asks at askMs 300
  assert.equal(NEWCOMER.status().haveKey, false, 'the rebooted banned member holds no K');
  assert.equal(handedTo(1), before, 'the holder handed nothing to it');
  await W.publish({ deny: [] });
  await waitFor('the rebooted member holds K after the ban is lifted', () => NEWCOMER.status().haveKey, 30000);
});
