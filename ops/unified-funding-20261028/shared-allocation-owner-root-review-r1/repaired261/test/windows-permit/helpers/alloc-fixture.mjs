// shared allocation r1 TEST harness (AUTHORED, NOT RUN). REAL: allocation-owner.mjs over win-durable openOwnedLog, the
// guestd-control/1 allocation service and AllocationClient, installed-source Manager/ProtectedManager/createServer,
// HyperVPartitionBackend and the actual WmiHyperVLauncher.start (its define/start boundaries and cleanup code).
// TEST, and labelled so: the in-process journal exclusion (TEST_inProcessExclusion - NOT Windows share-mode-0), the inert
// PowerShell host below (it answers the launcher's scripts from an in-memory VM table; nothing is Hyper-V), the sampler
// and coverage numbers, and the readiness judge. Nothing here is Windows, Hyper-V, NTFS, commit or native evidence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { initializeOwnedLog, openOwnedLog, TEST_inProcessExclusion } from "../../../control/windows/vbslike/manager/win-durable.mjs";
import { LEDGER_PURPOSE, COVERAGE_TERMS, establishLogDomain, logStore, openAllocationOwner } from "../../../control/windows/vbslike/manager/allocation-owner.mjs";
import { createAllocationService, AllocationClient } from "../../../control/windows/vbslike/manager/allocation-service.mjs";
import { installSharedAllocation } from "../../../control/windows/vbslike/manager/allocation-integration.mjs";
import { Manager, createServer, startManager } from "../../../control/windows/vbslike/manager/server.mjs";
import { ProtectedManager } from "../../../control/windows/vbslike/manager/protected-manager.mjs";
import { HyperVPartitionBackend } from "../../../control/windows/vbslike/manager/backend.mjs";
import { WmiHyperVLauncher, HYPERV_MODULE_SHA256, type1VmMemMiB } from "../../../control/windows/vbslike/manager/wmi-launcher.mjs";
import { vectors, KEY } from "./world.mjs";

export { vectors, LEDGER_PURPOSE, initializeOwnedLog, openOwnedLog, TEST_inProcessExclusion, logStore, openAllocationOwner, AllocationClient, installSharedAllocation };
export const IMG = "ab".repeat(32);
export const DOMAIN = Object.freeze({ id: "test-isolated-alloc-r1", floorMiB: 18432, roles: ["general", "native"], commitReserveMiB: 1024,
  vmCommitOverheadMiB: 256, maxSampleAgeMs: 5000, maxTtlMs: 600_000, isolated: true });
export const COVER = Object.freeze({ physical: Object.fromEntries(COVERAGE_TERMS.map((k) => [k, 1])), commit: Object.fromEntries(COVERAGE_TERMS.map((k) => [k, 1])), source: "TEST" });
export const deployment = (b) => "0x" + b.repeat(32);
export function vmMiB() { const { record } = vectors(); return type1VmMemMiB(record.policy.memMiB, {}); }
/** capacity for exactly `n` partitions of vmMiB() under DOMAIN/COVER (one MiB short of n+1) */
export function capacityFor(n) {
  const v = vmMiB(), cov = COVERAGE_TERMS.length;
  return { phys: DOMAIN.floorMiB + cov + n * v + (v - 1), commit: DOMAIN.commitReserveMiB + cov + n * (v + DOMAIN.vmCommitOverheadMiB) + (v - 1) };
}
export function tmpDir(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "alloc-r1-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

/** The TEST clock both the owner and its sampler read; `advance` moves it forward (expiry tests). */
export function testClock() { let off = 0; const c = () => performance.now() + off; c.advance = (ms) => { off += ms; }; return c; }

/** One owner: TEST-established isolated domain over an owned log, the real service on loopback, a key per role. */
export async function ownerRig(t, { capacity = capacityFor(1), clock = testClock(), dir = tmpDir(t), file = path.join(dir, "allocation.log"), exclusion = TEST_inProcessExclusion(), establish = true } = {}) {
  if (establish) establishLogDomain(file, { domain: DOMAIN, exclusion, platform: "linux" });
  // TEST sampler: the configured capacity minus what the inert hosts (sample.hosts) show Running - i.e. an allocation is
  // visible to a sample only after its VM runs, as the owner's unreflected accounting assumes
  const sample = { phys: capacity.phys, commit: capacity.commit, fail: null, liveFloorMiB: undefined, hosts: [] };
  const sampler = async () => {
    if (sample.fail) throw Error(sample.fail);
    const at = clock();
    const running = sample.hosts.flatMap((h) => [...h.vms.values()]).filter((v) => v.state === "Running");
    const used = running.reduce((n, v) => n + v.memMiB, 0);
    return { availablePhysicalMiB: sample.phys === undefined ? undefined : sample.phys - used,
      availableCommitMiB: sample.commit === undefined ? undefined : sample.commit - used - running.length * DOMAIN.vmCommitOverheadMiB,
      at, source: "TEST", ...(sample.liveFloorMiB !== undefined ? { liveFloorMiB: sample.liveFloorMiB } : {}) };
  };
  const cover = structuredClone(COVER);
  const open = () => openAllocationOwner({ store: logStore(openOwnedLog(file, { purpose: LEDGER_PURPOSE, exclusion, platform: "linux" })), domainId: DOMAIN.id, sampler, coverage: async () => cover, monotonic: clock });
  const keys = { general: crypto.randomBytes(32), native: crypto.randomBytes(32) };
  const rig = { file, dir, exclusion, sample, cover, clock, keys, owner: open(), server: null, url: null,
    async listen() {
      rig.server = createAllocationService(rig.owner, { keys });
      await new Promise((r) => rig.server.listen(0, "127.0.0.1", r));
      rig.url = `http://127.0.0.1:${rig.server.address().port}`;
      t.after(async () => { rig.server.closeAllConnections?.(); await new Promise((r) => rig.server.close(r)); });
    },
    /** owner restart: same ledger file, new incarnation, same service port and keys */
    async restart() {
      await new Promise((r) => { rig.server.closeAllConnections?.(); rig.server.close(r); });
      const port = Number(new URL(rig.url).port);
      rig.owner.close("TEST restart");
      rig.owner = open();
      rig.server = createAllocationService(rig.owner, { keys });
      await new Promise((r) => rig.server.listen(port, "127.0.0.1", r));
    },
    client: (role, key = keys[role]) => new AllocationClient({ url: rig.url, role, key }) };
  t.after(() => { try { rig.owner.close("TEST end"); } catch {} });
  await rig.listen();
  return rig;
}

/**
 * Inert PowerShell host for the REAL WmiHyperVLauncher: it recognises each script the launcher builds and answers from
 * an in-memory VM table. `calls` records each recognised script kind in order. `hold[kind]` (a promise) delays an answer.
 */
export function inertHost() {
  const vms = new Map(), calls = [], hold = {};
  const qv = (s, v) => { const m = new RegExp("\\$" + v + " = '((?:[^']|'')*)';").exec(s); return m ? m[1].replace(/''/g, "'") : null; };
  const guid = (s) => (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(s) || [null])[0];
  const out = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: "" });
  async function run(script) {
    const s = String(script);
    const kind = s.includes("LogicalProcessorCount") ? "preflight" : s.includes("New-CustomVM -VMName") ? "define" : s.includes("@{state=$state; console=") ? "start"
      : s.includes("@{vms=@(") ? "survey" : s.includes("not ours: the ownership marker is absent") ? "removeById" : s.includes("refusing to retire") ? "retire"
      : s.includes("@{present=$true; sha256=(Get-FileHash") ? "imageHash" : s.includes("Remove-VM") ? "removeExact" : "unknown";
    calls.push(kind);
    if (hold[kind]) await hold[kind];
    if (kind === "preflight") return out({ vmms: true, namespace: true, module: true, firmwareField: true, hypervisor: true, firmwareOptIn: { present: true, value: 1, kind: "DWord" },
      hypervModule: { present: true, sha256: HYPERV_MODULE_SHA256 }, guestStateMaster: { present: true, bytes: 1 }, logicalProcessors: 16 });
    if (kind === "imageHash") return out({ present: true, sha256: IMG, bytes: 1 });
    if (kind === "define") {
      const m = /-Memory \((\d+) \* 1MB\) -VpCount (\d+)/.exec(s), notes = /-Notes '((?:[^']|'')*)';/.exec(s)[1].replace(/''/g, "'");
      const id = crypto.randomUUID(), name = qv(s, "name");
      vms.set(id, { vmId: id, name, state: "Off", notes, memMiB: Number(m[1]) });
      return out({ id, name, notes, isolationType: 1, isolationEnabled: true, featureSet: 0x201, vtl2Mode: 0, firmwareFile: qv(s, "fw"), firmwareSha256: IMG,
        hypervModuleSha256: HYPERV_MODULE_SHA256, guestStateFile: qv(s, "gsf"), vbsOptOut: true, nics: 0, com1: qv(s, "pipe"), secureBoot: "Off", disks: 0, dvds: 0,
        vcpus: Number(m[2]), memBytes: Number(m[1]) * 1048576, dynamicMemory: false, automaticStartAction: "Nothing", automaticStopAction: "TurnOff", tpmEnabled: true });
    }
    if (kind === "start") { const v = vms.get(guid(s)); if (v) v.state = "Running"; return out({ state: v ? "Running" : "Off", console: { connected: true, early: true, bytes: 48, head: "MON snp=0 vcpus=1 ready", sawUntil: true } }); }
    if (kind === "survey") return out({ vms: [...vms.values()].map(({ vmId, name, state, notes }) => ({ vmId, name, state, notes })) });
    if (kind === "removeById") { const id = guid(s); return out(vms.delete(id) ? { found: true, removed: true } : { found: false, removed: false }); }
    if (kind === "retire") return out({ present: false, retired: false });
    if (kind === "removeExact") return out({ found: false, removed: false });
    return { code: 1, stdout: "", stderr: "TEST inert host: unrecognised script" };
  }
  return { run, vms, calls, hold, count: (k) => calls.filter((c) => c === k).length };
}

export function wmiLauncher(host, prefix = "enclave-native-") {
  return new WmiHyperVLauncher({ run: host.run, imagePath: "C:\\img\\guest.igvm", imageSha256: IMG, boot: "linux-direct",
    guestStateMaster: "C:\\gs\\master.vmgs", guestStateArchiveDir: "C:\\gs\\archive", hypervModule: "C:\\petri\\hyperv.psm1", prefix });
}

/** One actual manager consumer: Manager (or ProtectedManager) -> HyperVPartitionBackend -> WmiHyperVLauncher -> inert host. */
export async function consumer(t, { role, rig = null, Klass = Manager, install = true, host = inertHost() } = {}) {
  const { record, component } = vectors();
  const launcher = wmiLauncher(host);
  const backend = new HyperVPartitionBackend({ launcher });
  const manager = new Klass({ backend, runtimeId: record.runtimeId, fetchComponent: async () => component, physicalRamPoolMiB: 262144,
    judgeReady: async () => ({ status: "running", transportKeySha256: KEY, checks: { document: { verdict: "TEST" } } }) });
  await startManager(manager);
  const server = createServer(manager);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const c = { role, host, launcher, backend, manager, base, alloc: null, record,
    body: (name, extra = {}) => ({ derive: record, name, isPublic: true, hasSecrets: false, ...extra }),
    async post(name, extra) { const r = await fetch(base + "/vms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c.body(name, extra)), signal: AbortSignal.timeout(10_000) }); return { status: r.status, body: await r.json() }; },
    async del(id) { const r = await fetch(base + "/vms/" + id, { method: "DELETE", signal: AbortSignal.timeout(10_000) }); return { status: r.status, body: await r.json() }; },
    async install() { c.alloc = await installSharedAllocation(manager, { client: rig.client(role), role, wmiLaunchers: [launcher], ttlMs: 60_000 }); return c.alloc; } };
  if (install && rig) await c.install();
  return c;
}
export { ProtectedManager, Manager };
