// Execute the actual main.mjs with local fixture files and injected host/worker boundaries: no PowerShell, listener,
// production service or VM. Ported from the installed-host qualification
// (windows/compat/native-desktop-control-installed-20261025/qualification/.../entrypoint.test.mjs) to this entry point's
// own router (shield-profile.mjs ImageLauncher, which replaces the installed desktop-router.mjs). Wiring tests, not
// hardware evidence.
//
// main.mjs is evaluated as a vm module, which needs --experimental-vm-modules. Run plainly (`node --test <this file>`),
// this file re-runs itself once with that flag and reports the child's result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from './derive.mjs';
import { runtimeId } from '../../../isolation/contract/runtime.mjs';
import { DESKTOP_DERIVATION } from './desktop-derive.mjs';
import { notesFor, markerFor, DEFAULT_VM_PREFIX } from './wmi-launcher.mjs';

if (typeof vm.SourceTextModule !== 'function') {
  test('entry point (re-run with --experimental-vm-modules)', () => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '--test', fileURLToPath(import.meta.url)],
      { env, encoding: 'utf8', timeout: 100_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-6000));
    assert.match(r.stdout, /# fail 0/);
  });
} else {

async function boot(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-entry-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const exe = path.join(dir, 'fixture.exe'); fs.writeFileSync(exe, 'non-executable fixture');
  const pin = sha256Hex(fs.readFileSync(exe));
  const runtime = { name: 'wasmtime', version: 'test', execution: 'jit', hostIsa: 'x86_64', targetIsa: 'x86_64', cpuFeatures: 'baseline', wx: 'enforced', cache: 'none' };
  const profileText = fs.readFileSync(new URL('./testdata/desktop-platform/profile.json', import.meta.url), 'utf8'), p = JSON.parse(profileText);
  const platform = { igvmSha256: 'f'.repeat(64), runtimeId: runtimeId(runtime).toString('hex'), profileText, profileSha256: sha256Hex(Buffer.from(profileText)),
    media: [['root', p.root.imageBytes, p.root.imageSha256], ['hashes', p.root.hashBytes, p.root.hashSha256], ['models', p.models.imageBytes, p.models.imageSha256]]
      .map(([role, payloadBytes, payloadSha256], i) => ({ role, path: `C:\\media\\${role}.iso`, bytes: payloadBytes + 65536, sha256: String(i + 1).repeat(64), payloadBytes, payloadSha256, payloadOffset: 65536 })) };
  const cfg = { imagePath: 'C:\\native\\igvm.bin', platform, runtime, bridge: { exe, sha256: pin }, workerPort: 19595, workerBudgetGb: 12 };
  const configPath = path.join(dir, 'desktop.json'); fs.writeFileSync(configPath, JSON.stringify(cfg));
  const gpuPath = path.join(dir, 'gpu.json'); fs.writeFileSync(gpuPath, JSON.stringify({ runtime, imagePath: 'gpu.bin', imageSha256: 'b'.repeat(64), bridgeExe: exe, bridgeSha256: pin }));
  const env = { ENCLAVE_GUEST_IGVM: 'legacy.bin', ENCLAVE_GUEST_IGVM_SHA256: 'a'.repeat(64), ENCLAVE_BOOT_FORM: 'linux-direct', ENCLAVE_GUEST_CPU_ALLOWANCE: '1',
    ENCLAVE_WMISERVE_EXE: exe, ENCLAVE_WMISERVE_EXE_SHA256: pin, ENCLAVE_BUNDLE_DIR: dir, ENCLAVE_EGRESS_V1: '1', NODE_APP_RAM_GB: '32', NODE_VM_RAM_GB: '48', NODE_VCPUS: '16',
    ENCLAVE_CONFIG_BUNDLE_V5: '1', ENCLAVE_SECRETS_V1: '1', ENCLAVE_CONFIG_SOCKET_SERVER_V1: '1', ENCLAVE_PROTECTED_PORTS_V1: '1',
    ENCLAVE_DESKTOP_CONFIG: configPath, ENCLAVE_DESKTOP_CONFIG_SHA256: sha256Hex(fs.readFileSync(configPath)), ENCLAVE_PARTITION_LOG_DIR: 'off', ENCLAVE_LIVENESS_MS: '0', ENCLAVE_ANSWER_CHECK_MS: '0',
    ...(over.gpu ? { ENCLAVE_SHIELD_PROFILE: gpuPath } : {}), ...(typeof over.env === 'function' ? over.env({ dir, runtime }) : over.env ?? {}) };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const launches = [], events = [], logs = []; let manager;
  class FakeLauncher {
    constructor(options) {
      this.options = options; this.desktopPlatform = options.desktopPlatform ?? null; this.boundary = 'host-trusted';
      // what the router (ImageLauncher) reads of a real launcher: its role and the inventory/cleanup scope it shares
      if (options.imageRole !== undefined) this.imageRole = options.imageRole;
      this.prefix = options.prefix; this.marker = markerFor(options.prefix);
      this.guestStateRunDir = options.guestStateRunDir ?? null; this.guestStateArchiveDir = options.guestStateArchiveDir ?? null;
      launches.push(this);
    }
    async verifyImage() { events.push(['verify', this.options.imagePath]); if (over.imageFailure && this.desktopPlatform) throw Error('native image differs'); }
    async preflight() { return { ok: true, checks: [], hostLogicalProcessors: over.logicalProcessors ?? 16 }; }
    async survey() { events.push(['survey', this.options.imagePath]); return { vms: over.vms ?? [] }; }
    async start(mapping, opts) { events.push(['start', this.options.imagePath]); return { mapping, opts }; }
    async stop(handle) { events.push(['stop', this.options.imagePath, handle]); return { stopped: true, removed: true }; }
  }
  const context = vm.createContext({ process: { env, exit(code) { throw Error('EXIT ' + code); } }, console: { log: s => logs.push(s), error: s => logs.push(s) }, Buffer,
    setInterval: () => ({ unref() {} }), clearInterval() {} });
  const url = new URL('./main.mjs', import.meta.url);
  const main = new vm.SourceTextModule(fs.readFileSync(url, 'utf8'), { context, identifier: url.href, initializeImportMeta(meta) { meta.url = url.href; } });
  await main.link(async spec => {
    const resolved = spec.startsWith('.') ? new URL(spec, url).href : spec;
    const actual = await import(resolved), exports = { ...actual };
    if (spec === './wmi-launcher.mjs') exports.WmiHyperVLauncher = FakeLauncher;
    if (spec === './psrun.mjs') exports.powershellRunner = () => () => { throw Error('host calls prohibited'); };
    // Transfer configuration data from the isolated VM realm to the real Manager realm; production main and Manager
    // share a realm. Callbacks stay intact.
    if (spec === './server.mjs') exports.Manager = class extends actual.Manager {
      constructor(opts) { super({ ...opts, images: structuredClone(opts.images) }); }
    };
    if (spec === './server.mjs') exports.createServer = m => { manager = m; return { listen(port, host, cb) { events.push(['listen', host, port]); cb(); } }; };
    if (spec === './desktop-config.mjs') exports.probeDesktopWorker = async () => { if (over.workerFailure) throw Error('worker unavailable'); return { protocol: '1,4,0', vramBudgetGb: 12 }; };
    if (spec === './shield-profile.mjs') exports.probeWorker = async () => ({ protocol: '1,4,0', vramBudgetGb: 12 });
    if (spec === './desktop-worker-transport.mjs') exports.startDesktopWorkerTransport = async args => { events.push(['worker', args]); return { fixture: true }; };
    if (spec === './egress.mjs') {
      exports.egressConfigFromEnv = env => env.ENCLAVE_EGRESS_V1 === '1' ? { mode: 'fixture', exe, sha256: pin, bridgeExe: exe, bridgeSha256: pin } : null;
      exports.checkPin = () => pin;
      exports.startEgress = async args => { events.push(['egress', args]); return { fixture: true }; };
    }
    return new vm.SyntheticModule(Object.keys(exports), function () { for (const [k, v] of Object.entries(exports)) this.setExport(k, v); }, { context });
  });
  let error; try { await main.evaluate(); } catch (e) { error = e; }
  return { manager, launches, events, logs, error, cfg, dir };
}

test('actual entry point wires separate native image, purchased quota, worker and egress', async t => {
  const h = await boot(t); assert.equal(h.error, undefined, h.logs.join('\n')); assert.equal(h.launches.length, 2);
  const m = h.manager, n = h.launches[1], health = m.health(); assert.equal(m.cpuPoolVcpus, 16); assert.equal(m.physicalRamPoolMiB, 49152);
  assert.equal(n.options.imageRole, 'desktop'); assert.equal(n.options.guestCpuAllowance, true); assert.equal(n.options.imageSha256, h.cfg.platform.igvmSha256);
  assert.equal(n.options.medium, null); assert.equal(n.options.boot, 'linux-direct'); assert.equal(health.supports.desktop, true);
  assert.ok(health.catalog.derivations.includes(DESKTOP_DERIVATION));
  const mapping = { record: { derivation: DESKTOP_DERIVATION } };
  await n.options.startTransport('test-vm', mapping); await n.options.startEgress('test-vm', 'test-deployment', mapping);
  const worker = h.events.find(x => x[0] === 'worker')[1]; assert.equal(worker.mapping, mapping); assert.equal(worker.runtimeId, h.cfg.platform.runtimeId); assert.equal(worker.workerPort, 19595);
  assert.equal(h.events.find(x => x[0] === 'egress')[1].deploymentId, 'test-deployment');
  // the ordinary (legacy) launcher's egress hook stays scoped to secret and desktop derivations
  assert.equal(await h.launches[0].options.startEgress('vm', 'd', { record: { derivation: 'enclave-catalog-bundle/1' } }), null);
});
test('actual entry point retains all three launch lanes when inference is configured', async t => {
  const h = await boot(t, { gpu: true }); assert.equal(h.error, undefined, h.logs.join('\n')); assert.equal(h.launches.length, 3);
  for (const record of [{ derivation: 7 }, { derivation: 4, inference: {} }, { derivation: DESKTOP_DERIVATION, desktop: {} }]) await h.manager.backend.start({ record }, {});
  assert.deepEqual(h.events.filter(x => x[0] === 'start').map(x => x[1]), ['legacy.bin', 'gpu.bin', 'C:\\native\\igvm.bin']);
  assert.equal(h.launches[0].options.guestCpuAllowance, true); assert.equal(h.launches[1].options.guestCpuAllowance, false); assert.equal(h.launches[2].options.guestCpuAllowance, true);
  assert.equal(h.launches[1].options.imageRole, 'gpu'); assert.equal(h.launches[1].options.startEgress, null);
  // a desktop-derivation mapping that lost its desktop record starts on no image at all
  await assert.rejects(h.manager.backend.start({ record: { derivation: DESKTOP_DERIVATION } }, {}), /never started on another image/);
  assert.equal(h.events.filter(x => x[0] === 'start').length, 3);
});
test('actual entry point without desktop configuration retains ordinary launch availability', async t => {
  const h = await boot(t, { env: { ENCLAVE_DESKTOP_CONFIG: '', ENCLAVE_DESKTOP_CONFIG_SHA256: '' } });
  assert.equal(h.error, undefined); assert.equal(h.launches.length, 1); assert.equal(h.manager.health().canStart, true); assert.equal(h.manager.desktopReady, false);
});
test('worker failure disables native admission while ordinary manager remains available', async t => {
  const h = await boot(t, { workerFailure: true }); assert.equal(h.error, undefined); assert.equal(h.manager.health().canStart, true); assert.equal(h.manager.desktopReady, false);
  assert.ok(!h.manager.health().catalog.derivations.includes(DESKTOP_DERIVATION));
});
test('partial native configuration fails before the manager listens', async t => {
  for (const env of [{ ENCLAVE_DESKTOP_CONFIG_SHA256: '' }, { ENCLAVE_DESKTOP_CONFIG_SHA256: '0'.repeat(64) }, { NODE_VM_RAM_GB: '' }, { ENCLAVE_PROTECTED_PORTS_V1: '0' }, { ENCLAVE_EGRESS_V1: '0' }, { NODE_VCPUS: '17' }]) {
    const h = await boot(t, { env });
    if (env.NODE_VCPUS) { assert.equal(h.error, undefined); assert.equal(h.manager.health().canStart, false); assert.equal(h.manager.desktopReady, false); }
    else { assert.match(h.error.message, /EXIT 2/); assert.equal(h.manager, undefined); }
  }
});
test('native image mismatch refuses entry-point startup', async t => {
  const h = await boot(t, { imageFailure: true }); assert.match(h.error.message, /EXIT 2/); assert.equal(h.manager, undefined); assert.ok(h.logs.some(s => s.includes('native image differs')));
});

// THE INSTALLED HOST'S OWN SETTINGS, by name (its shield-config.cmd plus the native desktop environment): no VM scope,
// no native-router pins, no shared physical pool, no NODE_VCPUS. The production prefix and marker follow, and the VMs a
// previous (installed) manager left running are adopted from Notes written in that manager's format.
test('the installed host environment starts in the production VM scope and adopts the previous manager\'s partitions', async t => {
  const id = n => ({ id: 'hv' + String(n).repeat(32), name: '0x' + String(n).repeat(64), instanceId: 'hv' + String(n).repeat(14) + '-' + 'deadbeef', appId: 'ab'.repeat(32) });
  const vm = (n, role) => ({ vmId: `${String(n).repeat(8)}-1111-2222-3333-444444444444`, name: DEFAULT_VM_PREFIX + id(n).instanceId, state: 'Running',
    notes: notesFor({ ...id(n), ...(role ? { imageRole: role } : {}) }) });
  const vms = [vm(1), vm(2), vm(3, 'desktop')];
  const h = await boot(t, { gpu: true, vms, logicalProcessors: os.cpus().length, env: ({ dir, runtime }) => {
    const identity = path.join(dir, 'runtime.json'); fs.writeFileSync(identity, JSON.stringify(runtime));
    return { NODE_VCPUS: undefined, NODE_APP_RAM_GB: '96', NODE_VM_RAM_GB: '83', VMMGR_PORT: '8091',
      ENCLAVE_GUEST_STATE_MASTER: 'C:\\ProgramData\\Enclave\\shield\\type1.vmgs', ENCLAVE_GUEST_STATE_MASTER_SHA256: 'e'.repeat(64),
      ENCLAVE_GUEST_STATE_ARCHIVE_DIR: 'C:\\ProgramData\\Enclave\\shield\\vmgs-archive', ENCLAVE_HYPERV_MODULE: 'C:\\guest\\hyperv.psm1', ENCLAVE_HYPERV_MODULE_SHA256: '1'.repeat(64),
      ENCLAVE_RUNTIME_IDENTITY: identity, PYTHON_BIN: 'python', IPFS_GATEWAY: 'https://ipfs.invalid',
      ENCLAVE_EGRESS_EXE: 'x', ENCLAVE_EGRESS_EXE_SHA256: '2'.repeat(64), ENCLAVE_EGRESS_BRIDGE_EXE: 'y', ENCLAVE_EGRESS_BRIDGE_EXE_SHA256: '3'.repeat(64),
      ENCLAVE_EGRESS_APP_ROUTES: 'routes.json', ENCLAVE_EGRESS_BLOB_SERVICE: '127.0.0.1:9621', ENCLAVE_WASM_SET: '1', ENCLAVE_WASM_MEMORY64: '1' };
  } });
  assert.equal(h.error, undefined, h.logs.join('\n')); assert.equal(h.launches.length, 3);
  const m = h.manager, health = m.health();
  assert.deepEqual(h.events.find(x => x[0] === 'listen'), ['listen', '127.0.0.1', 8091]);
  for (const l of h.launches) assert.equal(l.options.prefix, DEFAULT_VM_PREFIX);
  assert.equal(m.backend.prefix, DEFAULT_VM_PREFIX); assert.equal(m.backend.marker, markerFor());
  assert.equal(health.instanceNamespace, null); assert.equal(health.sharedPhysicalPool, null); assert.deepEqual(health.vmScope, { prefix: DEFAULT_VM_PREFIX, marker: markerFor() });
  assert.equal(m.cpuPoolVcpus, os.cpus().length); assert.equal(m.cpuPoolSource, 'os.cpus'); assert.equal(m.ramPoolMiB, 96 * 1024); assert.equal(m.physicalRamPoolMiB, 83 * 1024);
  assert.equal(health.canStart, true); assert.equal(health.supports.desktop, true); assert.equal(health.supports.set, true); assert.equal(health.supports.mem64, true);
  // adopted, not removed: one survey of the shared inventory, three recovered records, no stop
  assert.deepEqual(m.inventory.state, 'ready'); assert.equal(m.inventory.recovered, 3); assert.equal(m.inventory.unattributed, 0);
  assert.equal(h.events.filter(x => x[0] === 'stop').length, 0);
  assert.deepEqual(h.events.filter(x => x[0] === 'survey').map(x => x[1]), ['legacy.bin']);
  assert.deepEqual(vms.map((_, i) => m.domains.get(id(i + 1).id)?.imageRole), ['legacy', 'legacy', 'desktop']);
  for (const r of m.domains.values()) { assert.equal(r.recovered, true); assert.equal(r.status, 'starting'); assert.equal(r.appReady, false); }
  // their allocations are not in their Notes: every pool reads unknown and new admission stays closed until reconciled
  assert.equal(health.memory.known, false); assert.equal(health.memory.freeMiB, null); assert.equal(health.cpu.allocatedUnits, null);
  assert.equal(health.allocation.known, false); assert.equal(health.allocation.unknown.length, 3);
  // reconciling one (the node's DELETE) removes exactly that VM, by its Id, through the shared inventory launcher
  assert.deepEqual(await m.remove(id(3).id), { removed: true, absent: false });
  const stops = h.events.filter(x => x[0] === 'stop');
  assert.equal(stops.length, 1); assert.equal(stops[0][1], 'legacy.bin'); assert.equal(stops[0][2].vmId, vms[2].vmId); assert.equal(stops[0][2].recovered, true);
  assert.equal(m.domains.size, 2);
});

}
