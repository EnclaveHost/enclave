// The host side of host-service transport (work/host-service-transport-20261021): network/host-service-transport.mjs (one
// guarded 'service' circuit per pinned exit, revoke before close), the operator's opt-in kept by windows/node/network-enroll.mjs,
// and the production transport profile (scripts/check-transport-profile.mjs) refusing a provider that skips the host policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { HostServiceTransport, validateHostServicesTransport, tlsReady } from '../network/host-service-transport.mjs';
import { hostServiceNames, hostChallengeName } from '../network/host-service-names.mjs';
import { checkTransportProfile } from '../scripts/check-transport-profile.mjs';
import { createNetworkEnroll, hostServicesBlock } from '../windows/node/network-enroll.mjs';
import { hostServicesPreflight } from '../network/privacy-agent.mjs';
import { keccak256, toBytes } from 'viem';
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

// a throwaway CA and leaf certificates (openssl), for the G3 readiness counterexamples
function pki(dir, names) {
  const run = (args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=test-ca', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2']);
  const leaf = (tag, name, days) => {
    // an X.509 CN holds at most 64 characters and the derived names are longer (69-76): the name lives in the SAN only
    run(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', `/CN=${tag}`, '-keyout', `${tag}.key`, '-out', `${tag}.csr`]);
    fs.writeFileSync(path.join(dir, `${tag}.ext`), `subjectAltName=DNS:${name}\n`);
    run(['x509', '-req', '-in', `${tag}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${tag}.pem`, '-days', String(days), '-extfile', `${tag}.ext`]);
    return { key: fs.readFileSync(path.join(dir, `${tag}.key`)), cert: fs.readFileSync(path.join(dir, `${tag}.pem`)) };
  };
  return { ca: fs.readFileSync(path.join(dir, 'ca.pem')), good: leaf('good', names.good, 2), wrong: leaf('wrong', 'someone-else.example', 2) };
}
const serve = async (opts) => { const s = tls.createServer(opts, (c) => c.end()); await new Promise((r) => s.listen(0, '127.0.0.1', r)); return s; };

test('B1: https is advertised only from VERIFIED G3 readiness; a configured port, a wrong name, an untrusted CA or a closed port is http', async () => {
  const n = hostServiceNames(HOST, ZONE), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-tls-'));
  const servers = [];
  try {
    const k = pki(dir, { good: n['directory-replica'] });
    const good = await serve(k.good), wrong = await serve(k.wrong); servers.push(good, wrong);
    const closed = await serve(k.good); const closedPort = closed.address().port; await new Promise((r) => closed.close(r));
    const mk = (tlsPorts) => new HostServiceTransport({ runtime: fakeRuntime(), providers: async () => [], grants: {}, hostId: HOST, config: { ...CFG, tls: { httpPort: 18280, tlsPorts } } });
    const ep = (await mk({ 'directory-replica': good.address().port, 'bootstrap-replica': wrong.address().port, 'policy-mirror': closedPort }).endpoints({ roots: k.ca }));
    assert.deepEqual(ep, { 'directory-replica': `https://${n['directory-replica']}/`, 'bootstrap-replica': `http://${n['bootstrap-replica']}/`, 'policy-mirror': `http://${n['policy-mirror']}/` });
    // the same valid listener, but its CA is not trusted (production roots): not ready
    assert.equal((await mk({ 'directory-replica': good.address().port }).endpoints())['directory-replica'], `http://${n['directory-replica']}/`);
    assert.equal(await tlsReady({ port: good.address().port, servername: n['directory-replica'], roots: k.ca }), true);
    assert.equal(await tlsReady({ port: good.address().port, servername: n['bootstrap-replica'], roots: k.ca }), false, 'hostname checked');
    // no TLS port configured: http, nothing probed
    const plain = new HostServiceTransport({ runtime: fakeRuntime(), providers: async () => [], grants: {}, hostId: HOST, config: CFG });
    assert.deepEqual(Object.values(await plain.endpoints()).map((u) => u.split(':')[0]), ['http', 'http', 'http']);
  } finally { for (const s of servers) s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('G3 front mapping (605\'s interface): port 80 of every name to httpPort, 443 only to listed tlsPorts', () => {
  const t = new HostServiceTransport({ runtime: fakeRuntime(), providers: async () => [], grants: {}, hostId: HOST, config: { ...CFG, tls: { httpPort: 18280, tlsPorts: { 'directory-replica': 18288 } } } });
  const n = hostServiceNames(HOST, ZONE);
  assert.deepEqual(t.names, { [n['directory-replica']]: { http: 18280, tls: 18288 }, [n['bootstrap-replica']]: { http: 18280, tls: null }, [n['policy-mirror']]: { http: 18280, tls: null } });
  const plain = new HostServiceTransport({ runtime: fakeRuntime(), providers: async () => [], grants: {}, hostId: HOST, config: CFG });
  assert.equal(plain.names[n['bootstrap-replica']].http, 18189, 'without G3, port 80 goes straight to the role');
});

test('validation is idempotent: the agent\'s normalized block constructs the transport (absent tls/dns stay absent)', () => {
  for (const c of [CFG, { ...CFG, dns: undefined }, { ...CFG, tls: { httpPort: 18280, tlsPorts: { 'directory-replica': 18288 } } }]) {
    const raw = structuredClone(c); for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k];
    const once = validateHostServicesTransport(raw);
    assert.deepEqual(validateHostServicesTransport(once), once);
    assert.doesNotThrow(() => new HostServiceTransport({ runtime: fakeRuntime(), providers: async () => [], grants: {}, hostId: HOST, config: once }));
  }
  assert.ok(!('tls' in validateHostServicesTransport(CFG)) && 'dns' in validateHostServicesTransport(CFG));
});

test('the host config is validated before anything starts', () => {
  for (const [c, re] of [[{ ...CFG, exits: [] }, /exits/], [{ ...CFG, ports: { 'credit-vault-submitter': 1 } }, /ports/], [{ ...CFG, ports: {} }, /ports/],
    [{ ...CFG, tls: { 'directory-replica': 18443 } }, /tls/], [{ ...CFG, tls: { httpPort: 18280, tlsPorts: { 'route-dns': 1 } } }, /tls/],
    [{ ...CFG, tls: { httpPort: 18188, tlsPorts: { 'directory-replica': 18288 } } }, /must differ/], [{ ...CFG, tls: { httpPort: 18280, tlsPorts: {} } }, /tls/],
    [{ ...CFG, dns: { tcp: 18153 } }, /dns/], [{ ...CFG, dns: { tcp: 18153, udp: 18154 } }, /both the same/], [{ ...CFG, names: ['x'] }, /unknown field/], [{ ...CFG, zone: 'Bad..zone' }, /zone/]])
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

const enrollWorld = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-enroll-')), agentDir = path.join(dir, 'agent'), policyFile = path.join(dir, 'policy.json');
  fs.mkdirSync(agentDir); fs.writeFileSync(policyFile, JSON.stringify({ cpu: { runtimeId: 'ab'.repeat(32) }, gpu: {} }));
  const D = '0x' + '11'.repeat(32), APP = '0x' + '5a'.repeat(32), CID = 'bafkreibjbefi32gvjrd54lhdizq6zlywym6urcuztzvi455xfv23tyjnza', RUNNER = '0x' + '22'.repeat(32);
  const vm = { name: D, status: 'running', appReady: true, catalog: { app: APP, version: 4 }, cid: CID, appId: 'ef'.repeat(32), runtimeId: 'ab'.repeat(32), componentSha256: rawDigest(CID), derivation: 'enclave-catalog-bundle/1', gpuMilli: 0, startedAt: 1 };
  const w = { dir, restarts: 0, logs: [] };
  const config = { agentDir, binDir: path.join(dir, 'bin'), nodeBinary: 'node.exe', operatorKeyFile: 'op.key', runner: RUNNER, endpoint: 'https://api.enclave.host/t/box', relayBase: 'https://api.enclave.host',
    policyFile, tpmBinary: 'tpmattest.exe', tpmSha256: 'aa'.repeat(32), addressBook: '0x' + '44'.repeat(20), chainRpc: ['https://rpc'], enclaveNetwork: { checkers: ['0x' + '57'.repeat(20)] } };
  w.enroll = createNetworkEnroll({ agentDir, binDir: path.join(dir, 'bin'), runner: RUNNER, relayBase: 'https://api.enclave.host', restartAgent: async () => { w.restarts++; }, config, log: (m) => w.logs.push(m),
    fetch: async () => ({ ok: true, json: async () => ({ domains: {} }) }), rows: async () => [{ id: D, appRef: `catalog://${APP}/4`, configCid: '{}', runner: RUNNER, active: true, isPublic: true, leaseUntil: 9999999999n }],
    version: async () => ({ cid: CID }), vms: async () => [vm] });
  w.file = path.join(agentDir, 'privacy-config.json'); w.read = () => JSON.parse(fs.readFileSync(w.file, 'utf8')); w.raw = () => fs.readFileSync(w.file, 'utf8');
  w.set = (h) => { const c = w.read(); c.enclaveNetwork.hostServices = h; fs.writeFileSync(w.file, JSON.stringify(c, null, 2)); };
  return w;
};

test('enrollment keeps the operator\'s hostServices opt-in and only then names the service worker; N passes restart nothing', async () => {
  const w = enrollWorld();
  try {
    await w.enroll.pass();
    assert.equal(w.read().enclaveNetwork.hostServices, undefined); assert.equal(w.read().enclaveNetwork.serviceWorkerModule, undefined, 'no other box\'s section changes');
    assert.equal((await w.enroll.pass()).changed, false);
    const G3 = { ...CFG, tls: { httpPort: 18280, tlsPorts: { 'directory-replica': 18288, 'bootstrap-replica': 18289, 'policy-mirror': 18290 } } };
    w.set(G3); await w.enroll.pass();
    assert.deepEqual(w.read().enclaveNetwork.hostServices, G3, 'the G3-shaped block (605\'s interface) is kept');
    assert.equal(path.basename(w.read().enclaveNetwork.serviceWorkerModule), 'host-service-ingress.mjs');
    assert.equal(w.restarts, 1, 'the agent restarts once to start them');
    const steady = w.raw();
    for (let i = 0; i < 4; i++) assert.equal((await w.enroll.pass()).changed, false, `pass ${i}: steady state`);
    assert.equal(w.raw(), steady, 'byte-for-byte across passes'); assert.equal(w.restarts, 1);
  } finally { fs.rmSync(w.dir, { recursive: true, force: true }); }
});

test('B2 counterexample: an INVALID or newer-release hostServices block is never deleted - kept byte-for-byte and reported every pass', async () => {
  assert.deepEqual(hostServicesBlock(undefined), { block: null, error: null });
  assert.match(hostServicesBlock({ ...CFG, exits: [] }).error, /exits/); assert.deepEqual(hostServicesBlock({ ...CFG, exits: [] }).block, { ...CFG, exits: [] });
  const w = enrollWorld();
  try {
    await w.enroll.pass();
    for (const bad of [{ ...CFG, exits: [] }, { ...CFG, futureField: { x: 1 } }, { ...CFG, tls: { httpPort: 18188, tlsPorts: { 'directory-replica': 18288 } } }]) {
      w.set(bad); await w.enroll.pass(); const before = w.raw(), restarts = w.restarts;
      const r1 = await w.enroll.pass(), r2 = await w.enroll.pass();
      assert.deepEqual(w.read().enclaveNetwork.hostServices, bad, 'kept exactly as written');
      assert.equal(w.raw(), before, 'not rewritten'); assert.equal(w.restarts, restarts, 'no restart loop');
      assert.ok(r1.hostServicesError && r2.hostServicesError, 'every pass reports it');
      assert.ok(w.logs.filter((l) => /HOST SERVICES CONFIG INVALID/.test(l)).length >= 2);
    }
  } finally { fs.rmSync(w.dir, { recursive: true, force: true }); }
});

test('the privacy agent preflight refuses host services only (apps unaffected): invalid block, missing worker, runner != keccak(endpoint)', () => {
  const ep = 'https://api.enclave.host/t/box', runner = keccak256(toBytes(ep)), wm = '/opt/enclave/network/host-service-ingress.mjs', exists = (f) => f === wm;
  assert.deepEqual(hostServicesPreflight({ block: undefined, workerModule: wm, runner, endpoint: ep, exists }), {});
  assert.deepEqual(Object.keys(hostServicesPreflight({ block: CFG, workerModule: wm, runner, endpoint: ep, exists })), ['config']);
  assert.match(hostServicesPreflight({ block: { ...CFG, exits: [] }, workerModule: wm, runner, endpoint: ep, exists }).refused, /invalid hostServices/);
  assert.match(hostServicesPreflight({ block: CFG, workerModule: '/opt/elsewhere/host-service-ingress.mjs', runner, endpoint: ep, exists }).refused, /worker is missing/, 'B3: a release without the worker');
  assert.match(hostServicesPreflight({ block: CFG, workerModule: 'relative.mjs', runner, endpoint: ep, exists }).refused, /worker is missing/);
  // B7: the id is keccak256 of the EXACT endpoint bytes (EnclaveRegistry idOf, unstripped). A registered trailing-slash
  // endpoint is valid with its own id; the same endpoint with another runner (e.g. the stripped id) is refused
  assert.deepEqual(Object.keys(hostServicesPreflight({ block: CFG, workerModule: wm, runner: keccak256(toBytes(ep + '/')), endpoint: ep + '/', exists })), ['config'], 'a valid slash registration is accepted');
  assert.match(hostServicesPreflight({ block: CFG, workerModule: wm, runner, endpoint: ep + '/', exists }).refused, /not keccak256 of this host's endpoint/);
  assert.match(hostServicesPreflight({ block: CFG, workerModule: wm, runner: '0x' + '0'.repeat(64), endpoint: ep, exists }).refused, /registry id/);
});

test('B3: the Windows bundle stages every network binary enrollment names, and build.mjs produces each', () => {
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const stage = fs.readFileSync(path.join(ROOT, 'windows/installer/stage-bundle.sh'), 'utf8');
  const staged = /for f in ([^;]+); do\s*\n\s*cp "\$W\/dist\/\$f"/.exec(stage)[1].trim().split(/\s+/);
  const enroll = fs.readFileSync(path.join(ROOT, 'windows/node/network-enroll.mjs'), 'utf8');
  const named = [...enroll.matchAll(/bin\("([^"]+)"\)/g)].map((m) => m[1]).concat([...enroll.matchAll(/path\.join\(binDir, "([^"]+)"\)/g)].map((m) => m[1]));
  assert.ok(named.includes('host-service-ingress.mjs') && named.includes('windows-circuit-worker.mjs'), named.join(','));
  for (const f of named) assert.ok(staged.includes(f), `${f} is named by enrollment but not staged by stage-bundle.sh`);
  const build = fs.readFileSync(path.join(ROOT, 'network/build.mjs'), 'utf8');
  for (const f of staged.filter((x) => x.endsWith('.mjs'))) assert.ok(build.includes(`'${f}')`), `${f} is staged but network/build.mjs does not bundle it`);
});


// enclave-circuit-firewall's install validation (network/windows-firewall/main_windows.go), ported rule for rule: a policy
// that breaks one makes the Windows tool panic, and the circuit never starts.
function firewallRefusal(cfg) {
  const v4 = (a) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/.exec(a);
  const isPublic = (m) => { const [a, b, c] = m.slice(1, 4).map(Number); return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) || (a === 198 && b >= 18 && b < 20) || a >= 224); };
  if (cfg.programs.length < 1 || cfg.programs.length > 4) return 'private circuit directory required';
  if (cfg.tunnel && (!cfg.appContainer || cfg.programs.length !== 1 || !(cfg.programs[0].udp?.length >= 1 && cfg.programs[0].udp.length <= 2))) return 'tunnel mode is one sandboxed program with 1-2 exact UDP peers';
  for (const p of cfg.programs) {
    if (p.udp?.length && !cfg.tunnel) return 'UDP peers are for tunnel mode only';
    for (const u of p.udp || []) { const m = v4(u); if (!m || Number(m[5]) === 0 || !isPublic(m)) return 'tunnel peers must be explicit public IPv4 ip:port'; }
    if ((p.connect || []).length > 16 || (p.listen || []).length > 16) return 'invalid program policy';
    for (const c of p.connect || []) { const m = v4(c); if (!m || m[1] !== '127' || Number(m[5]) === 0) return 'only explicit IPv4 loopback circuit ports may be connected'; }
    for (const l of p.listen || []) if (!l) return 'explicit listener ports required';
  }
  return null;
}

test('Windows sandbox: a host-service circuit WITH DNS yields policies enclave-circuit-firewall accepts (no loopback UDP)', async () => {
  const { circuitFirewallPolicies } = await import('../network/wg-circuit-runtime.mjs');
  const ports = { ingress: 40001, redirect: 40002, socks: 40003, control: 40004, guardSocks: 40005 };
  const files = { wg: 'C:\\x\\enclave-circuit-a\\enclave-wg.exe', node: 'C:\\x\\enclave-circuit-b\\worker.exe' };
  const svc = new HostServiceTransport({ runtime: fakeRuntime(), providers: async () => [], grants: {}, hostId: HOST, config: CFG });
  const service = { names: svc.names, granted: svc.granted, dns: { tcp: 18153, udp: 18153 } };
  const rolePorts = [...new Set(Object.values(service.names).map((t) => t.http))].map((p) => '127.0.0.1:' + p);
  const pols = circuitFirewallPolicies({ wgDir: 'C:\\x\\enclave-circuit-a', dir: 'C:\\x\\enclave-circuit-b', files, udpPeer: '134.209.248.172:51821', ports, ingress: true, service, rolePorts });
  for (const p of pols) assert.equal(firewallRefusal(p), null, JSON.stringify(p));
  const wg = pols[0].programs[0];
  assert.deepEqual(wg.udp, ['134.209.248.172:51821'], 'UDP only to the public WireGuard peer');
  assert.ok(wg.connect.includes('127.0.0.1:18153'), 'route-dns reached over loopback TCP');
  assert.deepEqual(pols[1].programs[0].connect, ['127.0.0.1:18188', '127.0.0.1:18189', '127.0.0.1:18190'], 'the worker reaches exactly the role ports');
  // the rev2 shape (loopback UDP for DNS) is what the tool refuses: the reason the relay now frames UDP onto TCP
  assert.match(firewallRefusal({ ...pols[0], programs: [{ ...wg, udp: [...wg.udp, '127.0.0.1:18153'] }] }), /public IPv4/);
  // an app circuit is unchanged: broker port for the worker, no DNS
  const app = circuitFirewallPolicies({ wgDir: 'C:\\x\\enclave-circuit-a', dir: 'C:\\x\\enclave-circuit-b', files, udpPeer: '134.209.248.172:51821', ports, ingress: true, brokerPort: 40099 });
  assert.deepEqual(app[1].programs[0].connect, ['127.0.0.1:40099']); assert.deepEqual(app[0].programs[0].connect, ['127.0.0.1:40001', '127.0.0.1:40002']);
  for (const p of app) assert.equal(firewallRefusal(p), null);
});

// Final review N3 (the reviewer's tests/start-decoupling.test.mjs, plus the control transport): a first round that cannot
// read any directory must not reject start() - the privacy agent's apps start regardless and the timers retry.
test('N3: start() of host services AND of control circuits does not reject when every directory is unreachable', async () => {
  const { WgControlTransport } = await import('../network/wg-control.mjs');
  const down = async () => { throw new Error('all public directories unavailable: fetch failed'); };
  const lines = [];
  const t = new HostServiceTransport({ runtime: fakeRuntime(), grants: {}, hostId: HOST, config: CFG, log: (m) => lines.push(m), providers: down });
  const c = new WgControlTransport({ runtime: fakeRuntime(), providers: down, probeUrls: ['http://127.0.0.1:1/v1/network/providers'], log: (m) => lines.push(m) });
  try {
    await assert.doesNotReject(t.start()); await assert.doesNotReject(c.start());
    assert.ok(lines.some((l) => /host service circuits: all public directories unavailable/.test(l)) && lines.some((l) => /control circuits: all public directories unavailable/.test(l)));
  } finally { await t.close(); await c.close(); }
});


test('G4 composition: enrollment preserves the reviewed challenge replica and serves its challenge TLS port', async () => {
  const w = enrollWorld();
  try {
    await w.enroll.pass();
    const challenge = JSON.parse(fs.readFileSync(new URL('./fixtures/challenge-replica-reviewed.json', import.meta.url), 'utf8'));
    const services = { ...CFG, tls: { httpPort: 18280, tlsPorts: { 'directory-replica': 18288 }, challengePort: 18292 } };
    const cfg = w.read(); cfg.enclaveNetwork.hostServices = services; cfg.enclaveNetwork.challengeReplica = challenge;
    fs.writeFileSync(w.file, JSON.stringify(cfg, null, 2));
    const result = await w.enroll.pass();
    assert.ok(!result.hostServicesError, result.hostServicesError);
    assert.deepEqual(w.read().enclaveNetwork.hostServices, services);
    assert.deepEqual(w.read().enclaveNetwork.challengeReplica, challenge);
    assert.equal(path.basename(w.read().enclaveNetwork.serviceWorkerModule), 'host-service-ingress.mjs');
    const stable = w.raw(), restarts = w.restarts;
    for (let i = 0; i < 3; i++) assert.equal((await w.enroll.pass()).changed, false);
    assert.equal(w.raw(), stable); assert.equal(w.restarts, restarts);
    const transport = new HostServiceTransport({ runtime: fakeRuntime(), providers: async () => [], grants: {}, hostId: HOST, config: w.read().enclaveNetwork.hostServices });
    const name = hostChallengeName(HOST, ZONE);
    assert.ok(transport.granted.includes(name));
    assert.deepEqual(transport.names[name], { http: 18280, tls: 18292 });
    assert.throws(() => validateHostServicesTransport({ ...services, tls: { ...services.tls, challengePort: 18288 } }), /must differ/);
  } finally { fs.rmSync(w.dir, { recursive: true, force: true }); }
});
