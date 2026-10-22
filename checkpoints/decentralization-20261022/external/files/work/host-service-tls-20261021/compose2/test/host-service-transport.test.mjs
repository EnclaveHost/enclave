// The host side of host-service transport (work/host-service-transport-20261021): network/host-service-transport.mjs (one
// guarded 'service' circuit per pinned exit, revoke before close), the operator's opt-in kept by windows/node/network-enroll.mjs,
// and the production transport profile (scripts/check-transport-profile.mjs) refusing a provider that skips the host policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { HostServiceTransport, validateHostServicesTransport } from '../network/host-service-transport.mjs';
import { hostServiceNames } from '../network/host-service-names.mjs';
import { checkTransportProfile } from '../scripts/check-transport-profile.mjs';
import { createNetworkEnroll, validHostServices } from '../windows/node/network-enroll.mjs';
import { rawDigest } from '../network/shield-expectation.mjs';

const HOST = '0x' + 'a1'.repeat(32), ZONE = 'svc.example';
const CFG = { zone: ZONE, exits: ['e1'.repeat(16), 'e2'.repeat(16)], ports: { 'directory-replica': 18188, 'bootstrap-replica': 18189, 'policy-mirror': 18190 }, dns: { tcp: 18153, udp: 18153 } };
const prov = (id, address, roles = ['guard', 'ingress', 'egress'], over = {}) => ({ providerId: id, address, wgExitKey: id + 'x', wgGuardKey: id + 'g', eligibleRoles: roles, pricePerGiB6: 0,
  qualifiedUntil: Date.now() + 3600e3, region: id.slice(0, 2), ports: { exit: 51820, guard: 51821, control: 51822 }, ...over });
function fakeRuntime() {
  const started = [];
  return { started, async start(o) {
    const c = new EventEmitter(); Object.assign(c, { closed: false, providers: { guard: o.guard, exit: o.exit }, service: { names: o.service.granted, exitKey: 'K' + started.length, control: '127.0.0.1:' + (40000 + started.length) },
      close: async (why) => { c.closed = true; c.why = why; } });
    started.push({ opts: o, circuit: c }); return c;
  } };
}

test('one service circuit per pinned exit, through a different guard, asking for exactly this host\'s names and routes', async () => {
  const rt = fakeRuntime(), revoked = [];
  // the exits offer no guard role here, so each circuit's guard is g1 and losing one exit touches only its own circuit
  let list = [prov('e1'.repeat(16), '1.0.0.1', ['ingress', 'egress']), prov('e2'.repeat(16), '1.0.0.2', ['ingress', 'egress']), prov('g1'.repeat(16), '1.0.0.3', ['guard']), prov('zz'.repeat(16), '1.0.0.4')];
  const t = new HostServiceTransport({ runtime: rt, providers: async () => list, grants: { revoke: async (o) => { revoked.push(o); return { revoked: true }; } }, hostId: HOST, config: CFG });
  await t.reconcile();
  assert.equal(rt.started.length, 2);
  const names = hostServiceNames(HOST, ZONE);
  for (const { opts } of rt.started) {
    assert.equal(opts.exitRole, 'service'); assert.equal(opts.ingress, true); assert.equal(opts.egress, false); assert.equal(opts.deploymentId, '0x' + '0'.repeat(64));
    assert.notEqual(opts.guard.address, opts.exit.address); assert.ok(CFG.exits.includes(opts.exit.providerId));
    assert.deepEqual(opts.service.granted, Object.values(names));
    assert.deepEqual(opts.service.names, { [names['directory-replica']]: { http: 18188, tls: null }, [names['bootstrap-replica']]: { http: 18189, tls: null }, [names['policy-mirror']]: { http: 18190, tls: null } });
    assert.deepEqual(opts.service.dns, { tcp: 18153, udp: 18153 });
  }
  assert.ok(!rt.started.some(({ opts }) => opts.exit.providerId === 'zz'.repeat(16)), 'an exit the operator did not name is never used');
  await t.reconcile(); assert.equal(rt.started.length, 2, 'steady state: nothing rebuilt');
  // an exit that loses qualification: its grant is revoked at it (through the guard), then the circuit closes
  list = list.filter((p) => p.providerId !== 'e2'.repeat(16));
  await t.reconcile();
  assert.equal(revoked.length, 1); assert.equal(revoked[0].provider.providerId, 'e2'.repeat(16)); assert.match(revoked[0].url, /^http:\/\/127\.0\.0\.1:4000\d$/);
  assert.ok(rt.started[1].circuit.closed || rt.started[0].circuit.closed);
  await t.close(); assert.equal(revoked.length, 2, 'close revokes every remaining grant'); assert.ok(rt.started.every(({ circuit }) => circuit.closed));
});

test('a failed revoke still closes (the grant expires on its own); a down circuit is rebuilt next round', async () => {
  const rt = fakeRuntime(), lines = [];
  const list = [prov('e1'.repeat(16), '1.0.0.1'), prov('g1'.repeat(16), '1.0.0.3', ['guard'])];
  const t = new HostServiceTransport({ runtime: rt, providers: async () => list, grants: { revoke: async () => { throw new Error('no answer'); } }, hostId: HOST, config: { ...CFG, exits: ['e1'.repeat(16)] }, log: (m) => lines.push(m) });
  await t.reconcile(); rt.started[0].circuit.emit('down', 'tunnel process exited');
  await t.reconcile(); assert.equal(rt.started.length, 2, 'rebuilt after down');
  await t.close(); assert.ok(rt.started[1].circuit.closed); assert.ok(lines.some((l) => /expires on its own/.test(l)));
});

test('endpoints are the derived names, http until a role has a TLS port (G3)', () => {
  const t = new HostServiceTransport({ runtime: fakeRuntime(), providers: async () => [], grants: {}, hostId: HOST, config: { ...CFG, tls: { httpPort: 18280, tlsPorts: { 'directory-replica': 18288 } } } });
  const n = hostServiceNames(HOST, ZONE);
  assert.deepEqual(t.endpoints(), { 'directory-replica': `https://${n['directory-replica']}/`, 'bootstrap-replica': `http://${n['bootstrap-replica']}/`, 'policy-mirror': `http://${n['policy-mirror']}/` });
  // G3's front (service-tls, 605's interface): port 80 of EVERY derived name to its httpPort, 443 only to the role's TLS port
  assert.deepEqual(t.names, { [n['directory-replica']]: { http: 18280, tls: 18288 }, [n['bootstrap-replica']]: { http: 18280, tls: null }, [n['policy-mirror']]: { http: 18280, tls: null } });
  const plain = new HostServiceTransport({ runtime: fakeRuntime(), providers: async () => [], grants: {}, hostId: HOST, config: CFG });
  assert.equal(plain.names[n['bootstrap-replica']].http, 18189, 'without G3, port 80 goes straight to the role');
});

test('the host config is validated before anything starts', () => {
  for (const [c, re] of [[{ ...CFG, exits: [] }, /exits/], [{ ...CFG, ports: { 'credit-vault-submitter': 1 } }, /ports/], [{ ...CFG, ports: {} }, /ports/],
    [{ ...CFG, tls: { 'directory-replica': 18443 } }, /tls/], [{ ...CFG, tls: { httpPort: 18280, tlsPorts: { 'route-dns': 1 } } }, /tls/],
    [{ ...CFG, tls: { httpPort: 18188, tlsPorts: { 'directory-replica': 18288 } } }, /must differ/], [{ ...CFG, tls: { httpPort: 18280, tlsPorts: {} } }, /tls/],
    [{ ...CFG, dns: { tcp: 18153 } }, /dns/], [{ ...CFG, names: ['x'] }, /unknown field/], [{ ...CFG, zone: 'Bad..zone' }, /zone/]])
    assert.throws(() => validateHostServicesTransport(c), re, JSON.stringify(c));
});

const MINIMAL = { bootstrap: 'explicit', operatorKeyFile: '/etc/enclave-network/operator.key', publicAddress: '203.0.113.7', uplink: 'eth0', roles: ['guard', 'ingress', 'egress'],
  rpc: ['https://rpc-a.example', 'https://rpc-b.example'], directories: ['https://dir-a.example/'], checkers: ['0x' + '33'.repeat(20)], zone: 'app.example', probeZone: 'probe.example', pricePerGiB6: 0 };
test('transport profile: host services with the platform host policy are transport; "off" or a malformed block refuses', () => {
  const ok = checkTransportProfile({ ...MINIMAL, hostServices: { zone: ZONE, platformHostPolicy: 'production', dns: { hosts: [HOST] } } });
  assert.equal(ok.ok, true, ok.violations.join('; '));
  assert.ok(ok.transport.some((t) => /host-service names/.test(t)) && ok.transport.some((t) => /DNS 53 .* as packets/.test(t)));
  for (const [hs, re] of [[{ zone: ZONE, platformHostPolicy: 'off' }, /"off": the admin's host bans/], [{ zone: 'x.app.example', platformHostPolicy: 'production' }, /overlaps the app zone/],
    [{ zone: ZONE }, /platformHostPolicy is required/]]) {
    const r = checkTransportProfile({ ...MINIMAL, hostServices: hs });
    assert.equal(r.ok, false); assert.ok(r.violations.some((v) => re.test(v)), r.violations.join('; '));
  }
  assert.equal(checkTransportProfile({ ...MINIMAL, roles: ['guard', 'egress'], hostServices: { zone: ZONE, platformHostPolicy: 'production' } }).ok, false, 'needs the ingress role');
  assert.deepEqual(checkTransportProfile(MINIMAL).transport.length, 5, 'without hostServices the profile is as before');
});

test('enrollment keeps the operator\'s hostServices opt-in (and only then names the service worker); malformed is dropped', async () => {
  assert.equal(validHostServices(undefined), null); assert.equal(validHostServices({ ...CFG, exits: [] }), null); assert.deepEqual(validHostServices(CFG), CFG);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-enroll-')), agentDir = path.join(dir, 'agent'), policyFile = path.join(dir, 'policy.json');
  try {
    fs.mkdirSync(agentDir); fs.writeFileSync(policyFile, JSON.stringify({ cpu: { runtimeId: 'ab'.repeat(32) }, gpu: {} }));
    const D = '0x' + '11'.repeat(32), APP = '0x' + '5a'.repeat(32), CID = 'bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza', RUNNER = '0x' + '22'.repeat(32);
    const vm = { name: D, status: 'running', appReady: true, catalog: { app: APP, version: 4 }, cid: CID, appId: 'ef'.repeat(32), runtimeId: 'ab'.repeat(32), componentSha256: rawDigest(CID), derivation: 'enclave-catalog-bundle/1', gpuMilli: 0, startedAt: 1 };
    let restarts = 0;
    const config = { agentDir, binDir: path.join(dir, 'bin'), nodeBinary: 'node.exe', operatorKeyFile: 'op.key', runner: RUNNER, endpoint: 'https://api.enclave.host/t/box', relayBase: 'https://api.enclave.host',
      policyFile, tpmBinary: 'tpmattest.exe', tpmSha256: 'aa'.repeat(32), addressBook: '0x' + '44'.repeat(20), chainRpc: ['https://rpc'], enclaveNetwork: { checkers: ['0x' + '57'.repeat(20)] } };
    const enroll = createNetworkEnroll({ agentDir, binDir: path.join(dir, 'bin'), runner: RUNNER, relayBase: 'https://api.enclave.host', restartAgent: async () => { restarts++; }, config,
      fetch: async () => ({ ok: true, json: async () => ({ domains: {} }) }), rows: async () => [{ id: D, appRef: `catalog://${APP}/4`, configCid: '{}', runner: RUNNER, active: true, isPublic: true, leaseUntil: 9999999999n }],
      version: async () => ({ cid: CID }), vms: async () => [vm] });
    const file = path.join(agentDir, 'privacy-config.json'), read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    await enroll.pass();
    assert.equal(read().enclaveNetwork.hostServices, undefined); assert.equal(read().enclaveNetwork.serviceWorkerModule, undefined, 'no other box\'s section changes');
    assert.equal((await enroll.pass()).changed, false);
    const c = read(); c.enclaveNetwork.hostServices = CFG; fs.writeFileSync(file, JSON.stringify(c));
    await enroll.pass();
    assert.deepEqual(read().enclaveNetwork.hostServices, CFG, 'kept across the pass');
    assert.equal(path.basename(read().enclaveNetwork.serviceWorkerModule), 'host-service-ingress.mjs');
    assert.equal(restarts, 1, 'the agent restarts once to start them');
    assert.equal((await enroll.pass()).changed, false, 'steady state'); assert.equal(restarts, 1);
    const m = read(); m.enclaveNetwork.hostServices = { ...CFG, exits: [] }; fs.writeFileSync(file, JSON.stringify(m));
    await enroll.pass(); assert.equal(read().enclaveNetwork.hostServices, undefined, 'a malformed block is dropped, like hostEgress');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
