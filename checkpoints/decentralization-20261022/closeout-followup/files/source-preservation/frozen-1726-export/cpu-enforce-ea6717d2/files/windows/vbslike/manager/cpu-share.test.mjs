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
  assert.equal(cpuForShare(16, .25, shield).blocker, null, "a 400% catalog cap can use all 4 VPs");
});

test("bad shares, pools and policies are refused, and a cap below 1% of a VP is not an allocation", () => {
  for (const s of [0, -0.1, 1.0001, NaN, Infinity, undefined, null, "0.5"]) assert.throws(() => cpuForShare(16, s, P1), /cpuShare/, String(s));
  for (const p of [0, -16, 1.5, 1025, NaN, "16", null]) assert.throws(() => cpuForShare(p, .1, P1), /CPU pool/, String(p));
  for (const pol of [null, {}, { vcpus: 0, cpuPercent: 100 }, { vcpus: 1, cpuPercent: 0 }, { vcpus: "1", cpuPercent: 100 }])
    assert.throws(() => cpuForShare(16, .1, pol), /catalog CPU policy/);
  assert.throws(() => cpuForShare(16, .0005, P1), /below 1000 per VP/);
  assert.equal(cpuForShare(16, .000625, P1).limit, 1000);
});

test("what the app can use is stated beside what the VM is given: the measured guest caps it at catalog cpuPercent", () => {
  const small = cpuForShare(16, .01, P1);
  assert.deepEqual([small.appCapUnits, small.realizableUnits, small.blocker], [100000, 16000, null]);
  const big = cpuForShare(16, .25, P1);
  assert.equal(big.grantedUnits, 400000); assert.equal(big.realizableUnits, 100000);
  assert.match(big.blocker, /cgroup cpu\.max.*300000 of 400000 granted units are not usable/);
  assert.deepEqual(cpuFixedPolicy({ vcpus: 1 }, "readiness-witness-fixed"),
                   { rule: "readiness-witness-fixed", vcpus: 1, limit: 100000, reservation: 0, grantedUnits: 100000 });
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
