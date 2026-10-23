// END-TO-END: the two independent policy readers under authority 'verifier' against REAL contracts on a CANONICAL-trie
// chain (the cli-independent rig on pinned reth --dev, chain id 8453) through the patched Helios (enclave-base-evm):
//   * the EnclaveServiceIndex (compiled from source) read by readServiceIndex, native control's readControlCandidates and
//     cold bootstrap's coldDiscover;
//   * the platform host policy - admin-signed documents anchored in the admin-owned EnclaveAddressBook, host rows in the
//     registry, EnclaveHostOwnership - read by createHostPolicyRuntime (gate decisions, the measured host gate) and by
//     coldDiscover's carrier-verified policy.
// Positive paths, admin moderation (a ban, a new anchor), outsiders, and failures: tampered or missing witnesses, a
// stale head, the original measured-gate grace. SYNTHETIC HEAD AUTHORITY: the local chain's blocks are signed by a TEST
// sequencer key (helios.toml override); the real Base head path is helios-base-head.e2e.
//   env: RIG_CHAIN_NODE=reth (+ RIG_RETH_*), HELIOS_BASE_BIN, TEST_TMP. Run inside `unshare -r -n`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { stringToHex, toHex, keccak256, toBytes, createPublicClient, http as viemHttp } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startRig, haveTools, KEYS, freePort, chain } from './helpers/cli-independent-rig.mjs';
import * as si from '../network/service-index.mjs';
import { readControlCandidates, CONTROL_KIND } from '../network/native-control-routes.mjs';
import { coldDiscover } from '../network/cold-bootstrap.mjs';
import { createHostPolicyRuntime, verifiedHostSnapshot } from '../network/host-policy-runtime.mjs';
import { POLICY_FORMAT, policyTypedData, policyDigest, encodeAnchor, ANCHOR_KEYS } from '../network/platform-host-policy.mjs';
import { createWitnessGateway } from '../network/witness-gateway.mjs';
import { makeCommitment, blockFields } from './fixtures/op-commitment.mjs';
import { challengeReplicaConfig, challengeReplicaEnv } from '../network/challenge-replica-host.mjs';
import { flatRelay } from './helpers/relay-flat.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { HELIOS_BASE_BIN } = process.env;
const skip = haveTools() || (!HELIOS_BASE_BIN && 'HELIOS_BASE_BIN not set') || (process.env.RIG_CHAIN_NODE !== 'reth' && 'needs the canonical-trie rig (RIG_CHAIN_NODE=reth)');
const TMP = fs.mkdtempSync(path.join(process.env.TEST_TMP || '/tmp', 'policy-verifier-'));
const SEQ_KEY = '0x' + '5e'.repeat(32), seqSigner = privateKeyToAccount(SEQ_KEY).address;
const Z32 = '0x' + '00'.repeat(32);
const OUT = path.join(REPO, 'contracts/foundry/out');
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, `${name}.json`), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = privateKeyToAccount(KEYS.deployer);                    // the book's deployer is its owner: the admin
const OPS = { a: { key: KEYS.other, endpoint: 'https://host-a.policy-test.net' }, b: { key: KEYS.owner, endpoint: 'https://host-b.policy-test.net' } };
let rig, helios, heliosUrl, feed, proxy, gateway, index, indexPin, book, bookAbi, ownership, docs = [], mirror, dirSrv;
const proxyMode = { value: 'ok' };
const idOf = (endpoint) => keccak256(toBytes(endpoint)).toLowerCase();   // the registry id of a host endpoint (as the rig computes it)

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
        current = await makeCommitment(blockFields(b), { chainId: 8453, privateKey: SEQ_KEY, txs });
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
async function sign(deny, signer = admin) {
  const prev = docs.length ? docs[docs.length - 1].digest : Z32;
  const p = { format: POLICY_FORMAT, chainId: 8453, book: book.toLowerCase(), registry: rig.addresses.registry.toLowerCase(), hostOwnership: ownership.toLowerCase(),
    sequence: docs.length + 1, issuedAt: Math.floor(Date.now() / 1000) - 5, expiresAt: 0, maxStaleSec: 0, previousDigest: prev, mode: 'denylist', deny, admit: [] };
  const d = { policy: p, digest: policyDigest(p), document: JSON.stringify(p), signature: await signer.signTypedData(policyTypedData(p)) };
  if (signer === admin) docs.push(d);
  return d;
}
const anchor = async (digest, key = KEYS.deployer) => { const a = encodeAnchor(digest); return rig.write(rig.wc(key), book, bookAbi, 'setMany', [[ANCHOR_KEYS.hi, ANCHOR_KEYS.lo], [a.hi, a.lo]]); };
async function publishAd(key, slot, kind, endpoints) {
  const blk = await rig.pc.getBlock();
  return rig.write(rig.wc(key), index, si.SERVICE_INDEX_ABI, 'publish', [slot, kind, si.AD_VERSION, 1n, blk.timestamp + 30n * 86400n, Z32, endpoints]);
}
// stand-in public names for the local directory and policy carrier (the resolver and fetch map them to loopback)
const NAMES = { 'dir-a.policy-test.net': '9.9.9.9', 'dir-b.policy-test.net': '149.112.112.112', 'pm.policy-test.net': '1.0.0.1' };
const resolve = async (h) => { if (NAMES[h]) return [NAMES[h]]; throw new Error('NXDOMAIN'); };
const netFetch = (url, opts) => {
  const u = new URL(url);
  if (u.hostname.startsWith('dir-')) return fetch(`http://127.0.0.1:${dirSrv.address().port}${u.pathname}`, opts);
  if (u.hostname === 'pm.policy-test.net') return fetch(`http://127.0.0.1:${mirror.address().port}${u.pathname}`, opts);
  return Promise.reject(new TypeError(`no route to ${u.hostname}`));
};

test.before(async () => {
  if (skip) return;
  rig = await startRig();
  const built = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { compileServiceIndex } from ${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/network/service-index.mjs')).href)}; process.stdout.write(JSON.stringify(compileServiceIndex()));`],
    { maxBuffer: 64 << 20 }).toString());
  index = (await rig.pc.waitForTransactionReceipt({ hash: await rig.wc(KEYS.deployer).deployContract({ abi: built.abi, bytecode: built.bytecode }) })).contractAddress;
  indexPin = si.validateIndexPin({ chainId: 8453, address: index, codeHash: built.codeHash });
  const B = art('EnclaveAddressBook.sol', 'EnclaveAddressBook'); bookAbi = B.abi;
  book = await rig.deploy(B);
  await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), rig.addresses.registry]);
  ownership = await rig.deploy(art('EnclaveHostOwnership.sol', 'EnclaveHostOwnership'), [rig.addresses.registry]);
  for (const o of Object.values(OPS)) await rig.write(rig.wc(o.key), rig.addresses.registry, rig.A.registry4.abi, 'register', [o.endpoint, 'independent/host', Z32, 1000n, 0n, '0x' + '00'.repeat(20)]);
  await sign([]);                                                   // policy 1: denies nobody
  await anchor(docs[0].digest);
  await publishAd(OPS.a.key, 0, si.SERVICE_KINDS.directory, ['https://dir-a.policy-test.net/']);
  await publishAd(OPS.b.key, 0, si.SERVICE_KINDS.directory, ['https://dir-b.policy-test.net/']);
  const last = await publishAd(OPS.b.key, 1, CONTROL_KIND, ['https://9.9.9.9/']);
  // the policy document carrier/mirror and a directory, served locally under stand-in public names
  mirror = http.createServer((q, res) => { const d = docs.find((x) => q.url.endsWith(`/${x.digest}.json`)); if (!d) { res.writeHead(404); return res.end(); } res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ document: d.document, signature: d.signature })); });
  dirSrv = http.createServer((q, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ records: [] })); });
  await Promise.all([mirror, dirSrv].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  feed = await startFeed(); proxy = await startProxy();
  gateway = createWitnessGateway({ upstreams: [proxy.url] }); const gUrl = await gateway.listen(0);
  const home = path.join(TMP, 'home'); fs.mkdirSync(path.join(home, '.helios'), { recursive: true });
  fs.writeFileSync(path.join(home, '.helios', 'helios.toml'), `[base.chain]\nunsafe_signer = "${seqSigner}"\n`);
  const port = await freePort();
  helios = spawn(HELIOS_BASE_BIN, ['opstack', '--network', 'base', '--consensus-rpc', feed.url, '--execution-rpc', gUrl, '--rpc-port', String(port)], { env: { HOME: home, PATH: process.env.PATH }, stdio: 'ignore' });
  heliosUrl = `http://127.0.0.1:${port}/`;
  await settled(last);
});
test.after(async () => {
  helios?.kill('SIGKILL');
  await gateway?.close(); feed?.srv.close(); proxy?.srv.close(); mirror?.close(); dirSrv?.close();
  await rig?.stop();
  fs.rmSync(TMP, { recursive: true, force: true });
});
const T = { skip, timeout: 300000 };
const V = () => ({ chainAuthority: 'verifier', chainVerifier: heliosUrl });
const policyRuntime = (extra = {}) => createHostPolicyRuntime({ book: book.toLowerCase(), hostOwnership: ownership.toLowerCase(), mirrors: ['https://pm.policy-test.net/platform-policy'],
  activation: 'required', ...V(), ...extra }, { fetch: netFetch });

test('service index through the verifier equals the provider-quorum read of the same contract', T, async () => {
  const v = await si.readServiceIndex({ pin: indexPin, kinds: ['directory'], lookups: [{ operator: privateKeyToAccount(OPS.a.key).address }], ...V() });
  // the legacy provider quorum over the rig's three distinct JSON-RPC origins
  const q = await si.readServiceIndex({ peers: rig.rpcs.map((u, i) => ({ label: `p${i}`, client: createPublicClient({ chain, transport: viemHttp(u, { retryCount: 0 }) }) })),
    pin: indexPin, kinds: ['directory'] });
  assert.equal(v.status, 'complete');
  const set = (r) => r.candidates.map((c) => `${c.operator}:${c.endpoints.join(',')}`).sort();
  assert.deepEqual(set(v), [`${privateKeyToAccount(OPS.a.key).address.toLowerCase()}:https://dir-a.policy-test.net/`, `${privateKeyToAccount(OPS.b.key).address.toLowerCase()}:https://dir-b.policy-test.net/`].sort());
  assert.equal(v.lookups.find((l) => l.state === 'listed')?.operator, privateKeyToAccount(OPS.a.key).address.toLowerCase());
  assert.equal(v.evidence.authority, 'local-verifier');
  const block = await rig.rpcCall('eth_getBlockByNumber', [toHex(BigInt(v.blockNumber)), false]);
  assert.equal(v.blockHash, block.hash, 'the verified block is the chain\'s block');
  assert.deepEqual(set(q), set(v), 'same listing as the provider quorum');
  await assert.rejects(si.readServiceIndex({ pin: { ...indexPin, codeHash: '0x' + '11'.repeat(32) }, kinds: ['directory'], ...V() }), /pinned/);
});

test('native control candidates through the verifier', T, async () => {
  const r = await readControlCandidates({ indexPin, operators: [privateKeyToAccount(OPS.b.key).address], ...V() });
  assert.deepEqual(r.candidates.map((c) => c.address), ['9.9.9.9']);
});

test('platform host policy through the verifier: admin policy admits, a new admin anchor bans, outsiders change nothing', T, async () => {
  const rt = policyRuntime();
  assert.match(rt.status().chainAuthority, /local-verifier/);
  const idA = idOf(OPS.a.endpoint), idB = idOf(OPS.b.endpoint);
  await rt.gate.refresh();
  let d = await rt.gate.decide({ registryIds: [idA, idB] });
  assert.equal(d.anchor, 'anchored');
  assert.equal(d.decisions[idA].admit, true, JSON.stringify(d.decisions[idA]));
  assert.equal(d.decisions[idB].admit, true);
  // an outsider cannot anchor policy (the book is admin-owned); the accepted policy is unchanged
  await assert.rejects(anchor(policyDigest({ ...docs[0].policy, sequence: 9 }), KEYS.other));
  await rt.gate.refresh();
  assert.equal(rt.gate.accepted().digest, docs[0].digest);
  // the admin bans operator A with a new anchored policy: the runtime follows at its next fresh read
  await sign([{ kind: 'operator', value: privateKeyToAccount(OPS.a.key).address.toLowerCase(), reason: 'abuse' }]);
  await settled(await anchor(docs[1].digest));
  await rt.gate.refresh();
  d = await rt.gate.decide({ registryIds: [idA, idB] });
  assert.equal(d.decisions[idA].admit, false, 'banned by the admin');
  assert.equal(d.decisions[idB].admit, true);
  assert.equal(rt.gate.accepted().digest, docs[1].digest);
});

test('cold discovery reads the index AND the carrier-verified admin policy through the verifier, with no RPC at all', T, async () => {
  const r = await coldDiscover({ indexPin, policy: { book: book.toLowerCase(), hostOwnership: ownership.toLowerCase(), carriers: ['https://pm.policy-test.net/platform-policy'] },
    resolve, fetch: netFetch, ...V() });
  assert.deepEqual(r.usable.directory, ['https://dir-b.policy-test.net'], 'the banned operator\'s directory is refused by the admin policy');
  assert.equal(r.refusedByPolicy.length, 1);
  assert.equal(r.evidence.authority, 'local-verifier');
});

test('tampered or missing witnesses refuse every policy reader; nothing is admitted from a refusal', T, async () => {
  const rt = policyRuntime();
  for (const mode of ['tamper', 'down']) {
    proxyMode.value = mode;
    try {
      await untilHelios(BigInt(await rpc(heliosUrl, 'eth_blockNumber')) + 2n);   // new blocks: their witnesses must come from the source
      await assert.rejects(si.readServiceIndex({ pin: indexPin, kinds: ['directory'], ...V() }), (e) => e instanceof si.QuorumError, mode);
      await assert.rejects(rt.gate.decide({ registryIds: ['0x' + '11'.repeat(32)] }), mode);
      await assert.rejects(coldDiscover({ indexPin, resolve, fetch: netFetch, ...V() }), mode);
    } finally { proxyMode.value = 'ok'; }
  }
});

test('a stale head refuses fresh policy authority while the chain keeps moving', T, async () => {
  const snap = verifiedHostSnapshot({ verifier: heliosUrl, maxAgeSec: 8 });
  assert.ok((await snap(async (at) => ({ code: await at.code(book) }))).code.length > 2);
  feed.freeze(true);
  try {
    await sleep(14000);
    await assert.rejects(snap(async (at) => ({ code: await at.code(book) })), (e) => e.code === 'chain_stale');
    await assert.rejects(si.readServiceIndex({ pin: indexPin, kinds: ['directory'], maxBlockAgeMs: 8000, ...V() }), /older than|stale/);
  } finally { feed.freeze(false); }
});

test('the measured host gate keeps its ORIGINAL grace under the verifier: serving within graceMs of the last admit, then not', T, async () => {
  let clock = Date.now();
  const rt = policyRuntime();
  const gate = rt.measured(idOf(OPS.b.endpoint), { graceMs: 5000, now: () => clock });
  await gate.check();
  assert.equal(gate.state().serving, true);
  proxyMode.value = 'down';
  try {
    await untilHelios(BigInt(await rpc(heliosUrl, 'eth_blockNumber')) + 2n);
    await gate.check().catch(() => {});
    assert.equal(gate.state().serving, true, 'within the configured grace (the same rule as under the quorum)');
    clock += 6000;
    await gate.check().catch(() => {});
    assert.equal(gate.state().serving, false, 'no invented grace beyond the configured one');
  } finally { proxyMode.value = 'ok'; }
});

// The REAL dns-relay process (flat relay directory, runtime bundle built from this source) started from the challenge
// replica's own configuration -> child environment: its app-zone ledger index reads the REAL ledger through the verifier
// (count + every id, proof-backed) and completes; under tampered witnesses a fresh process's index stays incomplete.
test('dns-relay (challenge replica child, flat bundle) indexes the real ledger through the verifier; tampered witnesses leave it incomplete', T, async () => {
  const dir = flatRelay(TMP);
  // two owner-created deployments in the real ledger (the rig starts with none), then let the verifier pass that block
  await rig.create(KEYS.owner); await settled(await rig.create(KEYS.owner));
  const count = Number(await rig.pc.readContract({ address: rig.addresses.ledger, functionName: 'count',
    abi: [{ type: 'function', name: 'count', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }] }));
  assert.ok(count >= 2, 'the rig ledger has the deployments');
  const start = async () => {
    const api = await freePort();
    const cfg = challengeReplicaConfig({ role: 'app-zone-replica', release: { dir: '/opt/replica', dnsSha256: 'aa'.repeat(32), runtimeBundleSha256: 'bb'.repeat(32) },
      zones: { app: 'app.policy-test.net', ip: 'ip.policy-test.net' }, ns: { name: 'ns1.policy-test.net' }, listen: { dns: `127.0.0.1:${await freePort()}`, api: `127.0.0.1:${api}` },
      front: { listen: '127.0.0.1:8443', certFile: '/etc/c.pem', keyFile: '/etc/k.pem', origin: 'https://ns1.policy-test.net' }, routeMap: 'http://127.0.0.1:1/v1/network/routes',
      snp: { measurements: ['77'.repeat(48)] }, chain: { pins: { addressBook: book.toLowerCase(), deployments: rig.addresses.ledger.toLowerCase(), registry: rig.addresses.registry.toLowerCase(), catalog: rig.addresses.catalog.toLowerCase() } },
      hostPolicy: { policy: 'off' }, ...V() });
    let out = '';
    const c = spawn(process.execPath, [path.join(dir, 'dns-relay.js')], { cwd: dir, env: challengeReplicaEnv(cfg, { basePath: process.env.PATH }), stdio: ['ignore', 'pipe', 'pipe'] });
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const health = async () => { try { return (await (await fetch(`http://127.0.0.1:${api}/health`, { signal: AbortSignal.timeout(3000) })).json()).appChallenge?.ledgerIndex; } catch { return null; } };
    return { c, health, out: () => out };
  };
  const a = await start();
  try {
    let idx = null; const end = Date.now() + 90000;
    while (Date.now() < end && !(idx = await a.health())?.complete) await sleep(500);
    assert.deepEqual(idx, { complete: true, size: count }, a.out().slice(-1200));
    assert.match(a.out(), /app-zone chain reads: local-verifier \(unsafe tier, proof-backed, no provider fallback\)/);
  } finally { a.c.kill('SIGKILL'); }
  proxyMode.value = 'tamper';
  try {
    await untilHelios(BigInt(await rpc(heliosUrl, 'eth_blockNumber')) + 2n);   // new blocks: their witnesses come from the tampering source
    const b = await start();
    try {
      const end = Date.now() + 60000;
      while (Date.now() < end && !/app-zone ledger index: /.test(b.out())) await sleep(500);
      assert.match(b.out(), /app-zone ledger index: /, 'the refusal is reported');
      assert.equal((await b.health())?.complete, false, 'a refused read never completes the index (no push could be judged unique)');
    } finally { b.c.kill('SIGKILL'); }
  } finally { proxyMode.value = 'ok'; }
});
