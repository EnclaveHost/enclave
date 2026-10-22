// A WireGuard provider carrying registered hosts' OWN public service roles (work/host-service-transport-20261021):
// network/wg-provider/provider.mjs service() / revoke() / route() / dnsTarget(), the same fake kernel as wg-provider.test.mjs.
// Every admission boundary here has a refusal test: signer, registry state, platform host policy, names, revocation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { recoverMessageAddress } from 'viem';
import { randomBytes, createHash } from 'node:crypto';
import { WgProvider, peerRequestMessage, grantMessage, revokeMessage, validatePeerRequest } from '../network/wg-provider/provider.mjs';
import { hostServiceNames, isHostServiceName, hostLabel, base32 } from '../network/host-service-names.mjs';
import { providerHostServices } from '../network/wg-provider/host-services-config.mjs';

const ZERO = '0x' + '0'.repeat(64), app = '0x' + 'ab'.repeat(32), appRunner = '0x' + '11'.repeat(32);
const hostA = '0x' + 'a1'.repeat(32), hostB = '0x' + 'b2'.repeat(32), hostC = '0x' + 'c3'.repeat(32);
const opA = privateKeyToAccount(generatePrivateKey()), opB = privateKeyToAccount(generatePrivateKey()), opC = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey()), appOperator = privateKeyToAccount(generatePrivateKey()), providerKey = privateKeyToAccount(generatePrivateKey());
const wgKey = () => randomBytes(32).toString('base64');
const ZONE = 'svc.example';

function rig({ hostServices = { zone: ZONE, platformHostPolicy: 'on' }, roles = ['guard', 'ingress', 'egress'], admission = 'admit', domains = ['www.example.org'], probe = true } = {}) {
  const dnsDown = new Set();   // tunnel addresses whose DNS role does not answer the provider's probe
  let now = 1_000_000_000;
  const kernel = { peers: new Map(), synced: null, stats: null, setPeer: async (p) => kernel.peers.set(p.key, { ...p }), removePeer: async (p) => kernel.peers.delete(p.key), sync: async (s) => { kernel.synced = s; },
    listPeers: async (iface) => [...kernel.peers.values()].filter((p) => (p.role === 'guard' ? 'wg-guard' : 'wg-exit') === iface).map((p) => p.key) };
  const hosts = new Map([[hostA, { active: true, operator: opA.address.toLowerCase() }], [hostB, { active: true, operator: opB.address.toLowerCase() }],
    [hostC, { active: true, operator: opC.address.toLowerCase() }], [appRunner, { active: true, operator: appOperator.address.toLowerCase() }]]);
  const policy = { decisions: new Map(), calls: 0, throws: false };
  const hostAdmission = admission === null ? null : async (ids) => {
    policy.calls++; if (policy.throws) throw new Error('no fresh agreeing chain quorum');
    return Object.fromEntries(ids.map((id) => [id, policy.decisions.get(id) || { admit: true, status: 'current', reason: null }]));
  };
  const lease = { active: true, runner: appRunner, runnerOperator: appOperator.address, owner: stranger.address, isPublic: true, validUntil: now + 60000, leaseUntil: now + 3600000 };
  const seen = new Map();
  const p = new WgProvider({ config: { providerId: 'aa'.repeat(16), roles, pricePerGiB6: 0, publicAddress: '134.199.235.187', exitKey: wgKey(), guardKey: wgKey(), ports: { exit: 51820, guard: 51821, control: 51822 },
    zone: 'app.example', checkers: [], ...(hostServices ? { hostServices } : {}) },
  signer: providerKey, kernel, hostAdmission, dnsProbe: probe ? async (address) => !dnsDown.has(address) : null, leases: async (x) => (x === app ? lease : null), hosts: async (x) => hosts.get(x) || null,
  policyMemory: { get: async (k) => seen.get(k), set: async (k, v) => seen.set(k, v) }, currentPolicy: async () => null,
  domains: async (x) => (x === app ? domains : []), now: () => now });
  return { p, kernel, hosts, policy, dnsDown, advance: (ms) => { now += ms; }, now: () => now };
}
async function ask(r, { runner = hostA, signer = opA, ...over } = {}) {
  const req = { version: 1, providerId: 'aa'.repeat(16), role: 'service', deploymentId: ZERO, runner, wgPublicKey: wgKey(), policy: null, ingress: true, egress: false,
    issuedAt: r.now(), nonce: randomBytes(16).toString('hex'), expiresAt: r.now() + 600000, ...over };
  return { request: req, signature: await signer.signMessage({ message: peerRequestMessage(req) }) };
}
async function revoke(r, { runner = hostA, signer = opA, wgPublicKey, ...over } = {}) {
  const req = { version: 1, providerId: 'aa'.repeat(16), runner, wgPublicKey, issuedAt: r.now(), nonce: randomBytes(16).toString('hex'), ...over };
  return { request: req, signature: await signer.signMessage({ message: revokeMessage(req) }) };
}
const appRequest = async (r) => {
  const req = { version: 1, providerId: 'aa'.repeat(16), role: 'exit', deploymentId: app, runner: appRunner, wgPublicKey: wgKey(), policy: null, ingress: true, egress: false,
    issuedAt: r.now(), nonce: randomBytes(16).toString('hex'), expiresAt: r.now() + 600000 };
  return { request: req, signature: await appOperator.signMessage({ message: peerRequestMessage(req) }) };
};

test('names: base32 of the FULL registry id, injective where 8 hex collide, never app-shaped', () => {
  assert.equal(base32(Buffer.from('foobar')), 'mzxw6ytboi');                       // RFC 4648 test vector, lowercase
  const n = hostServiceNames(hostA, ZONE);
  assert.deepEqual(Object.keys(n), ['directory-replica', 'bootstrap-replica', 'policy-mirror']);
  for (const name of Object.values(n)) { assert.ok(isHostServiceName(name, ZONE)); assert.ok(name.split('.')[0].length <= 63); }
  assert.equal(hostLabel(hostA).length, 52);
  // two ids sharing the first 8 hex (an app label's collision) still get different names
  const x = '0x' + 'a1a1a1a1' + '00'.repeat(28), y = '0x' + 'a1a1a1a1' + '00'.repeat(27) + '01';
  assert.notEqual(hostServiceNames(x, ZONE)['directory-replica'], hostServiceNames(y, ZONE)['directory-replica']);
  assert.throws(() => hostServiceNames(ZERO, ZONE), /nonzero/);
  assert.throws(() => hostServiceNames('0x' + 'a1'.repeat(31), ZONE), /32-byte/);
  assert.equal(isHostServiceName('abababab.app.example'), false);
  assert.equal(isHostServiceName(`dir-${hostLabel(hostA)}.other.example`, ZONE), false);
});

test('an active registered host, signed by its operator and admitted by the platform host policy, gets exactly its derived names', async () => {
  const r = rig();
  const { grant, signature } = await r.p.handle(await ask(r));
  assert.equal(await recoverMessageAddress({ message: grantMessage(grant), signature }), providerKey.address);
  assert.equal(grant.role, 'service'); assert.match(grant.clientAddress, /^10\.77\./); assert.equal(grant.endpoint, '134.199.235.187:51820');
  assert.deepEqual(grant.names, Object.values(hostServiceNames(hostA, ZONE)));
  for (const name of grant.names) assert.equal(r.p.route(name), grant.clientAddress);
  assert.equal(r.p.route(hostServiceNames(hostB, ZONE)['directory-replica']), null, 'another host\'s name is not routed to this one');
  assert.equal(r.p.route('unknown.example'), null, 'an unknown name stays closed');
  assert.ok(!r.kernel.synced.egress.includes(grant.clientAddress), 'a service peer gets no egress');
  assert.equal(r.policy.calls, 1, 'the platform host policy was asked');
});

test('refused: a stranger\'s signature, another host\'s operator, an unknown or inactive host, a tampered request', async () => {
  const r = rig();
  await assert.rejects(r.p.handle(await ask(r, { signer: stranger })), /active registered host/);
  await assert.rejects(r.p.handle(await ask(r, { signer: opB })), /active registered host/);
  await assert.rejects(r.p.handle(await ask(r, { runner: '0x' + '99'.repeat(32) })), /active registered host/);
  r.hosts.set(hostA, { ...r.hosts.get(hostA), active: false });
  await assert.rejects(r.p.handle(await ask(r)), /active registered host/);
  r.hosts.set(hostA, { ...r.hosts.get(hostA), active: true });
  const t = await ask(r); t.request.runner = hostB; await assert.rejects(r.p.handle(t), /active registered host/);
  const replay = await ask(r); await r.p.handle(replay); await assert.rejects(r.p.handle(replay), /replayed/);
  assert.equal([...r.p.peers.values()].filter((p) => p.role === 'service').length, 1);
});

test('refused by shape: egress, no ingress, an app id, a policy, the zero runner; the app/control paths do not grant service names', async () => {
  const r = rig();
  for (const over of [{ egress: true }, { ingress: false }, { deploymentId: app }, { policy: { policy: {}, signature: '0x' } }, { runner: ZERO, signer: opA }])
    await assert.rejects(r.p.handle(await ask(r, over)), /service peer|invalid/);
  const withNames = { ...(await ask(r)).request, names: ['x'] };
  assert.throws(() => validatePeerRequest(withNames, r.now()), /invalid peer request/, 'a request cannot carry names');
  // a control peer of the same host is still egress-only and nameless
  const c = await r.p.handle(await ask(r, { role: 'control', ingress: false, egress: true }));
  assert.deepEqual(c.grant.names, []);
});

test('the platform host policy: a ban, an allowlist miss, an inactive decision or an unreadable policy refuses the grant', async () => {
  for (const d of [{ admit: false, status: 'current', reason: 'banned by platform policy #4 (operator): abuse' },
    { admit: false, status: 'current', reason: 'not admitted by platform allowlist #4' }, { admit: false, status: 'inactive', reason: 'host registry entry is not active' },
    { admit: false, status: 'behind', reason: 'this node has not loaded the policy the book anchors at this block' }]) {
    const r = rig(); r.policy.decisions.set(hostA, d);
    await assert.rejects(r.p.handle(await ask(r)), /platform host policy/, d.reason);
    assert.equal(r.p.peers.size, 0);
  }
  const r = rig(); r.policy.throws = true; await assert.rejects(r.p.handle(await ask(r)), /quorum/);
  // no policy configured and not written "off": refused (never a silent bypass); "off" written explicitly: allowed (dev only)
  await assert.rejects(rig({ admission: null }).p.handle(await ask(rig({ admission: null }))), /need the platform host policy/);
  const off = rig({ admission: null, hostServices: { zone: ZONE, platformHostPolicy: 'off' } });
  assert.equal((await off.p.handle(await ask(off))).grant.role, 'service');
});

test('a provider without hostServices (today\'s) or without ingress refuses service peers', async () => {
  const none = rig({ hostServices: null });
  await assert.rejects(none.p.handle(await ask(none)), /does not carry host services/);
  const noIngress = rig({ roles: ['guard', 'egress'] });
  await assert.rejects(noIngress.p.handle(await ask(noIngress)), /does not offer ingress/);
});

test('apps and hosts never hold each other\'s names: custom domains in the (dedicated) service zone are dropped', async () => {
  const theirs = hostServiceNames(hostA, ZONE)['directory-replica'];
  const r = rig({ domains: ['www.example.org', theirs, 'x.' + ZONE, ZONE, `boot-${hostLabel(hostB)}.elsewhere.example`] });
  const a = await r.p.handle(await appRequest(r));
  // a lookalike OUTSIDE the service zone is an ordinary verified customer domain (root review 15:35Z): kept
  assert.deepEqual(a.grant.names, ['abababab.app.example', 'www.example.org', `boot-${hostLabel(hostB)}.elsewhere.example`]);
  assert.equal(r.p.route(theirs), null, 'an app cannot take a host-service name');
  const s = await r.p.handle(await ask(r));
  assert.equal(r.p.route(theirs), s.grant.clientAddress);
  assert.equal(r.p.route('abababab.app.example'), a.grant.clientAddress, 'the app name still routes to the app, not the newer service peer');
  // route() keeps them apart even if a peer table somehow held a crossed name
  [...r.p.peers.values()].find((p) => p.role === 'service').names.push('www.example.org');
  [...r.p.peers.values()].find((p) => p.role === 'exit').names.push(hostServiceNames(hostB, ZONE)['policy-mirror']);
  assert.equal(r.p.route('www.example.org'), a.grant.clientAddress);
  assert.equal(r.p.route(hostServiceNames(hostB, ZONE)['policy-mirror']), null);
});

test('bounds: two peers per host (handover), maxHosts distinct hosts', async () => {
  const r = rig({ hostServices: { zone: ZONE, platformHostPolicy: 'on', maxHosts: 2 } });
  const a1 = await r.p.handle(await ask(r)); r.advance(1); await r.p.handle(await ask(r)); r.advance(1); await r.p.handle(await ask(r));
  assert.equal([...r.p.peers.values()].filter((p) => p.runner === hostA).length, 2); assert.ok(!r.p.peers.has(a1.grant.clientPublicKey), 'the oldest was replaced');
  await r.p.handle(await ask(r, { runner: hostB, signer: opB }));
  await assert.rejects(r.p.handle(await ask(r, { runner: hostC, signer: opC })), /maximum number of host services/);
  const renew = [...r.p.peers.values()].find((p) => p.runner === hostA);
  await r.p.handle(await ask(r, { wgPublicKey: renew.key }));                             // a renewal of a held key is fine at the bound
});

test('revocation: the host\'s operator withdraws its own peer at once; nobody else can, and never an app\'s peer', async () => {
  const r = rig();
  const s = await r.p.handle(await ask(r)), key = s.grant.clientPublicKey;
  await assert.rejects(r.p.revoke(await revoke(r, { wgPublicKey: key, signer: stranger })), /registry operator/);
  await assert.rejects(r.p.revoke(await revoke(r, { wgPublicKey: key, runner: hostB, signer: opB })), /no peer of this host/);
  await assert.rejects(r.p.revoke(await revoke(r, { wgPublicKey: key, issuedAt: r.now() - 120000 })), /stale/);
  await assert.rejects(r.p.revoke(await revoke(r, { wgPublicKey: key, providerId: 'bb'.repeat(16) })), /another provider/);
  const forged = await revoke(r, { wgPublicKey: key }); forged.request.runner = hostB; await assert.rejects(r.p.revoke(forged), /registry operator/);
  const a = await r.p.handle(await appRequest(r));
  await assert.rejects(r.p.revoke(await revoke(r, { wgPublicKey: a.grant.clientPublicKey, runner: appRunner, signer: appOperator })), /no peer of this host/);
  assert.ok(r.p.peers.has(a.grant.clientPublicKey), 'the app peer survives');
  const ok = await revoke(r, { wgPublicKey: key });
  assert.equal((await r.p.revoke(ok)).revoked, true);
  assert.ok(!r.p.peers.has(key) && !r.kernel.peers.has(key));
  for (const name of s.grant.names) assert.equal(r.p.route(name), null, 'a revoked host\'s names close');
  await assert.rejects(r.p.revoke(ok), /replayed/);
});

test('sweep: deactivation, a ban or an allowlist miss removes the peer; an unreadable registry or policy keeps it; expiry removes', async () => {
  const r = rig(); const s = await r.p.handle(await ask(r)), key = s.grant.clientPublicKey;
  r.policy.throws = true; await r.p.sweep(); assert.ok(r.p.peers.has(key), 'an unreadable policy is not a refusal');
  r.policy.throws = false; r.policy.decisions.set(hostA, { admit: false, status: 'behind', reason: 'this node has not loaded the policy' });
  await r.p.sweep(); assert.ok(r.p.peers.has(key), 'a node behind the anchor is not a definite refusal');
  r.policy.decisions.set(hostA, { admit: false, status: 'current', reason: 'banned by platform policy #9 (operator): abuse' });
  await r.p.sweep(); assert.ok(!r.p.peers.has(key), 'a ban removes it'); assert.equal(r.p.route(s.grant.names[0]), null);
  const r2 = rig(); const s2 = await r2.p.handle(await ask(r2));
  const hosts = r2.p.hosts; r2.p.hosts = async () => { throw new Error('rpc'); }; await r2.p.sweep(); assert.ok(r2.p.peers.has(s2.grant.clientPublicKey));
  r2.p.hosts = hosts; r2.hosts.set(hostA, { ...r2.hosts.get(hostA), active: false }); await r2.p.sweep(); assert.equal(r2.p.peers.size, 0, 'deactivation (the admin\'s registry ban) removes it');
  const r3 = rig(); await r3.p.handle(await ask(r3)); r3.policy.decisions.set(hostA, { admit: false, status: 'current', reason: 'not admitted by platform allowlist #2' });
  await r3.p.sweep(); assert.equal(r3.p.peers.size, 0);
  const r4 = rig(); await r4.p.handle(await ask(r4)); r4.advance(600001); await r4.p.sweep(); assert.equal(r4.p.peers.size, 0, 'expiry removes it');
  const r5 = rig(); await r5.p.handle(await ask(r5)); r5.p.config.hostServices = undefined; await r5.p.sweep(); assert.equal(r5.p.peers.size, 0, 'host services withdrawn by the operator');
});

test('DNS 53: one pinned host, chosen by rendezvous rank, deterministic; fails over on revoke, expiry and a stale handshake', async () => {
  const dns = { hosts: [hostA, hostB], staleMs: 180000 };
  const r = rig({ hostServices: { zone: ZONE, platformHostPolicy: 'on', dns } });
  assert.equal(r.p.dnsTarget(), null, 'nobody before a grant');
  const c = await r.p.handle(await ask(r, { runner: hostC, signer: opC }));
  assert.equal(r.p.dnsTarget(), null, 'an unpinned host never gets DNS');
  const a = await r.p.handle(await ask(r)), b = await r.p.handle(await ask(r, { runner: hostB, signer: opB }));
  const rank = (h) => createHash('sha256').update(`${'aa'.repeat(16)}|${h}`).digest('hex');
  const [first, second] = rank(hostA) > rank(hostB) ? [a, b] : [b, a];
  await r.p.probeDnsPeers(); await r.p.sync();
  assert.equal(r.p.dnsTarget(), first.grant.clientAddress); assert.equal(r.kernel.synced.dns, first.grant.clientAddress, 'the kernel got the same target');
  for (let i = 0; i < 5; i++) assert.equal(r.p.dnsTarget(), first.grant.clientAddress, 'the same inputs give the same host');
  // a stale handshake: the first is passed over, the second takes it; a fresh handshake brings the first back
  r.advance(200000);
  r.kernel.stats = async () => ({ [first.grant.clientPublicKey]: { lastHandshake: r.now() - 190000 }, [second.grant.clientPublicKey]: { lastHandshake: r.now() - 5000 } });
  await r.p.sweep(); assert.equal(r.kernel.synced.dns, second.grant.clientAddress);
  r.kernel.stats = async () => ({ [first.grant.clientPublicKey]: { lastHandshake: r.now() - 1000 }, [second.grant.clientPublicKey]: { lastHandshake: r.now() - 1000 } });
  await r.p.sweep(); assert.equal(r.kernel.synced.dns, first.grant.clientAddress);
  // revoke: next-ranked at once
  const firstHost = first === a ? hostA : hostB, firstOp = first === a ? opA : opB;
  await r.p.revoke(await revoke(r, { runner: firstHost, signer: firstOp, wgPublicKey: first.grant.clientPublicKey }));
  assert.equal(r.kernel.synced.dns, second.grant.clientAddress);
  // expiry of the last pinned host: nobody (the unpinned host C still never gets it)
  r.advance(600001); r.kernel.stats = null; await r.p.sweep();
  assert.equal(r.kernel.synced.dns, null); assert.ok(c.grant.clientAddress);
  // another provider ranks the same hosts with its own id (spreading), still deterministically
  const other = rig({ hostServices: { zone: ZONE, platformHostPolicy: 'on', dns } }); other.p.config.providerId = 'cc'.repeat(16);
  const oa = await other.p.handle(await ask(other, { providerId: 'cc'.repeat(16) })), ob = await other.p.handle(await ask(other, { runner: hostB, signer: opB, providerId: 'cc'.repeat(16) }));
  const orank = (h) => createHash('sha256').update(`${'cc'.repeat(16)}|${h}`).digest('hex');
  await other.p.probeDnsPeers();
  assert.equal(other.p.dnsTarget(), orank(hostA) > orank(hostB) ? oa.grant.clientAddress : ob.grant.clientAddress);
});

test('a provider without dns configured never sends a DNS target to the kernel', async () => {
  const r = rig(); await r.p.handle(await ask(r));
  assert.ok(!('dns' in r.kernel.synced)); assert.equal(r.p.dnsTarget(), null);
});

test('the restart table keeps service peers (restore) and their names route again', async () => {
  let saved = null; const store = { load: async () => saved, save: async (v) => { saved = structuredClone(v); } };
  const r = rig(); r.p.store = store; const s = await r.p.handle(await ask(r));
  const again = rig(); again.p.store = store; assert.equal(await again.p.restore(), 1);
  assert.equal(again.p.route(s.grant.names[0]), s.grant.clientAddress);
  assert.equal(again.kernel.peers.get(s.grant.clientPublicKey).role, 'exit', 'kernel peer on the exit interface');
});

test('provider config: zone overlap, missing policy, ingress role, dns pins and limits are validated', () => {
  const ok = providerHostServices({ zone: ZONE, platformHostPolicy: 'production', dns: { hosts: [hostA.toUpperCase().replace('0X', '0x')] } }, { zone: 'app.example', probeZone: 'probe.example', roles: ['ingress'] });
  assert.deepEqual(ok.dns.hosts, [hostA]); assert.equal(ok.dns.limits.perSourcePps, 20);
  const bad = [[{ zone: 'x.app.example', platformHostPolicy: 'production' }, /overlaps the app zone/], [{ zone: 'z.probe.example', platformHostPolicy: 'production' }, /overlaps the probe zone/],
    [{ zone: 'probe.example', platformHostPolicy: 'production' }, /probe zone/], [{ zone: ZONE }, /platformHostPolicy is required/],
    [{ zone: ZONE, platformHostPolicy: 'off', platformHostPolicyMirrors: ['https://m.example/'] }, /nothing would use/],
    [{ zone: ZONE, platformHostPolicy: 'production', dns: { hosts: [] } }, /dns.hosts/], [{ zone: ZONE, platformHostPolicy: 'production', dns: { hosts: [ZERO] } }, /dns.hosts/],
    [{ zone: ZONE, platformHostPolicy: 'production', dns: { hosts: [hostA], perSourcePps: 5000 } }, /per-source at most global|burst/],
    [{ zone: ZONE, platformHostPolicy: 'production', token: 'x' }, /unknown field/], [{ zone: 'UPPER.example', platformHostPolicy: 'production' }, /lowercase DNS zone/]];
  for (const [h, re] of bad) assert.throws(() => providerHostServices(h, { zone: 'app.example', probeZone: 'probe.example', roles: ['ingress'] }), re, JSON.stringify(h));
  assert.throws(() => providerHostServices({ zone: ZONE, platformHostPolicy: 'production' }, { roles: ['guard', 'egress'] }), /ingress role/);
});

// ---- root review 15:35Z: replay races, zone-scoped reservation, structured policy statuses ----
import { definiteRefusal, STALE_NEW_HOST } from '../network/wg-provider/provider.mjs';
import { judgeHost } from '../network/platform-host-policy.mjs';

test('a signed request racing through the reads twice is used ONCE; two keys racing for one host never make duplicate peers', async () => {
  const r = rig();
  // slow reads: both copies pass handle()'s first replay check before either consumes the nonce
  const hosts = r.p.hosts; r.p.hosts = async (x) => { await new Promise((ok) => setTimeout(ok, 30)); return hosts(x); };
  const env = await ask(r);
  const results = await Promise.allSettled([r.p.handle(env), r.p.handle(env), r.p.handle(env)]);
  assert.equal(results.filter((x) => x.status === 'fulfilled').length, 1, results.map((x) => x.reason?.message).join(' | '));
  assert.ok(results.filter((x) => x.status === 'rejected').every((x) => /replayed/.test(x.reason.message)));
  assert.equal([...r.p.peers.values()].filter((p) => p.role === 'service').length, 1);
  // the same KEY in two differently-signed requests at once: one peer, one address
  const key = wgKey(), a = await ask(r, { wgPublicKey: key }), b = await ask(r, { wgPublicKey: key });
  const both = await Promise.all([r.p.handle(a), r.p.handle(b)]);
  assert.equal(both[0].grant.clientAddress, both[1].grant.clientAddress, 'the second is a renewal of the first, not a second peer');
  assert.equal([...r.p.peers.values()].filter((p) => p.key === key).length, 1);
  assert.equal(r.p.used.size, r.p.peers.size, 'no tunnel address leaked');
  // a revoke racing with itself
  const rv = await revoke(r, { wgPublicKey: key });
  const out = await Promise.allSettled([r.p.revoke(rv), r.p.revoke(rv)]);
  assert.equal(out.filter((x) => x.status === 'fulfilled').length, 1); assert.match(out.find((x) => x.status === 'rejected').reason.message, /replayed/);
});

test('only the configured service zone is reserved: a verified customer domain of the same SHAPE elsewhere still routes to its app', async () => {
  const lookalike = `dir-${hostLabel(hostA)}.customer.example`, inZone = hostServiceNames(hostA, ZONE)['directory-replica'];
  const r = rig({ domains: [lookalike, inZone] });
  const a = await r.p.handle(await appRequest(r));
  assert.deepEqual(a.grant.names, ['abababab.app.example', lookalike], 'the customer domain is kept; the in-zone host name is not');
  assert.equal(r.p.route(lookalike), a.grant.clientAddress);
  const s = await r.p.handle(await ask(r));
  assert.equal(r.p.route(lookalike), a.grant.clientAddress, 'a service peer never takes a name outside its zone');
  assert.equal(r.p.route(inZone), s.grant.clientAddress);
});

test('the app zone itself as the service zone (hosted route-dns): app labels and customer domains unchanged, service shapes reserved', async () => {
  const r = rig({ hostServices: { zone: 'app.example', platformHostPolicy: 'on' }, domains: ['www.example.org', `dir-${hostLabel(hostB)}.app.example`] });
  const a = await r.p.handle(await appRequest(r));
  assert.deepEqual(a.grant.names, ['abababab.app.example', 'www.example.org'], 'exactly as without host services');
  const s = await r.p.handle(await ask(r));
  assert.deepEqual(s.grant.names, Object.values(hostServiceNames(hostA, 'app.example')));
  assert.equal(r.p.route('abababab.app.example'), a.grant.clientAddress);
  assert.equal(r.p.route(hostServiceNames(hostA, 'app.example')['policy-mirror']), s.grant.clientAddress);
  assert.equal(r.p.route(`dir-${hostLabel(hostB)}.app.example`), null, 'another host\'s name is not claimable by an app');
  assert.doesNotThrow(() => providerHostServices({ zone: 'app.example', platformHostPolicy: 'production' }, { zone: 'app.example', probeZone: 'probe.example', roles: ['ingress'] }));
});

test('sweep decisions come from the policy runtime\'s STRUCTURED statuses (real judgeHost fixtures), not wording', async () => {
  const now = 2_000_000_000, host = { registryId: hostA, operator: opA.address.toLowerCase() };
  const policy = (o) => ({ sequence: 7, mode: 'denylist', deny: [], admit: [], expiresAt: now + 3600, maxStaleSec: 86400, ...o });
  const ban = { kind: 'registryId', value: hostA, reason: 'any wording at all' };
  const cases = [
    ['ban, current policy', judgeHost(policy({ deny: [ban] }), host, now), true],
    ['ban, stale-grace policy', judgeHost(policy({ deny: [ban], expiresAt: now - 10 }), host, now), true],
    ['ban, stale policy', judgeHost(policy({ deny: [ban], expiresAt: now - 200000, maxStaleSec: 100 }), host, now), true],
    ['allowlist miss', judgeHost(policy({ mode: 'allowlist' }), host, now), true],
    ['inactive entry', { admit: false, status: 'inactive', reason: 'host registry entry is not active' }, true],
    ['stale policy, never admitted', judgeHost(policy({ expiresAt: now - 200000, maxStaleSec: 100 }), host, now), false],
    ['no policy accepted', judgeHost(null, host, now), false],
    ['behind the anchor', { admit: false, status: 'behind', reason: 'x' }, false], ['authority rotated', { admit: false, status: 'authority', reason: 'x' }, false],
    ['authority unread', { admit: false, status: 'authority-unread', reason: 'x' }, false], ['torn anchor', { admit: false, status: 'anchor', reason: 'x' }, false],
    ['no decision', { admit: false, reason: 'no decision' }, false], ['unban: admitted', judgeHost(policy({}), host, now), false],
  ];
  assert.equal(cases[5][1].reason, STALE_NEW_HOST, 'the one non-admin judgement is judgeHost\'s own text');
  assert.equal(cases[0][1].status, 'current'); assert.equal(cases[12][1].admit, true);
  for (const [what, d, definite] of cases) {
    assert.equal(definiteRefusal(d), definite, what);
    const r = rig(); const s = await r.p.handle(await ask(r)); r.policy.decisions.set(hostA, d);
    await r.p.sweep();
    assert.equal(r.p.peers.has(s.grant.clientPublicKey), !definite, `${what}: ${definite ? 'removed' : 'kept'}`);
  }
  // after an unban the host is granted again
  const r = rig(); r.policy.decisions.set(hostA, cases[0][1]); await assert.rejects(r.p.handle(await ask(r)), /platform host policy/);
  r.policy.decisions.set(hostA, cases[12][1]); assert.equal((await r.p.handle(await ask(r))).grant.role, 'service');
});

test('a sweep asks the platform host policy ONCE for every carried host (one quorum read), never once per peer', async () => {
  const r = rig({ hostServices: { zone: ZONE, platformHostPolicy: 'on', maxHosts: 8 } });
  await r.p.handle(await ask(r)); await r.p.handle(await ask(r)); await r.p.handle(await ask(r, { runner: hostB, signer: opB })); await r.p.handle(await ask(r, { runner: hostC, signer: opC }));
  const seen = []; const inner = r.p.hostAdmission; r.p.hostAdmission = async (ids) => { seen.push([...ids].sort()); return inner(ids); };
  await r.p.sweep();
  assert.deepEqual(seen, [[hostA, hostB, hostC].sort()]);
  assert.equal([...r.p.peers.values()].filter((p) => p.role === 'service').length, 4);
});


// ---- hs-transport-review B5 / m1 / m3 counterexamples ----
test('B5: a pinned host whose tunnel is up but whose DNS role does not answer loses 53 to the next healthy host within one sweep', async () => {
  const dns = { hosts: [hostA, hostB], staleMs: 180000 };
  const r = rig({ hostServices: { zone: ZONE, platformHostPolicy: 'on', dns } });
  const a = await r.p.handle(await ask(r)), b = await r.p.handle(await ask(r, { runner: hostB, signer: opB }));
  const rank = (h) => createHash('sha256').update(`${'aa'.repeat(16)}|${h}`).digest('hex');
  const [first, second] = rank(hostA) > rank(hostB) ? [a, b] : [b, a];
  await r.p.sweep(); assert.equal(r.kernel.synced.dns, first.grant.clientAddress);
  // the first's route-dns crashed (or it never configured dns): its circuit renews, its handshakes stay fresh
  r.dnsDown.add(first.grant.clientAddress);
  r.kernel.stats = async () => ({ [first.grant.clientPublicKey]: { lastHandshake: r.now() }, [second.grant.clientPublicKey]: { lastHandshake: r.now() } });
  await r.p.handle(await ask(r, { runner: first === a ? hostA : hostB, signer: first === a ? opA : opB, wgPublicKey: first.grant.clientPublicKey }));   // a renewal
  await r.p.sweep();
  assert.equal(r.kernel.synced.dns, second.grant.clientAddress, 'moved to the healthy pinned host at the next sweep');
  r.dnsDown.clear(); await r.p.sweep();
  assert.equal(r.kernel.synced.dns, first.grant.clientAddress, 'back to the rendezvous winner once it answers again');
  // the PIN decides, not health: an unpinned host whose DNS answers (and that outranks both) is never chosen
  const c = await r.p.handle(await ask(r, { runner: hostC, signer: opC }));
  const cp = r.p.peers.get(c.grant.clientPublicKey); Object.assign(cp, { dnsOk: true, dnsCheckedAt: r.now(), lastHandshake: r.now() });
  const ownId = r.p.config.providerId;
  r.p.config.providerId = [...Array(64).keys()].map((i) => 'p' + i).find((id) => { const rk = (h) => createHash('sha256').update(`${id}|${h}`).digest('hex'); return rk(hostC) > rk(hostA) && rk(hostC) > rk(hostB); }) || r.p.config.providerId;
  assert.notEqual(r.p.dnsTarget(), c.grant.clientAddress, 'a healthy unpinned host is not a DNS target');
  r.p.config.providerId = ownId;
  // both silent: nobody (the provider's own listener, or nothing, answers 53), never a blackhole
  r.dnsDown.add(first.grant.clientAddress); r.dnsDown.add(second.grant.clientAddress); await r.p.sweep();
  assert.equal(r.kernel.synced.dns, null);
  // a provider without a probe never forwards 53, however fresh the tunnels are
  const np = rig({ hostServices: { zone: ZONE, platformHostPolicy: 'on', dns }, probe: false });
  await np.p.handle(await ask(np)); await np.p.sweep(); assert.equal(np.kernel.synced.dns, null);
  // a fresh grant is probed at once (not only at the next sweep)
  const fresh = rig({ hostServices: { zone: ZONE, platformHostPolicy: 'on', dns } });
  const g = await fresh.p.handle(await ask(fresh)); await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(fresh.kernel.synced.dns, g.grant.clientAddress);
});

test('m1: concurrent new keys for one host never leave more than two service peers, even while removals are slow', async () => {
  const r = rig();
  const k1 = await r.p.handle(await ask(r)); r.advance(1); await r.p.handle(await ask(r)); r.advance(1);
  const remove = r.kernel.removePeer; r.kernel.removePeer = async (p) => { await new Promise((ok) => setTimeout(ok, 40)); return remove(p); };
  await Promise.all([r.p.handle(await ask(r)), r.p.handle(await ask(r)), r.p.handle(await ask(r))]);
  assert.equal([...r.p.peers.values()].filter((p) => p.role === 'service' && p.runner === hostA).length, 2);
  assert.equal([...r.kernel.peers.values()].filter((p) => p.runner === hostA).length, 2, 'the kernel agrees');
  assert.ok(!r.p.peers.has(k1.grant.clientPublicKey));
  assert.equal(r.p.used.size, r.p.peers.size, 'no address leaked');
});

test('m3: a restart re-derives service names from the CURRENT zone; without host services the saved service peers are not restored', async () => {
  let saved = null; const store = { load: async () => saved, save: async (v) => { saved = structuredClone(v); } };
  const r = rig(); r.p.store = store; const s = await r.p.handle(await ask(r));
  const moved = rig({ hostServices: { zone: 'other.example', platformHostPolicy: 'on' } }); moved.p.store = store;
  assert.equal(await moved.p.restore(), 1);
  for (const n of s.grant.names) assert.equal(moved.p.route(n), null, `old-zone name ${n} no longer routes`);
  assert.equal(moved.p.route(hostServiceNames(hostA, 'other.example')['directory-replica']), s.grant.clientAddress);
  const gone = rig({ hostServices: null }); gone.p.store = store;
  assert.equal(await gone.p.restore(), 0); assert.equal(gone.kernel.peers.size, 0);
});
