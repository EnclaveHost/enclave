// The hosted service roles on the EXPLICIT LOCAL VERIFIER (chainAuthority 'verifier'), not a provider quorum: the PACKAGED
// directory-replica and policy-mirror roles under network/host-services/runner.mjs with the REAL platform host policy gate,
// carriers and service index, on the real local chain of the hosted policy rig (anvil; the admin-owned EnclaveAddressBook,
// EnclaveHostOwnership, the registry and the EnclaveServiceIndex from source). Every chain read of the hosts goes to ONE
// loopback verifier endpoint (test/helpers/loopback-verifier.mjs: the real verifier's protocol and refusals; Merkle proof
// checking itself is the real verifier's, proven in work/rpc-priority's policy-verifier E2E). The fleet's policy mirrors
// are refused at the transport, and the rig's three public-provider origins are DOWN while the hosts start.
//   - config: one explicit authority (verifier mode refuses an RPC list; a remote verifier is refused; the verifier is never
//     counted as a provider vote); legacy quorum validation unchanged;
//   - cold start with every public provider down: admitted, roles serve, the anchored document from the import carrier;
//   - a second host with EMPTY state finds host A's policy mirror through the service index read via the verifier;
//   - the admin's ban and unban through the carrier; then an AddressBook OWNER MIGRATION (setOwner + acceptOwnership): the
//     old admin's documents stop counting, the new admin's anchored policy governs;
//   - unknown, stale, missing and failed proofs REFUSE, with the public providers up: no provider fallback anywhere.
//   - host B also runs the PACKAGED public-rpc role (network/public-rpc.mjs, its node the test chain): the same ban stops it,
//     the unban restarts it, and after the owner migration it serves under the new admin's policy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stringToHex, keccak256, toBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startRig, haveTools, KEYS, freePort } from './helpers/cli-independent-rig.mjs';
import { startLoopbackVerifier } from './helpers/loopback-verifier.mjs';
import * as si from '../network/service-index.mjs';
import { runHostServices, validateHostServicesConfig, advertisements } from '../network/host-services/runner.mjs';
import { ROLES } from '../network/host-services/roles.mjs';
import { POLICY_FORMAT, policyTypedData, policyDigest, encodeAnchor, ANCHOR_KEYS } from '../network/platform-host-policy.mjs';
import { PRODUCTION_MIRRORS } from '../network/platform-host-policy-config.mjs';
import { hostPolicySnapshot } from '../network/host-policy-runtime.mjs';
import { freshVerifier } from '../network/policy-carriers.mjs';
import { LeaseReader, chainAuthorityOptions } from '../network/lease-reader.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(REPO, 'network/host-services/packages');
const OUT = path.join(REPO, 'contracts/foundry/out');
const skip = haveTools() || (!fs.existsSync(path.join(PKG, 'policy-mirror.package.json')) ? 'needs the built packages (scripts/build-host-service-packages.mjs)' : false);
const compileIndexInChild = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  `import { compileServiceIndex } from ${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/network/service-index.mjs')).href)}; process.stdout.write(JSON.stringify(compileServiceIndex()));`],
  { maxBuffer: 16 << 20, timeout: 180000 }).toString());
const DO = { addresses: ['134.199.235.187', '134.209.248.172', '165.245.191.129', '146.190.246.39'] };
const pin = (role) => 'sha256:' + createHash('sha256').update(fs.readFileSync(path.join(PKG, `${role}.package.json`))).digest('hex');
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + '.json'), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'hs-verifier-'));
const Z32 = '0x' + '00'.repeat(32);
const admin = privateKeyToAccount(KEYS.deployer), newAdminKey = generatePrivateKey(), newAdmin = privateKeyToAccount(newAdminKey);
const OPS = { a: privateKeyToAccount(KEYS.other), b: privateKeyToAccount(KEYS.owner) };
const OP_KEYS = { a: KEYS.other, b: KEYS.owner };
const HOST_ADDR = { a: '9.9.9.9', b: '149.112.112.112' };

const denied = [];
const netFetch = (url, opts) => {
  const u = new URL(url);
  if (DO.addresses.includes(u.hostname)) { denied.push(u.href); return Promise.reject(new TypeError('connect ECONNREFUSED (DigitalOcean down)')); }
  if (Object.values(HOST_ADDR).includes(u.hostname)) { u.hostname = '127.0.0.1'; return fetch(u, opts); }
  if (u.hostname === '127.0.0.1') return fetch(u, opts);
  return Promise.reject(new TypeError(`no route to ${u.hostname}`));
};
const diag = () => Object.values(hosts).map((h) => `--- host ${h.name}: ${JSON.stringify(h.running?.status?.() ?? null).slice(0, 1500)}\n${h.logs.slice(-20).join('\n').slice(-3000)}`).join('\n');
const wait = async (f, ms = 40000, what = 'condition') => { const end = Date.now() + ms; for (;;) { try { const v = await f(); if (v) return v; } catch {} if (Date.now() > end) throw new Error(`timed out: ${what}\n${diag()}`); await new Promise((r) => setTimeout(r, 250)); } };
const up = (port) => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);
// the public RPC role answers a browser profile's first call (eth_chainId) only while it runs
const rpcUp = (port) => fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })
  .then((r) => r.json()).then((j) => j.result === '0x2105', () => false);

let rig, verifier, miner, index, indexPin, book, ownership, bookAbi, registryAddr, hosts = {}, docs = [];
const POLICY = () => ({ book: book.toLowerCase(), hostOwnership: ownership.toLowerCase(), mirrors: [...PRODUCTION_MIRRORS], activation: 'required' });
async function sign(deny, signer = admin) {
  const prev = docs.length ? docs[docs.length - 1].digest : Z32;
  const p = { format: POLICY_FORMAT, chainId: 8453, book: book.toLowerCase(), registry: registryAddr.toLowerCase(), hostOwnership: ownership.toLowerCase(),
    sequence: docs.length + 1, issuedAt: Math.floor(Date.now() / 1000) - 5, expiresAt: 0, maxStaleSec: 0, previousDigest: prev, mode: 'denylist', deny, admit: [] };
  return { policy: p, digest: policyDigest(p), document: JSON.stringify(p), signature: await signer.signTypedData(policyTypedData(p)) };
}
const adopt = (d) => { docs.push(d); return d; };
const anchor = async (digest, key = KEYS.deployer) => { const a = encodeAnchor(digest); await rig.write(rig.wc(key), book, bookAbi, 'setMany', [[ANCHOR_KEYS.hi, ANCHOR_KEYS.lo], [a.hi, a.lo]]); await rig.mine(); };
async function publishAd(key, slot, kind, endpoints) {
  const blk = await rig.pc.getBlock();
  await rig.write(rig.wc(key), index, si.SERVICE_INDEX_ABI, 'publish', [slot, si.SERVICE_KINDS[kind], si.AD_VERSION, 1n, blk.timestamp + 30n * 86400n, Z32, endpoints]);
}
const V = () => ({ chainAuthority: 'verifier', chainVerifier: verifier.url });

async function startHost(name, { importDoc = null, carriers, mirrorPeers = [] } = {}) {
  const dir = path.join(tmp, 'host-' + name);
  const ports = { dir: await freePort(), pm: await freePort(), rpc: await freePort() };
  if (importDoc) { fs.mkdirSync(path.join(dir, 'import'), { recursive: true }); fs.writeFileSync(path.join(dir, 'import', `${importDoc.digest}.json`), JSON.stringify({ document: importDoc.document, signature: importDoc.signature })); }
  const services = [
    { role: 'directory-replica', package: pin('directory-replica'), heapMiB: 192, config: { port: ports.dir, bind: '127.0.0.1', stateDir: path.join(dir, 'directory-state'),
      addressBook: '0x' + '0b'.repeat(20), authorityPins: { deployments: rig.addresses.ledger, registry: rig.addresses.registry, connectivity: '0x' + '00'.repeat(20), sessionVaultFactory: '0x' + '00'.repeat(20) },
      checkers: ['0x' + '3c'.repeat(20)], ...V() } },
    { role: 'policy-mirror', package: pin('policy-mirror'), heapMiB: 128, config: { port: ports.pm, bind: '127.0.0.1', stateDir: path.join(dir, 'policy-mirror-state'),
      book, hostOwnership: ownership, peers: mirrorPeers, syncSec: 5, ...(importDoc ? { importDir: path.join(dir, 'import') } : {}), ...V() } },
    // host B's public RPC: the operator's own node is the test chain (loopback); not advertised (no index kind)
    ...(name === 'b' ? [{ role: 'public-rpc', package: pin('public-rpc'), heapMiB: 96, config: { port: ports.rpc, bind: '127.0.0.1',
      hostId: keccak256(toBytes(`https://host-${name}.policy-placement.net`)).toLowerCase(), chainId: 8453, node: rig.rpc, allowedOrigins: ['https://dashboard.policy-placement.net'] } }] : []),
  ];
  const publicEndpoints = { 'directory-replica': [`http://${HOST_ADDR[name]}:${ports.dir}/`], 'policy-mirror': [`http://${HOST_ADDR[name]}:${ports.pm}/platform-policy`] };
  const cfg = { format: 'enclave-host-services/v1', host: { endpoint: `https://host-${name}.policy-placement.net`, publicEndpoints },
    platformHostPolicy: POLICY(), ...(carriers ? { platformHostPolicyCarriers: carriers } : {}), ...V(),
    serviceIndex: indexPin, packagesDir: PKG, stateRoot: path.join(dir, 'state'), services };
  const logs = [];
  const running = await runHostServices(cfg, { fetch: netFetch, log: (m) => logs.push(m), intervalMs: 500, gateIntervalMs: 500 });
  return { name, cfg, ports, running, logs, dir };
}

before(async () => {
  if (skip) return;
  rig = await startRig();
  registryAddr = rig.addresses.registry;
  const built = compileIndexInChild();
  index = (await rig.pc.waitForTransactionReceipt({ hash: await rig.wc(KEYS.deployer).deployContract({ abi: built.abi, bytecode: built.bytecode }) })).contractAddress;
  indexPin = si.validateIndexPin({ chainId: 8453, address: index, codeHash: built.codeHash });
  const B = art('EnclaveAddressBook.sol', 'EnclaveAddressBook'); bookAbi = B.abi;
  book = await rig.deploy(B);
  await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), registryAddr]);
  ownership = await rig.deploy(art('EnclaveHostOwnership.sol', 'EnclaveHostOwnership'), [registryAddr]);
  for (const n of ['a', 'b'])
    await rig.write(rig.wc(OP_KEYS[n]), registryAddr, rig.A.registry4.abi, 'register', [`https://host-${n}.policy-placement.net`, 'independent/host', Z32, 1000n, 0n, '0x' + '00'.repeat(20)]);
  adopt(await sign([{ kind: 'operator', value: '0x' + '5a'.repeat(20), reason: 'unrelated abuse' }]));
  await anchor(docs[0].digest);
  verifier = await startLoopbackVerifier({ upstream: rig.rpc });
  // the verifier follows a head that keeps moving (Helios refuses a head older than 60 s)
  miner = setInterval(() => void rig.mine().catch(() => {}), 2000);
});
after(async () => {
  clearInterval(miner);
  for (const h of Object.values(hosts)) await h.running?.stop().catch(() => {});
  await verifier?.close(); await rig?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('config: one explicit authority, the verifier local only and never a provider vote; the legacy quorum rule unchanged', () => {
  const v = 'http://127.0.0.1:8545';
  const pm = { port: 18190, bind: '127.0.0.1', stateDir: '/var/lib/x', book: '0x' + '11'.repeat(20), hostOwnership: '0x' + '22'.repeat(20) };
  assert.equal(ROLES['policy-mirror'].validate({ ...pm, chainAuthority: 'verifier', chainVerifier: v }).chainVerifier, v);
  assert.equal(ROLES['policy-mirror'].validate({ ...pm, chainAuthority: 'verifier', chainVerifier: v }).rpc, undefined, 'no RPC list in verifier mode');
  assert.throws(() => ROLES['policy-mirror'].validate({ ...pm, chainAuthority: 'verifier', chainVerifier: v, rpc: ['https://a.example', 'https://b.example'] }), /one explicit authority/);
  assert.throws(() => ROLES['policy-mirror'].validate({ ...pm, chainAuthority: 'verifier', chainVerifier: v, minAgree: 2 }), /one explicit authority/);
  assert.throws(() => ROLES['policy-mirror'].validate({ ...pm, chainAuthority: 'verifier', chainVerifier: 'https://verifier.example.net/' }), /local|loopback/);
  assert.throws(() => ROLES['policy-mirror'].validate({ ...pm, chainVerifier: v }), /not verifier/);
  assert.throws(() => ROLES['policy-mirror'].validate({ ...pm, chainAuthority: 'helios', chainVerifier: v }), /quorum or verifier/);
  // legacy: unchanged - 2 to 8 distinct providers, majority minAgree
  assert.throws(() => ROLES['policy-mirror'].validate({ ...pm, rpc: ['https://a.example'] }), /2 to 8/);
  assert.throws(() => ROLES['policy-mirror'].validate({ ...pm, rpc: ['https://a.example', 'https://a.example/x'] }), /repeats a provider/);
  assert.throws(() => ROLES['policy-mirror'].validate({ ...pm, rpc: ['https://a.example', 'https://b.example'], minAgree: 1 }), /majority/);
  assert.deepEqual(ROLES['policy-mirror'].validate({ ...pm, rpc: ['https://a.example', 'https://b.example'] }).rpc, ['https://a.example', 'https://b.example']);
  const dr = { port: 18188, bind: '127.0.0.1', stateDir: '/var/lib/d', addressBook: '0x' + '33'.repeat(20), checkers: ['0x' + '44'.repeat(20)] };
  assert.equal(ROLES['directory-replica'].validate({ ...dr, chainAuthority: 'verifier', chainVerifier: v }).chainAuthority, 'verifier');
  assert.throws(() => ROLES['directory-replica'].validate({ ...dr, chainAuthority: 'verifier', chainVerifier: v, rpc: ['https://a.example', 'https://b.example'] }), /one explicit authority/);
  assert.throws(() => ROLES['directory-replica'].validate(dr), /rpc is required/);
  assert.throws(() => ROLES['directory-replica'].validate({ ...dr, rpc: ['https://a.example'] }), /rpc: 2 to 8/);
  // the runner: verifier mode refuses the policy's RPC list; and no RPC anywhere may be the verifier's own endpoint
  const host = { format: 'enclave-host-services/v1', host: { endpoint: 'https://h.example.net' }, platformHostPolicy: { book: pm.book, hostOwnership: pm.hostOwnership, mirrors: [] },
    packagesDir: '/opt/p', stateRoot: '/var/lib/s' };
  assert.throws(() => validateHostServicesConfig({ ...host, chainAuthority: 'verifier', chainVerifier: v, platformHostPolicyRpcs: ['https://a.example', 'https://b.example'],
    services: [{ role: 'policy-mirror', package: 'sha256:' + '0'.repeat(64), config: { ...pm, chainAuthority: 'verifier', chainVerifier: v } }] }), /one explicit authority/);
  assert.throws(() => validateHostServicesConfig({ ...host, chainAuthority: 'verifier', chainVerifier: v,
    services: [{ role: 'directory-replica', package: 'sha256:' + '0'.repeat(64), config: { ...dr, rpc: ['https://a.example', 'http://127.0.0.1:8545/'] } }] }), /never a provider vote/);
  assert.equal(validateHostServicesConfig({ ...host, ...{ chainAuthority: 'verifier', chainVerifier: v },
    services: [{ role: 'policy-mirror', package: 'sha256:' + '0'.repeat(64), config: { ...pm, chainAuthority: 'verifier', chainVerifier: v } }] }).services[0].config.chainVerifier, v);
});

test('every public provider down: the hosts start on the verifier alone; the roles serve; host B cold-starts from the index read through it', { skip, timeout: 240_000 }, async () => {
  for (const i of [0, 1, 2]) rig.rpcModes[i] = 'down';
  const before = verifier.state.calls.length;
  hosts.a = await startHost('a', { importDoc: docs[0], carriers: { importDir: path.join(tmp, 'host-a', 'import') } });
  await wait(() => up(hosts.a.ports.dir), 60000, 'host A directory (admitted through the verifier)');
  const sa = hosts.a.running.status();
  assert.equal(sa.refusal, null); assert.equal(sa.platformHostPolicy.runtime.accepted.digest, docs[0].digest);
  assert.match(String(sa.platformHostPolicy.runtime.chainAuthority), /local-verifier/);
  assert.ok(denied.some((u) => u.startsWith(PRODUCTION_MIRRORS[0])), 'the fleet mirrors were tried and refused');
  await wait(() => netFetch(`http://${HOST_ADDR.a}:${hosts.a.ports.pm}/platform-policy/${docs[0].digest}.json`).then((r) => r.ok), 30000, 'host A mirror holds the anchored document');
  assert.ok(hosts.a.logs.some((l) => /chain reads: local-verifier \(unsafe tier, proof-backed, no provider fallback\)/.test(l)), 'the PACKAGED directory replica reads through the verifier\n' + hosts.a.logs.join('\n'));
  assert.ok(verifier.state.calls.slice(before).some((c) => c.method === 'eth_call' && c.to === book.toLowerCase()), 'the gate read the book through the verifier');

  const ads = await advertisements(hosts.a.cfg, { operator: OPS.a.address, slot: 0, sequence: 1 });
  for (const x of ads) await publishAd(OP_KEYS.a, ads.indexOf(x), x.kind, x.endpoints);
  await publishAd(KEYS.operator, 1, 'policy', DO.addresses.map((ip) => `https://${ip}/platform-policy`));   // fleet ads: refused
  for (let i = 0; i < 3; i++) await rig.mine();
  const idx = verifier.state.calls.length;
  hosts.b = await startHost('b', { carriers: { serviceIndex: true }, mirrorPeers: [`http://127.0.0.1:${hosts.a.ports.pm}/platform-policy`] });
  await wait(() => up(hosts.b.ports.dir), 60000, 'host B (EMPTY state) admitted via the index carrier read through the verifier');
  await wait(() => rpcUp(hosts.b.ports.rpc), 30000, 'host B public RPC serves once admitted');
  assert.equal(hosts.b.running.status().platformHostPolicy.runtime.accepted.digest, docs[0].digest);
  assert.ok(verifier.state.calls.slice(idx).some((c) => c.method === 'eth_call' && c.to === index.toLowerCase()), 'the service index was read through the verifier');
  for (const i of [0, 1, 2]) rig.rpcModes[i] = 'ok';
});

test('admin moderation through the verifier: ban and unban host B; then an AddressBook owner MIGRATION hands the policy to the new admin', { skip, timeout: 300_000 }, async () => {
  const pubA = (d) => netFetch(`http://${HOST_ADDR.a}:${hosts.a.ports.pm}/platform-policy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: d.document, signature: d.signature }) });
  const ban = adopt(await sign([...docs[0].policy.deny, { kind: 'operator', value: OPS.b.address.toLowerCase(), reason: 'abuse report 9' }]));
  assert.equal((await pubA(ban)).status, 201);
  await anchor(ban.digest);
  await wait(async () => !(await up(hosts.b.ports.dir)), 60000, 'host B stops every role (banned)');
  await wait(async () => !(await rpcUp(hosts.b.ports.rpc)), 30000, 'host B public RPC stopped by the ban');
  assert.match(String(hosts.b.running.status().refusal), /banned by platform policy #2 \(operator\): abuse report 9/);
  assert.equal(await up(hosts.a.ports.dir), true, 'host A is not banned');
  const unban = adopt(await sign(docs[0].policy.deny));
  assert.equal((await pubA(unban)).status, 201);
  await anchor(unban.digest);
  await wait(() => up(hosts.b.ports.dir), 60000, 'host B serves again after the unban');
  await wait(() => rpcUp(hosts.b.ports.rpc), 30000, 'host B public RPC serves again after the unban');

  // the admin migrates the book to a new owner (two steps, as on Base)
  await rig.rpcCall('anvil_setBalance', [newAdmin.address, '0x8ac7230489e80000']);   // the new admin's account on the test chain
  await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'setOwner', [newAdmin.address]);
  await rig.write(rig.wc(newAdminKey), book, bookAbi, 'acceptOwnership', []);
  await rig.mine();
  assert.equal(String(await rig.pc.readContract({ address: book, abi: bookAbi, functionName: 'owner' })).toLowerCase(), newAdmin.address.toLowerCase(), 'the book has migrated');
  // through the verifier, exactly as the roles and gates verify: the old admin's next document no longer counts
  const verify = freshVerifier({ snapshot: hostPolicySnapshot(V()), book, hostOwnership: ownership });
  const stale = await sign(docs[0].policy.deny, admin), fresh = await sign([...docs[0].policy.deny, { kind: 'operator', value: '0x' + '6b'.repeat(20), reason: 'new admin' }], newAdmin);
  const r = await verify([stale, fresh]);
  assert.deepEqual(r.verified.map((x) => x.digest), [fresh.digest], 'only the CURRENT owner\'s signature verifies');
  adopt(fresh);
  // the new admin's document reaches host A by its operator's import; the new admin anchors it
  fs.writeFileSync(path.join(hosts.a.dir, 'import', `${fresh.digest}.json`), JSON.stringify({ document: fresh.document, signature: fresh.signature }));
  await anchor(fresh.digest, newAdminKey);
  await wait(() => hosts.a.running.status().platformHostPolicy.runtime.accepted?.digest === fresh.digest, 60000, 'host A follows the NEW admin\'s anchored policy');
  await wait(() => hosts.b.running.status().platformHostPolicy.runtime.accepted?.digest === fresh.digest, 60000, 'host B too, through host A\'s carrier');
  await wait(() => up(hosts.a.ports.pm), 30000, 'host A mirror serving');
  assert.equal((await pubA(stale)).status, 422, 'the old admin\'s document is refused by the mirror after the migration');
  assert.equal(await rpcUp(hosts.b.ports.rpc), true, 'host B public RPC serves under the NEW admin\'s policy');
});

test('unknown, stale, missing and failed proofs REFUSE with the public providers up: no provider fallback in any reader', { skip, timeout: 240_000 }, async () => {
  for (const i of [0, 1, 2]) rig.rpcModes[i] = 'ok';
  const pubA = (d) => netFetch(`http://${HOST_ADDR.a}:${hosts.a.ports.pm}/platform-policy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: d.document, signature: d.signature }) });
  // the directory replica's reader, constructed exactly as network/directory-server.mjs runDirectory builds it
  const reader = new LeaseReader({ addressBook: '0x' + '0b'.repeat(20), authorityPins: hosts.a.cfg.services[0].config.authorityPins, includeHostPayout: true, ...chainAuthorityOptions(V()) });
  const hostId = (await import('viem')).keccak256(new TextEncoder().encode('https://host-a.policy-placement.net'));
  const [row] = await reader.registryEntries(registryAddr, [hostId]);
  assert.equal(row.operator.toLowerCase(), OPS.a.address.toLowerCase(), 'the replica\'s registry read answers through the verifier');
  const logLen = rig.rpcLog.length;
  const next = await sign(docs[0].policy.deny, newAdmin);
  for (const fault of ['proof', 'missing', 'stale', 'unknown']) {
    verifier.state.fault = fault;
    const res = await pubA(next);
    assert.equal(res.status, 503, `${fault}: the mirror refuses to verify (${await res.clone().text()})`);
    await assert.rejects(reader.registryEntries(registryAddr, [hostId]), undefined, `${fault}: the replica's reader refuses`);
    await assert.rejects(freshVerifier({ snapshot: hostPolicySnapshot(V()), book, hostOwnership: ownership })([next]), undefined, `${fault}: the gate's policy read refuses`);
  }
  verifier.state.fault = null;
  assert.equal(rig.rpcLog.length, logLen, 'no reader fell back to the (healthy) public providers');
  assert.equal((await pubA(next)).status, 201, 'recovered once the verifier answers again');
});
