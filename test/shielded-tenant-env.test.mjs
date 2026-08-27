/*
 * The manager's shielded launch path, which is the one place a GPU share stops
 * being a number and becomes a tenant's environment.
 *
 * It gets its own test because it broke twice in a row in ways nothing else
 * could catch: once on a log() that does not exist in that module, and once on
 * indexing vol_mounts (a {name: path} dict) by [0]. Both raised inside the
 * manager's request thread, so the supervisor saw only "provision: socket hang
 * up", the claim was rolled back, the tenant was reaped as an orphan, and the
 * deployment returned to queued behind a backoff -- four misleading symptoms
 * upstream of a one-line mistake. The path needs a real claim and a real card to
 * reach in production; it needs neither here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const py = (code) => JSON.parse(execFileSync("python3", ["-c", `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(join(repo, "wasm", "wasm_manager.py"))})
wm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wm)
${code}
`], { encoding: "utf8", cwd: join(repo, "wasm"), timeout: 300_000 }).trim().split("\n").pop());

test("a shielded tenant gets the worker and the backend, and no CUDA caps", () => {
  const env = py(`
os.environ["CUDA_MPS_PIPE_DIRECTORY"] = "/tmp/should-be-dropped"
os.environ["CUDA_MPS_ACTIVE_THREAD_PERCENTAGE"] = "99"
e = wm._shielded_tenant_env({"endpoint": "10.0.2.2:9500"}, "")
print(json.dumps({k: e.get(k) for k in
  ["SHIELDED_HOST","SHIELDED_PORT","GGML_BACKEND_PATH","ENCLAVE_GGML_N_GPU_LAYERS",
   "CUDA_VISIBLE_DEVICES","CUDA_MPS_PIPE_DIRECTORY","CUDA_MPS_ACTIVE_THREAD_PERCENTAGE"]}))
`);
  assert.equal(env.SHIELDED_HOST, "10.0.2.2");
  assert.equal(env.SHIELDED_PORT, "9500");
  assert.ok(/libggml-shielded\.so$/.test(env.GGML_BACKEND_PATH || ""));
  // Load-bearing, not tidy: a nonzero offload count tells llama.cpp to move whole
  // layers onto a CUDA device this box does not have, and the tenant fails to
  // launch instead of quietly using the shielded path.
  assert.equal(env.ENCLAVE_GGML_N_GPU_LAYERS, "0");
  // There is no local card to cap or to find.
  assert.equal(env.CUDA_VISIBLE_DEVICES, "");
  assert.equal(env.CUDA_MPS_PIPE_DIRECTORY, null, "an MPS pipe must not survive into a shielded tenant");
  assert.equal(env.CUDA_MPS_ACTIVE_THREAD_PERCENTAGE, null);
});

test("calibration is looked up by the attached volume's NAME", () => {
  // vol_mounts is {name: host_path}. Indexing it by [0] is a KeyError, which is
  // exactly how this failed in production.
  const r = py(`
d = {"qwen2.5-0.5b-q8-gguf": "/models/qwen2.5-0.5b-q8-gguf", "other": "/models/other"}
first = next(iter(d), "")
e = wm._shielded_tenant_env({"endpoint": "10.0.2.2:9500"}, first)
print(json.dumps({"first": first, "calib": e.get("SHIELDED_CALIB"),
                  "dir": wm.SHIELDED_CALIB_DIR}))
`);
  assert.equal(r.first, "qwen2.5-0.5b-q8-gguf", "attach order names the model");
  // The file only exists inside the guest image, so absence here is correct and
  // must be non-fatal: no calibration means nothing is offloaded, which is slow
  // rather than wrong.
  assert.ok(r.calib === null || String(r.calib).endsWith("qwen2.5-0.5b-q8-gguf.calib"));
  assert.ok(String(r.dir).length > 0);
});

test("host tenantEnv is applied LAST and only for SHIELDED_* names", () => {
  // metal/config.json's shieldedWorker.tenantEnv reaches the manager as
  // spec.tenantEnv after two host-influenced hops (fw_cfg, the guest verdict
  // file). It exists to tune the backend -- SHIELDED_SPIN_US, the wire layer's
  // bounded poll before it blocks on a reply -- and must win over the defaults
  // this function sets. It must NOT be a way for an operator to put arbitrary
  // environment into a tenant: LD_PRELOAD here would be code injection, a
  // WASMTIME_* or GGML_* name would redirect what the engine loads.
  const r = py(`
e = wm._shielded_tenant_env({"endpoint": "10.0.2.2:9500", "vsockPort": 9500, "tenantEnv": {
  "SHIELDED_SPIN_US": "120",
  "SHIELDED_PROFILE": "0",
  "LD_PRELOAD": "/tmp/evil.so",
  "GGML_BACKEND_PATH": "/tmp/evil",
  "WASMTIME_LOG": "trace",
  "SHIELDED_lower": "x",
  "SHIELDED_BAD_VALUE": "a\\nb",
  "SHIELDED_LONG": "x" * 300,
  "SHIELDED_NUM": 7,
}}, "")
print(json.dumps({k: e.get(k) for k in
  ["SHIELDED_SPIN_US","SHIELDED_PROFILE","LD_PRELOAD","GGML_BACKEND_PATH","WASMTIME_LOG",
   "SHIELDED_lower","SHIELDED_BAD_VALUE","SHIELDED_LONG","SHIELDED_NUM","SHIELDED_VSOCK_PORT"]}))
`);
  assert.equal(r.SHIELDED_SPIN_US, "120", "the knob this exists for");
  assert.equal(r.SHIELDED_PROFILE, "0", "host config wins over the defaults set above it");
  assert.equal(r.SHIELDED_NUM, "7", "numbers are stringified");
  assert.equal(r.SHIELDED_VSOCK_PORT, "9500", "the rest of the spec still applies");
  assert.equal(r.LD_PRELOAD, null, "a non-SHIELDED name is dropped, not applied");
  assert.ok(/libggml-shielded\.so$/.test(r.GGML_BACKEND_PATH || ""), "the backend path cannot be redirected");
  assert.equal(r.WASMTIME_LOG, "wasmtime_wasi_nn=debug", "the default stays");
  assert.equal(r.SHIELDED_lower, null, "names are upper-case env names");
  assert.equal(r.SHIELDED_BAD_VALUE, null, "values are printable ASCII");
  assert.equal(r.SHIELDED_LONG, null, "values are bounded");
});

test("a tenantEnv that is not a map is ignored", () => {
  const r = py(`
out = {}
for te in (["SHIELDED_SPIN_US=5"], "SHIELDED_SPIN_US=5", 5, None):
    e = wm._shielded_tenant_env({"endpoint": "10.0.2.2:9500", "tenantEnv": te}, "")
    out[str(type(te).__name__)] = e.get("SHIELDED_SPIN_US")
print(json.dumps(out))
`);
  for (const [k, v] of Object.entries(r)) assert.equal(v, null, `tenantEnv as ${k}`);
});
