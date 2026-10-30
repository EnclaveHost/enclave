// createShieldSecretRelease end to end: real operator EIP-191 signatures, a real X25519 seal opened with the guest's key and
// a real Ed25519 response signature. The hub is a FAKE: verifyShieldApp only records what reaches it and returns a chosen
// verdict. No attestation is tested here (the signed VBS verification has its own tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createShieldSecretRelease, secretRequestMessage } from '../relay/shield-secrets.mjs';
import { openRelease, verifyResponse, rawPublicOf, ed25519RawPublic, keyIdOf } from '../relay/secrets-release.mjs';
import { expectedShieldApp } from '../relay/shield-app-verifier.mjs';

const vectors = JSON.parse(fs.readFileSync(new URL('../isolation/contract/catalog/desktop_vectors.json', import.meta.url)));
const pinned = vectors.ok[0].mapping, component = Buffer.from(vectors.component_hex, 'hex');

const HOST = 'shield-node-1', ENDPOINT = 'https://node-1.example.test', EP_ID = '0x' + 'aa'.repeat(32);
const ID = '0x' + '33'.repeat(32), APP = pinned.record.catalog.app;
const ADMIT = { hosts: [HOST] };
const operator = privateKeyToAccount(generatePrivateKey()), stranger = privateKeyToAccount(generatePrivateKey());
const SECRETS = { API_TOKEN: `test-only-${randomBytes(12).toString('hex')}` };
const MODEL = 'qwen2.5-0.5b-q8-gguf';

const desktop = {
  schema: 'enclave-desktop-release/1',
  controllerCid: pinned.record.cid,
  controllerSha256: pinned.componentSha256,
  runtimeId: pinned.record.runtimeId,
  igvmSha256: '5a'.repeat(32),
  profileSha256: pinned.record.desktop.profileSha256,
  launchMeasurement: '6b'.repeat(32),
  minimumCpuMilli: 250,
  policy: { cpuPercent: pinned.record.policy.cpuPercent, vcpus: pinned.record.policy.vcpus },
};
const cpuProfile = { runtimeId: 'ab'.repeat(32), secretsV1: true, configBundleV5: true, configSocketServer: true };
const nativePolicy = { ...ADMIT, desktop };   // no cpu profile: native-only acceptance
const nativeRow = () => ({ id: ID, owner: '0x' + '44'.repeat(20), runner: EP_ID, appRef: `catalog://${APP}/1`,
  configCid: JSON.stringify({ isolation: { require: 'hyperv-partition-per-app' } }),
  active: true, isPublic: true, cpuMilli: 250, gpuMilli: 750, leaseUntil: Math.floor(Date.now() / 1000) + 3600 });
const nativeVersion = { cid: desktop.controllerCid, memMb: pinned.record.policy.memMiB,
  ports: ['http:8000', ...pinned.record.ports].join(','), approval: 1, yanked: false };
const nativeConfig = JSON.stringify({ egress: 'public-web' });

const VALID = Symbol('valid proof');
function setup({ policy = nativePolicy, row = nativeRow(), version = nativeVersion, config = nativeConfig, bytes = component,
                 proofs = [VALID], verdict = () => ({ ok: true }), custody = null } = {}) {
  const log = [], reads = [], sleeps = [], fetches = [], verifies = [], installs = [];
  const guest = generateKeyPairSync('x25519');
  const handshake = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
  const relayKey = generateKeyPairSync('ed25519').privateKey;
  const state = { row, session: 'session-1' };
  const validProof = () => ({ purpose: 'enclave-shield-secrets/1', id: ID, sealKey: rawPublicOf(guest.publicKey).toString('base64'),
    handshakeSpki: handshake.toString('base64'), doc: { appSha256: 'claimed-by-node' } });
  const hub = {
    shieldSessionId: name => { log.push('session'); return name === HOST ? state.session : null; },
    fetchJson: async (origin, path) => {
      log.push('proof'); fetches.push({ origin, path });
      const p = proofs[Math.min(fetches.length, proofs.length) - 1];
      return p === VALID ? validProof() : typeof p === 'function' ? p(validProof()) : p;
    },
    verifyShieldApp: async (name, input, pol) => { log.push('verify'); verifies.push({ name, input, policy: pol }); return verdict(state, input); },
    request: async (origin, req) => { log.push('install'); installs.push({ origin, ...req }); return { status: 200, body: Buffer.from('{"ok":true}') }; },
  };
  const deps = { policy, readCatalog: async () => ({ app: { active: true }, version }),
    readConfig: async () => ({ config, configCid: '' }), fetchVerified: async () => ({ ok: true, bytes }) };
  const deliver = createShieldSecretRelease({ hub, ...deps,
    confirmRow: async id => { log.push('ledger'); return id === ID ? { ...state.row } : null; },
    hostForEndpoint: epId => epId === EP_ID ? { name: HOST, mode: 'hv-node' } : null,
    custodyRefusal: async () => { log.push('custody'); return custody; },
    signingKey: () => relayKey,
    sleep: async ms => { sleeps.push(ms); } });
  const ctx = { operatorOfEndpoint: async ep => ep === ENDPOINT ? operator.address : null,
    endpointIdOf: async ep => ep === ENDPOINT ? EP_ID : null };
  const read = id => { log.push('read'); reads.push(id); return { env: { ...SECRETS }, rev: 7 }; };
  const request = async ({ signer = operator, signedTs } = {}) => {
    const ts = Math.floor(Date.now() / 1000);
    return { id: ID, endpoint: ENDPOINT, ts, opSig: await signer.signMessage({ message: secretRequestMessage(ID, ENDPOINT, signedTs ?? ts) }) };
  };
  return { deliver: b => deliver(b, ctx, read), request, deps, guest, handshake, relayKey, state,
    log, reads, sleeps, fetches, verifies, installs };
}
const nonceOf = path => /[?&]nonce=([0-9a-f]{64})$/.exec(path)?.[1];

// Refused before any secret is read or any install is sent. `status` null: a plain expectation error (no HTTP status).
async function refused(h, status, pattern, body) {
  await assert.rejects(h.deliver(body ?? await h.request()),
    e => (status === null ? e.status === undefined : e.status === status) && pattern.test(e.message));
  assert.equal(h.reads.length, 0, 'secrets were read');
  assert.equal(h.installs.length, 0, 'an install was sent');
}

test('the vectors carry the pins this release is built from', () => {
  assert.deepEqual(pinned.record.policy, { cpuPercent: 800, memMiB: 16384, vcpus: 8 });
  assert.deepEqual(pinned.record.ports, ['tcp:47984', 'tcp:47989', 'tcp:48010', 'udp:47998', 'udp:47999', 'udp:48000']);
  assert.equal(pinned.record.http, 8000);
  assert.notEqual(desktop.igvmSha256, desktop.launchMeasurement);
});

test('approved native delivery: secrets read only after every check, sealed to the guest and signed by the relay', async () => {
  const h = setup();
  const expected = await expectedShieldApp(nativeRow(), { ...h.deps, secretsRequired: true });
  const result = await h.deliver(await h.request());

  // order: authorization, proof, (fake) verification, final ledger and session recheck, THEN the read, then the install
  assert.deepEqual(h.log, ['session', 'ledger', 'custody', 'proof', 'verify', 'ledger', 'session', 'read', 'install']);
  assert.deepEqual(h.reads, [ID]);
  assert.deepEqual(result, { ok: true, id: ID, appId: expected.appSha256, rev: 7, count: 1 });

  // what reached the (fake) hub: the relay's own native expectation, never the node's claim
  const [{ name, input, policy }] = h.verifies;
  assert.equal(name, HOST);
  assert.equal(policy, nativePolicy);
  assert.match(input.expectedAppSha256, /^[0-9a-f]{64}$/);
  assert.equal(input.expectedAppSha256, expected.appSha256);
  assert.notEqual(input.expectedAppSha256, 'claimed-by-node');
  assert.equal(input.expectedRuntimeId, pinned.record.runtimeId);
  assert.equal(input.requiresDesktop, true);
  assert.equal(input.requiresSecretsV1, true);
  assert.equal(input.requiresConfigBundleV5, true);
  assert.equal(input.requiresConfigSocketServer, true);
  assert.ok(input.handshakeSpki.equals(h.handshake));
  const sealKey = rawPublicOf(h.guest.publicKey);
  assert.equal(input.shieldRelease.purpose, 'enclave-shield-secrets/1');
  assert.equal(input.shieldRelease.id, ID);
  assert.ok(input.shieldRelease.sealKey.equals(sealKey));
  assert.equal(input.nonce.toString('hex'), nonceOf(h.fetches[0].path));
  assert.equal(h.fetches[0].origin, `tunnel://${HOST}`);

  // the install: ciphertext only, under the same nonce
  const [install] = h.installs;
  assert.equal(install.origin, `tunnel://${HOST}`);
  assert.equal(install.method, 'POST');
  assert.equal(install.path, '/v1/shield/secret-install');
  const text = install.body.toString(), body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ['id', 'keyId', 'nonce', 'sealed', 'sig']);
  assert.equal(body.id, ID);
  assert.equal(body.nonce, input.nonce.toString('hex'));
  const sealed = Buffer.from(body.sealed, 'base64'), ticket = Buffer.from(body.nonce, 'hex');
  assert.ok(!text.includes(SECRETS.API_TOKEN) && !sealed.includes(SECRETS.API_TOKEN));

  // opens with the intended guest key, nonce and deployment only
  const opened = JSON.parse(openRelease({ id: ID, ticket, sealPrivateKey: h.guest.privateKey, sealed }).toString());
  assert.equal(opened.id, ID);
  assert.deepEqual(opened.secrets, SECRETS);
  assert.throws(() => openRelease({ id: ID, ticket, sealPrivateKey: generateKeyPairSync('x25519').privateKey, sealed }));
  assert.throws(() => openRelease({ id: ID, ticket: randomBytes(32), sealPrivateKey: h.guest.privateKey, sealed }));
  assert.throws(() => openRelease({ id: '0x' + '34'.repeat(32), ticket, sealPrivateKey: h.guest.privateKey, sealed }));

  // the relay's Ed25519 signature over exactly these fields
  const publicKey = ed25519RawPublic(h.relayKey), sig = Buffer.from(body.sig, 'base64');
  assert.equal(body.keyId, keyIdOf(publicKey));
  assert.equal(verifyResponse({ publicKey, sig, id: ID, ticket, sealKey, sealed }), true);
  assert.equal(verifyResponse({ publicKey: ed25519RawPublic(generateKeyPairSync('ed25519').privateKey), sig, id: ID, ticket, sealKey, sealed }), false);
  assert.equal(verifyResponse({ publicKey, sig, id: ID, ticket, sealKey, sealed: Buffer.concat([sealed, Buffer.from([0])]) }), false);
  assert.equal(verifyResponse({ publicKey, sig, id: ID, ticket: randomBytes(32), sealKey, sealed }), false);
});

test('a replayed request is refused without a second read or install', async () => {
  const h = setup(), body = await h.request();
  assert.equal((await h.deliver(body)).ok, true);
  await assert.rejects(h.deliver(body), e => e.status === 409 && /replayed/.test(e.message));
  assert.equal(h.reads.length, 1);
  assert.equal(h.installs.length, 1);
});

test('a bad operator signature never reaches a read or install', async () => {
  const h = setup();
  await refused(h, 403, /operator signature refused/, await h.request({ signer: stranger }));
  await refused(h, 403, /operator signature refused/, await h.request({ signedTs: Math.floor(Date.now() / 1000) - 1 }));
  await refused(h, 403, /operator signature refused/, { ...(await h.request()), opSig: '0x1234' });
  assert.equal(h.fetches.length, 0);
});

test('lease and custody refusals never reach a read or install', async () => {
  await refused(setup({ row: { ...nativeRow(), runner: '0x' + 'bb'.repeat(32) } }), 403, /not public work leased/);
  await refused(setup({ row: { ...nativeRow(), leaseUntil: Math.floor(Date.now() / 1000) - 1 } }), 403, /not public work leased/);
  await refused(setup({ row: { ...nativeRow(), active: false } }), 403, /not public work leased/);
  const h = setup({ custody: 'the owner has not promoted this record' });
  await refused(h, 403, /not promoted/);
  assert.equal(h.fetches.length, 0);
});

test('an unapproved controller CID, hash, version or public configuration never reaches a read or install', async () => {
  const other = 'QmZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
  for (const [h, pattern] of [
    [setup({ version: { ...nativeVersion, cid: other } }), /no admitted runtime/],
    [setup({ version: { ...nativeVersion, approval: 0 } }), /not approved/],
    [setup({ version: { ...nativeVersion, yanked: true } }), /yanked/],
    [setup({ bytes: Buffer.concat([component.subarray(0, 8), Buffer.from('tampered-controller')]) }), /approved release hash/],
    [setup({ policy: { ...ADMIT, desktop: { ...desktop, controllerSha256: 'cc'.repeat(32) } } }), /approved release hash/],
    [setup({ config: JSON.stringify({ egress: 'public-web', volumes: ['data'] }) }), /admits no volumes/],
    [setup({ config: '{}' }), /egress public-web/],
  ]) {
    await refused(h, null, pattern);
    assert.equal(h.fetches.length, 0);
  }
});

test('without an approved native release, a native workload gets no sealed secrets', async () => {
  // no desktop and no CPU secrets profile: release is off altogether
  await refused(setup({ policy: { ...ADMIT } }), 503, /disabled/);
  // a CPU secrets profile does not admit the native workload in place of the desktop release
  const h = setup({ policy: { ...ADMIT, cpu: cpuProfile, gpu: { runtimeId: 'cd'.repeat(32), model: MODEL } } });
  await refused(h, null, /sealed secrets are not supported/);
  assert.equal(h.fetches.length, 0);
});

test('an inference GPU workload gets no sealed secrets', async () => {
  const h = setup({ policy: { ...nativePolicy, cpu: cpuProfile, gpu: { runtimeId: 'cd'.repeat(32), model: MODEL } },
    row: { ...nativeRow(), cpuMilli: 250, gpuMilli: 500 },
    version: { cid: 'Qm' + 'c'.repeat(44), memMb: 8192, ports: '', approval: 1, yanked: false },
    config: JSON.stringify({ volumes: [MODEL] }) });
  await refused(h, null, /sealed secrets are not supported/);
  assert.equal(h.fetches.length, 0);
});

test('a bad or missing proof never reaches a read or install', async () => {
  for (const bad of [null, p => ({ ...p, purpose: 'enclave-shield-evidence/1' }), p => ({ ...p, id: '0x' + '34'.repeat(32) }),
                     p => ({ ...p, sealKey: undefined }), p => ({ ...p, handshakeSpki: 'A'.repeat(5501) })]) {
    const h = setup({ proofs: [bad] });
    await refused(h, 503, /no bounded secret-release proof/);
    assert.equal(h.fetches.length, 3);
    assert.equal(h.verifies.length, 0);
  }
  // 44 base64 characters that decode to 31 bytes
  const h = setup({ proofs: [p => ({ ...p, sealKey: randomBytes(31).toString('base64') })] });
  await refused(h, 403, /invalid guest seal key/);
  assert.equal(h.verifies.length, 0);
});

test('a refused or absent verdict never reaches a read or install', async () => {
  await refused(setup({ verdict: () => ({ ok: false, reason: 'test refusal' }) }), 403, /guest release proof refused: test refusal/);
  await refused(setup({ verdict: () => undefined }), 403, /no verdict/);
});

test('a ledger or session change after verification never reaches a read or install', async () => {
  for (const change of [
    s => { s.row = { ...s.row, cpuMilli: 500 }; },
    s => { s.row = { ...s.row, configCid: JSON.stringify({}) }; },
    s => { s.row = { ...s.row, runner: '0x' + 'bb'.repeat(32) }; },
    s => { s.row = { ...s.row, leaseUntil: Math.floor(Date.now() / 1000) - 1 }; },
    s => { s.session = 'session-2'; },
  ]) {
    const h = setup({ verdict: s => { change(s); return { ok: true }; } });
    await refused(h, 403, /changed during release/);
    assert.equal(h.verifies.length, 1);
  }
});

test('busy proofs are retried with the same nonce and secrets are read once', async () => {
  const h = setup({ proofs: [null, { error: 'busy' }, VALID] });
  assert.equal((await h.deliver(await h.request())).ok, true);
  assert.equal(h.fetches.length, 3);
  const nonces = new Set(h.fetches.map(f => nonceOf(f.path)));
  assert.equal(nonces.size, 1);
  assert.equal(h.verifies[0].input.nonce.toString('hex'), [...nonces][0]);
  assert.equal(h.sleeps.length, 2);
  assert.ok(h.sleeps.every(ms => ms >= 1500 && ms < 4000));
  assert.equal(h.verifies.length, 1);
  assert.deepEqual(h.reads, [ID]);
  assert.equal(h.installs.length, 1);
});

test('CPU V6 sealed delivery remains supported beside the native release', async () => {
  const policy = { ...nativePolicy, cpu: cpuProfile };
  const row = { ...nativeRow(), cpuMilli: 100, gpuMilli: 0 };
  const h = setup({ policy, row, config: '',
    version: { cid: 'Qm' + 'b'.repeat(44), memMb: 128, ports: 'http:8080', approval: 1, yanked: false } });
  const expected = await expectedShieldApp(row, { ...h.deps, secretsRequired: true });
  const result = await h.deliver(await h.request());
  assert.equal(result.ok, true);
  assert.equal(result.appId, expected.appSha256);

  const [{ input }] = h.verifies;
  assert.equal(input.expectedAppSha256, expected.appSha256);
  assert.equal(input.expectedRuntimeId, cpuProfile.runtimeId);
  assert.equal('requiresDesktop' in input, false);
  assert.equal(input.requiresSecretsV1, true);
  assert.equal(input.requiresConfigBundleV5, true);
  assert.equal(input.requiresConfigSocketServer, true);

  const body = JSON.parse(h.installs[0].body.toString());
  const opened = JSON.parse(openRelease({ id: ID, ticket: Buffer.from(body.nonce, 'hex'),
    sealPrivateKey: h.guest.privateKey, sealed: Buffer.from(body.sealed, 'base64') }).toString());
  assert.deepEqual(opened.secrets, SECRETS);
  assert.deepEqual(h.reads, [ID]);
});
