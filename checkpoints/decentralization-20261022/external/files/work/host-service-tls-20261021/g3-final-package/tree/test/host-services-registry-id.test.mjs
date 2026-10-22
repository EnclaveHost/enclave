// B7 (cross-component, work/host-service-tls-20261021): every host-services path names THIS host to the platform host policy
// by its REGISTRY id = keccak256 of the endpoint bytes EXACTLY as registered (EnclaveRegistry idOf), never by the legacy
// slash-stripped hostIdOfEndpoint. Real call paths, with only the chain-reading policy runtime / snapshot stubbed:
//   - runner.mjs runHostServices -> the unchanged createHostServiceGate: a host registered as "https://…/" is served when
//     ITS id is admitted and stopped when ITS id is refused, whatever the stripped id's decision is;
//   - stage-tool.mjs health: the gate check judges the same exact id;
//   - stage-tool.mjs capturePublic: reads the registry row of the exact id and reports the endpoint byte for byte;
//   - the legacy helper is unchanged (storage-indexer-host's canonicalization is out of scope and untouched).
//   node --test test/host-services-registry-id.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hostIdOfEndpoint, registryIdOfEndpoint } from '../network/host-service-gate.mjs';
import { runHostServices, validateHostServicesConfig } from '../network/host-services/runner.mjs';
import { health, capturePublic } from '../network/host-services/stage-tool.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = path.join(REPO, 'network/host-services/packages');
const pin = (role) => 'sha256:' + createHash('sha256').update(fs.readFileSync(path.join(PKG, `${role}.package.json`))).digest('hex');
const SLASH = 'https://host-s.example/';                       // registered WITH its trailing slash
const EXACT = registryIdOfEndpoint(SLASH), STRIPPED = hostIdOfEndpoint(SLASH);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b7-registry-id-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const manifest = path.join(tmp, 'manifest.json');
fs.writeFileSync(manifest, JSON.stringify({ verifiedObjects: [] }));
const cfgFor = (endpoint) => ({ format: 'enclave-host-services/v1', host: { endpoint }, platformHostPolicy: 'production', packagesDir: PKG, stateRoot: path.join(tmp, 'state'),
  services: [{ role: 'bootstrap-replica', package: pin('bootstrap-replica'), heapMiB: 64, config: { port: 1, bind: '127.0.0.1', directory: tmp, manifest } }] });

// the chain-reading runtime under the UNCHANGED gate: a decision per registry id, and every id the gate asked about
function runtime(decisions) {
  const asked = [];
  return { asked, status: () => ({ activation: 'anchor', anchor: 'anchored', accepted: null }),
    measured(hostId) {
      asked.push(hostId);
      const d = decisions[hostId] || { serving: false, reason: 'no decision for this id' };
      return { check: async () => d, state: () => ({ ...d }) };
    } };
}
const admitted = { serving: true, status: 'admitted', reason: 'admitted' }, banned = { serving: false, status: 'banned', reason: 'banned by the admin' };
function fakeSpawn() {
  const started = [];
  const spawn = (exe, argv) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 4242 + started.length, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(),
      kill() { child.signalCode = 'SIGTERM'; setImmediate(() => child.emit('exit', null, 'SIGTERM')); } });
    started.push(argv); return child;
  };
  return { spawn, started };
}

test('the legacy helper is unchanged; the registry id differs for a trailing-slash endpoint and equals it otherwise', () => {
  assert.equal(hostIdOfEndpoint(SLASH), hostIdOfEndpoint('https://host-s.example'), 'legacy: slashes stripped (storage-indexer canonical form)');
  assert.notEqual(EXACT, STRIPPED);
  assert.equal(registryIdOfEndpoint('https://host-s.example'), hostIdOfEndpoint('https://host-s.example'));
  assert.equal(validateHostServicesConfig(cfgFor(SLASH)).host.endpoint, SLASH, 'the runner keeps the endpoint byte for byte');
});

test('runner: a slash-registered host is SERVED when its own id is admitted, although the stripped id is banned', async () => {
  const rt = runtime({ [EXACT]: admitted, [STRIPPED]: banned }), sp = fakeSpawn();
  const run = await runHostServices(cfgFor(SLASH), { policyRuntime: rt, spawn: sp.spawn, log: () => {}, intervalMs: 60_000 });
  try {
    assert.deepEqual([...new Set(rt.asked)], [EXACT], 'the gate judges ONLY the registry id');
    assert.equal(sp.started.length, 1, 'the role started');
    assert.equal(run.status().refusal, null);
    assert.equal(run.status().platformHostPolicy.hostId, EXACT);
  } finally { await run.stop(); }
});

test('runner: a slash-registered host is STOPPED when its own id is banned, although the stripped id is admitted', async () => {
  const rt = runtime({ [EXACT]: banned, [STRIPPED]: admitted }), sp = fakeSpawn();
  const run = await runHostServices(cfgFor(SLASH), { policyRuntime: rt, spawn: sp.spawn, log: () => {}, intervalMs: 60_000 });
  try {
    assert.deepEqual([...new Set(rt.asked)], [EXACT]);
    assert.equal(sp.started.length, 0, 'no role starts for a banned host');
    assert.match(run.status().refusal, /banned by the admin/);
  } finally { await run.stop(); }
});

test('stage-tool health: the gate check judges the same exact registry id (both directions)', async () => {
  const file = path.join(tmp, 'host-services.json');
  fs.writeFileSync(file, JSON.stringify(cfgFor(SLASH)));
  const deny = async () => { throw new Error('network denied in this test'); };
  for (const [decisions, ok] of [[{ [EXACT]: admitted, [STRIPPED]: banned }, true], [{ [EXACT]: banned, [STRIPPED]: admitted }, false]]) {
    const rt = runtime(decisions);
    const r = await health({ config: file, fetch: deny, policyRuntime: rt });
    const g = r.checks.find((c) => c.name.startsWith('gate:'));
    assert.equal(g.ok, ok);
    assert.equal(g.detail.hostId, EXACT);
    assert.deepEqual([...new Set(rt.asked)], [EXACT]);
    assert.equal(r.hostEndpoint, SLASH);
  }
});

test('stage-tool capture-public: reads the exact id\'s registry row and reports the endpoint byte for byte', async () => {
  const facts = { owner: '0x' + '11'.repeat(20), ownerIsContract: false, anchorHi: 0n, anchorLo: 0n, registry: '0x' + '22'.repeat(20), block: 1n,
    hosts: { [EXACT]: { endpoint: SLASH, operator: '0x' + '33'.repeat(20), active: true, owner: null },
             [STRIPPED]: { endpoint: 'https://host-s.example', operator: '0x' + '44'.repeat(20), active: false, owner: null } } };
  const out = await capturePublic({ endpoint: SLASH, snapshot: async () => facts });
  assert.equal(out.endpoint, SLASH);
  assert.equal(out.hostId, EXACT);
  assert.deepEqual(out.registryEntry, { endpoint: SLASH, operator: '0x' + '33'.repeat(20), active: true });
});
