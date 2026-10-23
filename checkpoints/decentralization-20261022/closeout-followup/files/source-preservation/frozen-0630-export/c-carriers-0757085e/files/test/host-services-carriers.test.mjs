// The privacy agent's host services WITHOUT the fleet's policy mirrors: the explicit enclaveNetwork.hostServicesPolicy
// block gives the unchanged platform host policy gate (network/host-service-gate.mjs) the integrated runner's CARRIERS
// (network/host-services/runner.mjs policyCarrierFetch -> network/policy-carriers.mjs) through the shared
// network/host-policy-carrier-gate.mjs. On the REAL daemon (node network/privacy-agent.mjs --config) and the REAL enrollment
// pass, with every connection to the four DigitalOcean fronts and every *.enclave.host lookup refused and logged.
//
// FIXTURE, not deployed provider independence: the chain and the administrator are test/helpers/platform-policy-world.mjs
// (loopback JSON-RPC answering the AddressBook anchor/owner, registry rows and host ownership; documents signed by its
// admin key). The policy's own mirror list is the PRODUCTION one (the four fronts), all refused at the socket; the signed
// document reaches the host only from a carrier: an operator-imported directory, this host's policy-mirror store, or an
// independent peer's mirror. Carriers supply bytes, never authority: the gate admits only the digest the book anchors,
// signed by the book's current owner, at a fresh agreed block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { platformPolicyWorld, BOOK, OWNERSHIP } from './helpers/platform-policy-world.mjs';
import { hostRig, daemon, sleep, count, ENDPOINT, RUNNER, DO_FRONTS, HS } from './helpers/privacy-agent-rig.mjs';
import { PRODUCTION_MIRRORS } from '../network/platform-host-policy-config.mjs';
import { policyTypedData } from '../network/platform-host-policy.mjs';
import { quorumSnapshot } from '../network/host-policy-runtime.mjs';
import { hostServicesPolicyConfig, hostPolicyGateEnv, CARRIER_MIRROR } from '../network/host-policy-gate-config.mjs';
import { CARRIER_MIRROR as CARRIER_MIRROR_PC, validateCarrierBases } from '../network/policy-carriers.mjs';
import { hostPolicyCarrierGate } from '../network/host-policy-carrier-gate.mjs';
import { createNetworkEnroll, appLessRefusal, readHostServicesFile } from '../windows/node/network-enroll.mjs';

const OPERATOR = '0x' + '44'.repeat(20);
const STARTED = /host services: \{/, STOPPED = /host services stopped: platform host policy:/, HELD = /host services held: platform host policy:/;
const FAST = { ENCLAVE_PLATFORM_HOST_POLICY_INTERVAL_SEC: '1', ENCLAVE_PLATFORM_HOST_POLICY_GRACE_SEC: '6' };
const world = (t) => platformPolicyWorld(t, { hosts: { [RUNNER]: { endpoint: ENDPOINT, operator: OPERATOR, owner: '0x' + '55'.repeat(20), active: true } } });
// the production-shaped policy for the fixture's book: its mirrors are the four fleet fronts (all refused here)
const block = (w, carriers) => ({ policy: { book: BOOK, hostOwnership: OWNERSHIP, mirrors: [...PRODUCTION_MIRRORS] }, rpcs: w.rpcs, carriers });
const tmpDir = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const put = (dir, name, body) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body)); };
const ban = [{ kind: 'operator', value: OPERATOR, reason: 'abuse' }];
const fleetTried = (rig) => rig.blocked().filter((h) => DO_FRONTS.includes(h));
const noEnclaveLookups = (rig) => assert.deepEqual(rig.blocked().filter((h) => !DO_FRONTS.includes(h)), [], 'no *.enclave.host name was looked up');

test('shared helper: one carrier origin and base rule (policy-carriers re-exports them); the block is explicit and validated', () => {
  assert.equal(CARRIER_MIRROR, CARRIER_MIRROR_PC);
  assert.deepEqual(validateCarrierBases(['http://10.0.0.1:8190/platform-policy/']), ['http://10.0.0.1:8190/platform-policy']);
  const ok = hostServicesPolicyConfig({ policy: 'production', carriers: { importDir: '/var/lib/policy-import', peers: ['https://peer.example/platform-policy'] } });
  const { env, shape } = hostPolicyGateEnv(ok);
  assert.equal(env.ENCLAVE_PLATFORM_HOST_POLICY, 'production'); assert.equal(env.ENCLAVE_PLATFORM_HOST_POLICY_MIRRORS, CARRIER_MIRROR);
  assert.deepEqual(shape.platformHostPolicyCarriers, { importDir: '/var/lib/policy-import', peers: ['https://peer.example/platform-policy'] });
  assert.deepEqual(hostServicesPolicyConfig({ policy: 'production', carriers: { policyMirrorStateDir: 'C:\\ProgramData\\Enclave\\pm' } }).carriers, { policyMirrorStateDir: 'C:\\ProgramData\\Enclave\\pm' });
  for (const [c, re] of [[{ policy: 'production', extra: 1 }, /unknown field/], [{ policy: { book: BOOK, hostOwnership: OWNERSHIP, mirrors: [] } }, /RPC quorum is unknown/],
    [{ policy: 'production', carriers: { importDir: 'relative' } }, /absolute path/], [{ policy: 'production', carriers: {} }, /names no carrier/],
    [{ policy: 'production', carriers: { peers: ['ftp://x'] } }, /distinct http\(s\) base URLs/], [{ policy: 'off', carriers: { importDir: '/x' } }, /"off" takes no/],
    [{ policy: 'production', rpcs: ['https://a.example'] }, /2 to 8 RPCs/], [{ policy: 'production', rpcs: ['https://a.example/x', 'https://a.example/y'] }, /distinct providers/],
    [{ policy: 'production', rpcs: ['http://rpc.example', 'https://b.example'] }, /rpcs\[0\]/], [{ policy: 'nope' }, /policy must be/], [null, /must be an object/]])
    assert.throws(() => hostServicesPolicyConfig(c), re, JSON.stringify(c));
});

test('empty state, every fleet front refused: the first authenticated admit comes from an imported carrier', { timeout: 90_000 }, async (t) => {
  const w = await world(t), d1 = await w.publish({ deny: [] }), importDir = tmpDir(t, 'policy-import-');
  put(importDir, d1, w.document(d1));
  const rig = await hostRig(t, { extra: { hostServicesPolicy: block(w, { importDir }) } }), d = daemon(t, rig, { env: FAST });
  await d.until(/no apps: running this host's services only/); await d.until(STARTED);
  assert.ok(fleetTried(rig).length >= 1, 'the production mirrors were tried, and refused at the socket');
  noEnclaveLookups(rig);
  assert.ok((await d.stop())?.code === 0);
});

test('missing, unanchored, substituted and wrongly signed carrier data never admit; the anchored document then does, without a restart', { timeout: 120_000 }, async (t) => {
  const w = await world(t), d1 = await w.publish({ deny: [] }), d2 = await w.publish({ deny: [] });
  w.anchor(d1);                                                    // d2: validly signed by the admin, but NOT the anchored digest
  const importDir = tmpDir(t, 'policy-import-');
  const rig = await hostRig(t, { extra: { hostServicesPolicy: block(w, { importDir }) } }), d = daemon(t, rig, { env: FAST });
  await d.until(HELD); await sleep(3000);
  const cur = w.document(d1), policy = JSON.parse(cur.document);
  const forged = await privateKeyToAccount(generatePrivateKey()).signTypedData(policyTypedData(policy));
  for (const [why, write] of [
    ['a validly signed but unanchored document', () => put(importDir, d2, w.document(d2))],
    ['another document under the anchored name', () => put(importDir, d1, w.document(d2))],
    ['substituted content under the real signature', () => put(importDir, d1, { document: JSON.stringify({ ...policy, deny: ban }), signature: cur.signature })],
    ['the anchored content signed by another key', () => put(importDir, d1, { document: cur.document, signature: forged })]]) {
    write(); await sleep(3500);
    assert.equal(count(d.out, STARTED), 0, `${why}: never admitted`);
  }
  put(importDir, d1, cur);                                         // the real one
  await d.until(STARTED);
  assert.ok((await d.stop())?.code === 0); noEnclaveLookups(rig);
});

test('admin ban and allow arrive through the carrier; a missing updated document and an anchored rollback fail closed', { timeout: 150_000 }, async (t) => {
  const w = await world(t), importDir = tmpDir(t, 'policy-import-');
  const d1 = await w.publish({ deny: [] }); put(importDir, d1, w.document(d1));
  const rig = await hostRig(t, { extra: { hostServicesPolicy: block(w, { importDir }) } }), d = daemon(t, rig, { env: FAST });
  await d.until(STARTED);
  const d2 = await w.publish({ deny: ban }); put(importDir, d2, w.document(d2));           // the admin bans this host
  await d.until(STOPPED); assert.match(d.out, /host services stopped: platform host policy: banned by platform policy #2 \(operator\): abuse/);
  const d3 = await w.publish({ deny: [] }); await sleep(4000);                               // the unban, NOT yet carried
  assert.equal(count(d.out, STARTED), 1, 'a known ban is never lifted without the authenticated unban');
  put(importDir, d3, w.document(d3)); await d.until(STARTED, 20_000, 2);
  await w.publish({ deny: [] });                                                            // an update nobody carries
  await d.until(STOPPED, 25_000, 2);                                                         // admitted -> undecided -> past the grace
  assert.equal(count(d.out, STARTED), 2);
  w.anchor(d1);                                                                             // the admin re-anchors an OLDER document (still carried)
  await sleep(5000);
  assert.equal(count(d.out, STARTED), 2, 'an anchored rollback (sequence below the high-water) never admits');
  assert.ok((await d.stop())?.code === 0); noEnclaveLookups(rig);
});

test('first app added and last app removed never touch host services; a restart needs a FRESH authenticated admit', { timeout: 120_000 }, async (t) => {
  const w = await world(t), importDir = tmpDir(t, 'policy-import-');
  const d1 = await w.publish({ deny: [] }); put(importDir, d1, w.document(d1));
  const rig = await hostRig(t, { extra: { hostServicesPolicy: block(w, { importDir }) } });
  let d = daemon(t, rig, { env: FAST });
  await d.until(STARTED);
  rig.write({ ...rig.cfg, apps: [rig.app] }); d.child.kill('SIGHUP'); await d.until(/config reloaded: 1 apps \(1 added, 0 changed\)/);
  rig.write({ ...rig.cfg, apps: [] }); d.child.kill('SIGHUP'); await d.until(/config reloaded: 1 apps \(0 added, 0 changed\)/);
  await sleep(2500);
  assert.equal(count(d.out, STARTED), 1); assert.doesNotMatch(d.out, /host services stopped|HOST SERVICES REFUSED/);
  let exit = await d.stop(); assert.ok(exit?.code === 0, JSON.stringify(exit));
  // restart with the chain unreadable: nothing restored from local state admits
  w.setDown(true); d = daemon(t, rig, { env: FAST });
  await d.until(HELD); await sleep(4000); assert.equal(count(d.out, STARTED), 0, 'no admit without a fresh agreed block');
  w.setDown(false); await d.until(STARTED);
  exit = await d.stop(); assert.ok(exit?.code === 0 || (exit?.code === 1 && /stopped during startup/.test(d.out)), JSON.stringify(exit));
});

test('this host\'s policy-mirror store (read from disk, the role need not run) and an independent peer\'s mirror carry the document', { timeout: 90_000 }, async (t) => {
  const w = await world(t), d1 = await w.publish({ deny: [] });
  const store = tmpDir(t, 'policy-mirror-state-'); put(path.join(store, 'documents'), d1, w.document(d1));
  let rig = await hostRig(t, { extra: { hostServicesPolicy: block(w, { policyMirrorStateDir: store }) } }), d = daemon(t, rig, { env: FAST });
  await d.until(STARTED); await d.stop();
  const served = [];
  const peer = http.createServer((req, res) => { served.push(req.url); const m = /^\/platform-policy\/(0x[0-9a-f]{64})\.json$/.exec(req.url);
    const doc = m && w.document(m[1]); res.writeHead(doc ? 200 : 404, { 'content-type': 'application/json' }); res.end(doc ? JSON.stringify(doc) : ''); });
  await new Promise((r) => peer.listen(0, '127.0.0.1', r)); t.after(() => peer.close());
  rig = await hostRig(t, { extra: { hostServicesPolicy: block(w, { peers: [`http://127.0.0.1:${peer.address().port}/platform-policy`] }) } }); d = daemon(t, rig, { env: FAST });
  await d.until(STARTED);
  assert.ok(served.includes(`/platform-policy/${d1}.json`), 'the peer served the anchored digest');
  await d.stop(); noEnclaveLookups(rig);
});

test('a malformed policy block refuses an app-less agent before anything binds; with apps, it refuses host services only', { timeout: 90_000 }, async (t) => {
  const w = await world(t);
  for (const [bad, re] of [[{ ...block(w, { importDir: '/x' }), extra: 1 }, /unknown field/], [{ policy: { book: BOOK, hostOwnership: OWNERSHIP, mirrors: [] } }, /RPC quorum is unknown/],
    [block(w, { importDir: 'relative/dir' }), /absolute path/], [block(w, { peers: ['ftp://x'] }), /distinct http\(s\) base URLs/]]) {
    const rig = await hostRig(t, { extra: { hostServicesPolicy: bad } }), d = daemon(t, rig, { env: FAST });
    const e = await Promise.race([d.exited, sleep(20_000).then(() => null)]);
    assert.equal(e?.code, 1, d.out); assert.match(d.out, /an empty app list runs only this host's services, and they are refused \(platform host policy: enclaveNetwork\.hostServicesPolicy/);
    assert.match(d.out, re); assert.doesNotMatch(d.out, /host services: \{|control circuits/);
  }
  const rig = await hostRig(t, { apps: 1, extra: { hostServicesPolicy: { policy: 'nope' } } }), d = daemon(t, rig, { env: FAST });
  await d.until(/HOST SERVICES REFUSED \(apps unaffected\): platform host policy: enclaveNetwork\.hostServicesPolicy: policy must be/);
  await sleep(1500); assert.equal(d.child.exitCode, null, 'the apps keep running'); assert.equal(count(d.out, STARTED), 0);
  await d.stop();
});

test('verifier seam: with one injected chain authority, neither the gate nor a carrier opens a raw RPC quorum of its own', { timeout: 60_000 }, async (t) => {
  const w = await world(t), d1 = await w.publish({ deny: [] }), importDir = tmpDir(t, 'policy-import-');
  put(importDir, d1, w.document(d1));
  // the block's own RPCs are DEAD: any raw-RPC use would fail; only the injected authority can answer
  const h = hostServicesPolicyConfig({ policy: { book: BOOK, hostOwnership: OWNERSHIP, mirrors: [] }, rpcs: ['http://127.0.0.1:1', 'http://127.0.0.1:2'], carriers: { importDir } });
  const real = quorumSnapshot({ rpcs: w.rpcs }); let calls = 0;
  const snapshot = (fn) => { calls++; return real(fn); };
  const gate = await hostPolicyCarrierGate(h, { hostId: RUNNER, stateDir: tmpDir(t, 'gate-'), snapshot });
  await gate.check();
  assert.equal(gate.serviceRefusal(), null, 'admitted through the injected authority and the carrier'); assert.ok(calls >= 2, `the gate and the carrier both used it (${calls})`);
  const control = await hostPolicyCarrierGate(h, { hostId: RUNNER, stateDir: tmpDir(t, 'gate-') });
  await control.check();
  assert.match(String(control.serviceRefusal()), /platform host policy/, 'control: without it, the dead raw quorum admits nothing');
});

// ---- enrollment carries the explicit block (the fresh box's opt-in file) ----
function enrollRig(t, optIn) {
  const dir = tmpDir(t, 'hs-carrier-enroll-'), agentDir = path.join(dir, 'agent'), policyFile = path.join(dir, 'policy.json'), file = path.join(dir, 'host-services.json');
  fs.mkdirSync(agentDir); fs.mkdirSync(path.join(dir, 'bin')); fs.writeFileSync(path.join(dir, 'bin', 'host-service-ingress.mjs'), '// the staged worker');
  fs.writeFileSync(policyFile, JSON.stringify({ cpu: { runtimeId: 'ab'.repeat(32) }, gpu: {} })); fs.writeFileSync(file, JSON.stringify(optIn));
  const w = { logs: [], restarts: 0, file, cfgFile: path.join(agentDir, 'privacy-config.json') };
  const config = { agentDir, binDir: path.join(dir, 'bin'), nodeBinary: 'node.exe', operatorKeyFile: 'op.key', runner: RUNNER, endpoint: ENDPOINT, relayBase: 'https://api.enclave.host',
    policyFile, tpmBinary: 'tpmattest.exe', tpmSha256: 'aa'.repeat(32), addressBook: '0x' + '44'.repeat(20), chainRpc: ['https://rpc'], enclaveNetwork: { checkers: ['0x' + '57'.repeat(20)] }, hostServicesFile: file };
  w.enroll = createNetworkEnroll({ agentDir, binDir: path.join(dir, 'bin'), runner: RUNNER, relayBase: 'https://api.enclave.host', restartAgent: async () => { w.restarts++; }, config, log: (m) => w.logs.push(m),
    fetch: async () => ({ ok: true, json: async () => ({ domains: {} }) }), rows: async () => [], version: async () => ({}), vms: async () => [] });
  w.read = () => JSON.parse(fs.readFileSync(w.cfgFile, 'utf8')); w.exists = () => fs.existsSync(w.cfgFile);
  return w;
}

test('enrollment: the opt-in file carries hostServicesPolicy (a non-production book becomes eligible only through it); an invalid one writes nothing', async (t) => {
  const hsp = { policy: { book: BOOK, hostOwnership: OWNERSHIP, mirrors: [...PRODUCTION_MIRRORS] }, rpcs: ['https://rpc-a.example', 'https://rpc-b.example'], carriers: { importDir: '/var/lib/enclave/policy-import' } };
  let w = enrollRig(t, { hostServices: HS });
  assert.equal((await w.enroll.pass()).changed, false, 'the node\'s book is not the production one and no explicit policy: not eligible');
  assert.ok(w.logs.some((l) => /the platform host policy is off for this config/.test(l)));
  w = enrollRig(t, { hostServices: HS, hostServicesPolicy: hsp });
  assert.equal((await w.enroll.pass()).changed, true);
  assert.deepEqual(w.read().apps, []); assert.deepEqual(w.read().enclaveNetwork.hostServicesPolicy, hsp, 'carried byte for byte');
  assert.equal(await appLessRefusal(w.read()), null);
  for (const [bad, re] of [[{ ...hsp, carriers: {} }, /names no carrier/], [{ policy: 'off' }, /platform host policy is off/], [{ ...hsp, rpcs: undefined, policy: { book: BOOK, hostOwnership: OWNERSHIP } }, /RPC quorum is unknown/]]) {
    w = enrollRig(t, { hostServices: HS, hostServicesPolicy: bad });
    const r = await w.enroll.pass();
    assert.equal(r.changed, false); assert.equal(w.exists(), false);
    assert.ok(w.logs.some((l) => re.test(l)), `${JSON.stringify(bad)}: ${w.logs.join(' | ')}`);
  }
  const r2 = await readHostServicesFile(enrollRig(t, { hostServices: HS, hostServicesPolicy: [] }).file);
  assert.match(r2.error, /hostServicesPolicy must be an object/);
});
