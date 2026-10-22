// Native control names bound to the measured control guest's ATTESTED key (metal/guest/measured-control.mjs nativeControl,
// scripts/native-control-certificate.mjs, network/native-control-routes.mjs). What runs here:
//   * the REAL control front, statement, certificate checks, issuance tool and discovery wiring (controlRoutesFromEnv);
//   * REAL TLS everywhere (a throwaway native CA and a rogue CA, minted with openssl per run);
//   * the REAL measured-control verifier and repository SNP verifier, fed a SYNTHETIC AMD-shaped chain
//     (test/helpers/snp-synth.mjs). That proves the protocol wiring only - nothing about AMD hardware or a real measurement;
//   * the REAL registry quorum reader and service-index quorum reader over in-process JSON-RPC servers, and the REAL platform
//     host policy gate over test/helpers/platform-policy-world.mjs (an admin-signed, anchored policy) - no injected decision;
//   * the REAL production MCP handler (relay/mcp.js handleMcp) behind the native mcp name.
// Public addresses (44.0.0.x, a DigitalOcean address) are dialed to loopback ports; nothing leaves 127.0.0.1.
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
import { X509Certificate, generateKeyPairSync, randomBytes } from 'node:crypto';
import * as viem from 'viem';
import { decodeFunctionData, encodeFunctionResult, keccak256, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { synthChain, synthReport } from './helpers/snp-synth.mjs';
import { platformPolicyWorld, REGISTRY } from './helpers/platform-policy-world.mjs';
import { memoryCollateral } from '../verifier/collateral.mjs';
import { TCB_FLOORS } from '../verifier/metal-box.mjs';
import { hostABI } from '../network/registry-abi.mjs';
import { SERVICE_INDEX_ABI, AD_VERSION } from '../network/service-index.mjs';
import * as MC from '../metal/guest/measured-control.mjs';
import { verifyMeasuredControl, registryIdOf } from '../metal/measured-control-verify.mjs';
import { quorumRegistry } from '../metal/guest/platform-api-verify.mjs';
import { nativeCertificateRequest, issueNativeCertificate, installNativeCertificate, pinnedRequest, main as certCli } from '../scripts/native-control-certificate.mjs';
import { controlRoutesFromEnv, readControlCandidates, prepareControlAd, nativeHostDecision, CONTROL_KIND } from '../network/native-control-routes.mjs';
import { createDiscovery } from '../relay/native-discovery.mjs';
import { handleMcp, isMcpHost } from '../relay/mcp.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-attested-'));
const servers = [], sockets = new Set();
const track = (s) => { servers.push(s); s.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)); }); return s; };
after(() => { for (const c of sockets) c.destroy(); for (const s of servers) { try { s.close(); } catch {} } fs.rmSync(tmp, { recursive: true, force: true }); });
const listen = async (s) => { track(s); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return s.address().port; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const API = 'api.enclavehost.eth', MCP = 'mcp.enclavehost.eth', PA_HOST = 'api.enclave.host';
const DO = ['134.199.235.187', '134.209.248.172', '165.245.191.129', '146.190.246.39'];
const ZA = '0x' + '00'.repeat(20), Z32 = '0x' + '00'.repeat(32);
const a = (n) => '0x' + n.toString(16).padStart(40, '0');

// ---- throwaway certificate authorities (openssl) ----------------------------------------------------------------------------
const o = (args) => execFileSync('openssl', args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
const read = (f) => fs.readFileSync(path.join(tmp, f), 'utf8');
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
function mintCa(name) {
  o(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.pem`, '-subj', `/CN=${name}`, '-days', '2',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  const pem = read(`${name}.pem`);
  return { pem, certFile: path.join(tmp, `${name}.pem`), keyFile: path.join(tmp, `${name}.key`), sha256: MC.sha256Hex(new X509Certificate(pem).raw) };
}
const NCA = mintCa('native-ca'), ROGUE = mintCa('rogue-ca');
let leafN = 0;
/** A CA-signed leaf over an arbitrary public key (what a CA holder COULD issue), for the refusal cases. -> chain PEM */
function leafOver(publicKeyPem, ca, names, { notBefore = Date.now() - 3600e3, notAfter = Date.now() + 86400e3 } = {}) {
  const n = ++leafN; fs.writeFileSync(path.join(tmp, `pub${n}.pem`), publicKeyPem);
  fs.writeFileSync(path.join(tmp, `ext${n}`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=${names.map((x) => 'DNS:' + x).join(',')}\n`);
  o(['x509', '-new', '-force_pubkey', `pub${n}.pem`, '-subj', `/CN=${names[0]}`, '-CA', ca.certFile, '-CAkey', ca.keyFile, '-set_serial', String(1000 + n),
    '-not_before', stamp(notBefore), '-not_after', stamp(notAfter), '-sha256', '-extfile', `ext${n}`, '-out', `leaf${n}.pem`]);
  return read(`leaf${n}.pem`) + ca.pem;
}

// ---- synthetic AMD chain (fixture: proves wiring, not hardware) -------------------------------------------------------------
const S = synthChain();
const COL = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } });
const ROOTS = new Map([['Genoa', S.arkFp]]);
const MEAS = '77'.repeat(48);

// ---- the chain: registry rows (shared with the policy world) and kind-9 index ads, over loopback JSON-RPC ---------------------
const HOSTS = {};                       // registryId -> { operator, active, endpoint, owner, proofKey }
const ADS = [];                         // { operator, slot, endpoints, ttlSec }
const INDEX = '0x' + '5a'.repeat(20), INDEX_CODE = '0x6080604052600a';
const INDEX_PIN = { chainId: 8453, address: INDEX, codeHash: keccak256(INDEX_CODE) };
const t0 = Date.now();
const head = () => 1000 + Math.floor((Date.now() - t0) / 1000);
const blockAt = (n) => ({ number: toHex(n), hash: keccak256(toHex(n, { size: 32 })), parentHash: keccak256(toHex(n - 1, { size: 32 })), timestamp: toHex(Math.floor(t0 / 1000) + (n - 1000)),
  transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x1', difficulty: '0x0', logsBloom: '0x' + '00'.repeat(256), miner: ZA, nonce: '0x0000000000000000',
  sha3Uncles: Z32, stateRoot: Z32, receiptsRoot: Z32, transactionsRoot: Z32, extraData: '0x', size: '0x1', uncles: [], mixHash: Z32, totalDifficulty: '0x0' });
const adRow = (x, ts) => ({ operator: x.operator, slot: x.slot, kind: x.kind ?? CONTROL_KIND, version: AD_VERSION, sequence: 1n, expiresAt: BigInt(ts + x.ttlSec), updatedAt: BigInt(ts), descriptor: Z32, endpoints: x.endpoints });
function rpcAnswer({ method, params }) {
  if (method === 'eth_chainId') return '0x2105';
  if (method === 'eth_blockNumber') return toHex(head());
  if (method === 'eth_getBlockByNumber') return blockAt(params[0] === 'latest' ? head() : Number(params[0]));
  if (method === 'eth_getCode') return String(params[0]).toLowerCase() === INDEX ? INDEX_CODE : '0x';
  if (method === 'eth_call') {
    const { to, data } = params[0], T = String(to).toLowerCase(), ts = Math.floor(t0 / 1000) + (Number(params[1]) - 1000 || 0);
    if (T === INDEX) {
      const { functionName, args } = decodeFunctionData({ abi: SERVICE_INDEX_ABI, data });
      if (functionName === 'page') { const all = ADS.filter((x) => (x.kind ?? CONTROL_KIND) === Number(args[0])); return encodeFunctionResult({ abi: SERVICE_INDEX_ABI, functionName, result: [all.slice(Number(args[1]), Number(args[1] + args[2])).map((x) => adRow(x, ts)), BigInt(all.length)] }); }
      if (functionName === 'get') { const x = ADS.find((y) => y.operator.toLowerCase() === args[0].toLowerCase() && y.slot === Number(args[1]));
        return encodeFunctionResult({ abi: SERVICE_INDEX_ABI, functionName, result: x ? adRow(x, ts) : { operator: ZA, slot: 0, kind: 0, version: 0, sequence: 0n, expiresAt: 0n, updatedAt: 0n, descriptor: Z32, endpoints: [] } }); }
    }
    if (T === REGISTRY) {
      const { args } = decodeFunctionData({ abi: hostABI, data }), h = HOSTS[String(args[0]).toLowerCase()];
      return encodeFunctionResult({ abi: hostABI, functionName: 'get', result: { endpoint: h?.endpoint || '', repo: '', measurement: Z32, operator: h?.operator || ZA, registeredAt: 1n, lastSeen: 1n,
        active: !!h?.active, cpuPricePerSec6: 0n, gpuPricePerSec6: 0n, proofKey: h?.proofKey || ZA, payoutWallet: ZA } });
    }
    throw new Error(`unscripted call to ${T}`);
  }
  throw new Error(`unsupported ${method}`);
}
const RPCS = [];
test.before(async () => {
  for (let i = 0; i < 3; i++) {
    const s = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
      const one = (q) => { try { return { jsonrpc: '2.0', id: q.id, result: rpcAnswer(q) }; } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; } };
      const b = JSON.parse(Buffer.concat(c)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(b) ? b.map(one) : one(b))); }); });
    RPCS.push(`http://127.0.0.1:${await listen(s)}`);
  }
});
const registryReader = () => quorumRegistry({ rpcs: RPCS, quorum: 3, registry: REGISTRY });

// ---- one measured control guest stand-in: the real front over this boot's minted keys ------------------------------------------
const PA = () => ({ apiPort: 8098, peerPort: 8099, hostname: PA_HOST,
  members: [0, 1, 2].map((i) => ({ operator: a(0xb0 + i), publicUrl: `https://member-${i}.example.org`, controlUrl: `https://198.51.100.${10 + i}:8444` })),
  measurements: [MEAS], minTcb: null, admins: [a(0xad)], recovery: ['11'.repeat(32)], archives: ['https://archive.example'], archiveMs: 30000,
  relayEnv: { ADDRESS_BOOK_ADDRESS: '0xab214342d5a490150a4a977063a2f88e21f80907' }, leaseMs: 10000 });
const RAW = ({ operator, publicUrl, native = true }) => ({
  format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: REGISTRY, deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ['https://rpc-a.example/v1', 'https://rpc-b.example'], quorum: 2, releaseId: 'ab'.repeat(32),
  replicas: { gateways: ['https://replica.example'], storagePlan: null }, identity: { publicUrl, repo: 'owner/enclave', operator },
  selling: { cpuPrice6: 14, payout: null }, isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096' }, hostAdmissionSha256: null, controlPort: 8444,
  platformApi: PA(), ...(native ? { nativeControl: { names: [API, MCP], caSha256: NCA.sha256 } } : {}) });
// the platform API role's port, as the relay behind it selects MCP (relay/api-relay.js: isMcpHost(routingHost) || /mcp || /mcp/)
async function roleUpstream(log) {
  return listen(http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), host = req.headers['x-forwarded-host'] || req.headers.host;
    log.push({ method: req.method, path: req.url, host: req.headers.host, ip: req.headers['x-enclave-client-ip'], auth: req.headers.authorization || null });
    if (isMcpHost(host) || u.pathname === '/mcp' || u.pathname === '/mcp/') return handleMcp(req, res, u);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ role: 'platform-api', path: req.url }));
  }));
}
let gN = 0;
async function guest({ operator = privateKeyToAccount(generatePrivateKey()).address.toLowerCase(), native = true, register = true, publicUrl = `https://host-${++gN}.example.org` } = {}) {
  const d = path.join(tmp, `guest-${gN}-${randomBytes(3).toString('hex')}`); fs.mkdirSync(d);
  const P = { ...MC.GUEST_PATHS, runDir: d, sessionDir: path.join(d, 'session'), tlsKey: path.join(d, 'tls-key.pem'), tlsCert: path.join(d, 'tls-cert.pem'),
    platformApiHandoffKey: path.join(d, 'handoff.key'), nativeCertificate: path.join(d, 'native.pem') };
  const raw = RAW({ operator, publicUrl, native }), config = MC.canonicalDirectConfig(raw), digest = MC.configDigest(config), hostData = MC.hostDataHex(digest);
  const keys = MC.mintControlKeys({ paths: P }); keys.platformApi = { publicKey: MC.mintPlatformApiKey({ paths: P }) };
  const st = MC.controlStatement({ config, digest, hostData, mode: 'snp', keys });
  const proofKey = MC.addressOfPublicKey(keys.proof.publicKey, viem.keccak256), kid = MC.jwkThumbprint(keys.session.jwk);
  const supPort = await listen(http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v1/attestation' ? { proofKey: { address: proofKey }, sessionKey: { kid } } : { supervisor: true, path: req.url })); }));
  const roleLog = [], rolePort = await roleUpstream(roleLog);
  // the group's shared WebPKI key for platformApi.hostname (another key than the control key)
  const web = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const webKey = path.join(d, 'webpki-key.pem'), webCert = path.join(d, 'webpki-cert.pem');
  fs.writeFileSync(webKey, web.privateKey.export({ type: 'pkcs8', format: 'pem' })); fs.writeFileSync(webCert, MC.selfSignedCert(web.privateKey, web.publicKey, { cn: PA_HOST }));
  // the role's API port: the same upstream the WebPKI host route uses (in the guest both are platformApi.apiPort)
  const launched = MC.directNativeLaunch(config, { paths: P }), nat = launched && { ...launched, upstream: { host: '127.0.0.1', port: rolePort } };
  const keyPem = fs.readFileSync(P.tlsKey, 'utf8');
  const front = MC.createControlFront({ statementText: st.text, keyPem, certPem: keys.controlTls.certPem, mode: 'snp',
    reporter: async (rd) => ({ report: synthReport(S, { reportData: rd, hostData: Buffer.from(hostData, 'hex') }), certs: null }),
    upstream: { host: '127.0.0.1', port: supPort }, hostRoutes: [{ host: PA_HOST, upstream: { host: '127.0.0.1', port: rolePort } }],
    sni: { [PA_HOST]: { certFile: webCert, keyFile: webKey } }, native: nat });
  const port = await listen(front);
  const g = { raw, config, keys, st, stObj: MC.parseStatement(st.text), keyPem, port, url: `https://127.0.0.1:${port}`, front, roleLog, operator, publicUrl,
    registryId: registryIdOf(publicUrl).toLowerCase(), proofKey, web: { publicKeyPem: web.publicKey.export({ type: 'spki', format: 'pem' }) },
    spki: keys.controlTls.spkiSha256, controlPublicPem: new X509Certificate(keys.controlTls.certPem).publicKey.export({ type: 'spki', format: 'pem' }) };
  if (register) HOSTS[g.registryId] = { operator, active: true, endpoint: publicUrl, owner: ZA, proofKey };
  return g;
}
/** The CA holder's flow: verify the boot against its TRUSTED config (never an advertiser's claim), request, issue, install. */
async function adminIssue(g, { days = 1 } = {}) {
  const v = await verifyMeasuredControl({ url: g.url, expect: { config: g.raw, measurements: [MEAS], minTcb: TCB_FLOORS, roots: ROOTS }, collateral: COL, registry: registryReader() });
  assert.equal(v.status, 'verified', v.reasons.join('\n'));
  const ev = await pinnedRequest(g.url, { path: `${MC.EVIDENCE_PATH}?nonce=${randomBytes(32).toString('hex')}`, spkiSha256: v.identity.controlTlsSpkiSha256 });
  const request = nativeCertificateRequest({ evidence: JSON.parse(ev.body), identity: v.identity });
  const chain = issueNativeCertificate({ request, caCertFile: NCA.certFile, caKeyFile: NCA.keyFile, days, tmpRoot: tmp });
  const r = await installNativeCertificate({ controlUrl: g.url, chainPem: chain, spkiSha256: g.spki });
  assert.equal(r.status, 200, r.body);
  return { chain, request };
}
/** A native client: SNI `name`, the native CA only, the hostname check. */
function nativeCall(port, name, { host = name, method = 'GET', path: p = '/v1/health', body = null, headers = {}, ca = NCA.pem } = {}) {
  return new Promise((resolve, reject) => {
    let spki = null;
    const req = https.request({ host: '127.0.0.1', port, servername: name, ca, rejectUnauthorized: true, agent: false, method, path: p,
      checkServerIdentity: (_h, c) => tls.checkServerIdentity(name, c), headers: { host, ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8'), spki }));
    });
    req.on('socket', (s) => s.once('secureConnect', () => { spki = MC.sha256Hex(new X509Certificate(s.getPeerCertificate().raw).publicKey.export({ type: 'spki', format: 'der' })); }));
    req.on('error', reject); req.end(body || undefined);
  });
}
/** A raw PUT to the install path (any TLS client: the path is public). */
function rawPut(port, body, { chunked = false, hold = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, method: 'PUT', path: MC.NATIVE_CERT_PATH, rejectUnauthorized: false, agent: false,
      headers: chunked ? {} : { 'content-length': Buffer.byteLength(body) } }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() })); });
    req.on('error', reject);
    if (hold) { req.write(body.slice(0, 10)); return resolve(req); }
    if (chunked) { req.write(body); req.end(); } else req.end(body);
  });
}

// ---- 1. config, statement, front construction ---------------------------------------------------------------------------------
test('nativeControl is a strict optional member: it needs platformApi, names the native names sorted and the CA; the statement states it', async () => {
  const base = RAW({ operator: a(0x99), publicUrl: 'https://x.example.org', native: false });
  const plain = MC.canonicalDirectConfig(base);
  assert.equal(plain.nativeControl, undefined);
  const ok = MC.canonicalDirectConfig({ ...base, nativeControl: { names: [API, MCP], caSha256: NCA.sha256 } });
  assert.notEqual(MC.configDigest(ok), MC.configDigest(plain), 'HOST_DATA binds the native member');
  const refuse = (nc, re, b = base) => assert.throws(() => MC.canonicalDirectConfig({ ...b, nativeControl: nc }), re);
  refuse({ names: [API], caSha256: NCA.sha256 }, /needs the platformApi/, (({ platformApi, ...r }) => r)(base));
  refuse({ names: [MCP, API], caSha256: NCA.sha256 }, /sorted/);
  refuse({ names: ['get.enclavehost.eth'], caSha256: NCA.sha256 }, /one or more of/);
  refuse({ names: [API, API], caSha256: NCA.sha256 }, /each once/);
  refuse({ names: [API], caSha256: 'xx' }, /caSha256/);
  refuse({ names: [API], caSha256: NCA.sha256, port: 443 }, /unknown field/);
  refuse({ names: [API], caSha256: NCA.sha256 }, /must not include platformApi.hostname/, { ...base, platformApi: { ...PA(), hostname: API } });
  const g = await guest({ register: false });
  assert.deepEqual(g.stObj.native, { names: [API, MCP], caSha256: NCA.sha256 });
  assert.throws(() => MC.parseStatement(g.st.text.replace(`"caSha256":"${NCA.sha256}"`, '"caSha256":"zz"')), /native names malformed|canonical/);
  // the front refuses native routing the statement does not state, and a statement's names without the front's
  assert.throws(() => MC.createControlFront({ statementText: g.st.text, keyPem: g.keyPem, certPem: g.keys.controlTls.certPem, reporter: null }), /names native control names/);
  const plainSt = MC.controlStatement({ config: plain, digest: MC.configDigest(plain), hostData: MC.hostDataHex(MC.configDigest(plain)), mode: 'snp', keys: g.keys });
  assert.equal(MC.parseStatement(plainSt.text).native, undefined);
  assert.throws(() => MC.createControlFront({ statementText: plainSt.text, keyPem: g.keyPem, certPem: g.keys.controlTls.certPem, reporter: null,
    native: MC.directNativeLaunch(ok) }), /statement's bound names/);
  assert.throws(() => MC.createControlFront({ statementText: g.st.text, keyPem: g.keyPem, certPem: g.keys.controlTls.certPem, reporter: null,
    native: MC.directNativeLaunch(g.config), sni: { [API]: { certFile: 'x', keyFile: 'y' } } }), /no SNI certificate of their own/);
});

// ---- 2. the front before and after a certificate ---------------------------------------------------------------------------------
test('no leaf: a native name is refused at the handshake and never routed through another key; the WebPKI route is unchanged', async () => {
  const g = await guest({ register: false });
  await assert.rejects(nativeCall(g.port, API), /disconnected|alert|handshake|ECONNRESET|socket hang up/i);
  // the control certificate (no SNI) with a native Host: misdirected, the role is never reached
  const r = await pinnedRequest(g.url, { path: '/v1/x', spkiSha256: g.spki }).catch((e) => e);
  assert.equal(r.status, 200, 'the plain control path still reaches the supervisor');
  // servername '' : no SNI (Node's agent would otherwise derive SNI from the Host header)
  const viaControl = await new Promise((resolve, reject) => { const q = https.request({ host: '127.0.0.1', port: g.port, path: '/v1/x', servername: '', rejectUnauthorized: false, agent: false, headers: { host: API } },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); q.on('error', reject); q.end(); });
  assert.equal(viaControl, 421);
  // the platform API's own WebPKI name: its SNI file and its host route, exactly as before
  const web = await new Promise((resolve, reject) => { let k = null; const q = https.request({ host: '127.0.0.1', port: g.port, servername: PA_HOST, path: '/v1/x', rejectUnauthorized: false, agent: false, headers: { host: PA_HOST } },
    (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString(), k })); });
    q.on('socket', (s) => s.once('secureConnect', () => { k = new X509Certificate(s.getPeerCertificate().raw).publicKey.export({ type: 'spki', format: 'pem' }); })); q.on('error', reject); q.end(); });
  assert.equal(web.status, 200); assert.equal(web.k, g.web.publicKeyPem, 'the shared WebPKI key on its own name');
  assert.deepEqual(JSON.parse(web.body), { role: 'platform-api', path: '/v1/x' });
  assert.equal(g.roleLog.length, 1);
});

test('install refusals leave the current leaf serving; installs are bounded (one at a time, declared length, released on abort)', async () => {
  const g = await guest({ register: true });
  await adminIssue(g);
  const before = (await nativeCall(g.port, API)).spki;
  assert.equal(before, g.spki, 'the native leaf carries the attested control key');
  const validTo0 = g.front.nativeState().validTo;
  const refused = async (chain, re) => { const r = await rawPut(g.port, chain); assert.equal(r.status, 400, r.body); assert.match(JSON.parse(r.body).message, re); };
  await refused(leafOver(g.web.publicKeyPem, NCA, [API, MCP]), /does not certify this guest/);                     // the shared group WebPKI key
  await refused(leafOver(g.controlPublicPem, ROGUE, [API, MCP]), /bound native CA/);                               // another CA
  await refused(leafOver(g.controlPublicPem, NCA, [API]), /does not serve mcp\.enclavehost\.eth/);                 // a bound name missing
  await refused(leafOver(g.controlPublicPem, NCA, [API, MCP], { notBefore: Date.now() - 7200e3, notAfter: Date.now() - 3600e3 }), /not valid now/);
  await refused(leafOver(g.controlPublicPem, NCA, [API, MCP]) + NCA.pem, /exactly two PEM certificates/);
  // a replayed or reissued leaf that expires no later never replaces the installed one
  await refused(leafOver(g.controlPublicPem, NCA, [API, MCP], { notAfter: validTo0 - 60e3 }), /expires no earlier/);
  await refused(leafOver(g.controlPublicPem, NCA, [API, MCP], { notAfter: validTo0 }), /expires no earlier/);
  assert.equal(g.front.nativeState().validTo, validTo0);
  assert.equal((await nativeCall(g.port, API)).spki, before, 'still serving after every refusal');
  // bounds: a declared length is required and bounded before any body is kept
  const big = 'x'.repeat(MC.MAX_NATIVE_CHAIN_BYTES + 1);
  assert.equal((await rawPut(g.port, big)).status, 413);
  assert.equal((await rawPut(g.port, 'abc', { chunked: true })).status, 411);
  // one body at a time: a second installer is refused while the first holds the slot; an abandoned body releases it
  const held = await rawPut(g.port, leafOver(g.controlPublicPem, NCA, [API, MCP]), { hold: true });
  await sleep(100);
  assert.equal(g.front.nativeState().bodyHeld, true);
  assert.equal((await rawPut(g.port, leafOver(g.controlPublicPem, NCA, [API, MCP]))).status, 429);
  held.destroy(); await sleep(150);
  assert.deepEqual([g.front.nativeState().bodyHeld, g.front.nativeState().installing], [false, false], 'released on abort');
  // a later leaf replaces it
  const later = leafOver(g.controlPublicPem, NCA, [API, MCP], { notAfter: validTo0 + 3600e3 });
  const ok = await rawPut(g.port, later); assert.equal(ok.status, 200, ok.body);
  assert.equal(Date.parse(JSON.parse(ok.body).validTo), Math.floor((validTo0 + 3600e3) / 1000) * 1000);
  // one verification at a time: a second install while one is being checked is refused, never queued
  const first = g.front.installNativeCertificate(leafOver(g.controlPublicPem, NCA, [API, MCP], { notAfter: validTo0 + 7200e3 }));
  await assert.rejects(g.front.installNativeCertificate(leafOver(g.controlPublicPem, NCA, [API, MCP], { notAfter: validTo0 + 7300e3 })), /in progress/);
  await first;
  assert.equal(g.front.nativeState().installing, false);
});

test('native requests: SNI and Host agree, both names reach the platform API role; mcp is the production MCP handler at /mcp', async () => {
  const g = await guest({ register: true });
  await adminIssue(g);
  const r = await nativeCall(g.port, API, { path: '/v1/health?x=1', headers: { 'x-enclave-client-ip': '6.6.6.6', authorization: 'Bearer t' } });
  assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body), { role: 'platform-api', path: '/v1/health?x=1' });
  const last = g.roleLog.at(-1);
  assert.equal(last.host, PA_HOST, 'the role sees exactly its WebPKI host'); assert.equal(last.ip, '127.0.0.1', 'the front writes the client address'); assert.equal(last.auth, 'Bearer t');
  // native mcp: the relay's own MCP endpoint, every path at /mcp, query kept; POST JSON-RPC, GET info, SSE refusal, CORS preflight
  const init = await nativeCall(g.port, MCP, { method: 'POST', path: '/', headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) });
  assert.equal(init.status, 200, init.body); assert.equal(JSON.parse(init.body).result.serverInfo.name.length > 0, true);
  assert.equal(g.roleLog.at(-1).path, '/mcp'); assert.equal(g.roleLog.at(-1).auth, 'Bearer tok');
  const list = await nativeCall(g.port, MCP, { method: 'POST', path: '/anything?q=2', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
  assert.ok(JSON.parse(list.body).result.tools.length > 10); assert.equal(g.roleLog.at(-1).path, '/mcp?q=2');
  assert.equal((await nativeCall(g.port, MCP, { path: '/' })).status, 200);
  assert.equal((await nativeCall(g.port, MCP, { path: '/', headers: { accept: 'text/event-stream' } })).status, 405);
  assert.equal((await nativeCall(g.port, MCP, { method: 'OPTIONS', path: '/' })).status, 204);
  // the evidence is answered on a native connection (what discovery reads); SNI and Host that disagree are misdirected
  assert.equal(JSON.parse((await nativeCall(g.port, API, { path: `${MC.EVIDENCE_PATH}?nonce=${'ab'.repeat(32)}` })).body).format, MC.EVIDENCE_FORMAT);
  const n = g.roleLog.length;
  assert.equal((await nativeCall(g.port, API, { host: MCP })).status, 421);
  assert.equal((await nativeCall(g.port, API, { host: PA_HOST })).status, 421);
  assert.equal(g.roleLog.length, n, 'nothing misdirected reaches the role');
  await assert.rejects(nativeCall(g.port, API, { ca: ROGUE.pem }), /self.signed|unable to verify|certificate/i);
});

test('an installed leaf that expires stops the native name; the CLI issues without printing key material', async () => {
  const g = await guest({ register: false });
  const short = leafOver(g.controlPublicPem, NCA, [API, MCP], { notAfter: Date.now() + 2500 });
  assert.equal((await rawPut(g.port, short)).status, 200);
  assert.equal((await nativeCall(g.port, API)).status, 200);
  await sleep(2700);
  await assert.rejects(nativeCall(g.port, API), /disconnected|alert|handshake|ECONNRESET|socket hang up|expired/i);
  // the issuance command: request -> chain; the CA must be the bound one; the output carries no private key
  const evText = (await pinnedRequest(g.url, { path: `${MC.EVIDENCE_PATH}?nonce=${'cd'.repeat(32)}`, spkiSha256: g.spki })).body;
  const identity = { bootId: g.stObj.bootId, controlTlsSpkiSha256: g.spki, registryId: g.registryId };
  const req = nativeCertificateRequest({ evidence: JSON.parse(evText), identity });
  assert.throws(() => nativeCertificateRequest({ evidence: JSON.parse(evText), identity: { ...identity, bootId: 'ff'.repeat(16) } }), /not from the verified boot/);
  fs.writeFileSync(path.join(tmp, 'req.json'), JSON.stringify(req));
  assert.throws(() => issueNativeCertificate({ request: req, caCertFile: ROGUE.certFile, caKeyFile: ROGUE.keyFile, tmpRoot: tmp }), /not the native CA the boot is bound to/);
  assert.throws(() => issueNativeCertificate({ request: req, caCertFile: NCA.certFile, caKeyFile: NCA.keyFile, days: 30, tmpRoot: tmp }), /days: 1 to 7/);
  const out = []; const chainFile = path.join(tmp, `chain-${randomBytes(3).toString('hex')}.pem`);
  await certCli(['issue', '--request', path.join(tmp, 'req.json'), '--ca-cert', NCA.certFile, '--ca-key', NCA.keyFile, '--days', '1', '--out', chainFile], (s) => out.push(s));
  const chain = fs.readFileSync(chainFile, 'utf8');
  assert.ok(!/PRIVATE KEY/.test(chain + out.join('')));
  assert.equal(new X509Certificate(chain).subjectAltName, `DNS:${API}, DNS:${MCP}`);
  assert.equal((await installNativeCertificate({ controlUrl: g.url, chainPem: chain, spkiSha256: g.spki })).status, 200);
  assert.equal((await nativeCall(g.port, MCP, { path: '/' })).status, 200);
});

test('the issuance tool pins the attested key on the secure socket: a wrong-key self-signed peer gets no request byte', async () => {
  const g = await guest({ register: false });
  const k = generateKeyPairSync('ec', { namedCurve: 'P-256' }); let bytes = 0;
  const impostor = tls.createServer({ key: k.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: MC.selfSignedCert(k.privateKey, k.publicKey) }, (s) => { s.on('data', (d) => { bytes += d.length; }); s.on('error', () => {}); });
  const port = await listen(impostor);
  const chain = leafOver(g.controlPublicPem, NCA, [API, MCP]);
  await assert.rejects(installNativeCertificate({ controlUrl: `https://127.0.0.1:${port}`, chainPem: chain, spkiSha256: g.spki }), /not the attested key/);
  await assert.rejects(pinnedRequest(`https://127.0.0.1:${port}`, { path: '/', spkiSha256: g.spki }), /not the attested key/);
  await sleep(100);
  assert.equal(bytes, 0, 'no HTTP byte reached the impostor');
  assert.equal((await installNativeCertificate({ controlUrl: g.url, chainPem: chain, spkiSha256: g.spki })).status, 200, 'the real guest, same tool');
});

// ---- 3. discovery: the advertised address, the serving identity, the original registry and the ANCHORED admin policy ----------
test('discovery serves only attested, registered, admitted serving hosts; an unbanned advertiser cannot republish a banned host', async (t) => {
  const W = await platformPolicyWorld(t, { hosts: HOSTS });
  const A = await guest(), B = await guest(), C = await guest({ native: false }), D = await guest();
  await adminIssue(A); await adminIssue(B); await adminIssue(D);
  HOSTS[D.registryId].proofKey = a(0xdead);                               // D's registry row names another proof key
  // an impostor whose OWN key the native CA (mistakenly) certified, relaying everything else to A
  const ik = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const iChain = leafOver(ik.publicKey.export({ type: 'spki', format: 'pem' }), NCA, [API, MCP]);
  const impostor = https.createServer({ key: ik.privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: iChain.split(/(?<=-----END CERTIFICATE-----\n)/)[0] }, (req, res) => {
    const up = https.request({ host: '127.0.0.1', port: A.port, method: req.method, path: req.url, headers: req.headers, servername: req.socket.servername || undefined, rejectUnauthorized: false, agent: false },
      (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }); up.on('error', () => res.destroy()); req.pipe(up); });
  const PORTS = { '44.0.0.1': A.port, '44.0.0.2': B.port, '44.0.0.3': await listen(impostor), '44.0.0.4': C.port, '44.0.0.5': D.port, [DO[0]]: A.port };
  const dial = (addr) => ({ host: '127.0.0.1', port: PORTS[addr] ?? 1 });
  const X = a(0x1111), Y = B.operator;                                     // X: an unbanned advertiser; Y: B's own operator
  ADS.length = 0;
  ADS.push({ operator: X, slot: 0, ttlSec: 3600, endpoints: ['https://44.0.0.2/', 'https://44.0.0.3/', 'https://44.0.0.1/', `https://${DO[0]}/`] },
           { operator: Y, slot: 0, ttlSec: 3600, endpoints: ['https://44.0.0.2/'] },
           { operator: a(0x2222), slot: 1, ttlSec: 3600, endpoints: ['https://44.0.0.4/', 'https://44.0.0.5/', 'http://44.0.0.9/'] });
  const env = (extra = {}) => ({ ...W.env(), NATIVE_CONTROL_SERVICE_INDEX: `${INDEX}@${INDEX_PIN.codeHash}`, NATIVE_CONTROL_RPCS: RPCS.join(','), NATIVE_CONTROL_REGISTRY: REGISTRY,
    NATIVE_CONTROL_MEASUREMENTS: MEAS, NATIVE_CONTROL_EXCLUDE: DO.join(','), ...extra });
  const caFetch = (url, init = {}) => new Promise((resolve, reject) => {
    const q = https.request(url, { method: init.method || 'GET', ca: fs.readFileSync(W.ca), headers: init.headers }, (res) => { const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => resolve(new Response(Buffer.concat(c), { status: res.statusCode }))); }); q.on('error', reject); q.end(); });
  const logs = [];
  const routes = async (extra) => (await controlRoutesFromEnv(env(extra), { caPem: NCA.pem, fetch: caFetch, log: (m) => logs.push(m), collateral: COL, roots: ROOTS, dial }))();
  // the admin bans B's OPERATOR (an anchored, signed policy, read through the real gate); X, who advertises B, is not banned
  await W.publish({ deny: [{ kind: 'operator', value: B.operator, reason: 'abuse' }] });
  let r = await routes();
  assert.deepEqual(r.routes[API].addresses, ['44.0.0.1']); assert.deepEqual(r.routes[MCP].addresses, ['44.0.0.1']);
  assert.ok(r.routes[API].expiresAt <= Date.now() + 60_000);
  assert.match(logs.at(-1), /1 verified/);
  // the same round's evidence (the functions controlRoutesFromEnv composes, one round, no cache), every refusal named
  const detail = await (async () => {
    const m = await import('../network/native-control-routes.mjs');
    const { createHostPolicyRuntime, resolveHostPolicyConfig } = await import('../network/host-policy-runtime.mjs');
    const { freshAdmissions } = await import('../network/host-policy-adapters.mjs');
    const { rpcPeers } = await import('../network/policy-carriers.mjs');
    const rt = createHostPolicyRuntime(resolveHostPolicyConfig({ env: W.env(), chainId: 8453 }), { fetch: caFetch });
    const decide = freshAdmissions(rt.gate);
    return m.discoverControlRoutes({ excludeAddresses: DO, readCandidates: () => m.readControlCandidates({ peers: rpcPeers(RPCS), indexPin: INDEX_PIN }),
      verifyEndpoint: (address) => m.verifyNativeControlEndpoint({ address, caPem: NCA.pem, dial, collateral: COL, registry: registryReader(),
        expect: { measurements: [MEAS], minTcb: TCB_FLOORS, roots: ROOTS }, decideHost: async (id) => m.nativeHostDecision((await decide([id]))[id.toLowerCase()], rt.gate.accepted()?.policy) }) });
  })();
  const rej = (addr) => detail.rejected.filter((x) => x.address === addr).map((x) => x.reason).join(' | ');
  assert.deepEqual(detail.verified.map((v) => [v.address, v.registryId, v.advertisedBy]), [['44.0.0.1', A.registryId, X]], 'identity is the attested host, not the advertiser');
  assert.match(rej('44.0.0.2'), /refused by the platform host policy: banned by platform policy #1 \(operator\)/, 'B: banned, whoever advertises it');
  assert.match(rej('44.0.0.3'), /not over the attested control key/, 'the impostor relays A\'s evidence but not A\'s key');
  assert.match(rej('44.0.0.4'), /not bound to serve|unable to verify|self.signed|certificate/i, 'C: no native binding');
  assert.match(rej('44.0.0.5'), /attestation pending|proof key/, 'D: the registry names another proof key');
  assert.deepEqual(detail.excluded.map((x) => x.address), [DO[0]], 'the fleet address is never probed');
  assert.ok(detail.rejected.some((x) => /http/.test(x.endpoint || x.reason || '')));
  // the admin lifts B's ban: B is served (the decision was always on B, the serving host)
  await W.publish({ deny: [] });
  r = await routes();
  assert.deepEqual(r.routes[API].addresses.sort(), ['44.0.0.1', '44.0.0.2']);
  // a ban on A's REGISTRY ID (host-level) withdraws A, though X (unbanned) still advertises it
  await W.publish({ deny: [{ kind: 'registryId', value: A.registryId, reason: 'host ban' }] });
  r = await routes();
  assert.deepEqual(r.routes[API].addresses, ['44.0.0.2']);
  // a chipId denial cannot be matched to a verified chip here: every native route is refused, not served past it
  await W.publish({ deny: [{ kind: 'chipId', value: '0x' + 'ab'.repeat(32), reason: 'chip ban' }] });
  r = await routes();
  assert.deepEqual(r.routes, {});
  assert.equal(nativeHostDecision({ admit: true, status: 'current' }, { sequence: 9, deny: [{ kind: 'chipId', value: '0x' + 'ab'.repeat(32) }] }).admit, false);
  // policy unreadable (every policy RPC down): nothing is served
  await W.publish({ deny: [] });
  W.setDown(true);
  r = await routes();
  assert.deepEqual(r.routes, {});
  W.setDown(false);
  // the policy's own registry row (the book's registry, read at the policy's agreed block) must name the ATTESTED operator:
  // a row that disagrees with the attestation's registry read refuses that host
  W.state.hosts = { ...HOSTS, [A.registryId]: { ...HOSTS[A.registryId], operator: a(0x7777) } };
  r = await routes();
  assert.deepEqual(r.routes[API].addresses, ['44.0.0.2']);
  W.state.hosts = HOSTS;
  // a measurement the reviewer did not approve: nothing is served
  r = await routes({ NATIVE_CONTROL_MEASUREMENTS: '66'.repeat(48) });
  assert.deepEqual(r.routes, {});
  // explicit policy off is a refusal for native control routes, not an open door
  await assert.rejects(controlRoutesFromEnv(env({ ENCLAVE_PLATFORM_HOST_POLICY: 'off' }), { caPem: NCA.pem, fetch: caFetch, collateral: COL, roots: ROOTS, dial }), /explicitly off/);
  // end to end through native discovery's resolver: exactly the verified address, the native CA's fingerprint
  const getControlRoutes = await controlRoutesFromEnv(env(), { caPem: NCA.pem, fetch: caFetch, collateral: COL, roots: ROOTS, dial });
  const server = createDiscovery({ caPem: NCA.pem, getRoutes: async () => ({}), getControlRoutes, timeoutMs: 30_000 });
  const port = await listen(server);
  const res = await (await fetch(`http://127.0.0.1:${port}/native/resolve?name=${MCP}`)).json();
  assert.deepEqual(res.addresses.sort(), ['44.0.0.1', '44.0.0.2']); assert.equal(res.kind, 'control'); assert.equal(res.port, 443); assert.equal(res.caSha256, NCA.sha256);
});

test('candidates: kind-9 ads read at one agreed block; bad endpoints and expired ads dropped; the publication is the CLI\'s shape', async () => {
  ADS.length = 0;
  ADS.push({ operator: a(0x31), slot: 0, ttlSec: 3600, endpoints: ['https://44.0.0.1/', 'https://44.0.0.1:443/', 'https://44.0.0.2:8443/', 'https://10.0.0.1/', 'https://ctl.example.org/'] },
           { operator: a(0x32), slot: 2, ttlSec: 0, endpoints: ['https://44.0.0.7/'] },
           { operator: a(0x33), slot: 0, ttlSec: 3600, kind: 1, endpoints: ['https://44.0.0.8/'] },
           { operator: a(0x34), slot: 5, ttlSec: 3600, endpoints: ['https://44.0.0.6/'] });
  const { rpcPeers } = await import('../network/policy-carriers.mjs');
  const r = await readControlCandidates({ peers: rpcPeers(RPCS), indexPin: INDEX_PIN, operators: [a(0x34)] });
  assert.deepEqual(r.candidates.map((c) => c.address), ['44.0.0.6', '44.0.0.1'], 'named operators first; one entry per address');
  assert.equal(r.rejected.filter((x) => x.operator === a(0x31)).length, 3);
  await assert.rejects(readControlCandidates({ peers: rpcPeers(RPCS), indexPin: { ...INDEX_PIN, codeHash: '0x' + '12'.repeat(32) } }), /not the pinned/);
  const prep = prepareControlAd({ pin: INDEX_PIN, operator: a(0x31), slot: 0, sequence: 1, endpoints: ['https://44.0.0.1'] });
  assert.equal(prep.typedData.message.kind, CONTROL_KIND); assert.deepEqual(prep.typedData.message.endpoints, ['https://44.0.0.1/']);
  assert.equal(decodeFunctionData({ abi: SERVICE_INDEX_ABI, data: prep.call.data }).args[1], CONTROL_KIND);
  assert.throws(() => prepareControlAd({ pin: INDEX_PIN, operator: a(0x31), slot: 0, sequence: 1, endpoints: ['https://10.0.0.1/'] }), /public IPv4/);
});
