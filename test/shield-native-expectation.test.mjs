import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expectedShieldApp, createShieldAppVerifier } from '../relay/shield-app-verifier.mjs';
import { admittedImages } from '../relay/shield-app-fresh.mjs';
import { shieldImageCandidates } from '../relay/shield-app-policy.mjs';
import { deriveApprovedDesktop } from '../relay/shield-desktop-release.mjs';
import { isolationPlan, BACKEND } from '../windows/vbslike/datapath/node-bridge.mjs';
import { createShieldMarketplace } from '../relay/shield-marketplace.mjs';

const vectors = JSON.parse(readFileSync(new URL('../isolation/contract/catalog/desktop_vectors.json', import.meta.url)));
const base = vectors.ok.find(v => v.name === 'baseline');
const component = Buffer.from(vectors.component_hex, 'hex');
const config = { egress: 'public-web', codec: 'h264', _media: { poster: 'store-only' } };
const release = { schema: 'enclave-desktop-release/1', controllerCid: base.record.cid,
  controllerSha256: base.mapping.componentSha256, runtimeId: base.record.runtimeId,
  igvmSha256: '55'.repeat(32), profileSha256: base.record.desktop.profileSha256,
  launchMeasurement: '66'.repeat(32), minimumCpuMilli: 250, policy: { cpuPercent: 800, vcpus: 8 } };
const version = { cid: release.controllerCid, memMb: 16384, ports: ['http:8000', ...base.record.ports].join(','), approval: 1, yanked: false };
const row = { id: base.record.secretDeployment, appRef: `catalog://${base.record.catalog.app}/1`,
  cpuMilli: 500, gpuMilli: 750, isPublic: true, configCid: JSON.stringify({ isolation: { require: BACKEND } }) };
const nativeImage = { measurement: release.launchMeasurement, runtimeId: release.runtimeId,
  igvmSha256: release.igvmSha256, profileSha256: release.profileSha256, controllerSha256: release.controllerSha256,
  nativeDesktop: true, configBundleV5: true, secretsV1: true, configSocketServer: true, protectedPorts: true };
function deps() {
  return { policy: { desktop: structuredClone(release), images: [structuredClone(nativeImage)] }, secretsRequired: true,
    readCatalog: async () => ({ app: { active: true }, version: { ...version } }),
    readConfig: async () => ({ config, configCid: '' }),
    fetchVerified: async cid => ({ ok: cid === release.controllerCid, bytes: component }) };
}

test('node purchase plan and independent relay catalog expectation name the same native app', async () => {
  const d = deps(), expected = await expectedShieldApp(row, d);
  const plan = isolationPlan({ deploymentId: row.id, deployment: row,
    version: { ...version, appId: base.record.catalog.app, index: 1 }, appConfig: config,
    desktopRelease: release, hasSecrets: true, waf: {}, volumes: [], appConfigCid: '', require: BACKEND,
    manager: { backend: BACKEND, canStart: true, desktop: { ...release, ready: true },
      supports: { desktop: true, config: true, secrets: true, ports: true },
      catalog: { derivations: [base.record.derivation] } } });
  assert.equal(plan.ok, true, plan.why);
  const mapped = deriveApprovedDesktop({ release, record: plan.spawn.derive, component });
  assert.deepEqual(expected, { appSha256: mapped.appId, runtimeId: release.runtimeId,
    requiresDesktop: true, requiresConfigBundleV5: true, requiresSecretsV1: true, requiresConfigSocketServer: true });
  assert.deepEqual(admittedImages(d.policy, expected), [release.launchMeasurement]);
  for (const patch of [{ id: '0x' + '77'.repeat(32) }, { gpuMilli: 800 },
    { configCid: JSON.stringify({ config: { egress: 'public-web', codec: 'hevc' } }) }])
    assert.notEqual((await expectedShieldApp({ ...row, ...patch }, deps())).appSha256, expected.appSha256);
});

test('native expectation requires independent approval, sealed identity, resource bounds and public configuration', async () => {
  for (const mutate of [d => { delete d.policy.desktop; }, d => { d.secretsRequired = false; },
    d => { d.policy.desktop.controllerSha256 = '99'.repeat(32); },
    d => { d.policy.desktop.controllerCid = 'Qm' + 'a'.repeat(44); },
    d => { d.readCatalog = async () => ({ app: { active: true }, version: { ...version, approval: 0 } }); },
    d => { d.readCatalog = async () => ({ app: { active: true }, version: { ...version, ports: version.ports + ',tcp:22' } }); },
    d => { d.readConfig = async () => ({ config: { egress: 'public-web', volumes: ['model'] } }); },
    d => { d.readConfig = async () => ({ config: {} }); },
    d => { d.fetchVerified = async () => ({ ok: false }); }]) {
    const d = deps(); mutate(d); await assert.rejects(expectedShieldApp(row, d));
  }
  for (const patch of [{ cpuMilli: 249 }, { gpuMilli: 0 }, { gpuMilli: 499 }, { isPublic: false },
    { configCid: JSON.stringify({ waf: { enabled: true } }) }, { id: '0x' + '00'.repeat(32) }])
    await assert.rejects(expectedShieldApp({ ...row, ...patch }, deps()));
});

test('native configuration CIDs are independently verified before measuring exactly the delivered JSON', async () => {
  const cid = 'Qm' + 'a'.repeat(44), d = deps(), seen = [];
  d.readConfig = async () => ({ configCid: cid });
  d.fetchVerified = async (key, max) => { seen.push([key, max]); return { ok: true,
    bytes: key === cid ? Buffer.from(JSON.stringify(config)) : component }; };
  assert.deepEqual(await expectedShieldApp(row, d), await expectedShieldApp(row, deps()));
  assert.deepEqual(seen, [[cid, 1 << 20], [release.controllerCid, 256 << 20]]);
  d.fetchVerified = async () => ({ ok: false });
  await assert.rejects(expectedShieldApp(row, d), /CID-verified/);
});

test('native image admission selects one full approved release and refuses legacy downgrade', () => {
  const expected = { runtimeId: release.runtimeId, requiresDesktop: true };
  const d = deps();
  assert.deepEqual(shieldImageCandidates(d.policy, expected), [nativeImage]);
  for (const key of ['measurement', 'igvmSha256', 'profileSha256', 'controllerSha256', 'runtimeId']) {
    const p = structuredClone(d.policy); p.images[0][key] = '99'.repeat(32);
    assert.deepEqual(admittedImages(p, expected), [], key);
  }
  for (const key of ['nativeDesktop', 'configBundleV5', 'secretsV1', 'configSocketServer', 'protectedPorts']) {
    const p = structuredClone(d.policy); delete p.images[0][key];
    assert.deepEqual(admittedImages(p, expected), [], key);
  }
  assert.deepEqual(admittedImages({ images: [nativeImage] }, expected), []);
  assert.deepEqual(admittedImages(d.policy, { runtimeId: release.runtimeId }), []);
  assert.deepEqual(admittedImages({ images: [nativeImage] }, { runtimeId: release.runtimeId }), []);
  const split = { ...d.policy, images: [{ ...nativeImage, measurement: '77'.repeat(32) },
    { ...nativeImage, controllerSha256: '88'.repeat(32) }] };
  assert.deepEqual(admittedImages(split, expected), []);
});

test('fresh native expectation and required image role reach the certificate verifier', async () => {
  const d = deps(), seen = [];
  const verify = createShieldAppVerifier({ ...d, hasSecrets: () => true, hub: {
    fetchJson: async (_origin, path) => ({ doc: {}, handshakeSpki: Buffer.alloc(44).toString('base64') }),
    verifyShieldApp: (_name, input) => { seen.push(input); return { ok: true }; } } });
  assert.equal((await verify('test-host', row, { csrSpkiSha256: '77'.repeat(32) })).ok, true);
  const expected = await expectedShieldApp(row, deps());
  assert.equal(seen[0].requiresDesktop, true);
  assert.equal(seen[0].expectedAppSha256, expected.appSha256);
  assert.equal(seen[0].expectedCsrSpkiSha256, '77'.repeat(32));
});

test('market routing accepts verified native secret work without enabling CPU or inference secrets', async () => {
  const d = deps(), host = { name: 'native-test', mode: 'hv-node', id: '0x' + '88'.repeat(32) };
  const leased = { ...row, runner: host.id, active: true, leaseUntil: Math.floor(Date.now() / 1000) + 3600 };
  let session = 'test-session', verified = 0;
  const market = createShieldMarketplace({ ...d,
    policy: { ...d.policy, schema: 'enclave-shield-app-policy/1', hosts: [host.name], ekRoots: 'synthetic',
      marketEnabled: true, cpu: { runtimeId: '77'.repeat(32) } },
    confirmRow: async () => ({ ...leased }), hasSecrets: () => true, log: () => {},
    hub: { shieldSessionId: () => session, notifyShieldMarket: () => {},
      fetchJson: async () => ({ doc: {}, handshakeSpki: Buffer.alloc(44).toString('base64') }),
      verifyShieldApp: (_name, input) => { assert.equal(input.requiresDesktop, true); verified++;
        return { ok: true, spkiSha256: '99'.repeat(32) }; } } });
  assert.equal((await market.certificate(host, leased, '99'.repeat(32))).ok, true);
  assert.equal(verified, 1);
  assert.ok(market.servesUntil(host, leased) > Date.now() / 1000);
  leased.gpuMilli = 0;
  assert.equal((await market.certificate(host, leased, '99'.repeat(32))).ok, false);
  assert.equal(verified, 1);
  assert.equal(market.servesUntil(host, leased), 0);
  leased.gpuMilli = 750;
  assert.equal((await market.certificate(host, leased, '99'.repeat(32))).ok, true);
  session = 'replacement';
  assert.equal(market.servesUntil(host, leased), 0);
});
