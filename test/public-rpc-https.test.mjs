// The public RPC origin over HTTPS through the PACKAGED roles: network/host-services/runner.mjs (the real runner and its real
// platform host policy gate) runs the packaged public-rpc role (its node: the rig's local chain) and the packaged
// service-tls role (G3) fronting it, on the EXPLICIT LOCAL VERIFIER (chainAuthority 'verifier') of the hosted policy rig
// (anvil; the admin-owned EnclaveAddressBook, EnclaveHostOwnership and registry from source; the admin's anchored policy
// delivered by an import carrier). service-tls orders from a LOCAL ACME CA (test/helpers/acme-local-ca.mjs) through the
// child-only test preload (test/helpers/acme-local-ca-preload.mjs): the package, its "letsencrypt" configuration and its
// certificate acceptance are the production ones; only the CA endpoint and one trust root are substituted, and every other
// non-loopback destination is refused and recorded (no public provider, no mirror, no redirect target).
//   - the RPC name rpc-<b32>.<zone> is fronted ONLY because tlsPorts names public-rpc and the host runs it: one order with
//     exactly that name (real http-01 through the port-80 front), the certificate's SAN exactly it, empty subject (CN rule);
//   - real JSON-RPC methods over HTTPS with SNI and Host = that name; no redirect; the role's CORS for the configured origin;
//   - an unknown SNI (the fixed three names, which tlsPorts does not list, and a foreign name) gets no certificate; an
//     unknown Host on port 80 is 421;
//   - restart: the stored certificate is loaded and served without a new order;
//   - the administrator's ban (a new anchored policy through the carrier) stops HTTPS; the unban restores it, no new order;
//   - configuration refusals: tlsPorts.public-rpc without the role, the role on ::1 (not frontable on 127.0.0.1), a TLS port
//     that is the role's own port; the role running WITHOUT a tlsPorts entry is not fronted (no name, no upstream).
// Renewal at 2/3 of the lifetime and the held/approved ordering gate are G3's own in-process tests (test/service-tls.test.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import https from 'node:https';
import http from 'node:http';
import { createHash, X509Certificate } from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stringToHex, keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { startRig, haveTools, KEYS, freePort } from './helpers/cli-independent-rig.mjs';
import { startLoopbackVerifier } from './helpers/loopback-verifier.mjs';
import { startLocalAcmeCa } from './helpers/acme-local-ca.mjs';
import { runHostServices, validateHostServicesConfig } from '../network/host-services/runner.mjs';
import { bindServiceTls, validateServiceTlsConfig, validateLaunchConfig } from '../network/host-services/service-tls.mjs';
import { hostRpcName, hostServiceNames, HOST_RPC_ROLE } from '../network/host-service-names.mjs';
import { POLICY_FORMAT, policyTypedData, policyDigest, encodeAnchor, ANCHOR_KEYS } from '../network/platform-host-policy.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(REPO, 'network/host-services/packages');
const OUT = path.join(REPO, 'contracts/foundry/out');
const PRELOAD = new URL('./helpers/acme-local-ca-preload.mjs', import.meta.url).href;
const skip = haveTools() || (!['public-rpc', 'service-tls'].every((r) => fs.existsSync(path.join(PKG, `${r}.package.json`))) ? 'needs the built packages (scripts/build-host-service-packages.mjs)' : false);
const pin = (role) => 'sha256:' + createHash('sha256').update(fs.readFileSync(path.join(PKG, `${role}.package.json`))).digest('hex');
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(OUT, file, name + '.json'), 'utf8')); return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rpc-https-'));
const Z32 = '0x' + '00'.repeat(32);
const admin = privateKeyToAccount(KEYS.deployer), OP = privateKeyToAccount(KEYS.owner);
const ENDPOINT = 'https://host-c.policy-placement.net', HOST_ID = keccak256(toBytes(ENDPOINT)).toLowerCase(), ZONE = 'app.policy-placement.net';
const RPC_NAME = hostRpcName(HOST_ID, ZONE), FIXED = hostServiceNames(HOST_ID, ZONE), ORIGIN = 'https://dashboard.policy-placement.net';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const denied = [];
const netFetch = (url, opts) => { const u = new URL(url); if (u.hostname === '127.0.0.1') return fetch(u, opts); denied.push(u.href); return Promise.reject(new TypeError(`no route to ${u.hostname}`)); };

let rig, verifier, miner, ca, book, ownership, bookAbi, registryAddr, host = null, docs = [], P, preloadLog, importDir;
const POLICY = () => ({ book: book.toLowerCase(), hostOwnership: ownership.toLowerCase(), mirrors: [], activation: 'required' });
async function sign(deny) {
  const prev = docs.length ? docs[docs.length - 1].digest : Z32;
  const p = { format: POLICY_FORMAT, chainId: 8453, book: book.toLowerCase(), registry: registryAddr.toLowerCase(), hostOwnership: ownership.toLowerCase(),
    sequence: docs.length + 1, issuedAt: Math.floor(Date.now() / 1000) - 5, expiresAt: 0, maxStaleSec: 0, previousDigest: prev, mode: 'denylist', deny, admit: [] };
  const d = { policy: p, digest: policyDigest(p), document: JSON.stringify(p), signature: await admin.signTypedData(policyTypedData(p)) };
  docs.push(d);
  fs.writeFileSync(path.join(importDir, `${d.digest}.json`), JSON.stringify({ document: d.document, signature: d.signature }));   // the import carrier
  const a = encodeAnchor(d.digest); await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'setMany', [[ANCHOR_KEYS.hi, ANCHOR_KEYS.lo], [a.hi, a.lo]]); await rig.mine();
  return d;
}
const V = () => ({ chainAuthority: 'verifier', chainVerifier: verifier.url });
const config = (over = {}) => ({ format: 'enclave-host-services/v1', host: { endpoint: ENDPOINT, publicEndpoints: {} }, platformHostPolicy: POLICY(),
  platformHostPolicyCarriers: { importDir }, ...V(), packagesDir: PKG, stateRoot: path.join(tmp, 'state'),
  services: [
    { role: 'public-rpc', package: pin('public-rpc'), heapMiB: 96, config: { port: P.rpc, bind: '127.0.0.1', hostId: HOST_ID, chainId: 8453, node: rig.rpc, allowedOrigins: [ORIGIN] } },
    { role: 'service-tls', package: pin('service-tls'), heapMiB: 128, config: { hostId: HOST_ID, zone: ZONE, httpPort: P.http, tlsPorts: { [HOST_RPC_ROLE]: P.tls }, ca: 'letsencrypt', orders: 'approved' } },
  ], ...over });
// the runner's spawn, unchanged except that the service-tls child gets the test preload and its three variables
const spawn = (cmd, argv, opts) => /[\\/]service-tls\.mjs$/.test(argv[argv.length - 1] || '') || argv.some((a) => /[\\/]service-tls\.mjs$/.test(a))
  ? spawnChild(cmd, ['--import', PRELOAD, ...argv], { ...opts, env: { ...opts.env, ACME_LOCAL_CA: ca.url, ACME_LOCAL_ROOT: ca.rootFile, ACME_LOCAL_LOG: preloadLog } })
  : spawnChild(cmd, argv, opts);
const logs = [];
const start = async () => { host = await runHostServices(config(), { fetch: netFetch, spawn, log: (m) => logs.push(m), intervalMs: 500, gateIntervalMs: 500 }); };
const diag = () => `${JSON.stringify(host?.status?.() ?? null).slice(0, 1500)}\n${logs.slice(-30).join('\n').slice(-4000)}\n--- preload\n${fs.existsSync(preloadLog) ? fs.readFileSync(preloadLog, 'utf8').slice(-2000) : ''}`;
const wait = async (f, ms = 60000, what = 'condition') => { const end = Date.now() + ms; for (;;) { try { const v = await f(); if (v) return v; } catch {} if (Date.now() > end) throw new Error(`timed out: ${what}\n${diag()}`); await sleep(250); } };

/** a TLS handshake to the loopback front with this SNI, trusting only the local CA's root -> { ok, cert, error } */
const handshake = (servername) => new Promise((ok) => {
  const s = tls.connect({ host: '127.0.0.1', port: P.tls, servername, ca: [ca.rootPem], rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] }, () => {
    const cert = s.getPeerX509Certificate(); s.end(); ok({ ok: s.authorized === true, cert });
  });
  s.on('error', (e) => ok({ ok: false, error: e.message })); s.setTimeout(5000, () => { s.destroy(); ok({ ok: false, error: 'timeout' }); });
});
/** one JSON-RPC call over HTTPS to the RPC name (SNI and Host), trusting only the local CA's root */
const rpcHttps = (method, params = []) => new Promise((ok, no) => {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const r = https.request({ host: '127.0.0.1', port: P.tls, servername: RPC_NAME, ca: [ca.rootPem], method: 'POST', path: '/', agent: false,
    headers: { host: RPC_NAME, origin: ORIGIN, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, json: (() => { try { return JSON.parse(b); } catch { return b; } })() }));
  });
  r.on('error', no); r.setTimeout(10000, () => r.destroy(new Error('timeout'))); r.end(body);
});
const http80 = (hostHeader, p = '/') => new Promise((ok) => {
  const r = http.get({ host: '127.0.0.1', port: P.http, path: p, headers: { host: hostHeader }, agent: false, timeout: 5000 }, (res) => { res.resume(); res.on('end', () => ok(res.statusCode)); });
  r.on('error', () => ok(null)); r.on('timeout', () => { r.destroy(); ok(null); });
});
const preloadLines = () => (fs.existsSync(preloadLog) ? fs.readFileSync(preloadLog, 'utf8').trim().split('\n') : []);

before(async () => {
  if (skip) return;
  importDir = path.join(tmp, 'import'); fs.mkdirSync(importDir, { recursive: true }); preloadLog = path.join(tmp, 'preload.log');
  P = { rpc: await freePort(), http: await freePort(), tls: await freePort() };
  rig = await startRig();
  registryAddr = rig.addresses.registry;
  const B = art('EnclaveAddressBook.sol', 'EnclaveAddressBook'); bookAbi = B.abi;
  book = await rig.deploy(B);
  await rig.write(rig.wc(KEYS.deployer), book, bookAbi, 'set', [stringToHex('registry', { size: 32 }), registryAddr]);
  ownership = await rig.deploy(art('EnclaveHostOwnership.sol', 'EnclaveHostOwnership'), [registryAddr]);
  await rig.write(rig.wc(KEYS.owner), registryAddr, rig.A.registry4.abi, 'register', [ENDPOINT, 'independent/host', Z32, 1000n, 0n, '0x' + '00'.repeat(20)]);
  await sign([{ kind: 'operator', value: '0x' + '5a'.repeat(20), reason: 'unrelated abuse' }]);
  verifier = await startLoopbackVerifier({ upstream: rig.rpc });
  miner = setInterval(() => void rig.mine().catch(() => {}), 2000);
  ca = await startLocalAcmeCa({ dir: path.join(tmp, 'ca'), httpPort: P.http });
});
after(async () => {
  clearInterval(miner);
  await host?.stop().catch(() => {});
  await ca?.close(); await verifier?.close(); await rig?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('configuration: the RPC name is fronted only for the host\'s own public-rpc with an explicit TLS port', { skip }, () => {
  const c = config(), svc = (cfg) => cfg.services.find((s) => s.role === 'service-tls').config;
  const bound = svc(validateHostServicesConfig(c));
  assert.deepEqual(bound.upstreams, { [HOST_RPC_ROLE]: P.rpc }, 'the upstream is the role\'s own port');
  assert.equal(bound.policy.chainAuthority, 'verifier', 'admission reads the policy through the runner\'s own authority');
  assert.equal(bound.policy.chainVerifier, verifier.url);
  // tlsPorts.public-rpc without the role
  assert.throws(() => validateHostServicesConfig(config({ services: [config().services[1]] })), /tlsPorts\.public-rpc: this host does not run public-rpc|runs none of/);
  // the role on ::1 cannot be fronted on 127.0.0.1
  const v6 = config(); v6.services[0].config.bind = '::1';
  assert.throws(() => validateHostServicesConfig(v6), /public-rpc must listen on 127\.0\.0\.1 or 0\.0\.0\.0/);
  // a TLS port that is the role's own port
  const clash = config(); clash.services[1].config.tlsPorts = { [HOST_RPC_ROLE]: P.rpc };
  assert.throws(() => validateHostServicesConfig(clash), /port \d+ is another role's/);
  // the role running WITHOUT a tlsPorts entry is not fronted: a host running public-rpc and a fixed role, tlsPorts naming
  // only the fixed role, binds no RPC upstream (so no RPC name is ordered, routed or served)
  const own = { hostId: HOST_ID, zone: ZONE, httpPort: P.http, tlsPorts: { 'directory-replica': P.tls }, ca: 'letsencrypt' };
  const b = bindServiceTls(validateServiceTlsConfig(own), { host: { endpoint: ENDPOINT }, platformHostPolicy: POLICY(), stateRoot: tmp,
    services: [{ role: 'public-rpc', config: { port: P.rpc, bind: '127.0.0.1' } }, { role: 'directory-replica', config: { port: P.rpc + 1, bind: '127.0.0.1' } }] });
  assert.deepEqual(b.upstreams, { 'directory-replica': P.rpc + 1 });
  assert.throws(() => validateLaunchConfig({ ...b, upstreams: { ...b.upstreams, [HOST_RPC_ROLE]: P.rpc } }), /fronted only with its tlsPorts entry/);
  // the three fixed names are unchanged and never include the RPC origin
  assert.deepEqual(Object.keys(FIXED).sort(), ['bootstrap-replica', 'directory-replica', 'policy-mirror']);
});

test('admission authority: service-tls reads the platform policy through the runner\'s verifier; G3\'s original field list did not', { skip }, async () => {
  const { POLICY_FIELDS } = await import('../network/host-services/service-tls.mjs');
  const { policyEnv } = await import('../network/host-services/runner.mjs');
  const { resolveHostPolicyConfig, hostPolicySnapshot } = await import('../network/host-policy-runtime.mjs');
  const { PRODUCTION_RPCS } = await import('../network/platform-host-policy-config.mjs');
  const G3_FIELDS = ['platformHostPolicy', 'platformHostPolicyMirrors', 'platformHostPolicyRpcs', 'platformHostPolicyCarriers', 'serviceIndex'];
  // what service-tls's policyAdmission resolves from the fields the runner binds into its config
  const resolveWith = (cfg, fields) => resolveHostPolicyConfig({ env: policyEnv(Object.fromEntries(fields.filter((k) => cfg[k] !== undefined).map((k) => [k, cfg[k]]))), chainId: 8453 });
  for (const platformHostPolicy of [POLICY(), 'production']) {
    const cfg = validateHostServicesConfig(config({ platformHostPolicy }));
    const now = resolveWith(cfg, POLICY_FIELDS);
    assert.equal(now.config.chainAuthority, 'verifier', `${JSON.stringify(platformHostPolicy).slice(0, 20)}: the runner's verifier`);
    assert.equal(now.config.chainVerifier, verifier.url);
    assert.doesNotThrow(() => hostPolicySnapshot(now.config), 'a verified snapshot (the RPC list is never used with the verifier)');
  }
  // counterexamples with G3's frozen list on this verifier-mode host:
  //   "production" (G3's own live config shape): the production PUBLIC RPC quorum - a provider fallback in verifier mode;
  const prod = resolveWith(validateHostServicesConfig(config({ platformHostPolicy: 'production' })), G3_FIELDS);
  assert.equal(prod.config.chainAuthority, undefined); assert.deepEqual([...prod.config.rpcs], [...PRODUCTION_RPCS]);
  //   an explicit platform policy (no RPC list in verifier mode): no snapshot at all - the role could never admit
  const expl = resolveWith(validateHostServicesConfig(config()), G3_FIELDS);
  assert.equal(expl.config.chainAuthority, undefined); assert.equal(expl.config.rpcs, null);
  assert.throws(() => hostPolicySnapshot(expl.config));
});

test('packaged: one order for exactly the RPC name; SAN and SNI exact; real methods over HTTPS; no redirect; nothing else reachable', { skip, timeout: 240_000 }, async () => {
  await start();
  await wait(() => preloadLines().some((l) => /^acme POST \/cert\//.test(l)) && logs.some((l) => /certificate issued for/.test(l)), 120000, 'the certificate is issued');
  await wait(async () => (await handshake(RPC_NAME)).ok, 30000, 'the TLS front serves the RPC name');
  // one order, exactly the RPC name, validated through the port-80 front
  assert.deepEqual(ca.st.newOrders, [[RPC_NAME]]);
  assert.deepEqual(ca.st.validations, [{ name: RPC_NAME, ok: true }]);
  assert.equal(ca.st.badCsr, 0);
  const h = await handshake(RPC_NAME);
  assert.equal(h.ok, true, h.error);
  assert.equal(h.cert.subjectAltName, `DNS:${RPC_NAME}`, 'the SAN is exactly the RPC name');
  assert.ok(!new X509Certificate(h.cert.raw).subject, 'empty subject (no CN): the derived name is longer than a CN may be');
  // real methods through TLS, SNI and Host = the RPC name
  const id = await rpcHttps('eth_chainId');
  assert.equal(id.status, 200); assert.equal(id.json.result, '0x2105');
  assert.equal(id.headers.location, undefined, 'no redirect');
  assert.equal(id.headers['access-control-allow-origin'], ORIGIN);
  const bn = await rpcHttps('eth_blockNumber');
  assert.equal(bn.status, 200); assert.ok(BigInt(bn.json.result) > 0n);
  const head = BigInt(await rig.rpcCall('eth_blockNumber'));
  assert.ok(head - BigInt(bn.json.result) <= 3n, 'the same chain as the node');
  const bal = await rpcHttps('eth_getBalance', [OP.address, 'latest']);
  assert.equal(bal.status, 200); assert.ok(BigInt(bal.json.result) > 0n);
  // an unknown SNI gets no certificate: the fixed names (not in tlsPorts) and a foreign name
  for (const n of [FIXED['directory-replica'], FIXED['policy-mirror'], 'rpc-foreign.' + ZONE, 'example.com']) {
    const x = await handshake(n); assert.equal(x.ok, false, `SNI ${n} refused`);
  }
  // port 80: an unknown Host is misdirected; an unknown challenge token is not found
  assert.equal(await http80('example.com'), 421);
  assert.equal(await http80(RPC_NAME, '/.well-known/acme-challenge/no-such-token'), 404);
  // nothing but loopback and the (mapped) CA origin was reached, every ACME fetch bounded and non-redirecting
  const lines = preloadLines();
  assert.ok(lines.some((l) => /^preload active/.test(l)), 'the preload ran in the service-tls child');
  assert.deepEqual(lines.filter((l) => /^(refused|violation)/.test(l)), [], 'no other destination, no unbounded or redirecting fetch');
  assert.deepEqual(denied, [], 'the runner reached nothing off loopback');
});

test('restart: the stored certificate is served without a new order', { skip, timeout: 180_000 }, async () => {
  await host.stop(); host = null;
  assert.equal((await handshake(RPC_NAME)).ok, false, 'stopped: nothing listens');
  await start();
  await wait(async () => (await handshake(RPC_NAME)).ok, 60000, 'served again after the restart');
  assert.ok(logs.some((l) => /loaded the stored certificate/.test(l)), 'loaded, not re-ordered');
  assert.equal(ca.st.newOrders.length, 1, 'no second order');
  assert.equal((await rpcHttps('eth_chainId')).json.result, '0x2105');
});

test('administration: the admin\'s ban stops HTTPS; the unban restores it with the same certificate', { skip, timeout: 180_000 }, async () => {
  const serial = (await handshake(RPC_NAME)).cert.serialNumber;
  await sign([{ kind: 'operator', value: OP.address.toLowerCase(), reason: 'abuse' }]);
  await wait(async () => !(await handshake(RPC_NAME)).ok, 60000, 'banned: the TLS front is closed');
  assert.ok(logs.some((l) => /STOPPING every role|host services stopped|banned/.test(l)), 'the runner reports the ban');
  await sign([]);
  await wait(async () => (await handshake(RPC_NAME)).ok, 90000, 'unbanned: served again');
  assert.equal((await handshake(RPC_NAME)).cert.serialNumber, serial, 'the same certificate');
  assert.equal(ca.st.newOrders.length, 1, 'no new order');
  assert.deepEqual(preloadLines().filter((l) => /^(refused|violation)/.test(l)), []);
});
