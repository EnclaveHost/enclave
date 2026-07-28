// A tenant that bought no GPU share may not reach the card.
//
// wasi-nn is granted to EVERY tenant (040ab777: a CPU-dialled model-volume app
// has to be able to run on the fleet's biggest machines, and it links against
// wasi:nn/tensor - gating the interface on gpu_share killed it at startup).
// That is right, but it makes the ENVIRONMENT the whole boundary: per-share GPU
// isolation on this platform IS the pair of MPS caps (SM% + pinned VRAM), both
// computed from the share, and a 0-GPU tenant has no share to compute from. It
// would otherwise inherit the manager's env - which on a GPU node carries the
// MPS pipe and an unrestricted view of the device - with NO caps at all, and
// under MPS an unset CUDA_MPS_ACTIVE_THREAD_PERCENTAGE means ALL the SMs. One
// ExecutionTarget::Gpu request (ORT's CUDA EP, an sdcpp graph) would then take
// a whole H200 on a box that sells it by the slice.
//
//   run: node --test test/nn-card-isolation.test.mjs   (needs python3)

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MGR = path.join(REPO, "wasm", "wasm_manager.py");

// Import the module with a GPU node's environment and read back the two envs it
// builds for tenants. NODE_HAS_GPU/CUDA_MPS_PIPE_DIRECTORY mirror
// enclaves/gpu/tinfoil-config.yml's manager container.
function envs() {
  const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
print(json.dumps({"bought": m._nn_tenant_env(0.25, pinned=True), "none": m._no_card_env()}))
`;
  const out = execFileSync("python3", ["-c", code], {
    env: { ...process.env, NODE_HAS_GPU: "1", WASM_NN: "1",
           CUDA_MPS_PIPE_DIRECTORY: "/tmp/nvidia-mps",
           // a node-global offload setting must not reach a card-less tenant
           ENCLAVE_GGML_N_GPU_LAYERS: "-1", GPU_VRAM_GB: "141" },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

test("a 0-GPU tenant gets no device, no MPS and no ggml offload", () => {
  const { none } = envs();
  assert.equal(none.CUDA_VISIBLE_DEVICES, "", "the card must be hidden outright");
  assert.equal(none.CUDA_MPS_PIPE_DIRECTORY, undefined, "it must not be able to join MPS at all");
  assert.equal(none.ENCLAVE_GGML_N_GPU_LAYERS, "0",
    "a node-global offload setting must not reach a tenant that bought no card");
  // it is still a normal tenant otherwise - this hides the GPU, it does not
  // strip the environment
  assert.equal(typeof none.PATH, "string");
});

test("a tenant that DID buy a share still gets both caps", () => {
  // The positive control: if the capped path broke, the test above would pass
  // while the platform sold uncapped slices.
  const { bought } = envs();
  assert.equal(bought.CUDA_MPS_ACTIVE_THREAD_PERCENTAGE, "25", "SM cap = the bought share");
  assert.match(bought.CUDA_MPS_PINNED_DEVICE_MEM_LIMIT || "", /^0=\d+M$/, "VRAM cap present");
  assert.equal(bought.CUDA_MPS_PIPE_DIRECTORY, "/tmp/nvidia-mps", "and it joins MPS");
  assert.notEqual(bought.CUDA_VISIBLE_DEVICES, "", "a paying tenant keeps the device");
});

test("the launch path routes 0-GPU nn tenants through it", () => {
  // The envs above are only worth anything if the spawn actually uses them, and
  // that decision is inline in _spawn_and_wait: pin the branch.
  const src = execFileSync("cat", [MGR], { encoding: "utf8" });
  assert.match(src, /if nn and NODE_HAS_GPU and gpu_share > 0:/, "capped branch for a bought share");
  assert.match(src, /elif nn and NODE_HAS_GPU:\n(?:\s*#.*\n)*\s*env = _no_card_env\(\)/,
    "and the card-less branch for everyone else on a GPU box");
});
