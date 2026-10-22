// The platform host policy WITHOUT the fleet's policy mirrors (work/hosted-service-placement): Enclave hosts cold-start, are
// banned and unbanned by the administrator, with every DigitalOcean endpoint denied. On a REAL local chain (anvil: the
// independent rig's registry and three JSON-RPC origins, plus a deployed EnclaveAddressBook whose owner is the admin, an
// EnclaveHostOwnership and the ownerless EnclaveServiceIndex):
//   - the admin signs a platform host policy and ANCHORS it in the book (setMany of the two anchor keys): activated;
//   - each host runs the PACKAGED roles under network/host-services/runner.mjs with the REAL gate (network/host-service-gate.mjs
//     -> host-policy-runtime.mjs -> platform-host-policy.mjs, nothing stubbed), the production-shaped mirror list (the four
//     fleet addresses, all refused at the transport) and EMPTY state;
//   - host A is the first carrier: its operator imported the signed document (any channel); host B has nothing but the
//     pinned service index, where host A advertises its policy-mirror role; host C has only the fleet mirrors and must
//     never start;
//   - the admin bans host B's operator (a new document, published to host A's policy mirror, then anchored): B stops every
//     role; the admin's next anchored document unbans it: B starts again;
//   - stale (an older, still validly signed document), substituted (edited content under a real signature) and wrongly
//     signed documents are refused by the carrier AND, independently, by the gate; an anchored rollback is refused;
//   - a cold client with empty caches loads the anchored policy from the index's carriers and drops the banned operator's
//     advertisements.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { keccak256, toBytes, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startRig, haveTools, KEYS, freePort } from './helpers/cli-independent-rig.mjs';
import { execFileSync } from 'node:child_process';
import * as si from '../network/service-index.mjs';
import { runHostServices, loadPackage, validateHostServicesConfig, advertisements } from '../network/host-services/runner.mjs';
import { coldDiscover } from '../network/cold-bootstrap.mjs';
import { POLICY_FORMAT, policyTypedData, policyDigest, encodeAnchor, ANCHOR_KEYS } from '../network/platform-host-policy.mjs';
import { PRODUCTION_MIRRORS } from '../network/platform-host-policy-config.mjs';
import { createHostPolicyRuntime, quorumSnapshot, fileStore } from '../network/host-policy-runtime.mjs';
import { CARRIER_MIRROR, carrierFetch, freshVerifier, candidateDigest } from '../network/policy-carriers.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(REPO, 'network/host-services/packages');
// solc-js (viaIR) in a short-lived child, as the rig compiles the registry: the compiler's WebAssembly memory never shrinks,
// and it must not count against this test's process-tree budget while the hosts' roles run
const compileIndexInChild = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  `import { compileServiceIndex } from ${JSON.stringify(pathToFileURL(path.join(REPO, 'scripts/network/service-index.mjs')).href)}; process.stdout.write(JSON.stringify(compileServiceIndex()));`],
  { maxBuffer: 16 << 20, timeout: 180000 }).toString());
const OUT = path.join(REPO, 'contracts/foundry/out');
const skip = haveTools() || (!fs.existsSync(path.join(PKG, 'policy-mirror.package.json')) ? 'needs the built packages (scripts/build-host-service-packages.mjs)' : false);
const DO = { name: 'digitalocean', addresses: ['134.199.235.187', '134.209.248.172', '165.245.191.129', '146.190.246.39'] };
const pin = (role) => 'sha256:' + createHash('sha256').update(fs.readFileSync(path.join(PKG, `${role}.package.json`))).digest('hex');
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + '.json'), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-policy-'));
const Z32 = '0x' + '00'.repeat(32);
const KEY4 = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';   // anvil #4 (gas price 0 on the rig)
const admin = privateKeyToAccount(KEYS.deployer);                                     // the book's deployer is its owner: the admin
const OPS = { a: privateKeyToAccount(KEYS.other), b: privateKeyToAccount(KEYS.owner), c: privateKeyToAccount(KEY4) };
const OP_KEYS = { a: KEYS.other, b: KEYS.owner, c: KEY4 };
const HOST_ADDR = { a: '9.9.9.9', b: '149.112.112.112' };   // stand-in public addresses, mapped to the hosts' loopback listeners

// the transport: every fleet address is refused (a whole-provider outage); the hosts' public addresses reach their listeners
const denied = [];
const netFetch = (url, opts) => {
  const u = new URL(url);
  if (DO.addresses.includes(u.hostname)) { denied.push(u.href); return Promise.reject(new TypeError('connect ECONNREFUSED (DigitalOcean down)')); }
  if (Object.values(HOST_ADDR).includes(u.hostname)) { u.hostname = '127.0.0.1'; return fetch(u, opts); }
  if (u.hostname === '127.0.0.1') return fetch(u, opts);
  return Promise.reject(new TypeError(`no route to ${u.hostname}`));
};
// on a timeout, every host's status and last log lines are part of the error (the only evidence a queued run leaves)
const diag = () => Object.values(hosts).map((h) => `--- host ${h.name}: ${JSON.stringify(h.running?.status?.() ?? null).slice(0, 1500)}\n${h.logs.slice(-25).join('\n').slice(-4000)}`).join('\n');
const wait = async (f, ms = 30000, what = 'condition') => { const end = Date.now() + ms; for (;;) { try { const v = await f(); if (v) return v; } catch {} if (Date.now() > end) throw new Error(`timed out: ${what}\n${diag()}`); await new Promise((r) => setTimeout(r, 250)); } };
const up = (port) => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false);

let rig, index, indexPin, book, ownership, bookAbi, registryAddr, hosts = {}, docs = [];
const POLICY = () => ({ book: book.toLowerCase(), hostOwnership: ownership.toLowerCase(), mirrors: [...PRODUCTION_MIRRORS], activation: 'required' });

async function sign(deny, signer = admin) {
  const prev = docs.length ? docs[docs.length - 1].digest : Z32;
  const p = { format: POLICY_FORMAT, chainId: 8453, book: book.toLowerCase(), registry: registryAddr.toLowerCase(), hostOwnership: ownership.toLowerCase(),
    sequence: docs.length + 1, issuedAt: Math.floor(Date.now() / 1000) - 5, expiresAt: 0, maxStaleSec: 0, previousDigest: prev, mode: 'denylist', deny, admit: [] };
  const d = { policy: p, digest: policyDigest(p), document: JSON.stringify(p), signature: await signer.signTypedData(policyTypedData(p)) };
  if (signer === admin) docs.push(d);
  return d;
}
const anchor = async (digest) => { const a = encodeAnchor(digest); await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'setMany', [[ANCHOR_KEYS.hi, ANCHOR_KEYS.lo], [a.hi, a.lo]]); await rig.mine(); };
async function publishAd(key, slot, kind, endpoints) {
  const blk = await rig.pc.getBlock();
  await rig.write(rig.wc(key), index, si.SERVICE_INDEX_ABI, 'publish', [slot, si.SERVICE_KINDS[kind], si.AD_VERSION, 1n, blk.timestamp + 30n * 86400n, Z32, endpoints]);
}

async function startHost(name, { importDoc = null, carriers = undefined, policyMirror = false, mirrorPeers = [] } = {}) {
  const dir = path.join(tmp, 'host-' + name);
  const ports = { dir: await freePort(), pm: await freePort() };
  assert.equal(fs.existsSync(path.join(dir, 'state')), false, 'empty caches: no admission or policy state');
  if (importDoc) { fs.mkdirSync(path.join(dir, 'import'), { recursive: true }); fs.writeFileSync(path.join(dir, 'import', `${importDoc.digest}.json`), JSON.stringify({ document: importDoc.document, signature: importDoc.signature })); }
  const services = [
    { role: 'directory-replica', package: pin('directory-replica'), heapMiB: 192, config: { port: ports.dir, bind: '127.0.0.1', stateDir: path.join(dir, 'directory-state'),
      rpc: rig.rpcs, addressBook: '0x' + '0b'.repeat(20), authorityPins: { deployments: rig.addresses.ledger, registry: rig.addresses.registry, connectivity: '0x' + '00'.repeat(20), sessionVaultFactory: '0x' + '00'.repeat(20) }, checkers: ['0x' + '3c'.repeat(20)] } },
    ...(policyMirror ? [{ role: 'policy-mirror', package: pin('policy-mirror'), heapMiB: 128, config: { port: ports.pm, bind: '127.0.0.1', stateDir: path.join(dir, 'policy-mirror-state'),
      rpc: rig.rpcs, book, hostOwnership: ownership, peers: mirrorPeers, syncSec: 5, ...(importDoc ? { importDir: path.join(dir, 'import') } : {}) } }] : []),
  ];
  const publicEndpoints = HOST_ADDR[name] ? { 'directory-replica': [`http://${HOST_ADDR[name]}:${ports.dir}/`], ...(policyMirror ? { 'policy-mirror': [`http://${HOST_ADDR[name]}:${ports.pm}/platform-policy`] } : {}) } : {};
  const cfg = { format: 'enclave-host-services/v1', host: { endpoint: `https://host-${name}.policy-placement.net`, publicEndpoints },
    platformHostPolicy: POLICY(), platformHostPolicyRpcs: rig.rpcs, ...(carriers ? { platformHostPolicyCarriers: carriers } : {}),
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
  for (const n of ['a', 'b', 'c'])
    await rig.write(rig.wc(OP_KEYS[n]), registryAddr, rig.A.registry4.abi, 'register', [`https://host-${n}.policy-placement.net`, 'independent/host', Z32, 1000n, 0n, '0x' + '00'.repeat(20)]);
  // ACTIVATED: the admin's first policy (it bans an unrelated operator) is signed and anchored before any host exists
  await sign([{ kind: 'operator', value: '0x' + '5a'.repeat(20), reason: 'unrelated abuse' }]);
  await anchor(docs[0].digest);
  for (let i = 0; i < 3; i++) await rig.mine();
});
after(async () => {
  for (const h of Object.values(hosts)) await h.running?.stop().catch(() => {});
  await rig?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('fresh hosts with empty caches start under an ACTIVATED anchor with every fleet policy mirror refused; a fleet-only host never does', { skip }, async () => {
  // host A: the first carrier, from an operator-imported copy of the signed document (untrusted bytes; verified on chain)
  hosts.a = await startHost('a', { importDoc: docs[0], carriers: { importDir: path.join(tmp, 'host-a', 'import') }, policyMirror: true });
  await wait(() => up(hosts.a.ports.dir), 30000, 'host A directory (admitted by the real gate)');
  const sa = hosts.a.running.status();
  assert.equal(sa.refusal, null); assert.equal(sa.platformHostPolicy.serving, true, JSON.stringify(sa.platformHostPolicy));
  assert.equal(sa.platformHostPolicy.runtime.accepted.digest, docs[0].digest); assert.equal(sa.platformHostPolicy.runtime.anchor, 'anchored');
  assert.ok(denied.some((u) => u.startsWith(PRODUCTION_MIRRORS[0])), 'the gate did try the fleet mirrors, and they were refused');
  const served = await wait(() => netFetch(`http://${HOST_ADDR.a}:${hosts.a.ports.pm}/platform-policy/${docs[0].digest}.json`).then((r) => r.ok && r.json()), 20000, 'host A policy mirror serves the anchored document');
  assert.equal(served.signature, docs[0].signature);
  assert.equal((await netFetch(`http://${HOST_ADDR.a}:${hosts.a.ports.pm}/platform-policy/latest.json`)).status, 404, 'no unanchored latest');

  // host A advertises its roles (operator-signed in production: runner.mjs advertise prepares exactly these); the index also
  // holds the fleet's production-shaped advertisements, every one of which is refused at the transport
  const ads = await advertisements(hosts.a.cfg, { operator: OPS.a.address, slot: 0, sequence: 1 });
  assert.deepEqual(ads.map((x) => x.kind).sort(), ['directory', 'policy']);
  for (const x of ads) await publishAd(OP_KEYS.a, ads.indexOf(x), x.kind, x.endpoints);
  await publishAd(KEYS.operator, 0, 'directory', DO.addresses.map((ip) => `http://${ip}:8188/`));
  await publishAd(KEYS.operator, 1, 'policy', DO.addresses.map((ip) => `https://${ip}/platform-policy`));
  for (let i = 0; i < 3; i++) await rig.mine();

  // host B: nothing but the pinned index. Its gate finds host A's policy mirror there and verifies the anchored document
  hosts.b = await startHost('b', { carriers: { serviceIndex: true }, policyMirror: true, mirrorPeers: [`http://127.0.0.1:${hosts.a.ports.pm}/platform-policy`] });
  await wait(() => up(hosts.b.ports.dir), 40000, 'host B directory (admitted via the index carrier)');
  assert.equal(hosts.b.running.status().platformHostPolicy.runtime.accepted.digest, docs[0].digest);
  await wait(() => fetch(`http://127.0.0.1:${hosts.b.ports.pm}/platform-policy/${docs[0].digest}.json`).then((r) => r.ok), 20000, 'host B mirror filled from its peer');
  await publishAd(OP_KEYS.b, 0, 'directory', hosts.b.cfg.host.publicEndpoints['directory-replica']);
  for (let i = 0; i < 3; i++) await rig.mine();

  // host C: the production default alone (fleet mirrors only), empty caches: fail-closed, never a first admit
  hosts.c = await startHost('c');
  await new Promise((r) => setTimeout(r, 4000));
  assert.equal(await up(hosts.c.ports.dir), false, 'host C must not serve');
  const sc = hosts.c.running.status();
  assert.match(String(sc.refusal), /has not loaded the policy the book anchors|anchored policy is not available/, JSON.stringify(sc));
  assert.equal(sc.services.every((s) => !s.running), true);
  await hosts.c.running.stop();
});

test('the admin bans host B (new anchored document, published only to an Enclave host carrier): B stops every role; the next authenticated policy unbans it', { skip }, async () => {
  const bOp = OPS.b.address.toLowerCase();
  const ban = await sign([...docs[0].policy.deny, { kind: 'operator', value: bOp, reason: 'abuse report 7' }]);
  const pub = await netFetch(`http://${HOST_ADDR.a}:${hosts.a.ports.pm}/platform-policy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: ban.document, signature: ban.signature }) });
  assert.equal(pub.status, 201, await pub.clone().text()); assert.equal((await pub.json()).anchored, false, 'published before anchoring');
  await anchor(ban.digest);
  await wait(async () => !(await up(hosts.b.ports.dir)) && !(await up(hosts.b.ports.pm)), 40000, 'host B stops every role');
  const sb = hosts.b.running.status();
  assert.match(String(sb.refusal), /banned by platform policy #2 \(operator\): abuse report 7/);
  assert.equal(sb.platformHostPolicy.banned, true); assert.ok(hosts.b.logs.some((l) => /STOPPING every role/.test(l)));
  await wait(() => hosts.a.running.status().platformHostPolicy.runtime.accepted?.digest === ban.digest, 20000, 'host A follows the new anchor');
  assert.equal(await up(hosts.a.ports.dir), true, 'host A is not banned and keeps serving');

  // an independent cold client, empty caches, fleet down: loads the anchored ban from the index's carriers itself
  const clientHosts = [];
  const r = await coldDiscover({ peers: rig.rpcs, indexPin, policy: { book, hostOwnership: ownership, activation: 'required' }, failureDomains: [DO],
    resolve: async () => [], fetch: (u, o) => { clientHosts.push(new URL(u).hostname); return netFetch(u, o); }, directoryPath: '/v1/network/providers' });
  assert.equal(r.policy.accepted.digest, ban.digest);
  assert.ok(r.refusedByPolicy.some((x) => x.candidate.operator.toLowerCase() === bOp), 'the banned operator\'s advertisement is dropped');
  assert.deepEqual(r.usable.directory, [`http://${HOST_ADDR.a}:${hosts.a.ports.dir}`]);
  assert.deepEqual(r.usable.policy, [`http://${HOST_ADDR.a}:${hosts.a.ports.pm}/platform-policy`]);
  assert.equal(r.excluded.filter((e) => e.domain === 'digitalocean').length, 8, JSON.stringify(r.excluded));
  assert.deepEqual(clientHosts.filter((h) => DO.addresses.includes(h)), [], 'the client contacted no fleet endpoint');
  assert.ok(clientHosts.includes(HOST_ADDR.a), 'it read the policy and the directory from host A');

  // stays refused while the ban is anchored (sticky), however often it checks
  await new Promise((x) => setTimeout(x, 2000));
  assert.equal(await up(hosts.b.ports.dir), false);

  // the unban: a new admin-signed document, anchored. Host B's own mirror is stopped; it loads it from host A's carrier
  const unban = await sign(docs[0].policy.deny);
  assert.equal((await netFetch(`http://${HOST_ADDR.a}:${hosts.a.ports.pm}/platform-policy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: unban.document, signature: unban.signature }) })).status, 201);
  await anchor(unban.digest);
  await wait(async () => (await up(hosts.b.ports.dir)) && (await up(hosts.b.ports.pm)), 40000, 'host B serves again after the authenticated unban');
  const s2 = hosts.b.running.status();
  assert.equal(s2.refusal, null); assert.equal(s2.platformHostPolicy.runtime.accepted.sequence, 3);
  assert.ok(hosts.b.logs.some((l) => /admitted again/.test(l)));
});

test('stale, substituted and wrongly signed documents are refused by the carrier and, independently, by the gate; an anchored rollback is refused', { skip }, async () => {
  const cur = docs[2], old = docs[0];
  const edited = JSON.stringify({ ...cur.policy, deny: [] });   // content changed under the real signature
  const post = (b) => netFetch(`http://${HOST_ADDR.a}:${hosts.a.ports.pm}/platform-policy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  assert.equal((await post({ document: edited, signature: cur.signature })).status, 422, 'substituted content');
  const forged = await sign(cur.policy.deny, privateKeyToAccount(KEYS.operator));
  assert.equal((await post({ document: forged.document, signature: forged.signature })).status, 422, 'signed by someone other than the book owner');
  assert.equal((await post({ document: 'nope', signature: '0x00' })).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${hosts.a.ports.pm}/platform-policy/${candidateDigest({ document: edited })}.json`)).status, 404, 'nothing refused was stored');

  const snapshot = quorumSnapshot({ rpcs: rig.rpcs });
  const verify = freshVerifier({ snapshot, book, hostOwnership: ownership });
  const hostA = keccak256(toBytes(hosts.a.cfg.host.endpoint)).toLowerCase();
  const lying = (cands) => async () => cands;   // a carrier that serves whatever it likes for any digest
  // rawDocument: the carrier origin answers with exactly this, skipping every carrier-side check (a hostile mirror)
  const runtimeWith = (carriers, { rawDocument = null, store = null } = {}) => createHostPolicyRuntime({ ...POLICY(), mirrors: [CARRIER_MIRROR] }, { snapshot, store,
    fetch: rawDocument ? async (url, o) => (String(url).startsWith(CARRIER_MIRROR + '/') ? new Response(JSON.stringify(rawDocument), { status: 200 }) : netFetch(url, o))
      : carrierFetch({ carriers, fetch: netFetch, verify }) });
  // the stale document (validly signed, no longer anchored) and an edited one: the carrier never shows them ...
  for (const bad of [{ document: old.document, signature: old.signature }, { document: edited, signature: cur.signature }]) {
    const rt = runtimeWith([lying([bad])]);
    await assert.rejects(rt.gate.refresh(), (e) => e.code === 'anchor_unavailable');
    assert.equal((await rt.measured(hostA).check()).serving, false, 'never a first admit');
    // ... and the gate refuses them by itself even when a carrier's own check is skipped
    const raw = runtimeWith([], { rawDocument: bad });
    await assert.rejects(raw.gate.refresh(), (e) => e.code === 'anchor_unavailable');
    assert.equal((await raw.measured(hostA).check()).serving, false);
  }
  // the honest anchored document from the same path is accepted (the refusals above were the documents, not the path)
  const good = runtimeWith([lying([{ document: cur.document, signature: cur.signature }])], { store: fileStore(path.join(tmp, 'rollback', 'policy.json')) });
  assert.equal((await good.gate.refresh()).digest, cur.digest);
  assert.equal((await good.measured(hostA).check()).serving, true);
  // rollback: the book re-anchors the older #1; a gate that accepted #3 (persisted high-water) refuses it, from a restart too
  await anchor(old.digest);
  try {
    const restarted = runtimeWith([lying([{ document: old.document, signature: old.signature }])], { store: fileStore(path.join(tmp, 'rollback', 'policy.json')) });
    await assert.rejects(restarted.gate.refresh(), (e) => e.code === 'rollback');
    assert.equal((await restarted.measured(hostA).check()).serving, false);
  } finally { await anchor(cur.digest); }
});

test('runner: a failed spawn is an exit with backoff, never an unhandled error event; heapMiB is a V8 heap cap and the old name is refused', { skip }, async () => {
  const cfg = structuredClone(hosts.a.cfg);
  cfg.stateRoot = path.join(tmp, 'spawn-state'); cfg.platformHostPolicy = 'off'; delete cfg.platformHostPolicyCarriers;
  cfg.services = [cfg.services.find((s) => s.role === 'directory-replica')]; cfg.host.publicEndpoints = {};
  assert.throws(() => validateHostServicesConfig({ ...cfg, services: [{ ...cfg.services[0], heapMiB: undefined, memoryMiB: 192 }] }), /memoryMiB is now heapMiB: it caps the V8 heap/);
  const spawned = [], logs = [];
  const spawn = (exe, argv) => {
    const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.exitCode = null; c.signalCode = null; c.kill = () => true;
    spawned.push(argv);
    if (spawned.length <= 2) { c.pid = undefined; setImmediate(() => c.emit('error', Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }))); }
    else { c.pid = 4242; c.kill = () => { setImmediate(() => c.emit('exit', null, 'SIGTERM')); return true; }; }
    return c;
  };
  const gate = { check: async () => {}, serviceRefusal: () => null, status: () => ({ platformHostPolicy: 'off' }) };
  const r = await runHostServices(cfg, { gate, spawn, log: (m) => logs.push(m), intervalMs: 100, backoffMs: 50 });
  try {
    await wait(() => spawned.length >= 3 && r.status().services[0].running, 5000, 'restarted after two failed spawns');
    assert.equal(logs.filter((l) => /could not start \(EAGAIN\); restarting in/.test(l)).length, 2);
    assert.equal(r.status().services[0].restarts, 2);
    assert.match(spawned[0][0], /^--max-old-space-size=192$/);
    assert.ok(logs.some((l) => /V8 heap cap 192 MiB/.test(l)));
  } finally { await r.stop(); }
});

test('the policy-mirror package: reviewed bytes, no secret, and its only custody/ input is the RPC quorum reader', { skip }, () => {
  const p = loadPackage(PKG, 'policy-mirror', pin('policy-mirror'));
  assert.equal(p.manifest.kind, 'policy'); assert.equal(p.manifest.secrets, 'none');
  assert.deepEqual(Object.keys(p.manifest.inputs).filter((f) => /(^|\/)custody\//.test(f)), ['custody/v2/quorum.mjs']);
  for (const f of Object.keys(p.manifest.inputs)) assert.doesNotMatch(f, /(lease-relay-service|lease-gas-runtime|sdk\/storage|secrets?-release|shield-secrets)/);
  const svc = hosts.a.cfg.services.find((s) => s.role === 'policy-mirror');
  assert.throws(() => validateHostServicesConfig({ ...hosts.a.cfg, services: [{ ...svc, config: { ...svc.config, book: '0x' + '77'.repeat(20) } }], host: { endpoint: hosts.a.cfg.host.endpoint } }),
    /book and hostOwnership must be the platformHostPolicy's/);
  assert.throws(() => validateHostServicesConfig({ ...hosts.a.cfg, services: [{ ...svc, config: { ...svc.config, signingKey: '0x01' } }], host: { endpoint: hosts.a.cfg.host.endpoint } }),
    /unknown config field "signingKey" \(a host service holds no secret\)/);
});
