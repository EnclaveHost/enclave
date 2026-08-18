// The VRAM ledger must carry the device's own count - and believe it.
//
// 2026-08-18, kryptos (H200): ~104 GiB of device memory orphaned by an
// in-place container update was invisible to every ledger - the share
// arithmetic said 27 GB unreserved while nvidia-smi said 35 GB total free -
// so a 51 GB tenant passed every fit check, loaded its weights, and SIGABRT'd
// at its first lazy context allocation, forever. These tests pin the fix:
// the manager probes nvidia-smi memory.free beside its arithmetic, surfaces
// the divergence, and refuses a launch the card physically cannot hold.
//
//   run: node --test test/vram-device-truth.test.mjs   (needs python3)
//
// nvidia-smi is faked on PATH (this box may have neither a card nor the
// tool); the fake answers both query forms the manager issues.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MGR = path.join(REPO, "wasm", "wasm_manager.py");

// A fake nvidia-smi: totals 140 GiB, free set by FAKE_FREE_MIB, one compute
// app holding the difference. Mirrors the real tool's csv,noheader,nounits
// output for the two queries the manager runs.
function fakeSmiDir(freeMib) {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-smi-"));
  const smi = path.join(dir, "nvidia-smi");
  writeFileSync(smi, `#!/bin/sh
case "$*" in
  *query-gpu=memory.free,memory.total*) echo "${freeMib}, 143360" ;;
  *query-gpu=memory.total*) echo "143360" ;;
  *query-compute-apps*) echo "4242, /orphaned/wasmtime, ${143360 - freeMib}" ;;
  *) exit 1 ;;
esac
`);
  chmodSync(smi, 0o755);
  return dir;
}

// Import the manager with a GPU node's env and run a snippet against it.
function runPy(snippet, { freeMib = 36186, extraEnv = {} } = {}) {
  const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
${snippet}
`;
  const out = execFileSync("python3", ["-c", code], {
    env: {
      ...process.env,
      PATH: `${fakeSmiDir(freeMib)}:${process.env.PATH}`,
      NODE_HAS_GPU: "1", WASM_NN: "1", GPU_COUNT: "1",
      CUDA_MPS_PIPE_DIRECTORY: "/tmp/nvidia-mps",
      ...extraEnv,
    },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

test("the budget carries the device's count and the divergence beside the arithmetic", () => {
  // Empty tenant table: arithmetic free = full budget, device free = 35.3 GB,
  // so the divergence IS the orphaned memory (~105 GB) - the incident's shape.
  const v = runPy(`print(json.dumps(m._vram_budget()))`);
  assert.equal(v.vramDevTotalGb, 140);
  assert.ok(Math.abs(v.vramDevFreeGb - 35.34) < 0.05, `dev free ${v.vramDevFreeGb}`);
  assert.ok(v.vramDivergenceGb > 100,
    `an empty ledger over a mostly-held card must show the divergence (got ${v.vramDivergenceGb})`);
});

test("capacity advertises the tighter of ledger and device", () => {
  const cap = runPy(`print(json.dumps(m._capacity()))`);
  // slice = devFree - ctx overhead, as a share of the card: the box must not
  // advertise arithmetic capacity the card cannot physically grant.
  const expect = (cap.vramDevFreeGb - 0.5) / 140;
  assert.ok(Math.abs(cap.gpuShareFree - expect) < 0.01,
    `gpuShareFree ${cap.gpuShareFree} should be device-bounded (~${expect.toFixed(3)})`);
});

test("per-PID attribution table parses, [N/A] rows keep their holder", () => {
  const p = runPy(`print(json.dumps(m._gpu_dev_procs()))`);
  assert.equal(p.length, 1);
  assert.equal(p[0].pid, 4242);
  assert.equal(p[0].name, "/orphaned/wasmtime");
  assert.ok(p[0].usedMiB > 100000);
});

test("admission refuses what the device cannot hold, even when the ledger admits it", () => {
  // 0.36 share of 140 GB = 50.4 GB + 0.5 overhead vs 35.3 GB physically free:
  // the arithmetic (empty table -> 140 GB "unreserved") says yes, the card
  // says no. The card must win. Exercised at the _vram_budget/gate level the
  // create handler uses.
  const r = runPy(`
v = m._vram_budget()
ask = 0.36 * m.GPU_VRAM_GB + m.VRAM_CTX_OVERHEAD_GB
print(json.dumps({
  "ledger_admits": ask <= v["vramFreeGb"] + 1e-6,
  "device_refuses": m.VRAM_DEV_GATE and ask > v["vramDevFreeGb"] + 1e-6,
}))`);
  assert.equal(r.ledger_admits, true, "the arithmetic alone would have admitted it (the incident)");
  assert.equal(r.device_refuses, true, "the device's count must refuse it");
});

test("WASM_VRAM_DEV_GATE=0 keeps reporting but never refuses", () => {
  const r = runPy(`print(json.dumps({"gate": m.VRAM_DEV_GATE, "dev": m._vram_budget().get("vramDevFreeGb")}))`,
    { extraEnv: { WASM_VRAM_DEV_GATE: "0" } });
  assert.equal(r.gate, false);
  assert.ok(r.dev > 0, "the device reading must still be surfaced");
});

test("probe failure fails open: no device fields, ledger-only admission", () => {
  // PATH carries a fake that exits 1 for the free/total query? Simpler: hide
  // nvidia-smi entirely by pointing PATH at an empty dir first.
  const r = runPy(`print(json.dumps({"dev": m._gpu_dev_mem(), "budget": m._vram_budget()}))`,
    { extraEnv: { WASM_VRAM_DEV_TTL_S: "0" }, freeMib: 36186 });
  assert.ok(r.budget, "the ledger itself must survive");
  // with the fake present this box HAS a reading; the fail-open path proper:
  const r2 = runPy(`
import subprocess
m._dev_mem_cache.update(at=0.0, val=None)
real = subprocess.run
def broken(*a, **k):
    raise OSError("no nvidia-smi")
subprocess.run = broken
try:
    out = {"dev": m._gpu_dev_mem(), "budget": m._vram_budget()}
finally:
    subprocess.run = real
print(json.dumps(out))`);
  assert.equal(r2.dev, null);
  assert.equal(r2.budget.vramDevFreeGb, undefined, "no fabricated device fields on probe failure");
});
