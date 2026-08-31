// Which memory a preloaded ggml graph must fit, per TENANT SHAPE
// (wasm_manager._nn_budgets). Drives the real manager module, like
// test/wasm-nn-graph-stage.test.mjs.
//
// This gate is silent when it is wrong. An over-budget volume is simply never
// emitted as `-S nn-graph=...`; it stays mounted, the guest's load_by_name()
// fails instantly, and the app reports the model "unfit" with no clue that the
// host made a placement decision. So the four shapes are pinned here.
//
// NODE_HAS_GPU means a LOCAL card throughout the manager - the thing whose OOM
// inside compute calls ggml_abort and takes the whole wasmtime process down, so
// a model that cannot fit it must never be preloaded. That is why the VRAM
// budget is hard and the RAM one is not.
//
// A SHIELDED box is deliberately NOT a special case, and these tests pin that,
// because it does not look that way from the tenant's side. metal0 sells GPU
// shares (its supervisor adopts the card at runtime and advertises gpu:true)
// and its tenants carry a real vram_bytes reservation - but the card sits on
// the untrusted host, reached per matmul, so the guest's manager is told
// NODE_HAS_GPU=0 and its tenants already take the RAM path. Nothing on such a
// box is resident on the card; the reservation is an offload budget.
//
// Worth pinning because I got it wrong (2026-08-31): reading the tenant's
// vram_bytes as evidence of a local card, I added a shielded branch here to
// "fix" a refusal that this gate never made. The volume was already preloading
// against node RAM; the refusal was the APP pricing itself against
// ENCLAVE_VRAM_BYTES, which is set from the reservation whenever gpu_share > 0
// and is independent of NODE_HAS_GPU.
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
(share_ram, node_ram, budget, kind, ggml, ggml_kind, gpu_tenant) = m._nn_budgets(
    ${tenant.gpuShare}, ${tenant.cpuShare},
    ${tenant.vramBytes ?? 0}, ${tenant.residentOther ?? 0})
print(json.dumps({"shareRam": share_ram, "nodeRam": node_ram, "budget": budget, "kind": kind,
                  "ggml": ggml, "ggmlKind": ggml_kind,
                  "gpuTenant": gpu_tenant}))
`;
  const out = execFileSync("python3", ["-c", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.trim().split("\n").pop());
}

// metal0 as it actually runs: 64 GB node, a shielded RTX 3070 on the untrusted
// host - so the GUEST's manager is told NODE_HAS_GPU=0 even though the box
// sells GPU shares and its tenants carry a real offload reservation.
const METAL0 = { hasGpu: false, ramGb: 64 };
// kryptos: a real local H200, whose VRAM a tenant's process can actually OOM
const KRYPTOS = { hasGpu: true, ramGb: 64 };

test("a shielded box's tenant answers to the NODE, though it bought a card share", () => {
  // eyesoff-ai on metal0: 36% of a 6.5 GB shielded card = 2.34 GB reserved.
  // The reservation reaches the tenant (ENCLAVE_VRAM_BYTES) but never this
  // gate, because the node has no local card to be resident on.
  const r = budgets(METAL0, { gpuShare: 0.36, cpuShare: 0.5, vramBytes: Math.floor(2.34 * GB) });
  assert.equal(r.gpuTenant, false, "NODE_HAS_GPU=0: no LOCAL card, whatever the tenant bought");
  assert.equal(r.ggmlKind, "RAM");
  assert.equal(r.ggml, (64 - 6) * GB, "58 GB of node RAM, never the 2.3 GB reservation");
  assert.ok(24 * GB < r.ggml, "so the 24 GB model was always preloadable here");
  // and the tenant budget is its RAM share - the offload reservation is not a
  // residency budget and does not bound anything on this box
  assert.equal(r.kind, "RAM");
  assert.equal(r.budget, Math.floor(0.5 * 64 * GB));
});

test("local GPU tenant: the hard VRAM ceiling is untouched", () => {
  // 36% of an H200 = ~50 GB, and ggml weights really are resident there, so a
  // model over it must never be preloaded (ggml_abort kills the whole tenant)
  const vram = Math.floor(50.5 * GB);
  const r = budgets(KRYPTOS, { gpuShare: 0.36, cpuShare: 0.12, vramBytes: vram });
  assert.equal(r.gpuTenant, true);
  assert.equal(r.ggmlKind, "VRAM");
  assert.equal(r.ggml, vram);
  assert.equal(r.budget, vram);
});

test("0-GPU tenant on a local GPU box still runs on cores", () => {
  // the regression from keying this on the NODE alone: such a tenant got a
  // VRAM budget of zero, every volume was skipped, and the app could never load
  const r = budgets(KRYPTOS, { gpuShare: 0, cpuShare: 0.5 });
  assert.equal(r.gpuTenant, false);
  assert.equal(r.ggmlKind, "RAM");
  assert.equal(r.ggml, (64 - 6) * GB);
  assert.notEqual(r.ggml, 0, "a zero budget would skip every volume");
});

test("node RAM is shared: another tenant's resident weights come off the top", () => {
  const held = 40 * GB;                      // a neighbour already holding a big model
  const r = budgets(METAL0, { gpuShare: 0.36, cpuShare: 0.5,
                              vramBytes: Math.floor(2.34 * GB), residentOther: held });
  assert.equal(r.ggml, (64 - 6) * GB - held,
    "without this term two tenants each clear the check and the pair thrashes");
  // and it has teeth: 18 GB left will not hold the 24 GB model. The RAM budget
  // is soft about HOW it fails, never about whether it is a budget.
  assert.ok(24 * GB > r.ggml, "the shared-node term still refuses what will not fit");
});

test("WASM_CPU_NN_BUDGET=share restores the strict per-share rule", () => {
  const r = budgets({ ...METAL0, budget: "share" },
                    { gpuShare: 0.36, cpuShare: 0.5, vramBytes: Math.floor(2.34 * GB) });
  assert.equal(r.ggml, r.shareRam, "the operator opt-out still binds");
  assert.equal(r.ggml, Math.floor(0.5 * 64 * GB));
});

test("a CPU-only box is unchanged by any of this", () => {
  const r = budgets({ hasGpu: false, ramGb: 32 }, { gpuShare: 0, cpuShare: 0.25 });
  assert.equal(r.gpuTenant, false);
  assert.equal(r.kind, "RAM");
  assert.equal(r.ggml, (32 - 6) * GB);
});
