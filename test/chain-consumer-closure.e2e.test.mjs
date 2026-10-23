// END-TO-END: the ACTUAL supervisor.js on the operator's explicitly selected local verifier (network/chain-authority.mjs),
// on A's canonical-trie reth --dev chain with the real ledger/registry/catalog, the REAL verifier runtime (network/rpc-runtime.mjs:
// the pinned Helios behind the witness gateway; the listener's `listen` is the reth stand-in, its commitment the real
// pinned listener) and an OWN transaction backend (a recording proxy in front of the same chain: the operator's own node).
// The supervisor runs under a preload that RECORDS and refuses every non-loopback origin (test/helpers/record-network-origins.mjs),
// and its BASE_RPC(S) point at a counting "provider" that must never be asked.
//   relay mode: claim, the claim receipt, renewal, the admin AddressBook migration, an owner veto, the admin's catalog
//   delisting, a proof-source outage (new actions refuse; the running app keeps serving; a restart adopts it), a lost
//   submission answer + restart (decided from the verified receipt; nothing sent twice);
//   direct mode: the supervisor started with the environment planDirectBoot derives for a bound chainVerifier.
// SYNTHETIC head authority (a TEST sequencer key). Not an SNP guest, not Base mainnet evidence, no real funds or keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { stringToHex, parseEventLogs, pad, parseTransaction } from 'viem';
import * as viem from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startRig, haveTools, KEYS, freePort, startActualHost } from './helpers/cli-independent-rig.mjs';
import { TOKEN, servableAppRef, getRow, login, api, sleep, waitFor, RELEASE_SELECTOR, releaseTxs } from './helpers/move-release-rig.mjs';
import { launchVerifierRuntime, startProofSource, seqSigner } from './helpers/verifier-runtime.mjs';
import { hostAdmissionPolicyHash } from '../network/host-admission-policy.mjs';
import * as MC from '../metal/guest/measured-control.mjs';

const { RUNTIME_BIN_DIR } = process.env;
const skip = haveTools() || (!RUNTIME_BIN_DIR && 'RUNTIME_BIN_DIR not set') || (process.env.RIG_CHAIN_NODE !== 'reth' && 'needs the canonical-trie rig (RIG_CHAIN_NODE=reth)');
const HERE = path.dirname(new URL(import.meta.url).pathname), REPO = path.resolve(HERE, '..');
const RECORD = path.join(HERE, 'helpers', 'record-network-origins.mjs');
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'chain-consumer-'));
const OUT = path.join(REPO, 'contracts/foundry/out');
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, `${name}.json`), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const lc = (s) => String(s).toLowerCase();
let rig, rt, proof, providers, backend, book, bookAbi, own, ownAbi, appRef, live = [];
const hosts = [];

async function rpc(url, method, params = [], ms = 30000) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
/** "public providers": answers nothing; every request is a failure of the test */
function startProviders() {
  const st = { hits: [] };
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { st.hits.push(b.slice(0, 200)); res.writeHead(503); res.end(); }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, st, url: `http://127.0.0.1:${srv.address().port}` })));
}
/** the operator's OWN backend: a recording proxy in front of the chain. mode: ok | down | lose-next-release (the next
 *  release() submission REACHES the chain, and its answer is lost) */
function startBackend() {
  const st = { mode: 'ok', calls: [], sends: [] };
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    let q; try { q = JSON.parse(b); } catch { res.writeHead(400); return res.end(); }
    for (const m of [q].flat()) st.calls.push(m.method);
    if (st.mode === 'down') { res.writeHead(503); return res.end(); }
    const sends = [q].flat().filter((m) => m.method === 'eth_sendRawTransaction');
    for (const m of sends) { let tx = null; try { tx = parseTransaction(m.params[0]); } catch {} st.sends.push({ at: Date.now(), to: lc(tx?.to || ''), selector: String(tx?.data || '').slice(0, 10), nonce: tx?.nonce }); }
    const up = await fetch(rig.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b });
    const text = await up.text();
    if (st.mode === 'lose-next-release' && st.sends.slice(-sends.length).some((x) => x.selector === RELEASE_SELECTOR)) { st.mode = 'ok'; st.lost = (st.lost || 0) + 1; res.writeHead(502); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(text);
  }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, st, url: `http://127.0.0.1:${srv.address().port}/` })));
}
const untilV = (n, ms = 90000) => waitFor(async () => BigInt(await rpc(rt.url, 'eth_blockNumber', [], 5000)) >= BigInt(n), ms, `verifier at block ${n}`);
const ledgerEvents = async (from, id) => parseEventLogs({ abi: rig.A.ledger.abi, logs: await rig.pc.getLogs({ address: rig.addresses.ledger, fromBlock: from, toBlock: 'latest' }) })
  .filter((e) => !id || lc(e.args.id) === lc(id));
async function fundedDeployment() {
  const id = rig.createdId(await rig.write(rig.wc(KEYS.owner), rig.addresses.ledger, rig.A.ledger.abi, 'create',
    [appRef, 0, 100, 3000, 'http:3000', true, '', '0x0000000000000000000000000000000000000000', 0n, 100000n]));
  await rig.write(rig.wc(KEYS.owner), rig.addresses.usdc, rig.A.usdc.abi, 'approve', [rig.addresses.ledger, 10_000_000n]);
  await rig.write(rig.wc(KEYS.owner), rig.addresses.ledger, rig.A.ledger.abi, 'fund', [id, 5_000_000n]);
  return id;
}
/** waitFor whose failure carries the given output AT FAILURE TIME (a message built when the wait starts shows only boot) */
const waitOr = (fn, ms, what, out = () => H?.stdout() || '') => waitFor(fn, ms, what).catch(async (e) => {
  throw new Error(`${e.message}\n--- output at failure ---\n${String(await out()).slice(-8000)}`); });
const attemptsAll = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };
// the supervisor's DNS-over-HTTPS resolvers (its existing DNS layer, not a chain provider) are listed apart; every OTHER
// non-loopback origin - any RPC provider, public default or Enclave service - must never even be attempted
const DOH = new Set(['cloudflare-dns.com', 'dns.google']);
const attempts = (f) => attemptsAll(f).filter((h) => !DOH.has(h.replace(/:443$/, '')));
const verifierEnv = () => ({ ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: rt.url, ENCLAVE_CHAIN_TX_BACKEND: backend.url, BASE_RPCS: providers.url });
let policyDir;
// a host with wallet admission reads its LeaseReader through the admin AddressBook (as production relay hosts do, with their
// pins): the book this rig deploys
const haEnv = () => ({ ADDRESS_BOOK_ADDRESS: book, ENCLAVE_HOST_OWNERSHIP: lc(own), ENCLAVE_HOST_REGISTRY_PIN: lc(rig.addresses.registry), ENCLAVE_HOST_CATALOG_PIN: lc(rig.addresses.catalog),
  ENCLAVE_HOST_POLICY_DIR: policyDir, ENCLAVE_HOST_ID: rig.runner });
async function host(name, { env = {}, claim = true, stateFile = null, seed = false, id = '0x' + '00'.repeat(32), net = path.join(TMP, `${name}.net`) } = {}) {
  const dir = path.join(TMP, name); fs.mkdirSync(dir, { recursive: true });
  const h = await startActualHost(rig, { id, owner: privateKeyToAccount(KEYS.owner).address, dir, token: TOKEN, claim, rpc: providers.url, seed, stateFile, appRef,
    preload: RECORD, env: { NETWORK_ATTEMPTS_FILE: net, CLAIM_POLL_SEC: '2', RELEASE_POLL_MS: '500', ...env } });
  h.net = net; hosts.push(h);
  return h;
}

test.before(async () => {
  if (skip) return;
  rig = await startRig();
  assert.notEqual(await rig.rpcCall('eth_getCode', ['0x0000F90827F1C53a10cb7A02335B175320002935', 'latest']), '0x', 'needs the EIP-2935 genesis');
  const B = art('EnclaveAddressBook.sol', 'EnclaveAddressBook'); bookAbi = B.abi;
  book = await rig.deploy(B);
  const dep = rig.wc(KEYS.deployer);
  for (const [k, v] of [['deployments', rig.addresses.ledger], ['registry', rig.addresses.registry], ['appCatalog', rig.addresses.catalog]])
    await rig.write(dep, book, bookAbi, 'set', [stringToHex(k, { size: 32 }), v]);
  const O = art('EnclaveHostOwnership.sol', 'EnclaveHostOwnership'); ownAbi = O.abi;
  own = await rig.deploy(O, [rig.addresses.registry]);
  await rig.write(rig.wc(KEYS.operator), own, ownAbi, 'proposeOwner', [rig.runner, rig.owner]);
  await rig.write(rig.wc(KEYS.owner), own, ownAbi, 'acceptOwner', [rig.runner]);
  policyDir = path.join(TMP, 'host-policy'); fs.mkdirSync(policyDir);
  appRef = await servableAppRef(rig);
  proof = await startProofSource(rig.rpc); providers = await startProviders(); backend = await startBackend();
  rt = launchVerifierRuntime({ chainRpc: rig.rpc, proofSources: [proof.url], port: await freePort(), dir: path.join(TMP, 'runtime') });
  await rt.ready();
});
test.after(async () => {
  for (const h of hosts) await h.kill().catch(() => {});
  rt?.stop();
  for (const s of [proof, providers, backend]) s?.srv.close();
  await rig?.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});
const T = { skip, timeout: 600000 };
// E2E_ONLY=1,3 runs only those cases (debugging; a final run selects none)
const ONLY = process.env.E2E_ONLY ? new Set(process.env.E2E_ONLY.split(',')) : null;
const Tn = (n) => (ONLY && !ONLY.has(String(n)) ? { skip: 'not selected (E2E_ONLY)' } : T);
let H, Q;   // the relay-mode verifier host and its first claimed deployment

test('relay mode: the supervisor claims, adopts on the VERIFIED claim receipt, and renews, every write through the own backend only; no provider or public origin is ever attempted', Tn(1), async () => {
  Q = await fundedDeployment();
  const from = await rig.pc.getBlockNumber();
  H = await host('h1', { env: { ...verifierEnv(), ...haEnv(), RENEW_MARGIN_SEC: '1795' } });
  await H.waitLog(/\[chain\] authority: local verifier .* own backend .* no provider RPC is used/, 30000);
  // boot proceeds past listening (a stalled process would show here, with its health endpoint's answer)
  const health0 = async () => { try { return JSON.stringify(await (await fetch(`${H.upstream}/v1/health`, { signal: AbortSignal.timeout(5000) })).json()).slice(0, 600); } catch (e) { return 'NO ANSWER: ' + e.message; } };
  await waitFor(() => /\[registry\] registered/.test(H.stdout()), 120000, 'registered through the own backend').catch(async (e) => { throw new Error(`${e.message}; health: ${await health0()}\n${H.stdout().slice(-6000)}`); });
  await waitFor(async () => lc((await getRow(rig, Q)).runner) === lc(rig.runner), 180000, 'Q claimed by this host').catch(async (e) => { throw new Error(`${e.message}; health: ${await health0()}\n${H.stdout().slice(-6000)}`); });
  await waitOr(() => H.effects.some((e) => e.launched && e.name === Q), 60000, 'Q launched after the claim receipt was verified');
  await waitOr(async () => (await ledgerEvents(from, Q)).some((e) => e.eventName === 'Renewed'), 120000, 'Q renewed');
  const ev = await ledgerEvents(from, Q);
  assert.equal(ev.filter((e) => e.eventName === 'Claimed').length, 1, 'one claim');
  const ledger = lc(rig.addresses.ledger);
  const toLedger = backend.st.sends.filter((s) => s.to === ledger);
  assert.ok(toLedger.length >= 2, 'claim and renew were submitted through the own backend');
  assert.deepEqual(providers.st.hits, [], 'the configured provider RPC was never asked');
  assert.deepEqual(attempts(H.net), [], 'no RPC provider, public default or other non-loopback origin was attempted (only the supervisor DNS-over-HTTPS resolvers, listed apart)');
  const health = await (await fetch(`${H.upstream}/v1/health`)).json();
  assert.equal(health.chainAuthority.authority, 'local-verifier'); assert.equal(health.chainAuthority.tier, 'unsafe');
  assert.equal(health.chainAuthority.lastGate.ok, true);
  assert.equal(health.chainAuthority.logs, 'inclusion only (completeness not proven)');
});

test('proof-source outage: new claims refuse (nothing submitted), the running app keeps serving; a restart during the outage keeps it; claims resume when proofs return', Tn(2), async () => {
  const sendsBefore = backend.st.sends.length, deletesBefore = H.effects.filter((e) => e.delete).length;
  proof.st.mode = 'down';
  await sleep(4000);
  const S = await fundedDeployment();
  await sleep(25000);
  assert.match(lc((await getRow(rig, S)).runner), /^0x0{64}$/, 'S is not claimed while no proof source answers');
  assert.equal(backend.st.sends.length, sendsBefore, 'nothing was submitted during the outage');
  assert.equal(H.effects.filter((e) => e.delete).length, deletesBefore, 'the running app was not stopped');
  // restart DURING the outage: the restored record keeps serving (chain-backed, not chain-live); nothing is sent
  const stateFile = H.stateFile;
  await H.kill();
  H = await host('h1b', { env: { ...verifierEnv(), ...haEnv(), RENEW_MARGIN_SEC: '1795' }, stateFile, seed: false });
  await sleep(15000);
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const rec = st.deployments.find((d) => lc(d.id) === lc(Q));
  assert.ok(rec && ['running', 'claimed'].includes(rec.status), `Q is still served after the restart (${rec?.status})`);
  assert.ok(!H.effects.some((e) => e.delete), 'no teardown on a restart during the outage');
  assert.equal(backend.st.sends.length, sendsBefore, 'still nothing submitted');
  const health = await (await fetch(`${H.upstream}/v1/health`)).json();
  assert.equal(health.chainAuthority.authority, 'local-verifier');
  proof.st.mode = 'ok';
  await waitOr(async () => lc((await getRow(rig, S)).runner) === lc(rig.runner), 180000, 'S claimed once proofs return');
  assert.deepEqual(providers.st.hits, []); assert.deepEqual(attempts(H.net), []);
});

test('a lost submission answer, then a restart: the release is decided from the VERIFIED receipt and nonce; nothing is sent twice', Tn(3), async () => {
  const from = await rig.pc.getBlockNumber();
  const tok = await login(H);
  backend.st.mode = 'lose-next-release';
  const before = backend.st.sends.filter((s) => s.selector === RELEASE_SELECTOR).length;
  // the owner's release, retried while the host says a renewal of it is in flight (release_blocked: nothing was stopped), as an
  // owner client does; the request dies with its process below: that rejection is expected, and handled from the start
  const reqP = (async () => {
    for (let i = 0; ; i++) {
      const x = await api(H, 'POST', `/v1/deployments/${Q}/release`, tok);
      if (x.status !== 409 || x.json?.code !== 'release_blocked' || i >= 20) return x;
      await sleep(1500);
    }
  })().catch((e) => ({ diedWithProcess: e.message }));
  let answered = null; reqP.then((x) => { answered = x; });
  await waitOr(() => backend.st.lost === 1, 60000, 'the release reached the chain and its answer was lost',
    () => `${H.stdout()}\n--- release API answer so far: ${JSON.stringify(answered)}\n--- backend sends: ${JSON.stringify(backend.st.sends.slice(-12))}`);
  // the process dies right after the lost answer; the next one restores the durable intent and resolves it
  const stateFile = H.stateFile;
  await H.kill(); await reqP;
  H = await host('h1c', { env: { ...verifierEnv(), ...haEnv(), RENEW_MARGIN_SEC: '1795' }, stateFile, seed: false });
  await waitOr(async () => (await ledgerEvents(from, Q)).some((e) => e.eventName === 'Released'), 120000, 'Q released', async () => `${H.stdout()}\n--- release txs on chain since ${from}: ${JSON.stringify(await releaseTxs(rig, from, Q))}\n--- backend sends: ${JSON.stringify(backend.st.sends.slice(-12))}`);
  await H.waitLog(new RegExp(`\\[release\\] ${Q} released`), 120000);
  await sleep(10000);
  assert.equal(backend.st.sends.filter((s) => s.selector === RELEASE_SELECTOR).length - before, 1, 'exactly one release was ever submitted');
  assert.equal((await ledgerEvents(from, Q)).filter((e) => e.eventName === 'Released').length, 1);
  assert.deepEqual(providers.st.hits, []); assert.deepEqual(attempts(H.net), []);
});

test('owner veto and admin delisting, decided through the verifier: a denied deployment is never claimed; a delisted app is stopped', Tn(4), async () => {
  const V = await fundedDeployment(), W = await fundedDeployment();
  const doc = { version: 1, chainId: 8453, ownershipContract: lc(own), hostId: rig.runner, requireCatalogApproval: false, denyDeployments: [lc(V)], denyAppRefs: [] };
  const h = hostAdmissionPolicyHash(doc);
  fs.writeFileSync(path.join(policyDir, `${h}.json`), JSON.stringify(doc));
  const rc = await rig.write(rig.wc(KEYS.owner), own, ownAbi, 'setPolicy', [rig.runner, h]);
  await untilV(rc.blockNumber + 2n);
  await waitOr(async () => lc((await getRow(rig, W)).runner) === lc(rig.runner), 180000, 'W (allowed) claimed');
  await sleep(10000);
  assert.match(lc((await getRow(rig, V)).runner), /^0x0{64}$/, 'V (owner-denied) was never claimed');
  // the admin delists the app: the serving host stops it (decided on a verified catalog read)
  const deletes = H.effects.filter((e) => e.delete).length;
  const d = await rig.write(rig.wc(KEYS.deployer), rig.addresses.catalog, rig.A.catalog.abi, 'setActive', ['hello3000', false]);
  await untilV(d.blockNumber + 2n);
  await waitOr(() => H.effects.filter((e) => e.delete).length > deletes, 180000, 'the delisted app was stopped');
  assert.deepEqual(providers.st.hits, []); assert.deepEqual(attempts(H.net), []);
});

test('the admin AddressBook migration reaches a verifier host with no provider (book polling, never frozen pins)', Tn(5), async () => {
  const net = path.join(TMP, 'book.net');
  const b = await host('book', { claim: false, net, env: { ...verifierEnv(), ENCLAVE_CONTRACT_PINS_FILE: '', ADDRESS_BOOK_ADDRESS: book, ADDRESS_BOOK_POLL_SEC: '2' } });
  await b.waitLog(/\[addressbook\] resolved from/, 60000);
  const rc = await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('proofOfTime', { size: 32 }), rig.addresses.registry5]);
  await untilV(rc.blockNumber + 2n);
  await b.waitLog(new RegExp(`\\[addressbook\\] PROOF_OF_TIME_ADDRESS .* -> ${rig.addresses.registry5}`, 'i'), 60000);
  assert.deepEqual(providers.st.hits, []); assert.deepEqual(attempts(net), []);
  await b.kill();
});

test('positive control: the same recorder sees the public defaults a LEGACY host attempts (so the empty lists above mean something)', Tn(6), async () => {
  const net = path.join(TMP, 'legacy.net');
  const l = await host('legacy', { claim: false, net, env: { BASE_RPC: '', BASE_RPCS: '', ENCLAVE_CONTRACT_PINS_FILE: '', ADDRESS_BOOK_ADDRESS: book } });
  await waitFor(() => attempts(net).length > 0, 60000, 'a legacy host attempts its public defaults');
  assert.ok(attempts(net).some((h) => /base|publicnode|drpc|1rpc/.test(h)), attemptsAll(net).join(','));
  await l.kill();
});

test('direct mode: the supervisor started with planDirectBoot\'s environment for a bound chainVerifier reads only through the verifier', Tn(7), async () => {
  const dir = path.join(TMP, 'direct'); fs.mkdirSync(dir, { recursive: true });
  const image = path.join(dir, 'IMAGE.json'); fs.copyFileSync(path.join(REPO, 'metal/chain-verifier-image.json'), image);
  // the guest's paths under this test's directory, and the keys PID 1 mints there (as the measured-control e2e does)
  const GP = { ...MC.GUEST_PATHS, runDir: dir, pins: path.join(dir, 'pins.json'), pairKey: path.join(dir, 'pair.key'), sessionDir: path.join(dir, 'session'),
    acmeDir: path.join(dir, 'acme'), statement: path.join(dir, 'statement.json'), tlsKey: path.join(dir, 'tls-key.pem'), tlsCert: path.join(dir, 'tls-cert.pem'),
    serveConfig: path.join(dir, 'serve.json'), status: path.join(dir, 'status.json'), chainVerifierImage: image };
  MC.mintControlKeys({ paths: GP });
  const raw = { format: MC.CONFIG_FORMAT, chainId: 8453,
    contracts: { registry: lc(rig.addresses.registry), deployments: lc(rig.addresses.ledger), appCatalog: lc(rig.addresses.catalog), proofOfTime: lc(rig.addresses.ledger),
      enclavePay: '0x' + '00'.repeat(20), verificationFees: '0x' + '00'.repeat(20), sessionVaultFactory: lc(rig.addresses.factory), secretVaultV2: '0x' + '00'.repeat(20) },
    profileDigest: null, rpcs: ['https://rpc-a.example', 'https://rpc-b.example'], quorum: 2, releaseId: 'ab'.repeat(32),
    replicas: { gateways: ['http://192.0.2.10:8189'], storagePlan: null }, identity: { publicUrl: rig.endpoint, repo: 'independent/host', operator: lc(rig.operator) },
    selling: { cpuPrice6: 1000, payout: null }, isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096' }, hostAdmissionSha256: null, controlPort: 8444,
    chainVerifier: { format: 'enclave-chain-verifier/v1', unsafeSigner: lc(seqSigner), proofSources: ['https://holder.example.net/'], port: 50546, txBackend: 'http://10.0.2.2:8545' } };
  const cfg = MC.canonicalDirectConfig(raw), hd = MC.hostDataHex(MC.configDigest(cfg));
  const fw = { mode: 'snp', name: 'ctl', direct: raw, isolation: { managerUrl: 'http://10.0.2.2:8095', dataAddr: '10.0.2.2:8096', pairingKey: 'cd'.repeat(32) }, registryKey: KEYS.operator };
  const plan = await MC.planDirectBoot({ cmdline: 'console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct',
    fw, reportHostData: hd, viem, paths: GP });
  assert.equal(plan.ok, true, plan.reasons?.join('; '));
  for (const [f, text] of Object.entries(plan.files)) fs.writeFileSync(f, text, { mode: 0o600 });
  // the plan's environment; ONLY the guest's in-VM addresses are moved to this test's loopback (the verifier's port is the
  // guest's 50546 -> this runtime; the backend's host link 10.0.2.2 -> the recording backend; the manager -> a stand-in)
  assert.equal(plan.env.ENCLAVE_CHAIN_VERIFIER, 'http://127.0.0.1:50546/'); assert.equal(plan.env.ENCLAVE_CHAIN_TX_BACKEND, 'http://10.0.2.2:8545/');
  const net = path.join(TMP, 'direct.net');
  const mgr = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url === '/health' ? JSON.stringify({ directBootstrap: true }) : '[]'); });
  await new Promise((r) => mgr.listen(0, '127.0.0.1', r));
  const port = await freePort();
  const env = { ...plan.env, ENCLAVE_CHAIN_VERIFIER: rt.url, ENCLAVE_CHAIN_TX_BACKEND: backend.url, PORT: String(port), STATE_FILE: path.join(dir, 'state.json'), HOME: dir,
    PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: '', NETWORK_ATTEMPTS_FILE: net, VMMGR_URL: `http://127.0.0.1:${mgr.address().port}`, GUESTD_DATA_ADDR: `127.0.0.1:${mgr.address().port}`,
    ATTESTATION_URL: `http://127.0.0.1:${mgr.address().port}/rad`, CLAIM_POLL_SEC: '2',
    // the bound config's rpcs, as the plan derived them, now point at the counting provider stand-in: never to be asked
    BASE_RPC: providers.url, BASE_RPCS: providers.url, ENCLAVE_PLATFORM_HOST_POLICY_RPCS: providers.url };
  assert.deepEqual(MC.directEnvProblems(env), [], 'still the direct-only environment');
  const U = await fundedDeployment();   // an uncommitted deployment: a direct host must read it (proven) and refuse it
  const c = spawn(process.execPath, ['--import', RECORD, path.join(REPO, 'supervisor.js')], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; c.stdout.on('data', (b) => { log += b; }); c.stderr.on('data', (b) => { log += b; });
  try {
    await waitOr(() => /\[chain\] authority: local verifier/.test(log), 30000, 'verifier authority selected', () => log);
    assert.match(log, /\[direct\] direct-only host control/);
    await waitOr(() => /\[ledger\] full pass/.test(log), 120000, 'a proven ledger pass', () => log);
    await sleep(8000);
    assert.match(lc((await getRow(rig, U)).runner), /^0x0{64}$/, 'the direct host does not claim an uncommitted deployment');
    assert.deepEqual(providers.st.hits, [], 'the bound config\'s rpcs and BASE_RPC(S) were never asked');
    assert.deepEqual(attempts(net), [], 'no RPC provider or other non-loopback origin attempted (DNS-over-HTTPS resolvers listed apart)');
  } finally { c.kill('SIGKILL'); mgr.close(); }
});
