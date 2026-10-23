// END-TO-END: the validated receipt source (network/receipt-source.mjs over worker E's vendored adapters) in the REAL
// consumers, against REAL transactions on the cli-independent rig (pinned reth --dev, chain 8453) read through the
// patched Helios as the state verifier.
//
// WHAT VALIDATES WHAT (labelled): the Base EXECUTION node is the rig's reth (it executes every block itself); the L1 is an
// anvil (chain 1); the beacon node and the Base rollup node are E's LABELLED fixtures (test/fixtures/tx-evidence/
// pair-stubs.mjs) that mirror tags and validate nothing. The identities are not Ethereum/Base mainnet, so every minted
// receipt carries trust 'test-fixture' and is accepted only under ENCLAVE_TEST_RECEIPT_FIXTURE=1; a production config
// (mainnet identities) is shown refusing this rig. Nothing here is local full-node validation of mainnet, mainnet sync,
// or a portable proof. TEST-SIGNED HEAD for the state verifier (local sequencer key in helios.toml).
//
// Covered: the CLI's real config path (--receipt-source FILE; `receipt-source status`); external-signer sends
// (success, a REAL on-chain revert, wallet-send with changed fields, handoff/attach with another sender's or another
// nonce's hash); unknown outcomes recovered by rebroadcasting the same bytes; a source deriving from another L1, a Base
// node that tampers with receipts, and a source that is not ready - none of which ever yields "confirmed"; the
// credit-vault CLI's submit/reconcile with the executing transaction verified; the journal never persists evidence.
//   env: RIG_CHAIN_NODE=reth (+ RIG_RETH_*), HELIOS_BASE_BIN, TEST_TMP. Run inside `unshare -r -n`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { toHex, keccak256, encodeFunctionData, decodeEventLog, parseAbi, createWalletClient, http as viemHttp, maxUint256 } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { startRig, haveTools, KEYS, freePort, chain as rigChain } from './helpers/cli-independent-rig.mjs';
import { createWitnessGateway } from '../network/witness-gateway.mjs';
import { makeCommitment, blockFields } from './fixtures/op-commitment.mjs';
import { startBeaconFixture, startRollupFixture, jrpc } from './fixtures/tx-evidence/pair-stubs.mjs';
import { independentChain } from '../cli/independent.mjs';
import { createExternalSigner, resolveIntent, rebroadcast, attachHash } from '../cli/independent-signer.mjs';
import { loadReceiptSourceConfig, createReceiptSource, FIXTURE_ENV } from '../network/receipt-source.mjs';
import { acceptEvidence } from '../network/tx-evidence/forced-inclusion.mjs';
import { TRUST } from '../network/tx-evidence/evidence-brand.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'cli', 'enclave.mjs');
const GUARD = pathToFileURL(path.join(REPO, 'test/helpers/cli-network-guard.mjs')).href;
const { HELIOS_BASE_BIN } = process.env;
const haveAnvil = (() => { try { execFileSync('anvil', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const skip = haveTools() || (!HELIOS_BASE_BIN && 'HELIOS_BASE_BIN not set') || (process.env.RIG_CHAIN_NODE !== 'reth' && 'needs the canonical-trie rig (RIG_CHAIN_NODE=reth)') || (!haveAnvil && 'needs anvil for the L1 fixture');
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'receipt-source-e2e-'));
const SEQ_KEY = '0x' + '5e'.repeat(32), seqSigner = privateKeyToAccount(SEQ_KEY).address;
const GVR = '0x' + '7e'.repeat(32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (a) => String(a).toLowerCase();
const T = { skip, timeout: 900000 };
let rig, helios, heliosUrl, feed, proxy, gateway, pinsFile, netLog, l1, l1proc, beacon, rollup, cfg, cfgFile, prodFile, source;
const servers = [];

// ---- the verifier rig (test/cli-mcp-verifier.e2e.test.mjs) -------------------------------------------------------------
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
function startProxy() {
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    res.end(JSON.stringify(await (await fetch(rig.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b })).json()));
  }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}
/** a JSON-RPC proxy in front of `target` whose answers `edit(method, params, result)` may rewrite */
async function editingProxy(target, edit) {
  const srv = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const q = JSON.parse(b);
    const one = async (m) => { const j = await (await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(m) })).json();
      return 'result' in j ? { ...j, result: await edit(m.method, m.params, j.result) } : j; };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(Array.isArray(q) ? await Promise.all(q.map(one)) : await one(q)));
  });
  servers.push(srv); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${srv.address().port}`;
}

test.before(async () => {
  if (skip) return;
  process.env[FIXTURE_ENV] = '1';                                   // this harness only: test-fixture trust is accepted
  rig = await startRig();
  pinsFile = path.join(TMP, 'pins.json'); fs.writeFileSync(pinsFile, JSON.stringify(rig.pins));
  netLog = path.join(TMP, 'net.log'); fs.writeFileSync(netLog, '');
  await rig.create(KEYS.owner); const last = await rig.create(KEYS.owner);
  feed = await startFeed(); proxy = await startProxy();
  gateway = createWitnessGateway({ upstreams: [proxy.url] }); const gUrl = await gateway.listen(0);
  const home = path.join(TMP, 'home'); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${seqSigner}"\n`);
  const port = await freePort();
  helios = spawn(HELIOS_BASE_BIN, ['opstack', '--network', 'base', '--consensus-rpc', feed.url, '--execution-rpc', gUrl, '--rpc-port', String(port)], { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  heliosUrl = `http://127.0.0.1:${port}/`;
  // the L1 fixture: anvil chain 1 (its finalized tag is 64 blocks back) + E's beacon fixture
  const l1port = await freePort();
  // a STATIC L1 (no interval mining, so its finalized tag cannot move between the adapter's paired reads), its head placed
  // hours ahead so the adapter's head/finalized lag checks hold for the whole run
  l1proc = spawn('anvil', ['--port', String(l1port), '--chain-id', '1', '--silent'], { stdio: 'ignore' });
  l1 = `http://127.0.0.1:${l1port}`;
  for (let i = 0; i < 150; i++) { try { await jrpc(l1, 'eth_chainId'); break; } catch { await sleep(100); } }
  await jrpc(l1, 'evm_setNextBlockTimestamp', ['0x' + (Math.floor(Date.now() / 1000) + 3 * 3600).toString(16)]);
  await jrpc(l1, 'anvil_mine', ['0x50']);
  beacon = await startBeaconFixture({ el: l1, gvr: GVR });
  rollup = await startRollupFixture({ l2: rig.rpc, l1 });           // the Base "rollup node": E's labelled syncStatus fixture
  cfg = { format: 'enclave-receipt-source/v1', l1: { execution: { url: l1 }, consensus: { url: beacon.url } }, base: { execution: { url: rig.rpc }, rollup: { url: rollup.url } },
    testFixture: { label: 'TEST FIXTURE reth --dev Base execution + anvil L1 + scripted beacon/rollup',
      l1Identity: { chainIdHex: '0x1', elGenesisHash: (await jrpc(l1, 'eth_getBlockByNumber', ['0x0', false])).hash, clGenesisValidatorsRoot: GVR },
      l2Identity: { chainIdHex: '0x2105', genesisHash: (await jrpc(rig.rpc, 'eth_getBlockByNumber', ['0x0', false])).hash } } };
  cfgFile = path.join(TMP, 'receipt-source.json'); fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const { testFixture, ...prod } = cfg;
  prodFile = path.join(TMP, 'receipt-source-production.json'); fs.writeFileSync(prodFile, JSON.stringify(prod));
  source = createReceiptSource(loadReceiptSourceConfig(cfgFile));
  await settled(last);
});
test.after(async () => {
  for (const s of servers) try { s.closeAllConnections?.(); s.close(); } catch {}
  helios?.kill('SIGKILL'); l1proc?.kill('SIGKILL'); beacon?.close(); rollup?.close();
  await gateway?.close(); feed?.srv.close(); proxy?.srv.close();
  await rig?.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});
const walletOf = (account) => createWalletClient({ account, chain: rigChain, transport: viemHttp(rig.rpc) });
let funding = Promise.resolve();
const fund = (address, wei = 10n ** 19n) => (funding = funding.then(async () => {
  const rc = await rig.pc.waitForTransactionReceipt({ hash: await rig.wc(KEYS.deployer).sendTransaction({ to: address, value: wei }) });
  if (rc.status !== 'success') throw new Error('funding failed'); return rc;
}));
const newAcct = async () => { const a = privateKeyToAccount(generatePrivateKey()); await settled(await fund(a.address)); return a; };
/** a receipt source from a config FILE (the real load path) */
const sourceFrom = (name, c) => { const f = path.join(TMP, name); fs.writeFileSync(f, JSON.stringify(c)); return createReceiptSource(loadReceiptSourceConfig(f)); };
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
const chainWith = (src, tx = rig.rpcs[2]) => independentChain({ chainVerifier: heliosUrl, rpcs: [tx], confirmations: 1, maxBlockAgeMs: 600000, receiptSource: src });

// ---- the CLI process (cli/enclave.mjs behind the network guard) --------------------------------------------------------
function cli(args, { tx = rig.rpcs[0], rs = cfgFile, fixtureEnv = true, key = KEYS.owner } = {}) {
  const base = ['--independent', '--contract-pins', pinsFile, '--usdc-token', rig.addresses.usdc, '--confirmations', '1', '--yes', '--chain-verifier', heliosUrl,
    ...(tx ? ['--rpc', tx] : []), ...(rs ? ['--receipt-source', rs] : [])];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, ...base], { cwd: TMP, env: { PATH: process.env.PATH, HOME: TMP, XDG_CONFIG_HOME: path.join(TMP, 'conf'),
      ENCLAVE_SESSION_DIR: path.join(TMP, 'sessions'), ENCLAVE_KEY: key, ENCLAVE_API_BASE: rig.apiOrigin, NODE_OPTIONS: `--import=${GUARD}`,
      ENCLAVE_TEST_NET_LOG: netLog, ENCLAVE_TEST_DENY_PORT: String(rig.apiPort), ...(fixtureEnv ? { [FIXTURE_ENV]: '1' } : {}) } });
    let out = '', err = '';
    const killer = setTimeout(() => { err += '\n[test: CLI killed after 150 s]'; p.kill('SIGKILL'); }, 150000);
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { clearTimeout(killer); resolve({ code, out, err, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }); });
  });
}
const ledgerGet = (id) => rig.pc.readContract({ address: rig.addresses.ledger, abi: rig.A.ledger.abi, functionName: 'get', args: [id] });
const VERIFIED_LINE = /TEST FIXTURE - success in block \d+: receipt minted by the local Base node source \(verifiedBy 'base-derivation', trust 'test-fixture', level 'unsafe'\); hash, sender and nonce bound to the signed transaction/;

test('CLI, real config path: --receipt-source FILE; readiness verbatim; a send reported from the MINTED receipt; fixture trust refused outside a harness; a production config refuses this rig', T, async () => {
  const id = rig.createdId(await rig.create(KEYS.owner)); await settled({ blockNumber: await rig.pc.getBlockNumber() });
  const st = await cli(['receipt-source', 'status']);
  assert.equal(st.code, 0, st.err + st.out);
  assert.match(st.out, /trust 'test-fixture': TEST FIXTURE: not production/);
  assert.match(st.out, /L1 pair: ready/); assert.match(st.out, /Base node: ready/); assert.match(st.out, /ok {3}l2\.l1view/); assert.match(st.out, /ok {3}pair\.finalized/);
  const stop = await cli(['stop', id]);
  assert.equal(stop.code, 0, stop.err + stop.out);
  assert.match(stop.err, /receipts \(inclusion, status, level\) only from the receipt source: TEST FIXTURE/);
  assert.match(stop.err, VERIFIED_LINE);
  assert.equal((await ledgerGet(id)).active, false);
  // the same config without the harness switch: refused before anything is read or sent
  const noEnv = await cli(['resume', id], { fixtureEnv: false });
  assert.notEqual(noEnv.code, 0); assert.match(noEnv.err + noEnv.out, /refused outside a test harness/);
  assert.equal((await ledgerGet(id)).active, false, 'nothing was sent');
  // a PRODUCTION config (mainnet identities, peers required) against this rig: not ready, and it says exactly why
  const prod = await cli(['receipt-source', 'status'], { rs: prodFile });
  assert.equal(prod.code, 1, prod.err + prod.out);
  assert.match(prod.out, /trust 'local-validated-pair': local full-node validation \(not a portable cryptographic proof\)/);
  for (const c of ['el.genesis', 'el.peers', 'cl.genesis', 'l2.genesis']) assert.match(prod.out, new RegExp(`FAIL ${c.replace('.', '\\.')}:`), c);
  // --receipt-source without --chain-verifier is refused
  const nov = await new Promise((resolve) => { const p = spawn(process.execPath, [CLI, 'ls', '--independent', '--contract-pins', pinsFile, '--rpc', `${rig.rpcs[0]},${rig.rpcs[1]}`, '--receipt-source', cfgFile],
    { cwd: TMP, env: { PATH: process.env.PATH, HOME: TMP, NODE_OPTIONS: `--import=${GUARD}`, ENCLAVE_TEST_NET_LOG: netLog, [FIXTURE_ENV]: '1' } });
    let e = ''; p.stderr.on('data', (d) => (e += d)); p.on('close', (code) => resolve({ code, e })); });
  assert.notEqual(nov.code, 0); assert.match(nov.e, /--receipt-source needs --chain-verifier/);
});

// ---- the external signer ----------------------------------------------------------------------------------------------
/** a JSON-RPC wallet: signs (eth_signTransaction) with `account`; `beforeSign` runs first; `send` (eth_sendTransaction) optional */
async function wallet(account, { beforeSign = null, send = null } = {}) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const m = JSON.parse(b); calls.push(m.method);
    const answer = async () => {
      if (m.method === 'eth_accounts') return { result: [account.address] };
      if (m.method === 'eth_chainId') return { result: '0x2105' };
      if (m.method === 'eth_signTransaction') { const p = m.params[0]; if (beforeSign) await beforeSign(p);
        return { result: await account.signTransaction({ type: 'eip1559', chainId: Number(p.chainId), nonce: Number(p.nonce), to: p.to, value: BigInt(p.value), data: p.data,
          gas: BigInt(p.gas), maxFeePerGas: BigInt(p.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas) }) }; }
      if (m.method === 'eth_sendTransaction' && send) return { result: await send(m.params[0]) };
      return { error: { code: -32601, message: `the method ${m.method} does not exist/is not available` } };
    };
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...(await answer()) }));
  });
  servers.push(srv); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}/rpc`, calls };
}
const signerFor = (account, url, o = {}) => createExternalSigner({ url, from: account.address, chainId: 8453, journalDir: fs.mkdtempSync(path.join(TMP, 'journal-')), approvalTimeoutMs: 8000, probeTimeoutMs: 4000, ...o });
const WAIT = { timeoutMs: 120000, pollMs: 1000 };
const journalFile = (s, id) => fs.readFileSync(path.join(s.journal.dir, `${id}.json`), 'utf8');

test('external signer with the receipt source: confirmed only on a minted, bound receipt; a REAL revert is "reverted" from that receipt; the journal never persists evidence', T, async () => {
  const account = await newAcct(), SINK = '0x' + '5b'.repeat(20), chain = chainWith(source);
  const w = await wallet(account);
  // success
  const s1 = signerFor(account, w.url);
  const r1 = await s1.sendQuorumTx(chain, { to: SINK, value: 3n, ...WAIT });
  assert.equal(r1.evidence.receiptVerified, true); assert.equal(r1.evidence.status, 'success'); assert.equal(r1.evidence.trust, TRUST.TEST_FIXTURE); assert.equal(r1.evidence.level, 'unsafe');
  assert.equal(acceptEvidence(r1.evidence.receiptEvidence, 'l2-receipt', { acceptTrust: [TRUST.TEST_FIXTURE] }, 'x'), 'minted', 'the minted receipt itself, by reference');
  assert.equal(r1.evidence.transaction.from, lc(account.address)); assert.equal(r1.evidence.transaction.hash, lc(r1.transactionHash));
  const j1 = s1.journal.get(r1.intent);
  assert.equal(j1.state, 'confirmed'); assert.equal(j1.evidence.receiptVerified, true); assert.equal(j1.evidence.trust, 'test-fixture');
  const persisted = journalFile(s1, r1.intent);
  assert.doesNotMatch(persisted, /"receiptEvidence"|"kind":\s*"l2-receipt"|"heads"/, 'the journal keeps the facts (text and numbers), never the minted evidence object');
  assert.match(JSON.parse(persisted).evidence.receipt, VERIFIED_LINE);
  assert.equal(await rig.pc.getBalance({ address: SINK }), 3n);
  // a REAL on-chain revert: the verified simulation passes, then (before the wallet answers) an allowance holder drains the
  // balance, so the signed transfer is mined and reverts
  const usdc = rig.addresses.usdc, U = rig.A.usdc.abi, drainer = rig.wc(KEYS.deployer);
  await settled(await rig.write(drainer, usdc, U, 'mint', [account.address, 5_000000n]));
  await settled(await rig.pc.waitForTransactionReceipt({ hash: await walletOf(account).writeContract({ address: usdc, abi: U, functionName: 'approve', args: [privateKeyToAccount(KEYS.deployer).address, maxUint256] }) }));
  const drain = async () => { await rig.write(drainer, usdc, U, 'transferFrom', [account.address, '0x' + '5c'.repeat(20), await rig.pc.readContract({ address: usdc, abi: U, functionName: 'balanceOf', args: [account.address] })]); };
  const w2 = await wallet(account, { beforeSign: drain });
  const s2 = signerFor(account, w2.url), n0 = await rig.pc.getTransactionCount({ address: account.address });
  const e2 = await s2.sendQuorumTx(chain, { to: usdc, data: encodeFunctionData({ abi: U, functionName: 'transfer', args: [SINK, 1_000000n] }), ...WAIT }).catch((x) => x);
  assert.equal(e2.mined, true, String(e2?.message)); assert.match(e2.message, /transaction reverted: .*TEST FIXTURE - reverted in block \d+: receipt minted by the local Base node source/);
  assert.equal(e2.evidence.receiptVerified, true); assert.equal(e2.evidence.status, 'reverted');
  const j2 = s2.journal.get(e2.intent);
  assert.equal(j2.state, 'reverted'); assert.equal(j2.note, undefined, 'a revert from a minted receipt carries no transport caveat');
  assert.equal(await rig.pc.getTransactionCount({ address: account.address }), n0 + 1);
  assert.equal((await rig.pc.getTransactionReceipt({ hash: j2.hash })).status, 'reverted', 'the chain agrees: it reverted');
});

test('unknown outcomes and untrusted sources: a swallowed send, a source deriving from ANOTHER L1, a Base node that alters receipts and a not-ready source never yield "confirmed"; the same bytes or the good source then decide it', T, async () => {
  const account = await newAcct(), SINK = '0x' + '5d'.repeat(20), good = chainWith(source);
  const w = await wallet(account);
  // 1. a transport that accepts the send but never forwards it: the source never shows it -> unknown; rebroadcast -> confirmed
  const swallow = await swallowingTransport();
  const s1 = signerFor(account, w.url);
  const e1 = await s1.sendQuorumTx(chainWith(source, swallow), { to: SINK, value: 1n, timeoutMs: 15000, pollMs: 1000 }).catch((x) => x);
  assert.equal(e1.outcomeUnknown, true, String(e1?.message)); assert.match(String(e1.cause?.message), /has not shown it included/);
  assert.equal(s1.journal.get(e1.intent).state, 'unknown');
  const open = await resolveIntent(good, s1.journal, e1.intent);
  assert.equal(open.open, true); assert.match(open.note, /unused in verified state .* does not show .* included/);
  const r1 = await rebroadcast(good, s1.journal, e1.intent, WAIT);
  assert.equal(r1.evidence.receiptVerified, true); assert.equal(s1.journal.get(e1.intent).state, 'confirmed');
  assert.equal(s1.journal.get(e1.intent).hash, lc(r1.transactionHash), 'the same signed bytes, never re-signed');
  // 2. a Base rollup node deriving from ANOTHER L1 (its L1 view is not in our L1 pair): not ready -> unknown, never confirmed
  const foreignRollup = await startRollupFixture({ l2: rig.rpc, l1 });
  foreignRollup.state.l1Override = { hash: '0x' + 'ab'.repeat(32), number: 1, parentHash: '0x' + '00'.repeat(32), timestamp: Math.floor(Date.now() / 1000) };
  const foreign = sourceFrom('foreign.json', { ...cfg, base: { ...cfg.base, rollup: { url: foreignRollup.url } } });
  const s2 = signerFor(account, w.url);
  const e2 = await s2.sendQuorumTx(chainWith(foreign), { to: SINK, value: 2n, timeoutMs: 12000, pollMs: 1000 }).catch((x) => x);
  assert.equal(e2.outcomeUnknown, true, String(e2?.message)); assert.match(String(e2.cause?.message), /another L1 source/);
  assert.equal(s2.journal.get(e2.intent).state, 'unknown');
  assert.equal((await resolveIntent(good, s2.journal, e2.intent)).state, 'confirmed', 'the good source decides the transaction that did land');
  foreignRollup.close();
  // 3. a Base execution node that ALTERS receipts (another sender): minted from its answer, but not bound -> unknown at once
  const altering = await editingProxy(rig.rpc, async (m, p, r) => (m === 'eth_getTransactionReceipt' && r ? { ...r, from: '0x' + '99'.repeat(20) } : r));
  const alteringSrc = sourceFrom('altering.json', { ...cfg, base: { ...cfg.base, execution: { url: altering } } });
  const s3 = signerFor(account, w.url);
  const e3 = await s3.sendQuorumTx(chainWith(alteringSrc), { to: SINK, value: 3n, timeoutMs: 60000, pollMs: 1000 }).catch((x) => x);
  assert.equal(e3.outcomeUnknown, true, String(e3?.message)); assert.match(String(e3.cause?.message), /receipt source refused it \(receipt-sender/);
  assert.equal(s3.journal.get(e3.intent).state, 'unknown');
  assert.equal((await resolveIntent(good, s3.journal, e3.intent)).state, 'confirmed');
  // 4. a source that is not ready (its rollup node is down): unknown with the readiness checks, never confirmed
  const down = sourceFrom('down.json', { ...cfg, base: { ...cfg.base, rollup: { url: `http://127.0.0.1:${await freePort()}` } } });
  const s4 = signerFor(account, w.url);
  const e4 = await s4.sendQuorumTx(chainWith(down), { to: SINK, value: 4n, timeoutMs: 8000, pollMs: 1000 }).catch((x) => x);
  assert.equal(e4.outcomeUnknown, true, String(e4?.message)); assert.match(String(e4.cause?.message), /l2-source-not-ready: .*l2\.syncStatus/);
  assert.equal(s4.journal.get(e4.intent).state, 'unknown');
  assert.equal((await resolveIntent(good, s4.journal, e4.intent)).state, 'confirmed');
});

test('identity: a wallet that sends CHANGED fields is "mismatch" from the minted receipt; a hash of another sender or another nonce is never confirmed', T, async () => {
  const account = await newAcct(), other = await newAcct(), SINK = '0x' + '5e'.repeat(20), chain = chainWith(source);
  // wallet-send: the wallet broadcasts the prepared transaction itself, but with value + 1 (same sender and nonce)
  const changed = await wallet(account, { send: async (p) => walletOf(account).sendTransaction({ to: p.to, data: p.data, value: BigInt(p.value) + 1n, nonce: Number(p.nonce), gas: BigInt(p.gas),
    maxFeePerGas: BigInt(p.maxFeePerGas), maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas) }) });
  const s1 = signerFor(account, changed.url, { mode: 'wallet-send' });
  const e1 = await s1.sendQuorumTx(chain, { to: SINK, value: 5n, ...WAIT }).catch((x) => x);
  assert.equal(e1.code, 'mismatch', String(e1?.message)); assert.match(e1.message, /THE WALLET SENT A DIFFERENT TRANSACTION .*value 6 != intended 5.*TEST FIXTURE - success in block/);
  const j1 = s1.journal.list()[0];
  assert.equal(j1.state, 'mismatch'); assert.equal(j1.evidence.receiptVerified, true);
  // handoff: attach the hash of ANOTHER sender's transaction -> refused as not this intent's; nothing confirmed
  const s2 = signerFor(account, null, { mode: 'handoff', url: undefined });
  const h = await s2.sendQuorumTx(chain, { to: SINK, value: 7n, ...WAIT }).catch((x) => x);
  assert.equal(h.code, 'handoff', String(h?.message));
  const theirs = await walletOf(other).sendTransaction({ to: SINK, value: 7n });
  await settled(await rig.pc.waitForTransactionReceipt({ hash: theirs }));
  const a = await attachHash(chain, s2.journal, h.intent, theirs, { timeoutMs: 8000, pollMs: 1000 }).catch((x) => x);
  assert.ok(a instanceof Error, 'attach does not confirm another sender\'s transaction');
  const j2 = s2.journal.get(h.intent);
  assert.equal(j2.state, 'unknown'); assert.match(j2.note, /not provably this intent's transaction \(receipt-sender/);
  // the hash of this sender's EARLIER transaction (another nonce) -> refused the same way
  const s3 = signerFor(account, null, { mode: 'handoff', url: undefined });
  const h3 = await s3.sendQuorumTx(chain, { to: SINK, value: 8n, ...WAIT }).catch((x) => x);
  const a3 = await attachHash(chain, s3.journal, h3.intent, j1.hash, { timeoutMs: 8000, pollMs: 1000 }).catch((x) => x);
  assert.ok(a3 instanceof Error);
  assert.match(s3.journal.get(h3.intent).note, /not provably this intent's transaction \(receipt-nonce/);
});

// ---- credit vault ------------------------------------------------------------------------------------------------------
const F = await import('./credit-vault-fixture.mjs');
const CV = await import('../site/js/core/credit-vault-independent.js');
const CVCLI = await import('../cli/credit-vault.mjs');

test('credit-vault CLI with --receipt-source: mint and submit report inclusion from the minted receipt; reconcile names the executing transaction as verified; exact funds', T, async () => {
  const c = { pub: rig.pc, wallet: (k) => walletOf(F.ACCT[k]) };
  const S = await F.deployStack(c);
  const PINS = CV.validatePins({ chainId: 8453, origin: F.ORIGIN, rpId: F.RPID, usdc: S.usdc, factories: [S.older, S.current] });
  const K1 = F.passkey(), dir = fs.mkdtempSync(path.join(TMP, 'cv-'));
  const pins = path.join(dir, 'pins.json'); fs.writeFileSync(pins, JSON.stringify(PINS));
  const keyFile = path.join(dir, 'payer.key'); fs.writeFileSync(keyFile, F.KEYS.payer, { mode: 0o600 });
  const vCur = CV.deriveVault(CVCLI.lib, K1.x, K1.y, S.current);
  await settled(await F.send(c, 'admin', S.usdc, F.CHAIN_FX.MockUSDC.abi, 'mint', [vCur, 100_000000n]));
  const cv = async (args) => { let o = ''; await CVCLI.main([...args, '--pins', pins, '--chain-verifier', heliosUrl, '--confirmations', '1', '--max-block-age', '600', '--journal-dir', path.join(dir, 'j'),
    '--json', '--rpc', rig.rpcs[1], '--receipt-source', cfgFile], { out: (s) => { o += s; }, env: {} }); return JSON.parse(o); };
  const m = await cv(['mint', '--x', K1.x, '--y', K1.y, '--key-file', keyFile]);
  assert.equal(m.vault, vCur); assert.equal(m.evidence.receiptVerified, true); assert.equal(m.evidence.status, 'success'); assert.equal(m.evidence.effect, 'verified');
  assert.match(m.evidence.receipt, VERIFIED_LINE);
  const d = await cv(['discover', '--x', K1.x, '--y', K1.y]);
  const profile = CV.makeProfile({ ...d.vaults[1], key: { x: K1.x, y: K1.y } }, { credentialId: K1.credentialId, label: 'laptop' }, PINS);
  const profFile = path.join(dir, 'profile.json'); fs.writeFileSync(profFile, JSON.stringify(profile));
  const reader = CVCLI.verifiedCreditReader({ verifier: heliosUrl, chainId: 8453, confirmations: 1 });
  const spec = { appRef: 'catalog://app/0', gpuMilli: 0, cpuMilli: 500, appPort: 8080, ports: '', isPublic: true, configCid: '', maxRate6: '1000' };
  const intent = { op: 'deploy', params: { spec, fundUsd: '30' } };
  const req = await CV.signPrepared(CVCLI.lib, await CV.prepareVaultOp(CVCLI.lib, profile, 'deploy', intent.params, { reader, pins: PINS, journal: F.memJournal() }), profile, { pins: PINS, origin: F.ORIGIN, getFn: K1.getFn(), intent });
  const reqFile = path.join(dir, 'request.json'); fs.writeFileSync(reqFile, JSON.stringify(req));
  const sub = await cv(['submit', reqFile, '--key-file', keyFile]);
  assert.equal(sub.submit, 'broadcast'); assert.equal(sub.outcome.status, 'executed');
  assert.match(sub.outcome.evidence.execution, /^TEST FIXTURE - success in block \d+: receipt minted by the local Base node source .*; its signed bytes call this vault with exactly the signed request$/);
  assert.equal(sub.outcome.evidence.trust, 'test-fixture'); assert.equal(sub.outcome.evidence.level, 'unsafe');
  const rc = await rig.pc.getTransactionReceipt({ hash: sub.txHash });
  const ev = rc.logs.filter((l) => lc(l.address) === profile.vault).map((l) => { try { return decodeEventLog({ abi: parseAbi(['event Deployed(bytes32 indexed id, uint256 funded6)']), ...l }); } catch { return null; } }).find(Boolean);
  assert.equal((await F.recordOf(c, S.ledger, ev.args.id)).balance6, 30_000000n); assert.equal(await F.usdcOf(c, S, profile.vault), 70_000000n);
  assert.equal((await cv(['reconcile', '--profile', profFile])).status, 'none');
});
