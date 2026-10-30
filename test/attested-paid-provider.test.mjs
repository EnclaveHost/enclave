// A PAID provider under chainAuthority "attested-verifier" (network/wg-provider/attested-submission.mjs): its on-chain
// qualification sends (EnclaveConnectivity setHost and qualify, through the UNCHANGED network/onchain-qualification.mjs)
// with every read, simulation, nonce and receipt from the ONE attested verifier and only submission, the pending nonce and
// fee hints from the operator's own backend.
//
// WHAT IS REAL HERE (actual runtime):
//   * an offline anvil chain (chain id 8453) with the PRODUCTION bytecode of EnclaveRegistry and EnclaveDeployments
//     (test/fixtures/credit-vault-independence-chain.json: verbatim live sources) and EnclaveConnectivity
//     (site/js/gen/contract-artifacts.js), so setHost / qualify succeed and revert exactly as on Base;
//   * the attested channel: the image lineage's control front and filtered /chain-verifier route (test fixture bundle of
//     e0dfe98aa), the provider's attested client (network/attested-verifier-client.mjs) attesting via SNP evidence;
//   * the provider's own modules: attested-authority.mjs, attested-submission.mjs, onchain-qualification.mjs (unchanged),
//     chain-authority.mjs checkOwnBackend (byte-identical to the control / lease-relay lineages);
//   * the own backend IS anvil (as the operator's own Base node), behind a fault-injecting proxy.
// WHAT IS A MOCK / SYNTHETIC (labelled):
//   * the SEV-SNP chain is synthetic (test/helpers/snp-synth.mjs; programmatic test roots - AMD's pin refuses it);
//   * the verifier behind the attested route is a STAND-IN that answers from anvil and checks NO Merkle proofs (the
//     real one is the pinned Helios); it models the verifier's refusals (stale head, down) and its "receipt not found";
//   * the backend faults (lost reply, swallowed request, wrong chain, unbound or behind head, pool hints, another hash)
//     are injected by the proxy.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as viem from 'viem';
import { createWalletClient, createPublicClient, http as viemHttp, defineChain, keccak256, stringToHex, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { synthChain, synthReport } from './helpers/snp-synth.mjs';
import { memoryCollateral } from '../verifier/collateral.mjs';
import { TCB_FLOORS } from '../verifier/metal-box.mjs';
import { providerChainAuthority } from '../network/wg-provider/attested-authority.mjs';
import { createAttestedSubmitter, providerTxBackend, parseSendRecord, TX_BACKEND_USE, backendCaller, quantity } from '../network/wg-provider/attested-submission.mjs';
import { connectivityQualificationABI, signOnchainQualification, submitAttestations, ensureHost } from '../network/onchain-qualification.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MC = await import(pathToFileURL(path.join(REPO, 'test/fixtures/attested-guest-image.bundle.mjs')).href);
const { CONTRACTS } = await import(pathToFileURL(path.join(REPO, 'site/js/gen/contract-artifacts.js')).href);
const FX = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/credit-vault-independence-chain.json'), 'utf8'));
const CONN_ABI = JSON.parse(fs.readFileSync(path.join(REPO, 'contracts/EnclaveConnectivity.abi.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'attested-paid-'));
const servers = [], children = [], closers = [];
after(() => { for (const c of closers) try { c(); } catch {} for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch {} } for (const c of children) try { c.kill('SIGKILL'); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });
// ZERO public calls: every socket this process opens (fetch/undici, viem http, the attested client's pinned TLS) is recorded
// by its target host; the last test asserts all of them are loopback. (The suite also runs in a network namespace with only lo.)
const connects = [];
const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0];
  connects.push(o && typeof o === 'object' ? (o.path ? 'unix:' + o.path : (o.host ?? 'localhost')) : typeof args[1] === 'string' ? args[1] : 'localhost');
  return socketConnect.apply(this, args);
};
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const listen = (s, port = 0) => new Promise((r) => s.listen(port, '127.0.0.1', () => { servers.push(s); r(s.address().port); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const hex = (n) => '0x' + BigInt(n).toString(16);
const HASH = /^0x[0-9a-fA-F]{64}$/;

// anvil's well-known development keys (offline chain only)
const K = { admin: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', operator: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  checker: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', stranger: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' };
const ACC = Object.fromEntries(Object.entries(K).map(([k, v]) => [k, privateKeyToAccount(v)]));
const PUBLIC_ADDRESS = '203.0.114.7', ENDPOINT = 'https://paid-host.example';

// ---- the verifier-only guest (image lineage), as test/attested-route-composition.test.mjs builds it ------------------------
const OPERATOR = privateKeyToAccount('0x' + randomBytes(32).toString('hex')).address.toLowerCase();
const SIGNER = '0x' + '9a'.repeat(20);
const RAW = () => ({ format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ['https://rpc-a.example/v1', 'https://rpc-b.example'], quorum: 2, releaseId: 'ab'.repeat(32),
  replicas: { gateways: ['http://192.0.2.10:8189', 'https://replica.example'], storagePlan: null },
  identity: { publicUrl: 'https://verifier.example.org', repo: 'owner/enclave', operator: OPERATOR },
  selling: { cpuPrice6: null, payout: null }, isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096' }, hostAdmissionSha256: null, controlPort: 8444,
  chainVerifier: { format: 'enclave-chain-verifier/v1', unsafeSigner: SIGNER, proofSources: ['http://10.0.2.2:28545/'], port: 50546, expose: 'attested' } });
let pathN = 0;
const guestPaths = () => { const d = path.join(tmp, `guest-${++pathN}`); fs.mkdirSync(d);
  return { ...MC.GUEST_PATHS, runDir: d, pins: path.join(d, 'pins.json'), sessionDir: path.join(d, 'session'), statement: path.join(d, 'statement.json'), tlsKey: path.join(d, 'tls-key.pem'), tlsCert: path.join(d, 'tls-cert.pem') }; };
const S = synthChain();
const COL = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } });
const ROOTS = new Map([['Genoa', S.arkFp]]), MEAS = '77'.repeat(48);
async function guest({ verifierPort }) {
  const P = guestPaths(), keys = MC.mintControlKeys({ paths: P }), raw = RAW();
  const cfg = MC.canonicalDirectConfig(raw), digest = MC.configDigest(cfg), hostData = MC.hostDataHex(digest);
  const st = MC.controlStatement({ config: cfg, digest, hostData, mode: 'snp', keys });
  const sup = http.createServer((req, res) => {
    if (req.url !== '/v1/attestation') { res.writeHead(404); return res.end(); }
    const b = Buffer.from(JSON.stringify({ proofKey: { address: MC.addressOfPublicKey(st.obj.keys.proof.publicKey, viem.keccak256) }, sessionKey: { kid: MC.jwkThumbprint(st.obj.keys.session) } }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b); });
  const supPort = await listen(sup);
  const reporter = async (reportData) => ({ report: synthReport(S, { reportData, hostData: Buffer.from(hostData, 'hex') }), certs: null });
  const front = MC.createControlFront({ statementText: st.text, keyPem: fs.readFileSync(P.tlsKey, 'utf8'), certPem: keys.controlTls.certPem, reporter, mode: 'snp',
    upstream: { host: '127.0.0.1', port: supPort }, routes: [{ path: MC.CHAIN_VERIFIER_ROUTE, upstream: { host: '127.0.0.1', port: verifierPort }, rewrite: '/', jsonrpc: MC.JSONRPC_FILTER }] });
  const port = await listen(front);
  return { url: `https://127.0.0.1:${port}`, raw };
}
function attestedCfg(g, over = {}) {
  const cfgFile = path.join(tmp, `replica-${randomBytes(4).toString('hex')}.json`); fs.writeFileSync(cfgFile, JSON.stringify(g.raw));
  return { chainAuthority: 'attested-verifier', attestedVerifier: { unsafeSigner: SIGNER, replicas: [{ url: g.url, configFile: cfgFile, measurements: [MEAS], minTcb: TCB_FLOORS }], collateral: { dir: tmp } }, ...over };
}

// ---- MOCK verifier stand-in behind the attested route: answers from anvil, checks NO proofs ------------------------------
async function startVerifierStandIn(upstream) {
  const state = { fault: null, calls: [] };
  let id = 0;
  const up = async (method, params) => {
    const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const j = await r.json(); if (j.error) throw new Error(j.error.message || 'upstream error'); return j.result;
  };
  const pinned = (p) => p && typeof p === 'object' && HASH.test(String(p.blockHash || ''));
  async function answer(method, p = []) {
    switch (method) {
      case 'eth_chainId': return '0x2105';
      case 'eth_blockNumber': return state.fault === 'lag' ? hex(BigInt(await up(method, [])) - 1n) : up(method, []);   // head one block behind
      case 'eth_getBlockByNumber': {
        if (state.fault === 'ring') {                         // the pinned Helios's refusal of a block its header path lacks (b1, real runtime)
          const latest = BigInt(await up('eth_blockNumber', []));
          if (BigInt(p[0]) === latest) throw new Error(`block ${latest} is outside EIP-2935 ring buffer range (latest: ${latest - 1n}, buffer size: 8191)`);
        }
        const b = await up(method, [p[0], false]); if (!b) return null;
        return { number: b.number, hash: b.hash, stateRoot: b.stateRoot, baseFeePerGas: b.baseFeePerGas,
          timestamp: state.fault === 'stale' ? hex(BigInt(b.timestamp) - 600n) : b.timestamp };
      }
      case 'eth_call': case 'eth_getBalance': case 'eth_getTransactionCount': case 'eth_getCode': case 'eth_getStorageAt':
        if (!pinned(p[p.length - 1])) throw new Error('verifier: state reads must be pinned by block hash');
        if (method === 'eth_getTransactionCount' && state.fault === 'nonce-unsafe') return '0x20000000000000';    // 2^53: beyond a safe integer
        if (method === 'eth_getTransactionCount' && state.fault === 'nonce-noncanonical') return '0x0' + (await up(method, p)).slice(2);
        return up(method, p);
      case 'eth_estimateGas': return up(method, p);
      case 'eth_getTransactionReceipt': {
        const r = await up(method, p); if (!r) throw new Error('receipt not found');   // as Helios answers
        if (state.fault === 'ring') { const latest = BigInt(await up('eth_blockNumber', [])); if (BigInt(r.blockNumber) === latest) throw new Error(`block ${latest} is outside EIP-2935 ring buffer range (latest: ${latest - 1n}, buffer size: 8191)`); }
        return r;
      }
      default: throw new Error('verifier: method not supported');
    }
  }
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      if (state.fault === 'down') { res.writeHead(502); return res.end('verifier down'); }
      const q = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      state.calls.push(q.method);
      let out; try { out = { jsonrpc: '2.0', id: q.id, result: await answer(q.method, q.params) }; } catch (e) { out = { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  const port = await listen(server);
  return { port, state };
}

// ---- the own backend: anvil (the operator's own node) behind a FAULT-INJECTING proxy -------------------------------------
async function startBackend(upstream) {
  const state = { fault: null, methods: [], raws: [] };
  const server = http.createServer((req, res) => {
    const chunks = []; req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      const q = JSON.parse(Buffer.concat(chunks).toString('utf8')), m = q.method;
      const f = (x) => String(state.fault || '').split('+').includes(x);       // faults combine: 'swallow+pending-ahead'
      state.methods.push(m === 'eth_getTransactionCount' ? `${m}(${q.params?.[1]})` : m);
      if (f('down')) return req.socket.destroy();
      const REFUSAL = { code: -32000, message: 'insufficient funds for gas * price + value' };
      const reply = (j) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      if (m === 'eth_sendRawTransaction') {
        state.raws.push(q.params[0]);
        if (f('swallow')) return req.socket.destroy();                                                                         // never reaches the node
        if (f('refuse-only')) return reply({ jsonrpc: '2.0', id: q.id, error: REFUSAL });                                      // refused, not forwarded
      }
      const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(q) });
      const j = await r.json();
      if (m === 'eth_sendRawTransaction' && f('drop-response')) return req.socket.destroy();                                   // reached the node, reply lost
      if (m === 'eth_sendRawTransaction' && f('hang')) return;                                                                  // reached the node, never answered
      if (m === 'eth_sendRawTransaction' && f('forward-then-refuse')) return reply({ jsonrpc: '2.0', id: q.id, error: REFUSAL });  // FORWARDED, then "refused"
      if (m === 'eth_sendRawTransaction' && f('wrong-id')) j.id = Number(q.id) + 1000;
      if (m === 'eth_sendRawTransaction' && f('both')) j.error = REFUSAL;
      if (m === 'eth_maxPriorityFeePerGas' && f('tip-noncanonical')) j.result = '0x0' + String(j.result).slice(2);
      if (m === 'eth_maxPriorityFeePerGas' && f('tip-negative')) j.result = '-0x1';
      if (m === 'eth_sendRawTransaction' && f('other-hash') && !j.error) j.result = '0x' + 'ab'.repeat(32);
      if (m === 'eth_chainId' && f('wrong-chain')) j.result = '0x1';
      if (m === 'eth_getBlockByNumber' && f('unbound') && j.result) j.result.hash = '0x' + 'ee'.repeat(32);
      if (m === 'eth_getBlockByNumber' && f('behind')) j.result = null;
      if (m === 'eth_getTransactionCount' && f('pending-ahead')) j.result = hex(BigInt(j.result) + 1n);
      if (m === 'eth_getTransactionCount' && f('pending-behind')) j.result = hex(BigInt(j.result) - 1n);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j));
    });
  });
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}/`, state };
}

// ---- the world: anvil + production contracts + attested channel + own backend -------------------------------------------
let worldP = null;
const world = () => (worldP ||= (async () => {
  const port = await freePort();
  const anvil = spawn('anvil', ['--port', String(port), '--chain-id', '8453', '--network', 'optimism', '--silent', '--code-size-limit', '30000', '--block-time', '1'], { stdio: 'ignore' });
  children.push(anvil);
  const rpc = `http://127.0.0.1:${port}`, chain = defineChain({ id: 8453, name: 'anvil', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pub = createPublicClient({ chain, transport: viemHttp(rpc) });
  for (let i = 0; ; i++) { try { await pub.getBlockNumber(); break; } catch { if (i > 150) throw new Error('anvil did not start'); await sleep(100); } }
  const wc = (who) => createWalletClient({ account: ACC[who], chain, transport: viemHttp(rpc) });
  const rawRpc = async (method, params = []) => { const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; };
  const deploy = async (abi, bytecode, args = []) => { const r = await pub.waitForTransactionReceipt({ hash: await wc('admin').deployContract({ abi, bytecode, args }) }); assert.equal(r.status, 'success'); return r.contractAddress.toLowerCase(); };
  const send = async (who, address, abi, functionName, args) => { const r = await pub.waitForTransactionReceipt({ hash: await wc(who).writeContract({ address, abi, functionName, args }) }); assert.equal(r.status, 'success', functionName); return r; };
  const usdc = await deploy(FX.MockUSDC.abi, FX.MockUSDC.bytecode), feed = await deploy(FX.FeedMock.abi, FX.FeedMock.bytecode);
  const registry = await deploy(FX.EnclaveRegistry.abi, FX.EnclaveRegistry.bytecode);
  const lib = await deploy(FX.EnclaveLedgerBandwidth.abi, FX.EnclaveLedgerBandwidth.bytecode);
  const ledger = await deploy(FX.EnclaveDeployments.abi, FX.EnclaveDeployments.bytecode.split(FX.EnclaveDeployments.libraryPlaceholder).join(lib.slice(2)), [usdc, '0x000000000000000000000000000000000000fee5', registry, feed]);
  const conn = await deploy(CONN_ABI, CONTRACTS.EnclaveConnectivity.bytecode, [ledger, [ACC.checker.address]]);   // the checker is the bootstrap signer
  const register = () => send('operator', registry, FX.EnclaveRegistry.abi, 'register', [ENDPOINT, 'owner/enclave', '0x' + '00'.repeat(32), 1n, 0n, a(0)]);
  await register();
  const hostId = keccak256(toBytes(ENDPOINT));
  const vs = await startVerifierStandIn(rpc), backend = await startBackend(rpc);
  const g = await guest({ verifierPort: vs.port });
  const caps = { maxFeePerGasWei: '100000000000', maxPriorityFeePerGasWei: '1000000000' };
  const auth = providerChainAuthority(attestedCfg(g, { pricePerGiB6: 1000, txBackend: { url: backend.url, ...caps } }), { testRoots: ROOTS, collateral: COL });
  closers.push(() => auth.verifier.close());   // file-level: after() here would bind to the first test that built the world
  // the operator's account, counting signatures (nothing may be signed when a gate refuses)
  const signs = [];
  const counted = (acct) => ({ ...acct, signTransaction: async (tx, o) => { signs.push(tx); return acct.signTransaction(tx, o); } });
  let n = 0;
  const submitter = ({ account = counted(ACC.operator), file = path.join(tmp, `send-${++n}.json`), backendCfg = auth.txBackend, timeoutMs } = {}) =>
    ({ file, s: createAttestedSubmitter({ verifier: auth.verifier, backend: backendCfg, account, stateFile: file, receiptPollMs: 200, ...(timeoutMs ? { timeoutMs } : {}) }) });
  const hosts = async (s) => s.client.readContract({ address: conn, abi: connectivityQualificationABI, functionName: 'hosts', args: [hostId] });
  const pause = () => rawRpc('evm_setIntervalMining', [0]), resume = () => rawRpc('evm_setIntervalMining', [1]), mine = () => rawRpc('evm_mine', []);
  // a checker's on-chain qualification of this host (the CHECKER side, signed over a direct read: not under test here).
  // skewMs moves issuedAt/expires later (issuedAt = now + skew - 30 s must stay at or before the head's time)
  const attestation = (skewMs = 0) => signOnchainQualification({ account: ACC.checker, client: pub, connectivity: conn, record: { kind: 'community', hostId, address: PUBLIC_ADDRESS }, now: Date.now() + skewMs });
  return { rpc, chain, pub, wc, rawRpc, send, register, registry, conn, hostId, vs, backend, g, auth, caps, signs, counted, submitter, hosts, pause, resume, mine, attestation };
})());
const recordOf = (f) => (fs.existsSync(f) ? parseSendRecord(fs.readFileSync(f, 'utf8'), f) : null);
const BACKEND_ALLOWED = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionCount(pending)', 'eth_maxPriorityFeePerGas', 'eth_sendRawTransaction']);

test('config: ONE explicit authority; a paid attested provider needs a valid own backend; the quorum is unchanged; the packaged provider reports it', { timeout: 60000 }, async () => {
  const q = providerChainAuthority({ rpc: ['https://a.example', 'https://b.example'], pricePerGiB6: 1000 });
  assert.equal(q.mode, 'quorum'); assert.equal(q.txBackend, null, 'a paid QUORUM provider is unchanged (it submits through its first RPC, as before)');
  assert.throws(() => providerChainAuthority({ rpc: ['https://a.example', 'https://b.example'], pricePerGiB6: 1000, txBackend: { url: 'http://127.0.0.1:8545/' } }), /txBackend is only used with chainAuthority "attested-verifier"/);
  const dead = http.createServer((q, r) => { r.writeHead(502); r.end(); }), deadPort = await listen(dead);
  const g = await guest({ verifierPort: deadPort });
  const opts = { testRoots: ROOTS, collateral: COL };
  assert.throws(() => providerChainAuthority(attestedCfg(g, { pricePerGiB6: 1000 }), opts), /needs txBackend/);
  assert.throws(() => providerChainAuthority(attestedCfg(g, { txBackend: { url: 'http://127.0.0.1:8545/' } }), opts), /not paid/);
  for (const [url, why] of [['https://rpc.example.org/', /address literal/], ['http://8.8.8.8:8545/', /public address/], ['http://localhost:8545/', /address literal/],
    ['http://u:p@127.0.0.1:8545/', /credentials/], ['http://127.0.0.1:8545/?key=1', /query/], ['ftp://127.0.0.1/', /http/], ['not a url', /URL/]])
    assert.throws(() => providerChainAuthority(attestedCfg(g, { pricePerGiB6: 1000, txBackend: { url } }), opts), why, url);
  assert.throws(() => providerTxBackend({ url: 'http://127.0.0.1:8545/', rpc: 'x' }), /unknown field rpc/);
  assert.throws(() => providerTxBackend({ url: 'http://127.0.0.1:8545/', maxGas: 1 }), /maxGas/);
  assert.throws(() => providerTxBackend({ url: 'http://127.0.0.1:8545/', maxFeePerGasWei: '0' }), /maxFeePerGasWei/);
  assert.throws(() => providerTxBackend({ url: 'http://127.0.0.1:8545/', maxFeePerGasWei: 5 }), /maxFeePerGasWei/);
  assert.throws(() => providerTxBackend({ url: 'http://127.0.0.1:8545/', maxFeePerGasWei: '10', maxPriorityFeePerGasWei: '11' }), /exceeds/);
  const ok = providerChainAuthority(attestedCfg(g, { pricePerGiB6: 1000, txBackend: { url: 'http://10.0.2.2:8545/' } }), opts);
  assert.equal(ok.mode, 'attested-verifier'); assert.equal(ok.txBackend.label, 'http://10.0.2.2:8545'); assert.equal(ok.txBackend.scope, 'private');
  assert.match(ok.describe, /own backend http:\/\/10\.0\.2\.2:8545 \(submission and hints only\)/);
  // the submitter refuses anything but the attested client, a backend and an absolute record file
  const st = path.join(tmp, 'x.json');
  assert.throws(() => createAttestedSubmitter({ verifier: { request: async () => null }, backend: ok.txBackend, account: ACC.operator, stateFile: st }), /attested verifier client/);
  assert.throws(() => createAttestedSubmitter({ verifier: ok.verifier, backend: null, account: ACC.operator, stateFile: st }), /own transaction backend/);
  assert.throws(() => createAttestedSubmitter({ verifier: ok.verifier, backend: ok.txBackend, account: ACC.operator, stateFile: 'rel.json' }), /absolute stateFile/);
  ok.verifier.close();
  // the packaged provider entry (wg-provider/main.mjs --check-config)
  const run = (args) => new Promise((resolve) => execFile(process.execPath, args, { cwd: REPO, timeout: 60000 }, (e, so, se) => resolve({ code: e ? (e.code ?? 1) : 0, out: so + se })));
  const write = (name, cfg) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(cfg)); return f; };
  const base = { bootstrap: 'explicit', checkers: ['0x' + '44'.repeat(20)], directories: ['https://dir.alice-net.org'], zone: 'apps.alice-net.org', probeZone: 'probe.alice-net.org',
    publicAddress: PUBLIC_ADDRESS, roles: ['exit'], authorityPins: { deployments: a(0x12), registry: a(0x11), connectivity: a(0x15), sessionVaultFactory: a(0) },
    pricePerGiB6: 1000, kind: 'community', hostId: '0x' + '12'.repeat(32), proofKeyFile: '/nonexistent/proof.key' };
  const main = path.join(REPO, 'network/wg-provider/main.mjs');
  let r = await run([main, '--check-config', write('paid-att.json', { ...base, ...attestedCfg(g, { txBackend: { url: 'http://127.0.0.1:18545/' } }) })]);
  assert.equal(r.code, 0, r.out);
  const out = JSON.parse(r.out.trim().split('\n').pop()); assert.equal(out.chainAuthority, 'attested-verifier'); assert.equal(out.txBackend, 'http://127.0.0.1:18545');
  r = await run([main, '--check-config', write('paid-att-none.json', { ...base, ...attestedCfg(g) })]); assert.notEqual(r.code, 0); assert.match(r.out, /needs txBackend/);
  r = await run([main, '--check-config', write('paid-att-public.json', { ...base, ...attestedCfg(g, { txBackend: { url: 'https://mainnet.base.org/' } }) })]); assert.notEqual(r.code, 0); assert.match(r.out, /address literal/);
  r = await run([main, '--check-config', write('paid-q.json', { ...base, rpc: ['https://a.example', 'https://b.example'] })]); assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(r.out.trim().split('\n').pop()).chainAuthority, 'quorum');
});

test('R2 backend answers are checked STRICTLY: exactly this id, JSON-RPC 2.0, exactly one of result or a well-formed error; anything else is no answer', { timeout: 60000 }, async () => {
  let answer = null, pending = [];
  const srv = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => {
    const q = JSON.parse(Buffer.concat(c).toString('utf8'));
    if (answer === 'swap') { pending.push({ q, res }); if (pending.length === 2) { const [x, y] = pending; pending = [];
      x.res.end(JSON.stringify({ jsonrpc: '2.0', id: y.q.id, result: '0x1' })); y.res.end(JSON.stringify({ jsonrpc: '2.0', id: x.q.id, result: '0x2' })); } return; }
    if (answer === 'http500') { res.writeHead(500); return res.end('{}'); }
    res.end(typeof answer === 'function' ? answer(q) : answer);
  }); });
  const port = await listen(srv), call = backendCaller(`http://127.0.0.1:${port}/`, 'test backend', 5000);
  const J = (o) => (q) => JSON.stringify(typeof o === 'function' ? o(q) : o);
  answer = J((q) => ({ jsonrpc: '2.0', id: q.id, result: '0x2105' }));
  assert.equal(await call('eth_chainId', []), '0x2105', 'a well-formed answer');
  answer = J((q) => ({ jsonrpc: '2.0', id: q.id, error: { code: -32000, message: 'nonce too low' } }));
  await assert.rejects(call('eth_sendRawTransaction', ['0x00']), (e) => e.code === 'chain_backend_error' && e.rpcMessage === 'nonce too low', 'a well-formed error keeps its words');
  const malformed = [
    ['no jsonrpc', (q) => ({ id: q.id, result: '0x1' })], ['jsonrpc 1.0', (q) => ({ jsonrpc: '1.0', id: q.id, result: '0x1' })],
    ['a wrong id', (q) => ({ jsonrpc: '2.0', id: q.id + 1, result: '0x1' })], ['a retyped id', (q) => ({ jsonrpc: '2.0', id: String(q.id), result: '0x1' })],
    ['no id', () => ({ jsonrpc: '2.0', result: '0x1' })], ['a null id', () => ({ jsonrpc: '2.0', id: null, result: '0x1' })],
    ['both result and error', (q) => ({ jsonrpc: '2.0', id: q.id, result: '0x1', error: { code: -32000, message: 'x' } })], ['neither', (q) => ({ jsonrpc: '2.0', id: q.id })],
    ['an error that is not an object', (q) => ({ jsonrpc: '2.0', id: q.id, error: 'insufficient funds' })],
    ['an error without an integer code', (q) => ({ jsonrpc: '2.0', id: q.id, error: { code: 1.5, message: 'insufficient funds' } })],
    ['an error without a message', (q) => ({ jsonrpc: '2.0', id: q.id, error: { code: -32000 } })],
    ['a batch', (q) => [{ jsonrpc: '2.0', id: q.id, result: '0x1' }]], ['null', () => null]];
  for (const [label, fn] of malformed) {
    answer = J(fn);
    await assert.rejects(call('eth_sendRawTransaction', ['0x00']), (e) => e.code === 'chain_backend_unavailable' && e.malformed === true, label);
  }
  answer = () => 'not json'; await assert.rejects(call('eth_chainId', []), (e) => e.code === 'chain_backend_unavailable', 'not JSON');
  answer = 'http500'; await assert.rejects(call('eth_chainId', []), (e) => e.code === 'chain_backend_unavailable', 'HTTP 500');
  // CONCURRENT requests answered with each other's ids: neither is taken as an answer
  answer = 'swap';
  const both = await Promise.allSettled([call('eth_getTransactionCount', ['0x' + '11'.repeat(20), 'pending']), call('eth_getTransactionCount', ['0x' + '22'.repeat(20), 'pending'])]);
  for (const r of both) { assert.equal(r.status, 'rejected'); assert.equal(r.reason.code, 'chain_backend_unavailable'); assert.match(r.reason.message, /not this request's/); }
  // canonical quantities only
  for (const ok of ['0x0', '0x1', '0xff', '0x' + 'f'.repeat(64)]) assert.equal(quantity(ok, 'x'), BigInt(ok));
  for (const no of ['0x', '0x01', '0X1', '0xFF', '-0x1', '1', 1, null, '0x' + '1'.repeat(65), ' 0x1']) assert.throws(() => quantity(no, 'x'), /canonical quantity/, String(no));
});

test('attested QUALIFICATION + PRICE flow on the real contracts: reads, simulation, nonce and receipts from the attested verifier; the own backend only submits', { timeout: 180000 }, async () => {
  const W = await world();
  const { s, file } = W.submitter();
  const before = W.signs.length;
  assert.equal(await ensureHost({ wallet: s.wallet, client: s.client, connectivity: W.conn, hostId: W.hostId, pricePerGiB6: 1000 }), true, 'setHost sent and confirmed by a verifier receipt');
  const [direct, tuna, price] = await W.hosts(s);
  assert.equal(direct, false); assert.equal(tuna, true); assert.equal(price, 1000n);
  assert.equal(await ensureHost({ wallet: s.wallet, client: s.client, connectivity: W.conn, hostId: W.hostId, pricePerGiB6: 1000 }), false, 'nothing sent when the verified state already matches');
  const att = await W.attestation();
  assert.equal(await submitAttestations({ wallet: s.wallet, client: s.client, connectivity: W.conn, hostId: W.hostId, address: PUBLIC_ADDRESS, attestations: [att] }), 1);
  const [operator, , expires] = await s.client.readContract({ address: W.conn, abi: connectivityQualificationABI, functionName: 'attestations', args: [W.hostId, ACC.checker.address] });
  assert.equal(operator.toLowerCase(), ACC.operator.address.toLowerCase()); assert.equal(Number(expires), att.expires);
  assert.equal(await submitAttestations({ wallet: s.wallet, client: s.client, connectivity: W.conn, hostId: W.hostId, address: PUBLIC_ADDRESS, attestations: [att] }), 0, 'a held attestation is not sent again');
  assert.equal(W.signs.length - before, 2, 'exactly two transactions signed');
  assert.equal(recordOf(file), null, 'the send record is empty once each was resolved');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the record is private'); assert.equal(fs.existsSync(file + '.strict.tmp'), false, 'no temp left: written by rename');
  // ABI / return-shape PARITY: the unchanged onchain-qualification.mjs gets from the attested reads exactly what a viem client
  // returns for the same calls (tuples, bigint widths, checksummed addresses)
  for (const q of [{ functionName: 'hosts', args: [W.hostId] }, { functionName: 'attestations', args: [W.hostId, ACC.checker.address] }, { functionName: 'ledger', args: [] },
    { functionName: 'qualificationDigest', args: [att.hostId, att.addressHash, BigInt(att.issuedAt), BigInt(att.expires), att.checks] }]) {
    const x = { address: W.conn, abi: connectivityQualificationABI, ...q };
    assert.deepEqual(await s.client.readContract(x), await W.pub.readContract(x), q.functionName);
  }
  // who was asked what
  const odd = W.backend.state.methods.filter((m) => !BACKEND_ALLOWED.has(m));
  assert.deepEqual(odd, [], 'the own backend is asked ONLY binding, pending nonce, fee hint and submission');
  assert.ok(W.backend.state.methods.includes('eth_sendRawTransaction') && W.backend.state.methods.includes('eth_getTransactionCount(pending)'));
  for (const m of ['eth_getTransactionReceipt', 'eth_getTransactionCount', 'eth_call', 'eth_estimateGas', 'eth_getBalance']) assert.ok(W.vs.state.calls.includes(m), `the attested verifier answered ${m}`);
  const d = s.describe();
  assert.equal(d.authority, 'attested-verifier'); assert.equal(d.localProof, false); assert.equal(d.replicaQuorum, false); assert.equal(d.finality, 'none');
  assert.deepEqual(d.submission.use, TX_BACKEND_USE);
  // the verified receipt carries the attested label, never "local proof" or "quorum"
  const last = keccak256(W.backend.state.raws.at(-1));
  const rc = await s.client.waitForTransactionReceipt({ hash: last, timeout: 5000 });
  assert.equal(rc.status, 'success'); assert.equal(rc.evidence.authority, 'attested-verifier'); assert.equal(rc.evidence.localProof, false);
  const vr = await W.pub.getTransactionReceipt({ hash: last });             // test check: the node's own receipt, same fields
  for (const k of ['status', 'blockNumber', 'gasUsed']) assert.deepEqual(rc[k], vr[k], k);
  for (const k of ['transactionHash', 'blockHash']) assert.equal(rc[k], vr[k].toLowerCase(), k);
});

test('PRE-SIGN gates: a refused, unavailable, unbound, behind or wrong-chain backend, a stale or down verifier, a foreign pending nonce, a revert (incl. the registry ban), caps and funds sign NOTHING', { timeout: 180000 }, async () => {
  const W = await world();
  const { s, file } = W.submitter();
  const sendPrice = (sub, p) => ensureHost({ wallet: sub.wallet, client: sub.client, connectivity: W.conn, hostId: W.hostId, pricePerGiB6: p });
  const expectNothing = async (label, fn, check) => {
    const signs = W.signs.length, raws = W.backend.state.raws.length;
    await assert.rejects(fn, check, label);
    assert.equal(W.signs.length, signs, `${label}: nothing signed`); assert.equal(W.backend.state.raws.length, raws, `${label}: nothing submitted`);
    assert.equal(recordOf(file), null, `${label}: nothing recorded`);
  };
  for (const [fault, code] of [['down', 'chain_backend_unavailable'], ['wrong-chain', 'chain_backend_wrong_chain'], ['unbound', 'chain_backend_unbound'],
    ['behind', 'chain_backend_behind'], ['pending-ahead', 'tx_foreign_pending'], ['pending-behind', 'chain_backend_pool_behind']]) {
    W.backend.state.fault = fault;
    await expectNothing(`backend ${fault}`, () => sendPrice(s, 2000), (e) => e.code === code && /not done|nothing signed/.test(e.message));
    W.backend.state.fault = null;
  }
  W.vs.state.fault = 'stale';
  await expectNothing('verifier head stale', () => sendPrice(s, 2000), (e) => e.code === 'chain_stale');
  W.vs.state.fault = null;
  // the verifier DOWN: even the read before the send fails; no fallback anywhere
  W.vs.state.fault = 'down';
  await expectNothing('verifier down', () => sendPrice(s, 2000), (e) => /attested verifier|chain_/.test(String(e.message) + e.code));
  W.vs.state.fault = null;
  // a revert in the verified simulation: setHost by an account that is not the host's operator
  const stranger = W.submitter({ account: W.counted(ACC.stranger) });
  await assert.rejects(sendPrice(stranger.s, 2000), (e) => e.code === 'tx_simulation');
  assert.equal(recordOf(stranger.file), null);
  // caps: a max fee below the verified base fee + tip, a gas cap below the call's need
  const tight = W.submitter({ backendCfg: providerTxBackend({ url: W.backend.url, maxFeePerGasWei: '1', maxPriorityFeePerGasWei: '1' }) });
  await assert.rejects(sendPrice(tight.s, 2000), (e) => e.code === 'tx_fee_cap'); assert.equal(recordOf(tight.file), null);
  const low = W.submitter({ backendCfg: providerTxBackend({ url: W.backend.url, ...W.caps, maxGas: 21000 }) });
  await assert.rejects(sendPrice(low.s, 2000), (e) => e.code === 'tx_gas_cap'); assert.equal(recordOf(low.file), null);
  // funds: anyone may submit a checker's attestation; an unfunded key is refused BEFORE signing (proven balance)
  const poor = W.submitter({ account: W.counted(privateKeyToAccount('0x' + randomBytes(32).toString('hex'))) });
  const att = await W.attestation(5_000);
  await assert.rejects(submitAttestations({ wallet: poor.s.wallet, client: poor.s.client, connectivity: W.conn, hostId: W.hostId, address: PUBLIC_ADDRESS, attestations: [att] }), (e) => e.code === 'tx_insufficient_funds');
  assert.equal(recordOf(poor.file), null);
  // the REGISTRY BAN (deregistration): verified reads still answer, and the qualify send refuses in simulation - nothing signed
  await W.send('operator', W.registry, FX.EnclaveRegistry.abi, 'deregister', [W.hostId]);
  const [, tuna] = await W.hosts(s); assert.equal(tuna, true, 'reads still pass through the attested verifier while the host is banned');
  await expectNothing('registry ban', () => submitAttestations({ wallet: s.wallet, client: s.client, connectivity: W.conn, hostId: W.hostId, address: PUBLIC_ADDRESS, attestations: [att] }), (e) => e.code === 'tx_simulation');
  await W.register();
  assert.equal(await sendPrice(s, 2000), true, 'with every fault cleared and the host re-registered, the same send goes through');
});

test('LOST broadcast reply and RESTART: the same signed bytes are re-broadcast, never re-signed; a returned hash or a pool entry is not a receipt', { timeout: 180000 }, async () => {
  const W = await world();
  const file = path.join(tmp, 'restart.json');
  const s1 = W.submitter({ file }).s;
  await W.pause();
  try {
    W.backend.state.fault = 'drop-response';                       // the node took it, the reply is lost
    const signs = W.signs.length;
    const hash = await s1.wallet.writeContract({ address: W.conn, abi: connectivityQualificationABI, functionName: 'setHost', args: [W.hostId, false, true, 3000n] });
    W.backend.state.fault = null;
    const rec = recordOf(file);
    assert.equal(rec.hash, hash); assert.equal(W.backend.state.raws.at(-1), rec.raw, 'the recorded bytes are what was broadcast');
    assert.ok(await W.rawRpc('eth_getTransactionByHash', [hash]), 'test check (direct node read): the transaction IS in the node pool');
    await assert.rejects(s1.client.waitForTransactionReceipt({ hash, timeout: 1500 }), (e) => e.code === 'tx_unconfirmed', 'a pool entry is not inclusion: no verifier receipt, no success');
    assert.deepEqual(recordOf(file), rec, 'still unresolved');
    // RESTART: a new submitter over the same record file
    const s2 = W.submitter({ file }).s; await s2.ready;
    assert.deepEqual(s2.pending(), { nonce: rec.nonce, hash });
    await assert.rejects(s2.settle(), (e) => e.code === 'tx_unresolved' && /re-broadcast (accepted|unknown)/.test(e.message));
    assert.equal(W.backend.state.raws.at(-1), rec.raw, 'exact bytes re-broadcast');
    await assert.rejects(ensureHost({ wallet: s2.wallet, client: s2.client, connectivity: W.conn, hostId: W.hostId, pricePerGiB6: 4000 }), (e) => e.code === 'tx_unresolved');
    assert.equal(W.signs.length - signs, 1, 'one signature in total');
    await W.mine();
    // (real-runtime finding, p4) the pinned Helios answers a receipt for a block past its own head and then refuses that
    // header: not confirmable yet -> unresolved, never an error that resolves anything
    W.vs.state.fault = 'lag';
    await assert.rejects(s2.settle(), (e) => e.code === 'tx_unresolved');
    assert.deepEqual(recordOf(file), rec, 'kept while the receipt\'s block is past the verifier head');
    W.vs.state.fault = 'ring';                                // head named, its header refused (exact real message)
    await assert.rejects(s2.settle(), (e) => e.code === 'tx_unresolved' && /re-broadcast/.test(e.message), 'unresolved, and the gate still binds at the verifier\'s own latest');
    assert.deepEqual(recordOf(file), rec, 'kept while the receipt\'s header is not served yet');
    W.vs.state.fault = null;
    const r = await s2.settle();
    assert.equal(r.state, 'receipt'); assert.equal(r.receipt.status, 'success'); assert.equal(r.receipt.transactionHash, hash);
    assert.equal(recordOf(file), null);
    assert.equal((await W.hosts(s2))[2], 3000n);
    // a request that never reached the node, then a backend answering ANOTHER hash: neither is evidence
    W.backend.state.fault = 'swallow';
    const h2 = await s2.wallet.writeContract({ address: W.conn, abi: connectivityQualificationABI, functionName: 'setHost', args: [W.hostId, false, true, 5000n] });
    const rec2 = recordOf(file);
    assert.equal(await W.rawRpc('eth_getTransactionByHash', [h2]), null, 'test check: the node never got it');
    W.backend.state.fault = 'other-hash';
    const s3 = W.submitter({ file }).s;
    await assert.rejects(s3.settle(), (e) => e.code === 'tx_unresolved' && /re-broadcast unknown/.test(e.message));
    assert.equal(W.backend.state.raws.at(-1), rec2.raw); assert.equal(W.backend.state.raws.at(-2), rec2.raw, 'the same bytes both times');
    W.backend.state.fault = null;
    await W.mine();
    const r2 = await s3.settle();
    assert.equal(r2.state, 'receipt'); assert.equal(r2.receipt.status, 'success'); assert.equal((await W.hosts(s3))[2], 5000n);
    assert.equal(W.signs.length - signs, 2);
    // a backend that takes the bytes and NEVER answers: the send is bounded by the backend timeout, its record kept
    W.backend.state.fault = 'hang';
    const quick = W.submitter({ timeoutMs: 2000 }), t0 = Date.now();
    const h3 = await quick.s.wallet.writeContract({ address: W.conn, abi: connectivityQualificationABI, functionName: 'setHost', args: [W.hostId, false, true, 8000n] });
    assert.ok(Date.now() - t0 < 10_000, `a lost reply is bounded (${Date.now() - t0} ms)`);
    assert.equal(recordOf(quick.file).hash, h3, 'kept for an exact re-broadcast');
    W.backend.state.fault = null;
    await W.mine();
    const r3 = await quick.s.settle();
    assert.equal(r3.state, 'receipt'); assert.equal(r3.receipt.status, 'success'); assert.equal(recordOf(quick.file), null);
  } finally { W.backend.state.fault = null; await W.resume(); }
});

test('R1 a backend REFUSAL is not proof that nothing is pending: forwarded-then-refused bytes stay recorded and are retried identically after restart; R2 malformed broadcast answers are unknown', { timeout: 180000 }, async () => {
  const W = await world();
  const file = path.join(tmp, 'refused.json');
  const s1 = W.submitter({ file }).s;
  await W.pause();
  try {
    const signs = W.signs.length;
    W.backend.state.fault = 'forward-then-refuse';               // the node TOOK the bytes; the backend answers "insufficient funds"
    await assert.rejects(s1.wallet.writeContract({ address: W.conn, abi: connectivityQualificationABI, functionName: 'setHost', args: [W.hostId, false, true, 11000n] }),
      (e) => e.code === 'tx_refused' && /refused, NOT proof that nothing is pending/.test(e.message));
    W.backend.state.fault = null;
    const rec = recordOf(file);
    assert.ok(rec, 'the record is KEPT after a refusal'); assert.equal(W.backend.state.raws.at(-1), rec.raw);
    assert.ok(await W.rawRpc('eth_getTransactionByHash', [rec.hash]), 'test check (direct node read): the "refused" bytes are in the node pool');
    // restart: the same bytes again, nothing new signed; a refusal of the re-broadcast is kept too
    const s2 = W.submitter({ file }).s;
    W.backend.state.fault = 'refuse-only';
    await assert.rejects(s2.settle(), (e) => e.code === 'tx_unresolved' && /refused on re-broadcast/.test(e.message));
    W.backend.state.fault = null;
    await assert.rejects(s2.settle(), (e) => e.code === 'tx_unresolved' && /re-broadcast (accepted|unknown)/.test(e.message));
    assert.equal(W.backend.state.raws.at(-1), rec.raw); assert.equal(W.backend.state.raws.at(-2), rec.raw, 'identical bytes on every retry');
    await assert.rejects(ensureHost({ wallet: s2.wallet, client: s2.client, connectivity: W.conn, hostId: W.hostId, pricePerGiB6: 12000 }), (e) => e.code === 'tx_unresolved');
    assert.equal(W.signs.length - signs, 1, 'no extra signature');
    await W.mine();
    const r = await s2.settle();
    assert.equal(r.state, 'receipt'); assert.equal(r.receipt.status, 'success'); assert.equal((await W.hosts(s2))[2], 11000n, 'the "refused" send landed');
    // a refusal that really was not forwarded holds the record BY DESIGN; manual reconciliation = consume that nonce with
    // another operator transaction (never delete the record): the verifier then proves it, and the send is "not landed"
    W.backend.state.fault = 'refuse-only';
    await assert.rejects(s2.wallet.writeContract({ address: W.conn, abi: connectivityQualificationABI, functionName: 'setHost', args: [W.hostId, false, true, 13000n] }), (e) => e.code === 'tx_refused');
    W.backend.state.fault = null;
    const held = recordOf(file);
    assert.ok(held); assert.equal(await W.rawRpc('eth_getTransactionByHash', [held.hash]), null, 'test check: never reached the node');
    const h = await W.wc('operator').sendTransaction({ to: ACC.operator.address, value: 0n, nonce: held.nonce }); await W.mine(); await W.pub.waitForTransactionReceipt({ hash: h });
    assert.equal((await s2.settle()).state, 'nonce-consumed'); assert.equal(recordOf(file), null); assert.equal((await W.hosts(s2))[2], 11000n);
    // R2: a broadcast answered with a WRONG id, or with BOTH members, is no answer: unknown, kept, retried as the same bytes
    for (const fault of ['wrong-id', 'both']) {
      W.backend.state.fault = fault;
      const hash = await s2.wallet.writeContract({ address: W.conn, abi: connectivityQualificationABI, functionName: 'setHost', args: [W.hostId, false, true, fault === 'both' ? 14000n : 15000n] });
      W.backend.state.fault = null;
      const k = recordOf(file); assert.equal(k.hash, hash, `${fault}: kept`);
      await assert.rejects(s2.settle(), (e) => e.code === 'tx_unresolved'); assert.equal(W.backend.state.raws.at(-1), k.raw);
      await W.mine(); const done = await s2.settle(); assert.equal(done.state, 'receipt', fault);
    }
    // R2: invalid fee or nonce answers refuse BEFORE signing (nothing signed, sent or recorded)
    const before = W.signs.length, raws = W.backend.state.raws.length;
    for (const [where, fault] of [['backend', 'tip-noncanonical'], ['backend', 'tip-negative'], ['verifier', 'nonce-unsafe'], ['verifier', 'nonce-noncanonical']]) {
      (where === 'backend' ? W.backend : W.vs).state.fault = fault;
      await assert.rejects(ensureHost({ wallet: s2.wallet, client: s2.client, connectivity: W.conn, hostId: W.hostId, pricePerGiB6: 16000 }), (e) => /canonical quantity|safe integer/.test(e.message), fault);
      (where === 'backend' ? W.backend : W.vs).state.fault = null;
      assert.equal(W.signs.length, before, `${fault}: nothing signed`); assert.equal(W.backend.state.raws.length, raws, `${fault}: nothing sent`); assert.equal(recordOf(file), null, fault);
    }
  } finally { W.backend.state.fault = null; W.vs.state.fault = null; await W.resume(); }
});

test('CHANGED NONCE: another transaction of the operator key consumes the recorded nonce - resolved from the verifier as "not landed", never as success', { timeout: 180000 }, async () => {
  const W = await world();
  const file = path.join(tmp, 'nonce.json');
  const { s } = W.submitter({ file });
  const consume = async (nonce) => { const h = await W.wc('operator').sendTransaction({ to: ACC.operator.address, value: 0n, nonce }); await W.mine(); await W.pub.waitForTransactionReceipt({ hash: h }); };
  const priceBefore = (await W.hosts(s))[2];
  await W.pause();
  try {
    W.backend.state.fault = 'swallow';
    await s.wallet.writeContract({ address: W.conn, abi: connectivityQualificationABI, functionName: 'setHost', args: [W.hostId, false, true, 6000n] });
    const rec = recordOf(file);
    // the BACKEND's nonce moving on is no proof: the record stays (its bytes are not re-broadcast to the node here: swallowed)
    W.backend.state.fault = 'swallow+pending-ahead';
    await assert.rejects(s.settle(), (e) => e.code === 'tx_unresolved');
    assert.deepEqual(recordOf(file), rec, 'an unproven backend nonce never resolves or clears the record');
    assert.equal(W.backend.state.methods.filter((m) => m.startsWith('eth_getTransactionCount') && m !== 'eth_getTransactionCount(pending)').length, 0, 'the backend is never asked a settled nonce');
    W.backend.state.fault = null;
    await consume(rec.nonce);
    const r = await s.settle();
    assert.equal(r.state, 'nonce-consumed'); assert.equal(recordOf(file), null);
    assert.equal((await W.hosts(s))[2], priceBefore, 'the verified state shows the send did not land');
    // the same through the caller's receipt wait
    W.backend.state.fault = 'swallow';
    const h = await s.wallet.writeContract({ address: W.conn, abi: connectivityQualificationABI, functionName: 'setHost', args: [W.hostId, false, true, 6000n] });
    W.backend.state.fault = null;
    await consume(recordOf(file).nonce);
    await assert.rejects(s.client.waitForTransactionReceipt({ hash: h, timeout: 10000 }), (e) => e.code === 'tx_nonce_consumed');
    assert.equal(recordOf(file), null);
    // a QUALIFY whose nonce is consumed by something else is NOT a qualification: the caller fails, the chain holds no attestation
    const att = await W.attestation(5_000);
    const held = async () => (await s.client.readContract({ address: W.conn, abi: connectivityQualificationABI, functionName: 'attestations', args: [W.hostId, ACC.checker.address] }))[2];
    const heldBefore = await held(), raws = W.backend.state.raws.length;
    W.backend.state.fault = 'swallow';
    const p = submitAttestations({ wallet: s.wallet, client: s.client, connectivity: W.conn, hostId: W.hostId, address: PUBLIC_ADDRESS, attestations: [att] });
    p.catch(() => {});
    for (let i = 0; W.backend.state.raws.length === raws; i++) { if (i > 200) throw new Error('nothing submitted'); await sleep(50); }
    W.backend.state.fault = null;
    await consume(recordOf(file).nonce);
    await assert.rejects(p, (e) => e.code === 'tx_nonce_consumed', 'nonce advanced without a receipt: the qualification is not counted as sent');
    assert.equal(await held(), heldBefore, 'and the verified chain holds no new attestation');
    assert.ok(Number(heldBefore) < att.expires);
    assert.equal(recordOf(file), null);
  } finally { W.backend.state.fault = null; await W.resume(); }
  assert.equal(await ensureHost({ wallet: s.wallet, client: s.client, connectivity: W.conn, hostId: W.hostId, pricePerGiB6: 6000 }), true, 'the next round re-decides from verified state and sends');
  assert.equal((await W.hosts(s))[2], 6000n);
});

test('RESTART state: an invalid, foreign or non-regular send record REFUSES every send (never cleared or overwritten); a record that cannot be written is never broadcast', { timeout: 120000 }, async () => {
  const W = await world();
  const sendPrice = (sub) => ensureHost({ wallet: sub.wallet, client: sub.client, connectivity: W.conn, hostId: W.hostId, pricePerGiB6: 9000 });
  const tx = (acct, over = {}) => acct.signTransaction({ chainId: 8453, type: 'eip1559', nonce: 7, to: W.conn, data: '0x', value: 0n, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, ...over });
  const good = await tx(ACC.operator), rec = (raw, nonce = 7) => JSON.stringify({ nonce, raw, hash: keccak256(raw) });
  const cases = [['not JSON', '{nope'], ['an extra field', JSON.stringify({ nonce: 7, raw: good, hash: keccak256(good), note: 'x' })],
    ['a hash that is not the bytes\' hash', JSON.stringify({ nonce: 7, raw: good, hash: '0x' + '11'.repeat(32) })], ['a nonce field other than the signed nonce', rec(good, 8)],
    ['another chain', rec(await tx(ACC.operator, { chainId: 1 }))], ['another key', rec(await tx(ACC.stranger))], ['not a transaction', rec('0x1234')],
    ['oversized', ' '.repeat(70 * 1024) + '{}']];
  const refuses = async (label, file, why) => {
    const before = fs.lstatSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null, signs = W.signs.length, raws = W.backend.state.raws.length;
    const { s } = W.submitter({ file });
    await assert.rejects(s.settle(), why, `${label}: settle`);
    await assert.rejects(sendPrice(s), why, `${label}: send`);
    if (before !== null) assert.equal(fs.readFileSync(file, 'utf8'), before, `${label}: never overwritten`);
    assert.equal(W.signs.length, signs, `${label}: nothing signed`); assert.equal(W.backend.state.raws.length, raws, `${label}: nothing sent`);
  };
  for (const [label, text] of cases) { const f = path.join(tmp, `bad-${randomBytes(4).toString('hex')}.json`); fs.writeFileSync(f, text); await refuses(label, f, /settle it by hand/); }
  const dir = path.join(tmp, 'record-dir'); fs.mkdirSync(dir); await refuses('a directory', dir, /regular file/);
  const target = path.join(tmp, 'record-target.json'), link = path.join(tmp, 'record-link.json'); fs.writeFileSync(target, '{}'); fs.symlinkSync(target, link);
  await refuses('a symlink', link, /regular file/);
  // PERSIST BEFORE BROADCAST: the temp file cannot be created -> the signed bytes never reach the backend, nothing is pending
  const blocked = path.join(tmp, 'blocked.json'); fs.mkdirSync(blocked + '.strict.tmp');
  const { s } = W.submitter({ file: blocked }), raws = W.backend.state.raws.length;
  await assert.rejects(sendPrice(s), /EISDIR|illegal operation on a directory/);
  assert.equal(W.backend.state.raws.length, raws, 'not persisted, so not broadcast'); assert.equal(s.pending(), null); assert.equal(fs.existsSync(blocked), false);
});

test('EXISTING paid-provider behaviour (the quorum branch\'s plain viem wallet and client over one node, unchanged): setHost, qualify, no resend', { timeout: 120000 }, async () => {
  const W = await world();
  // main.mjs under the RPC quorum: createWalletClient(http(cfg.rpc[0])) and the first public client - here the anvil node
  const wallet = createWalletClient({ account: ACC.operator, chain: W.chain, transport: viemHttp(W.rpc) }), client = W.pub;
  assert.equal(await ensureHost({ wallet, client, connectivity: W.conn, hostId: W.hostId, pricePerGiB6: 7000 }), true);
  assert.equal(await ensureHost({ wallet, client, connectivity: W.conn, hostId: W.hostId, pricePerGiB6: 7000 }), false);
  const att = await W.attestation(10_000);
  assert.equal(await submitAttestations({ wallet, client, connectivity: W.conn, hostId: W.hostId, address: PUBLIC_ADDRESS, attestations: [att] }), 1);
  assert.equal(await submitAttestations({ wallet, client, connectivity: W.conn, hostId: W.hostId, address: PUBLIC_ADDRESS, attestations: [att] }), 0);
});

test('a VERIFIED REVERTED receipt: a qualify that passed the verified simulation reverts on inclusion - the caller sees the revert, the record resolves', { timeout: 180000 }, async () => {
  const W = await world();
  const file = path.join(tmp, 'revert.json');
  const { s } = W.submitter({ file });
  const att = await W.attestation(15_000);   // issuedAt still before the head's time; expires after the last one sent
  await W.pause();
  const raws = W.backend.state.raws.length;
  const p = submitAttestations({ wallet: s.wallet, client: s.client, connectivity: W.conn, hostId: W.hostId, address: PUBLIC_ADDRESS, attestations: [att] });
  p.catch(() => {});
  for (let i = 0; W.backend.state.raws.length === raws; i++) { if (i > 200) throw new Error('nothing submitted'); await sleep(50); }
  const hash = keccak256(W.backend.state.raws.at(-1));
  // the attestation expires before the including block (chain time moves 400 s): the contract reverts it
  await W.rawRpc('evm_increaseTime', [400]); await W.mine();
  await assert.rejects(p, /qualify reverted/);
  assert.equal(recordOf(file), null, 'a reverted receipt resolves the send (its nonce is consumed)');
  const rc = await s.client.waitForTransactionReceipt({ hash, timeout: 5000 });
  assert.equal(rc.status, 'reverted'); assert.equal(rc.evidence.authority, 'attested-verifier'); assert.equal(rc.evidence.localProof, false);
  await W.resume();
});

test('ZERO public calls: every connection this file made went to loopback (the attested route, the own backend proxy, the test node)', () => {
  assert.ok(connects.length > 20, `connections recorded (${connects.length})`);
  assert.deepEqual(connects.filter((h) => !['127.0.0.1', '::1', 'localhost'].includes(h)), []);
});
