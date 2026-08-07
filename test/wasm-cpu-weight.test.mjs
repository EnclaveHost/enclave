// CPU fair-share: a tenant's cgroup cpu.weight is PROPORTIONAL to the cpuShare
// it bought, and it is ON BY DEFAULT.
//
// Why this is a default and cpu.max is not: a weight cannot throttle anybody.
// cgroup-v2 only consults it when CPU is CONTENDED, so an app still bursts to
// every idle core; what it guarantees is that under contention you get what
// you paid for. That guarantee was cosmetic when a tenant was one
// single-threaded wasm process and becomes load-bearing as guests get more
// concurrent/parallel (see docs/wasm-parallelism.md). A HARD cap (cpu.max)
// throttles even an idle node, so it stays opt-in.
//
//   run: node --test test/wasm-cpu-weight.test.mjs   (needs python3)

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MGR = path.join(REPO, "wasm", "wasm_manager.py");

function mgr(expr, env = {}) {
  const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
print(json.dumps(${expr}))
`;
  const out = execFileSync("python3", ["-c", code], {
    env: { ...process.env, WASM_MANAGER_PORT: "8091", NODE_HAS_GPU: "0", ...env },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

test("weight is the purchased share of a 10000-point node", () => {
  // two tenants at 0.25 / 0.75 must divide a contended node 25/75
  assert.equal(mgr("m._cpu_weight_for(0.25)"), 2500);
  assert.equal(mgr("m._cpu_weight_for(0.75)"), 7500);
  assert.equal(mgr("m._cpu_weight_for(1.0)"), 10000);
  assert.equal(mgr("m._cpu_weight_for(0.05)"), 500);
});

test("the weight is on by default", () => {
  assert.equal(mgr("[m._CPU_CGROUP_ON, m._CPU_WEIGHT_OFF]")[0], true);
  assert.equal(mgr("[m._CPU_CGROUP_ON, m._CPU_WEIGHT_OFF]")[1], false);
});

test("an unpriced tenant is ordinary, not starved", () => {
  // share 0 (direct callers) must land on cgroup's own default of 100, NOT
  // weight 1 — rounding a 0 share down would make such a tenant lose every
  // contended slice to everyone else.
  assert.equal(mgr("m._cpu_weight_for(0)"), 100);
});

test("a share over 1.0 cannot exceed the node", () => {
  assert.equal(mgr("m._cpu_weight_for(2.0)"), 10000);
});

test("WASM_CPU_WEIGHT pins a fixed weight for every tenant", () => {
  assert.equal(mgr("m._cpu_weight_for(0.25)", { WASM_CPU_WEIGHT: "500" }), 500);
});

test("WASM_CPU_WEIGHT=0 restores the pre-2026-08 unweighted behaviour", () => {
  const [on, off] = mgr("[m._CPU_CGROUP_ON, m._CPU_WEIGHT_OFF]", { WASM_CPU_WEIGHT: "0" });
  assert.equal(off, true);
  assert.equal(on, false, "with no hard cap either, the cgroup path is a no-op again");
});

test("the hard cap stays opt-in and does not switch on with the weight", () => {
  // default env: cpu.max must be unset. Its knob is the only thing that turns
  // it on, and it must still work alongside the default weight.
  assert.equal(mgr("m._CPU_MAX_PCT"), "");
  assert.equal(mgr("m._CPU_MAX_PCT", { WASM_CPU_MAX_PCT: "50" }), "50");
  assert.equal(mgr("m._CPU_CGROUP_ON", { WASM_CPU_MAX_PCT: "50", WASM_CPU_WEIGHT: "0" }), true);
});
