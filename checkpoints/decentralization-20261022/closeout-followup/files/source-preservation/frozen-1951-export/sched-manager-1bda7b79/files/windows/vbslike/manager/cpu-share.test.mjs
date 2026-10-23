// The share -> processors rule (cpu-share.mjs), and main.mjs taking the CPU pool only from trusted host config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cpuForShare, cpuFixedPolicy, CPU_UNITS_PER_VCPU } from "./cpu-share.mjs";

const P1 = { vcpus: 1, cpuPercent: 100 };

test("16 logical processors: the exact examples, and fractions that need a fractional per-VP quota", () => {
  const at = (share, policy = P1) => { const c = cpuForShare(16, share, policy); return [c.vcpus, c.limit, c.reservation, c.grantedUnits]; };
  assert.deepEqual(at(.01), [1, 16000, 16000, 16000]);          // .16 vCPU: one VP at 16%
  assert.deepEqual(at(.25), [4, 100000, 100000, 400000]);
  assert.deepEqual(at(.21), [4, 84000, 84000, 336000]);
  assert.deepEqual(at(.13), [3, 69333, 69333, 207999]);         // 2.08 vCPU: whole percent would be 69% (2.07) or 70% (2.10)
  assert.deepEqual(at(.0625), [1, 100000, 100000, 100000]);
  assert.deepEqual(at(1), [16, 100000, 100000, 1600000]);
  // floating-point shares the node can produce land on the intended unit, never one below it
  assert.deepEqual(at(.29), [5, 92800, 92800, 464000]);         // 16*.29*1e5 = 463999.99999999994
  assert.deepEqual(at(0.16999999999999998), [3, 90666, 90666, 271998]);
  assert.deepEqual(at(.07), [2, 56000, 56000, 112000]);
  for (const s of [.01, .02, .05, .13, .17, .21, .25, .33, .5, .75, .99]) {
    const c = cpuForShare(16, s, P1), want = 16 * s * CPU_UNITS_PER_VCPU;
    assert.ok(c.grantedUnits <= Math.round(want) && Math.round(want) - c.grantedUnits < c.vcpus, `${s}: ${c.grantedUnits} vs ${want}`);
    assert.equal(c.vcpus, Math.max(1, Math.ceil(Math.round(want) / CPU_UNITS_PER_VCPU)), `${s}: the fewest VPs that can carry it`);
  }
});

test("the catalog VP count is a minimum shape, and the pool is a hard ceiling", () => {
  const shield = { vcpus: 4, cpuPercent: 400 };
  assert.deepEqual([cpuForShare(16, .25, shield).vcpus, cpuForShare(16, .25, shield).limit], [4, 100000]);
  assert.deepEqual([cpuForShare(8, .25, shield).vcpus, cpuForShare(8, .25, shield).limit], [4, 50000], "2 vCPU of an 8-VP pool over the 4 VPs it requires");
  assert.throws(() => cpuForShare(2, .5, shield), /needs 4 virtual processors, but the CPU pool has 2/);
  assert.equal(cpuForShare(16, .25, shield).appCpuPercent, 400, "a 25% share confines the app to 4 processors' worth");
});

test("bad shares, pools and policies are refused, and a cap below 1% of a VP is not an allocation", () => {
  for (const s of [0, -0.1, 1.0001, NaN, Infinity, undefined, null, "0.5"]) assert.throws(() => cpuForShare(16, s, P1), /cpuShare/, String(s));
  for (const p of [0, -16, 1.5, 1025, NaN, "16", null]) assert.throws(() => cpuForShare(p, .1, P1), /CPU pool/, String(p));
  for (const pol of [null, {}, { vcpus: 0, cpuPercent: 100 }, { vcpus: 1, cpuPercent: 0 }, { vcpus: "1", cpuPercent: 100 }])
    assert.throws(() => cpuForShare(16, .1, pol), /catalog CPU policy/);
  assert.throws(() => cpuForShare(16, .0005, P1), /below 1000 per VP/);
  assert.equal(cpuForShare(16, .000625, P1).limit, 1000);
});

test("the guest app quota is the purchased share exactly, below the catalog's 100% too, never rounded up", () => {
  // percent of ONE processor (cgroup cpu.max): whole-percent shares of the 16-processor pool are exact
  for (const [share, pct] of [[.01, 16], [.02, 32], [.04, 64], [.0625, 100], [.13, 208], [.21, 336], [.25, 400], [1, 1600], [.29, 464]])
    assert.equal(cpuForShare(16, share, P1).appCpuPercent, pct, `${share}`);
  // a fractional entitlement rounds DOWN (never past what was bought): 1.25% of 16 = 20%, 1.3% = 20.8% -> 20
  assert.equal(cpuForShare(16, .0125, P1).appCpuPercent, 20);
  assert.equal(cpuForShare(16, .013, P1).appCpuPercent, 20);
  assert.equal(cpuForShare(16, 0.16999999999999998, P1).appCpuPercent, 272, "a float share the node can produce lands on its percent");
  assert.equal(cpuForShare(8, .01, P1).appCpuPercent, 8, "another pool: 1% of 8 processors");
  assert.equal(cpuForShare(16, .000625, P1).appCpuPercent, 1, "the cgroup's smallest quota");
  for (const s of [.000625, .001, .01, .013, .05, .13, .21, .33, .5, .99, 1]) {
    const c = cpuForShare(16, s, P1);
    assert.ok(c.appCpuPercent >= 1 && c.appCpuPercent <= c.vcpus * 100, `${s}: within what the VM's processors can carry`);
    assert.ok(c.appCpuPercent * 1000 <= c.entitlementUnits && c.entitlementUnits - c.appCpuPercent * 1000 < 1000, `${s}: never over, under by < 1%`);
  }
  // no claim built from the catalog cap or the VM's (unenforced) Limit
  const c = cpuForShare(16, .25, P1);
  for (const k of ["realizableUnits", "appCapUnits", "blocker"]) assert.equal(k in c, false, k);
  assert.deepEqual(cpuFixedPolicy({ vcpus: 1 }, "readiness-witness-fixed"),
                   { rule: "readiness-witness-fixed", vcpus: 1, limit: 100000, reservation: 0, grantedUnits: 100000 });
});

test("the catalog's real compute minimum is kept by the node's share, so a quota below the catalog's 100% never goes under it", async () => {
  // windows/node/chain.mjs effectiveCpuShare (the CPU rule the activated node a5e155ec keeps unchanged): a version's GFLOPS
  // floor raises the share to whole percents, rounded UP, of this box; the manager then confines the app to that share
  const { effectiveCpuShare } = await import("../../node/chain.mjs");
  const BOX_GFLOPS = 800;                                              // what the node measures for the whole 16-LP box
  for (const [gflops, dial, share] of [[8, 0, .01], [8.1, 0, .02], [30, .01, .04], [168, 0, .21], [8, .25, .25]]) {
    const s = effectiveCpuShare({ cpuMilli: dial * 1000 }, { cpuGflops: gflops, memMb: 256 }, BOX_GFLOPS);
    assert.equal(s, share, `${gflops} GFLOPS dialed ${dial}`);
    const q = cpuForShare(16, s, P1).appCpuPercent;                    // percent of one of 16 processors
    assert.ok(q / 1600 * BOX_GFLOPS >= gflops - 1e-9, `${gflops} GFLOPS: the ${q}% quota still carries the catalog floor`);
  }
});

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.mjs");
function runMain(env, ms = 6000) {
  return new Promise((resolve) => {
    const clean = { ...process.env }; delete clean.NODE_VCPUS; delete clean.NODE_APP_RAM_GB;
    const p = spawn(process.execPath, [MAIN], { env: { ...clean, VMMGR_PORT: "0", ENCLAVE_RUNTIME_ID: "", ENCLAVE_RUNTIME_IDENTITY: "", ...env },
                                                stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
    const t = setTimeout(() => { p.kill(); resolve({ code: null, out, err, timedOut: true }); }, ms);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, out, err, timedOut: false }); });
  });
}

test("main.mjs: the node's pool rule (NODE_VCPUS || os.cpus().length), and a malformed explicit pool refuses to start", async () => {
  const fallback = await runMain({ NODE_APP_RAM_GB: "96" });
  assert.ok(fallback.timedOut, `the node's default runs: exited ${fallback.code}: ${fallback.err.slice(0, 300)}`);
  assert.match(fallback.out, new RegExp(`CPU pool ${os.cpus().length} VPs \\(os\\.cpus\\), RAM pool 96 GB`));
  for (const bad of ["16.5", "0", "-4", "sixteen", "0x10", "1025", "016"]) {
    const r = await runMain({ NODE_APP_RAM_GB: "96", NODE_VCPUS: bad });
    assert.equal(r.code, 2, `${bad}: ${r.err}`); assert.match(r.err, /NODE_VCPUS must be a positive integer/);
  }
  const lone = await runMain({ NODE_VCPUS: "16" });
  assert.equal(lone.code, 2); assert.match(lone.err, /without NODE_APP_RAM_GB/);
  const ok = await runMain({ NODE_APP_RAM_GB: "96", NODE_VCPUS: "16" });
  assert.ok(ok.timedOut, `with both it runs: exited ${ok.code}: ${ok.err.slice(0, 300)}`);
  assert.match(ok.out, /CPU pool 16 VPs \(NODE_VCPUS\)/);
});
