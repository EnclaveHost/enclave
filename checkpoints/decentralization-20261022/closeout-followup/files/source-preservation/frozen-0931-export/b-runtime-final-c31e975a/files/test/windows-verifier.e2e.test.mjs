// END-TO-END: the Windows node's REAL chain consumers (windows/node/chain.mjs through its shipped admission bundle,
// chain-reader.mjs + host-identity check-endpoint, session-api-auth.mjs in snapshot mode) under ENCLAVE_CHAIN_AUTHORITY=
// verifier, against REAL contracts on a CANONICAL-trie chain (the cli-independent rig on pinned reth --dev, chain id 8453)
// through the patched Helios. Each consumer runs in a child process (test/helpers/windows-chain-driver.mjs) with a
// counting loopback stand-in as BASE_RPCS: it must stay at zero. Positive reads equal the chain; admin AddressBook
// migration is followed and an outsider cannot repoint it; a session the owner terminates is refused on the next request;
// tampered or missing witnesses and a stale head refuse with no provider fallback.
// TEST-SIGNED HEAD (a local sequencer key in helios.toml), not real Base; NON-NATIVE: Node on Linux, not a Windows host.
// COMPOSED with the proof-aware gateway (witness-failover ce7c1b73 and later), which serves no unverified witness: the
// gateway gets the witness-check helper and a root store, the head feed pushes each signed head to the root store before
// serving it, and signs the block's real parent beacon root (so a commitment's hash matches its contents).
//   env: RIG_CHAIN_NODE=reth (+ RIG_RETH_*), HELIOS_BASE_BIN, WITNESS_CHECK_BIN, TEST_TMP. Run inside `unshare -r -n`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { stringToHex, toHex, keccak256, toBytes, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startRig, haveTools, KEYS, freePort } from './helpers/cli-independent-rig.mjs';
import { createWitnessGateway } from '../network/witness-gateway.mjs';
import { createWitnessChecker, createRootStore } from '../network/witness-verify.mjs';
import { makeCommitment, blockFields } from './fixtures/op-commitment.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRIVER = path.join(REPO, 'test/helpers/windows-chain-driver.mjs');
const { HELIOS_BASE_BIN, WITNESS_CHECK_BIN } = process.env;
const skip = haveTools() || (!HELIOS_BASE_BIN && 'HELIOS_BASE_BIN not set') || (!WITNESS_CHECK_BIN && 'WITNESS_CHECK_BIN not set') || (process.env.RIG_CHAIN_NODE !== 'reth' && 'needs the canonical-trie rig (RIG_CHAIN_NODE=reth)');
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'win-verifier-'));
const SEQ_KEY = '0x' + '5e'.repeat(32), seqSigner = privateKeyToAccount(SEQ_KEY).address;
const OUT = path.join(REPO, 'contracts/foundry/out');
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, `${name}.json`), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rig, helios, heliosUrl, feed, proxy, gateway, providers, pinsFile, book, bookAbi, checker, roots;
const proxyMode = { value: 'ok' };

async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30000) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
}
async function untilHelios(n, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (BigInt(await rpc(heliosUrl, 'eth_blockNumber')) >= BigInt(n)) return; } catch {} await sleep(300); }
  throw new Error(`helios did not reach block ${n}`);
}
const settled = (rc) => untilHelios(rc.blockNumber + 2n);
function startFeed() {
  let served = 0n, current = null, frozen = false;
  const srv = http.createServer(async (q, res) => {
    if (q.url === '/chain_id') return res.end('8453');
    try {
      const latest = BigInt(await rig.rpcCall('eth_blockNumber'));
      if (served === 0n && latest > 3n) served = latest - 3n;
      if (!frozen && served < latest) {
        const n = served + 1n;
        const b = await rig.rpcCall('eth_getBlockByNumber', [toHex(n), false]);
        const txs = await Promise.all(b.transactions.map((h) => rig.rpcCall('eth_getRawTransactionByHash', [h])));
        current = await makeCommitment(blockFields(b), { chainId: 8453, privateKey: SEQ_KEY, txs, ...(b.parentBeaconBlockRoot ? { parentBeaconRoot: b.parentBeaconBlockRoot } : {}) });
        await roots.offer(current);     // bound before Helios can see the head
        served = n;
      }
    } catch {}
    res.end(JSON.stringify(current));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/`, freeze: (v) => { frozen = v; } })));
}
function startProxy() {
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', async () => {
    if (proxyMode.value === 'down') { res.writeHead(503); return res.end(); }
    const j = await (await fetch(rig.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: b })).json();
    if (proxyMode.value === 'tamper') for (const x of [j].flat()) if (x?.result?.storageProof) for (const s of x.result.storageProof) s.value = '0x' + 'beef'.padStart(40, '1');
    res.end(JSON.stringify(j));
  }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/` })));
}
// BASE_RPCS for every Windows consumer: a loopback stand-in that counts any request and refuses it (it must stay at 0)
function countingProviders() {
  const st = { calls: 0 };
  const srv = http.createServer((req, res) => { st.calls++; req.resume(); res.writeHead(503); res.end(); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, st, url: `http://127.0.0.1:${srv.address().port}/` })));
}
const drive = (ops, extraEnv = {}) => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [DRIVER, JSON.stringify(ops)], { env: { PATH: process.env.PATH, BASE_RPCS: providers.url, ENCLAVE_CHAIN_AUTHORITY: 'verifier',
    ENCLAVE_CHAIN_VERIFIER: heliosUrl, ENCLAVE_CONTRACT_PINS_FILE: pinsFile, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  c.on('exit', () => { try { resolve(Object.fromEntries(JSON.parse(out).results.map((r) => [r.op, r]))); } catch { reject(new Error(`driver: ${err.slice(-1000)}`)); } });
});
const ok = (r, op) => { assert.equal(r[op].ok, true, `${op}: ${r[op].error}`); return r[op].value; };

test.before(async () => {
  if (skip) return;
  rig = await startRig();
  pinsFile = path.join(TMP, 'pins.json'); fs.writeFileSync(pinsFile, JSON.stringify(rig.pins));
  const B = art('EnclaveAddressBook.sol', 'EnclaveAddressBook'); bookAbi = B.abi;
  book = await rig.deploy(B);
  await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('deployments', { size: 32 }), rig.addresses.ledger]);
  await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry]);
  await rig.create(KEYS.owner); await rig.create(KEYS.owner);
  const last = await rig.create(KEYS.owner);
  checker = createWitnessChecker({ bin: WITNESS_CHECK_BIN, chainId: 8453, signer: seqSigner });
  roots = createRootStore({ checker });
  feed = await startFeed(); proxy = await startProxy(); providers = await countingProviders();
  gateway = createWitnessGateway({ upstreams: [proxy.url], proofs: { checker, roots } }); const gUrl = await gateway.listen(0);
  const home = path.join(TMP, 'home'); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${seqSigner}"\n`);
  const port = await freePort();
  helios = spawn(HELIOS_BASE_BIN, ['opstack', '--network', 'base', '--consensus-rpc', feed.url, '--execution-rpc', gUrl, '--rpc-port', String(port)], { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  heliosUrl = `http://127.0.0.1:${port}/`;
  await settled(last);
});
test.after(async () => {
  helios?.kill('SIGKILL');
  await gateway?.close(); feed?.srv.close(); proxy?.srv.close(); roots?.close?.(); checker?.close(); providers?.srv.close();
  await rig?.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});
const T = { skip, timeout: 300000 };
const COUNT_ABI = [{ type: 'function', name: 'count', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];

test('chain.mjs state reads through the verifier equal the chain: coherent paged enumeration, deployment, registry row, catalog version', T, async () => {
  const count = Number(await rig.pc.readContract({ address: rig.addresses.ledger, abi: COUNT_ABI, functionName: 'count' }));
  const r = await drive([{ op: 'authority' }, { op: 'resolveAddresses' }, { op: 'allDeployments', pageSize: 1 }, { op: 'readEnclave', id: rig.runner },
    { op: 'resolveAppRef', appRef: rig.appRef }, { op: 'stateTx', address: rig.operator }, { op: 'txNonce', address: rig.operator }]);
  assert.equal(ok(r, 'authority').authority.authority, 'local-verifier');
  const rows = ok(r, 'allDeployments');
  assert.equal(rows.length, count, 'every row, one page per row, at one verified block');
  const first = ok(await drive([{ op: 'resolveAddresses' }, { op: 'readDeployment', id: rows[0].id }]), 'readDeployment');
  assert.equal(String(first.owner).toLowerCase(), privateKeyToAccount(KEYS.owner).address.toLowerCase());
  const e = ok(r, 'readEnclave');
  assert.equal(String(e.operator).toLowerCase(), String(rig.operator).toLowerCase()); assert.equal(e.endpoint, rig.endpoint);
  const v = ok(r, 'resolveAppRef');
  const direct = await rig.pc.readContract({ address: rig.addresses.catalog, abi: rig.A.catalog.abi, functionName: 'getVersion', args: [rig.appRef.split('/')[2], BigInt(rig.appRef.split('/')[3])] });
  assert.ok(v.cid, 'the version names its artifact'); assert.equal(v.cid, direct.cid); assert.equal(v.version, direct.version);
  assert.match(r.stateTx.error, /not a verified state read/);
  assert.match(r.txNonce.error, /no transaction\/history transport/);
  assert.equal(providers.st.calls, 0, 'BASE_RPCS was never contacted');
});

test('admin AddressBook migration is followed through the verifier; an outsider cannot repoint it', T, async () => {
  const noPins = { ENCLAVE_CONTRACT_PINS_FILE: '', ADDRESS_BOOK_ADDRESS: book };
  assert.equal(ok(await drive([{ op: 'resolveAddresses' }], noPins), 'resolveAddresses').registry.toLowerCase(), rig.addresses.registry.toLowerCase());
  await assert.rejects(rig.write(rig.wc(KEYS.other), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry5]));
  await settled(await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry5]));
  assert.equal(ok(await drive([{ op: 'resolveAddresses' }], noPins), 'resolveAddresses').registry.toLowerCase(), rig.addresses.registry5.toLowerCase());
  await settled(await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry]));
  assert.equal(providers.st.calls, 0);
});

test('check-endpoint ownership through the shared chain reader: ours, taken and free on the pinned registry', T, async () => {
  const reg = rig.addresses.registry, other = privateKeyToAccount(KEYS.other).address;
  const r = await drive([{ op: 'checkEndpoint', endpoint: rig.endpoint, operator: rig.operator, registry: reg, rpcs: [providers.url] }]);
  assert.equal(ok(r, 'checkEndpoint').status, 'ours');
  assert.equal(ok(await drive([{ op: 'checkEndpoint', endpoint: rig.endpoint, operator: other, registry: reg }]), 'checkEndpoint').status, 'taken');
  assert.equal(ok(await drive([{ op: 'checkEndpoint', endpoint: 'https://unregistered.example.org', operator: other, registry: reg }]), 'checkEndpoint').status, 'free');
  assert.equal(providers.st.calls, 0);
});

test('session API: a live session verifies through the verifier at one block; once the owner terminates it, the next request is refused', T, async () => {
  const S = await import('../sdk/sessions/dist/node.mjs');
  const owner = privateKeyToAccount(KEYS.owner);
  const kp = await S.generateKeyPair(true); const signer = await S.signerFromKeyPair(kp); const { x, y } = await S.publicKeyXY(kp.publicKey);
  const grant = S.buildGrant({ label: 'win-test', sessionKey: S.keyHashOf(x, y), policy: { actions: ['api.status', 'api.logs'], apps: ['*'], environments: ['staging', 'prod'], budget: 0n,
    spendPerPeriod: 0n, periodSeconds: 86400, opsPerPeriod: 0, maxFeePerOp: 0n, maxAppFeePerHour: 0n, maxRatePerHour: 0n, expiresIn: 3600 } });
  const tx = await S.prepareSessionOpen({ publicClient: rig.pc, factory: rig.addresses.factory, owner, chainId: 8453, grant });
  await settled(await rig.pc.waitForTransactionReceipt({ hash: await rig.wc(KEYS.owner).sendTransaction({ to: tx.to, data: tx.data }) }));
  const pins = { deployments: rig.addresses.ledger, sessionVaultFactory: rig.addresses.factory };
  const verify = async () => drive([{ op: 'sessionVerify', pins, base: 'api.example.org', method: 'GET', path: '/v1/x', scope: 'api.logs',
    header: await S.signApiRequest(signer, tx.vault, tx.sid, 'GET', 'https://api.example.org/v1/x') }]);
  const live = ok(await verify(), 'sessionVerify');
  assert.equal(live.owner.toLowerCase(), owner.address.toLowerCase()); assert.equal(live.sid, tx.sid);
  const p = await S.prepareOwnerOperation({ publicClient: rig.pc, chainId: 8453, vault: tx.vault, op: { op: 'terminate', sessionId: tx.sid }, mode: 'direct', owner });
  await settled(await rig.pc.waitForTransactionReceipt({ hash: await rig.wc(KEYS.owner).sendTransaction({ to: p.to, data: p.data }) }));
  const ended = await verify();
  assert.equal(ended.sessionVerify.ok, false); assert.equal(ended.sessionVerify.code, 'session_ended', ended.sessionVerify.error);
  assert.equal(providers.st.calls, 0);
});

test('tampered or missing witnesses and a stale head refuse every Windows state read; nothing falls back to BASE_RPCS', T, async () => {
  const id = rig.runner;
  for (const mode of ['tamper', 'down']) {
    proxyMode.value = mode;
    try {
      await untilHelios(BigInt(await rpc(heliosUrl, 'eth_blockNumber')) + 2n);
      const r = await drive([{ op: 'readEnclave', id }, { op: 'allDeployments' }, { op: 'checkEndpoint', endpoint: rig.endpoint, operator: rig.operator, registry: rig.addresses.registry }]);
      for (const op of ['readEnclave', 'allDeployments', 'checkEndpoint']) assert.equal(r[op].ok, false, `${mode} ${op}`);
    } finally { proxyMode.value = 'ok'; }
  }
  feed.freeze(true);
  try {
    await sleep(100000);                                              // past the readers' 90 s block-age bound
    const r = await drive([{ op: 'readEnclave', id }]);
    assert.equal(r.readEnclave.ok, false); assert.match(r.readEnclave.error, /stale|behind|older/i);
  } finally { feed.freeze(false); }
  assert.equal(providers.st.calls, 0);
});
