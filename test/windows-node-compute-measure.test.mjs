// The node's GFLOPS are MEASURED (windows/node/compute-measure.mjs), not the fleet's 62.5-per-vCPU convention: flops-probe
// (pinned) on every vCPU at once under the apps' wasmtime, the work grown until a run lasts a second, every copy's
// exactly counted work checked. Measured on nucbox-k11 2026-10-08: 420 GFLOPS where the convention said 1000.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { measureGflops, PROBE, PROBE_SHA256, FLOPS_PER_STEP } from "../windows/node/compute-measure.mjs";

const line = (steps) => `flops=${steps * FLOPS_PER_STEP} kernel=simd steps=${steps} sum=6.445086956`;
const fakeCompile = async (_src, dst) => fs.writeFileSync(dst, "x");

test("the probe in the node directory is the pinned one", async () => {
  const { createHash } = await import("node:crypto");
  assert.ok(PROBE.endsWith(path.join("windows", "node", "flops-probe.wasm")));
  assert.equal(createHash("sha256").update(fs.readFileSync(PROBE)).digest("hex"), PROBE_SHA256);
});

test("work grows until a run lasts a second, and the figure is copies x work / wall time", async () => {
  const seen = [];
  const run = async ({ instances, steps }) => { seen.push(steps); const wallMs = steps / 4000; return { wallMs, outs: Array(instances).fill(line(steps)) }; };
  const m = await measureGflops({ wasmtime: "wasmtime", instances: 16, run, compile: fakeCompile, startSteps: 1000 });
  assert.ok(seen.length > 1 && seen.every((s, i) => i === 0 || s > seen[i - 1]), `grew: ${seen}`);
  assert.ok(m.wallMs >= 1000, "only a run of a second or more counts");
  // 4000 steps a ms per copy -> 4000 * 128 flops/ms = 0.512 GFLOPS a copy
  assert.equal(m.perInstance, 0.5); assert.equal(m.gflops, Math.round(16 * 0.512 * 10) / 10);
  assert.equal(m.instances, 16); assert.match(m.method, /every vCPU at once/);
});

test("refused: a probe that is not the pinned one, copies that disagree, work that is not steps x 128, a run that never lasts", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cm-")); const other = path.join(tmp, "p.wasm"); fs.writeFileSync(other, "not the probe");
  await assert.rejects(measureGflops({ wasmtime: "w", instances: 2, probe: other, compile: fakeCompile }), /is not the pinned/);
  const slow = (outs) => async ({ steps }) => ({ wallMs: 2000, outs: outs(steps) });
  await assert.rejects(measureGflops({ wasmtime: "w", instances: 2, compile: fakeCompile, run: slow((s) => [line(s), line(s + 1)]) }), /answered differently/);
  await assert.rejects(measureGflops({ wasmtime: "w", instances: 2, compile: fakeCompile, run: slow((s) => [line(s).replace(/flops=\d+/, "flops=5"), line(s).replace(/flops=\d+/, "flops=5")]) }), /not steps x 128/);
  await assert.rejects(measureGflops({ wasmtime: "w", instances: 2, compile: fakeCompile, run: slow((s) => [line(s)]) }), /1 of 2 copies/);
  await assert.rejects(measureGflops({ wasmtime: "w", instances: 2, compile: fakeCompile, maxRuns: 2, run: async ({ steps }) => ({ wallMs: 5, outs: [line(steps), line(steps)] }) }), /no run lasted/);
  await assert.rejects(measureGflops({ wasmtime: "w", instances: 0, compile: fakeCompile }), /instances must be/);
});

const haveWasmtime = spawnSync("wasmtime", ["--version"]).status === 0;
test("measured for real under wasmtime (JIT): two copies, positive and consistent", { skip: !haveWasmtime && "no wasmtime on PATH" }, async () => {
  const m = await measureGflops({ wasmtime: "wasmtime", instances: 2, minWallMs: 300, startSteps: 1_000_000 });
  assert.ok(m.gflops > 0 && m.perInstance > 0, JSON.stringify(m));
  assert.ok(Math.abs(m.gflops - 2 * m.perInstance) <= 0.2 + 0.01 * m.gflops, JSON.stringify(m));
});
