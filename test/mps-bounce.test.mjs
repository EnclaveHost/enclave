// The MPS bounce order: reclaiming device memory a dead generation's MPS
// servers still hold, without a CVM restart.
//
// 2026-08-18: three in-place fleet updates stranded ~104 GiB on kryptos's
// H200 - the tenant containers were replaced while the mps-control container
// (and the GPU) stayed hot, and nothing could order the MPS stack bounced.
// The lever is a request file on the pipe-dir volume the two containers
// already share: the wasm-manager writes an order (operator endpoint, or
// once at boot when the device holds memory against an EMPTY tenant table),
// the mps-daemon loop consumes it, bounces, and answers in a result file.
//
//   run: node --test test/mps-bounce.test.mjs   (needs python3 + bash)

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MGR = path.join(REPO, "wasm", "wasm_manager.py");
const ENTRY = path.join(REPO, "mps-daemon", "entrypoint.sh");

// ---- manager side -----------------------------------------------------------

// fake nvidia-smi so the boot check has a device to look at
function fakeSmiDir(freeMib, totalMib = 143360) {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-smi-"));
  const smi = path.join(dir, "nvidia-smi");
  writeFileSync(smi, `#!/bin/sh
case "$*" in
  *query-gpu=memory.free,memory.total*) echo "${freeMib}, ${totalMib}" ;;
  *query-gpu=memory.total*) echo "${totalMib}" ;;
  *query-compute-apps*) echo "4242, /orphaned/wasmtime, ${totalMib - freeMib}" ;;
  *) exit 1 ;;
esac
`);
  chmodSync(smi, 0o755);
  return dir;
}

function runPy(snippet, { freeMib = 36186, extraEnv = {} } = {}) {
  const pipe = mkdtempSync(path.join(tmpdir(), "mps-pipe-"));
  const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
${snippet}
`;
  const out = execFileSync("python3", ["-c", code], {
    env: { ...process.env, PATH: `${fakeSmiDir(freeMib)}:${process.env.PATH}`,
           NODE_HAS_GPU: "1", WASM_NN: "1", GPU_COUNT: "1",
           CUDA_MPS_PIPE_DIRECTORY: pipe, ...extraEnv },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return { out: JSON.parse(out.trim().split("\n").pop()), pipe };
}

test("an order is written atomically and carries its reason", () => {
  const { out, pipe } = runPy(`
ok = m._request_mps_bounce("test: because")
req = json.load(open(m.MPS_PIPE_DIR + "/enclave-bounce-request"))
print(json.dumps({"ok": ok, "reason": req["reason"], "tmp_left": __import__("os").path.exists(m.MPS_PIPE_DIR + "/.enclave-bounce-request.tmp")}))`);
  assert.equal(out.ok, true);
  assert.equal(out.reason, "test: because");
  assert.equal(out.tmp_left, false, "the temp file must be renamed away, never left");
  rmSync(pipe, { recursive: true, force: true });
});

test("boot check orders a bounce when the card holds memory against an empty table", () => {
  // 143360 total, 36186 free -> ~104 GiB held, table empty: the incident.
  const { out } = runPy(`
m._boot_bounce_check()
import os
req = os.path.exists(m.MPS_PIPE_DIR + "/enclave-bounce-request")
body = json.load(open(m.MPS_PIPE_DIR + "/enclave-bounce-request")) if req else None
print(json.dumps({"ordered": req, "reason": (body or {}).get("reason", "")}))`);
  assert.equal(out.ordered, true);
  assert.match(out.reason, /boot: 10[0-9]\.\d GB held/, out.reason);
});

test("boot check stays quiet on a clean card, a busy table, or when opted out", () => {
  const clean = runPy(`
m._boot_bounce_check()
import os; print(json.dumps(os.path.exists(m.MPS_PIPE_DIR + "/enclave-bounce-request")))`,
    { freeMib: 140000 });
  assert.equal(clean.out, false, "a near-empty card must not be bounced");

  const busy = runPy(`
m._apps["x"] = {"id": "x", "status": "running", "gpuShare": 0.3}
m._boot_bounce_check()
import os; print(json.dumps(os.path.exists(m.MPS_PIPE_DIR + "/enclave-bounce-request")))`);
  assert.equal(busy.out, false, "a non-empty tenant table means the memory may be OURS");

  const off = runPy(`print(json.dumps(m.MPS_BOOT_BOUNCE))`,
    { extraEnv: { WASM_MPS_BOOT_BOUNCE: "0" } });
  assert.equal(off.out, false, "the opt-out must be honored");
});

// ---- daemon side: the entrypoint really consumes an order -------------------

test("the daemon loop consumes an order, bounces, and answers", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mps-e2e-"));
  const pipe = path.join(dir, "pipe");
  const log = path.join(dir, "control.log");
  // fake nvidia-cuda-mps-control: record argv and stdin verbs, always succeed
  const bin = path.join(dir, "bin");
  execFileSync("mkdir", ["-p", bin, pipe]);
  writeFileSync(path.join(bin, "nvidia-cuda-mps-control"), `#!/bin/sh
if [ $# -gt 0 ]; then echo "argv:$*" >> "${log}"; else read -r v; echo "stdin:$v" >> "${log}"; fi
exit 0
`);
  chmodSync(path.join(bin, "nvidia-cuda-mps-control"), 0o755);

  const child = spawn("bash", [ENTRY], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
           CUDA_MPS_PIPE_DIRECTORY: pipe, CUDA_MPS_LOG_DIRECTORY: path.join(dir, "log"),
           MPS_HEALTH_FILE: path.join(dir, "health"), MPS_PROBE_BIN: "/bin/true",
           MPS_PROBE_INTERVAL_S: "1", MPS_PROBE_TIMEOUT_S: "5" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (c) => (stdout += c));
  try {
    // let the daemon start, then drop an order
    await new Promise((r) => setTimeout(r, 1500));
    writeFileSync(path.join(pipe, "enclave-bounce-request"),
      JSON.stringify({ at: 0, reason: "test order" }));
    const result = path.join(pipe, "enclave-bounce-result");
    const t0 = Date.now();
    while (!existsSync(result) && Date.now() - t0 < 15000)
      await new Promise((r) => setTimeout(r, 250));
    assert.ok(existsSync(result), `no result file; stdout so far:\n${stdout}`);
    assert.match(readFileSync(result, "utf8"), / ok$/m, "the bounce must be answered 'ok'");
    assert.equal(existsSync(path.join(pipe, "enclave-bounce-request")), false,
      "the order must be consumed");
    const verbs = readFileSync(log, "utf8");
    assert.match(verbs, /stdin:quit/, "the bounce must quit the control daemon");
    assert.ok(verbs.match(/argv:-d/g).length >= 2, "a fresh daemon must be started after the quit");
    assert.match(stdout, /bounce ordered: .*test order/);
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second order inside the cooldown is refused, not honored", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mps-cd-"));
  const pipe = path.join(dir, "pipe");
  const log = path.join(dir, "control.log");
  const bin = path.join(dir, "bin");
  execFileSync("mkdir", ["-p", bin, pipe]);
  writeFileSync(path.join(bin, "nvidia-cuda-mps-control"), `#!/bin/sh
if [ $# -gt 0 ]; then echo "argv:$*" >> "${log}"; else read -r v; echo "stdin:$v" >> "${log}"; fi
exit 0
`);
  chmodSync(path.join(bin, "nvidia-cuda-mps-control"), 0o755);
  const child = spawn("bash", [ENTRY], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
           CUDA_MPS_PIPE_DIRECTORY: pipe, CUDA_MPS_LOG_DIRECTORY: path.join(dir, "log"),
           MPS_HEALTH_FILE: path.join(dir, "health"), MPS_PROBE_BIN: "/bin/true",
           MPS_PROBE_INTERVAL_S: "1", MPS_PROBE_TIMEOUT_S: "5",
           MPS_BOUNCE_COOLDOWN_S: "3600" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const result = path.join(pipe, "enclave-bounce-result");
    const order = () => writeFileSync(path.join(pipe, "enclave-bounce-request"),
      JSON.stringify({ at: 0, reason: "again" }));
    await new Promise((r) => setTimeout(r, 1500));
    order();
    let t0 = Date.now();
    while (!existsSync(result) && Date.now() - t0 < 15000)
      await new Promise((r) => setTimeout(r, 250));
    assert.match(readFileSync(result, "utf8"), / ok$/m);
    rmSync(result);
    order();
    t0 = Date.now();
    while (!existsSync(result) && Date.now() - t0 < 15000)
      await new Promise((r) => setTimeout(r, 250));
    assert.match(readFileSync(result, "utf8"), /refused-cooldown/,
      "the second order must be refused inside the cooldown");
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
