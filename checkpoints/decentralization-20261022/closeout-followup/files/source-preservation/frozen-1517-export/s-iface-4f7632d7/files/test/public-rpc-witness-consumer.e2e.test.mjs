// COMPOSED: B's actual fresh-witness path reads proof material and headers through the PACKAGED public-rpc role, whose node
// is the operator's own pinned reth. Chain of custody:
//   Helios (B's pinned helios-eeffcc9, opstack) --execution-rpc--> B's witness gateway (consumers/b-673601e5, git archive of
//   B 673601e54, hash-pinned) --its ONLY upstream--> the packaged role under the runner --> fault proxy --> reth v2.8.0
//   --dev on B's EIP-2935 genesis (pinned).
// The gateway verifies every eth_getProof/eth_getCode witness with B's witness-check helper (pinned) against a state root it
// holds independently: a SIGNED head pushed to its root store, or a header bound by hash to such a head (ancestry via
// eth_getBlockByHash through this role). The role labels those answers X-Enclave-Rpc-Class: proof-material-unverified;
// it never claims they are proofs.
// TEST-ONLY HEAD AUTHORITY: the feed signs each local block with a TEST sequencer key (0x5e..5e, as B's E2E does) and
// Helios trusts that key through helios.toml. This says nothing about the real Base sequencer head path (B's gossip
// listener); only that the role is a usable fresh witness source for the actual gateway and Helios.
//   - fresh state through Helios (eth_call, balance, storage) equals the chain at the same block;
//   - a block older than every signed head is recovered by authenticated ancestry through the role; a tampered header is
//     refused even though the role served it (labelled unverified), and an honest one then recovers;
//   - tampered storage proofs, the node down, a stale node (the role refuses), and a frozen signed head (newer state has
//     no authenticated root) are each REFUSED by the consumer - never answered from anywhere else;
//   - the role was the gateway's only upstream; nothing reached the node that the role does not allow (no full-transaction
//     blocks, no access-list hint, no pending state for proofs).
//   env: RETH_BIN, HELIOS_BASE_BIN, WITNESS_CHECK_BIN (pinned below), CONSUMERS (default ../consumers). Run inside `unshare -r -n`.
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
import { SERVED_METHODS } from '../network/public-rpc-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// B's immutable consumer code and binaries (rpc-runtime-final-integration/bin/PINS.sha256; B fixture at 673601e54)
const B_SUMS = '1ec87930d684ac5dd6fb0fd6e7afe51cbfd181aa4efed79aefda7f2759770ff6';
const PIN = { helios: 'cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0', witnessCheck: '4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411',
  reth: '8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250', genesis2935: '99138899e98faa27cdd28c21423d3ae55c36c36b50eb1334c102a1ab937ee319' };
const GENESIS_2935 = path.join(HERE, 'fixtures/reth-dev-8453-genesis-2935.json');
const { HELIOS_BASE_BIN, WITNESS_CHECK_BIN } = process.env;
const skip = haveReth() || (!HELIOS_BASE_BIN && 'HELIOS_BASE_BIN not set') || (!WITNESS_CHECK_BIN && 'WITNESS_CHECK_BIN not set') || (!packagePin() && 'needs the built packages') || false;
const chain = defineChain({ id: 8453, name: 'base-dev', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1'] } } });
const SEQ_KEY = '0x' + '5e'.repeat(32), seqSigner = privateKeyToAccount(SEQ_KEY).address;
const OWNER = privateKeyToAccount(DEV_KEY).address;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let reth, probe, proxy, role, feed, gateway, gatewayUrl, checker, roots, helios, heliosUrl, pc, wc, B, deployBlock, TMP;
let mode = 'ok';
const nodeSeen = [];          // every request the role forwarded to the node: [method, params]

async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(40000) });
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
const decodeValue = (data) => decodeFunctionResult({ abi: probe.abi, functionName: 'value', data });
async function poke(n) {
  const h = await wc.writeContract({ address: probe.address, abi: probe.abi, functionName: 'poke', args: [n] });
  return (await pc.waitForTransactionReceipt({ hash: h })).blockNumber;
}

// the operator's node behind a fault proxy: ok | tamper (storage proof values) | tamper-header (state root of a header by
// hash) | down | stale (the head's timestamp, so the role's own head-age check refuses)
function startProxy() {
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const q = JSON.parse(body); nodeSeen.push([q.method, q.params]);
    if (mode === 'down') return req.socket.destroy();
    const j = await (await fetch(reth.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).json();
    if (mode === 'tamper' && j.result?.storageProof) for (const s of j.result.storageProof) s.value = '0x' + 'beef'.padStart(40, '1');
    if (mode === 'tamper-header' && q.method === 'eth_getBlockByHash' && j.result) j.result.stateRoot = '0x' + '77'.repeat(32);
    if (mode === 'stale' && q.method === 'eth_getBlockByNumber' && j.result) j.result.timestamp = '0x' + (BigInt(j.result.timestamp) - 10000n).toString(16);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}
// TEST-ONLY head source: every local block in order, signed by the test sequencer key, bound in the root store first
function startFeed() {
  let served = 0n, current = null, frozen = false;
  const srv = http.createServer(async (q, res) => {
    if (q.url === '/chain_id') return res.end('8453');
    try {
      const latest = BigInt(await ok(reth.url, 'eth_blockNumber'));
      if (served === 0n && latest > 3n) served = latest - 3n;
      if (!frozen && served < latest) {
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
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/`, freeze: (v) => { frozen = v; }, served: () => served })));
}

before(async () => {
  if (skip) return;
  pinnedFile(HELIOS_BASE_BIN, PIN.helios); pinnedFile(WITNESS_CHECK_BIN, PIN.witnessCheck); pinnedFile(RETH_BIN, PIN.reth); pinnedFile(GENESIS_2935, PIN.genesis2935);
  const dir = pinnedConsumer('b-673601e5', B_SUMS);
  const imp = (rel) => import(pathToFileURL(path.join(dir, rel)).href);
  const [G, V, OC] = await Promise.all([imp('network/witness-gateway.mjs'), imp('network/witness-verify.mjs'), imp('test/fixtures/op-commitment.mjs')]);
  B = { ...G, ...V, ...OC };
  TMP = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'rpc-witness-'));
  reth = await startRethDev({ blockTime: '1s', genesis: GENESIS_2935 });
  pc = createPublicClient({ chain, transport: viemHttp(reth.url) });
  wc = createWalletClient({ chain, account: privateKeyToAccount(DEV_KEY), transport: viemHttp(reth.url) });
  while (await pc.getBlockNumber() < 3n) await sleep(300);
  probe = compileProbe();
  const rc = await pc.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: probe.abi, bytecode: probe.bytecode }) });
  probe.address = rc.contractAddress; deployBlock = rc.blockNumber;
  const poked = await poke(7n);
  while (await pc.getBlockNumber() < poked + 4n) await sleep(300);    // the first signed head (latest - 2) is past the deploy block
  proxy = await startProxy();
  role = await startPackagedRole('witness', await freePort(), { node: proxy.url, allowedOrigins: ['https://dashboard.example'] });
  checker = B.createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: seqSigner });
  roots = B.createRootStore({ checker });
  // B's runtime default: no access-list hint (rpc-runtime.mjs NO_HINT); the role is the ONLY upstream
  gateway = B.createWitnessGateway({ upstreams: [role.url], proofs: { checker, roots }, methods: B.WITNESS_METHODS.filter((m) => m !== 'eth_createAccessList') });
  gatewayUrl = await gateway.listen(0);
  feed = await startFeed();
  const home = path.join(TMP, 'home'); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${seqSigner}"\n`);
  const port = await freePort();
  helios = spawn(HELIOS_BASE_BIN, ['opstack', '--network', 'base', '--consensus-rpc', feed.url, '--execution-rpc', gatewayUrl, '--rpc-port', String(port)], { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  heliosUrl = `http://127.0.0.1:${port}/`;
  await untilHelios((await pc.getBlockNumber()) + 1n);
});
after(async () => {
  helios?.kill('SIGKILL');
  await gateway?.close(); feed?.srv.close(); checker?.close?.();
  await role?.stop(); proxy?.srv.closeAllConnections?.(); proxy?.srv.close(); reth?.stop();
  if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
});

test('fresh state through Helios: B\'s gateway verifies the role\'s proof material against signed roots; it equals the chain at that block', { skip, timeout: 180_000 }, async () => {
  const at = await heliosHead();
  const tag = toHex(at);
  assert.equal(decodeValue(await ok(heliosUrl, 'eth_call', [{ to: probe.address, data: value() }, tag])), 7n);
  assert.equal(await ok(heliosUrl, 'eth_getBalance', [OWNER, tag]), await ok(reth.url, 'eth_getBalance', [OWNER, tag]));
  assert.equal(BigInt(await ok(heliosUrl, 'eth_getStorageAt', [probe.address, '0x0', tag])), 7n);
  assert.equal(await ok(heliosUrl, 'eth_getCode', [probe.address, tag]), await ok(reth.url, 'eth_getCode', [probe.address, tag]));
  const proofs = nodeSeen.filter(([m]) => m === 'eth_getProof');
  assert.ok(proofs.length > 0, 'the witnesses came through the role from the node');
  assert.ok(proofs.every(([, p]) => p.length === 3 && Array.isArray(p[1]) && p[2] !== 'pending'), 'block-pinned proof requests only');
  const st = gateway.stats().upstream;
  assert.deepEqual(Object.keys(st).length, 1, 'one upstream: the role');
  assert.ok(Object.values(st)[0].ok > 0 && Object.values(st)[0].invalid === 0, JSON.stringify(st));
  // what the role itself says about such an answer: proof material, not verified
  const head = await ok(reth.url, 'eth_getBlockByNumber', ['latest', false]);
  const direct = await rpc(role.url, 'eth_getProof', [probe.address, ['0x0'], head.hash]);
  assert.equal(direct.headers.get('x-enclave-rpc-class'), 'proof-material-unverified'); assert.equal(direct.headers.get('x-enclave-rpc-source'), 'node');
});

test('a block older than every signed head: authenticated ancestry through the role; a tampered header is refused even though the role served it', { skip, timeout: 180_000 }, async () => {
  const older = await ok(reth.url, 'eth_getBlockByNumber', [toHex(deployBlock - 1n), false]);
  const deploy = await ok(reth.url, 'eth_getBlockByNumber', [toHex(deployBlock), false]);
  assert.equal(await roots.rootFor(older.hash), null, 'never signed, never bound yet');
  mode = 'tamper-header';
  try {
    const served = await rpc(role.url, 'eth_getBlockByHash', [older.hash, false]);
    assert.equal(served.result.stateRoot, '0x' + '77'.repeat(32), 'the role passes the node\'s header on unchanged (it verifies nothing) ...');
    assert.equal(served.headers.get('x-enclave-rpc-class'), 'proof-material-unverified', '... and says so');
    const refused = await rpc(gatewayUrl, 'eth_getProof', [probe.address, ['0x0'], { blockHash: older.hash }]);
    assert.ok(refused.error, 'the consumer refuses: ' + JSON.stringify(refused).slice(0, 300));
    assert.equal(await roots.rootFor(older.hash), null, 'no root from a tampered header');
  } finally { mode = 'ok'; }
  const before = nodeSeen.length;
  const got = await ok(gatewayUrl, 'eth_getProof', [probe.address, ['0x0'], { blockHash: deploy.hash }]);
  assert.equal(BigInt(got.storageProof[0].value), 42n, 'the deploy block\'s own state, proven');
  assert.equal((await roots.rootFor(deploy.hash))?.via, 'ancestor');
  assert.ok(nodeSeen.slice(before).some(([m, p]) => m === 'eth_getBlockByHash' && p[1] === false), 'headers by hash through the role');
  assert.equal(BigInt((await ok(gatewayUrl, 'eth_getProof', [probe.address, ['0x0'], older.hash])).storageProof[0].value), 0n, 'a bare block hash (alloy BlockId) too; before the deploy, unset');
});

test('tampered proofs, the node down, a stale node: the consumer refuses fresh state and recovers when the source is honest; nothing answers from elsewhere', { skip, timeout: 240_000 }, async () => {
  const st0 = Object.values(gateway.stats().upstream)[0];
  for (const [m, n] of [['tamper', 8n], ['down', 9n], ['stale', 10n]]) {
    const at = await poke(n);
    const blk = await ok(reth.url, 'eth_getBlockByNumber', [toHex(at), false]);
    await untilHelios(at);
    mode = m;
    if (m !== 'tamper') await sleep(2100);    // past the role's 2 s sync-check cache: the role's own check now sees it
    try {
      const h = await rpc(heliosUrl, 'eth_call', [{ to: probe.address, data: value() }, toHex(at)]);
      assert.ok(h.error, `${m}: Helios refuses (${JSON.stringify(h).slice(0, 200)})`);
      const g = await rpc(gatewayUrl, 'eth_getProof', [probe.address, ['0x0'], { blockHash: blk.hash }]);
      assert.ok(g.error && !g.result, `${m}: the gateway serves no unverified witness`);
      if (m !== 'tamper') assert.equal((await fetch(role.url + '/health')).status, 503, `${m}: the role refuses`);
    } finally { mode = 'ok'; }
    await sleep(2100);    // past the role's 2 s sync-check cache
    assert.equal(decodeValue(await ok(heliosUrl, 'eth_call', [{ to: probe.address, data: value() }, toHex(at)])), n, `${m}: recovers once honest`);
  }
  const st = Object.values(gateway.stats().upstream)[0];
  assert.ok(st.invalid > st0.invalid, 'tampered proofs cost the role its try (invalid)');
  assert.equal(Object.keys(gateway.stats().upstream).length, 1, 'still the only upstream');
});

test('a frozen signed head: newer state has no authenticated root and is refused, although the role serves it as unverified material', { skip, timeout: 120_000 }, async () => {
  feed.freeze(true);
  try {
    const frozenAt = await heliosHead();
    const target = (await pc.getBlockNumber()) + 3n;
    while (await pc.getBlockNumber() < target) await sleep(300);
    const head = await ok(reth.url, 'eth_getBlockByNumber', ['latest', false]);
    assert.ok(BigInt(head.number) > frozenAt + 2n);
    const fromRole = await rpc(role.url, 'eth_getProof', [probe.address, ['0x0'], { blockHash: head.hash }]);
    assert.ok(fromRole.result?.accountProof?.length, 'the role answers the node\'s material ...');
    assert.equal(fromRole.headers.get('x-enclave-rpc-class'), 'proof-material-unverified', '... labelled unverified');
    const newer = roots.stats().ancestryRefused['newer-than-every-bound-head'] || 0;
    const g = await rpc(gatewayUrl, 'eth_getProof', [probe.address, ['0x0'], { blockHash: head.hash }]);
    assert.ok(g.error, 'no signed head covers it: refused, ' + JSON.stringify(g).slice(0, 200));
    assert.equal(await roots.rootFor(head.hash), null);
    assert.ok((roots.stats().ancestryRefused['newer-than-every-bound-head'] || 0) > newer, 'refused as newer than every signed head: ' + JSON.stringify(roots.stats().ancestryRefused));
    assert.ok(await heliosHead() <= frozenAt + 1n, 'Helios does not advance without a signed head');
  } finally { feed.freeze(false); }
});

test('the node saw only what the role allows: block-pinned proofs, headers without transactions, no access-list hint, no pending proofs', { skip }, () => {
  const methods = new Set(nodeSeen.map(([m]) => m));
  for (const m of methods) assert.ok(m === 'eth_syncing' || (SERVED_METHODS.includes(m) && m !== 'eth_sendRawTransaction'), 'unexpected ' + m);   // eth_syncing: the role's own sync check
  assert.ok(!nodeSeen.some(([m, p]) => (m === 'eth_getBlockByHash' || m === 'eth_getBlockByNumber') && p[1] !== false), 'no full-transaction block was fetched');
  assert.ok(!nodeSeen.some(([m, p]) => m === 'eth_getProof' && p[2] === 'pending'));
  assert.ok(!methods.has('eth_createAccessList'));
});
