// permit r1/r2 TEST harness (AUTHORED, NOT RUN). REAL: installed-source Manager/createServer (via ProtectedManager),
// createProtectedServer + guestd-control/1 ControlServer and the supervisor's GuestdControl client, the r18
// DeploymentPermitGate/verifyServingPermit/host-authority code with real secp256k1 typed-data signatures (viem), the
// owned permit journal on win-durable.mjs, the createDataPlane splice listener, and the guard as a REAL SEPARATE
// PROCESS (guard-main.mjs) speaking the real pipe protocol. TEST, and labelled so: the JSON-file "Hyper-V" inventory
// shared by the manager's launcher double and the guard, the launcher/readiness doubles, the in-process journal
// exclusion (not Windows share-mode-0, and NOT cross-process: each guard process gets its own journal file unless a
// test passes one on purpose after killing the previous guard), /proc process identity, and the authority reader
// (qualification "TEST": it hands the gate an assignment/host-authority snapshot instead of a derived-finality read).
// Nothing here is Windows, Hyper-V, NTFS or Base evidence.
// r2: splice(id) uses the app/image/runtime/key identity RETAINED when the instance was first observed live (staged()/
// serve()/an earlier splice), so a splice attempted AFTER legitimate removal still presents the originally
// authenticated identity on an actual new socket and must be denied (root author-run #18/#24 helper defect).
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { hostAuthorityDigest, reporterPolicyDigest } from "../../../control/network/deployment-host-authority.mjs";
import { signServingPermit, servingPermitTypedData } from "../../../control/network/deployment-serving-permit.mjs";
import { hashTypedData } from "viem";
import { HyperVPartitionBackend } from "../../../control/windows/vbslike/manager/backend.mjs";
import { startManager } from "../../../control/windows/vbslike/manager/server.mjs";
import { notesFor } from "../../../control/windows/vbslike/manager/wmi-launcher.mjs";
import { ProtectedManager, createProtectedServer, protectedRoutes } from "../../../control/windows/vbslike/manager/protected-manager.mjs";
import { ControlServer } from "../../../control/windows/vbslike/manager/control.mjs";
import { PermitEnforcement, CONFIG_SCHEMA, STAGE_SCHEMA, ATTACHMENT_SCHEMA, TEST_QUALIFICATION } from "../../../control/windows/vbslike/manager/permit-enforcement.mjs";
import { openOwnedLog, initializeOwnedLog, TEST_inProcessExclusion } from "../../../control/windows/vbslike/manager/win-durable.mjs";
import { openPermitJournal } from "../../../control/windows/vbslike/manager/permit-journal.mjs";
import { GuardClient } from "../../../control/windows/vbslike/guard/guard-client.mjs";
import { GUARD_PURPOSE } from "../../../control/windows/vbslike/guard/guard-core.mjs";
import { dataPlaneFor } from "../../../control/windows/vbslike/datapath/node-bridge.mjs";
import { GuestdControl } from "../../../control/isolation/m4/guestd/control-client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GUARD_MAIN = path.resolve(HERE, "../../../control/windows/vbslike/guard/guard-main.mjs");
// The installed baseline's derivation vectors (historical pinned input, B/derive_vectors.json).
export const VECTORS = process.env.ENCLAVE_DERIVE_VECTORS || "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/installed-manager-http-baseline-r1/derive_vectors.json";
export function vectors() { const v = JSON.parse(fs.readFileSync(VECTORS, "utf8")); return { record: v.ok[0].mapping.record, component: Buffer.from(v.component_hex, "hex") }; }

export const PINS = Object.freeze({ chainId: 8453, lifecycle: "0x" + "4c".repeat(20), profile: "independent-host-registry-r1", servingPermit: { version: 2, profile: "independent-host-registry-r1" } });
export const HOST = "0x" + "a1".repeat(32);
export const DEPLOYMENT = "0x" + "e6".repeat(32);
export const IMAGE = "ab".repeat(32), KEY = "cd".repeat(32);
const b32 = (x) => "0x" + x.repeat(32);
export function hostAuthority({ hostGeneration = "1", ownerRevision = "1" } = {}) {
  const c = { version: "enclave-host-authority/v1", chainId: "8453", profile: "independent-host-registry-r1", registry: "0x" + "5e".repeat(20),
    registryCodeHash: b32("c0"), hostId: HOST, hostGeneration, qualificationDigest: b32("01"), trustAnchorId: b32("02"), hardwareId: b32("03"),
    resourceDigest: b32("04"), descriptorDigest: b32("05"), owner: "0x" + "0a".repeat(20), ownerRevision, policyHash: b32("06"),
    reporterPolicyDigest: reporterPolicyDigest([], 0), reporterRevision: "0" };
  return Object.freeze({ ...c, digest: hostAuthorityDigest(c) });
}
// Owner-selected witnesses. Index 3 is the "Enclave-operated" witness; the censorship test has it refuse.
export const WITNESSES = [1, 2, 3, 4].map((i) => privateKeyToAccount("0x" + i.toString(16).padStart(64, "0")));
export const POLICY = Object.freeze({ revision: 1, threshold: 3, witnesses: WITNESSES.map((a) => a.address) });

/** TEST authority reader: the snapshot a derived-finality read would yield, set by the test. */
export function testAuthority({ now }) {
  const s = { state: "queued", generation: 4, online: true, admitted: true, ha: hostAuthority(), blockHash: b32("b1"), fail: null, delay: null };
  return { qualification: "TEST", s,
    async read(deployment) {
      if (s.delay) await s.delay;
      if (s.fail) throw Error(s.fail);
      const sec = Math.floor(now() / 1000);
      return { hostAdmitted: s.admitted, policy: POLICY,
        hostAuthority: { context: s.ha, status: s.online ? "online" : "offline", blockHash: s.blockHash, blockNumber: "100", proofVerified: true },
        assignment: { deployment, host: HOST, state: s.state, operator: "0x" + "0b".repeat(20), generation: s.generation, policyRevision: 1,
          admitted: true, funded: true, authorityTier: "finalized", proofVerified: true, observedAt: sec, blockTimestamp: sec, blockHash: s.blockHash } };
    } };
}
/**
 * r12: the authenticated context a fixture's launch body is planned on (what Host #protectedLaunch passes as `basis`): the SAME transform
 * the direct-supervisor fixtures' composition.snapshot applies (id, assignment revision 1). Read fresh; never a bypass of the binding.
 */
export async function basisOf(authority, id) {
  const ctx = await authority.read(id);
  return { ...ctx, id, verified: ctx.assignment.proofVerified, assignment: { ...ctx.assignment, revision: 1 } };
}
export function permitRecord({ generation, sequence, now, lifeSec = 20, ha = hostAuthority() }) {
  const t = Math.floor(now() / 1000);
  return { deployment: DEPLOYMENT, host: HOST, generation, policyRevision: 1, sequence, issuedAt: t + lifeSec - 20, validUntil: t + lifeSec, hostAuthority: ha };
}
export async function envelope(record, signers = WITNESSES.slice(0, 3)) {
  return { record, signatures: await Promise.all(signers.map((a) => signServingPermit(a, PINS, record))) };
}
export const digestOf = (record) => hashTypedData(servingPermitTypedData(PINS, record));

export function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), "permit-r1-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
export const readInv = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const writeInv = (file, j) => { const tmpf = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmpf, JSON.stringify(j)); fs.renameSync(tmpf, file); };

/** TEST launcher over the shared JSON inventory. Hooks let a test delay/hang/fail start and stop. */
export function testLauncher({ file, relayPort, hooks = {} }) {
  return { boundary: { tier: "T0-hv", hostExcluded: false },
    async preflight() { return { ok: true, checks: [], hostLogicalProcessors: 8 }; },
    async survey() { return readInv(file); },
    async start(mapping, opts) {
      if (hooks.start) await hooks.start(opts);
      const vmId = crypto.randomUUID();
      const j = readInv(file); j.vms.push({ vmId, name: "enclave-" + opts.instanceId, state: "Running", notes: notesFor(opts.identity) }); writeInv(file, j);
      if (hooks.afterCreate) await hooks.afterCreate(opts, vmId);
      return { vmId, name: "enclave-" + opts.instanceId, appReady: false, tcpPort: relayPort, launcherKey: "TEST", launcherVmId: vmId, image: IMAGE, boundary: { tier: "T0-hv", hostExcluded: false } };
    },
    async stop(handle) {
      if (hooks.stop) await hooks.stop(handle);
      const j = readInv(file); j.vms = j.vms.filter((v) => v.vmId !== handle?.vmId); writeInv(file, j);
      return { stopped: true, removed: true, vmId: handle?.vmId };
    } };
}
export async function echoServer(t) {
  const conns = new Set();
  const s = net.createServer((c) => { conns.add(c); c.on("error", () => {}); c.on("close", () => conns.delete(c)); c.pipe(c); });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => { for (const c of conns) c.destroy(); s.close(); });
  return s.address().port;
}
export function selfIdentity(pid = process.pid) {
  const f = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  return { pid, created: "TEST-proc-starttime-" + f.slice(f.lastIndexOf(")") + 2).split(" ")[19] };
}
/** The REAL guard process (TEST backend/exclusion). A fresh journal per guard unless `journal` is passed on purpose. */
export async function startGuard(t, dir, { inventory, maxLaunchMs = 1500, key = crypto.randomBytes(32), journal = null } = {}) {
  journal ??= path.join(dir, `guard-${crypto.randomBytes(4).toString("hex")}.log`);
  const socket = path.join(dir, `guard-${crypto.randomBytes(4).toString("hex")}.sock`);
  if (!fs.existsSync(journal)) initializeOwnedLog(journal, { purpose: GUARD_PURPOSE });
  const proc = spawn(process.execPath, [GUARD_MAIN, "--socket", socket, "--journal", journal, "--key", key.toString("hex"), "--inventory", inventory, "--max-launch-ms", String(maxLaunchMs)],
    { env: { ...process.env, ENCLAVE_GUARD_TEST: "TEST-ONLY-NOT-WINDOWS" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; proc.stdout.on("data", (d) => { out += d; }); proc.stderr.on("data", (d) => { out += d; });
  t.after(() => { try { proc.kill("SIGKILL"); } catch {} });
  await waitFor(() => out.includes("[guard] ready") || proc.exitCode !== null, 10_000);
  if (proc.exitCode !== null) throw Error(`guard exited: ${out}`);
  return { proc, socket, key, journal, log: () => out };
}
export async function waitFor(fn, ms = 5000, step = 20) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw Error("waitFor timed out"); await new Promise((r) => setTimeout(r, step)); }
}

/** The full protected composition over installed-source HTTP. */
// permit r6: routerKey (TEST owner-selected K_r) enables the manager's /router/attest route for the actual composite router
export async function rig(t, { now = Date.now, monotonic, hooks = {}, maxStagingMs = 60_000, withGuard = true, dir = tmp(t), maxLaunchMs, routerKey = null } = {}) {
  const { record, component } = vectors();
  const inventory = path.join(dir, "inventory.json"); if (!fs.existsSync(inventory)) writeInv(inventory, { vms: [] });
  const relayPort = await echoServer(t);
  const backend = new HyperVPartitionBackend({ launcher: testLauncher({ file: inventory, relayPort, hooks }) });
  const manager = new ProtectedManager({ backend, runtimeId: record.runtimeId, fetchComponent: async () => component,
    judgeReady: async () => ({ status: "running", transportKeySha256: KEY, checks: { document: { verdict: "TEST" } } }) });
  await startManager(manager);
  const jfile = path.join(dir, "permit.log"); if (!fs.existsSync(jfile)) initializeOwnedLog(jfile, { purpose: "enclave-manager-permit/1" });
  const log = openOwnedLog(jfile, { purpose: "enclave-manager-permit/1", exclusion: TEST_inProcessExclusion() });
  t.after(() => { try { log.release(); } catch {} });
  const journal = openPermitJournal(log);
  const g = withGuard ? await startGuard(t, dir, { inventory, maxLaunchMs }) : null;
  const guard = g ? await GuardClient.connect({ path: g.socket, key: g.key, identity: { ...selfIdentity(), epoch: manager.epoch } }) : null;
  t.after(() => guard?.close());
  const authority = testAuthority({ now });
  let enforcement = null;
  const dp = dataPlaneFor({ get: (id) => enforcement.dataView(id, manager.get(id)) });
  await new Promise((r) => dp.server.listen(0, "127.0.0.1", r)); t.after(() => dp.server.close());
  manager.onReclaim = (id, why) => dp.closeInstance(id, why);
  const config = { schema: CONFIG_SCHEMA, pins: PINS, host: HOST, maxStagingMs, derivations: ["enclave-catalog-bundle/1"], qualification: TEST_QUALIFICATION, retryMs: 200 };
  enforcement = new PermitEnforcement({ config, manager, journal, guard, authority, dataPlane: dp, now, ...(monotonic ? { monotonic } : {}) });
  manager.enforcement = enforcement;
  await enforcement.verifyGuard();
  const pairing = crypto.randomBytes(32);
  const control = new ControlServer({ key: pairing, handle: protectedRoutes(manager, enforcement) });
  const server = createProtectedServer(manager, { control, routerKey, enforcement });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new GuestdControl(base, pairing);
  const plain = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) }); return { status: r.status, body: await r.json() }; };
  const spawnBody = { derive: record, name: DEPLOYMENT, isPublic: true, hasSecrets: false };
  // r2: the identity a splice presents, retained while the instance was live; never re-read from a removed record
  const identities = new Map();
  const retain = (id) => {
    if (identities.has(id)) return identities.get(id);
    const m = manager.get(id);
    if (!m || !m.appId || !m.runtimeId) return null;
    const ident = Object.freeze({ appId: m.appId, image: m.image, runtimeId: m.runtimeId, key: KEY });
    identities.set(id, ident); return ident;
  };
  const w = { manager, enforcement, journal, log, guard, g, authority, dp, client, plain, base, pairing, inventory, dir, spawnBody, now, server, control, routerKey,
    stageBody: (stagingMs = 30_000) => ({ schema: STAGE_SCHEMA, deployment: DEPLOYMENT, stagingMs, spawn: structuredClone(spawnBody) }),
    async stage(stagingMs) { return client.request("POST", "/protected/vms", w.stageBody(stagingMs), { idempotent: false }); },
    async staged(id) {
      await waitFor(() => { const r = journal.instance(id); return r && r.state === "staged" && manager.get(id)?.status === "running"; });
      retain(id);
      return journal.instance(id);
    },
    identityOf: (id) => identities.get(id) ?? null,
    attachment(id, record, overrides = {}) {
      const r = journal.instance(id), m = manager.get(id);
      return { schema: ATTACHMENT_SCHEMA, instanceId: id, vmId: r.vmId, managerEpoch: manager.epoch, launchEpoch: r.launchEpoch, deployment: DEPLOYMENT,
        generation: r.generation, appId: m.appId, runtimeId: m.runtimeId, image: m.image, permitDigest: digestOf(record), validUntil: record.validUntil * 1000, ...overrides };
    },
    async permit(id, record, { signers, overrides } = {}) {
      retain(id);
      return client.request("POST", `/protected/vms/${id}/permit`, { envelope: await envelope(record, signers), attachment: w.attachment(id, record, overrides) }, { idempotent: false });
    },
    async serve(id, { lifeSec = 20, sequence = 1 } = {}) {
      authority.s.state = "running"; authority.s.generation = journal.instance(id).generation;
      return w.permit(id, permitRecord({ generation: journal.instance(id).generation, sequence, now, lifeSec }));
    },
    /** An ACTUAL new TCP connection presenting the originally authenticated identity (retained before any removal). */
    splice(id) {
      const ident = retain(id);
      if (!ident) throw Error(`TEST helper: no authenticated identity was retained for ${id} before it was removed`);
      return new Promise((resolve) => {
        const c = net.connect(dp.server.address().port, "127.0.0.1");
        let got = ""; c.on("error", () => {}); c.setEncoding("latin1");
        c.on("data", (d) => { got += d; });
        c.on("connect", () => c.write(`ENCLAVE-SPLICE/1 id=${id} app=${ident.appId} image=${ident.image} runtime=${ident.runtimeId} key=${ident.key}\n`));
        const done = () => resolve({ c, got: () => got, closed: () => c.destroyed || c.readableEnded });
        setTimeout(done, 300);
      });
    },
    vms: () => readInv(inventory).vms,
  };
  return w;
}
