// The privacy agent's OWN host-services gate (enclaveNetwork.hostServicesPolicy -> host-policy-carrier-gate.mjs) on the
// EXPLICIT local chain verifier (chainAuthority "verifier"), not the policy's RPC quorum. Offline: the platform policy world
// (test/helpers/platform-policy-world.mjs: the book, registry and ownership facts, its three PUBLIC provider origins with a
// hit counter and an outage switch, and the operator's own node) behind test/helpers/loopback-verifier.mjs (the verifier
// protocol and refusals; Merkle checks are the real verifier's). The fleet's policy mirrors are refused at the transport.
//   - config: one explicit authority (verifier refuses rpcs/minAgree, a policy that names its own authority, a remote or
//     missing verifier, "off"); the quorum block is normalized exactly as before; env/chain mismatches refuse;
//   - with every public provider DOWN: the gate admits from the import carrier through the verifier; ban, unban, a book
//     OWNER rotation (the old owner's anchored document never counts; the new owner's ban and unban do);
//   - verifier outage with the public providers UP: no fallback (zero public hits), grace then refusal, recovery;
//   - control: the raw-quorum default still reads the providers;
//   - the real daemon: admitted through the verifier with the providers down, then banned; an authority mismatch refuses
//     HOST SERVICES only (the apps keep running).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { platformPolicyWorld, BOOK, OWNERSHIP } from './helpers/platform-policy-world.mjs';
import { startLoopbackVerifier } from './helpers/loopback-verifier.mjs';
import { hostRig, daemon, sleep, count, ENDPOINT, RUNNER, DO_FRONTS } from './helpers/privacy-agent-rig.mjs';
import { hostServicesPolicyConfig, hostPolicyGateEnv, runnerPolicyShape, hostServicesGateAuthority } from '../network/host-policy-gate-config.mjs';
import { hostPolicyCarrierGate } from '../network/host-policy-carrier-gate.mjs';

const OPERATOR = '0x' + '44'.repeat(20);
const FLEET_MIRRORS = DO_FRONTS.map((ip) => `https://${ip}/platform-policy`);
const STARTED = /host services: \{/, STOPPED = /host services stopped: platform host policy:/;
const FAST = { ENCLAVE_PLATFORM_HOST_POLICY_INTERVAL_SEC: '1', ENCLAVE_PLATFORM_HOST_POLICY_GRACE_SEC: '6' };
const ban = [{ kind: 'operator', value: OPERATOR, reason: 'abuse' }];
const world = (t) => platformPolicyWorld(t, { hosts: { [RUNNER]: { endpoint: ENDPOINT, operator: OPERATOR, owner: '0x' + '55'.repeat(20), active: true } } });
const tmpDir = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const put = (dir, name, body) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body)); };
const POLICY = { book: BOOK, hostOwnership: OWNERSHIP, mirrors: [...FLEET_MIRRORS] };
async function verifierFor(t, w) { const v = await startLoopbackVerifier({ upstream: w.node }); t.after(() => v.close()); return v; }
// the gate's transport: the fleet fronts refused (recorded); loopback only otherwise
function transport() {
  const denied = [];
  const f = (url, opts) => { const u = new URL(url);
    if (DO_FRONTS.includes(u.hostname)) { denied.push(u.href); return Promise.reject(new TypeError('connect ECONNREFUSED (fleet down)')); }
    if (u.hostname === '127.0.0.1') return fetch(u, opts);
    return Promise.reject(new TypeError(`no route to ${u.hostname}`)); };
  return { fetch: f, denied };
}

test('config: verifier mode is one explicit authority; the quorum block is unchanged; mixed settings refuse', () => {
  const V = { chainAuthority: 'verifier', chainVerifier: 'http://127.0.0.1:28590/' };
  const h = hostServicesPolicyConfig({ policy: POLICY, ...V, carriers: { importDir: '/var/lib/policy-import' } });
  assert.equal(h.chainAuthority, 'verifier'); assert.equal(h.chainVerifier, V.chainVerifier); assert.equal(h.rpcs, null);
  const { env } = hostPolicyGateEnv(h);
  assert.equal(env.ENCLAVE_CHAIN_AUTHORITY, 'verifier'); assert.equal(env.ENCLAVE_CHAIN_VERIFIER, V.chainVerifier); assert.equal(env.ENCLAVE_PLATFORM_HOST_POLICY_RPCS, undefined);
  assert.deepEqual([runnerPolicyShape(h).chainAuthority, runnerPolicyShape(h).chainVerifier], ['verifier', V.chainVerifier]);
  assert.equal(hostServicesPolicyConfig({ policy: 'production', ...V }).chainAuthority, 'verifier', 'production + verifier: the platform RPC defaults are unused');
  // the raw-quorum default: normalized exactly as before (no authority keys at all), and still needs its quorum
  const q = hostServicesPolicyConfig({ policy: POLICY, rpcs: ['http://127.0.0.1:1', 'http://127.0.0.1:2'] });
  assert.deepEqual(Object.keys(q), ['policy', 'mirrors', 'rpcs', 'carriers']);
  assert.equal(hostPolicyGateEnv(q).env.ENCLAVE_CHAIN_AUTHORITY, undefined);
  assert.deepEqual(Object.keys(hostServicesPolicyConfig({ policy: POLICY, rpcs: ['http://127.0.0.1:1', 'http://127.0.0.1:2'], chainAuthority: 'quorum' })), ['policy', 'mirrors', 'rpcs', 'carriers']);
  for (const [c, re] of [
    [{ policy: POLICY, ...V, rpcs: ['http://127.0.0.1:1', 'http://127.0.0.1:2'] }, /not used with chainAuthority "verifier"/],
    [{ policy: { ...POLICY, rpcs: ['http://127.0.0.1:1', 'http://127.0.0.1:2'] }, ...V }, /not used with chainAuthority "verifier"/],
    [{ policy: { ...POLICY, minAgree: 2 }, ...V }, /not used with chainAuthority "verifier"/],
    // before this change a policy-level verifier beside an RPC list was accepted SILENTLY as verifier mode
    [{ policy: { ...POLICY, ...V, rpcs: ['http://127.0.0.1:1', 'http://127.0.0.1:2'] } }, /name the chain authority once/],
    [{ policy: { ...POLICY, ...V } }, /name the chain authority once/],
    [{ policy: POLICY, chainAuthority: 'verifier' }, /needs chainVerifier/],
    [{ policy: POLICY, chainAuthority: 'verifier', chainVerifier: 'https://verifier.example.net/' }, /local \(loopback\)/],
    [{ policy: POLICY, chainAuthority: 'verifier', chainVerifier: 'http://10.0.2.2:28590/' }, /local \(loopback\)/],
    [{ policy: POLICY, rpcs: ['http://127.0.0.1:1', 'http://127.0.0.1:2'], chainVerifier: V.chainVerifier }, /chainVerifier is set but chainAuthority is not "verifier"/],
    [{ policy: POLICY, chainAuthority: 'helios', chainVerifier: V.chainVerifier }, /must be "quorum" or "verifier"/],
    [{ policy: 'off', ...V }, /"off" takes no chain authority/],
    [{ policy: POLICY }, /RPC quorum is unknown/]]) assert.throws(() => hostServicesPolicyConfig(c), re, JSON.stringify(c));
  // the agent's environment and its own chain verifier must agree with the block
  const qa = hostServicesGateAuthority;
  assert.match(qa(q, { env: { ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: V.chainVerifier } }).refused, /disagree/);
  assert.match(qa(h, { env: {} }).refused ?? 'none', /none/);
  assert.match(qa(h, { env: { ENCLAVE_CHAIN_AUTHORITY: 'quorum' } }).refused, /disagree/);
  assert.match(qa(h, { env: { ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: 'http://127.0.0.1:1/' } }).refused, /disagree/);
  assert.deepEqual(qa(h, { env: { ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: V.chainVerifier }, chain: { authority: 'verifier', verifier: V.chainVerifier } }), { refused: null, warning: null });
  assert.match(qa(h, { chain: { authority: 'verifier', verifier: 'http://127.0.0.1:50546/' } }).refused, /one local verifier per host/);
  const warn = qa(q, { chain: { authority: 'verifier', verifier: V.chainVerifier } });
  assert.equal(warn.refused, null); assert.match(warn.warning, /RPC quorum/, 'the kept quorum default is reported, never hidden');
  assert.match(qa(null, { chain: { authority: 'verifier', verifier: V.chainVerifier } }).warning, /RPC quorum/, 'no block: the default gate is reported too');
});

test('gate on the verifier with every public provider DOWN: admit, ban, unban, owner rotation; outage never falls back', { timeout: 120_000 }, async (t) => {
  const w = await world(t), v = await verifierFor(t, w), importDir = tmpDir(t, 'policy-import-'), net = transport();
  w.setDown(true);
  const hits0 = w.publicHits();
  const d1 = await w.publish({ deny: [] }); put(importDir, d1, w.document(d1));
  const h = hostServicesPolicyConfig({ policy: POLICY, chainAuthority: 'verifier', chainVerifier: v.url, carriers: { importDir } });
  const gate = await hostPolicyCarrierGate(h, { hostId: RUNNER, stateDir: tmpDir(t, 'gate-'), fetch: net.fetch, graceMs: 4000, intervalMs: 500 });
  const accepted = () => gate.status().runtime?.accepted?.digest ?? null;
  await gate.check();
  assert.equal(gate.serviceRefusal(), null, `admitted through the verifier and the carrier: ${JSON.stringify(gate.status()).slice(0, 600)}`);
  assert.equal(accepted(), d1);
  assert.ok(v.state.calls.some((c) => c.method === 'eth_call' && c.to === BOOK.toLowerCase()), 'the book was read through the verifier');
  assert.ok(net.denied.some((u) => u.startsWith(FLEET_MIRRORS[0])), 'the fleet mirrors were tried and refused');

  const d2 = await w.publish({ deny: ban }); put(importDir, d2, w.document(d2));
  await gate.check();
  assert.match(String(gate.serviceRefusal()), /platform host policy/, 'the admin\'s ban closes host services'); assert.equal(accepted(), d2);
  const d3 = await w.publish({ deny: [] }); put(importDir, d3, w.document(d3));
  await gate.check();
  assert.equal(gate.serviceRefusal(), null, 'the admin\'s unban admits again'); assert.equal(accepted(), d3);

  // AddressBook owner rotation: a document the PREVIOUS owner signs and anchors never counts; the current owner's do
  const { prev } = w.rotateOwner();
  const stale = await w.publish({ deny: ban, signer: prev }); put(importDir, stale, w.document(stale));
  await gate.check();
  assert.notEqual(accepted(), stale, 'the previous owner\'s document is not accepted');
  const d4 = await w.publish({ deny: ban }); put(importDir, d4, w.document(d4));
  await gate.check();
  assert.equal(accepted(), d4); assert.match(String(gate.serviceRefusal()), /platform host policy/, 'the current owner\'s ban applies');
  const d5 = await w.publish({ deny: [] }); put(importDir, d5, w.document(d5));
  await gate.check();
  assert.equal(gate.serviceRefusal(), null, 'the current owner\'s unban admits'); assert.equal(accepted(), d5);
  assert.equal(w.publicHits(), hits0, 'no public provider was asked while they were down');

  // the verifier fails while the public providers are HEALTHY: nothing falls back to them
  w.setDown(false);
  const hits1 = w.publicHits();
  for (const fault of ['down', 'proof', 'stale']) {
    v.state.fault = fault;
    await gate.check().catch(() => {});
    assert.equal(accepted(), d5, `${fault}: nothing new is accepted`);
  }
  v.state.fault = 'down';
  await sleep(4500); await gate.check().catch(() => {});
  assert.match(String(gate.serviceRefusal()), /platform host policy/, 'after the grace without an authenticated admit: refused');
  assert.equal(w.publicHits(), hits1, 'zero public-provider requests during the verifier outage (no fallback)');
  v.state.fault = null;
  await gate.check();
  assert.equal(gate.serviceRefusal(), null, 'recovered through the verifier');
  gate.stop();
});

test('control: the raw-quorum default (no chainAuthority) still reads the policy\'s providers, and admits nothing while they are down', { timeout: 60_000 }, async (t) => {
  const w = await world(t), importDir = tmpDir(t, 'policy-import-'), net = transport();
  const d1 = await w.publish({ deny: [] }); put(importDir, d1, w.document(d1));
  const h = hostServicesPolicyConfig({ policy: POLICY, rpcs: w.rpcs, carriers: { importDir } });
  w.setDown(true);
  const down = await hostPolicyCarrierGate(h, { hostId: RUNNER, stateDir: tmpDir(t, 'gate-'), fetch: net.fetch });
  await down.check().catch(() => {});
  assert.match(String(down.serviceRefusal()), /platform host policy/, 'providers down: the quorum gate admits nothing'); down.stop();
  w.setDown(false);
  const hits = w.publicHits(), up = await hostPolicyCarrierGate(h, { hostId: RUNNER, stateDir: tmpDir(t, 'gate-'), fetch: net.fetch });
  await up.check();
  assert.equal(up.serviceRefusal(), null); assert.ok(w.publicHits() > hits, 'the quorum default read the providers'); up.stop();
});

test('the real daemon: host services admitted through the verifier with every provider down, then banned', { timeout: 120_000 }, async (t) => {
  const w = await world(t), v = await verifierFor(t, w), importDir = tmpDir(t, 'policy-import-');
  w.setDown(true); const hits0 = w.publicHits();
  const d1 = await w.publish({ deny: [] }); put(importDir, d1, w.document(d1));
  const rig = await hostRig(t, { extra: { hostServicesPolicy: { policy: POLICY, chainAuthority: 'verifier', chainVerifier: v.url, carriers: { importDir } } } });
  const d = daemon(t, rig, { env: FAST });
  await d.until(/read through the local chain verifier \(no RPC quorum\)/); await d.until(STARTED, 40_000);
  const d2 = await w.publish({ deny: ban }); put(importDir, d2, w.document(d2));
  await d.until(STOPPED, 30_000);
  assert.equal(w.publicHits(), hits0, 'the daemon\'s gate and carriers never asked a public provider');
  assert.ok(v.state.calls.length > 0);
  assert.ok(await d.stop(), 'stopped');
});

test('the real daemon: an authority mismatch refuses HOST SERVICES only; the apps keep running', { timeout: 60_000 }, async (t) => {
  const w = await world(t), v = await verifierFor(t, w);
  const rig = await hostRig(t, { apps: 1, extra: { hostServicesPolicy: { policy: POLICY, rpcs: w.rpcs } } });
  const d = daemon(t, rig, { env: { ...FAST, ENCLAVE_CHAIN_AUTHORITY: 'verifier', ENCLAVE_CHAIN_VERIFIER: v.url } });
  await d.until(/HOST SERVICES REFUSED \(apps unaffected\): platform host policy: ENCLAVE_CHAIN_AUTHORITY\/ENCLAVE_CHAIN_VERIFIER \(verifier\) in the environment disagree/);
  await sleep(1500); assert.equal(d.child.exitCode, null, 'the apps keep running'); assert.equal(count(d.out, STARTED), 0);
  assert.ok(await d.stop(), 'stopped');
});
