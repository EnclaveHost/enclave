// R3: the paid provider's attested sends (network/wg-provider/attested-submission.mjs) against the REAL pinned verifier
// runtime - so the exact call parameters it sends (block-hash-pinned state reads, the numbered estimate, receipts by hash,
// header fields) are answered by the pinned Helios, not by a stand-in.
//
// WHAT IS REAL HERE (actual runtime):
//   * reth v2.8.0 --dev (chain 8453, the pinned dev genesis, 2 s blocks): the chain, and ALSO the provider's own backend
//     (behind a loopback fault/recording proxy);
//   * the verifier: the real runtime (network/rpc-runtime.mjs: the pinned helios-eeffcc9, witness-check and the real
//     listener's commitment step, heads signed by a TEST sequencer key, proofs from an untrusted loopback source), launched
//     READ-ONLY from the relay-consumer-source tree's own test helper (test/helpers/verifier-runtime.mjs, as its
//     relay-sponsor-verifier e2e does: this lineage has no rpc-runtime.mjs);
//   * the attested channel to it: the image lineage's control front and filtered /chain-verifier route (fixture bundle of
//     e0dfe98aa) and the provider's attested client; the provider modules and onchain-qualification.mjs (unchanged);
//   * the production EnclaveRegistry (live-source fixture) and EnclaveConnectivity (site artifact) bytecode.
// WHAT IS A STAND-IN (labelled):
//   * the SEV-SNP evidence is synthetic (programmatic test roots);
//   * the ledger passed to EnclaveConnectivity's constructor is a minimal contract answering registry() only: reth enforces
//     the 24 KiB code limit the full ledger exceeds, and on the setHost / qualify / hosts / attestations / qualificationFor(0)
//     path the ledger is read only by the constructor's registry() (contracts/EnclaveConnectivity.sol);
//   * the checker's attestation is signed over a direct node read (the checker side is not under test).
// Needs RUNTIME_BIN_DIR, RIG_RETH_BIN, RIG_RETH_GENESIS and RELAY_CONSUMER_TREE (a clean relay-consumer-source); with
// REQUIRE_VERIFIER_E2E=1 anything missing FAILS (never a silent skip).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as viem from 'viem';
import { createWalletClient, createPublicClient, http as viemHttp, keccak256, toBytes } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { synthChain, synthReport } from './helpers/snp-synth.mjs';
import { memoryCollateral } from '../verifier/collateral.mjs';
import { TCB_FLOORS } from '../verifier/metal-box.mjs';
import { providerChainAuthority } from '../network/wg-provider/attested-authority.mjs';
import { createAttestedSubmitter, parseSendRecord } from '../network/wg-provider/attested-submission.mjs';
import { connectivityQualificationABI, signOnchainQualification, submitAttestations, ensureHost } from '../network/onchain-qualification.mjs';

const { RUNTIME_BIN_DIR, RIG_RETH_BIN, RIG_RETH_GENESIS, RELAY_CONSUMER_TREE } = process.env;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = RELAY_CONSUMER_TREE ? path.join(RELAY_CONSUMER_TREE, 'test/helpers/verifier-runtime.mjs') : null;
const missing = (!RUNTIME_BIN_DIR && 'RUNTIME_BIN_DIR not set') || (!RIG_RETH_BIN && 'RIG_RETH_BIN not set') || (!RIG_RETH_GENESIS && 'RIG_RETH_GENESIS not set')
  || (!HELPER && 'RELAY_CONSUMER_TREE not set') || (!fs.existsSync(HELPER) && `${HELPER} missing`);
const T = { timeout: 900_000, skip: !process.env.REQUIRE_VERIFIER_E2E && missing };
if (process.env.REQUIRE_VERIFIER_E2E && missing) test('required artifacts', () => assert.fail(missing));

const MC = await import(pathToFileURL(path.join(REPO, 'test/fixtures/attested-guest-image.bundle.mjs')).href);
const { CONTRACTS } = await import(pathToFileURL(path.join(REPO, 'site/js/gen/contract-artifacts.js')).href);
const FX = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/credit-vault-independence-chain.json'), 'utf8'));
const CONN_ABI = JSON.parse(fs.readFileSync(path.join(REPO, 'contracts/EnclaveConnectivity.abi.json'), 'utf8'));
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || process.env.TMPDIR || os.tmpdir(), 'paid-helios-'));
const servers = [];
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => { servers.push(s); r(s.address().port); }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const K = { deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', operator: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  submitter: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' };
const ACC = Object.fromEntries(Object.entries(K).map(([k, v]) => [k, privateKeyToAccount(v)]));
const CHECKER = privateKeyToAccount(generatePrivateKey());          // signs attestations only (no ETH needed)
const PUBLIC_ADDRESS = '203.0.114.9', ENDPOINT = 'https://paid-helios-host.example';

// ---- the verifier-only guest (image lineage) in front of the REAL runtime, as test/attested-paid-provider.test.mjs builds it
const SIGNER = '0x' + '9a'.repeat(20);
const RAW = () => ({ format: MC.CONFIG_FORMAT, chainId: 8453,
  contracts: { registry: a(0x11), deployments: a(0x12), appCatalog: a(0x13), proofOfTime: a(0x14), enclavePay: a(0), verificationFees: a(0), sessionVaultFactory: a(0), secretVaultV2: a(0) },
  profileDigest: null, rpcs: ['https://rpc-a.example/v1', 'https://rpc-b.example'], quorum: 2, releaseId: 'ab'.repeat(32),
  replicas: { gateways: ['http://192.0.2.10:8189', 'https://replica.example'], storagePlan: null },
  identity: { publicUrl: 'https://verifier.example.org', repo: 'owner/enclave', operator: privateKeyToAccount(generatePrivateKey()).address.toLowerCase() },
  selling: { cpuPrice6: null, payout: null }, isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096' }, hostAdmissionSha256: null, controlPort: 8444,
  chainVerifier: { format: 'enclave-chain-verifier/v1', unsafeSigner: SIGNER, proofSources: ['http://10.0.2.2:28545/'], port: 50546, expose: 'attested' } });
const S = synthChain();
const COL = memoryCollateral({ chains: { Genoa: S.chainPem }, vceks: { Genoa: S.vcekDer }, crls: { Genoa: S.crlDer } });
const ROOTS = new Map([['Genoa', S.arkFp]]), MEAS = '77'.repeat(48);
async function guest(verifierPort) {
  const d = path.join(TMP, 'guest'); fs.mkdirSync(d);
  const P = { ...MC.GUEST_PATHS, runDir: d, pins: path.join(d, 'pins.json'), sessionDir: path.join(d, 'session'), statement: path.join(d, 'statement.json'), tlsKey: path.join(d, 'tls-key.pem'), tlsCert: path.join(d, 'tls-cert.pem') };
  const keys = MC.mintControlKeys({ paths: P }), raw = RAW();
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
  const cfgFile = path.join(TMP, 'replica.json'); fs.writeFileSync(cfgFile, JSON.stringify(raw));
  return { url: `https://127.0.0.1:${port}`, cfgFile };
}

// a loopback recorder in front of the REAL verifier: every method and its params (what the pinned Helios was asked)
async function recorder(target) {
  const calls = [];
  const s = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', async () => {
    const body = Buffer.concat(c).toString(); let q = null; try { q = JSON.parse(body); } catch {}
    try { const r = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch {}
      calls.push({ method: q?.method, params: q?.params, ok: !!j && !j.error, error: j?.error?.message ?? null });
      res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(text); }
    catch (e) { calls.push({ method: q?.method, params: q?.params, ok: false, error: String(e.message) }); res.writeHead(502); res.end(String(e.message)); }
  }); });
  return { port: await listen(s), calls };
}
// the own backend: reth behind a fault/recording proxy (faults as in the synthetic suite)
async function backendProxy(target) {
  const state = { fault: null, hold: null, methods: [], raws: [] };
  const s = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', async () => {
    const q = JSON.parse(Buffer.concat(c).toString()), m = q.method;
    state.methods.push(m === 'eth_getTransactionCount' ? `${m}(${q.params?.[1]})` : m);
    if (m === 'eth_sendRawTransaction') { state.raws.push(q.params[0]); if (state.fault === 'swallow') return req.socket.destroy(); if (state.hold) await state.hold; }
    const r = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(q) }); const j = await r.json();
    if (m === 'eth_sendRawTransaction' && state.fault === 'drop-response') return req.socket.destroy();
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j));
  }); });
  return { url: `http://127.0.0.1:${await listen(s)}/`, state };
}

let reth, rt, proof, W;
test.before(async () => {
  if (T.skip) return;
  const g = JSON.parse(fs.readFileSync(RIG_RETH_GENESIS, 'utf8'));
  g.baseFeePerGas = '0x989680';                                  // Base-like fees (0.01 gwei), as relay-sponsor-verifier does
  const genesis = path.join(TMP, 'genesis.json'); fs.writeFileSync(genesis, JSON.stringify(g));
  const port = await freePort();
  reth = spawn(RIG_RETH_BIN, ['node', '--dev', '--dev.block-time', '2s', '--chain', genesis, '--datadir', path.join(TMP, 'reth'), '--http', '--http.addr', '127.0.0.1',
    '--http.port', String(port), '--http.api', 'eth,net,web3', '--disable-discovery', '--ipcdisable', '--port', '0', '--authrpc.port', String(await freePort()),
    '--rpc.eth-proof-window', '1024'], { stdio: 'ignore' });
  const rethUrl = `http://127.0.0.1:${port}`;
  const pub = createPublicClient({ chain: base, transport: viemHttp(rethUrl) });
  for (let i = 0; i < 600; i++) { try { await pub.getBlockNumber(); break; } catch { await sleep(200); } }
  const wc = (who) => createWalletClient({ chain: base, account: ACC[who], transport: viemHttp(rethUrl) });
  const mined = async (hash) => { const r = await pub.waitForTransactionReceipt({ hash }); assert.equal(r.status, 'success'); return r; };
  const deploy = async (abi, bytecode, args = []) => (await mined(await wc('deployer').deployContract({ abi, bytecode, args }))).contractAddress.toLowerCase();
  const registry = await deploy(FX.EnclaveRegistry.abi, FX.EnclaveRegistry.bytecode);
  // STAND-IN ledger: answers registry() (any call) with the registry's address - see the header
  const runtime = '73' + registry.slice(2) + '60005260206000f3', init = '0x61' + (runtime.length / 2).toString(16).padStart(4, '0') + '80600c6000396000f3' + runtime;
  const ledger = (await mined(await wc('deployer').sendTransaction({ data: init }))).contractAddress.toLowerCase();
  const conn = await deploy(CONN_ABI, CONTRACTS.EnclaveConnectivity.bytecode, [ledger, [CHECKER.address]]);
  const register = async () => mined(await wc('operator').writeContract({ address: registry, abi: FX.EnclaveRegistry.abi, functionName: 'register', args: [ENDPOINT, 'owner/enclave', '0x' + '00'.repeat(32), 1n, 0n, a(0)] }));
  await register();
  const hostId = keccak256(toBytes(ENDPOINT));
  // the REAL verifier runtime (relay-consumer-source's helper, read-only) and the attested channel to it
  const { launchVerifierRuntime, startProofSource } = await import(pathToFileURL(HELPER).href);
  proof = await startProofSource(rethUrl);
  rt = launchVerifierRuntime({ chainRpc: rethUrl, proofSources: [proof.url], port: await freePort(), dir: path.join(TMP, 'runtime') });
  await rt.ready();
  const vrec = await recorder(rt.url), backend = await backendProxy(rethUrl), gst = await guest(vrec.port);
  const caps = { maxFeePerGasWei: '1000000000', maxPriorityFeePerGasWei: '100000000' };
  const auth = providerChainAuthority({ chainAuthority: 'attested-verifier', pricePerGiB6: 1000, txBackend: { url: backend.url, ...caps },
    attestedVerifier: { unsafeSigner: SIGNER, replicas: [{ url: gst.url, configFile: gst.cfgFile, measurements: [MEAS], minTcb: TCB_FLOORS }], collateral: { dir: TMP } } },
  { testRoots: ROOTS, collateral: COL });
  const signs = [];
  const counted = (acct) => ({ ...acct, signTransaction: async (tx, o) => { signs.push(tx); return acct.signTransaction(tx, o); } });
  let n = 0;
  const submitter = ({ account = counted(ACC.operator), file = path.join(TMP, `send-${++n}.json`) } = {}) =>
    ({ file, s: createAttestedSubmitter({ verifier: auth.verifier, backend: auth.txBackend, account, stateFile: file, receiptPollMs: 500, timeoutMs: 30_000 }) });
  // the real verifier follows reth's head only after its listener commits; wait until the attested channel serves the contract
  const s0 = submitter().s;
  for (let i = 0; ; i++) {
    try { await s0.client.readContract({ address: conn, abi: connectivityQualificationABI, functionName: 'hosts', args: [hostId] }); break; }
    catch (e) { if (i > 240) throw new Error('the real verifier never served the contract: ' + e.message + '\n' + rt.out().slice(-1500)); await sleep(500); }
  }
  const attestation = async (skewMs = 0) => signOnchainQualification({ account: CHECKER, client: pub, connectivity: conn, record: { kind: 'community', hostId, address: PUBLIC_ADDRESS }, now: Date.now() + skewMs });
  W = { pub, wc, registry, conn, hostId, register, mined, auth, backend, vrec, signs, counted, submitter, attestation };
});
test.after(async () => {
  try { W?.auth.verifier.close(); } catch {}
  for (const s of servers) try { s.closeAllConnections?.(); s.close(); } catch {}
  try { rt?.stop(); } catch {}
  try { proof?.srv?.close(); } catch {}
  if (reth && reth.exitCode === null) { reth.kill('SIGTERM'); await Promise.race([new Promise((r) => reth.once('exit', r)), sleep(15000)]); try { reth.kill('SIGKILL'); } catch {} }
  for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) { try { if (fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(TMP)) process.kill(Number(pid), 'SIGKILL'); } catch {} }
  fs.rmSync(TMP, { recursive: true, force: true });
});
const recordOf = (f) => (fs.existsSync(f) ? parseSendRecord(fs.readFileSync(f, 'utf8'), f) : null);
const hostsOf = (s) => s.client.readContract({ address: W.conn, abi: connectivityQualificationABI, functionName: 'hosts', args: [W.hostId] });

test('REAL pinned Helios behind the attested route: setHost + qualify confirmed by the real verifier; reads match the node; exact call parameters accepted', T, async () => {
  const { s, file } = W.submitter();
  assert.equal(await ensureHost({ wallet: s.wallet, client: s.client, connectivity: W.conn, hostId: W.hostId, pricePerGiB6: 1000 }), true);
  assert.equal(await ensureHost({ wallet: s.wallet, client: s.client, connectivity: W.conn, hostId: W.hostId, pricePerGiB6: 1000 }), false, 'no resend once the verified state matches');
  const att = await W.attestation();
  assert.equal(await submitAttestations({ wallet: s.wallet, client: s.client, connectivity: W.conn, hostId: W.hostId, address: PUBLIC_ADDRESS, attestations: [att] }), 1);
  assert.equal(await submitAttestations({ wallet: s.wallet, client: s.client, connectivity: W.conn, hostId: W.hostId, address: PUBLIC_ADDRESS, attestations: [att] }), 0);
  assert.equal(recordOf(file), null);
  // ABI / shape parity with the node (test check: direct reth reads) for the same calls
  for (const q of [{ functionName: 'hosts', args: [W.hostId] }, { functionName: 'attestations', args: [W.hostId, CHECKER.address] }, { functionName: 'ledger', args: [] },
    { functionName: 'qualificationDigest', args: [att.hostId, att.addressHash, BigInt(att.issuedAt), BigInt(att.expires), att.checks] }]) {
    const x = { address: W.conn, abi: connectivityQualificationABI, ...q };
    assert.deepEqual(await s.client.readContract(x), await W.pub.readContract(x), q.functionName);
  }
  const last = keccak256(W.backend.state.raws.at(-1));
  const rc = await s.client.waitForTransactionReceipt({ hash: last, timeout: 30_000 }), vr = await W.pub.getTransactionReceipt({ hash: last });
  assert.equal(rc.status, 'success'); assert.equal(rc.blockHash, vr.blockHash.toLowerCase()); assert.equal(rc.blockNumber, vr.blockNumber); assert.equal(rc.gasUsed, vr.gasUsed);
  assert.equal(rc.evidence.authority, 'attested-verifier'); assert.equal(rc.evidence.localProof, false);
  // what the REAL verifier was asked, with which parameter shapes, and that it answered (reported in the result)
  const C = W.vrec.calls, by = (m) => C.filter((c) => c.method === m);
  const pinnedOk = (m) => by(m).some((c) => c.ok && c.params?.at(-1)?.blockHash && /^0x[0-9a-f]{64}$/.test(c.params.at(-1).blockHash));
  for (const m of ['eth_call', 'eth_getTransactionCount', 'eth_getBalance']) assert.ok(pinnedOk(m), `${m} at {blockHash} answered by the real verifier`);
  assert.ok(by('eth_estimateGas').some((c) => c.ok && /^0x[0-9a-f]+$/.test(String(c.params?.[1]))), 'eth_estimateGas at a numbered block answered');
  assert.ok(by('eth_getTransactionReceipt').some((c) => c.ok), 'a receipt by hash answered');
  assert.ok(by('eth_getBlockByNumber').some((c) => c.ok && c.params?.[1] === false), 'a numbered header answered');
  report('flow');
  assert.deepEqual(W.backend.state.methods.filter((m) => !['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionCount(pending)', 'eth_maxPriorityFeePerGas', 'eth_sendRawTransaction'].includes(m)), [], 'the own backend: hints and submission only');
});
// what the REAL verifier answered so far, per method and parameter shape (printed by every test, also when it fails)
function report(label) {
  const summary = {};
  for (const c of W.vrec.calls) { const k = `${c.method}(${(c.params || []).map((p) => (p && typeof p === 'object' ? Object.keys(p).sort().join('+') : /^0x[0-9a-f]{64}$/i.test(String(p)) ? 'hash' : /^0x[0-9a-f]{40}$/i.test(String(p)) ? 'address' : /^0x/.test(String(p)) ? 'qty' : String(p))).join(',')})`;
    summary[k] ||= { ok: 0, err: 0, errors: [] }; summary[k][c.ok ? 'ok' : 'err']++; if (!c.ok && summary[k].errors.length < 2) summary[k].errors.push(String(c.error).slice(0, 120)); }
  console.log(`REAL-VERIFIER-CALLS ${label} ` + JSON.stringify(summary));
}

test('REAL pinned Helios: a lost broadcast reply resolves only by the real verifier\'s receipt; a consumed nonce is "not landed", and the verified state shows it', T, async () => {
  try { await lostAndConsumed(); } finally { report('lost+nonce'); }
});
async function lostAndConsumed() {
  const file = path.join(TMP, 'lost.json'), signs = W.signs.length;
  const s1 = W.submitter({ file }).s;
  W.backend.state.fault = 'drop-response';
  const hash = await s1.wallet.writeContract({ address: W.conn, abi: connectivityQualificationABI, functionName: 'setHost', args: [W.hostId, false, true, 2000n] });
  W.backend.state.fault = null;
  assert.equal(recordOf(file).hash, hash);
  const s2 = W.submitter({ file }).s;                               // restart
  let r;
  for (let i = 0; ; i++) { try { r = await s2.settle(); break; } catch (e) { assert.equal(e.code, 'tx_unresolved', e.message); if (i > 60) throw e; await sleep(1000); } }
  assert.equal(r.state, 'receipt'); assert.equal(r.receipt.status, 'success'); assert.equal(recordOf(file), null);
  assert.equal((await hostsOf(s2))[2], 2000n); assert.equal(W.signs.length - signs, 1, 'one signature');
  // a swallowed send whose nonce another operator transaction consumes
  W.backend.state.fault = 'swallow';
  await s2.wallet.writeContract({ address: W.conn, abi: connectivityQualificationABI, functionName: 'setHost', args: [W.hostId, false, true, 3000n] });
  W.backend.state.fault = null;
  const rec = recordOf(file);
  await W.mined(await W.wc('operator').sendTransaction({ to: ACC.operator.address, value: 0n, nonce: rec.nonce }));
  for (let i = 0; ; i++) { try { r = await s2.settle(); if (r.state !== 'unresolved') break; } catch (e) { if (e.code !== 'tx_unresolved' || i > 60) throw e; } await sleep(1000); }
  assert.equal(r.state, 'nonce-consumed'); assert.equal(recordOf(file), null);
  assert.equal((await hostsOf(s2))[2], 2000n, 'the verified price is unchanged: the consumed nonce is not a landed send');
}

test('REAL pinned Helios: a VERIFIED REVERTED receipt (qualify simulated while the host was active; deregistered before inclusion)', T, async () => {
  const file = path.join(TMP, 'revert.json');
  const { s } = W.submitter({ account: W.counted(ACC.submitter), file });      // anyone may submit a checker's attestation
  const att = await W.attestation(5_000);
  let release; W.backend.state.hold = new Promise((r) => { release = r; });  // the own backend holds the bytes...
  const raws = W.backend.state.raws.length;
  const p = submitAttestations({ wallet: s.wallet, client: s.client, connectivity: W.conn, hostId: W.hostId, address: PUBLIC_ADDRESS, attestations: [att] });
  p.catch(() => {});
  for (let i = 0; W.backend.state.raws.length === raws; i++) { if (i > 600) throw new Error('nothing submitted'); await sleep(50); }
  // ...while the host's operator deregisters it (the registry ban); only then do the bytes reach the node
  await W.mined(await W.wc('operator').writeContract({ address: W.registry, abi: FX.EnclaveRegistry.abi, functionName: 'deregister', args: [W.hostId] }));
  W.backend.state.hold = null; release();
  await assert.rejects(p, /qualify reverted/);
  const hash = keccak256(W.backend.state.raws.at(-1));
  const rc = await s.client.waitForTransactionReceipt({ hash, timeout: 30_000 });
  assert.equal(rc.status, 'reverted'); assert.equal(rc.evidence.authority, 'attested-verifier');
  assert.equal((await W.pub.getTransactionReceipt({ hash })).status, 'reverted', 'test check: the node agrees');
  assert.equal(recordOf(file), null);
  await W.register();
  report('reverted');
});
