// COMPOSED: Helios's ACTUAL historical path through the PACKAGED public-rpc role. Asked for state at a block it never
// received as a head (EIP-1898 {blockHash}), B's pinned Helios (helios-eeffcc9) asks its execution source for the FULL
// block by hash (eth_getBlockByHash [h, true]; B test/helios-block-failover.e2e at 673601e54), then proves that block's
// hash with an EIP-2935 history proof (eth_getProof of 0x0000F908...2935, slot n % 8191) at its own signed head, then
// reads state at the block with proofs. Chain of custody, exactly as test/public-rpc-witness-consumer.e2e:
//   Helios --execution-rpc--> B's witness gateway (consumers/b-673601e5, hash-pinned; its ONLY upstream) --> the packaged
//   role under the runner --> fault proxy --> reth v2.8.0 --dev on B's EIP-2935 genesis (pinned).
// The gateway verifies the full block with witness-check (the header must hash to the requested hash; the body must pass
// OpStack validate_block), the history proof against the signed head's state root, and state witnesses against a root
// bound by authenticated ancestry. The role verifies none of it and labels it proof-material-unverified.
// TEST-ONLY HEAD AUTHORITY: the feed signs local blocks with a TEST sequencer key (0x5e..5e) that helios.toml trusts. This
// is not Base's production sequencer path (B's gossip listener); only the execution-source interface is under test.
//   - positive: calls at never-delivered blocks equal the chain at those blocks; the role served every request of the path
//     (full block, history proof, state witnesses, headers), and refused none;
//   - tampered transactions, a tampered full-block header, a tampered EIP-2935 history proof, the node down: refused by
//     the consumer, and the same block then answers once the source is honest (nothing poisoned);
//   - Helios's call by block NUMBER (eth_getBlockByNumber [n, true]), receipt path (eth_getTransactionReceipt -> full
//     block by hash -> eth_getBlockReceipts, checked against the receipts root; rpc.rs get_receipt) and log path
//     (eth_getLogs -> full block by number -> eth_getBlockReceipts; rpc.rs verify_logs) equal the chain; tampered receipt
//     metadata, log metadata and transactions in a block by number are refused, then recover;
//   - historical lookup negative: a hash that is no block is refused;
//   - control: the previous package (4f7632d7, 78f06b5b) refuses full blocks and block receipts, so these paths could not
//     work through it.
//   env: RETH_BIN, HELIOS_BASE_BIN, WITNESS_CHECK_BIN (pinned below), CONSUMERS (default ../consumers), CONTROL_PKG (the
//   78f06b5b build; default ../controls/pkg-78f06b5b). Run inside `unshare -r -n`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, http as viemHttp, encodeFunctionData, decodeFunctionResult, defineChain, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startRethDev, haveReth, DEV_KEY, freePort, RETH_BIN } from './helpers/reth-dev.mjs';
import { compileProbe } from './helpers/rpc-probe-contract.mjs';
import { startPackagedRole, packagePin, pinnedConsumer, pinnedFile } from './helpers/packaged-rpc-role.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const B_SUMS = '1ec87930d684ac5dd6fb0fd6e7afe51cbfd181aa4efed79aefda7f2759770ff6';
const PIN = { helios: 'cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0', witnessCheck: '4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411',
  reth: '8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250', genesis2935: '99138899e98faa27cdd28c21423d3ae55c36c36b50eb1334c102a1ab937ee319',
  control: { manifest: '78f06b5b546fa2f7d6e57fb4d073e4e12f542cf0886fa1005cc80c51966d6319', bundle: 'b1e8f62e12ef152b5e5adbfee43a5bffd4a3d67694c72df9ea5d98505884ea81' } };
const HISTORY = '0x0000f90827f1c53a10cb7a02335b175320002935';
const GENESIS_2935 = path.join(HERE, 'fixtures/reth-dev-8453-genesis-2935.json');
const CONTROL_PKG = path.resolve(process.env.CONTROL_PKG || path.join(HERE, '../../controls/pkg-78f06b5b'));
const { HELIOS_BASE_BIN, WITNESS_CHECK_BIN } = process.env;
const skip = haveReth() || (!HELIOS_BASE_BIN && 'HELIOS_BASE_BIN not set') || (!WITNESS_CHECK_BIN && 'WITNESS_CHECK_BIN not set') || (!packagePin() && 'needs the built packages') || false;
const chain = defineChain({ id: 8453, name: 'base-dev', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1'] } } });
const SEQ_KEY = '0x' + '5e'.repeat(32), seqSigner = privateKeyToAccount(SEQ_KEY).address;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let reth, probe, proxy, role, feed, gateway, gatewayUrl, checker, roots, helios, heliosUrl, pc, wc, B, TMP;
let mode = 'ok', target = null;      // {hash, number} of the block a fault applies to
const nodeSeen = [];          // what the role forwarded to the node: [method, params]
const roleSeen = [];          // what the gateway asked the role, and how the role answered: {method, params, status, code, cls}
const blocks = {};            // name -> { number, hash, value }: blocks Helios never received as heads

async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
  return { status: r.status, headers: r.headers, ...(await r.json()) };
}
const ok = async (url, method, params) => { const j = await rpc(url, method, params); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const heliosHead = async () => BigInt(await ok(heliosUrl, 'eth_blockNumber'));
async function untilHelios(n, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await heliosHead() >= BigInt(n)) return; } catch {} await sleep(300); }
  throw new Error(`helios did not reach block ${n}`);
}
const value = () => encodeFunctionData({ abi: probe.abi, functionName: 'value' });
const valueAt = (hash) => rpc(heliosUrl, 'eth_call', [{ to: probe.address, data: value() }, { blockHash: hash }]);
const decodeValue = (data) => decodeFunctionResult({ abi: probe.abi, functionName: 'value', data });
async function poke(n) {
  const h = await wc.writeContract({ address: probe.address, abi: probe.abi, functionName: 'poke', args: [n] });
  const rc = await pc.waitForTransactionReceipt({ hash: h });
  return { number: rc.blockNumber, hash: rc.blockHash, value: n, tx: h };
}
const asks = (from, pred) => roleSeen.slice(from).filter(pred);
const servedAll = (from, what) => assert.deepEqual(roleSeen.slice(from).filter((x) => x.code !== null || x.status !== 200).map((x) => [x.method, x.status, x.code]), [], `${what}: the role refused nothing this path needed`);
const fullBlockAsks = (hash) => roleSeen.filter((r) => r.method === 'eth_getBlockByHash' && r.params[0].toLowerCase() === hash.toLowerCase() && r.params[1] === true);

// the operator's node behind a fault proxy. Faults apply to the `target` block only (or the history proof):
//   tamper-txs (a transaction's input in the full block; its hash field kept) | tamper-full-header (the full block's
//   stateRoot; its hash field kept) | tamper-history (the EIP-2935 proof's storage value) | down
function startProxy() {
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const q = JSON.parse(body); nodeSeen.push([q.method, q.params]);
    if (mode === 'down') return req.socket.destroy();
    const j = await (await fetch(reth.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json();
    const full = (q.method === 'eth_getBlockByHash' || q.method === 'eth_getBlockByNumber') && q.params[1] === true && j.result && target && j.result.hash.toLowerCase() === target.hash.toLowerCase();
    const flip = (hex) => hex.slice(0, -2) + (hex.endsWith('00') ? '01' : '00');
    if (mode === 'tamper-txs' && full) { const t = j.result.transactions[0]; t.input = flip(t.input); }
    if (mode === 'tamper-full-header' && full) j.result.stateRoot = '0x' + '66'.repeat(32);
    const receiptsOfTarget = q.method === 'eth_getBlockReceipts' && Array.isArray(j.result) && target && j.result[0]?.blockHash?.toLowerCase() === target.hash.toLowerCase();
    if (mode === 'tamper-receipts' && receiptsOfTarget) for (const x of j.result) x.cumulativeGasUsed = '0x' + (BigInt(x.cumulativeGasUsed) + 1n).toString(16);
    if (mode === 'tamper-receipt-logs' && receiptsOfTarget) for (const x of j.result) for (const l of x.logs) l.data = flip(l.data);
    if (mode === 'tamper-logs' && q.method === 'eth_getLogs' && Array.isArray(j.result)) for (const l of j.result) l.data = flip(l.data);
    if (mode === 'tamper-history' && q.method === 'eth_getProof' && String(q.params[0]).toLowerCase() === HISTORY && j.result?.storageProof)
      for (const s of j.result.storageProof) s.value = '0x' + '77'.repeat(32);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}
// TEST-ONLY head source (as B's E2E): every local block in order from near the head, signed by the test key, bound first
function startFeed() {
  let served = 0n, current = null;
  const srv = http.createServer(async (q, res) => {
    if (q.url === '/chain_id') return res.end('8453');
    try {
      const latest = BigInt(await ok(reth.url, 'eth_blockNumber'));
      if (served === 0n && latest > 3n) served = latest - 3n;
      if (served < latest) {
        const n = served + 1n;
        const b = await ok(reth.url, 'eth_getBlockByNumber', [toHex(n), false]);
        const txs = await Promise.all(b.transactions.map((h) => ok(reth.url, 'eth_getRawTransactionByHash', [h])));
        current = await B.makeCommitment(B.blockFields(b), { chainId: 8453, privateKey: SEQ_KEY, txs, ...(b.parentBeaconBlockRoot ? { parentBeaconRoot: b.parentBeaconBlockRoot } : {}) });
        await roots.offer(current);
        served = n;
      }
    } catch {}
    res.end(JSON.stringify(current));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/`, served: () => served })));
}
// the gateway's transport to the role, recorded with the role's answer (status, JSON-RPC error code, class label)
async function recordingFetch(url, opts) {
  const res = await fetch(url, opts);
  let q = null; try { q = JSON.parse(opts.body); } catch {}
  for (const x of [q].flat()) if (x?.method) {
    const body = await res.clone().json().catch(() => null);
    roleSeen.push({ method: x.method, params: x.params, status: res.status, code: [body].flat()[0]?.error?.code ?? null, cls: res.headers.get('x-enclave-rpc-class') });
  }
  return res;
}

before(async () => {
  if (skip) return;
  pinnedFile(HELIOS_BASE_BIN, PIN.helios); pinnedFile(WITNESS_CHECK_BIN, PIN.witnessCheck); pinnedFile(RETH_BIN, PIN.reth); pinnedFile(GENESIS_2935, PIN.genesis2935);
  pinnedFile(path.join(CONTROL_PKG, 'public-rpc.package.json'), PIN.control.manifest); pinnedFile(path.join(CONTROL_PKG, 'public-rpc.mjs'), PIN.control.bundle);
  const dir = pinnedConsumer('b-673601e5', B_SUMS);
  const imp = (rel) => import(pathToFileURL(path.join(dir, rel)).href);
  const [G, V, OC] = await Promise.all([imp('network/witness-gateway.mjs'), imp('network/witness-verify.mjs'), imp('test/fixtures/op-commitment.mjs')]);
  B = { ...G, ...V, ...OC };
  TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'rpc-history-'));
  reth = await startRethDev({ blockTime: '1s', genesis: GENESIS_2935 });
  pc = createPublicClient({ chain, transport: viemHttp(reth.url) });
  wc = createWalletClient({ chain, account: privateKeyToAccount(DEV_KEY), transport: viemHttp(reth.url) });
  while (await pc.getBlockNumber() < 3n) await sleep(300);
  assert.notEqual(await pc.getCode({ address: HISTORY }), undefined, 'the genesis carries the EIP-2935 history contract');
  probe = compileProbe();
  const rc = await pc.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: probe.abi, bytecode: probe.bytecode }) });
  probe.address = rc.contractAddress;
  blocks.deploy = { number: rc.blockNumber, hash: rc.blockHash, value: 42n };
  // every block under test exists BEFORE the head feed starts: none is ever delivered to Helios as a head
  for (const [name, n] of [['positive', 11n], ['txs', 12n], ['header', 13n], ['history', 14n], ['down', 15n], ['bynumber', 16n], ['receipt', 17n], ['logs', 18n],
    ['receipt-tamper', 19n], ['logs-tamper', 20n], ['receipt-logs-tamper', 21n], ['bynumber-tamper', 22n]]) blocks[name] = await poke(n);
  while (await pc.getBlockNumber() < blocks['bynumber-tamper'].number + 4n) await sleep(300);
  proxy = await startProxy();
  // RATE SIZING (measured here, h2): one historical call through the gateway cost 28-98 requests to the role (Helios
  // re-fetches the full block and its EIP-2935 proof per lookup; the first walk adds ancestry headers), so the default
  // aggregate bucket (50/s, burst 100) refused it with 429 - fail-closed, but unusable. An operator serving a light-client
  // consumer states larger, still bounded, limits; these are the ones under test.
  role = await startPackagedRole('history', await freePort(), { node: proxy.url, allowedOrigins: ['https://dashboard.example'], limits: { perSecond: 500, burst: 1000 } });
  checker = B.createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: seqSigner });
  roots = B.createRootStore({ checker });
  gateway = B.createWitnessGateway({ upstreams: [role.url], proofs: { checker, roots }, methods: B.WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList'), fetch: recordingFetch });
  gatewayUrl = await gateway.listen(0);
  feed = await startFeed();
  const home = path.join(TMP, 'home'); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${seqSigner}"\n`);
  const port = await freePort();
  helios = spawn(HELIOS_BASE_BIN, ['opstack', '--network', 'base', '--consensus-rpc', feed.url, '--execution-rpc', gatewayUrl, '--rpc-port', String(port)], { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  heliosUrl = `http://127.0.0.1:${port}/`;
  await untilHelios((await pc.getBlockNumber()) + 1n);
  assert.ok(feed.served() > blocks['bynumber-tamper'].number + 1n, 'every block under test is older than the first signed head');
});
after(async () => {
  helios?.kill('SIGKILL');
  await gateway?.close(); feed?.srv.close(); checker?.close?.();
  await role?.stop(); proxy?.srv.closeAllConnections?.(); proxy?.srv.close(); reth?.stop();
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
});

test('Helios\'s historical path through the role: full block by hash, EIP-2935 history proof at the signed head, state at the block - equal to the chain; the role refused nothing', { skip, timeout: 240_000 }, async (t) => {
  for (const name of ['deploy', 'positive']) {
    const b = blocks[name], from = roleSeen.length;
    const r = await valueAt(b.hash);
    t.diagnostic(`${name} ${b.number}: ${JSON.stringify(roleSeen.slice(from).map((x) => [x.method, JSON.stringify(x.params).slice(0, 90), x.status, x.code]))}`);
    assert.ok(!r.error, `${name}: ${JSON.stringify(r.error)}`);
    assert.equal(decodeValue(r.result), b.value, `${name}: the state at block ${b.number}`);
    const asked = roleSeen.slice(from);
    assert.ok(asked.some((x) => x.method === 'eth_getBlockByHash' && x.params[0].toLowerCase() === b.hash.toLowerCase() && x.params[1] === true && x.status === 200 && x.cls === 'proof-material-unverified'),
      `${name}: the full block by hash came from the role, labelled unverified`);
    const hist = asked.filter((x) => x.method === 'eth_getProof' && x.params[0].toLowerCase() === HISTORY);
    assert.ok(hist.some((x) => x.params[1].some((k) => BigInt(k) === b.number % 8191n) && x.status === 200), `${name}: the EIP-2935 history proof of slot ${b.number % 8191n}`);
    assert.ok(asked.some((x) => x.method === 'eth_getProof' && x.params[0].toLowerCase() === probe.address.toLowerCase()), `${name}: state witnesses at the block`);
    assert.deepEqual(asked.filter((x) => x.code !== null || x.status !== 200).map((x) => [x.method, x.status, x.code]), [], `${name}: the role refused nothing this path needed`);
  }
  const st = gateway.stats();
  assert.ok(st.blocksFull >= 2 && Object.values(st.upstream)[0].blockOk >= 2 && Object.values(st.upstream)[0].blockInvalid === 0, JSON.stringify(st));
  assert.equal(Object.keys(st.upstream).length, 1, 'the role is the only upstream');
  assert.equal(st.blocksHeaderOnly, 0);
});

test('tampered transactions, a tampered full-block header, a tampered history proof, the node down: the consumer refuses, then the same block answers once honest', { skip, timeout: 300_000 }, async (t) => {
  for (const [m, name] of [['tamper-txs', 'txs'], ['tamper-full-header', 'header'], ['tamper-history', 'history'], ['down', 'down']]) {
    const b = blocks[name], s0 = Object.values(gateway.stats().upstream)[0];
    target = b; mode = m;
    if (m === 'down') await sleep(2100);                  // past the role's 2 s sync-check cache
    const from = roleSeen.length;
    try {
      const r = await valueAt(b.hash);
      assert.ok(r.error && r.result === undefined, `${m}: refused, ${JSON.stringify(r).slice(0, 300)}`);
      t.diagnostic(`${m}: Helios refused: ${r.error.message.slice(0, 240)}`);
      if (m !== 'down') {
        // the role relayed the tampered material (200, labelled unverified): the refusal is the consumer's verification
        servedAll(from, m);
        const tm = { 'tamper-txs': 'eth_getBlockByHash', 'tamper-full-header': 'eth_getBlockByHash', 'tamper-history': 'eth_getProof' }[m];
        assert.ok(asks(from, (x) => x.method === tm && x.cls === 'proof-material-unverified').length, `${m}: ${tm} was relayed`);
      }
      if (m === 'tamper-txs' || m === 'tamper-full-header') {
        const asked = fullBlockAsks(b.hash);
        assert.ok(asked.length && asked.every((x) => x.status === 200 && x.cls === 'proof-material-unverified'), `${m}: the role passed the node's block on, labelled unverified`);
        assert.ok(Object.values(gateway.stats().upstream)[0].blockInvalid > s0.blockInvalid, `${m}: the gateway found it invalid`);
      }
      if (m === 'down') assert.equal((await fetch(role.url + '/health')).status, 503);
    } finally { mode = 'ok'; target = null; }
    if (m === 'down') await sleep(2100);
    const again = await valueAt(b.hash);
    assert.ok(!again.error, `${m}: recovers (${JSON.stringify(again.error)})`);
    assert.equal(decodeValue(again.result), b.value, `${m}: the honest answer at block ${b.number}, nothing poisoned`);
  }
});

const sameReceipt = (a, b) => ['transactionHash', 'blockHash', 'blockNumber', 'status', 'gasUsed', 'cumulativeGasUsed', 'logsBloom', 'transactionIndex'].every((k) => String(a[k]).toLowerCase() === String(b[k]).toLowerCase())
  && JSON.stringify(a.logs.map((l) => [l.address.toLowerCase(), l.data, l.topics, l.logIndex])) === JSON.stringify(b.logs.map((l) => [l.address.toLowerCase(), l.data, l.topics, l.logIndex]));
const logsAt = (n) => rpc(heliosUrl, 'eth_getLogs', [{ address: probe.address, fromBlock: toHex(n), toBlock: toHex(n) }]);

test('Helios\'s historical call by NUMBER, receipt and log paths through the role: full blocks by hash and number, block receipts, all equal to the chain', { skip, timeout: 240_000 }, async (t) => {
  // a call at a block NUMBER Helios never held: get_untrusted_block(Number(n), true) -> EIP-2935 proof -> state
  let b = blocks.bynumber, from = roleSeen.length;
  const byNum = await rpc(heliosUrl, 'eth_call', [{ to: probe.address, data: value() }, toHex(b.number)]);
  t.diagnostic('bynumber: ' + JSON.stringify(roleSeen.slice(from).map((x) => [x.method, JSON.stringify(x.params).slice(0, 80), x.status, x.code])));
  assert.ok(!byNum.error, JSON.stringify(byNum.error)); assert.equal(decodeValue(byNum.result), b.value);
  assert.ok(asks(from, (x) => x.method === 'eth_getBlockByNumber' && BigInt(x.params[0]) === b.number && x.params[1] === true && x.cls === 'proof-material-unverified').length, 'the full block by number');
  servedAll(from, 'call by number');
  // the receipt path (rpc.rs get_receipt): receipt -> the full block by hash -> the block's receipts, checked against its root
  b = blocks.receipt; from = roleSeen.length;
  const rc = await rpc(heliosUrl, 'eth_getTransactionReceipt', [b.tx]);
  t.diagnostic('receipt: ' + JSON.stringify(roleSeen.slice(from).map((x) => [x.method, JSON.stringify(x.params).slice(0, 80), x.status, x.code])));
  assert.ok(!rc.error, JSON.stringify(rc.error));
  assert.ok(sameReceipt(rc.result, await ok(reth.url, 'eth_getTransactionReceipt', [b.tx])), 'the receipt equals the chain\'s');
  for (const m of ['eth_getTransactionReceipt', 'eth_getBlockReceipts']) assert.ok(asks(from, (x) => x.method === m).length, m);
  assert.ok(asks(from, (x) => x.method === 'eth_getBlockByHash' && x.params[1] === true).length, 'the full block by hash');
  servedAll(from, 'receipt');
  // the same path for a block Helios HOLDS as a signed head (a fresh transaction): no historical block, receipts only
  const fresh = await poke(99n); await untilHelios(fresh.number + 1n); from = roleSeen.length;
  const rf = await rpc(heliosUrl, 'eth_getTransactionReceipt', [fresh.tx]);
  assert.ok(!rf.error, JSON.stringify(rf.error)); assert.ok(sameReceipt(rf.result, await ok(reth.url, 'eth_getTransactionReceipt', [fresh.tx])));
  assert.ok(asks(from, (x) => x.method === 'eth_getBlockReceipts').length && !asks(from, (x) => x.method === 'eth_getBlockByHash' && x.params[1] === true).length, 'held head: receipts only');
  servedAll(from, 'fresh receipt');
  // the log path (rpc.rs get_logs/verify_logs): logs -> the full block by NUMBER -> its receipts; every log field checked
  b = blocks.logs; from = roleSeen.length;
  const lg = await logsAt(b.number);
  t.diagnostic('logs: ' + JSON.stringify(roleSeen.slice(from).map((x) => [x.method, JSON.stringify(x.params).slice(0, 80), x.status, x.code])));
  assert.ok(!lg.error, JSON.stringify(lg.error));
  const real = await ok(reth.url, 'eth_getLogs', [{ address: probe.address, fromBlock: toHex(b.number), toBlock: toHex(b.number) }]);
  assert.equal(lg.result.length, 1); assert.deepEqual(lg.result.map((l) => [l.transactionHash, l.data, l.logIndex]), real.map((l) => [l.transactionHash, l.data, l.logIndex]));
  for (const m of ['eth_getLogs', 'eth_getBlockReceipts']) assert.ok(asks(from, (x) => x.method === m).length, m);
  servedAll(from, 'logs');
});

test('tampered receipt metadata, log metadata and transactions in a full block by number: the consumer refuses, then the same block answers once honest', { skip, timeout: 300_000 }, async (t) => {
  const cases = [
    ['tamper-receipts', 'receipt-tamper', () => rpc(heliosUrl, 'eth_getTransactionReceipt', [blocks['receipt-tamper'].tx]), (r) => r.result?.transactionHash === blocks['receipt-tamper'].tx],
    ['tamper-logs', 'logs-tamper', () => logsAt(blocks['logs-tamper'].number), (r) => r.result?.length === 1],
    ['tamper-receipt-logs', 'receipt-logs-tamper', () => logsAt(blocks['receipt-logs-tamper'].number), (r) => r.result?.length === 1],
    ['tamper-txs', 'bynumber-tamper', () => rpc(heliosUrl, 'eth_call', [{ to: probe.address, data: value() }, toHex(blocks['bynumber-tamper'].number)]), (r) => r.result && decodeValue(r.result) === blocks['bynumber-tamper'].value],
  ];
  const tampered = { 'tamper-receipts': 'eth_getBlockReceipts', 'tamper-logs': 'eth_getLogs', 'tamper-receipt-logs': 'eth_getBlockReceipts', 'tamper-txs': 'eth_getBlockByNumber' };
  for (const [m, name, ask, good] of cases) {
    target = blocks[name]; mode = m;
    const from = roleSeen.length;
    try {
      const r = await ask();
      assert.ok(r.error && !good(r), `${m}: refused, ${JSON.stringify(r).slice(0, 300)}`);
      t.diagnostic(`${m}: Helios refused: ${r.error.message.slice(0, 240)}`);
      servedAll(from, m);                                 // the role relayed everything with 200: the consumer refused
      assert.ok(asks(from, (x) => x.method === tampered[m]).length, `${m}: ${tampered[m]} was relayed`);
    } finally { mode = 'ok'; target = null; }
    const again = await ask();
    assert.ok(!again.error && good(again), `${m}: recovers, ${JSON.stringify(again).slice(0, 300)}`);
  }
});

test('historical lookup negative: a hash that is no block is refused; the control package (78f06b5b) refuses the full block, so this path never worked through it', { skip, timeout: 120_000 }, async () => {
  const none = '0x' + '5a'.repeat(32);
  const r = await valueAt(none);
  assert.ok(r.error && r.result === undefined, JSON.stringify(r).slice(0, 200));
  assert.ok(roleSeen.some((x) => x.method === 'eth_getBlockByHash' && x.params[0] === none), 'asked, and the node knows no such block');
  // the previous reviewed bundle (pinned bytes), run directly: this tree's runner normalizes the config with the new
  // limits, which the old validator refuses as unknown fields, so the control is the bundle itself on the same node
  const port = await freePort(), cfgFile = path.join(TMP, 'control.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ port, bind: '127.0.0.1', hostId: '0x' + '42'.repeat(32), chainId: 8453, node: proxy.url, allowedOrigins: ['https://dashboard.example'] }));
  const child = spawn(process.execPath, [path.join(CONTROL_PKG, 'public-rpc.mjs'), cfgFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ready, no) => { let out = ''; child.stdout.on('data', (c) => { out += c; if (/"type":"ready"/.test(out)) ready(); }); child.once('exit', (c) => no(new Error('control exited ' + c))); });
  const old = { url: `http://127.0.0.1:${port}`, stop: async () => { child.kill('SIGKILL'); } };
  try {
    const refused = await rpc(old.url, 'eth_getBlockByHash', [blocks.positive.hash, true]);
    assert.equal(refused.error?.code, -32602); assert.match(refused.error.message, /full transaction objects are not served/);
    assert.equal((await rpc(old.url, 'eth_getBlockByNumber', [toHex(blocks.positive.number), true])).error?.code, -32602, 'nor a full block by number');
    assert.equal((await rpc(old.url, 'eth_getBlockReceipts', [blocks.positive.hash])).error?.code, -32601, 'nor block receipts');
    const served = await rpc(role.url, 'eth_getBlockByHash', [blocks.positive.hash, true]);
    assert.equal(served.result?.hash, blocks.positive.hash); assert.equal(served.result.transactions.length, 1);
  } finally { await old.stop(); }
});

test('the node saw only what the role allows: full blocks by number only with a number (never a tag), no pending state, no access-list hint, nothing unserved', { skip }, async () => {
  const { SERVED_METHODS } = await import('../network/public-rpc-config.mjs');
  for (const [m] of nodeSeen) assert.ok(m === 'eth_syncing' || (SERVED_METHODS.includes(m) && m !== 'eth_sendRawTransaction'), 'unexpected ' + m);
  assert.ok(!nodeSeen.some(([m, p]) => m === 'eth_getBlockByNumber' && p[1] === true && !/^0x[0-9a-f]+$/i.test(p[0])), 'a full block by number always names a number');
  assert.ok(!nodeSeen.some(([m, p]) => m === 'eth_getBlockReceipts' && !(typeof p[0] === 'string' || p[0]?.blockHash)), 'receipts by block hash only');
  assert.ok(!nodeSeen.some(([m, p]) => m === 'eth_getProof' && p[2] === 'pending'));
  // every method the gateway asked the role for on these paths is one the role serves
  assert.deepEqual([...new Set(roleSeen.filter((x) => x.code === -32601).map((x) => x.method))], [], 'no method of the path was missing');
});
