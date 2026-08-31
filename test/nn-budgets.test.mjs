// Which memory a preloaded ggml graph must fit, per TENANT SHAPE
// (wasm_manager._nn_budgets). Drives the real manager module, like
// test/wasm-nn-graph-stage.test.mjs.
//
// This gate is silent when it is wrong. An over-budget volume is simply never
// emitted as `-S nn-graph=...`; it stays mounted, the guest's load_by_name()
// fails instantly, and the app reports the model "unfit" with no clue that the
// host made a placement decision. So the four shapes are pinned here.
//
// The bug it exists for (2026-08-31, eyesoff-ai on metal0). The gate keyed on
// `NODE_HAS_GPU and gpu_share > 0` and gave every such tenant the VRAM budget.
// That is right for a LOCAL card - a CUDA OOM inside compute calls ggml_abort
// and takes the whole wasmtime process down, so a model that cannot fit must
// never be preloaded. It is wrong for a SHIELDED one: there is no local card
// (CUDA_VISIBLE_DEVICES="", ENCLAVE_GGML_N_GPU_LAYERS=0), the weights are
// mmap'd page cache in the CVM exactly like a CPU tenant's, and the card is
// reached per matmul over the masked-offload protocol - where a model bigger
// than the reservation is SLOW, not fatal. A 24 GB model was refused against a
// 2.3 GB offload reservation while 58 GB of node RAM sat free.
//
//   run: node --test test/nn-budgets.test.mjs   (needs python3)

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MGR = path.join(REPO, "wasm", "wasm_manager.py");
const GB = 1024 ** 3;

// node: what the box IS (has a card, its RAM, the reserve, the budget policy)
// tenant: what this deployment BOUGHT
function budgets(node, tenant) {
  const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
m.NODE_HAS_GPU       = ${node.hasGpu ? "True" : "False"}
m.NODE_RAM_GB        = ${node.ramGb}
m.CPU_NN_RESERVE_GB  = ${node.reserveGb ?? 6}
m.CPU_NN_BUDGET      = ${JSON.stringify(node.budget ?? "node")}
(share_ram, node_ram, budget, kind, ggml, ggml_kind, gpu_tenant, local_gpu) = m._nn_budgets(
    ${tenant.gpuShare}, ${tenant.cpuShare}, ${tenant.shieldedVramGb ?? 0},
    ${tenant.vramBytes ?? 0}, ${tenant.residentOther ?? 0})
print(json.dumps({"shareRam": share_ram, "nodeRam": node_ram, "budget": budget, "kind": kind,
                  "ggml": ggml, "ggmlKind": ggml_kind,
                  "gpuTenant": gpu_tenant, "localGpu": local_gpu}))
`;
  const out = execFileSync("python3", ["-c", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").pop());
}

// metal0 as it actually runs: 64 GB node, shielded RTX 3070 with a 6.5 GB budget
const METAL0 = { hasGpu: true, ramGb: 64 };
// kryptos: a real H200 the tenant's process can OOM
const KRYPTOS = { hasGpu: true, ramGb: 64 };

test("shielded tenant: ggml answers to the NODE, the card is only the reservation", () => {
  // eyesoff-ai on metal0: 36% of a 6.5 GB shielded card = 2.34 GB reserved
  const r = budgets(METAL0, { gpuShare: 0.36, cpuShare: 0.5, shieldedVramGb: 2.34,
                              vramBytes: Math.floor(2.34 * GB) });
  assert.equal(r.gpuTenant, true, "it did buy a card share");
  assert.equal(r.localGpu, false, "but there is no LOCAL card to OOM");
  assert.equal(r.ggmlKind, "RAM");
  assert.equal(r.ggml, (64 - 6) * GB, "58 GB of node RAM, not the 2.3 GB reservation");
  // the 24 GB model that was being refused now fits with room to spare
  assert.ok(24 * GB < r.ggml, "a 24 GB model is servable here");
  assert.ok(24 * GB > r.budget, "...and would NOT have been under the old gate");
  // sd/onnx are not mmap-backed, so they keep the tenant budget
  assert.equal(r.kind, "VRAM");
  assert.equal(r.budget, Math.floor(2.34 * GB));
});

test("local GPU tenant: the hard VRAM ceiling is untouched", () => {
  // 36% of an H200 = ~50 GB, and ggml weights really are resident there
  const vram = Math.floor(50.5 * GB);
  const r = budgets(KRYPTOS, { gpuShare: 0.36, cpuShare: 0.12, vramBytes: vram });
  assert.equal(r.localGpu, true);
  assert.equal(r.ggmlKind, "VRAM");
  assert.equal(r.ggml, vram, "a local card's ceiling is hard - ggml_abort kills the tenant");
  assert.equal(r.budget, vram);
});

test("0-GPU tenant on a GPU box still runs on cores", () => {
  // the regression that keying on NODE_HAS_GPU alone caused: a VRAM budget of
  // zero skipped every volume and the app could never load
  const r = budgets(METAL0, { gpuShare: 0, cpuShare: 0.5 });
  assert.equal(r.gpuTenant, false);
  assert.equal(r.ggmlKind, "RAM");
  assert.equal(r.ggml, (64 - 6) * GB);
  assert.notEqual(r.ggml, 0, "a zero budget would skip every volume");
});

test("node RAM is shared: another tenant's resident weights come off the top", () => {
  const held = 40 * GB;                      // a neighbour already holding a big model
  const r = budgets(METAL0, { gpuShare: 0.36, cpuShare: 0.5, shieldedVramGb: 2.34,
                              vramBytes: Math.floor(2.34 * GB), residentOther: held });
  assert.equal(r.ggml, (64 - 6) * GB - held,
    "without this term two tenants each clear the check and the pair thrashes");
  // and it has teeth: 18 GB left is not enough for the 24 GB model, so the
  // shielded path refuses too - this is a real budget, not a waived one
  assert.ok(24 * GB > r.ggml, "the shared-node term still refuses what will not fit");
});

test("WASM_CPU_NN_BUDGET=share restores the strict per-share rule", () => {
  const r = budgets({ ...METAL0, budget: "share" },
                    { gpuShare: 0.36, cpuShare: 0.5, shieldedVramGb: 2.34,
                      vramBytes: Math.floor(2.34 * GB) });
  assert.equal(r.ggml, r.shareRam, "the operator opt-out is honoured on the shielded path too");
  assert.equal(r.ggml, Math.floor(0.5 * 64 * GB));
});

test("a CPU-only box is unchanged by any of this", () => {
  const r = budgets({ hasGpu: false, ramGb: 32 }, { gpuShare: 0, cpuShare: 0.25 });
  assert.equal(r.gpuTenant, false);
  assert.equal(r.localGpu, false);
  assert.equal(r.kind, "RAM");
  assert.equal(r.ggml, (32 - 6) * GB);
});
