// THE PURCHASED SHARE SIZES THE VM'S PROCESSORS, through the real call chain: Manager.spawn -> HyperVPartitionBackend ->
// WmiHyperVLauncher (fake PowerShell host) -> the define script's VP count and WMI Limit/Reservation -> the read-back ->
// wmiserve's argv -> the record. Imports no new module, so it also runs against the pre-fix tree (where every app VM was
// 1 VP at 100% whatever the share) and fails there.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Manager } from "./server.mjs";
import { HyperVPartitionBackend } from "./backend.mjs";
import { WmiHyperVLauncher, READINESS_WITNESS_APP_ID } from "./wmi-launcher.mjs";
import { TYPE1, PREFLIGHT_OK, defineAnswer, keyOf, startAndReadAnswer } from "./fake-hyperv.mjs";

// What a compliant Hyper-V reads back after the processor script: taken FROM the script, so a launcher that asks for the
// wrong quota gets the wrong quota back. (Kept here rather than imported, so this file also runs on the pre-fix tree.)
function processorAnswer(script, over = {}) {
  const [q, l, r] = (/\$cpuWant = @\{q=(\d+); l=(\d+); r=(\d+)\}/.exec(script) || [null, 0, 0, 0]).slice(1).map(Number);
  return { vcpus: q, count: q, limit: l, reservation: r, weight: 100, units: "percent / 1000", maximum: Math.round(l / 1000), reserve: Math.round(r / 1000), ...over };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const v = JSON.parse(fs.readFileSync(path.join(HERE, "../../../isolation/contract/catalog/derive_vectors.json"), "utf8"));
const component = Buffer.from(v.component_hex, "hex");
const REC = v.ok[0].mapping.record;                          // policy { cpuPercent: 100, memMiB: 512, vcpus: 1 }
const IMG = "C:\\Users\\claude\\vbs-like\\runtime.bin";
const SHA = "2d7353760b89b81b6f47759382bb2e83c325d73ed0825734f30fc4051183dfb3";
const FAKE_WMISERVE = path.join(HERE, "testdata/fake-wmiserve.mjs");
const dep = (n) => "0x" + n.toString(16).padStart(2, "0").repeat(32);

/** A Hyper-V host that does what it is asked unless `over` says otherwise; records every script. */
function host({ define = {}, processor = {}, preflight = PREFLIGHT_OK, head = "\nMON snp=0 vcpus=1 memMiB=395 boot_ms=312\nMON ready" } = {}) {
  const seen = [];
  const answers = { preflight, imageHash: { present: true, sha256: SHA, bytes: 1 }, start: { state: "Running" },
                    readConsole: { connected: true, bytes: 64, head }, removeById: { found: true, removed: true },
                    retire: { present: true, retired: true }, survey: { vms: [] } };
  const run = async (script) => {
    seen.push(script);
    const k = keyOf(script);
    let a = answers[k];
    if (k === "startAndRead") a = startAndReadAnswer((x) => answers[x]);
    if (k === "define") a = defineAnswer(script, typeof define === "function" ? define(script) : define);
    if (k === "processor") a = processorAnswer(script, processor);
    return { code: 0, stdout: JSON.stringify(a ?? { ok: true }), stderr: "" };
  };
  return { run, seen, scripts: (k) => seen.filter((s) => keyOf(s) === k) };
}

function stack({ pool = 16, lp = 16, ram = 98304, hostOver = {}, serve = false, mode = "ok", guestCpuAllowance = false } = {}) {
  const h = host({ ...hostOver, preflight: { ...PREFLIGHT_OK, logicalProcessors: lp } });
  const argsFiles = [];
  const bundleDir = serve ? fs.mkdtempSync(path.join(os.tmpdir(), "cpu-alloc-")) : null;
  const spawn = (exe, args, opts) => {
    const f = path.join(bundleDir, `args-${argsFiles.length}.json`); argsFiles.push(f);
    return nodeSpawn(process.execPath, [FAKE_WMISERVE, ...args], { ...opts, env: { ...process.env, FAKE_WMISERVE: mode, FAKE_WMISERVE_ARGS: f } });
  };
  const launcher = new WmiHyperVLauncher({ run: h.run, imagePath: IMG, imageSha256: SHA, prefix: "enclave-app-t-", ...TYPE1, guestCpuAllowance,
    ...(serve ? { serve: { exe: "shield-host.exe", bundleDir, portFor: () => 19411, readyTimeoutMs: 5_000, spawn } } : {}) });
  const m = new Manager({ runtimeId: REC.runtimeId, fetchComponent: async () => component, ramPoolMiB: ram, cpuPoolVcpus: ram === null ? null : pool,
                          backend: new HyperVPartitionBackend({ launcher }) });
  return { m, h, argsFiles, bundleDir };
}
const body = (share, name = dep(0xe6)) => ({ derive: REC, name, isPublic: true, hasSecrets: false, cpuShare: share });
const cpuWant = (s) => { const x = /\$cpuWant = @\{q=(\d+); l=(\d+); r=(\d+)\}/.exec(s); return x ? x.slice(1).map(Number) : null; };
const vpCount = (s) => Number(/-VpCount (\d+)/.exec(s)?.[1]);
async function stopAll(m) { for (const r of m.list()) await m.remove(r.id).catch(() => {}); }

test("16 logical processors: 1% -> 1 VP at 16%, 25% -> 4 VPs at 100%, 21% -> 4 VPs at 84%, 13% -> 3 VPs at 69.333%", async () => {
  for (const [share, vps, limit] of [[.01, 1, 16000], [.25, 4, 100000], [.21, 4, 84000], [.13, 3, 69333], [.17, 3, 90666]]) {
    const { m, h } = stack();
    await m.probe(); await m.recover();
    const r = await m.spawn(body(share));
    try {
      const def = h.scripts("define")[0], cpuScript = h.scripts("processor")[0];
      assert.equal(vpCount(def), vps, `${share}: New-CustomVM -VpCount`);
      assert.ok(cpuScript, `${share}: the processor allocation is set`);
      assert.deepEqual(cpuWant(cpuScript), [vps, limit, limit], `${share}: the exact WMI Limit and Reservation asked for`);
      assert.match(cpuScript, /-MethodName ModifyResourceSettings/);
      assert.ok(h.seen.indexOf(cpuScript) > h.seen.indexOf(def) && h.seen.indexOf(cpuScript) < h.seen.findIndex((x) => keyOf(x) === "startAndRead"),
                "after the definition and BEFORE the first start");
      assert.equal(r.status, "starting", r.reason);
      assert.equal(r.cpu.vcpus, vps); assert.equal(r.cpu.limit, limit); assert.equal(r.cpu.reservation, limit);
      assert.equal(r.cpu.grantedUnits, vps * limit);
      assert.ok(r.cpu.grantedUnits <= Math.round(16 * share * 100000) && r.cpu.grantedUnits > 16 * share * 100000 - vps,
                `${share}: granted ${r.cpu.grantedUnits} is the purchased ${16 * share} vCPU, never over and under by < 1 unit per VP`);
      assert.deepEqual([r.cpu.readback.vcpus, r.cpu.readback.limit, r.cpu.readback.reservation, r.cpu.readback.units],
                       [vps, limit, limit, "percent / 1000"], "what Hyper-V read back is on the record");
      assert.deepEqual(r.policy, REC.policy, "the catalog policy (and so the AppID) is unchanged");
      assert.equal(r.appId, v.ok[0].mapping.appId);
      assert.equal(r.memory.appMiB, Math.floor(98304 * share + 1e-7), "and the SAME share sized the app RAM");
      assert.equal(m.health().cpu.allocatedUnits, vps * limit);
    } finally { await stopAll(m); }
  }
});

test("the guest's own launcher statement and its online count follow the allocation (wmiserve --vcpus, MON vcpus=)", async () => {
  const { m, argsFiles } = stack({ serve: true, hostOver: { head: "\nMON snp=0 vcpus=4 memMiB=8000 boot_ms=300\nMON ready" } });
  await m.probe(); await m.recover();
  const r = await m.spawn(body(.21));
  try {
    const argv = JSON.parse(fs.readFileSync(argsFiles[0], "utf8"));
    assert.equal(argv[argv.indexOf("--vcpus") + 1], "4", "the signed report's partition.vcpus states the VPs the VM has");
    assert.equal(argv[argv.indexOf("--app-mem") + 1], String(Math.floor(98304 * .21)));
    assert.equal(r.cpu.guestOnlineVcpus, 4);
    // the measured guest still confines the app to its catalog cpuPercent: said, not hidden
    assert.equal(r.cpu.realizableUnits, 100000);
    assert.match(r.cpu.blocker, /catalog cpuPercent 100/);
  } finally { await stopAll(m); }
});

test("a guest that brings fewer processors online than it was given is recorded as such, not as the full allocation", async () => {
  const { m } = stack({ hostOver: { head: "\nMON snp=0 vcpus=1 memMiB=8000 boot_ms=300\nMON ready" } });
  await m.probe(); await m.recover();
  const r = await m.spawn(body(.05));                       // 0.8 vCPU on 1 VP: nothing lost
  assert.equal(r.cpu.realizableUnits, 80000); assert.equal(r.cpu.blocker, null);
  await stopAll(m);
  const s = stack({ hostOver: { head: "\nMON snp=0 vcpus=1 memMiB=8000 boot_ms=300\nMON ready" } });
  await s.m.probe(); await s.m.recover();
  const r2 = await s.m.spawn(body(.0625 * 2));              // 2 VPs at 100%
  try {
    assert.equal(r2.cpu.vcpus, 2); assert.equal(r2.cpu.guestOnlineVcpus, 1);
    assert.equal(r2.cpu.realizableUnits, 100000);
    assert.match(r2.cpu.blocker, /brought 1 of 2 virtual processors online/);
  } finally { await stopAll(s.m); }
});

test("Hyper-V reading back anything but the exact quota fails the start, and the VM it defined is removed", async () => {
  for (const bad of [{ limit: 84 }, { limit: 84001 }, { reservation: 0 }, { vcpus: 1, count: 1 }, { count: 1 }, { units: "percent" }]) {
    const { m, h } = stack({ hostOver: { processor: bad } });
    await m.probe(); await m.recover();
    const r = await m.spawn(body(.21));
    assert.equal(r.status, "failed", JSON.stringify(bad));
    assert.match(r.reason, /processor allocation reads back as/);
    assert.equal(h.scripts("removeById").length, 1, `${JSON.stringify(bad)}: the VM is removed by its Id`);
    assert.equal(h.scripts("startAndRead").length, 0, "and never started");
  }
});

test("bad shares are refused before anything is defined; no share, no bypass for an ordinary deployment", async () => {
  for (const share of [0, -1, 1.01, NaN, Infinity, undefined, null, "0.25", .0001]) {
    const { m, h } = stack();
    await m.probe(); await m.recover();
    await assert.rejects(m.spawn(body(share)), (e) => e.status === 400, String(share));
    assert.equal(h.scripts("define").length, 0);
  }
  // the readiness witness's NAME with another app is an ordinary spawn, and needs a deployment id and a share
  const { m } = stack(); await m.probe(); await m.recover();
  await assert.rejects(m.spawn({ ...body(undefined), name: "shield-readiness-v1" }), /deployment ID is required/);
});

test("bad or unknown CPU pools fail closed", async () => {
  for (const pool of [0, -1, 1.5, 2000, "16", NaN])
    assert.throws(() => new Manager({ ramPoolMiB: 98304, cpuPoolVcpus: pool }), /cpuPoolVcpus/);
  assert.throws(() => new Manager({ ramPoolMiB: 98304 }), /configured together/, "RAM by share with CPU fixed is the defect");
  assert.throws(() => new Manager({ cpuPoolVcpus: 16 }), /configured together/);
  // a pool larger than the host's processors: canStart false, and no deployment spawns
  const big = stack({ pool: 32, lp: 16 });
  const pre = await big.m.probe(); await big.m.recover();
  assert.equal(pre.ok, false); assert.equal(big.m.health().canStart, false);
  assert.ok(pre.checks.some((c) => c.name === "CPU pool within host logical processors" && !c.ok));
  await assert.rejects(big.m.spawn(body(.01)), (e) => e.status === 503 && /logical processors/.test(e.message));
  // never read (no preflight yet, or the read failed): unknown is not "fits"
  const unread = stack({ lp: null });
  await unread.m.probe(); await unread.m.recover();
  assert.equal(unread.m.health().cpu.hostLogicalProcessors, null);
  await assert.rejects(unread.m.spawn(body(.01)), (e) => e.status === 503);
  assert.equal(unread.h.scripts("define").length, 0);
});

test("the CPU pool is never oversubscribed, including by the fixed-policy readiness witness", async () => {
  const { m } = stack();
  await m.probe(); await m.recover();
  const results = await Promise.allSettled([m.spawn(body(.6)), m.spawn(body(.6, dep(0xab)))]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  await stopAll(m);
  // the witness keeps its qualified fixed policy (1 VP at 100%, no reservation) and holds that 1 VP of the pool
  const w = stack();
  await w.m.probe(); await w.m.recover();
  const wv = v.ok.find((x) => x.mapping.appId === READINESS_WITNESS_APP_ID);
  if (wv) {
    const wr = await w.m.spawn({ derive: wv.mapping.record, name: "shield-readiness-v1", isPublic: true, hasSecrets: false });
    assert.equal(wr.cpu.rule, "readiness-witness-fixed");
    assert.equal(vpCount(w.h.scripts("define")[0]), 1);
    assert.equal(w.h.scripts("processor").length, 0, "the witness's qualified launch is unchanged: no processor step");
  } else {
    // the vectors carry no witness bundle: model one held fixed-policy record directly (the same held-units rule)
    w.m.domains.set("w", { id: "w", name: "shield-readiness-v1", status: "running", policy: { vcpus: 1, memMiB: 256, cpuPercent: 100 },
                           cpu: { rule: "readiness-witness-fixed", vcpus: 1, limit: 100000, reservation: 0, grantedUnits: 100000 } });
  }
  assert.equal(w.m.health().cpu.allocatedUnits, 100000);
  // RAM fits (.95 of 96 GiB plus the witness's 256 MiB), CPU does not (15.2 + 1 > 16 VPs)
  await assert.rejects(w.m.spawn(body(.95)), (e) => e.status === 507 && /CPU pool/.test(e.message));
  const ok = await w.m.spawn(body(.9));
  assert.equal(ok.cpu.grantedUnits, 1440000);
  assert.equal(w.m.health().cpu.freeUnits, 1600000 - 1440000 - 100000);
  await stopAll(w.m);
});

test("after a manager restart, recovered partitions make CPU allocation unknown: deployments 503 until reconciled", async () => {
  const { m, h } = stack();
  // the survey answers one of our VMs, recovered from its Notes
  const notes = "enclave-vbslike-app-domain/manager|" + Buffer.from(JSON.stringify({ v: 1, id: "hvold", name: dep(0x11), instanceId: "hvold-1" })).toString("base64url");
  m.backend.survey = async () => ({ vms: [{ vmId: "5DB6D4EB-1619-4936-9D60-C7E3CA67F3A8", name: "enclave-app-t-hvold-1", state: "Running", notes }] });
  await m.probe(); await m.recover();
  await assert.rejects(m.spawn(body(.01)), (e) => e.status === 503 && /unknown until recovered partitions are reconciled/.test(e.message));
  assert.equal(h.scripts("define").length, 0);
});

test("with no pools (a lab manager) nothing changes: the catalog's VP count, no processor script, no CPU record", async () => {
  const { m, h } = stack({ ram: null });
  await m.probe(); await m.recover();
  const r = await m.spawn(body(.25));
  try {
    assert.equal(vpCount(h.scripts("define")[0]), 1);
    assert.equal(h.scripts("processor").length, 0);
    assert.equal(r.cpu, null); assert.equal(m.health().cpu, undefined);
  } finally { await stopAll(m); }
});

test("a guest image with the CPU allowance: the app's own cgroup quota is raised to the VM allocation, and confirmed", async () => {
  const { m, argsFiles } = stack({ serve: true, guestCpuAllowance: true, hostOver: { head: "\nMON snp=0 vcpus=4 memMiB=8000 boot_ms=300\nMON ready" } });
  await m.probe(); await m.recover();
  const r = await m.spawn(body(.21));
  try {
    const argv = JSON.parse(fs.readFileSync(argsFiles[0], "utf8"));
    assert.equal(argv[argv.indexOf("--app-cpu") + 1], "336", "4 VPs at 84% = 336% of one CPU");
    assert.equal(r.cpu.appCpuPercent, 336, "as the monitor applied it (wmiserve's load step)");
    assert.equal(r.cpu.realizableUnits, 336000); assert.equal(r.cpu.blocker, null);
  } finally { await stopAll(m); }
  // 13%: 207999 units -> 208%, rounded UP so the VM's exact Limit, not the cgroup, is the binding cap
  const t = stack({ serve: true, guestCpuAllowance: true, hostOver: { head: "\nMON snp=0 vcpus=3 memMiB=8000 boot_ms=300\nMON ready" } });
  await t.m.probe(); await t.m.recover();
  const r13 = await t.m.spawn(body(.13));
  try {
    const argv = JSON.parse(fs.readFileSync(t.argsFiles[0], "utf8"));
    assert.equal(argv[argv.indexOf("--app-cpu") + 1], "208");
    assert.equal(r13.cpu.realizableUnits, 207999);
  } finally { await stopAll(t.m); }
  // at or below the catalog share there is nothing to raise, and nothing is sent
  const u = stack({ serve: true, guestCpuAllowance: true });
  await u.m.probe(); await u.m.recover();
  const r1 = await u.m.spawn(body(.01));
  try { assert.equal(JSON.parse(fs.readFileSync(u.argsFiles[0], "utf8")).includes("--app-cpu"), false); }
  finally { await stopAll(u.m); }
});

test("an allowance the guest path did not apply is refused, not served under the catalog cap", async () => {
  const { m, h } = stack({ serve: true, guestCpuAllowance: true, mode: "cpu-ignored" });
  await m.probe(); await m.recover();
  const r = await m.spawn(body(.21));
  assert.equal(r.status, "failed");
  assert.match(r.reason, /loaded with cpuPercent null, not the 336 allocated/);
  assert.equal(h.scripts("removeById").length, 1, "and the VM is removed");
});
