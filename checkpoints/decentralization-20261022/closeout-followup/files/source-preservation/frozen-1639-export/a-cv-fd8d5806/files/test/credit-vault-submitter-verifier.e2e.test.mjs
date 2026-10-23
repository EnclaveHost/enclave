// END-TO-END: the PACKAGED credit-vault submitter host role (network/host-services/packages/credit-vault-submitter.mjs,
// launched exactly as network/host-services/runner.mjs launches it: `node --max-old-space-size=N <bundle> <config.json>`)
// in its opt-in verifier mode - state from the local proof-backed verifier, the rpc list only the explicit transaction
// transport, receipts from the locally validated receipt source - against REAL credit-vault requests on the cli-independent
// rig (pinned reth --dev, chain 8453) read through the patched Helios.
//
// WHAT VALIDATES WHAT (labelled): reth --dev is the Base EXECUTION node; the L1 is an anvil (chain 1); the beacon and Base
// rollup nodes are worker E's LABELLED fixtures (test/fixtures/tx-evidence/pair-stubs.mjs). Their identities are not
// mainnet, so every minted receipt is trust 'test-fixture'. A role given a fixture source is spawned with the harness
// switch ENCLAVE_TEST_RECEIPT_FIXTURE=1 in ITS environment only; the host-service runner passes no environment, and this
// test process never sets the switch - so through the runner a fixture source is refused, and a production source
// (mainnet identities) against this rig is NOT READY. Nothing here is mainnet, a synchronized node, or a portable proof.
//
// Covered: exact success (minted receipt, exact funds, journal "confirmed"), idempotent same bytes, a REAL on-chain revert
// (journal "reverted" from the minted receipt), an unknown outcome held and recovered by rebroadcasting the SAME bytes,
// tampered verifier proofs refused before anything is signed, the admin's book migration followed, and through the
// runner: no environment, a not-ready production source ending UNKNOWN (never confirmed), the platform host policy gate.
//   env: RIG_CHAIN_NODE=reth (+ RIG_RETH_*), HELIOS_BASE_BIN, TEST_TMP. Run inside `unshare -r -n`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toHex, keccak256, decodeEventLog, parseAbi, createWalletClient, http as viemHttp } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { startRig, haveTools, KEYS, freePort, chain as rigChain } from './helpers/cli-independent-rig.mjs';
import { createWitnessGateway } from '../network/witness-gateway.mjs';
import { makeCommitment, blockFields } from './fixtures/op-commitment.mjs';
import { startBeaconFixture, startRollupFixture, jrpc } from './fixtures/tx-evidence/pair-stubs.mjs';
import { independentChain } from '../cli/independent.mjs';
import { intentJournal, rebroadcast, resolveIntent } from '../cli/independent-signer.mjs';
import { parseReceiptSourceConfig, createReceiptSource, FIXTURE_ENV } from '../network/receipt-source.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(REPO, 'network/host-services/packages');
const ROLE = 'credit-vault-submitter';
const { HELIOS_BASE_BIN } = process.env;
const haveAnvil = (() => { try { execFileSync('anvil', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const skip = haveTools() || (!HELIOS_BASE_BIN && 'HELIOS_BASE_BIN not set') || (process.env.RIG_CHAIN_NODE !== 'reth' && 'needs the canonical-trie rig (RIG_CHAIN_NODE=reth)')
  || (!haveAnvil && 'needs anvil for the L1 fixture') || (!fs.existsSync(path.join(PKG, `${ROLE}.package.json`)) && 'needs the built packages');
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'cvs-verifier-e2e-'));
const SEQ_KEY = '0x' + '5e'.repeat(32), seqSigner = privateKeyToAccount(SEQ_KEY).address;
const GVR = '0x' + '7e'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (a) => String(a).toLowerCase();
const T = { skip, timeout: 1200000 };
const HARNESS = { [FIXTURE_ENV]: '1' };
let rig, helios, heliosUrl, feed, proxy, gateway, l1proc, l1, beacon, rollup, fixtureCfg, prodCfg, source;
const proxyMode = { value: 'ok' };
const servers = [], children = [];

// ---- the verifier rig ----------------------------------------------------------------------------------------------------
async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
async function untilHelios(n, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (BigInt(await rpc(heliosUrl, 'eth_blockNumber')) >= BigInt(n)) return; } catch {} await sleep(300); }
  throw new Error(`helios did not reach block ${n}`);
}
const settled = (rc) => untilHelios(BigInt(rc.blockNumber) + 2n);
function startFeed() {
  let served = 0n, current = null;
  const srv = http.createServer(async (q, res) => {
    if (q.url === '/chain_id') return res.end('8453');
    try {
      const latest = BigInt(await rig.rpcCall('eth_blockNumber'));
      if (served === 0n && latest > 3n) served = latest - 3n;
      if (served < latest) {
        const n = served + 1n, b = await rig.rpcCall('eth_getBlockByNumber', [toHex(n), false]);
        const txs = await Promise.all(b.transactions.map((h) => rig.rpcCall('eth_getRawTransactionByHash', [h])));
        current = await makeCommitment(blockFields(b), { chainId: 8453, privateKey: SEQ_KEY, txs }); served = n;
      }
    } catch {}
    res.end(JSON.stringify(current));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}
// Helios's witness source: 'tamper' rewrites every storage proof value (a forged proof the verifier must refuse)
function startProxy() {
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    const j = await (await fetch(rig.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b })).json();
    if (proxyMode.value === 'tamper') for (const x of [j].flat()) if (x?.result?.storageProof) for (const s of x.result.storageProof) s.value = '0x' + 'beef'.padStart(40, '1');
    res.end(JSON.stringify(j));
  }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}
/** a transaction transport that answers eth_sendRawTransaction with the right hash but never forwards the bytes */
async function swallowingTransport() {
  const srv = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const q = JSON.parse(b);
    const one = async (m) => (m.method === 'eth_sendRawTransaction' ? { jsonrpc: '2.0', id: m.id, result: keccak256(m.params[0]) }
      : (await fetch(rig.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) })).json());
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(q) ? await Promise.all(q.map(one)) : await one(q)));
  });
  servers.push(srv); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${srv.address().port}`;
}

test.before(async () => {
  if (skip) return;
  assert.equal(process.env[FIXTURE_ENV], undefined, 'this test process never carries the harness switch');
  rig = await startRig();
  const last = await rig.create(KEYS.owner);
  feed = await startFeed(); proxy = await startProxy();
  gateway = createWitnessGateway({ upstreams: [proxy.url] }); const gUrl = await gateway.listen(0);
  const home = path.join(TMP, 'home'); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${seqSigner}"\n`);
  const port = await freePort();
  helios = spawn(HELIOS_BASE_BIN, ['opstack', '--network', 'base', '--consensus-rpc', feed.url, '--execution-rpc', gUrl, '--rpc-port', String(port)], { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  heliosUrl = `http://127.0.0.1:${port}/`;
  // the L1 fixture: a STATIC anvil (chain 1; finalized 64 blocks back; head hours ahead so lag checks hold) + E's beacon
  const l1port = await freePort();
  l1proc = spawn('anvil', ['--port', String(l1port), '--chain-id', '1', '--silent'], { stdio: 'ignore' });
  l1 = `http://127.0.0.1:${l1port}`;
  for (let i = 0; i < 150; i++) { try { await jrpc(l1, 'eth_chainId'); break; } catch { await sleep(100); } }
  await jrpc(l1, 'evm_setNextBlockTimestamp', ['0x' + (Math.floor(Date.now() / 1000) + 3 * 3600).toString(16)]);
  await jrpc(l1, 'anvil_mine', ['0x50']);
  beacon = await startBeaconFixture({ el: l1, gvr: GVR });
  rollup = await startRollupFixture({ l2: rig.rpc, l1 });
  prodCfg = { format: 'enclave-receipt-source/v1', l1: { execution: { url: l1 }, consensus: { url: beacon.url } }, base: { execution: { url: rig.rpc }, rollup: { url: rollup.url } } };
  fixtureCfg = { ...prodCfg, testFixture: { label: 'TEST FIXTURE reth --dev Base execution + anvil L1 + scripted beacon/rollup',
    l1Identity: { chainIdHex: '0x1', elGenesisHash: (await jrpc(l1, 'eth_getBlockByNumber', ['0x0', false])).hash, clGenesisValidatorsRoot: GVR },
    l2Identity: { chainIdHex: '0x2105', genesisHash: (await jrpc(rig.rpc, 'eth_getBlockByNumber', ['0x0', false])).hash } } };
  source = createReceiptSource(parseReceiptSourceConfig(fixtureCfg, { env: HARNESS }));   // the client's / operator's own
  await settled(last);
});
test.after(async () => {
  for (const c of children) try { c.kill('SIGKILL'); } catch {}
  for (const s of servers) try { s.closeAllConnections?.(); s.close(); } catch {}
  helios?.kill('SIGKILL'); l1proc?.kill('SIGKILL'); beacon?.close(); rollup?.close();
  await gateway?.close(); feed?.srv.close(); proxy?.srv.close();
  await rig?.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});
const walletOf = (account) => createWalletClient({ account, chain: rigChain, transport: viemHttp(rig.rpc) });
let funding = Promise.resolve();
const fundEth = (address, wei = 10n ** 19n) => (funding = funding.then(async () => {
  const rc = await rig.pc.waitForTransactionReceipt({ hash: await rig.wc(KEYS.deployer).sendTransaction({ to: address, value: wei }) });
  if (rc.status !== 'success') throw new Error('funding failed'); return rc;
}));
const newAcct = async () => { const a = privateKeyToAccount(generatePrivateKey()); await settled(await fundEth(a.address)); return a; };
const goodChain = () => independentChain({ chainVerifier: heliosUrl, rpcs: [rig.rpcs[2]], confirmations: 1, maxBlockAgeMs: 600000, receiptSource: source });
const STATE_METHODS = ['eth_call', 'eth_getCode', 'eth_getStorageAt', 'eth_getBalance', 'eth_getProof'];

/** the operator's loopback wallet: signs (eth_signTransaction) with `account`; `hooks.beforeSign` runs once if set */
async function operatorWallet(account) {
  const st = { signs: 0, beforeSign: null };
  const srv = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const m = JSON.parse(b);
    const answer = async () => {
      if (m.method === 'eth_accounts') return { result: [account.address] };
      if (m.method === 'eth_chainId') return { result: '0x2105' };
      if (m.method === 'eth_signTransaction') { const p = m.params[0]; st.signs++;
        if (st.beforeSign) { const f = st.beforeSign; st.beforeSign = null; await f(); }
        return { result: await account.signTransaction({ type: 'eip1559', chainId: Number(p.chainId), nonce: Number(p.nonce), to: p.to, value: BigInt(p.value), data: p.data,
          gas: BigInt(p.gas), maxFeePerGas: BigInt(p.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas) }) }; }
      return { error: { code: -32601, message: `the method ${m.method} does not exist/is not available` } };
    };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...(await answer()) }));
  });
  servers.push(srv); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, st };
}
/** the packaged role, launched as the runner launches it (argv), with the given environment (the runner passes PATH only) */
async function spawnRole(config, env) {
  const dir = fs.mkdtempSync(path.join(TMP, 'role-')); const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const p = spawn(process.execPath, ['--max-old-space-size=128', path.join(PKG, `${ROLE}.mjs`), file], { cwd: dir, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(p);
  const log = [];
  p.stderr.on('data', (d) => log.push(...String(d).split('\n').filter(Boolean)));
  const url = await new Promise((ok, no) => {
    let out = ''; p.stdout.on('data', (d) => { out += d; const m = /\{"submitter":"([^"]+)"\}/.exec(out); if (m) ok(m[1]); });
    p.on('exit', (code) => no(new Error(`role exited ${code}: ${log.join('\n')}`))); setTimeout(() => no(new Error('role did not start: ' + log.join('\n'))), 60000);
  });
  return { url, log, proc: p, journalDir: path.join(config.stateDir, 'signer') };
}
const post = async (url, req) => { const r = await fetch(url + '/v1/credit-vault/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req), signal: AbortSignal.timeout(300000) });
  return { status: r.status, body: await r.json() }; };
const VERIFIED = /TEST FIXTURE - success in block \d+: receipt minted by the local Base node source \(verifiedBy 'base-derivation', trust 'test-fixture', level 'unsafe'\); hash, sender and nonce bound to the signed transaction/;

// ---- the credit-vault world (the production factory bytecode, a real P-256 passkey) -----------------------------------------
const F = await import('./credit-vault-fixture.mjs');
const CV = await import('../site/js/core/credit-vault-independent.js');
const CLI = await import('../cli/credit-vault.mjs');
let W;
async function world() {
  if (W) return W;
  const c = { pub: rig.pc, wallet: (k) => walletOf(F.ACCT[k]) };
  const S = await F.deployStack(c);
  const PINS = CV.validatePins({ chainId: 8453, origin: F.ORIGIN, rpId: F.RPID, usdc: S.usdc, factories: [S.older, S.current] });
  const K = F.passkey();
  await F.send(c, 'admin', S.current.address, CV.ABI.factory, 'createVault', [BigInt(K.x), BigInt(K.y)]);
  const vault = CV.deriveVault(CLI.lib, K.x, K.y, S.current);
  await settled(await F.send(c, 'admin', S.usdc, F.CHAIN_FX.MockUSDC.abi, 'mint', [vault, 100_000000n]));
  const profile = CV.makeProfile({ factory: S.current.address, vault, key: { x: K.x, y: K.y } }, { credentialId: K.credentialId }, PINS);
  // the client's own verified reader (its own transport front 1, its own receipt source): it reconciles from the chain
  const reader = CLI.verifiedCreditReader({ verifier: heliosUrl, chainId: 8453, confirmations: 1, transport: [rig.rpcs[1]], receiptSource: source });
  const sign = async (op, params) => CV.signPrepared(CLI.lib, await CV.prepareVaultOp(CLI.lib, profile, op, params, { reader, pins: PINS, journal: F.memJournal() }), profile,
    { pins: PINS, origin: F.ORIGIN, getFn: K.getFn(), intent: { op, params } });
  const reconcile = (req, hashes) => CV.reconcile(CLI.lib, { request: req, txHashes: hashes }, { reader });
  W = { c, S, PINS, K, vault, profile, reader, sign, reconcile };
  return W;
}
const spec = { appRef: 'catalog://app/0', gpuMilli: 0, cpuMilli: 500, appPort: 8080, ports: '', isPublic: true, configCid: '', maxRate6: '1000' };
const roleConfig = async (payer, wallet, extra) => ({ port: await freePort(), bind: '127.0.0.1', perMinute: 600, stateDir: fs.mkdtempSync(path.join(TMP, 'state-')), signer: wallet.url, from: payer.address, chainId: 8453,
  pins: W.PINS, confirmations: 1, chainVerifier: heliosUrl, outcomeTimeoutSec: 30, ...extra });
const journalOf = (dir) => intentJournal(dir);
let A;                                                              // the verifier-mode role with the fixture receipt source

test('packaged role, verifier mode + receipt source: /health states each authority; an exact request succeeds once from a MINTED receipt; the same bytes are idempotent; the transport never answers state', T, async () => {
  await world();
  const payer = await newAcct(), wallet = await operatorWallet(payer);
  const cfg = await roleConfig(payer, wallet, { rpc: [rig.rpcs[0]], receiptSource: fixtureCfg });
  await assert.rejects(spawnRole(cfg, {}), /refused outside a test harness/, 'without the harness switch the packaged role refuses a fixture source');
  A = { ...(await spawnRole(cfg, HARNESS)), payer, wallet, cfg };
  const h = await (await fetch(A.url + '/health')).json();
  assert.equal(h.authority.mode, 'local-verifier'); assert.match(h.authority.state, /local proof-backed verifier http:\/\/127\.0\.0\.1:\d+\/ \(unsafe tier\)/);
  assert.equal(h.authority.transactions, 'explicit transaction transport: 1 endpoint(s), never a state authority');
  assert.match(h.authority.receipts, /^receipt source: TEST FIXTURE .*trust 'test-fixture'$/);
  assert.ok(A.log.some((l) => /state: the local proof-backed verifier/.test(l)), A.log.join('\n'));
  // a deploy through the role: verified simulation, one send through the transport, inclusion from the minted receipt
  const u0 = await F.usdcOf(W.c, W.S, W.vault), f0 = rig.rpcLog.length;
  const req = await W.sign('deploy', { spec, fundUsd: '30' });
  const r = await post(A.url, req);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.outcome, VERIFIED);
  const used = rig.rpcLog.slice(f0).filter((x) => x.i === 0);
  assert.ok(used.some((x) => x.method === 'eth_sendRawTransaction'));
  assert.deepEqual(used.filter((x) => STATE_METHODS.includes(x.method)).map((x) => x.method), [], 'the transport never answered a state read or the simulation');
  const rc = await rig.pc.getTransactionReceipt({ hash: r.body.txHash });
  const ev = rc.logs.filter((l) => lc(l.address) === W.profile.vault).map((l) => { try { return decodeEventLog({ abi: parseAbi(['event Deployed(bytes32 indexed id, uint256 funded6)']), ...l }); } catch { return null; } }).find(Boolean);
  W.id = ev.args.id;
  assert.equal((await F.recordOf(W.c, W.S.ledger, W.id)).balance6, 30_000000n); assert.equal(await F.usdcOf(W.c, W.S, W.vault), u0 - 30_000000n, 'exact funds');
  const rec = await W.reconcile(req, [r.body.txHash]);
  assert.equal(rec.status, 'executed'); assert.equal(rec.txHash, lc(r.body.txHash));
  assert.match(CLI.outcomeEvidence(rec, W.reader).evidence.execution, /^TEST FIXTURE - success in block \d+: receipt minted .*its signed bytes call this vault with exactly the signed request$/);
  const j = journalOf(A.journalDir).list();
  assert.equal(j.length, 1); assert.equal(j[0].state, 'confirmed'); assert.equal(j[0].evidence.receiptVerified, true); assert.equal(j[0].evidence.trust, 'test-fixture');
  // the same bytes again: the held flight answers; nothing is signed or sent again
  const s0 = wallet.st.signs, b0 = rig.rpcLog.filter((x) => x.method === 'eth_sendRawTransaction').length;
  const again = await post(A.url, req);
  assert.equal(again.body.txHash, r.body.txHash);
  assert.equal(wallet.st.signs, s0); assert.equal(rig.rpcLog.filter((x) => x.method === 'eth_sendRawTransaction').length, b0);
});

test('a REAL on-chain revert: the vault nonce is used between the role\'s verified simulation and inclusion; "reverted" comes from the minted receipt; the client decides "superseded"', T, async () => {
  // two requests signed for the SAME vault nonce; the owner's own wallet lands the other one while the operator's wallet signs
  const r1 = await W.sign('fund', { id: W.id, amountUsd: '1' }), r2 = await W.sign('fund', { id: W.id, amountUsd: '2' });
  assert.equal(r1.nonce, r2.nonce);
  const u0 = await F.usdcOf(W.c, W.S, W.vault);
  A.wallet.st.beforeSign = async () => {
    const h = await walletOf(F.ACCT.payer).sendTransaction({ to: r2.to, data: r2.data });
    await settled(await rig.pc.waitForTransactionReceipt({ hash: h }));
  };
  const n0 = await rig.pc.getTransactionCount({ address: A.payer.address });
  const r = await post(A.url, r1);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.match(r.body.error, /transaction reverted: 0x[0-9a-f]{64} .*TEST FIXTURE - reverted in block \d+: receipt minted by the local Base node source/);
  assert.equal(await rig.pc.getTransactionCount({ address: A.payer.address }), n0 + 1, 'the operator\'s nonce was used once');
  const rev = journalOf(A.journalDir).list().find((x) => x.state === 'reverted');
  assert.ok(rev, 'the journal holds the reverted intent'); assert.equal(rev.evidence.receiptVerified, true); assert.equal(rev.note, undefined, 'no transport caveat: the revert is minted');
  assert.equal((await rig.pc.getTransactionReceipt({ hash: rev.hash })).status, 'reverted', 'the chain agrees');
  assert.equal(await F.usdcOf(W.c, W.S, W.vault), u0 - 2_000000n, 'only the request that landed moved funds');
  assert.equal((await W.reconcile(r1, [rev.hash])).status, 'superseded');
});

test('tampered verifier proofs: the role refuses before anything is signed; the same bytes execute once the proofs are honest', T, async () => {
  const req = await W.sign('fund', { id: W.id, amountUsd: '3' });
  const s0 = A.wallet.st.signs, u0 = await F.usdcOf(W.c, W.S, W.vault);
  proxyMode.value = 'tamper';
  try {
    await untilHelios(BigInt(await rpc(heliosUrl, 'eth_blockNumber')) + 2n);
    const r = await post(A.url, req);
    assert.ok(r.status >= 400, JSON.stringify(r)); assert.equal(A.wallet.st.signs, s0, 'nothing was signed'); assert.equal(await F.usdcOf(W.c, W.S, W.vault), u0);
  } finally { proxyMode.value = 'ok'; }
  await untilHelios(BigInt(await rig.rpcCall('eth_blockNumber')) - 2n, 300000);
  let r;
  for (let i = 0; i < 30; i++) { r = await post(A.url, req); if (r.status === 200) break; await sleep(2000); }
  assert.equal(r.status, 200, JSON.stringify(r)); assert.match(r.body.outcome, VERIFIED);
  assert.equal(await F.usdcOf(W.c, W.S, W.vault), u0 - 3_000000n, 'exactly once');
});

test('admin migration: the book\'s "deployments" repointed by the admin is followed by the role\'s verified reads (a new deployment lands on the ledger the book names)', T, async () => {
  const ledger2 = await F.deployLedger(W.c, [W.S.usdc, F.PAYOUT, W.S.registry, W.S.feed]);
  await settled(await F.send(W.c, 'admin', W.S.book, F.CHAIN_FX.EnclaveAddressBook.abi, 'set', [F.bookKey('deployments'), ledger2]));
  try {
    const req = await W.sign('deploy', { spec, fundUsd: '4' });
    const r = await post(A.url, req);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.outcome, VERIFIED);
    const rc = await rig.pc.getTransactionReceipt({ hash: r.body.txHash });
    assert.ok(rc.logs.some((l) => lc(l.address) === lc(ledger2)), 'created on the ledger the admin\'s book names');
  } finally { await settled(await F.send(W.c, 'admin', W.S.book, F.CHAIN_FX.EnclaveAddressBook.abi, 'set', [F.bookKey('deployments'), W.S.ledger])); }
});

test('an unknown outcome is held (the transport swallowed the send): repeats answer the same transaction, nothing re-signed; the operator rebroadcasts the SAME bytes and it confirms from a minted receipt', T, async () => {
  const payer = await newAcct(), wallet = await operatorWallet(payer);
  const B = await spawnRole(await roleConfig(payer, wallet, { rpc: [await swallowingTransport()], receiptSource: fixtureCfg, outcomeTimeoutSec: 12 }), HARNESS);
  const req = await W.sign('fund', { id: W.id, amountUsd: '5' });
  const u0 = await F.usdcOf(W.c, W.S, W.vault);
  const r = await post(B.url, req);
  assert.equal(r.status, 200); assert.equal(r.body.unknown, true, JSON.stringify(r.body)); const H = r.body.txHash;
  const signs = wallet.st.signs;
  assert.deepEqual((await post(B.url, req)).body, { txHash: H, unknown: true }, 'held: the same answer, no new flight');
  assert.equal(wallet.st.signs, signs, 'never re-signed');
  assert.equal(await F.usdcOf(W.c, W.S, W.vault), u0, 'nothing moved');
  const journal = journalOf(B.journalDir), rec = journal.list()[0];
  assert.equal(rec.state, 'unknown'); assert.equal(lc(rec.hash), lc(H));
  // the operator's resolution (`enclave … signer rebroadcast` with the same receipt source): the SAME signed bytes
  const out = await rebroadcast(goodChain(), journal, rec.id, { timeoutMs: 120000, pollMs: 1000 });
  assert.equal(out.evidence.receiptVerified, true); assert.equal(journal.get(rec.id).state, 'confirmed'); assert.equal(lc(journal.get(rec.id).hash), lc(H));
  assert.equal(await F.usdcOf(W.c, W.S, W.vault), u0 - 5_000000n, 'exactly once');
  assert.equal((await W.reconcile(req, [H])).status, 'executed');
});

test('through the host-service RUNNER (no environment): a fixture source is refused; a PRODUCTION source against this rig is not ready, so the send ends UNKNOWN, never confirmed; the platform host policy gate still stops and restarts the role', T, async () => {
  const { runHostServices, validateHostServicesConfig } = await import('../network/host-services/runner.mjs');
  const payer = await newAcct(), wallet = await operatorWallet(payer);
  const pin = 'sha256:' + createHash('sha256').update(fs.readFileSync(path.join(PKG, `${ROLE}.package.json`))).digest('hex');
  const port = await freePort();
  const config = { ...(await roleConfig(payer, wallet, { rpc: [rig.rpcs[0]], receiptSource: prodCfg, outcomeTimeoutSec: 15 })), port };
  const hs = (c) => ({ format: 'enclave-host-services/v1', host: { endpoint: 'https://host-v.credit-test.net' }, platformHostPolicy: 'production', packagesDir: PKG,
    stateRoot: fs.mkdtempSync(path.join(TMP, 'hs-')), services: [{ role: ROLE, package: pin, heapMiB: 128, config: c }] });
  assert.throws(() => validateHostServicesConfig(hs({ ...config, receiptSource: fixtureCfg })), /refused outside a test harness/);
  const logs = [], gate = { refusal: null };
  const gateOf = { check: async () => {}, start() {}, stop() {}, serviceRefusal: () => gate.refusal, status: () => ({ platformHostPolicy: 'test', refusal: gate.refusal }) };
  const running = await runHostServices(hs(config), { gate: gateOf, log: (m) => logs.push(m), intervalMs: 200, backoffMs: 200 });
  try {
    const url = `http://127.0.0.1:${port}`;
    const healthy = () => fetch(url + '/health', { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
    const wait = async (f, ms, what) => { const end = Date.now() + ms; for (;;) { if (await f()) return; if (Date.now() > end) throw new Error(`timed out: ${what}\n${logs.slice(-20).join('\n')}`); await sleep(200); } };
    await wait(healthy, 60000, 'the runner-launched role');
    const st = running.status().services[0];
    assert.deepEqual(fs.readFileSync(`/proc/${st.pid}/environ`, 'utf8').split('\0').filter(Boolean).map((e) => e.split('=')[0]), ['PATH'], 'no harness switch, no environment');
    const h = await (await fetch(url + '/health')).json();
    assert.match(h.authority.receipts, /trust 'local-validated-pair' \(local full-node validation, not a portable proof\)/);
    const req = await W.sign('fund', { id: W.id, amountUsd: '6' });
    const u0 = await F.usdcOf(W.c, W.S, W.vault);
    const r = await post(url, req);
    assert.equal(r.body.unknown, true, JSON.stringify(r.body));
    const rec = journalOf(path.join(config.stateDir, 'signer')).list()[0];
    assert.equal(rec.state, 'unknown'); assert.match(rec.note, /l2-source-not-ready|has not shown it included/);
    // the transaction did land; a working source then decides it - the role never claimed it
    const fin = await resolveIntent(goodChain(), journalOf(path.join(config.stateDir, 'signer')), rec.id);
    assert.equal(fin.state, 'confirmed'); assert.equal(await F.usdcOf(W.c, W.S, W.vault), u0 - 6_000000n);
    // the platform host policy gate still governs the role
    gate.refusal = 'platform host policy: banned by platform policy #9 (host)';
    await wait(async () => !running.status().services[0].running && !(await healthy()), 20000, 'the role stopped on refusal');
    gate.refusal = null;
    await wait(healthy, 60000, 'the role restarted after admission');
  } finally { await running.stop(); }
});
