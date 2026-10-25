// The ATTESTED chain verifier (G1-G4): a verifier-only measured direct-control guest exposes its bound chain verifier read-only
// through the control front, and a remote caller reads the chain through it ONLY after SEV-SNP attestation.
// What runs here, and what it proves:
//   * the guest helper (metal/guest/measured-control.mjs), the guest checker (metal/guest/chain-verifier.mjs), the runtime
//     config check (network/rpc-runtime.mjs), the client (network/attested-verifier-client.mjs), the readers' labels
//     (network/lease-reader.mjs, network/verified-chain.mjs) and the owner-signature path (network/owner-signature.mjs)
//     are the ACTUAL source;
//   * the SEV-SNP evidence is SYNTHETIC (test/helpers/snp-synth.mjs, an AMD-shaped chain whose ARK this test pins; the real
//     AMD pin refuses it) and goes through verifier/snp.mjs UNCHANGED, via metal/measured-control-verify.mjs UNCHANGED;
//   * the verifier is test/helpers/loopback-verifier.mjs (the verifier protocol and refusals over a real anvil chain, no
//     Merkle checks: those are the real verifier's); the supervisor behind the front is a stand-in that serves only the minted
//     keys (verifyMeasuredControl step 6), because a verifier-only guest's supervisor is not under test here;
//   * the ERC-1271 owner, the SessionVault and its factory are real contracts on anvil (minimal hand-assembled bytecode with
//     exactly the call shapes network/owner-signature.mjs uses).
// Nothing leaves 127.0.0.1.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as viem from 'viem';
import { createWalletClient, createPublicClient, http as viemHttp, hashMessage, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { synthChain, synthReport } from './helpers/snp-synth.mjs';
import { startLoopbackVerifier } from './helpers/loopback-verifier.mjs';
import { memoryCollateral } from '../verifier/collateral.mjs';
import { TCB_FLOORS } from '../verifier/metal-box.mjs';
import * as MC from '../metal/guest/measured-control.mjs';
import { checkChainVerifier, REFUSING_VERIFIER } from '../metal/guest/chain-verifier.mjs';
import { witnessSourceEndpoint, rpcEndpoint } from '../network/rpc-identity.mjs';
import { createAttestedVerifier, checkAttestedReplicas, attestedOutcome, pinnedPost } from '../network/attested-verifier-client.mjs';
import { isAttestedVerifier } from '../network/attested-verifier-brand.mjs';
import { providerChainAuthority } from '../network/wg-provider/attested-authority.mjs';
import { LeaseReader } from '../network/lease-reader.mjs';
import { verifyOwnerSignature } from '../network/owner-signature.mjs';

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'attested-verifier-'));
const servers = [], children = [];
after(() => { for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch {} } for (const c of children) try { c.kill('SIGKILL'); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const listen = (s, port = 0) => new Promise((r) => s.listen(port, '127.0.0.1', () => { servers.push(s); r(s.address().port); }));

// ---- a disposable verifier-only owner config ---------------------------------------------------------------------------------
const OPERATOR_KEY = '0x' + randomBytes(32).toString('hex');                 // disposable, generated per run
const OPERATOR = privateKeyToAccount(OPERATOR_KEY).address.toLowerCase();
const SIGNER = '0x' + '9a'.repeat(20);
const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const RAW = () => ({
  format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ['https://rpc-a.example/v1', 'https://rpc-b.example'], quorum: 2, releaseId: 'ab'.repeat(32),
  replicas: { gateways: ['http://192.0.2.10:8189', 'https://replica.example'], storagePlan: null },
  identity: { publicUrl: 'https://verifier.example.org', repo: 'owner/enclave', operator: OPERATOR },
  selling: { cpuPrice6: null, payout: null }, isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096' },
  hostAdmissionSha256: null, controlPort: 8444,
});
const CVX = (over = {}) => ({ format: 'enclave-chain-verifier/v1', unsafeSigner: SIGNER, proofSources: ['http://10.0.2.2:28545/'], port: 50546, expose: 'attested', ...over });
const VRAW = () => ({ ...RAW(), chainVerifier: CVX() });
const CMDLINE = 'console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct';
const PAIR = randomBytes(32).toString('hex');
const fwFor = (over = {}) => ({ mode: 'snp', name: 'ctl', direct: VRAW(), isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096', pairingKey: PAIR }, registryKey: '', ...over });
let pathN = 0;
const guestPaths = () => { const d = path.join(tmp, `guest-${++pathN}`); fs.mkdirSync(d);
  return { ...MC.GUEST_PATHS, runDir: d, pins: path.join(d, 'pins.json'), storagePlan: path.join(d, 'plan.json'), pairKey: path.join(d, 'pair.key'), sessionDir: path.join(d, 'session'),
    acmeDir: path.join(d, 'acme'), statement: path.join(d, 'statement.json'), tlsKey: path.join(d, 'tls-key.pem'), tlsCert: path.join(d, 'tls-cert.pem'), serveConfig: path.join(d, 'serve.json'), status: path.join(d, 'status.json') }; };

// ---- G2: an untrusted witness source at a private literal ------------------------------------------------------------------
test('G2: the guest checker and the runtime accept http at a PRIVATE IPv4 literal as an untrusted witness source, nothing wider', () => {
  for (const u of ['http://10.0.2.2:28545/', 'http://172.16.0.9/', 'http://192.168.8.249:8545/'])
    assert.deepEqual(checkChainVerifier({ ...CVX({ expose: undefined }), proofSources: [u] }).proofSources, [u]);
  for (const u of ['http://8.8.8.8/', 'http://rpc.example/', 'http://172.32.0.1/', 'http://10.0.2.2.example/', 'http://user:pw@10.0.2.2/', 'ftp://10.0.2.2/'])
    assert.throws(() => checkChainVerifier({ ...CVX({ expose: undefined }), proofSources: [u] }), /proofSources\[0\] must be https/, u);
  const e = witnessSourceEndpoint('http://10.0.2.2:28545/');
  assert.equal(e.privateLiteral, true); assert.equal(e.loopback, false); assert.equal(e.identity, 'private:10.0.2.2:28545');
  assert.throws(() => rpcEndpoint('http://10.0.2.2:28545/'), /HTTPS/, 'the shared RPC rule is unchanged: a private literal is never an RPC authority');
  assert.throws(() => witnessSourceEndpoint('http://8.8.8.8/'), /HTTPS/);
  assert.equal(witnessSourceEndpoint('https://holder.example.net/').identity, rpcEndpoint('https://holder.example.net/').identity, 'https sources: exactly rpcEndpoint');
});

// ---- G1: the bound exposure and the verifier-only guest ---------------------------------------------------------------------
test('G1: expose "attested" exists only in the HOST_DATA-bound direct config; absent keeps every earlier digest; it makes a verifier-only guest', () => {
  assert.throws(() => checkChainVerifier(CVX()), /expose is offered only inside a HOST_DATA-bound direct config/, 'a host-level / fw_cfg member can never expose');
  const plainCfg = MC.canonicalDirectConfig({ ...RAW(), chainVerifier: CVX({ expose: undefined }) });
  assert.equal('expose' in plainCfg.chainVerifier, false, 'absent: no key, so earlier digests are unchanged');
  const cfg = MC.canonicalDirectConfig(VRAW());
  assert.equal(cfg.chainVerifier.expose, 'attested');
  assert.notEqual(MC.configDigest(cfg), MC.configDigest(plainCfg), 'the exposure is part of the bound bytes');
  const refuse = (raw, re) => assert.throws(() => MC.canonicalDirectConfig(raw), re);
  refuse({ ...RAW(), chainVerifier: CVX({ expose: 'public' }) }, /expose must be "attested"/);
  refuse({ ...RAW(), chainVerifier: CVX({ txBackend: 'http://10.0.2.2:8545/' }) }, /read-only verifier: it takes no txBackend/);
  refuse({ ...VRAW(), mcp: { port: 8710, managementDirectories: [], capacityDirectories: [], capacityCold: [], maxHosts: 8, sessionScan: { fromBlock: 1 } } }, /verifier-only guest: remove mcp/);
});

test('G1: planDirectBoot of a verifier-only guest: the verifier is the only chain authority, every RPC name refuses, nothing is sold, one filtered route', async () => {
  const P = guestPaths(), imageFile = path.join(P.runDir, 'IMAGE.json');
  fs.copyFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'metal/chain-verifier-image.json'), imageFile);
  const cfg = MC.canonicalDirectConfig(VRAW()), hd = MC.hostDataHex(MC.configDigest(cfg));
  const plan = await MC.planDirectBoot({ cmdline: CMDLINE, fw: fwFor(), reportHostData: hd, viem, paths: { ...P, chainVerifierImage: imageFile } });
  assert.equal(plan.ok, true, plan.reasons?.join('; '));
  assert.equal(plan.env.ENCLAVE_CHAIN_AUTHORITY, 'verifier'); assert.equal(plan.env.ENCLAVE_CHAIN_VERIFIER, 'http://127.0.0.1:50546/');
  assert.equal('ENCLAVE_CHAIN_TX_BACKEND' in plan.env, false, 'nothing is submitted');
  for (const k of ['BASE_RPC', 'BASE_RPCS', 'ENCLAVE_PLATFORM_HOST_POLICY_RPCS']) assert.equal(plan.env[k], REFUSING_VERIFIER, `${k}: a legacy reader fails closed, never a public RPC`);
  assert.ok(!Object.values(plan.env).some((v) => String(v).includes('rpc-a.example') || String(v).includes('rpc-b.example')), 'the config\'s rpcs reach no environment name');
  assert.equal(plan.env.REGISTRY_ENABLED, '0'); assert.equal(plan.env.CLAIM_ENABLED, '0'); assert.equal(plan.selling, false);
  assert.deepEqual(MC.directEnvProblems(plan.env), []);
  const { directOnlyEnvProblems } = await import('../cli/host-independent-lifecycle.mjs');
  assert.deepEqual(directOnlyEnvProblems(plan.env), [], 'the real supervisor\'s direct-only rules accept it');
  assert.deepEqual(plan.chainVerifier.route, { path: '/chain-verifier', upstream: { host: '127.0.0.1', port: 50546 }, rewrite: '/', jsonrpc: 'chain-verifier-readonly' });
  assert.ok(!plan.mcp && !plan.platformApi && !plan.native, 'no rpcs-reading member');
  const sold = await MC.planDirectBoot({ cmdline: CMDLINE, fw: fwFor({ registryKey: OPERATOR_KEY }), reportHostData: hd, viem, paths: { ...guestPaths(), chainVerifierImage: imageFile } });
  assert.equal(sold.ok, false); assert.match(sold.reasons.join('\n'), /verifier-only guest: the host must hand over no registry key/);
  // a plain bound verifier (no expose) is exactly as before: no route, the configured rpcs stay where they were
  const plain = await MC.planDirectBoot({ cmdline: CMDLINE, fw: fwFor({ direct: { ...RAW(), chainVerifier: CVX({ expose: undefined }) } }),
    reportHostData: MC.hostDataHex(MC.configDigest(MC.canonicalDirectConfig({ ...RAW(), chainVerifier: CVX({ expose: undefined }) }))), viem, paths: { ...guestPaths(), chainVerifierImage: imageFile } });
  assert.equal(plain.ok, true, plain.reasons?.join('; ')); assert.equal(plain.chainVerifier.route, undefined); assert.equal(plain.env.BASE_RPC, 'https://rpc-a.example/v1');
});

// ---- the front's filtered route ---------------------------------------------------------------------------------------------
async function recordingUpstream({ answer = (q) => ({ jsonrpc: '2.0', id: q.id, result: '0x2105' }) } = {}) {
  const seen = [];
  const s = http.createServer((req, res) => { const c = []; req.on('data', (b) => c.push(b)); req.on('end', () => {
    const body = Buffer.concat(c); seen.push({ method: req.method, url: req.url, body: body.toString() });
    const out = Buffer.from(typeof answer === 'function' ? JSON.stringify(answer(JSON.parse(body.toString()))) : answer);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': out.length }); res.end(out); }); });
  return { port: await listen(s), seen };
}
// a booted verifier-only guest stand-in: minted keys, its statement, the stand-in supervisor (step 6) and the REAL front
const S = synthChain();
const COL = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } });
const MEAS = '77'.repeat(48);
async function guest({ verifierPort, raw = VRAW(), reporterHostData = null, frontPort = 0, mode = 'snp' } = {}) {
  const P = guestPaths(), keys = MC.mintControlKeys({ paths: P });
  const cfg = MC.canonicalDirectConfig(raw), digest = MC.configDigest(cfg), hostData = MC.hostDataHex(digest);
  const st = MC.controlStatement({ config: cfg, digest, hostData, mode, keys });
  const sup = http.createServer((req, res) => {
    if (req.url !== '/v1/attestation') { res.writeHead(404); return res.end(); }
    const b = Buffer.from(JSON.stringify({ proofKey: { address: MC.addressOfPublicKey(st.obj.keys.proof.publicKey, viem.keccak256) }, sessionKey: { kid: MC.jwkThumbprint(st.obj.keys.session) } }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b); });
  const supPort = await listen(sup);
  const reporter = async (reportData) => ({ report: synthReport(S, { reportData, hostData: Buffer.from(reporterHostData || hostData, 'hex') }), certs: null });
  const front = MC.createControlFront({ statementText: st.text, keyPem: fs.readFileSync(P.tlsKey, 'utf8'), certPem: keys.controlTls.certPem, reporter, mode,
    upstream: { host: '127.0.0.1', port: supPort }, routes: [{ path: MC.CHAIN_VERIFIER_ROUTE, upstream: { host: '127.0.0.1', port: verifierPort }, rewrite: '/', jsonrpc: MC.JSONRPC_FILTER }] });
  const port = await listen(front, frontPort);
  return { url: `https://127.0.0.1:${port}`, port, raw, st, front, spki: keys.controlTls.spkiSha256 };
}
const replica = (g, over = {}) => ({ url: g.url, config: g.raw, measurements: [MEAS], minTcb: TCB_FLOORS, roots: new Map([['Genoa', S.arkFp]]), ...over });

test('the front exposes ONLY filtered reads of the bound verifier; refusals never reach it; the route shape is fixed', async () => {
  const up = await recordingUpstream();
  const g = await guest({ verifierPort: up.port });
  const post = (body, { headers = {}, method = 'POST', pathQ = MC.CHAIN_VERIFIER_ROUTE } = {}) => pinnedPost(g.url, pathQ, Buffer.from(body), { pinSha256: g.spki }).catch((e) => e);
  const ok = await post(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'eth_chainId', params: [] }));
  assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.body).result, '0x2105');
  assert.equal(up.seen.length, 1); assert.equal(up.seen[0].url, '/'); assert.deepEqual(JSON.parse(up.seen[0].body), { jsonrpc: '2.0', id: 7, method: 'eth_chainId', params: [] }, 'the exact checked bytes');
  for (const [q, status] of [
    [{ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: ['0x00'] }, 403],
    [{ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [a(1), 'pending'] }, 403],
    [{ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: a(1) }, 'latest', { [a(1)]: { code: '0x00' } }] }, 403],
    [{ jsonrpc: '2.0', id: 1, method: 'constructor', params: [] }, 403], [{ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: [] }, 403],
    [{ jsonrpc: '2.0', id: 1, method: 'admin_nodeInfo', params: [] }, 403], [[{ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }], 400],
    [{ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [], extra: 1 }, 400], [{ jsonrpc: '1.0', id: 1, method: 'eth_chainId' }, 400],
    [{ jsonrpc: '2.0', id: { x: 1 }, method: 'eth_chainId' }, 400]]) {
    const r = await post(JSON.stringify(q)); assert.equal(r.status, status, JSON.stringify(q));
  }
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post('x'.repeat(MC.MAX_VERIFIER_REQUEST_BYTES + 1))).status, 413);
  assert.equal((await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }), { pathQ: MC.CHAIN_VERIFIER_ROUTE + '?x=1' })).status, 400);
  assert.equal(up.seen.length, 1, 'no refused request reached the verifier');
  // route validation: a JSON-RPC route is only the chain verifier's, at '/', on loopback
  const base = { statementText: g.st.text, keyPem: 'x', certPem: 'x', reporter: async () => ({}), upstream: { host: '127.0.0.1', port: 1 } };
  for (const r of [{ path: '/rpc', upstream: { host: '127.0.0.1', port: 1 }, rewrite: '/', jsonrpc: MC.JSONRPC_FILTER },
    { path: MC.CHAIN_VERIFIER_ROUTE, upstream: { host: '10.0.0.1', port: 1 }, rewrite: '/', jsonrpc: MC.JSONRPC_FILTER },
    { path: MC.CHAIN_VERIFIER_ROUTE, upstream: { host: '127.0.0.1', port: 1 }, rewrite: '/x', jsonrpc: MC.JSONRPC_FILTER },
    { path: MC.CHAIN_VERIFIER_ROUTE, upstream: { host: '127.0.0.1', port: 1 }, rewrite: '/', jsonrpc: 'any' },
    { path: '/mcp', upstream: { host: '127.0.0.1', port: 1 }, rewrite: '/' }])
    assert.throws(() => MC.createControlFront({ ...base, routes: [r] }), /front routes are exact/, JSON.stringify(r));
});

test('a verifier answer above the bound is cut off, never served as complete', async () => {
  const up = await recordingUpstream({ answer: JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'x'.repeat(MC.MAX_VERIFIER_ANSWER_BYTES + 10) }) });
  const g = await guest({ verifierPort: up.port });
  const r = await pinnedPost(g.url, MC.CHAIN_VERIFIER_ROUTE, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] })), { pinSha256: g.spki, maxBytes: 64 << 20 });
  assert.equal(r.status, 502); assert.equal(JSON.parse(r.body).error, 'answer_too_large');
});

// ---- G3: attestation, the pin, failover, and what is never accepted ---------------------------------------------------------
test('G3: a replica is used only after attestation through the UNCHANGED verifier; the outcome is "attested", never "verified"', async () => {
  const up = await recordingUpstream();
  const g = await guest({ verifierPort: up.port });
  const v = createAttestedVerifier({ allowTestRoots: true, replicas: [replica(g)], unsafeSigner: SIGNER, collateral: COL });
  assert.equal(isAttestedVerifier(v), true);
  assert.equal(await v.request('eth_chainId', [], 5000), '0x2105');
  const st = v.status();
  assert.equal(st.authority, 'attested-verifier'); assert.equal(st.localProof, false); assert.equal(st.replicaQuorum, false); assert.equal(st.finality, 'none');
  assert.equal(st.replicas[0].status, 'attested'); assert.equal(st.replicas[0].measurement, MEAS); assert.notEqual(st.replicas[0].status, 'verified');
  await assert.rejects(v.request('eth_sendRawTransaction', ['0x00']), /not a verifier read/, 'refused before any byte leaves');
  // the acceptance rule itself: every check but the registry, exactly
  assert.equal(attestedOutcome({ status: 'verified', checks: {} }).status, 'unavailable', 'a "verified" from anywhere else is not this outcome');
  assert.equal(attestedOutcome({ status: 'pending', checks: { statement: true, config: true, 'endpoint key': true, report: false, supervisor: true, registry: null } }).status, 'unavailable');
});

test('G3: wrong measurement, another config, a HOST_DATA that binds nothing, an unattested front, and a key change all refuse; failover is availability only', async () => {
  const up = await recordingUpstream();
  const g = await guest({ verifierPort: up.port });
  const once = async (r) => { const v = createAttestedVerifier({ allowTestRoots: true, replicas: [r], unsafeSigner: SIGNER, collateral: COL }); const e = await v.request('eth_chainId', [], 5000).catch((x) => x); return { e, st: v.status().replicas[0] }; };
  let o = await once(replica(g, { measurements: ['88'.repeat(48)] })); assert.match(String(o.e.message), /no attested replica/); assert.equal(o.st.status, 'rejected');
  o = await once(replica(g, { config: { ...VRAW(), controlPort: 8445 } })); assert.equal(o.st.status, 'rejected'); assert.match(o.st.reasons.join(' '), /config/);
  const lying = await guest({ verifierPort: up.port, reporterHostData: 'ee'.repeat(32) });
  o = await once(replica(lying)); assert.equal(o.st.status, 'rejected');
  const unattested = await guest({ verifierPort: up.port, mode: 'test' });
  o = await once(replica(unattested)); assert.equal(o.st.status, 'rejected'); assert.match(o.st.reasons.join(' '), /no hardware report/);
  assert.equal(up.seen.length, 0, 'no unattested replica was ever asked a chain question');
  // config refusals before anything is fetched
  assert.throws(() => checkAttestedReplicas([replica(g, { config: { ...RAW(), chainVerifier: CVX({ expose: undefined }) } })], { unsafeSigner: SIGNER, allowTestRoots: true }), /binds no attested chain verifier/);
  assert.throws(() => checkAttestedReplicas([replica(g)], { unsafeSigner: '0x' + '9b'.repeat(20), allowTestRoots: true }), /pins sequencer/);
  assert.throws(() => checkAttestedReplicas([replica(g, { minTcb: undefined })], { unsafeSigner: SIGNER, allowTestRoots: true }), /explicit TCB floor/);
  assert.throws(() => checkAttestedReplicas([replica(g, { url: 'http://127.0.0.1:1' })], { unsafeSigner: SIGNER, allowTestRoots: true }), /https origin/);
  assert.throws(() => checkAttestedReplicas([replica(g, { status: 'attested' })], { unsafeSigner: SIGNER, allowTestRoots: true }), /unknown field status/, 'no caller-supplied status');
  // failover: a dead first replica, an attested second one answers; nothing is combined
  const dead = `https://127.0.0.1:${await freePort()}`;
  const v = createAttestedVerifier({ allowTestRoots: true, replicas: [replica(g, { url: dead }), replica(g)], unsafeSigner: SIGNER, collateral: COL });
  assert.equal(await v.request('eth_chainId', [], 5000), '0x2105');
  assert.deepEqual(v.status().replicas.map((r) => r.status), ['unavailable', 'attested']);
  // a reboot: the same address now presents NEW keys; the pin refuses before any byte is sent, then a fresh attestation follows
  const before = up.seen.length;
  const g2 = await guest({ verifierPort: up.port });
  const solo = createAttestedVerifier({ allowTestRoots: true, replicas: [replica(g2)], unsafeSigner: SIGNER, collateral: COL });
  assert.equal(await solo.request('eth_chainId', [], 5000), '0x2105');
  const port = g2.port; g2.front.closeAllConnections?.(); await new Promise((r) => g2.front.close(r));
  const g3 = await guest({ verifierPort: up.port, frontPort: port });
  await assert.rejects(solo.request('eth_chainId', [], 5000), /key other than the attested control key/);
  assert.equal(solo.status().replicas[0].status, 'unattested');
  assert.equal(await solo.request('eth_chainId', [], 5000), '0x2105', 're-attested with a fresh nonce');
  assert.notEqual(solo.status().replicas[0].bootId, null);
  assert.equal(up.seen.length, before + 2, 'only attested requests reached the verifier');
  void g3;
});

test('G4: a plain object is never "attested", whatever it claims (the brand marks only client-built objects; not a boundary against same-process code)', () => {
  const fake = Object.freeze({ request: async () => '0x1', status: () => ({ authority: 'attested-verifier' }) });
  assert.equal(isAttestedVerifier(fake), false);
  const reader = new LeaseReader({ addressBook: a(0xb0), authority: 'verifier', verifier: fake });
  assert.equal(reader.authorityInfo().authority, 'local-verifier', 'an in-process object is what it always was; only the client is labelled attested');
});

// ---- the real chain path: anvil + the verifier protocol + ERC-1271 / SessionVault call shapes ----------------------------------
const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const init = (runtime) => { const n = runtime.length / 2; return '0x61' + n.toString(16).padStart(4, '0') + '80600c6000396000f3' + runtime; };
// isValidSignature(bytes32 h, bytes) -> 0x1626ba7e iff h == H (calldata word 1), else 0xffffffff
const erc1271 = (H) => '600435' + '7f' + word(H) + '14' + '603857' + '63ffffffff60e01b60005260206000f3' + '5b631626ba7e60e01b60005260206000f3';
const vaultOwner = (owner) => '73' + owner.slice(2) + '60005260206000f3';                       // owner() -> owner
const factoryIsVault = (vault) => '600435' + '73' + vault.slice(2) + '1460005260206000f3';       // isVault(x) -> x == vault
test('ERC-1271 and SessionVault owner signatures through the ATTESTED verifier on a real chain: the exact call shapes, no public RPC', { timeout: 120000 }, async () => {
  const port = await freePort();
  const anvil = spawn('anvil', ['--port', String(port), '--chain-id', '8453', '--silent', '--block-time', '1'], { stdio: 'ignore' }); children.push(anvil);
  const rpc = `http://127.0.0.1:${port}`, chain = defineChain({ id: 8453, name: 'anvil', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pc = createPublicClient({ chain, transport: viemHttp(rpc) });
  for (let i = 0; i < 100; i++) { try { await pc.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const wc = createWalletClient({ account: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'), chain, transport: viemHttp(rpc) });
  const deploy = async (runtime) => (await pc.waitForTransactionReceipt({ hash: await wc.sendTransaction({ data: init(runtime) }) })).contractAddress.toLowerCase();
  const message = 'enclave-network:policy:0x' + 'ab'.repeat(32), signature = '0x' + 'cd'.repeat(65);
  const passkey = await deploy(erc1271(hashMessage(message)));
  const vault = await deploy(vaultOwner(passkey)), factory = await deploy(factoryIsVault(vault));
  const lv = await startLoopbackVerifier({ upstream: rpc });
  const g = await guest({ verifierPort: Number(new URL(lv.url).port) });
  const attested = createAttestedVerifier({ allowTestRoots: true, replicas: [replica(g)], unsafeSigner: SIGNER, collateral: COL });
  const reader = new LeaseReader({ addressBook: a(0xb0), authority: 'verifier', verifier: attested });
  assert.equal(reader.authorityInfo().authority, 'attested-verifier'); assert.equal(reader.authorityInfo().localProof, false);
  const calls0 = lv.state.calls.length;
  assert.equal(await verifyOwnerSignature({ reader, owner: passkey, message, signature, addressBook: a(0xb0), sessionVaultFactory: a(0) }), true, 'ERC-1271 owner');
  assert.equal(await verifyOwnerSignature({ reader, owner: passkey, message: message + 'x', signature, addressBook: a(0xb0), sessionVaultFactory: a(0) }), false, 'another message');
  assert.equal(await verifyOwnerSignature({ reader, owner: vault, message, signature, addressBook: a(0xb0), sessionVaultFactory: factory }), true, 'SessionVault -> factory.isVault -> owner() -> ERC-1271');
  assert.equal(await verifyOwnerSignature({ reader, owner: vault, message, signature, addressBook: a(0xb0), sessionVaultFactory: a(0x99) }), false, 'not a vault of that factory');
  const calls = lv.state.calls.slice(calls0);
  assert.ok(calls.some((c) => c.method === 'eth_call' && c.to === passkey), 'isValidSignature was executed by the verifier');
  assert.ok(calls.some((c) => c.method === 'eth_call' && c.to === factory) && calls.some((c) => c.method === 'eth_call' && c.to === vault), 'isVault and owner() too');
  assert.ok(calls.every((c) => ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_call', 'eth_getCode'].includes(c.method)), calls.map((c) => c.method).join(','));
  // the verifier refuses (a failed proof): the answer is "not the owner", never a fallback
  lv.state.fault = 'proof';
  assert.equal(await verifyOwnerSignature({ reader, owner: passkey, message, signature, addressBook: a(0xb0), sessionVaultFactory: a(0) }), false);
  lv.state.fault = null;
  await lv.close();
});

// ---- round 2: configuration that must refuse, deadlines, aborts, the provider authority, packaging, the REAL supervisor ------
test('config: minTcb is validated as the verifier does (supported product line, exactly its fields, integers 0-255); roots only with the programmatic flag', async () => {
  const up = await recordingUpstream();
  const g = await guest({ verifierPort: up.port });
  const chk = (over, opts = { allowTestRoots: true }) => () => checkAttestedReplicas([replica(g, over)], { unsafeSigner: SIGNER, ...opts });
  assert.doesNotThrow(chk({}));
  assert.throws(chk({ minTcb: { Genoa: { bootloader: 10 } } }), /Genoa\.tee must be an integer 0-255/);
  assert.throws(chk({ minTcb: { Venice: { bootloader: 1 } } }), /unsupported product line "Venice"/);
  assert.throws(chk({ minTcb: { Genoa: { ...TCB_FLOORS.Genoa, fmc: 1 } } }), /unknown field "fmc"/);
  assert.throws(chk({ minTcb: { Turin: { ...TCB_FLOORS.Turin, snp: 5.5 } } }), /Turin\.snp must be an integer/);
  assert.throws(chk({ minTcb: { Genoa: { ...TCB_FLOORS.Genoa, microcode: 256 } } }), /integer 0-255/);
  assert.throws(chk({ minTcb: {} }), /names no product line/);
  assert.throws(chk({ crl: 'optional' }), /only "required"/);
  assert.throws(chk({}, {}), /roots: a non-AMD root pin is for programmatic tests only/, 'a root pin without the explicit programmatic flag is refused');
  assert.throws(() => createAttestedVerifier({ replicas: [replica(g)], unsafeSigner: SIGNER, collateral: COL }), /programmatic tests only/);
  assert.throws(() => createAttestedVerifier({ allowTestRoots: true, replicas: [replica(g)], unsafeSigner: SIGNER, collateral: {} }), /collateral/);
});

// a TCP listener that accepts and never answers (no TLS handshake): a replica that hangs
async function hanging() { const conns = new Set(); const s = net.createServer((c) => { conns.add(c); c.on('close', () => conns.delete(c)); });
  const port = await listen(s); return { url: `https://127.0.0.1:${port}`, close: () => { for (const c of conns) c.destroy(); } }; }
test('ONE deadline across attestation and every replica: 8 hanging replicas settle at the caller\'s deadline, not 8 x timeout; 8 dead ones fail fast', async () => {
  const up = await recordingUpstream();
  const g = await guest({ verifierPort: up.port });
  const hs = await Promise.all(Array.from({ length: 8 }, hanging));
  const v = createAttestedVerifier({ allowTestRoots: true, replicas: hs.map((h) => replica(g, { url: h.url })), unsafeSigner: SIGNER, collateral: COL, timeoutMs: 5000 });
  let t0 = Date.now(), e = await v.request('eth_chainId', [], 1200).catch((x) => x);
  const took = Date.now() - t0;
  assert.equal(e.code, 'ABORT_ERR', String(e?.message)); assert.match(e.message, /deadline passed/);
  assert.ok(took >= 1150 && took < 1900, `settled at the one deadline (${took} ms), not after 8 replicas x 5 s`);
  assert.ok(v.status().pendingAttestations <= 1, 'no attestation pile-up');
  v.close(); for (const h of hs) h.close();
  const dead = await Promise.all(Array.from({ length: 8 }, () => freePort()));
  const vd = createAttestedVerifier({ allowTestRoots: true, replicas: dead.map((p) => replica(g, { url: `https://127.0.0.1:${p}` })), unsafeSigner: SIGNER, collateral: COL });
  t0 = Date.now(); e = await vd.request('eth_chainId', [], 5000).catch((x) => x);
  assert.match(e.message, /no attested replica answered/); assert.ok(Date.now() - t0 < 3000, 'cold start with 8 dead replicas fails fast');
  assert.deepEqual(vd.status().replicas.map((r) => r.status), Array(8).fill('unavailable'));
  assert.equal(up.seen.length, 0);
  // the deadline is shared: a hanging FIRST replica consumes it, the healthy second is not given a fresh budget
  const h1 = await hanging();
  const vs = createAttestedVerifier({ allowTestRoots: true, replicas: [replica(g, { url: h1.url }), replica(g)], unsafeSigner: SIGNER, collateral: COL, timeoutMs: 5000 });
  t0 = Date.now(); e = await vs.request('eth_chainId', [], 800).catch((x) => x);
  assert.equal(e.code, 'ABORT_ERR'); assert.ok(Date.now() - t0 < 1500);
  vs.close(); h1.close();
});

test('aborts settle promptly while an attestation is pending; repeated aborts share one attestation; close() leaves no socket open', async () => {
  const up = await recordingUpstream();
  const g = await guest({ verifierPort: up.port });
  const h = await hanging();
  const v = createAttestedVerifier({ allowTestRoots: true, replicas: [replica(g, { url: h.url })], unsafeSigner: SIGNER, collateral: COL, timeoutMs: 10000 });
  const times = await Promise.all(Array.from({ length: 20 }, async (_, i) => {
    const ac = new AbortController(); setTimeout(() => ac.abort(), 20 + i);
    const t0 = Date.now(); const e = await v.request('eth_chainId', [], 10000, ac.signal).catch((x) => x);
    assert.equal(e.code, 'ABORT_ERR'); assert.match(e.message, /aborted/); return Date.now() - t0;
  }));
  assert.ok(Math.max(...times) < 400, `every aborted request settled promptly (max ${Math.max(...times)} ms)`);
  assert.ok(v.status().pendingAttestations <= 1, 'one shared attestation, not one per aborted caller');
  const pre = new AbortController(); pre.abort();
  await assert.rejects(v.request('eth_chainId', [], 1000, pre.signal), /aborted/);
  // an attested replica: a request aborted mid-flight destroys its pinned socket
  const slow = http.createServer((req, res) => { req.resume(); /* never answers */ });
  const slowPort = await listen(slow);
  const g2 = await guest({ verifierPort: slowPort });
  const v2 = createAttestedVerifier({ allowTestRoots: true, replicas: [replica(g2)], unsafeSigner: SIGNER, collateral: COL });
  await v2.attest();
  const ac = new AbortController(); setTimeout(() => ac.abort(), 200);
  await assert.rejects(v2.request('eth_chainId', [], 10000, ac.signal), /aborted/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(v2.status().openSockets, 0, 'the aborted request\'s socket is gone');
  v.close(); v2.close(); h.close(); slow.closeAllConnections?.();
  await assert.rejects(v.request('eth_chainId'), /closed/);
});

test('G5: the provider authority is ONE explicit choice; legacy modes unchanged; mixed, paid and root-naming configs refuse', async () => {
  const q = providerChainAuthority({ rpc: ['https://a.example', 'https://b.example'] });
  assert.equal(q.mode, 'quorum'); assert.deepEqual(q.leaseReaderOptions, {});
  const lv = providerChainAuthority({ rpc: ['https://a.example', 'https://b.example'], chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:8545/' });
  assert.equal(lv.mode, 'verifier'); assert.deepEqual(lv.leaseReaderOptions, { authority: 'verifier', verifier: 'http://127.0.0.1:8545/' });
  assert.throws(() => providerChainAuthority({}), /two or more RPC endpoints required/, 'the legacy requirement is unchanged');
  const up = await recordingUpstream();
  const g = await guest({ verifierPort: up.port });
  const cfgFile = path.join(tmp, 'replica-config.json'); fs.writeFileSync(cfgFile, JSON.stringify(g.raw));
  const seedDir = path.join(tmp, 'amd-seed'); fs.mkdirSync(seedDir);
  const AV = (over = {}) => ({ unsafeSigner: SIGNER, replicas: [{ url: g.url, configFile: cfgFile, measurements: [MEAS], minTcb: TCB_FLOORS }], collateral: { dir: seedDir }, ...over });
  const att = (cfg, opts = {}) => providerChainAuthority({ chainAuthority: 'attested-verifier', attestedVerifier: AV(), ...cfg }, opts);
  for (const [cfg, re] of [[{ rpc: ['https://a.example', 'https://b.example'] }, /rpc is not used/], [{ chainVerifier: 'http://127.0.0.1:1/' }, /chainVerifier \(a local verifier\)/],
    [{ pricePerGiB6: 5 }, /paid provider/], [{ attestedVerifier: AV({ roots: {} }) }, /unknown field roots/],
    [{ attestedVerifier: AV({ replicas: [{ url: g.url, configFile: cfgFile, measurements: [MEAS], minTcb: TCB_FLOORS, roots: [] }] }) }, /trust roots and statuses are never configured/],
    [{ attestedVerifier: AV({ replicas: [{ url: g.url, configFile: 'replica.json', measurements: [MEAS], minTcb: TCB_FLOORS }] }) }, /must be an absolute path/],
    [{ attestedVerifier: AV({ collateral: { dir: 'amd' } }) }, /collateral\.dir must be an absolute path/],
    [{ attestedVerifier: AV({ replicas: [{ url: g.url, configFile: cfgFile, measurements: [MEAS], minTcb: { Genoa: {} } }] }) }, /Genoa\.bootloader must be an integer/]])
    assert.throws(() => att(cfg), re, JSON.stringify(cfg).slice(0, 120));
  assert.throws(() => providerChainAuthority({ rpc: ['https://a.example', 'https://b.example'], attestedVerifier: AV() }), /chainAuthority is not "attested-verifier"/);
  // a config file alone (no programmatic roots) trusts only AMD's pin: the synthetic chain is refused at attestation
  const prod = att({}, { collateral: COL });
  await assert.rejects(prod.verifier.request('eth_chainId', [], 5000), /no attested replica/);
  assert.equal(prod.verifier.status().replicas[0].status, 'rejected');
  // with the programmatic test roots: the provider's reader, built exactly as main.mjs builds it, reads through the client
  const ok = att({}, { testRoots: new Map([['Genoa', S.arkFp]]), collateral: COL });
  const leases = new LeaseReader({ addressBook: a(0xb0), includeHostPayout: true, ...ok.leaseReaderOptions });
  assert.equal(leases.authorityInfo().authority, 'attested-verifier'); assert.equal(ok.rpc.length, 0, 'no raw RPC client exists');
  assert.equal(await ok.verifier.request('eth_chainId', [], 5000), '0x2105');
  prod.verifier.close(); ok.verifier.close();
});

test('packaging: separately bundled reader and client share ONE brand (no duplicate-module mislabel); the provider bundle resolves its closure', async () => {
  const esbuild = await import('esbuild');
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const entryA = path.join(tmp, 'reader-entry.mjs'), entryB = path.join(tmp, 'client-entry.mjs');
  fs.writeFileSync(entryA, `export { LeaseReader } from ${JSON.stringify(path.join(REPO, 'network/lease-reader.mjs'))};\nexport { isAttestedVerifier } from ${JSON.stringify(path.join(REPO, 'network/attested-verifier-brand.mjs'))};\n`);
  fs.writeFileSync(entryB, `export { createAttestedVerifier } from ${JSON.stringify(path.join(REPO, 'network/attested-verifier-client.mjs'))};\n`);
  const out = {};
  for (const [k, e] of [['a', entryA], ['b', entryB]]) {
    const f = path.join(tmp, `bundle-${k}.mjs`);
    await esbuild.build({ entryPoints: [e], outfile: f, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
      banner: { js: 'import {createRequire as __cr} from "node:module"; const require=__cr(import.meta.url);' } });
    out[k] = await import(pathToFileURLSafe(f));
  }
  const up = await recordingUpstream();
  const g = await guest({ verifierPort: up.port });
  const c = out.b.createAttestedVerifier({ allowTestRoots: true, replicas: [replica(g)], unsafeSigner: SIGNER, collateral: COL });
  assert.equal(out.a.isAttestedVerifier(c), true, 'the reader bundle recognises the client bundle\'s object');
  assert.equal(new out.a.LeaseReader({ addressBook: a(0xb0), authority: 'verifier', verifier: c }).authorityInfo().authority, 'attested-verifier');
  c.close();
  const prov = await esbuild.build({ entryPoints: [path.join(REPO, 'network/wg-provider/main.mjs')], bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false, logLevel: 'silent' });
  const text = Buffer.from(prov.outputFiles[0].contents).toString('utf8');
  assert.equal(text.split('enclave.attested-verifier.brand/v1').length, 2, 'one brand registry in the provider bundle');
  assert.ok(text.includes('attested-verifier'), 'the attested authority is in the provider bundle');
});
const pathToFileURLSafe = (f) => new URL('file://' + f).href;

test('the REAL supervisor starts in a verifier-only boot (refusing RPC names) and, behind the real front, passes attestation step 6', { timeout: 120000 }, async () => {
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const P = guestPaths(), imageFile = path.join(P.runDir, 'IMAGE.json');
  fs.copyFileSync(path.join(REPO, 'metal/chain-verifier-image.json'), imageFile);
  const cfg = MC.canonicalDirectConfig(VRAW()), digest = MC.configDigest(cfg), hd = MC.hostDataHex(digest);
  const plan = await MC.planDirectBoot({ cmdline: CMDLINE, fw: fwFor(), reportHostData: hd, viem, paths: { ...P, chainVerifierImage: imageFile } });
  assert.equal(plan.ok, true, plan.reasons?.join('; '));
  const keys = MC.mintControlKeys({ paths: P });
  const st = MC.controlStatement({ config: plan.config, digest: plan.digest, hostData: plan.hostData, mode: 'snp', keys });
  for (const [f, text] of Object.entries(plan.files)) fs.writeFileSync(f, text, { mode: 0o600 });
  fs.writeFileSync(P.pairKey, PAIR + '\n', { mode: 0o600 });
  const port = await freePort(), closed = await freePort(), dead = `127.0.0.1:${closed}`;
  // the plan's environment UNCHANGED for every chain name (BASE_RPC(S) and the policy RPCs stay the refusing verifier;
  // ENCLAVE_CHAIN_VERIFIER stays the bound loopback port); only process plumbing and non-chain services are moved to a
  // closed loopback port, so nothing leaves 127.0.0.1
  const env = { ...plan.env, PORT: String(port), STATE_FILE: path.join(P.runDir, 'state.json'), HOME: P.runDir, NODE_EXTRA_CA_CERTS: '', PATH: process.env.PATH,
    ATTESTATION_URL: `http://${dead}/.well-known/enclave-attestation`, VMMGR_URL: `http://${dead}`, GUESTD_DATA_ADDR: dead,
    GUEST_BOOTSTRAP_GATEWAYS: `http://${dead}/ipfs`, IPFS_GATEWAY: JSON.stringify([`http://${dead}`]) };
  for (const k of ['BASE_RPC', 'BASE_RPCS', 'ENCLAVE_PLATFORM_HOST_POLICY_RPCS']) assert.equal(env[k], REFUSING_VERIFIER);
  const c = spawn(process.execPath, ['--max-old-space-size=160', '--import', path.join(REPO, 'test/helpers/loopback-only-fetch.mjs'), path.join(REPO, 'supervisor.js')], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(c);
  let log = ''; c.stdout.on('data', (b) => { log += b; }); c.stderr.on('data', (b) => { log += b; });
  let healthy = false;
  for (let i = 0; i < 200 && !healthy; i++) {
    if (c.exitCode !== null) assert.fail(`the real supervisor exited ${c.exitCode} in a verifier-only boot:\n${log.slice(-3000)}`);
    try { healthy = (await fetch(`http://127.0.0.1:${port}/v1/health`)).ok; } catch {} if (!healthy) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(healthy, `the real supervisor answers:\n${log.slice(-2000)}`);
  assert.ok(!/rpc-a\.example|rpc-b\.example/.test(log), 'the config\'s rpcs appear nowhere in the supervisor\'s output');
  const up = await recordingUpstream();
  const reporter = async (reportData) => ({ report: synthReport(S, { reportData, hostData: Buffer.from(hd, 'hex') }), certs: null });
  const front = MC.createControlFront({ statementText: st.text, keyPem: fs.readFileSync(P.tlsKey, 'utf8'), certPem: keys.controlTls.certPem, reporter,
    upstream: { host: '127.0.0.1', port }, routes: [{ ...plan.chainVerifier.route, upstream: { host: '127.0.0.1', port: up.port } }] });
  const fport = await listen(front);
  const v = createAttestedVerifier({ allowTestRoots: true, replicas: [{ url: `https://127.0.0.1:${fport}`, config: VRAW(), measurements: [MEAS], minTcb: TCB_FLOORS, roots: new Map([['Genoa', S.arkFp]]) }], unsafeSigner: SIGNER, collateral: COL });
  assert.equal(await v.request('eth_chainId', [], 10000), '0x2105', 'attested through the REAL supervisor\'s minted keys (step 6)');
  assert.equal(v.status().replicas[0].status, 'attested');
  v.close(); c.kill('SIGTERM');
});
