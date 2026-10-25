// The attested chain verifier composed into the ROUTE provider (network/wg-provider/main.mjs + attested-authority.mjs):
// ONE attested client for every chain read of the provider - the host-services admission policy (anchor, current owner,
// ban/unban, sequence/rollback, persisted state), registry/app/owner reads (EOA, ERC-1271, SessionVault) - with no public RPC,
// no mixed config and no fallback.
// What runs here, and what it proves:
//   * the provider modules, the client, the readers, the policy runtime and gate (network/platform-host-policy.mjs) are the
//     ACTUAL route source; the guest side (control front, statement, config canonicalization) is the IMAGE lineage's code from
//     test/fixtures/attested-guest-image.bundle.mjs (scripts/build-attested-guest-verify.mjs, pinned to its image commit);
//   * SEV-SNP evidence is SYNTHETIC (test/helpers/snp-synth.mjs; the real AMD pin refuses it) through verifier/snp.mjs UNCHANGED;
//   * the verifier is test/helpers/loopback-verifier.mjs: the verifier protocol and refusals with NO Merkle (MPT) proof checks;
//   * the policy chain is the scripted platform policy world (book, registry, ownership facts; admin-signed documents); the
//     ERC-1271 owner, SessionVault and factory are minimal hand-assembled contracts on a real anvil with the exact call shapes;
//   * the supervisor behind the guest front is a stand-in serving only the minted keys (the REAL supervisor's verifier-only
//     boot is covered in the image lineage, e0dfe98aa test/attested-chain-verifier.test.mjs).
// Nothing leaves 127.0.0.1.
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
import { createWalletClient, createPublicClient, http as viemHttp, hashMessage, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { synthChain, synthReport } from './helpers/snp-synth.mjs';
import { startLoopbackVerifier } from './helpers/loopback-verifier.mjs';
import { platformPolicyWorld, BOOK, OWNERSHIP } from './helpers/platform-policy-world.mjs';
import { memoryCollateral } from '../verifier/collateral.mjs';
import { TCB_FLOORS } from '../verifier/metal-box.mjs';
import { createAttestedVerifier } from '../network/attested-verifier-client.mjs';
import { isAttestedVerifier } from '../network/attested-verifier-brand.mjs';
import { providerChainAuthority, providerHostPolicyRuntime, providerCollateral } from '../network/wg-provider/attested-authority.mjs';
import { providerHostServices } from '../network/wg-provider/host-services-config.mjs';
import { LeaseReader } from '../network/lease-reader.mjs';
import { verifyOwnerSignature } from '../network/owner-signature.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MC = await import(pathToFileURL(path.join(REPO, 'test/fixtures/attested-guest-image.bundle.mjs')).href);
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'attested-route-'));
const servers = [], children = [];
after(() => { for (const s of servers) { try { s.closeAllConnections?.(); s.close(); } catch {} } for (const c of children) try { c.kill('SIGKILL'); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const listen = (s, port = 0) => new Promise((r) => s.listen(port, '127.0.0.1', () => { servers.push(s); r(s.address().port); }));
const a = (n) => '0x' + n.toString(16).padStart(40, '0');

// ---- the verifier-only guest config (image lineage) ------------------------------------------------------------------------
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
/** A verifier-only guest stand-in: the image lineage's control front with minted keys, its statement over the bound config,
 *  a synthetic SNP reporter (chain `chain`), the minted-keys supervisor stand-in, and the filtered route to `verifierPort`. */
async function guest({ verifierPort, chain = S }) {
  const P = guestPaths(), keys = MC.mintControlKeys({ paths: P }), raw = RAW();
  const cfg = MC.canonicalDirectConfig(raw), digest = MC.configDigest(cfg), hostData = MC.hostDataHex(digest);
  const st = MC.controlStatement({ config: cfg, digest, hostData, mode: 'snp', keys });
  const sup = http.createServer((req, res) => {
    if (req.url !== '/v1/attestation') { res.writeHead(404); return res.end(); }
    const b = Buffer.from(JSON.stringify({ proofKey: { address: MC.addressOfPublicKey(st.obj.keys.proof.publicKey, viem.keccak256) }, sessionKey: { kid: MC.jwkThumbprint(st.obj.keys.session) } }));
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': b.length }); res.end(b); });
  const supPort = await listen(sup);
  const reporter = async (reportData) => ({ report: synthReport(chain, { reportData, hostData: Buffer.from(hostData, 'hex') }), certs: null });
  const front = MC.createControlFront({ statementText: st.text, keyPem: fs.readFileSync(P.tlsKey, 'utf8'), certPem: keys.controlTls.certPem, reporter, mode: 'snp',
    upstream: { host: '127.0.0.1', port: supPort }, routes: [{ path: MC.CHAIN_VERIFIER_ROUTE, upstream: { host: '127.0.0.1', port: verifierPort }, rewrite: '/', jsonrpc: MC.JSONRPC_FILTER }] });
  const port = await listen(front);
  return { url: `https://127.0.0.1:${port}`, raw };
}
function attestedCfg(g, over = {}) {
  const cfgFile = path.join(tmp, `replica-${randomBytes(4).toString('hex')}.json`); fs.writeFileSync(cfgFile, JSON.stringify(g.raw));
  return { chainAuthority: 'attested-verifier', attestedVerifier: { unsafeSigner: SIGNER, replicas: [{ url: g.url, configFile: cfgFile, measurements: [MEAS], minTcb: TCB_FLOORS }], collateral: { dir: tmp } }, ...over };
}

test('the provider authority is ONE explicit choice: the quorum is unchanged; mixed, paid, root-naming and policy-RPC configs refuse', async () => {
  const q = providerChainAuthority({ rpc: ['https://a.example', 'https://b.example'] });
  assert.equal(q.mode, 'quorum'); assert.deepEqual(q.leaseReaderOptions, {}); assert.equal(q.rpc.length, 2);
  assert.throws(() => providerChainAuthority({}), /two or more RPC endpoints required/);
  assert.throws(() => providerChainAuthority({ rpc: ['https://a.example', 'https://b.example'], chainAuthority: 'verifier' }), /quorum or attested-verifier/);
  const lv = await startLoopbackVerifier({ upstream: 'http://127.0.0.1:1' }); after(() => lv.close());
  const g = await guest({ verifierPort: Number(new URL(lv.url).port) });
  const c = attestedCfg(g);
  for (const [over, re] of [[{ rpc: ['https://a.example', 'https://b.example'] }, /rpc is not used/], [{ chainVerifier: 'http://127.0.0.1:1/' }, /chainVerifier is not used/],
    [{ pricePerGiB6: 5 }, /paid provider is not supported/],
    [{ attestedVerifier: { ...c.attestedVerifier, roots: [] } }, /unknown field roots/],
    [{ attestedVerifier: { ...c.attestedVerifier, replicas: [{ ...c.attestedVerifier.replicas[0], status: 'attested' }] } }, /trust roots and statuses are never configured/],
    [{ attestedVerifier: { ...c.attestedVerifier, replicas: [{ ...c.attestedVerifier.replicas[0], configFile: 'r.json' }] } }, /absolute path/],
    [{ attestedVerifier: { ...c.attestedVerifier, collateral: { dir: 'amd' } } }, /collateral\.dir must be an absolute path/]])
    assert.throws(() => providerChainAuthority({ ...c, ...over }), re, JSON.stringify(over).slice(0, 80));
  assert.throws(() => providerChainAuthority({ rpc: ['https://a.example', 'https://b.example'], attestedVerifier: c.attestedVerifier }), /chainAuthority is not "attested-verifier"/);
  const auth = providerChainAuthority(c, { testRoots: ROOTS, collateral: COL });
  assert.equal(auth.mode, 'attested-verifier'); assert.equal(auth.rpc.length, 0, 'no raw RPC client exists');
  const hs = (extra) => providerHostServices({ zone: 'app.enclave.host', platformHostPolicy: { book: BOOK, hostOwnership: OWNERSHIP, mirrors: ['https://mirror.example/policy'] }, ...extra }, { roles: ['ingress'] });
  assert.throws(() => providerHostPolicyRuntime(hs({ platformHostPolicyRpcs: ['https://a.example', 'https://b.example'] }), auth, { stateDir: tmp }), /platformHostPolicyRpcs is not used/);
  assert.throws(() => providerHostPolicyRuntime(providerHostServices({ zone: 'app.enclave.host', platformHostPolicy: { book: BOOK, hostOwnership: OWNERSHIP, mirrors: [], rpcs: ['https://a.example', 'https://b.example'] } }, { roles: ['ingress'] }), auth, { stateDir: tmp }),
    /names its own RPCs or chain authority/);
  assert.throws(() => providerHostPolicyRuntime(providerHostServices({ zone: 'app.enclave.host', platformHostPolicy: { book: BOOK, hostOwnership: OWNERSHIP, mirrors: [], chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:1/' } }, { roles: ['ingress'] }), auth, { stateDir: tmp }),
    /names its own RPCs or chain authority/);
  assert.equal(providerHostPolicyRuntime(providerHostServices({ zone: 'app.enclave.host', platformHostPolicy: 'off' }, { roles: ['ingress'] }), auth, { stateDir: tmp }), null, '"off" stays the explicit development switch');
  auth.verifier.close();
});

test('host-services ADMISSION through the attested verifier, every public provider down: admit, ban, unban, owner rotation, rollback; outage never falls back', { timeout: 120000 }, async () => {
  const RUNNER = viem.keccak256(viem.toBytes('https://host.policy.example')).toLowerCase(), OPERATOR_H = '0x' + '44'.repeat(20);
  const w = await platformPolicyWorld({ after }, { hosts: { [RUNNER]: { endpoint: 'https://host.policy.example', operator: OPERATOR_H, owner: '0x' + '55'.repeat(20), active: true } } });
  const lv = await startLoopbackVerifier({ upstream: w.node }); after(() => lv.close());
  const g = await guest({ verifierPort: Number(new URL(lv.url).port) });
  const auth = providerChainAuthority(attestedCfg(g), { testRoots: ROOTS, collateral: COL });
  const hs = providerHostServices({ zone: 'app.enclave.host', platformHostPolicy: { book: BOOK, hostOwnership: OWNERSHIP, mirrors: [w.mirrorOrigin] } }, { roles: ['ingress'] });
  // the mirror is untrusted transport for admin-SIGNED documents: served here without its throwaway CA (the gate verifies them)
  const docFetch = async (url) => { const m = /\/(0x[0-9a-f]{64})\.json$/.exec(String(url)); const d = m && w.document(m[1]);
    return d ? new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('', { status: 404 }); };
  const stateDir = fs.mkdtempSync(path.join(tmp, 'hs-')), rt = providerHostPolicyRuntime(hs, auth, { stateDir, fetch: docFetch, ttlMs: 0 });   // no decision cache between steps (the production default is 30 s)
  const admit = async () => { try { return (await rt.admissions([RUNNER]))[RUNNER]; } catch (e) { return { admit: null, reason: `read failed: ${e.message}` }; } };
  w.setDown(true); const hits0 = w.publicHits();
  const ban = [{ kind: 'operator', value: OPERATOR_H, reason: 'abuse' }];
  await w.publish({ deny: [] });
  let d = await admit(); assert.equal(d?.admit, true, JSON.stringify(d));
  assert.ok(lv.state.calls.some((c) => c.method === 'eth_call' && c.to === BOOK.toLowerCase()), 'the book was read through the attested verifier');
  await w.publish({ deny: ban }); d = await admit(); assert.equal(d?.admit, false, `the admin's ban refuses: ${JSON.stringify(d)}`);
  const unban = await w.publish({ deny: [] }); d = await admit(); assert.equal(d?.admit, true, 'the unban admits');
  const { prev } = w.rotateOwner();
  await w.publish({ deny: ban, signer: prev }); d = await admit(); assert.notEqual(d?.admit, true, 'a document the PREVIOUS owner signed and anchored never admits');
  await w.publish({ deny: ban }); d = await admit(); assert.equal(d?.admit, false, 'the current owner\'s ban refuses');
  const last = await w.publish({ deny: [] }); d = await admit(); assert.equal(d?.admit, true, 'the current owner\'s unban admits');
  w.anchor(unban); d = await admit(); assert.notEqual(d?.admit, true, `an anchored ROLLBACK to an older sequence is refused: ${JSON.stringify(d)}`);
  w.anchor(last); d = await admit(); assert.equal(d?.admit, true);
  assert.equal(w.publicHits(), hits0, 'no public provider was asked while they were down');
  w.setDown(false); const hits1 = w.publicHits();
  lv.state.fault = 'down'; d = await admit(); assert.notEqual(d?.admit, true, 'the verifier is down: no admit');
  lv.state.fault = 'proof'; d = await admit(); assert.notEqual(d?.admit, true, 'a failed proof: no admit');
  assert.equal(w.publicHits(), hits1, 'zero public-provider requests during the verifier outage: no fallback');
  lv.state.fault = null; d = await admit(); assert.equal(d?.admit, true, 'recovered through the attested verifier');
  auth.verifier.close();
});

// ERC-1271 owner, SessionVault and its factory: minimal real contracts on anvil with the exact call shapes owner-signature.mjs uses
const word = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const init = (runtime) => { const n = runtime.length / 2; return '0x61' + n.toString(16).padStart(4, '0') + '80600c6000396000f3' + runtime; };
const erc1271 = (H) => '600435' + '7f' + word(H) + '14' + '603857' + '63ffffffff60e01b60005260206000f3' + '5b631626ba7e60e01b60005260206000f3';
const vaultOwner = (owner) => '73' + owner.slice(2) + '60005260206000f3';
const factoryIsVault = (vault) => '600435' + '73' + vault.slice(2) + '1460005260206000f3';
test('PARITY: the legacy QUORUM runtime and the attested runtime give the same decision at every step of one policy history', { timeout: 120000 }, async () => {
  const RUNNER = viem.keccak256(viem.toBytes('https://host.policy.example')).toLowerCase(), OPERATOR_H = '0x' + '44'.repeat(20);
  const w = await platformPolicyWorld({ after }, { hosts: { [RUNNER]: { endpoint: 'https://host.policy.example', operator: OPERATOR_H, owner: '0x' + '55'.repeat(20), active: true } } });
  const lv = await startLoopbackVerifier({ upstream: w.node }); after(() => lv.close());
  const g = await guest({ verifierPort: Number(new URL(lv.url).port) });
  const auth = providerChainAuthority(attestedCfg(g), { testRoots: ROOTS, collateral: COL });
  const hsA = providerHostServices({ zone: 'app.enclave.host', platformHostPolicy: { book: BOOK, hostOwnership: OWNERSHIP, mirrors: [w.mirrorOrigin] } }, { roles: ['ingress'] });
  const docFetch = async (url) => { const m = /\/(0x[0-9a-f]{64})\.json$/.exec(String(url)); const d = m && w.document(m[1]);
    return d ? new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('', { status: 404 }); };
  const rtA = providerHostPolicyRuntime(hsA, auth, { stateDir: fs.mkdtempSync(path.join(tmp, 'pa-')), fetch: docFetch, ttlMs: 0 });
  // the legacy twin: the SAME createHostPolicyRuntime over the world's own (loopback) RPC quorum - the earlier provider path
  const { createHostPolicyRuntime, fileStore } = await import('../network/host-policy-runtime.mjs');
  const { resolveHostPolicyConfig } = await import('../network/platform-host-policy-config.mjs');
  const rtQ = createHostPolicyRuntime(resolveHostPolicyConfig({ env: { ENCLAVE_PLATFORM_HOST_POLICY: JSON.stringify({ book: BOOK, hostOwnership: OWNERSHIP, mirrors: [w.mirrorOrigin] }),
    ENCLAVE_PLATFORM_HOST_POLICY_RPCS: w.rpcs.join(',') }, chainId: 8453 }), { store: fileStore(path.join(fs.mkdtempSync(path.join(tmp, 'pq-')), 'p.json')), fetch: docFetch, ttlMs: 0 });
  const one = async (rt) => { try { return (await rt.admissions([RUNNER]))[RUNNER]?.admit ?? null; } catch { return 'error'; } };
  const both = async () => [await one(rtA), await one(rtQ)];
  const ban = [{ kind: 'operator', value: OPERATOR_H, reason: 'abuse' }], steps = [];
  await w.publish({ deny: [] }); steps.push(['admit', await both()]);
  await w.publish({ deny: ban }); steps.push(['ban', await both()]);
  const unban = await w.publish({ deny: [] }); steps.push(['unban', await both()]);
  const { prev } = w.rotateOwner();
  await w.publish({ deny: ban, signer: prev }); steps.push(['previous-owner-doc', await both()]);
  await w.publish({ deny: ban }); steps.push(['current-owner-ban', await both()]);
  const last = await w.publish({ deny: [] }); steps.push(['current-owner-unban', await both()]);
  w.anchor(unban); steps.push(['rollback-anchor', await both()]);
  w.anchor(last); steps.push(['re-anchor', await both()]);
  console.log(`[parity] ${JSON.stringify(steps)}`);
  for (const [name, [att, quo]] of steps) assert.equal(att, quo, `step ${name}: attested ${att} vs quorum ${quo} (${JSON.stringify(steps)})`);
  auth.verifier.close();
});

test('registry/app/OWNER reads: the provider\'s reader (built as main.mjs builds it) verifies ERC-1271 and SessionVault owners through the attested verifier', { timeout: 120000 }, async () => {
  const port = await freePort();
  const anvil = spawn('anvil', ['--port', String(port), '--chain-id', '8453', '--silent', '--block-time', '1'], { stdio: 'ignore' }); children.push(anvil);
  const rpc = `http://127.0.0.1:${port}`, chain = defineChain({ id: 8453, name: 'anvil', nativeCurrency: { name: 'E', symbol: 'E', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pc = createPublicClient({ chain, transport: viemHttp(rpc) });
  for (let i = 0; i < 100; i++) { try { await pc.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  const wc = createWalletClient({ account: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'), chain, transport: viemHttp(rpc) });
  const deploy = async (runtime) => (await pc.waitForTransactionReceipt({ hash: await wc.sendTransaction({ data: init(runtime) }) })).contractAddress.toLowerCase();
  const message = 'enclave-network:policy:0x' + 'ab'.repeat(32), signature = '0x' + 'cd'.repeat(65);
  const passkey = await deploy(erc1271(hashMessage(message))), vault = await deploy(vaultOwner(passkey)), factory = await deploy(factoryIsVault(vault));
  const lv = await startLoopbackVerifier({ upstream: rpc }); after(() => lv.close());
  const g = await guest({ verifierPort: Number(new URL(lv.url).port) });
  const auth = providerChainAuthority(attestedCfg(g), { testRoots: ROOTS, collateral: COL });
  const leases = new LeaseReader({ addressBook: a(0xb0), includeHostPayout: true, ...auth.leaseReaderOptions });
  assert.equal(leases.authorityInfo().authority, 'attested-verifier'); assert.equal(leases.authorityInfo().localProof, false);
  const verifyOwner = (owner, msg, sig, sessionVaultFactory) => verifyOwnerSignature({ reader: leases, owner, message: msg, signature: sig, addressBook: a(0xb0), sessionVaultFactory });
  assert.equal(await verifyOwner(passkey, message, signature, a(0)), true, 'ERC-1271 owner');
  assert.equal(await verifyOwner(passkey, message + 'x', signature, a(0)), false);
  assert.equal(await verifyOwner(vault, message, signature, factory), true, 'SessionVault -> factory.isVault -> owner() -> ERC-1271');
  assert.equal(await verifyOwner(vault, message, signature, a(0x99)), false);
  assert.ok(lv.state.calls.some((c) => c.method === 'eth_call' && c.to === passkey) && lv.state.calls.some((c) => c.method === 'eth_call' && c.to === factory));
  lv.state.fault = 'proof'; assert.equal(await verifyOwner(passkey, message, signature, a(0)), false, 'a verifier refusal is "not the owner", never a fallback'); lv.state.fault = null;
  auth.verifier.close();
});

test('collateral PRE-SEED: the provider\'s file collateral attests fully; an EXPIRED pre-seeded CRL refuses (fail closed)', { timeout: 60000 }, async () => {
  const up = http.createServer((req, res) => { const c = []; req.on('data', (b) => c.push(b)); req.on('end', () => {
    let id = null; try { id = JSON.parse(Buffer.concat(c).toString()).id; } catch {}
    const b = JSON.stringify({ jsonrpc: '2.0', id, result: '0x2105' }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(b); }); });
  const upPort = await listen(up);
  // learn the exact VCEK key the verifier asks for (product, chip, tcb) from one attestation over a recording adapter
  const seen = [];
  const rec = (src) => ({ chain: (p) => src.chain(p), crl: (p) => src.crl(p), vcek: (p, chip, tcb) => { seen.push([p, chip, tcb]); return src.vcek(p, chip, tcb); } });
  const seed = (dir, chain) => { fs.mkdirSync(path.join(dir, 'amd'), { recursive: true }); fs.mkdirSync(path.join(dir, 'vcek'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'amd', 'Genoa-cert_chain.pem'), chain.chainPem); fs.writeFileSync(path.join(dir, 'amd', 'Genoa-crl.der'), chain.crlDer);
    for (const [p, chip, tcb] of seen) fs.writeFileSync(path.join(dir, 'vcek', `${p}-${chip}-${tcb}.der`), chain.vcekDer); };
  const g = await guest({ verifierPort: upPort });
  const probe = createAttestedVerifier({ allowTestRoots: true, replicas: [{ url: g.url, config: g.raw, measurements: [MEAS], minTcb: TCB_FLOORS, roots: ROOTS }], unsafeSigner: SIGNER,
    collateral: rec(COL) });
  await probe.attest(); probe.close();
  assert.ok(seen.length >= 1, 'the verifier asked for a VCEK');
  const dir = fs.mkdtempSync(path.join(tmp, 'seed-')); seed(dir, S);
  const c = attestedCfg(g); c.attestedVerifier.collateral = { dir };
  const ok = providerChainAuthority(c, { testRoots: ROOTS });          // the provider's OWN collateral: providerCollateral({dir})
  assert.deepEqual(await ok.verifier.attest(), [true], JSON.stringify(ok.verifier.status().replicas[0].reasons));
  ok.verifier.close();
  // an EXPIRED pre-seeded CRL: the same files judged at a clock past the CRL's nextUpdate (synthChain's CRL lasts 30 days)
  const expired = providerChainAuthority(c, { testRoots: ROOTS, verifyNow: () => new Date(Date.now() + 40 * 86400_000) });
  assert.deepEqual(await expired.verifier.attest(), [false]);
  const st = expired.verifier.status().replicas[0];
  assert.notEqual(st.status, 'attested'); assert.match(st.reasons.join(' '), /CRL|crl|nextUpdate|stale|expired|collateral/i, st.reasons.join(' | '));
  await assert.rejects(expired.verifier.request('eth_chainId', [], 5000), /no attested replica/);
  expired.verifier.close();
  assert.throws(() => providerCollateral({ dir: 'relative' }), /absolute path/); assert.throws(() => providerCollateral({ dir, kds: 'yes' }), /boolean/);
});

const run = (args, opts = {}) => new Promise((resolve) => execFile(process.execPath, args, { cwd: REPO, timeout: 60000, ...opts }, (e, so, se) => resolve({ code: e ? (e.code ?? 1) : 0, out: so + se })));
test('the PACKAGED provider: source entry and an esbuild bundle of wg-provider/main.mjs report the attested authority, refuse a mixed config, keep the quorum', { timeout: 120000 }, async () => {
  const lv = await startLoopbackVerifier({ upstream: 'http://127.0.0.1:1' }); after(() => lv.close());
  const g = await guest({ verifierPort: Number(new URL(lv.url).port) });
  const write = (name, cfg) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(cfg)); return f; };
  // the explicit bootstrap shape install.sh writes (service-index.test.mjs): the operator's own pins, directory and zones
  const base = { bootstrap: 'explicit', checkers: ['0x' + '44'.repeat(20)], directories: ['https://dir.alice-net.org'], zone: 'apps.alice-net.org', probeZone: 'probe.alice-net.org',
    publicAddress: '203.0.114.7', roles: ['exit'], authorityPins: { deployments: a(0x12), registry: a(0x11), connectivity: a(0), sessionVaultFactory: a(0) } };
  const att = write('p-att.json', { ...base, ...attestedCfg(g) }), mixed = write('p-mixed.json', { ...base, ...attestedCfg(g), rpc: ['https://a.example', 'https://b.example'] }),
    quorum = write('p-q.json', { ...base, rpc: ['https://a.example', 'https://b.example'] });
  const esbuild = await import('esbuild'), bundle = path.join(tmp, 'wg-provider.bundle.mjs');
  await esbuild.build({ entryPoints: [path.join(REPO, 'network/wg-provider/main.mjs')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    banner: { js: 'import {createRequire as __cr} from "node:module"; const require=__cr(import.meta.url);' } });
  const text = fs.readFileSync(bundle, 'utf8');
  assert.equal(text.split('enclave.attested-verifier.brand/v1').length, 2, 'one brand registry in the provider bundle');
  for (const entry of [path.join(REPO, 'network/wg-provider/main.mjs'), bundle]) {
    let r = await run([entry, '--check-config', att]);
    assert.equal(r.code, 0, r.out); assert.equal(JSON.parse(r.out.trim().split('\n').pop()).chainAuthority, 'attested-verifier', entry);
    r = await run([entry, '--check-config', mixed]); assert.notEqual(r.code, 0); assert.match(r.out, /rpc is not used with chainAuthority "attested-verifier"/);
    r = await run([entry, '--check-config', quorum]); assert.equal(r.code, 0, r.out); assert.equal(JSON.parse(r.out.trim().split('\n').pop()).chainAuthority, 'quorum');
  }
});

test('packaging: separately bundled reader and client share ONE brand; a plain object is never "attested"', async () => {
  const esbuild = await import('esbuild');
  const ea = path.join(tmp, 'ra.mjs'), eb = path.join(tmp, 'rb.mjs');
  fs.writeFileSync(ea, `export { LeaseReader } from ${JSON.stringify(path.join(REPO, 'network/lease-reader.mjs'))};\nexport { isAttestedVerifier } from ${JSON.stringify(path.join(REPO, 'network/attested-verifier-brand.mjs'))};\n`);
  fs.writeFileSync(eb, `export { createAttestedVerifier } from ${JSON.stringify(path.join(REPO, 'network/attested-verifier-client.mjs'))};\n`);
  const out = {};
  for (const [k, e] of [['a', ea], ['b', eb]]) { const f = path.join(tmp, `pkg-${k}.mjs`);
    await esbuild.build({ entryPoints: [e], outfile: f, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', banner: { js: 'import {createRequire as __cr} from "node:module"; const require=__cr(import.meta.url);' } });
    out[k] = await import(pathToFileURL(f).href); }
  const lv = await startLoopbackVerifier({ upstream: 'http://127.0.0.1:1' }); after(() => lv.close());
  const g = await guest({ verifierPort: Number(new URL(lv.url).port) });
  const c = out.b.createAttestedVerifier({ allowTestRoots: true, replicas: [{ url: g.url, config: g.raw, measurements: [MEAS], minTcb: TCB_FLOORS, roots: ROOTS }], unsafeSigner: SIGNER, collateral: COL });
  assert.equal(out.a.isAttestedVerifier(c), true);
  assert.equal(new out.a.LeaseReader({ addressBook: a(0xb0), authority: 'verifier', verifier: c }).authorityInfo().authority, 'attested-verifier');
  const fake = Object.freeze({ request: async () => '0x1', status: () => ({ authority: 'attested-verifier' }) });
  assert.equal(isAttestedVerifier(fake), false);
  assert.equal(new LeaseReader({ addressBook: a(0xb0), authority: 'verifier', verifier: fake }).authorityInfo().authority, 'local-verifier');
  c.close();
});
