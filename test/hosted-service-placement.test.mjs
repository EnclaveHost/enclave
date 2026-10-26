// Hosted discovery/bootstrap services as Enclave host roles, cold-started WITHOUT the DigitalOcean failure domain
// (work/hosted-service-placement). On a REAL local chain (anvil: the independent rig's contracts and three JSON-RPC
// origins, plus the ownerless EnclaveServiceIndex compiled from the reviewed source):
//   - two Enclave hosts run the PACKAGED roles (scripts/build-host-service-packages.mjs bundles, pinned manifests) under
//     network/host-services/runner.mjs: a directory replica, a bootstrap replica and (host A) a read-only route DNS;
//   - the index holds the production-shaped advertisement of the four DigitalOcean machines AND each host operator's own;
//   - every DigitalOcean address is unreachable (the transport refuses it), and a mirror NAME that resolves into the fleet
//     is offered too;
//   - a cold client (network/cold-bootstrap.mjs) with empty caches finds the hosts' services from the pinned index alone,
//     reads signed records that were submitted to one host and replicated to the other, verifies them against the chain,
//     and fetches a bootstrap artifact by its pinned digest - and the evidence shows it excluded every fleet endpoint;
//   - Enclave administration holds: an administrator's ban removes an operator's advertisements, and a host the platform
//     host policy refuses STOPS its roles; package and configuration integrity refuse tampering and any secret.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { startRig, haveTools, KEYS, freePort } from './helpers/cli-independent-rig.mjs';
import { execFileSync } from 'node:child_process';
import * as si from '../network/service-index.mjs';
import { planHostServices, runHostServices, advertisements, loadPackage, validateHostServicesConfig } from '../network/host-services/runner.mjs';
import { ROLES } from '../network/host-services/roles.mjs';
import { coldDiscover, classifyEndpoint } from '../network/cold-bootstrap.mjs';
import { DirectoryClient } from '../network/directory-client.mjs';
import { signProviderRecord, providerIdFor } from '../network/provider-directory.mjs';
import { artifactIdentity } from '../sdk/storage/unixfs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(REPO, 'network/host-services/packages');
// solc-js (viaIR) in a short-lived child, as the rig compiles the registry: the compiler's WebAssembly memory never shrinks,
// and it must not count against this test's process-tree budget while the hosts' roles run
const compileIndexInChild = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  `import { compileServiceIndex } from ${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/network/service-index.mjs')).href)}; process.stdout.write(JSON.stringify(compileServiceIndex()));`],
  { maxBuffer: 16 << 20, timeout: 180000 }).toString());
// haveTools() -> null when anvil, openssl and the Foundry build are present, else the reason
const skip = haveTools() || (!fs.existsSync(path.join(PKG, 'directory-replica.package.json')) ? 'needs the built packages (scripts/build-host-service-packages.mjs)' : false);
const DO = { name: 'digitalocean', addresses: ['134.199.235.187', '134.209.248.172', '165.245.191.129', '146.190.246.39'] };
const pin = (role) => 'sha256:' + createHash('sha256').update(fs.readFileSync(path.join(PKG, `${role}.package.json`))).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-placement-'));
let rig, index, indexPin, hosts = {}, artifact, manifest, fetchLog = [];
// Stand-in PUBLIC addresses for the two Enclave hosts (the network maps them to the hosts' loopback listeners); the fleet's
// addresses are refused at the transport, as in a whole-provider outage.
const HOST_ADDR = { a: '9.9.9.9', b: '149.112.112.112' };
const netFetch = (url, opts) => {
  const u = new URL(url); fetchLog.push(u.hostname);
  if (DO.addresses.includes(u.hostname)) return Promise.reject(new TypeError('connect ECONNREFUSED (DigitalOcean down)'));
  if (Object.values(HOST_ADDR).includes(u.hostname)) { u.hostname = '127.0.0.1'; return fetch(u, opts); }
  return Promise.reject(new TypeError(`no route to ${u.hostname}`));
};
const resolve = async (name) => ({ 'dir.sneaky-mirror.net': ['134.209.248.172'], 'replica.host-a.net': [HOST_ADDR.a] })[name] || [];
const gateOf = (state) => ({ check: async () => {}, start() {}, stop() {}, serviceRefusal: () => state.refusal, status: () => ({ platformHostPolicy: 'test', refusal: state.refusal }) });
// on a timeout, every host's status and last log lines are part of the error (the only evidence a queued run leaves)
const diag = () => Object.values(hosts).map((h) => `--- host ${h.name}: ${JSON.stringify(h.running?.status?.() ?? null).slice(0, 1500)}\n${h.logs.slice(-25).join('\n').slice(-4000)}`).join('\n');
const wait = async (f, ms = 30000, what = 'condition') => { const end = Date.now() + ms; for (;;) { try { const v = await f(); if (v) return v; } catch {} if (Date.now() > end) throw new Error(`timed out: ${what}\n${diag()}`); await new Promise((r) => setTimeout(r, 250)); } };

async function startHost(name, { peers = [], dns = false, gate = { refusal: null } } = {}) {
  const dir = path.join(tmp, 'host-' + name); fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  for (const ext of ['bin', 'car']) fs.writeFileSync(path.join(dir, 'artifacts', `${artifact.cid}.${ext}`), ext === 'bin' ? artifact.bytes : artifact.car);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  const ports = { dir: await freePort(), boot: await freePort(), dns: await freePort(), api: await freePort() };
  const services = [
    { role: 'directory-replica', package: pin('directory-replica'), heapMiB: 192, config: { port: ports.dir, bind: '127.0.0.1', stateDir: path.join(dir, 'directory-state'),
      rpc: rig.rpcs, addressBook: '0x' + '0b'.repeat(20), authorityPins: { deployments: rig.addresses.ledger, registry: rig.addresses.registry, connectivity: '0x' + '00'.repeat(20), sessionVaultFactory: '0x' + '00'.repeat(20) }, checkers: ['0x' + '3c'.repeat(20)], peers } },
    { role: 'bootstrap-replica', package: pin('bootstrap-replica'), heapMiB: 128, config: { port: ports.boot, bind: '127.0.0.1', directory: path.join(dir, 'artifacts'), manifest: path.join(dir, 'manifest.json') } },
    ...(dns ? [{ role: 'route-dns', package: pin('route-dns'), heapMiB: 128, config: { dnsPort: ports.dns, bind: '127.0.0.1', apiPort: ports.api, zone: 'app.placement-test.net',
      ipZone: 'ip.placement-test.net', nsName: 'ns-a.placement-test.net', nsNames: ['ns-a.placement-test.net', 'ns-b.placement-test.net'], routeMapUrl: `http://127.0.0.1:${ports.dir}/v1/network/routes` } }] : []),
  ];
  const cfg = { format: 'enclave-host-services/v1', host: { endpoint: `https://host-${name}.placement-test.net`, publicEndpoints: {
      'directory-replica': [`http://${HOST_ADDR[name]}:${ports.dir}/`], 'bootstrap-replica': [`http://${HOST_ADDR[name]}:${ports.boot}/`] } },
    platformHostPolicy: 'production', serviceIndex: indexPin, packagesDir: PKG, stateRoot: path.join(dir, 'state'), services };
  const logs = [];
  const running = await runHostServices(cfg, { gate: gateOf(gate), log: (m) => logs.push(m), intervalMs: 300 });
  await wait(() => fetch(`http://127.0.0.1:${ports.dir}/health`).then((r) => r.ok), 20000, `host ${name} directory`);
  await wait(() => fetch(`http://127.0.0.1:${ports.boot}/ipfs/${artifact.cid}`, { method: 'HEAD' }).then((r) => r.ok), 20000, `host ${name} replica`);
  return { name, cfg, ports, running, logs, gate, dir };
}
async function publish(key, slot, kind, endpoints, sequence = 1n) {
  const now = BigInt(Math.floor(Date.now() / 1000)) + 0n;
  const blk = await rig.pc.getBlock();
  await rig.write(rig.wc(key), index, si.SERVICE_INDEX_ABI, 'publish', [slot, si.SERVICE_KINDS[kind], si.AD_VERSION, sequence, blk.timestamp + 30n * 86400n, '0x' + '00'.repeat(32), endpoints]);
  void now;
}

before(async () => {
  if (skip) return;
  rig = await startRig();
  const built = compileIndexInChild();
  const hash = await rig.wc(KEYS.deployer).deployContract({ abi: built.abi, bytecode: built.bytecode });
  index = (await rig.pc.waitForTransactionReceipt({ hash })).contractAddress;
  indexPin = si.validateIndexPin({ chainId: 8453, address: index, codeHash: built.codeHash });
  const bytes = Buffer.from('enclave host runtime release (bootstrap artifact fixture) ' + 'x'.repeat(4096));
  artifact = { cid: artifactIdentity(new Uint8Array(bytes)).cid, bytes, car: Buffer.concat([Buffer.from('car:'), bytes]) };
  manifest = { verifiedObjects: [{ cid: artifact.cid, sha256: createHash('sha256').update(artifact.bytes).digest('hex'), carSha256: createHash('sha256').update(artifact.car).digest('hex') }] };
  hosts.a = await startHost('a', { dns: true });
  hosts.b = await startHost('b', { peers: [`http://127.0.0.1:${hosts.a.ports.dir}/`] });
  // the index as production has it (the four fleet machines) plus each host operator's own advertisement, and a mirror whose
  // NAME resolves into the fleet
  await publish(KEYS.operator, 0, 'directory', DO.addresses.map((ip) => `http://${ip}:8188/`));
  await publish(KEYS.operator, 1, 'replica', DO.addresses.map((ip) => `http://${ip}:8189/`));
  await publish(KEYS.operator, 2, 'directory', ['http://dir.sneaky-mirror.net:8188/']);
  for (const [key, h] of [[KEYS.other, hosts.a], [KEYS.owner, hosts.b]]) {
    await publish(key, 0, 'directory', h.cfg.host.publicEndpoints['directory-replica']);
    await publish(key, 1, 'replica', h.cfg.host.publicEndpoints['bootstrap-replica']);
  }
  for (let i = 0; i < 4; i++) await rig.mine();
});
after(async () => {
  for (const h of Object.values(hosts)) await h.running?.stop().catch(() => {});
  await rig?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('packages: only the reviewed bytes run, only public configuration reaches a role, and no role reaches custody, storage or lease relays', { skip }, () => {
  for (const role of Object.keys(ROLES)) {
    const p = loadPackage(PKG, role, pin(role));
    assert.equal(p.manifest.role, role);
    // service-tls is the one role with key material: GENERATED on the host into its preflighted key directory, none in
    // its configuration (network/host-services/service-tls.mjs, work/host-service-tls-20261021)
    if (role === 'service-tls') assert.match(p.manifest.secrets, /^generated on the host .*none in its configuration$/);
    else assert.equal(p.manifest.secrets.startsWith('none'), true);
    // the policy mirror's fresh-block checks use the RPC quorum reader (custody/v2/quorum.mjs: no key, no custody state)
    for (const f of Object.keys(p.manifest.inputs)) if (f !== 'custody/v2/quorum.mjs') assert.doesNotMatch(f, /(^|\/)(custody|lease-relay-service|lease-gas-runtime|sdk\/storage)\//, `${role} reaches ${f}`);
  }
  assert.throws(() => loadPackage(PKG, 'directory-replica', 'sha256:' + '0'.repeat(64)), /not the pinned/);
  const copy = path.join(tmp, 'tampered'); fs.mkdirSync(copy);
  for (const f of fs.readdirSync(PKG)) fs.copyFileSync(path.join(PKG, f), path.join(copy, f));
  fs.appendFileSync(path.join(copy, 'bootstrap-replica.mjs'), '\n// changed');
  assert.throws(() => loadPackage(copy, 'bootstrap-replica', pin('bootstrap-replica')), /does not match its manifest/);
  const cfg = hosts.a.cfg, svc = (role, config) => ({ ...cfg, services: [{ role, package: pin(role), config }] });
  const dirCfg = cfg.services[0].config;
  assert.throws(() => validateHostServicesConfig(svc('directory-replica', { ...dirCfg, privateKey: '0x01' })), /unknown config field "privateKey" \(a host service holds no secret\)/);
  assert.throws(() => validateHostServicesConfig(svc('directory-replica', { ...dirCfg, addressBook: '0x' + '00'.repeat(20) })), /admin-controlled EnclaveAddressBook/);
  assert.throws(() => validateHostServicesConfig(svc('directory-replica', { ...dirCfg, rpc: [rig.rpcs[0]] })), /2 to 8 Base RPC/);
  assert.throws(() => validateHostServicesConfig(svc('route-dns', { ...hosts.a.cfg.services[2].config, routeMapUrl: 'https://api.enclave.host/v1/network/routes?key=1' })), /no credentials or query/);
  assert.throws(() => validateHostServicesConfig({ ...cfg, platformHostPolicy: undefined }), /platformHostPolicy is required/);
  assert.throws(() => validateHostServicesConfig({ ...cfg, fleetSecret: 'x' }), /host services hold no secret/);
  assert.throws(() => validateHostServicesConfig({ ...cfg, services: [{ role: 'wasm-directory', package: 'sha256:' + '0'.repeat(64), config: {} }] }), /unknown role/);
  // the launched roles inherit nothing of the host's environment
  const plan = planHostServices(cfg);
  assert.deepEqual(Object.keys(plan.services.find((s) => s.role === 'route-dns').launch.env).sort(),
    ['APP_ZONE', 'DNS_API_BIND', 'DNS_API_PORT', 'DNS_BIND', 'DNS_PORT', 'DNS_READ_ONLY', 'IP_ZONE', 'NS_NAME', 'NS_NAMES', 'ROUTE_MAP_URL']);
});

test('cold start from the pinned index alone, with every DigitalOcean endpoint down: signed records and a verified artifact from Enclave hosts', { skip }, async () => {
  // a signed provider record submitted to host A only; host B replicates it from A (its peer), and both verify it on chain
  const operator = privateKeyToAccount(KEYS.operator), address = '8.8.4.4', now = Date.now();
  const record = { version: 1, providerId: providerIdFor(operator.address, address), operator: operator.address.toLowerCase(), address,
    wgExitKey: Buffer.alloc(32, 1).toString('base64'), wgGuardKey: Buffer.alloc(32, 2).toString('base64'), ports: { exit: 51820, guard: 51821, control: 51822 },
    roles: ['guard', 'ingress', 'egress'], pricePerGiB6: 0, region: 'placement-test', kind: 'community', hostId: rig.runner, issuedAt: now, expiresAt: now + 1800000 };
  const signed = await signProviderRecord(operator, record);
  const post = await fetch(`http://127.0.0.1:${hosts.a.ports.dir}/v1/network/providers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) });
  assert.equal(post.status, 200, await post.text());
  await wait(async () => (await (await fetch(`http://127.0.0.1:${hosts.b.ports.dir}/v1/network/providers`)).json()).providers.length === 1, 40000, 'host B replicates host A');

  fetchLog = [];
  const r = await coldDiscover({ peers: rig.rpcs, indexPin, failureDomains: [DO], resolve, fetch: netFetch, directoryPath: '/v1/network/providers', manifest, artifacts: [artifact.cid] });
  // every fleet endpoint, and the name that resolves into the fleet, was EXCLUDED - never contacted
  assert.equal(r.excluded.filter((e) => e.domain === 'digitalocean').length, 9, JSON.stringify(r.excluded));
  assert.ok(r.excluded.some((e) => e.endpoint === 'http://dir.sneaky-mirror.net:8188/' && /dir\.sneaky-mirror\.net -> 134\.209\.248\.172 is in digitalocean/.test(e.reason)));
  assert.deepEqual(fetchLog.filter((h) => DO.addresses.includes(h)), [], 'no hidden DigitalOcean download');
  assert.deepEqual(r.usable.directory.sort(), [`http://${HOST_ADDR.a}:${hosts.a.ports.dir}`, `http://${HOST_ADDR.b}:${hosts.b.ports.dir}`].sort());
  assert.equal(r.directory.answers.length, 2, 'both Enclave hosts answered');
  // the records verify against the chain (the registry's operator for the provider's host), whichever host served them
  const registryAbi = rig.A.registry4.abi;
  const hostOperator = async (id) => { const e = await rig.pc.readContract({ address: rig.addresses.registry, abi: registryAbi, functionName: 'get', args: [id] }); return e.operator ?? e[1]; };
  const verified = await new DirectoryClient({ origins: r.usable.directory.map((o) => o + '/'), fetch: netFetch }).providers({ hostOperator });
  assert.equal(verified.providers.length, 1); assert.equal(verified.providers[0].record.record.providerId, record.providerId);
  assert.equal(r.artifacts.length, 1); assert.ok(r.artifacts[0].bytes.equals(artifact.bytes));
  assert.ok([`http://${HOST_ADDR.a}:${hosts.a.ports.boot}`, `http://${HOST_ADDR.b}:${hosts.b.ports.boot}`].includes(r.artifacts[0].origin));
  // without the hosts' advertisements there is nothing to fall back to: the fleet is never used silently
  await assert.rejects(coldDiscover({ peers: rig.rpcs, indexPin, failureDomains: [DO, { name: 'hosts', addresses: Object.values(HOST_ADDR) }], resolve, fetch: netFetch }),
    /no directory outside the failure domains/);
});

test('administration holds: a banned operator\'s advertisements are dropped, and a refused host stops its roles', { skip }, async () => {
  const bOperator = privateKeyToAccount(KEYS.owner).address.toLowerCase();
  const decide = async (ops) => Object.fromEntries(ops.map((o) => [o, o === bOperator ? { admit: false, status: 'refused', reason: 'banned by platform policy #7 (operator): abuse' } : { admit: true, status: 'admitted' }]));
  const r = await coldDiscover({ peers: rig.rpcs, indexPin, decide, failureDomains: [DO], resolve, fetch: netFetch, directoryPath: '/v1/network/providers' });
  assert.deepEqual(r.usable.directory, [`http://${HOST_ADDR.a}:${hosts.a.ports.dir}`]);
  assert.ok(r.refusedByPolicy.some((x) => x.candidate.operator === bOperator));
  // the platform host policy refuses host B: its runner stops every role (sticky until an admit), and starts them again after
  hosts.b.gate.refusal = 'platform host policy: banned by platform policy #7 (host)';
  await wait(async () => { try { await fetch(`http://127.0.0.1:${hosts.b.ports.dir}/health`); return false; } catch { return true; } }, 15000, 'host B stops');
  assert.equal(hosts.b.running.status().refusal, hosts.b.gate.refusal);
  assert.ok(hosts.b.logs.some((l) => /STOPPING every role/.test(l)));
  hosts.b.gate.refusal = null;
  await wait(() => fetch(`http://127.0.0.1:${hosts.b.ports.dir}/health`).then((x) => x.ok), 20000, 'host B serves again after the admit');
});

test('cold dependencies: artifacts serve with the chain down; route DNS answers from its own host\'s directory; endpoints are classified, not trusted', { skip }, async () => {
  for (const i of [0, 1, 2]) rig.rpcModes[i] = 'down';
  try {
    const a = await fetch(`http://127.0.0.1:${hosts.a.ports.boot}/ipfs/${artifact.cid}`);
    assert.ok(Buffer.from(await a.arrayBuffer()).equals(artifact.bytes), 'a bootstrap replica needs no chain, discovery, storage or relay');
    assert.equal((await fetch(`http://127.0.0.1:${hosts.a.ports.dir}/health`)).status, 200, 'a directory replica keeps serving through an RPC outage');
  } finally { for (const i of [0, 1, 2]) rig.rpcModes[i] = 'ok'; }
  // SOA of the app zone from host A's route DNS (read-only: its route map is host A's own directory replica)
  const q = Buffer.concat([Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...'app.placement-test.net'.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0, 0, 6, 0, 1])]);
  const answer = await wait(() => new Promise((ok) => {
    const s = dgram.createSocket('udp4'); const t = setTimeout(() => { s.close(); ok(null); }, 1500);
    s.on('message', (m) => { clearTimeout(t); s.close(); ok(m); }); s.send(q, hosts.a.ports.dns, '127.0.0.1');
  }), 20000, 'route DNS answers');
  assert.equal(answer.readUInt16BE(0), 0x1234); assert.equal(answer[3] & 0x0f, 0, 'NOERROR'); assert.ok(answer.readUInt16BE(6) >= 1, 'an SOA answer');
  assert.ok(answer[2] & 0x04, 'authoritative');
  assert.deepEqual(await classifyEndpoint('http://replica.host-a.net:80/', [DO], resolve), { excluded: false, addresses: [HOST_ADDR.a] });
  assert.equal((await classifyEndpoint('http://unknown.example-host.net/', [DO], resolve)).excluded, true, 'an unresolvable name has an unknown failure domain');
});

test('advertisements are prepared for the operator to sign; nothing is signed or sent here', { skip }, async () => {
  const ads = await advertisements(hosts.a.cfg, { operator: privateKeyToAccount(KEYS.other).address, slot: 0, sequence: 2 });
  assert.deepEqual(ads.map((a) => a.kind).sort(), ['directory', 'replica']);
  for (const a of ads) {
    assert.equal(a.signed, false); assert.equal(a.typedData.primaryType, 'Publish');
    assert.equal(a.descriptorHash, si.descriptorHash(Buffer.from(a.descriptor)));
    const d = JSON.parse(a.descriptor); assert.equal(d.format, 'enclave-service-descriptor/v1'); assert.equal(d.package, pin(d.role));
  }
});
